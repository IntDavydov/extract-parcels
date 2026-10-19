const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { lookupEland, stopLookup } = require('./src/eland');
const { generateResearchXlsx, stopResearch } = require('./src/research');
const { generatePresentation, stopPresentationGenerate: stopPresentationGenerateJob } = require('./src/pptx');
const appConfig = require('./src/config');

function getUnpackedPath(...parts) {
  return path.join(__dirname, ...parts);
}

function getAppRole() {
  const roleArg = process.argv.find((arg) => arg.startsWith('--role='));
  const role = roleArg ? roleArg.split('=')[1] : '';
  return role === 'admin' ? 'admin' : 'user';
}

const APP_ROLE = getAppRole(); console.log('PROCESS ARGV:', process.argv);
process.env.APP_ROLE = APP_ROLE;
ipcMain.on('get-app-role', (event) => {
  event.returnValue = APP_ROLE;
});

// Ensure Puppeteer's bundled Chrome is downloaded (runs once, ~100 MB)
async function ensurePuppeteerChrome() {
  function loadPuppeteer() {
    return require('puppeteer');
  }

  try {
    const puppeteer = loadPuppeteer();
    const chromePath = puppeteer.executablePath();
    if (fs.existsSync(chromePath)) return chromePath;
  } catch (_) {}

  // Chrome missing — download it via puppeteer's CJS install API
  try {
    const installPath = path.join(__dirname, 'node_modules', 'puppeteer', 'lib', 'cjs', 'puppeteer', 'node', 'install.js');
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

let mainWindow;
let scrapingProcess = null;

// ── Keep the system awake during long unattended operations ──────────────────
// A real macOS *sleep* (not just screen lock — that alone doesn't pause
// anything) suspends the whole process: network sockets drop, timers freeze,
// and the Puppeteer-driven browser used for scraping/e-land lookups can end
// up on a stale/logged-out page after waking. Reference-counted so scraping
// and an e-land lookup running around the same time don't stomp on each other.
let sleepBlockerId = null;
let sleepBlockerRefs = 0;
function preventSystemSleep(reason) {
  sleepBlockerRefs++;
  if (sleepBlockerId === null || !powerSaveBlocker.isStarted(sleepBlockerId)) {
    sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    console.log(`🔒 Preventing system sleep (${reason})`);
  }
}
function allowSystemSleep() {
  sleepBlockerRefs = Math.max(0, sleepBlockerRefs - 1);
  if (sleepBlockerRefs === 0 && sleepBlockerId !== null) {
    if (powerSaveBlocker.isStarted(sleepBlockerId)) powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
    console.log('🔓 System sleep re-allowed');
  }
}
const OFFLINE_CACHE_DIR = path.join(os.homedir(), '.land-management-cache');
const DEFAULT_OFFLINE_DATASETS = [
  {
    key: 'pbf',
    label: 'OSM Ukraine PBF',
    filename: 'ukraine-latest.osm.pbf',
    url: 'https://download.geofabrik.de/europe/ukraine-latest.osm.pbf',
    required: true,
    estimatedBytes: 560 * 1024 * 1024,
  },
  {
    key: 'wind',
    label: 'GWA Wind 150m GeoTIFF',
    filename: 'UKR_wind-speed_150m.tif',
    urls: [
      'https://gwa.cdn.nazkamapps.com/country_tifs_v4/UKR_wind-speed_150m.tif',
      'https://gwa.cdn.nazkamapps.com/country_tifs_v3/UKR_wind-speed_150m.tif',
    ],
    required: false,
    estimatedBytes: 60 * 1024 * 1024,
  },
  {
    key: 'worldcover',
    label: 'ESA WorldCover GeoTIFF',
    filename: 'worldcover.zip',
    url: 'https://land-science.s3.us-east-1.amazonaws.com/terrascope_ukraine.zip',
    required: false,
    estimatedBytes: 180 * 1024 * 1024,
  },
  {
    key: 'geology',
    label: 'Geology/Karst GeoJSON',
    filename: 'geology-karst.geojson',
    url: '',
    required: false,
    estimatedBytes: 20 * 1024 * 1024,
  },
  {
    key: 'emerald',
    label: 'Emerald Network (EEA)',
    filename: 'ukraine-emerald.geojson',
    url: "https://bio.discomap.eea.europa.eu/arcgis/rest/services/ProtectedSites/EmeraldSites/MapServer/3/query?where=COUNTRY_CODE%3D'UA'&outFields=*&outSR=4326&f=geojson",
    required: false,
    estimatedBytes: 115 * 1024 * 1024,
  }
];

function ensureCacheDir() {
  if (!fs.existsSync(OFFLINE_CACHE_DIR)) fs.mkdirSync(OFFLINE_CACHE_DIR, { recursive: true });
  // Cleanup stale partial downloads from interrupted sessions.
  for (const name of fs.readdirSync(OFFLINE_CACHE_DIR)) {
    if (!name.endsWith('.tmp')) continue;
    try { fs.unlinkSync(path.join(OFFLINE_CACHE_DIR, name)); } catch (_) {}
  }
}

function getAwsCredentials() {
  // Hardcoded AWS credentials for read-only access to public-ish S3 buckets.
  // Although not best practice for sensitive data, it is acceptable for read-only 
  // public datasets distributed via desktop apps.
  return {
    accessKeyId: 'AKIARNTV4TYNIBC3XBKK',
    secretAccessKey: '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'
  };
}

async function downloadS3Stream(fileUrl, targetPath, onProgress, creds) {
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
  
  // Parse S3 URL (e.g. https://land-science.s3.us-east-1.amazonaws.com/terrascope_ukraine.zip)
  const urlObj = new URL(fileUrl);
  let bucket = '';
  let key = '';
  let region = 'us-east-1'; // default

  // Extract bucket and region
  const hostParts = urlObj.hostname.split('.');
  if (hostParts.length >= 4 && hostParts[1] === 's3') {
    bucket = hostParts[0];
    region = hostParts[2];
  } else {
    throw new Error(`Unsupported S3 URL format: ${fileUrl}`);
  }
  
  key = decodeURIComponent(urlObj.pathname.substring(1)); // Remove leading slash

  const client = new S3Client({
    region: region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey
    }
  });

  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await client.send(command);
  
  return new Promise((resolve, reject) => {
    let settled = false;
    const totalBytes = parseInt(response.ContentLength, 10) || 0;
    let downloadedBytes = 0;
    const tmpPath = `${targetPath}.tmp`;
    const fileStream = fs.createWriteStream(tmpPath);

    response.Body.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      onProgress(downloadedBytes, totalBytes);
    });

    response.Body.pipe(fileStream);

    fileStream.on('finish', () => {
      fileStream.close(() => {
        if (settled) return;
        settled = true;
        fs.rename(tmpPath, targetPath, (err) => {
          if (err) return reject(err);
          resolve(targetPath);
        });
      });
    });

    fileStream.on('error', (err) => {
      if (settled) return;
      settled = true;
      fs.unlink(tmpPath, () => reject(err));
    });
  });
}

