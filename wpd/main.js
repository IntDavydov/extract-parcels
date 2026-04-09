'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { lookupEland, stopLookup } = require('../src/eland');

let mainWindow = null;
let scrapingProcess = null;

function projectRoot() {
  return app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
}

function getUnpackedPath(...parts) {
  if (app.isPackaged) return path.join(process.resourcesPath, 'app.asar.unpacked', ...parts);
  return path.join(projectRoot(), ...parts);
}

async function ensurePuppeteerChrome() {
  function loadPuppeteer() {
    if (app.isPackaged) {
      return require(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'puppeteer'));
    }
    return require(path.join(projectRoot(), 'node_modules', 'puppeteer'));
  }

  try {
    const puppeteer = loadPuppeteer();
    const chromePath = puppeteer.executablePath();
    if (fs.existsSync(chromePath)) return chromePath;
  } catch (_) {}

  try {
    const installPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'puppeteer', 'lib', 'cjs', 'puppeteer', 'node', 'install.js')
      : path.join(projectRoot(), 'node_modules', 'puppeteer', 'lib', 'cjs', 'puppeteer', 'node', 'install.js');
    const installMod = require(installPath);
    await installMod.downloadBrowsers();
  } catch (e) {
    console.error('Chrome download failed:', e.message);
    return null;
  }

  try {
    const puppeteer = loadPuppeteer();
    const chromePath = puppeteer.executablePath();
    if (fs.existsSync(chromePath)) return chromePath;
  } catch (_) {}
  return null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    show: false,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.maximize();
  mainWindow.show();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.commandLine.appendSwitch('no-sandbox');
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('open-folder-dialog', async () => {
  return dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
});

ipcMain.handle('open-kml-dialog', async () => {
  return dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'KMZ / KML', extensions: ['kmz', 'kml'] }],
  });
});

ipcMain.handle('open-csv-dialog', async () => {
  return dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'CSV files', extensions: ['csv'] }],
  });
});

ipcMain.handle('save-dialog', async (_event, options) => {
  return dialog.showSaveDialog(mainWindow, options);
});

