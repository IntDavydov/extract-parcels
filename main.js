const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { lookupEland, stopLookup } = require('./src/eland');

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: start kadastr scraping
ipcMain.handle('start-scraping', (event, { url, outputPath, headless, boundaryFilter, proxy, gridCells }) => {
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
  if (gridCells && gridCells.length) env.GRID_CELLS = JSON.stringify(gridCells);

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
        folders.push(
          `<Folder><name>${escXmlAttr(areaName)}</name>` +
          areaGroundOverlays.join('') +
          areaFolders.join('') +
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
          // Send a real HTTP GET request and verify we get a valid response body
          const tlsSocket = tls.connect({ socket, servername: targetHost, rejectUnauthorized: false }, () => {
            tlsSocket.write(
              `GET / HTTP/1.1\r\nHost: ${targetHost}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`
            );
            let response = '';
            tlsSocket.on('data', (chunk) => {
              response += chunk.toString('binary', 0, Math.min(chunk.length, 512));
              // Accept any real HTTP response (2xx, 3xx, 4xx — means server actually replied)
              if (/^HTTP\/1\.[01] [2-5]\d\d/.test(response)) {
                tlsSocket.destroy();
                finish(true);
              }
            });
            tlsSocket.on('end', () => {
              finish(/^HTTP\/1\.[01] [2-5]\d\d/.test(response));
            });
            tlsSocket.on('error', () => finish(false));
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
      const ok = await testHttpProxy(host, parseInt(port), 'kadastr.live', 443, 12000);
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

ipcMain.handle('show-in-folder', (_event, filePath) => {
  shell.showItemInFolder(filePath);
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

ipcMain.handle('start-eland-lookup', async (event, { csvPath, outputXlsx }) => {
  try {
    const onProgress = msg => event.sender.send('log', msg);
    const result = await lookupEland(csvPath, outputXlsx, onProgress);
    return result;
  } catch (err) {
    event.sender.send('log', `❌ e.land lookup failed: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.on('stop-eland-lookup', () => stopLookup());