function downloadAssetStream(fileUrl, targetPath, onProgress, redirectsLeft = 5) {
  if (fileUrl.includes('amazonaws.com')) {
    const creds = getAwsCredentials();
    if (creds && creds.accessKeyId !== 'YOUR_AWS_ACCESS_KEY_ID_HERE') {
      console.log('Using hardcoded AWS credentials to download:', fileUrl);
      return downloadS3Stream(fileUrl, targetPath, onProgress, creds);
    } else {
       console.log('AWS URL detected but no valid credentials hardcoded. Attempting public download.');
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const urlObj = new URL(fileUrl);
    const client = urlObj.protocol === 'https:' ? https : http;
    const request = client.get(fileUrl, { headers: { 'User-Agent': 'land-management-app/1.0' } }, (response) => {
      const code = response.statusCode || 0;
      if (code >= 300 && code < 400 && response.headers.location) {
        if (redirectsLeft <= 0) {
          response.resume();
          reject(new Error(`Too many redirects for ${fileUrl}`));
          return;
        }
        response.resume();
        downloadAssetStream(response.headers.location, targetPath, onProgress, redirectsLeft - 1)
          .then(resolve)
          .catch(reject);
        return;
      }
      if (code !== 200) {
        response.resume();
        reject(new Error(`Failed to download (${code}): ${fileUrl}`));
        return;
      }

      const totalBytes = parseInt(response.headers['content-length'] || '0', 10) || 0;
      let downloadedBytes = 0;
      const tmpPath = `${targetPath}.tmp`;
      const fileStream = fs.createWriteStream(tmpPath);

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        onProgress(downloadedBytes, totalBytes);
      });

      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => {
          if (settled) return;
          settled = true;
          fs.rename(tmpPath, targetPath, (err) => {
            if (err) return reject(err);
            resolve(targetPath);
          });
        });
      });

      fileStream.on('error', (err) => {
        if (settled) return;
        settled = true;
        response.destroy();
        fs.unlink(tmpPath, () => reject(err));
      });
    });

    request.on('error', (err) => {
      if (settled) return;
      settled = true;
      fs.unlink(`${targetPath}.tmp`, () => reject(err));
    });
    request.setTimeout(300000, () => {
      request.destroy(new Error('Download timeout'));
    });
  });
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

  // Prevent Electron from navigating when files are dropped on the window
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

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