ipcMain.handle('show-in-folder', (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('copy-icons', (_event, outputFolder) => {
  const iconsDir = path.join(outputFolder, 'icons');
  if (fs.existsSync(iconsDir)) fs.rmSync(iconsDir, { recursive: true, force: true });
});

ipcMain.handle('resolve-output-path', (_event, folder, baseName) => {
  let candidate = path.join(folder, `${baseName}.kmz`);
  if (!fs.existsSync(candidate)) return candidate;
  for (let i = 1; i < 1000; i++) {
    candidate = path.join(folder, `${baseName}_${i}.kmz`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return candidate;
});

ipcMain.handle('read-kml-bbox', async (_event, filePath) => {
  const JSZip = require('jszip');
  try {
    let kmlText = '';
    if (filePath.toLowerCase().endsWith('.kmz')) {
      const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
      const kmlName = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith('.kml'));
      if (!kmlName) throw new Error('No .kml inside KMZ');
      kmlText = await zip.files[kmlName].async('text');
    } else {
      kmlText = fs.readFileSync(filePath, 'utf8');
    }

    const all = [];
    const re = /<coordinates>([\s\S]*?)<\/coordinates>/g;
    let m;
    while ((m = re.exec(kmlText)) !== null) {
      m[1].trim().split(/\s+/).forEach((c) => {
        const [lon, lat] = c.split(',').map(Number);
        if (!Number.isNaN(lon) && !Number.isNaN(lat)) all.push([lon, lat]);
      });
    }
    if (!all.length) throw new Error('No coordinates found in file');

    const lons = all.map((c) => c[0]);
    const lats = all.map((c) => c[1]);
    const west = Math.min(...lons);
    const east = Math.max(...lons);
    const south = Math.min(...lats);
    const north = Math.max(...lats);
    const centerLat = (north + south) / 2;
    const centerLng = (west + east) / 2;
    const zoomLng = Math.log2(1600 / 256 * 360 / (east - west));
    const zoomLat = Math.log2(900 / 256 * 180 / (north - south));
    const zoom = Math.min(14, Math.floor(Math.min(zoomLng, zoomLat) * 10) / 10);

    return { centerLat, centerLng, zoom, west, south, east, north };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('start-scraping', async (event, { url, outputPath, headless, boundaryFilter, parcelSource }) => {
  if (scrapingProcess) {
    try { scrapingProcess.kill('SIGINT'); } catch (_) {}
    scrapingProcess = null;
  }

  const nodeModulesPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'node_modules')
    : path.join(projectRoot(), 'node_modules');

  const env = Object.assign({}, process.env, {
    ELECTRON_RUN_AS_NODE: '1',
    NODE_PATH: nodeModulesPath,
  });
  if (outputPath) env.OUTPUT_PATH = outputPath;
  if (headless) env.HEADLESS = '1';
  if (boundaryFilter) env.BOUNDARY_FILTER = boundaryFilter;
  if (parcelSource) env.PARCEL_SOURCE = String(parcelSource);

  event.sender.send('log', '🔍 Checking Chrome availability...');
  const chromePath = await ensurePuppeteerChrome();
  if (chromePath) {
    env.CHROME_PATH = chromePath;
    event.sender.send('log', `✅ Chrome: ${chromePath}`);
  }

  const kmzPath = outputPath ? path.join(outputPath, 'land_plots.kmz') : path.join(process.cwd(), 'land_plots.kmz');
  event.sender.send('log', `💾 Kadastr output: ${kmzPath}`);

  const args = [getUnpackedPath('script.js')];
  if (url) args.push(url);

  scrapingProcess = spawn(process.execPath, args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let tilesProcessed = 0;
  let parcelsFound = 0;

  scrapingProcess.stdout.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach((line) => {
      event.sender.send('log', line);
      const m = line.match(/Tiles processed:\s*(\d+)/);
      if (m) tilesProcessed = parseInt(m[1], 10);
      const p = line.match(/Parcels:\s*(\d+)/);
      if (p) parcelsFound = parseInt(p[1], 10);
      const p2 = line.match(/total parcels:\s*(\d+)/i);
      if (p2) parcelsFound = Math.max(parcelsFound, parseInt(p2[1], 10));
    });
  });

  scrapingProcess.stderr.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach((line) => {
      event.sender.send('log', '[ERR] ' + line);
    });
  });

  return new Promise((resolve) => {
    scrapingProcess.on('close', (code) => {
      scrapingProcess = null;
      resolve({ code, tiles: tilesProcessed, parcels: parcelsFound });
    });
  });
});

ipcMain.on('stop-scraping', () => {
  if (!scrapingProcess) return;
  try {
    scrapingProcess.stdin.write('SHUTDOWN\n');
  } catch (_) {
    try { scrapingProcess.kill(); } catch (_) {}
  }
  setTimeout(() => {
    if (scrapingProcess) {
      try { scrapingProcess.kill(); } catch (_) {}
    }
  }, 15000);
});

ipcMain.handle('merge-kmz', async (_event, { paths, outputPath, cleanup, areaNames, docName }) => {
  const JSZip = require('jszip');

  function extractElements(kml, tagName) {
    const results = [];
    const openRe = new RegExp(`<${tagName}(?=\\s|>)`, 'g');
    const closeTag = `</${tagName}>`;
    let m;
    while ((m = openRe.exec(kml)) !== null) {
      const start = m.index;
      let depth = 1;
      let pos = m.index + m[0].length;
      while (depth > 0 && pos < kml.length) {
        const nextOpen = kml.indexOf(`<${tagName}`, pos);
        const nextClose = kml.indexOf(closeTag, pos);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) {
          const after = kml[nextOpen + tagName.length + 1];
          if (after === '>' || after === ' ' || after === '\n' || after === '\r') depth++;
          pos = nextOpen + tagName.length + 1;
        } else {
          depth--;
          pos = nextClose + closeTag.length;
        }
      }
      if (depth === 0) {
        results.push(kml.slice(start, pos));
        openRe.lastIndex = pos;
      }
    }
    return results;
  }

  try {
    const parsedKmls = [];
    const allZips = [];

    for (const p of paths) {
      if (!fs.existsSync(p)) continue;
      const zip = await JSZip.loadAsync(fs.readFileSync(p));
      allZips.push(zip);
      const kmlName = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith('.kml'));
      if (kmlName) parsedKmls.push(await zip.files[kmlName].async('text'));
    }
    if (!parsedKmls.length) throw new Error('No valid KMZ files found to merge');

    const escXmlAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const useAreaFolders = areaNames && areaNames.length > 0;

    if (parsedKmls.length === 1 && allZips.length === 1 && !useAreaFolders) {
      fs.copyFileSync(paths.find((p) => fs.existsSync(p)), outputPath);
      if (cleanup) for (const p of paths) { try { if (p !== outputPath) fs.unlinkSync(p); } catch (_) {} }
      return { success: true };
    }

    const seenIds = new Set();
    const styles = [];
    const overlays = [];
    const folders = [];

    for (let kmzIdx = 0; kmzIdx < parsedKmls.length; kmzIdx++) {
      const kml = parsedKmls[kmzIdx];
      const areaName = useAreaFolders ? areaNames[kmzIdx] : null;

      for (const s of [...extractElements(kml, 'Style'), ...extractElements(kml, 'StyleMap')]) {
        const id = (s.match(/\sid="([^"]+)"/) || [])[1];
        if (!id || !seenIds.has(id)) {
          if (id) seenIds.add(id);
          styles.push(s);
        }
      }

      if (areaName) {
        const areaGroundOverlays = extractElements(kml, 'GroundOverlay');
        const areaFolders = extractElements(kml, 'Folder');
        folders.push(`<Folder><name>${escXmlAttr(areaName)}</name>${areaGroundOverlays.join('')}${areaFolders.join('')}</Folder>`);
      } else {
        overlays.push(...extractElements(kml, 'GroundOverlay'));
        for (const f of extractElements(kml, 'Folder')) {
          const nameMatch = f.match(/^<Folder[^>]*>\s*<name>([^<]+)<\/name>/);
          const fname = nameMatch ? nameMatch[1] : null;
          if (fname) {
            const idx = folders.findIndex((x) => x.match(/^<Folder[^>]*>\s*<name>([^<]+)<\/name>/)?.[1] === fname);
            if (idx >= 0) { folders[idx] = f; continue; }
          }
          folders.push(f);
        }
      }
    }

    const folderContent = folders.join('');
    const topOverlays = overlays.filter((ov) => !folderContent.includes(ov));
    const combinedKml =
`<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${docName || 'Kadastr'}</name>
  ${styles.join('\n  ')}
  ${topOverlays.join('\n  ')}
  ${folders.join('\n  ')}
</Document>
</kml>`;

    const outZip = new JSZip();
    outZip.file('doc.kml', combinedKml);
    const copiedAssets = new Set();
    for (const zip of allZips) {
      for (const [name, file] of Object.entries(zip.files)) {
        if (!file.dir && !name.toLowerCase().endsWith('.kml') && !copiedAssets.has(name)) {
          copiedAssets.add(name);
          outZip.file(name, await file.async('nodebuffer'));
        }
      }
    }

    const buf = await outZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync(outputPath, buf);
    if (cleanup) for (const p of paths) { try { fs.unlinkSync(p); } catch (_) {} }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('start-eland-lookup', async (event, { csvPath, outputXlsx }) => {
  try {
    const onProgress = (msg) => event.sender.send('log', msg);
    onProgress('🔍 Checking Chrome availability...');
    const chromePath = await ensurePuppeteerChrome();
    if (chromePath) onProgress(`✅ Chrome: ${chromePath}`);
    return await lookupEland(csvPath, outputXlsx, onProgress, chromePath);
  } catch (err) {
    event.sender.send('log', `❌ e.land lookup failed: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.on('stop-eland-lookup', () => stopLookup());
