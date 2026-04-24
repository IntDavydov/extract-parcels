'use strict';

const LOG_MAX_LINES = 1500;
let logLines = [];
let logFlushScheduled = false;

let outputFolder = '';
let boundaryFiles = [];
let csvPath = '';
let elandOutputPath = '';
let elandOutputFormat = 'xlsx_full';
let userStopped = false;

function flushLog() {
  const el = document.getElementById('main-log');
  if (!el) { logFlushScheduled = false; return; }
  const chunk = logLines.splice(0, 200);
  if (chunk.length) {
    const current = el.textContent ? el.textContent.split('\n') : [];
    current.push(...chunk);
    if (current.length > LOG_MAX_LINES) current.splice(0, current.length - LOG_MAX_LINES);
    el.textContent = current.join('\n');
    el.scrollTop = el.scrollHeight;
  }
  logFlushScheduled = false;
  if (logLines.length) scheduleLogFlush();
}

function scheduleLogFlush() {
  if (logFlushScheduled) return;
  logFlushScheduled = true;
  requestAnimationFrame(flushLog);
}

function appendLog(msg) {
  logLines.push(String(msg || '').replace(/^\[ERR(?:OR)?\]\s*/i, '❌ '));
  scheduleLogFlush();
}

window.api.onLog((msg) => appendLog(msg));

function setBusy(busy) {
  document.getElementById('btn-start').disabled = busy || !(outputFolder && boundaryFiles.length);
  document.getElementById('btn-stop').style.display = busy ? '' : 'none';
}

function setElandBusy(busy) {
  document.getElementById('btn-eland-start').disabled = busy || !(csvPath && elandOutputPath);
  document.getElementById('btn-eland-stop').style.display = busy ? '' : 'none';
}

function checkReady() {
  if (document.getElementById('btn-stop').style.display === 'none') {
    document.getElementById('btn-start').disabled = !(outputFolder && boundaryFiles.length);
  }
  if (document.getElementById('btn-eland-stop').style.display === 'none') {
    document.getElementById('btn-eland-start').disabled = !(csvPath && elandOutputPath);
  }
}

function makeParcelUrlForBoundary(boundaryFile) {
  const bbox = boundaryFile?.bbox || {};
  const hash = (boundaryFile?.url || '').split('#')[1] || '';
  const [z] = hash.split('/');
  const zoomFromUrl = Number(z);
  const zoom = Number.isFinite(Number(bbox.zoom)) ? Number(bbox.zoom) : (Number.isFinite(zoomFromUrl) ? zoomFromUrl : 14);
  const centerLat = Number.isFinite(Number(bbox.centerLat))
    ? Number(bbox.centerLat)
    : ((Number(bbox.south) + Number(bbox.north)) / 2);
  const centerLng = Number.isFinite(Number(bbox.centerLng))
    ? Number(bbox.centerLng)
    : ((Number(bbox.west) + Number(bbox.east)) / 2);
  return `https://kadastrova-karta.com/#${zoom}/${centerLat.toFixed(5)}/${centerLng.toFixed(5)}`;
}

function renderBoundaryList() {
  const list = document.getElementById('boundary-list');
  const btn = document.getElementById('btn-clear-boundary');
  const hint = document.getElementById('drop-hint');
  if (!boundaryFiles.length) {
    list.textContent = '';
    btn.style.display = 'none';
    hint.style.display = '';
  } else {
    list.textContent = boundaryFiles.map((f, i) => `${i + 1}. ${f.name}`).join('\n');
    btn.style.display = '';
    hint.style.display = 'none';
  }
}

async function addBoundaryPaths(filePaths) {
  for (const filePath of filePaths.filter((p) => /\.(kmz|kml)$/i.test(p))) {
    const name = filePath.split(/[\\/]/).pop();
    const bbox = await window.api.readKmlBbox(filePath);
    if (bbox && !bbox.error) {
      const url = `https://kadastrova-karta.com/#${bbox.zoom}/${bbox.centerLat.toFixed(5)}/${bbox.centerLng.toFixed(5)}`;
      boundaryFiles.push({
        path: filePath,
        url,
        bbox: {
          west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north,
          centerLat: bbox.centerLat, centerLng: bbox.centerLng, zoom: bbox.zoom,
        },
        name,
      });
      appendLog(`📍 ${name}: zoom=${bbox.zoom}, center=${bbox.centerLat.toFixed(4)},${bbox.centerLng.toFixed(4)}`);
    } else {
      appendLog(`⚠ Could not read bbox from ${name}${bbox?.error ? ': ' + bbox.error : ''}`);
    }
  }
  renderBoundaryList();
  checkReady();
}

