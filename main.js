const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let scrapingProcess = null;

// When packaged, script.js is in app.asar.unpacked — not inside the asar archive
function getUnpackedPath(...parts) {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : __dirname;
  return path.join(base, ...parts);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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

// IPC: start kadastr scraping
ipcMain.handle('start-scraping', (event, { url, outputPath, headless, boundaryFilter, proxy }) => {
  if (scrapingProcess) {
    try { scrapingProcess.kill('SIGINT'); } catch (_) {}
    scrapingProcess = null;
  }

  const nodeModulesPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'node_modules')
    : path.join(__dirname, 'node_modules');

  const env = Object.assign({}, process.env, {
    ELECTRON_RUN_AS_NODE: '1',
    NODE_PATH: nodeModulesPath,
  });
  if (outputPath) env.OUTPUT_PATH = outputPath;
  if (headless)        env.HEADLESS = '1';
  if (boundaryFilter)  env.BOUNDARY_FILTER = boundaryFilter;
  if (proxy)           env.KADASTR_PROXY = proxy;

  const kmzPath = outputPath
    ? path.join(outputPath, 'land_plots.kmz')
    : path.join(process.cwd(), 'land_plots.kmz');
  event.sender.send('log', `💾 Kadastr output: ${kmzPath}`);

  const args = [getUnpackedPath('script.js')];
  if (url) args.push(url);

  scrapingProcess = spawn(process.execPath, args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let tilesProcessed = 0;

  scrapingProcess.stdout.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach((line) => {
      event.sender.send('log', line);
      const m = line.match(/Tiles processed:\s*(\d+)/);
      if (m) tilesProcessed = parseInt(m[1]);
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
      resolve({ code, tiles: tilesProcessed });
    });
  });
});

// IPC: stop scraping — write SHUTDOWN to stdin for graceful save, then force-kill after 15s
ipcMain.on('stop-scraping', () => {
  if (scrapingProcess) {
    try {
      scrapingProcess.stdin.write('SHUTDOWN\n');
    } catch (_) {
      try { scrapingProcess.kill(); } catch (_) {}
    }
    // Force kill after 15s if still running
    setTimeout(() => {
      if (scrapingProcess) {
        try { scrapingProcess.kill(); } catch (_) {}
      }
    }, 15000);
  }
});

// IPC: fetch OSM data
ipcMain.handle('fetch-osm', async (event, options) => {
  const { fetchOSM } = require(getUnpackedPath('src', 'osm.js'));
  try {
    const resultPath = await fetchOSM(
      options.territory,
      options.layers,
      options.outputPath,
      options.format,
      (msg) => event.sender.send('log', msg),
      options.windOptions || null,
      options.fallbackBbox || null
    );
    return { success: true, path: resultPath };
  } catch (err) {
    event.sender.send('log', '[ERROR] ' + err.message);
    return { success: false, error: err.message };
  }
});