ipcMain.handle('get-territories', async () => {
  try {
    const territoriesPath = getUnpackedPath('src', 'territories.json');
    if (fs.existsSync(territoriesPath)) {
      const data = fs.readFileSync(territoriesPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Failed to read territories.json', err);
  }
  return [];
});

ipcMain.handle('parse-kmz', async (event, kmzPath) => {
  try {
    const JSZip = require('jszip');
    const toGeoJSON = require('@mapbox/togeojson');
    const { DOMParser } = require('@xmldom/xmldom');

    if (!fs.existsSync(kmzPath)) throw new Error('File not found');

    // Plain .kml (uncompressed XML) — read directly, no zip involved. This
    // also covers boundary files the user attaches from other GIS tools,
    // which aren't guaranteed to be zipped, or to name their entry doc.kml.
    let kmlText;
    let unzipped = null;
    if (kmzPath.toLowerCase().endsWith('.kml')) {
      kmlText = fs.readFileSync(kmzPath, 'utf8');
    } else {
      const kmzData = fs.readFileSync(kmzPath);
      unzipped = await JSZip.loadAsync(kmzData);
      const kmlFile = unzipped.file('doc.kml')
        || Object.values(unzipped.files).find(f => !f.dir && f.name.toLowerCase().endsWith('.kml'));
      if (!kmlFile) throw new Error('No .kml found inside KMZ');
      kmlText = await kmlFile.async('string');
    }

    const { XMLSerializer } = require('@xmldom/xmldom');
    const dom = new DOMParser().parseFromString(kmlText, 'text/xml');

    // GroundOverlays (e.g. wind/elevation heatmap PNGs) aren't understood by
    // @mapbox/togeojson, so extract them separately before the folder-stripping
    // pass below mutates the tree.
    const groundOverlays = [];
    if (unzipped) {
      for (const el of Array.from(dom.getElementsByTagName('GroundOverlay'))) {
        try {
          const nameNode = el.getElementsByTagName('name')[0];
          const hrefNode = el.getElementsByTagName('href')[0];
          const boxNode = el.getElementsByTagName('LatLonBox')[0];
          if (!hrefNode || !boxNode) continue;
          const href = hrefNode.textContent.trim();
          const imgFile = unzipped.file(href);
          if (!imgFile) continue;
          const imgBuf = await imgFile.async('nodebuffer');
          const north = parseFloat(boxNode.getElementsByTagName('north')[0].textContent);
          const south = parseFloat(boxNode.getElementsByTagName('south')[0].textContent);
          const east = parseFloat(boxNode.getElementsByTagName('east')[0].textContent);
          const west = parseFloat(boxNode.getElementsByTagName('west')[0].textContent);
          groundOverlays.push({
            name: nameNode ? nameNode.textContent : 'Overlay',
            dataUrl: `data:image/png;base64,${imgBuf.toString('base64')}`,
            bounds: [[south, west], [north, east]],
          });
        } catch (ovErr) {
          console.error('Failed to extract GroundOverlay', ovErr);
        }
      }
    }

    const folders = Array.from(dom.getElementsByTagName('Folder'));
    const layers = [];
    
    if (folders.length === 0) {
      // No folders, just parse the whole thing as one layer
      layers.push({ name: 'Default', geojson: toGeoJSON.kml(dom) });
    } else {
      // Remove all folders from the document to keep styles intact but isolate features
      folders.forEach(f => f.parentNode && f.parentNode.removeChild(f));
      
      for (const folder of folders) {
        const nameNode = folder.getElementsByTagName('name')[0];
        const folderName = nameNode ? nameNode.textContent : 'Unnamed Layer';
        
        // Clone the document without any folders, then append this specific folder
        const tempDom = new DOMParser().parseFromString(new XMLSerializer().serializeToString(dom), 'text/xml');
        const tempDoc = tempDom.getElementsByTagName('Document')[0] || tempDom.documentElement;
        tempDoc.appendChild(tempDom.importNode(folder, true));
        
        const geojson = toGeoJSON.kml(tempDom);
        if (geojson.features && geojson.features.length > 0) {
          layers.push({ name: folderName, geojson });
        }
      }
    }
    
    return { success: true, layers, groundOverlays };
  } catch (err) {
    console.error('parse-kmz failed', err);
    return { success: false, error: err.message };
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: start parcel scraping (kadastrova-karta.com)
ipcMain.handle('start-scraping', async (event, { url, outputPath, headless, boundaryFilter, cadnumFilter, gridCells, parcelSource, fetchDetailedRegistry }) => {
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
    NODE_OPTIONS: '--max-old-space-size=8192',
  });
  if (outputPath) env.OUTPUT_PATH = outputPath;
  if (headless)        env.HEADLESS = '1';
  if (boundaryFilter)  env.BOUNDARY_FILTER = boundaryFilter;
  if (cadnumFilter)    env.CADNUM_FILTER = cadnumFilter;
  if (gridCells && gridCells.length) env.GRID_CELLS = JSON.stringify(gridCells);
  if (parcelSource) env.PARCEL_SOURCE = String(parcelSource);
  if (fetchDetailedRegistry) env.FETCH_DETAILED_REGISTRY = '1';

  // Ensure Chrome is available (downloads on first run if needed)
  event.sender.send('log', '🔍 Checking Chrome availability...');
  const chromePath = await ensurePuppeteerChrome();
  if (chromePath) {
    env.CHROME_PATH = chromePath;
    event.sender.send('log', `✅ Chrome: ${chromePath}`);
  } else {
    event.sender.send('log', '⚠️  Chrome path unknown — puppeteer will auto-detect');
  }

  const kmzPath = outputPath
    ? path.join(outputPath, 'land_plots.kmz')
    : path.join(process.cwd(), 'land_plots.kmz');
  event.sender.send('log', `💾 Kadastr output: ${kmzPath}`);

  const args = [getUnpackedPath('script.js')];
  if (url) args.push(url);

  preventSystemSleep('scraping');
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
      if (m) tilesProcessed = parseInt(m[1]);
      const p = line.match(/Parcels:\s*(\d+)/);
      if (p) parcelsFound = parseInt(p[1]);
      const p2 = line.match(/total parcels:\s*(\d+)/i);
      if (p2) parcelsFound = Math.max(parcelsFound, parseInt(p2[1]));
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
      allowSystemSleep();
      resolve({ code, tiles: tilesProcessed, parcels: parcelsFound });
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
      options.fallbackBbox || null,
      options.customBoundaryPaths || options.customBoundaryPath || null
    );
    return { success: true, path: resultPath };
  } catch (err) {
    event.sender.send('log', '[ERROR] ' + err.message);
    return { success: false, error: err.message };
  }
});

// IPC: merge two KMZ files into one
ipcMain.handle('merge-kmz', async (_event, { paths, outputPath, cleanup, areaNames, docName }) => {
  const JSZip  = require('jszip');
  const fs     = require('fs');

  // Find top-level occurrences of a tag, handling nesting correctly
  function extractElements(kml, tagName) {
    const results = [];
    const openRe = new RegExp(`<${tagName}(?=\\s|>)`, 'g');
    const closeTag = `</${tagName}>`;
    let m;
    while ((m = openRe.exec(kml)) !== null) {
      const start = m.index;
      let depth = 1, pos = m.index + m[0].length;
      while (depth > 0 && pos < kml.length) {
        const nextOpen  = kml.indexOf(`<${tagName}`, pos);
        const nextClose = kml.indexOf(closeTag, pos);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) {
          // check it's actually <tagName> or <tagName  (not <tagNameFoo>)
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
    const allZips    = [];

    for (const p of paths) {
      if (!fs.existsSync(p)) continue;
      const zip = await JSZip.loadAsync(fs.readFileSync(p));
      allZips.push(zip);
      const kmlName = Object.keys(zip.files).find(n => n.toLowerCase().endsWith('.kml'));
      if (kmlName) parsedKmls.push(await zip.files[kmlName].async('text'));
    }

    if (!parsedKmls.length) throw new Error('No valid KMZ files found to merge');

    const escXmlAttr = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const getFolderOwnName = (folderXml) => {
      const m = folderXml.match(/^<Folder[^>]*>\s*<name>([\s\S]*?)<\/name>/i);
      return m ? m[1].trim() : null;
    };
    const getFolderInnerXml = (folderXml) => folderXml
      .replace(/^<Folder[^>]*>\s*<name>[\s\S]*?<\/name>/i, '')
      .replace(/<\/Folder>\s*$/i, '');
    const flattenParcelsAreaFolders = (areaFolders, areaName) => {
      // Kadastr multi-merge inputs often look like:
      // Parcels -> {areaName} -> [Parcel Boundaries, Parcels]
      // We flatten this to: {areaName} -> [Parcel Boundaries, Parcels]
      if (!areaName || areaFolders.length !== 1) return null;
      const topFolder = areaFolders[0];
      if (getFolderOwnName(topFolder) !== 'Parcels') return null;
      const childFolders = extractElements(getFolderInnerXml(topFolder), 'Folder');
      if (childFolders.length !== 1) return null;
      const coordsFolder = childFolders[0];
      if (getFolderOwnName(coordsFolder) !== areaName) return null;
      return getFolderInnerXml(coordsFolder);
    };
    const useAreaFolders = areaNames && areaNames.length > 0;

    // Single-file with no area wrapping: just copy
    if (parsedKmls.length === 1 && allZips.length === 1 && !useAreaFolders) {
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

    for (let kmzIdx = 0; kmzIdx < parsedKmls.length; kmzIdx++) {
      const kml      = parsedKmls[kmzIdx];
      const areaName = useAreaFolders ? areaNames[kmzIdx] : null;

      for (const s of [...extractElements(kml, 'Style'), ...extractElements(kml, 'StyleMap')]) {
        const id = (s.match(/\sid="([^"]+)"/) || [])[1];
        if (!id || !seenIds.has(id)) {
          if (id) seenIds.add(id);
          styles.push(s);
        }
      }

      if (areaName) {
        // Wrap all this KMZ's content in a parent folder named after the area
        const areaGroundOverlays = extractElements(kml, 'GroundOverlay');
        const areaFolders        = extractElements(kml, 'Folder');
        const flattenedAreaContent = flattenParcelsAreaFolders(areaFolders, areaName);
        const folderContent = flattenedAreaContent !== null
          ? areaGroundOverlays.join('') + flattenedAreaContent
          : areaGroundOverlays.join('') + areaFolders.join('');
        folders.push(
          `<Folder><name>${escXmlAttr(areaName)}</name>` +
          folderContent +
          `</Folder>`
        );
      } else {
        overlays.push(...extractElements(kml, 'GroundOverlay'));
        for (const f of extractElements(kml, 'Folder')) {
          // Match only the folder's own <name> (first one, directly after <Folder>)
          const nameMatch = f.match(/^<Folder[^>]*>\s*<name>([^<]+)<\/name>/);
          const fname = nameMatch ? nameMatch[1] : null;
          if (fname) {
            const idx = folders.findIndex(x => x.match(/^<Folder[^>]*>\s*<name>([^<]+)<\/name>/)?.[1] === fname);
            if (idx >= 0) { folders[idx] = f; continue; }
          }
          folders.push(f);
        }
      }
    }

    // Drop any GroundOverlay already nested inside a folder (avoids duplicates)
    const folderContent = folders.join('');
    const topOverlays = overlays.filter(ov => !folderContent.includes(ov));

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

ipcMain.handle('merge-cadnum-csvs', (_event, { paths, outputPath, cleanup = true }) => {
  const fs = require('fs');
  try {
    const cadnums = [];
    const seen = new Set();
    for (const p of (paths || [])) {
      if (!p || !fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
      for (const rawLine of text.split(/\r?\n/)) {
        const line = String(rawLine || '').trim();
        if (!line) continue;
        if (/^#?,?cadnum/i.test(line)) continue;
        const parts = line.split(',');
        const cadnum = (parts.length > 1 ? parts.slice(1).join(',') : parts[0]).trim();
        if (!cadnum || seen.has(cadnum)) continue;
        seen.add(cadnum);
        cadnums.push(cadnum);
      }
    }
    const rows = ['#,cadnum', ...cadnums.map((cadnum, idx) => `${idx + 1},${cadnum}`)];
    fs.writeFileSync(outputPath, '\uFEFF' + rows.join('\r\n'), 'utf8');
    if (cleanup) {
      for (const p of (paths || [])) {
        try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
      }
    }
    return { success: true, outputPath, count: cadnums.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: write a plain list of cadastral numbers to a CSV (same format merge-cadnum-csvs
// produces) — used by the "By cadastral numbers" tab to feed its typed-in list into
// the e.land detailed-registry lookup, which expects a CSV path.
ipcMain.handle('write-cadnums-csv', (_event, { cadnums, outputPath }) => {
  const fs = require('fs');
  try {
    const list = (cadnums || []).map(c => String(c || '').trim()).filter(Boolean);
    const rows = ['#,cadnum', ...list.map((cadnum, idx) => `${idx + 1},${cadnum}`)];
    fs.writeFileSync(outputPath, '﻿' + rows.join('\r\n'), 'utf8');
    return { success: true, outputPath, count: list.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: list top-level entries of the output folder — used to snapshot it right
// before a run starts, so a later Stop can tell "produced by this run" apart
// from files that were already there.
ipcMain.handle('list-output-folder', (_event, folderPath) => {
  const fs = require('fs');
  try {
    if (!folderPath || !fs.existsSync(folderPath)) return { success: true, files: [] };
    return { success: true, files: fs.readdirSync(folderPath) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: delete every top-level entry of the output folder that wasn't present
// in `baseline` (the snapshot taken at run start) — the "Stop" button's
// cleanup: wipe everything this run produced, leave everything else alone.
ipcMain.handle('delete-new-output-files', (_event, { folderPath, baseline }) => {
  const fs = require('fs');
  const path = require('path');
  const deleted = [];
  try {
    if (!folderPath || !fs.existsSync(folderPath)) return { success: true, deleted };
    const baselineSet = new Set(baseline || []);
    for (const name of fs.readdirSync(folderPath)) {
      if (baselineSet.has(name)) continue;
      const full = path.join(folderPath, name);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
        else fs.unlinkSync(full);
        deleted.push(full);
      } catch (_) {}
    }
    return { success: true, deleted };
  } catch (err) {
    return { success: false, error: err.message, deleted };
  }
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
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'KMZ / KML', extensions: ['kmz', 'kml'] }],
  });
  return result;
});

ipcMain.handle('open-csv-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'CSV files', extensions: ['csv'] }],
  });
  return result;
});

ipcMain.handle('open-pptx-template-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'PowerPoint template', extensions: ['pptx'] }],
  });
  return result;
});

ipcMain.handle('open-data-files-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Word / Excel data files', extensions: ['docx', 'xlsx'] }],
  });
  return result;
});

// Decimal degrees → "D M S,ffffff" (space-separated, comma decimal — matches
// the DMS format used in Ukrainian land-act coordinate tables). Ukraine sits
// entirely in the N/E hemispheres, so no N/S/E/W suffix is needed here.
function decimalToDMS(value) {
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const secFloat = (minFloat - min) * 60;
  return `${deg} ${min} ${secFloat.toFixed(6).replace('.', ',')}`;
}

ipcMain.handle('extract-kml-coordinates', async (_event, { sourcePath, outputFolder }) => {
  const JSZip = require('jszip');
  try {
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw new Error('Source KML/KMZ file was not found');
    }
    if (!outputFolder || !fs.existsSync(outputFolder)) {
      throw new Error('Output folder was not found');
    }

    let kmlText;
    if (sourcePath.toLowerCase().endsWith('.kmz')) {
      const buf = fs.readFileSync(sourcePath);
      const zip = await JSZip.loadAsync(buf);
      const kmlName = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith('.kml'));
      if (!kmlName) throw new Error('No .kml inside KMZ');
      kmlText = await zip.files[kmlName].async('text');
    } else {
      kmlText = fs.readFileSync(sourcePath, 'utf8');
    }

    const polygonBlocks = [...kmlText.matchAll(/<Polygon[\s\S]*?<\/Polygon>/gi)].map((m) => m[0]);
    if (!polygonBlocks.length) throw new Error('No Polygon geometries found in file');

    const rows = ['polygon_index,ring_index,point_index,latitude,longitude,combined_coordinates'];
    let pointCount = 0;
    let usedPolygonCount = 0;
    const dmsPoints = [];

    for (let polygonIdx = 0; polygonIdx < polygonBlocks.length; polygonIdx++) {
      const polygonXml = polygonBlocks[polygonIdx];
      const ringMatches = [...polygonXml.matchAll(/<LinearRing[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/LinearRing>/gi)];
      if (!ringMatches.length) continue;
      let polygonHadPoints = false;
      for (let ringIdx = 0; ringIdx < ringMatches.length; ringIdx++) {
        const coordText = String(ringMatches[ringIdx][1] || '').trim();
        if (!coordText) continue;
        const coordParts = coordText.split(/\s+/).filter(Boolean);
        const ringPoints = [];
        for (let pointIdx = 0; pointIdx < coordParts.length; pointIdx++) {
          const [lonRaw, latRaw] = coordParts[pointIdx].split(',');
          const lon = Number(lonRaw);
          const lat = Number(latRaw);
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          rows.push(`${polygonIdx + 1},${ringIdx + 1},${pointIdx + 1},${lat},${lon},"${lat}, ${lon}"`);
          pointCount++;
          polygonHadPoints = true;
          ringPoints.push({ lat, lon });
        }
        // A closed ring repeats its first vertex as the last — drop that
        // duplicate for the vertex table (only the CSV above keeps every
        // raw coordinate, matching its existing output exactly).
        if (ringPoints.length > 1) {
          const f = ringPoints[0], l = ringPoints[ringPoints.length - 1];
          if (f.lat === l.lat && f.lon === l.lon) ringPoints.pop();
        }
        dmsPoints.push(...ringPoints);
      }
      if (polygonHadPoints) usedPolygonCount++;
    }

    if (!pointCount) throw new Error('No valid polygon coordinates found in file');

    const safeBase = path
      .basename(sourcePath, path.extname(sourcePath))
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .trim() || 'polygon_coordinates';
    let outputPath = path.join(outputFolder, `${safeBase}_polygon_coordinates.csv`);
    if (fs.existsSync(outputPath)) {
      for (let i = 1; i < 1000; i++) {
        const candidate = path.join(outputFolder, `${safeBase}_polygon_coordinates_${i}.csv`);
        if (!fs.existsSync(candidate)) {
          outputPath = candidate;
          break;
        }
      }
    }

    fs.writeFileSync(outputPath, rows.join('\n'), 'utf8');

    // DMS coordinate table (.xlsx) — Широта/Довгота columns, one row per
    // polygon vertex, alongside the decimal-degree CSV above.
    let dmsOutputPath = path.join(outputFolder, `${safeBase}_coordinates_dms.xlsx`);
    if (fs.existsSync(dmsOutputPath)) {
      for (let i = 1; i < 1000; i++) {
        const candidate = path.join(outputFolder, `${safeBase}_coordinates_dms_${i}.xlsx`);
        if (!fs.existsSync(candidate)) {
          dmsOutputPath = candidate;
          break;
        }
      }
    }
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Координати');
    sheet.columns = [
      { header: '', key: 'label', width: 12 },
      { header: 'Широта', key: 'lat', width: 24 },
      { header: 'Довгота', key: 'lon', width: 24 },
    ];
    sheet.getRow(1).font = { bold: true };
    dmsPoints.forEach((p, i) => {
      sheet.addRow({ label: `Точка ${i + 1}`, lat: decimalToDMS(p.lat), lon: decimalToDMS(p.lon) });
    });
    await workbook.xlsx.writeFile(dmsOutputPath);

    return { success: true, outputPath, dmsOutputPath, pointCount, polygonCount: usedPolygonCount };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('show-in-folder', (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('open-path', async (_event, targetPath) => {
  return shell.openPath(targetPath);
});

// IPC: open a URL in the system's default browser — used by the map's
// right-click "Directions here" menu. Restricted to http(s) so a renderer
// bug (or a malicious KML description) can never hand this a custom
// protocol / file: URL.
ipcMain.handle('open-external', async (_event, url) => {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { success: false, error: 'Only http(s) URLs are allowed.' };
    }
    await shell.openExternal(url);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('resolve-bbox', async (_event, territory) => {
  try {
    const { fetchOSM, getBboxExport } = require(getUnpackedPath('src', 'osm.js'));
    // We need to call getBbox — it's not exported, so we use a wrapper approach via fetch-osm
    // Instead, do a direct Nominatim call here
    const https = require('https');
    function httpGet(url) {
      return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'land-management-app/1.0' } }, (res) => {
          let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
        }).on('error', reject);
      });
    }
    // Try Nominatim for the territory
    const attempts = [territory, territory.replace(/\s+громада$/i, '').trim()];
    for (const q of [...new Set(attempts)]) {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=ua&polygon_geojson=1`;
      const raw = await httpGet(url);
      const results = JSON.parse(raw);
      if (results.length) {
        const r = results[0];
        const [south, north, west, east] = r.boundingbox.map(Number);
        return { success: true, bbox: { south, north, west, east }, boundaryGeojson: r.geojson || null, displayName: r.display_name };
      }
    }
    return { success: false, error: `Territory "${territory}" not found` };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('create-boundary-kmz', async (_event, { geojson, outputPath }) => {
  try {
    const JSZip = require('jszip');
    const fs    = require('fs');
    // Build a minimal KML from the geojson boundary
    function coordsToKmlStr(coords) {
      return coords.map(c => `${c[0]},${c[1]},0`).join(' ');
    }
    function ringToKml(ring, isOuter) {
      const tag = isOuter ? 'outerBoundaryIs' : 'innerBoundaryIs';
      return `<${tag}><LinearRing><coordinates>${coordsToKmlStr(ring)}</coordinates></LinearRing></${tag}>`;
    }
    function geomToKml(g) {
      if (g.type === 'Polygon') {
        return `<Polygon>${g.coordinates.map((r,i) => ringToKml(r, i===0)).join('')}</Polygon>`;
      }
      if (g.type === 'MultiPolygon') {
        return `<MultiGeometry>${g.coordinates.map(poly =>
          `<Polygon>${poly.map((r,i) => ringToKml(r, i===0)).join('')}</Polygon>`).join('')}</MultiGeometry>`;
      }
      return '';
    }
    const geomKml = geomToKml(geojson);
    const kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>Boundary</name>${geomKml}</Placemark></Document></kml>`;
    const zip = new JSZip();
    zip.file('doc.kml', kml);
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync(outputPath, buf);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('copy-icons', (_event, outputFolder) => {
  // Icons are bundled inside KMZ — delete any leftover icons folder
  const fs = require('fs');
  const iconsDir = path.join(outputFolder, 'icons');
  if (fs.existsSync(iconsDir)) fs.rmSync(iconsDir, { recursive: true, force: true });
});

ipcMain.handle('merge-kmz-files', async (_event, { sourceDir, outputPath }) => {
  const fs = require('fs');
  const path = require('path');
  const JSZip = require('jszip');
  
  try {
    // Find all KMZ files in source directory
    const files = fs.readdirSync(sourceDir).filter(f => f.endsWith('.kmz'));
    
    if (files.length === 0) {
      throw new Error('No KMZ files found to merge');
    }
    
    const allPlacemarks = [];
    
    // Extract placemarks from each KMZ
    for (const file of files) {
      const filePath = path.join(sourceDir, file);
      const data = fs.readFileSync(filePath);
      const zip = await JSZip.loadAsync(data);
      const kmlFile = Object.keys(zip.files).find(name => name.endsWith('.kml'));
      
      if (kmlFile) {
        const kmlText = await zip.file(kmlFile).async('string');
        
        // Extract Placemark elements
        const placemarkMatches = kmlText.matchAll(/<Placemark>[\s\S]*?<\/Placemark>/g);
        for (const match of placemarkMatches) {
          allPlacemarks.push(match[0]);
        }
      }
    }
    
    if (allPlacemarks.length === 0) {
      throw new Error('No placemarks found in KMZ files');
    }
    
    // Create merged KML
    const mergedKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Merged Cadastral Parcels</name>
    <Folder>
      <name>Parcels</name>
${allPlacemarks.map(pm => '      ' + pm).join('\n')}
    </Folder>
  </Document>
</kml>`;
    
    // Create output KMZ
    const outputZip = new JSZip();
    outputZip.file('doc.kml', mergedKml);
    const buffer = await outputZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync(outputPath, buffer);
    
    return { success: true, parcels: allPlacemarks.length };
  } catch (error) {
    console.error('KMZ merge error:', error);
    return { success: false, error: error.message };
  }
});

// Search for cadastral number via selected source
ipcMain.handle('search-cadastral-number', async (_event, input) => {
  const { getSource, resolveSourceKey } = require(getUnpackedPath('src', 'cadastral-sources', 'index.js'));
  const payload = (typeof input === 'string')
    ? { cadnum: input, source: 'kadastrova_karta_ua' }
    : (input || {});
  const cadnum = String(payload.cadnum || '').trim();
  const sourceKey = resolveSourceKey(payload.source);
  const source = getSource(sourceKey);

  if (!cadnum) throw new Error('Cadastral number is required');

  try {
    return await source.lookupByCadnum(cadnum);
  } catch (err) {
    throw new Error(`${source.label} lookup failed: ${err.message}`);
  }
});

ipcMain.handle('cadnum-batch-init', (_event, outputFolder) => {
  const fs = require('fs');
  const path = require('path');
  const tempDir = path.join(outputFolder, '.cadnum_batch_' + Date.now());
  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
});

ipcMain.handle('cadnum-batch-finalize-item', (_event, { tempDir, cadnum }) => {
  const fs = require('fs');
  const path = require('path');
  const tempKmz = path.join(tempDir, 'land_plots.kmz');
  if (!fs.existsSync(tempKmz)) return null;
  const namedKmz = path.join(tempDir, `${String(cadnum).replace(/:/g, '_')}.kmz`);
  fs.renameSync(tempKmz, namedKmz);
  return namedKmz;
});

ipcMain.handle('cadnum-batch-cleanup', (_event, tempDir) => {
  const fs = require('fs');
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  return true;
});

// Export GeoJSON features directly to a KMZ (used by cadnum .com.ua path — no scraping needed)
ipcMain.handle('create-cadnum-kmz', async (_event, { features, outputPath, docName }) => {
  try {
    const { exportKMZ } = require(getUnpackedPath('src', 'kmz.js'));
    const layerMap = { 'Land Parcels': features };
    await exportKMZ(layerMap, outputPath, () => {}, [], docName || 'Kadastr');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('resolve-output-path', (_event, folder, baseName) => {
  const fs   = require('fs');
  const path = require('path');
  let candidate = path.join(folder, baseName + '.kmz');
  if (!fs.existsSync(candidate)) return candidate;
  for (let i = 1; i < 1000; i++) {
    candidate = path.join(folder, `${baseName}_${i}.kmz`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return candidate;
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

ipcMain.handle('start-eland-lookup', async (event, { csvPath, outputPath, outputXlsx, format }) => {
  preventSystemSleep('e-land lookup');
  try {
    const onProgress = msg => event.sender.send('log', msg);
    onProgress('🔍 Checking Chrome availability...');
    const chromePath = await ensurePuppeteerChrome();
    if (chromePath) onProgress(`✅ Chrome: ${chromePath}`);
    const targetPath = outputPath || outputXlsx;
    const csvDir = csvPath ? path.dirname(csvPath) : app.getAppPath();
    const result = await lookupEland(csvPath, targetPath, onProgress, chromePath, {
      format,
      partialOptionsPath: path.join(csvDir, 'info', 'e-land-options.xlsx'),
    });
    return result;
  } catch (err) {
    event.sender.send('log', `❌ e.land lookup failed: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    allowSystemSleep();
  }
});

ipcMain.on('stop-eland-lookup', () => stopLookup());

ipcMain.handle('get-ai-config', async () => {
  const primary = appConfig.getPrimaryAiConfig();
  const fallback = appConfig.getFallbackAiConfig();
  return {
    primary: {
      hasApiKey: !!primary.apiKey,
      apiKeyMasked: appConfig.maskKey(primary.apiKey),
      baseUrl: primary.baseUrl,
      model: primary.model,
    },
    fallback: {
      hasApiKey: !!fallback.apiKey,
      apiKeyMasked: appConfig.maskKey(fallback.apiKey),
      baseUrl: fallback.baseUrl,
      model: fallback.model,
    },
  };
});

ipcMain.handle('save-ai-config', async (_event, { primary, fallback } = {}) => {
  appConfig.saveAiConfig({ primary, fallback });
  return { success: true };
});

ipcMain.handle('start-presentation-generate', async (event, { templatePath, dataFilePaths, topic, outputPath }) => {
  preventSystemSleep('presentation generate');
  try {
    const onProgress = (msg) => event.sender.send('log', msg);
    const result = await generatePresentation({ templatePath, dataFilePaths, topic, outputPath }, onProgress);
    return result;
  } catch (err) {
    event.sender.send('log', `❌ Presentation generation failed: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    allowSystemSleep();
  }
});

ipcMain.on('stop-presentation-generate', () => stopPresentationGenerateJob());

ipcMain.handle('download-offline-data', async (event, { worldcoverUrl = '', geologyUrl = '', forceUpdate = false, forceUpdateAws = false } = {}) => {
  try {
    ensureCacheDir();
    const datasets = DEFAULT_OFFLINE_DATASETS.map((d) => {
      if (d.key === 'worldcover') {
        const customUrls = worldcoverUrl ? [worldcoverUrl] : (d.urls || (d.url ? [d.url] : []));
        const isZip = customUrls.length > 0 && customUrls[0].toLowerCase().endsWith('.zip');
        return { 
          ...d, 
          urls: customUrls,
          filename: isZip ? 'worldcover.zip' : d.filename
        };
      }
      if (d.key === 'geology') {
        const customUrls = geologyUrl ? [geologyUrl] : (d.urls || (d.url ? [d.url] : []));
        const isZip = customUrls.length > 0 && customUrls[0].toLowerCase().endsWith('.zip');
        return { 
          ...d, 
          urls: customUrls,
          filename: isZip ? 'geology.zip' : d.filename
        };
      }
      if (d.urls) return d;
      return { ...d, urls: d.url ? [d.url] : [] };
    });

    const toDownload = datasets.filter((d) => Array.isArray(d.urls) && d.urls.length > 0);
    const skipped = datasets
      .filter((d) => !Array.isArray(d.urls) || d.urls.length === 0)
      .map((d) => ({ key: d.key, label: d.label, reason: 'No URL provided' }));

    if (!toDownload.length) {
      return { success: false, error: 'No dataset URLs configured', skipped, cacheDir: OFFLINE_CACHE_DIR };
    }

    const installed = [];
    const failed = [];
    const totalEstimatedBytes = toDownload.reduce((sum, item) => sum + Math.max(1, Number(item.estimatedBytes || 0)), 0);
    let completedEstimatedBytes = 0;
    for (let i = 0; i < toDownload.length; i++) {
      const item = toDownload[i];
      const targetPath = path.join(OFFLINE_CACHE_DIR, item.filename);
      const itemEstimatedBytes = Math.max(1, Number(item.estimatedBytes || 0));
      
      let isAlreadyInstalled = false;
      if (item.filename.endsWith('.zip')) {
        // Since we delete the zip after extracting, check if the expected output directory exists instead
        const expectedDir = item.key === 'worldcover' 
          ? path.join(OFFLINE_CACHE_DIR, 'WORLDCOVER') 
          : targetPath.replace('.zip', '');
        isAlreadyInstalled = fs.existsSync(expectedDir);
      } else {
        isAlreadyInstalled = fs.existsSync(targetPath);
      }

      const shouldForceUpdate = item.key === 'worldcover' ? forceUpdateAws : forceUpdate;

      if (!shouldForceUpdate && isAlreadyInstalled) {
        completedEstimatedBytes += itemEstimatedBytes;
        const overallPercent = Math.round((completedEstimatedBytes / totalEstimatedBytes) * 100);
        event.sender.send('download-progress', {
          file: item.label,
          filename: item.filename,
          percent: 100,
          downloadedBytes: itemEstimatedBytes,
          totalBytes: itemEstimatedBytes,
          index: i + 1,
          totalFiles: toDownload.length,
          overallPercent,
          status: 'already_installed',
        });
        installed.push({ key: item.key, label: item.label, path: targetPath, status: 'already_installed' });
        event.sender.send('log', `✅ Already installed: ${item.label}`);
        continue;
      }
      event.sender.send('log', `📥 Downloading ${item.label}…`);
      let downloaded = false;
      let lastErr = null;
      for (let u = 0; u < item.urls.length; u++) {
        const candidateUrl = item.urls[u];
        try {
          if (u > 0) event.sender.send('log', `  ↪ retry source ${u + 1}/${item.urls.length}: ${candidateUrl}`);
          await downloadAssetStream(candidateUrl, targetPath, (downloadedBytes, totalBytes) => {
            const filePercent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
            const weightedCurrent = Math.min(itemEstimatedBytes, downloadedBytes || 0);
            const overallPercent = Math.round(((completedEstimatedBytes + weightedCurrent) / totalEstimatedBytes) * 100);
            event.sender.send('download-progress', {
              file: item.label,
              filename: item.filename,
              percent: filePercent,
              downloadedBytes,
              totalBytes,
              index: i + 1,
              totalFiles: toDownload.length,
              overallPercent,
            });
          });
          downloaded = true;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (downloaded) {
        completedEstimatedBytes += itemEstimatedBytes;
        event.sender.send('log', `✅ Downloaded: ${item.label}`);
        if (targetPath.toLowerCase().endsWith('.zip')) {
          event.sender.send('log', `📦 Extracting ${item.label} (this might take a few minutes)...`);
          try {
            const extractZip = require('extract-zip');
            await extractZip(targetPath, { dir: OFFLINE_CACHE_DIR });
            event.sender.send('log', `✅ Extracted: ${item.label}`);
            // Clean up the zip file to save space
            fs.unlink(targetPath, () => {});
          } catch (err) {
            event.sender.send('log', `❌ Failed to extract ${item.label}: ${err.message}`);
          }
        }
        installed.push({ key: item.key, label: item.label, path: targetPath, status: 'downloaded' });
      } else {
        completedEstimatedBytes += itemEstimatedBytes;
        const reason = lastErr ? lastErr.message : 'unknown error';
        failed.push({ key: item.key, label: item.label, required: !!item.required, reason });
        event.sender.send('log', `⚠️ Failed: ${item.label} (${reason})`);
      }
    }

    event.sender.send('download-progress', {
      file: 'All datasets',
      filename: '',
      percent: 100,
      downloadedBytes: 0,
      totalBytes: 0,
      index: toDownload.length,
      totalFiles: toDownload.length,
      overallPercent: 100,
    });
    const failedRequired = failed.filter((f) => f.required);
    const success = failedRequired.length === 0;
    if (!success) {
      return {
        success: false,
        error: `Required datasets failed: ${failedRequired.map((f) => f.label).join(', ')}`,
        installed,
        failed,
        skipped,
        cacheDir: OFFLINE_CACHE_DIR,
      };
    }
    return { success: true, installed, failed, skipped, cacheDir: OFFLINE_CACHE_DIR };
  } catch (err) {
    event.sender.send('log', `❌ Offline data download failed: ${err.message}`);
    return { success: false, error: err.message, cacheDir: OFFLINE_CACHE_DIR };
  }
});

ipcMain.handle('generate-research-xlsx', async (event, { oblastName, outputPath }) => {
  try {
    let pendingLogMsg = null;
    let lastLogFlush = 0;
    let flushTimer = null;
    const FLUSH_MS = 250;
    const flushLog = () => {
      if (!pendingLogMsg) return;
      event.sender.send('log', pendingLogMsg);
      pendingLogMsg = null;
      lastLogFlush = Date.now();
    };
    const onProgress = (msg) => {
      pendingLogMsg = msg;
      const now = Date.now();
      if (now - lastLogFlush >= FLUSH_MS) {
        flushLog();
        return;
      }
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushLog();
      }, FLUSH_MS);
    };
    onProgress('🔍 Checking Chrome availability…');
    const chromePath = await ensurePuppeteerChrome();
    if (chromePath) onProgress(`✅ Chrome: ${chromePath}`);
    const result = await generateResearchXlsx(oblastName, outputPath, onProgress, chromePath);
    if (flushTimer) clearTimeout(flushTimer);
    flushLog();
    return result;
  } catch (err) {
    event.sender.send('log', `❌ Research generation failed: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.on('stop-research', () => stopResearch());