document.querySelectorAll('.left-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const targetId = btn.dataset.tabTarget;
    document.querySelectorAll('.left-tab-btn').forEach((b) => {
      const isActive = b === btn;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    document.querySelectorAll('.left-tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === targetId);
    });
  });
});

document.getElementById('drop-zone').addEventListener('click', async (e) => {
  if (e.target.id === 'btn-clear-boundary') return;
  const result = await window.api.openKmlDialog();
  if (!result.canceled && result.filePaths.length) await addBoundaryPaths(result.filePaths);
});

document.getElementById('btn-clear-boundary').addEventListener('click', () => {
  boundaryFiles = [];
  renderBoundaryList();
  checkReady();
});

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'copy';
  dropZone.style.borderColor = '#4a90d9';
  dropZone.style.background = '#0f2a50';
});
dropZone.addEventListener('dragleave', (e) => {
  if (dropZone.contains(e.relatedTarget)) return;
  dropZone.style.borderColor = '#2a4a7f';
  dropZone.style.background = '';
});
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.style.borderColor = '#2a4a7f';
  dropZone.style.background = '';
  const paths = [...e.dataTransfer.files]
    .map((f) => window.api.getPathForFile(f))
    .filter((p) => p && /\.(kmz|kml)$/i.test(p));
  if (!paths.length) {
    appendLog('⚠ No KMZ/KML files found in drop.');
    return;
  }
  await addBoundaryPaths(paths);
});

document.getElementById('btn-pick-folder').addEventListener('click', async () => {
  const result = await window.api.openFolderDialog();
  if (!result.canceled && result.filePaths.length) {
    outputFolder = result.filePaths[0];
    document.getElementById('output-folder-display').textContent = outputFolder;
    checkReady();
  }
});

async function scrapeWithRetries(startUrl, boundaryPath, label) {
  appendLog(`━━━ Parcels: ${label} ━━━`);
  let tilesGot = 0;
  let parcelsGot = 0;
  for (let round = 1; round <= 2 && tilesGot === 0 && !userStopped; round++) {
    for (let attempt = 1; attempt <= 3 && !userStopped; attempt++) {
      const res = await window.api.startScraping(startUrl, outputFolder, {
        headless: true,
        boundaryFilter: boundaryPath,
        parcelSource: 'kadastrova_karta',
      });
      appendLog(`Scraper exited (code ${res.code})`);
      tilesGot = res.tiles || 0;
      parcelsGot = res.parcels || 0;
      if (parcelsGot > 0) break;
      if (attempt < 3) appendLog(`⚠ No parcels yet — retrying (${attempt + 1}/3)…`);
    }
  }
  return { tiles: tilesGot, parcels: parcelsGot };
}