// IPC: merge two KMZ files into one
ipcMain.handle('merge-kmz', async (_event, { paths, outputPath, cleanup }) => {
  const JSZip  = require('jszip');
  const fs     = require('fs');

  // Find first occurrence of each top-level tag (handles non-nested KML elements)
  function extractElements(kml, tagName) {
    const results = [];
    const open = new RegExp(`<${tagName}(?=\\s|>)`, 'g');
    const close = `</${tagName}>`;
    let m;
    while ((m = open.exec(kml)) !== null) {
      const start = m.index;
      const end = kml.indexOf(close, start);
      if (end === -1) continue;
      results.push(kml.slice(start, end + close.length));
      open.lastIndex = end + close.length;
    }
    return results;
  }

  try {
    const parsedKmls = [];
    const allZips    = [];

    for (const p of paths) {
      if (!fs.existsSync(p)) continue;
      const zip = await JSZip.loadAsync(fs.readFileSync(p));
      allZips.push(zip);
      const kmlName = Object.keys(zip.files).find(n => n.toLowerCase().endsWith('.kml'));
      if (kmlName) parsedKmls.push(await zip.files[kmlName].async('text'));
    }

    if (!parsedKmls.length) throw new Error('No valid KMZ files found to merge');

    // Single-file case: just copy to outputPath
    if (parsedKmls.length === 1 && allZips.length === 1) {
      fs.copyFileSync(paths.find(p => fs.existsSync(p)), outputPath);
      if (cleanup) {
        for (const p of paths) { try { if (p !== outputPath) fs.unlinkSync(p); } catch (_) {} }
      }
      return { success: true };
    }

    // Collect all styles (dedup by id), ground overlays, and folders
    const seenIds    = new Set();
    const styles     = [];
    const overlays   = [];
    const folders    = [];

    for (const kml of parsedKmls) {
      for (const s of [...extractElements(kml, 'Style'), ...extractElements(kml, 'StyleMap')]) {
        const id = (s.match(/\sid="([^"]+)"/) || [])[1];
        if (!id || !seenIds.has(id)) {
          if (id) seenIds.add(id);
          styles.push(s);
        }
      }
      overlays.push(...extractElements(kml, 'GroundOverlay'));
      folders.push(...extractElements(kml, 'Folder'));
    }

    const combinedKml =
`<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Land Management</name>
  ${styles.join('\n  ')}
  ${overlays.join('\n  ')}
  ${folders.join('\n  ')}
</Document>
</kml>`;

    const outZip = new JSZip();
    outZip.file('doc.kml', combinedKml);

    // Copy all non-KML file assets from both zips (first-writer wins on name clash)
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

    if (cleanup) {
      for (const p of paths) {
        try { fs.unlinkSync(p); } catch (_) {}
      }
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: find working proxy for kadastr.live
ipcMain.handle('find-proxy', async (event, excludeList = []) => {
  const https = require('https');
  const http  = require('http');
  const net   = require('net');

  function fetchText(url) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      mod.get(url, { timeout: 8000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
    });
  }

  function testHttpProxy(proxyHost, proxyPort, targetHost, targetPort, timeoutMs) {
    return new Promise((resolve) => {
      const tls = require('tls');
      let done = false;
      const finish = (val) => { if (!done) { done = true; clearTimeout(timer); resolve(val); } };

      const socket = net.connect(proxyPort, proxyHost);
      const timer = setTimeout(() => { socket.destroy(); finish(false); }, timeoutMs);

      socket.on('connect', () => {
        socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
        socket.once('data', (data) => {
          if (!data.toString().includes('200')) { finish(false); socket.destroy(); return; }
          // Full TLS handshake proves the proxy can actually reach the target
          const tlsSocket = tls.connect({ socket, servername: targetHost, rejectUnauthorized: false }, () => {
            tlsSocket.destroy();
            finish(true);
          });
          tlsSocket.on('error', () => finish(false));
        });
      });
      socket.on('error', () => finish(false));
    });
  }

  const sources = [
    'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=3000&country=all&anonymity=all',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
  ];

  let proxies = [];
  for (const src of sources) {
    try {
      const text = await fetchText(src);
      const lines = text.trim().split('\n')
        .map(l => l.trim())
        .filter(l => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l));
      proxies = proxies.concat(lines);
      if (proxies.length >= 200) break;
    } catch (_) {}
  }

  const excluded = new Set((excludeList || []).map(p => p.replace(/^https?:\/\//, '')));
  proxies = [...new Set(proxies)].filter(p => !excluded.has(p)).slice(0, 200);
  event.sender.send('log', `🔍 Testing ${proxies.length} proxies for kadastr.live…`);

  // Test in parallel batches of 20
  const BATCH = 20;
  for (let i = 0; i < proxies.length; i += BATCH) {
    const batch = proxies.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (p) => {
      const [host, port] = p.split(':');
      const ok = await testHttpProxy(host, parseInt(port), 'kadastr.live', 443, 8000);
      return ok ? p : null;
    }));
    const found = results.find(r => r !== null);
    if (found) {
      event.sender.send('log', `✅ Working proxy found: ${found}`);
      return `http://${found}`;
    }
    event.sender.send('log', `   … tested ${Math.min(i + BATCH, proxies.length)}/${proxies.length}`);
  }

  event.sender.send('log', '⚠ No working proxy found — kadastr.live may be reachable directly, or try manually entering a proxy.');
  return null;
});

// IPC: save dialog
ipcMain.handle('save-dialog', async (_event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result;
});

// IPC: open folder dialog
ipcMain.handle('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return result;
});

ipcMain.handle('open-kml-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'KMZ / KML', extensions: ['kmz', 'kml'] }],
  });
  return result;
});

ipcMain.handle('show-in-folder', (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('read-kml-bbox', async (_event, filePath) => {
  const fs   = require('fs');
  const JSZip = require('jszip');
  try {
    let kmlText;
    if (filePath.toLowerCase().endsWith('.kmz')) {
      const buf = fs.readFileSync(filePath);
      const zip = await JSZip.loadAsync(buf);
      const kmlName = Object.keys(zip.files).find(n => n.toLowerCase().endsWith('.kml'));
      if (!kmlName) throw new Error('No .kml inside KMZ');
      kmlText = await zip.files[kmlName].async('text');
    } else {
      kmlText = fs.readFileSync(filePath, 'utf8');
    }

    // Extract all coordinate pairs
    const all = [];
    const re = /<coordinates>([\s\S]*?)<\/coordinates>/g;
    let m;
    while ((m = re.exec(kmlText)) !== null) {
      m[1].trim().split(/\s+/).forEach(c => {
        const [lon, lat] = c.split(',').map(Number);
        if (!isNaN(lon) && !isNaN(lat)) all.push([lon, lat]);
      });
    }
    if (!all.length) throw new Error('No coordinates found in file');

    const lons = all.map(c => c[0]), lats = all.map(c => c[1]);
    const west  = Math.min(...lons), east  = Math.max(...lons);
    const south = Math.min(...lats), north = Math.max(...lats);
    const centerLat = (north + south) / 2;
    const centerLng = (west  + east)  / 2;

    // Zoom to fit the bbox in a 1600×900 headless viewport (256px tiles)
    const zoomLng = Math.log2(1600 / 256 * 360 / (east - west));
    const zoomLat = Math.log2(900  / 256 * 180 / (north - south));
    // Cap at 14 (parcel detail level) — lower if territory is large
    const zoom = Math.min(14, Math.floor(Math.min(zoomLng, zoomLat) * 10) / 10);

    return { centerLat, centerLng, zoom, west, south, east, north };
  } catch (e) {
    return { error: e.message };
  }
});
