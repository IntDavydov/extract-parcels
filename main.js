const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
ipcMain.on('start-scraping', (event, { url, outputPath, headless, boundaryFilter }) => {
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

  const kmzPath = outputPath
    ? path.join(outputPath, 'land_plots.kmz')
    : path.join(process.cwd(), 'land_plots.kmz');
  event.sender.send('log', `💾 Output will be saved to: ${kmzPath}`);

  const args = [getUnpackedPath('script.js')];
  if (url) args.push(url);

  scrapingProcess = spawn(process.execPath, args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  scrapingProcess.stdout.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach((line) => {
      event.sender.send('log', line);
    });
  });

  scrapingProcess.stderr.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach((line) => {
      event.sender.send('log', '[ERR] ' + line);
    });
  });

  scrapingProcess.on('close', (code) => {
    event.sender.send('log', `Process exited with code ${code}`);
    event.sender.send('scraping-done', { code });
    scrapingProcess = null;
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
      options.windOptions || null
    );
    event.sender.send('osm-done', { path: resultPath });
    return { success: true, path: resultPath };
  } catch (err) {
    event.sender.send('log', '[ERROR] ' + err.message);
    return { success: false, error: err.message };
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
    properties: ['openFile'],
    filters: [{ name: 'KMZ / KML', extensions: ['kmz', 'kml'] }],
  });
  return result;
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