document.getElementById('btn-start').addEventListener('click', async () => {
  if (!outputFolder || !boundaryFiles.length) return;
  document.getElementById('main-log').textContent = '';
  userStopped = false;
  setBusy(true);
  appendLog(`🗺 Kadastr parcel scraping mode (${boundaryFiles.length} boundary file(s))`);

  try {
    if (boundaryFiles.length === 1) {
      const bf = boundaryFiles[0];
      const scrapeRes = await scrapeWithRetries(makeParcelUrlForBoundary(bf), bf.path, bf.name);
      if (userStopped) return;
      if (scrapeRes.tiles === 0) {
        appendLog('❌ No tiles/parcels after retries.');
        return;
      }
      const finalOutput = await window.api.resolveOutputPath(outputFolder, 'kadastr');
      const mergeResult = await window.api.mergeKmz([`${outputFolder}/land_plots.kmz`], finalOutput, true);
      if (mergeResult.success) {
        appendLog(`✅ Done → ${finalOutput}`);
        await window.api.copyIcons(outputFolder);
        window.api.showInFolder(finalOutput);
      } else {
        appendLog(`❌ Save failed: ${mergeResult.error}`);
      }
      return;
    }

    const finalOutput = await window.api.resolveOutputPath(outputFolder, 'kadastr');
    const kmzPaths = [];
    const folderNames = [];
    for (let i = 0; i < boundaryFiles.length; i++) {
      if (userStopped) return;
      const bf = boundaryFiles[i];
      const folderName = bf.url.includes('#') ? bf.url.split('#')[1] : bf.name.replace(/\.kmz?$/i, '');
      const tempPath = `${outputFolder}/_kadastr_temp_${i}.kmz`;
      const scrapeRes = await scrapeWithRetries(makeParcelUrlForBoundary(bf), bf.path, `${i + 1}/${boundaryFiles.length}: ${bf.name}`);
      if (scrapeRes.tiles === 0) {
        appendLog(`⚠ Skipping ${bf.name} — no tiles.`);
        continue;
      }
      const saveRes = await window.api.mergeKmz([`${outputFolder}/land_plots.kmz`], tempPath, true);
      if (!saveRes.success) {
        appendLog(`⚠ Could not save temp KMZ for ${bf.name}`);
        continue;
      }
      kmzPaths.push(tempPath);
      folderNames.push(folderName);
    }
    if (!kmzPaths.length) {
      appendLog('❌ All files failed.');
      return;
    }
    appendLog('📦 Merging into kadastr.kmz…');
    const mergeResult = await window.api.mergeKmz(kmzPaths, finalOutput, true, folderNames);
    if (mergeResult.success) {
      appendLog(`✅ Done → ${finalOutput}`);
      await window.api.copyIcons(outputFolder);
      window.api.showInFolder(finalOutput);
    } else {
      appendLog(`❌ Merge failed: ${mergeResult.error}`);
    }
  } finally {
    setBusy(false);
  }
});

document.getElementById('btn-stop').addEventListener('click', () => {
  userStopped = true;
  window.api.stopScraping();
  appendLog('⛔ Stop requested');
});

document.getElementById('btn-pick-csv').addEventListener('click', async () => {
  const result = await window.api.openCsvDialog();
  if (!result.canceled && result.filePaths.length) {
    csvPath = result.filePaths[0];
    document.getElementById('csv-display').textContent = csvPath.split(/[\\/]/).pop();
    checkReady();
  }
});

function syncElandOutputControls() {
  const isDocx = elandOutputFormat === 'docx';
  document.getElementById('output-file-label').innerHTML = isDocx
    ? 'Output DOCX <span style="color:#e05;">*required</span>'
    : 'Output XLSX <span style="color:#e05;">*required</span>';
}

document.getElementById('eland-output-format').addEventListener('change', (e) => {
  elandOutputFormat = String(e.target.value || 'xlsx_full');
  elandOutputPath = '';
  document.getElementById('output-file-display').textContent = 'not selected';
  syncElandOutputControls();
  checkReady();
});

document.getElementById('btn-pick-output-file').addEventListener('click', async () => {
  const ext = elandOutputFormat === 'docx' ? 'docx' : 'xlsx';
  const kind = elandOutputFormat === 'docx' ? 'Word' : 'Excel';
  const result = await window.api.saveDialog({
    title: 'Save e.land lookup result',
    defaultPath: elandOutputPath || `eland_lookup.${ext}`,
    filters: [{ name: kind, extensions: [ext] }],
  });
  if (!result.canceled && result.filePath) {
    elandOutputPath = result.filePath;
    document.getElementById('output-file-display').textContent = elandOutputPath.split(/[\\/]/).pop();
    checkReady();
  }
});

document.getElementById('btn-eland-start').addEventListener('click', async () => {
  if (!csvPath || !elandOutputPath) return;
  setElandBusy(true);
  appendLog(`📋 e.land lookup: ${csvPath.split(/[\\/]/).pop()}`);
  try {
    const result = await window.api.startElandLookup(csvPath, elandOutputPath, { format: elandOutputFormat });
    if (result.success) {
      appendLog(`✅ Done → ${result.outputPath}`);
      window.api.showInFolder(result.outputPath);
    } else {
      appendLog(`❌ Failed: ${result.error || 'Unknown error'}`);
    }
  } finally {
    setElandBusy(false);
  }
});

document.getElementById('btn-eland-stop').addEventListener('click', () => {
  window.api.stopElandLookup();
  appendLog('⛔ e.land stop requested');
});

syncElandOutputControls();
