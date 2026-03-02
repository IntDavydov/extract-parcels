'use strict';

// ── Helpers ────────────────────────────────────────────────
function appendLog(msg) {
  const el = document.getElementById('main-log');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  const formatted = msg.replace(/^\[ERR(?:OR)?\]\s*/i, '❌ ');
  el.textContent += formatted + '\n';
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function sanitizeFilename(name) {
  return (name || 'land_management')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .trim() || 'land_management';
}

// Forward all main-process log events to the single log area
window.api.onLog((msg) => appendLog(msg));

// ── State ──────────────────────────────────────────────────
let outputFolder   = '';
let boundaryFiles  = []; // [{path, url, bbox, name}]
let userStopped    = false;
let proxyCache     = null;
let usedProxies    = new Set();

function renderBoundaryList() {
  const list = document.getElementById('boundary-list');
  const btn  = document.getElementById('btn-clear-boundary');
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
  // When multiple KMZ: disable area name + OSM layers
  const isMultiKmz = boundaryFiles.length > 1;
  document.getElementById('area-name').disabled = isMultiKmz;
  document.querySelectorAll('input[name="layer"]').forEach(cb => { cb.disabled = isMultiKmz; });
  document.getElementById('btn-select-all').disabled = isMultiKmz;
  document.getElementById('btn-clear-all').disabled  = isMultiKmz;
  if (isMultiKmz) {
    document.querySelectorAll('input[name="layer"]').forEach(cb => { cb.checked = false; });
    document.getElementById('wind-settings').style.display = 'none';
  }
}

// ── Boundary picker ────────────────────────────────────────
document.getElementById('drop-zone').addEventListener('click', async (e) => {
  if (e.target.id === 'btn-clear-boundary') return; // let clear handle itself
  const result = await window.api.openKmlDialog();
  if (!result.canceled && result.filePaths.length) {
    for (const filePath of result.filePaths) {
      const name = filePath.split(/[\\/]/).pop();
      const bbox = await window.api.readKmlBbox(filePath);
      if (bbox && !bbox.error) {
        const url = `https://kadastr.live/#${bbox.zoom}/${bbox.centerLat.toFixed(5)}/${bbox.centerLng.toFixed(5)}`;
        boundaryFiles.push({ path: filePath, url, bbox: { west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north }, name });
        appendLog(`📍 ${name}: zoom=${bbox.zoom}, center=${bbox.centerLat.toFixed(4)},${bbox.centerLng.toFixed(4)}`);
      } else {
        appendLog(`⚠ Could not read bbox from ${name}${bbox?.error ? ': ' + bbox.error : ''}`);
      }
    }
    renderBoundaryList();
    checkStartReady();
  }
});

document.getElementById('btn-clear-boundary').addEventListener('click', () => {
  boundaryFiles = [];
  renderBoundaryList();
  checkStartReady();
});

// ── Drag & drop ────────────────────────────────────────────
// Prevent Electron from navigating to dropped files
document.addEventListener('dragover',  (e) => e.preventDefault());
document.addEventListener('drop',      (e) => e.preventDefault());

async function addDroppedFiles(filePaths) {
  const valid = filePaths.filter(p => /\.(kmz|kml)$/i.test(p));
  if (!valid.length) return;
  for (const filePath of valid) {
    const name = filePath.split(/[\\/]/).pop();
    const bbox = await window.api.readKmlBbox(filePath);
    if (bbox && !bbox.error) {
      const url = `https://kadastr.live/#${bbox.zoom}/${bbox.centerLat.toFixed(5)}/${bbox.centerLng.toFixed(5)}`;
      boundaryFiles.push({ path: filePath, url, bbox: { west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north }, name });
      appendLog(`📍 ${name}: zoom=${bbox.zoom}, center=${bbox.centerLat.toFixed(4)},${bbox.centerLng.toFixed(4)}`);
    } else {
      appendLog(`⚠ Could not read bbox from ${name}${bbox?.error ? ': ' + bbox.error : ''}`);
    }
  }
  renderBoundaryList();
  checkStartReady();
}

const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'copy';
  dropZone.style.borderColor = '#4a90d9';
  dropZone.style.background  = '#0f2a50';
});
dropZone.addEventListener('dragleave', (e) => {
  if (dropZone.contains(e.relatedTarget)) return;
  dropZone.style.borderColor = '#2a4a7f';
  dropZone.style.background  = '';
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.style.borderColor = '#2a4a7f';
  dropZone.style.background  = '';
  // f.path is Electron-specific; filter out empty (e.g. folders)
  const paths = [...e.dataTransfer.files]
    .map(f => window.api.getPathForFile(f))
    .filter(p => p && /\.(kmz|kml)$/i.test(p));
  if (paths.length) addDroppedFiles(paths);
  else appendLog('⚠ No KMZ/KML files found in drop — only .kmz/.kml are supported.');
});

// ── Output folder picker ───────────────────────────────────
document.getElementById('btn-pick-folder').addEventListener('click', async () => {
  const result = await window.api.openFolderDialog();
  if (!result.canceled && result.filePaths.length) {
    outputFolder = result.filePaths[0];
    document.getElementById('output-folder-display').textContent = outputFolder;
    checkStartReady();
  }
});

// ── Layer checkboxes ───────────────────────────────────────
document.getElementById('btn-select-all').addEventListener('click', () => {
  document.querySelectorAll('input[name="layer"]').forEach(cb => cb.checked = true);
  document.getElementById('wind-settings').style.display = 'block';
  checkStartReady();
});

document.getElementById('btn-clear-all').addEventListener('click', () => {
  document.querySelectorAll('input[name="layer"]').forEach(cb => cb.checked = false);
  document.getElementById('wind-settings').style.display = 'none';
  checkStartReady();
});

document.getElementById('layer-wind').addEventListener('change', (e) => {
  document.getElementById('wind-settings').style.display = e.target.checked ? 'block' : 'none';
});

document.getElementById('area-name').addEventListener('input', () => {
  const isMulti = document.getElementById('area-name').value.includes('...');
  document.getElementById('drop-zone').style.pointerEvents = isMulti ? 'none' : '';
  document.getElementById('drop-zone').style.opacity = isMulti ? '0.4' : '';
  if (isMulti && boundaryFiles.length) {
    boundaryFiles = [];
    renderBoundaryList();
  }
  checkStartReady();
});

// Track every individual checkbox change
document.querySelectorAll('input[name="layer"]').forEach(cb => {
  cb.addEventListener('change', checkStartReady);
});

// ── Start / Stop ───────────────────────────────────────────
function hasAnything() {
  const hasBoundary = boundaryFiles.length > 0;
  const hasLayers   = document.querySelectorAll('input[name="layer"]:checked').length > 0;
  return hasBoundary || hasLayers;
}

function checkStartReady() {
  const territory    = document.getElementById('area-name').value.trim();
  const isMultiKmz   = boundaryFiles.length > 1;
  // Multi-KMZ mode: only need output folder + files
  // Single/no boundary: need territory + something to do
  const ready = !!outputFolder && (isMultiKmz || (!!territory && hasAnything()));
  document.getElementById('btn-start').disabled = !ready;
}

function setBusy(busy) {
  document.getElementById('btn-start').disabled = busy;
}


document.getElementById('btn-start').addEventListener('click', async () => {
  if (!outputFolder) { appendLog('⚠ Please select an output folder.'); return; }

  const rawInput   = document.getElementById('area-name').value.trim();
  const areas      = rawInput.split('...').map(s => s.trim()).filter(Boolean);
  const territory  = areas[0] || '';
  const isMultiArea = areas.length > 1;
  const isMultiKmz  = boundaryFiles.length > 1;
  const layers     = [...document.querySelectorAll('input[name="layer"]:checked')].map(cb => cb.value);

  // ── Validate ──
  if (isMultiKmz) {
    // Multi-KMZ mode: no other requirements
  } else if (!boundaryFiles.length) {
    if (!territory) { appendLog('⚠ Please enter an area name.'); return; }
    if (!layers.length) { appendLog('⚠ Please select at least one layer.'); return; }
  } else {
    if (boundaryFiles[0].url === '' ) { appendLog('⚠ Boundary file could not be parsed.'); return; }
    if (layers.length > 0 && !territory) { appendLog('⚠ Please enter an area name for OSM layers.'); return; }
  }

  const windOptions = layers.includes('wind') ? {
    apiKey: 'hWrMKuAzGg0OCHhfidHrcuygKydLiRhyWuhXEUeZ',
    hubHeight: document.getElementById('wind-hub-height').value,
    year: '2019', email: 'successful0506@gmail.com',
  } : null;

  document.getElementById('main-log').textContent = '';
  setBusy(true);
  userStopped = false;

  // Helper: run kadastr scraper for one boundary file with proxy retry
  async function scrapeOne(bf, label) {
    appendLog(`━━━ Kadastr: ${label} ━━━`);
    let tilesGot = 0;
    for (let round = 1; round <= 2 && tilesGot === 0; round++) {
      if (round === 2) { appendLog('🔄 Refetching proxy list…'); proxyCache = null; }
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (!proxyCache) {
          appendLog(`🔎 Searching proxy (round ${round}, attempt ${attempt}/3)…`);
          proxyCache = await window.api.findProxy([...usedProxies]);
          if (proxyCache) usedProxies.add(proxyCache);
        }
        const res = await window.api.startScraping(bf.url, outputFolder,
          { headless: true, boundaryFilter: bf.path, proxy: proxyCache || '' });
        appendLog(`Scraper exited (code ${res.code})`);
        tilesGot = res.tiles || 0;
        if (tilesGot > 0) break;
        if (attempt < 3) { appendLog(`⚠ No tiles — trying next proxy…`); proxyCache = null; }
      }
    }
    return tilesGot;
  }

  // ══════════════════════════════════════════════════════════
  // MULTI-KMZ MODE — batch kadastr scraping, output: Parcels.kmz
  // ══════════════════════════════════════════════════════════
  if (isMultiKmz) {
    const finalOutput = await window.api.resolveOutputPath(outputFolder, 'Parcels');
    const kmzPaths = [], folderNames = [];

    for (let i = 0; i < boundaryFiles.length; i++) {
      const bf = boundaryFiles[i];
      // Folder name = coordinates portion of kadastr URL (after #)
      const folderName = bf.url.includes('#') ? bf.url.split('#')[1] : bf.name.replace(/\.kmz?$/i, '');
      const tempPath   = `${outputFolder}/_kadastr_temp_${i}.kmz`;

      const tilesGot = await scrapeOne(bf, `${i + 1}/${boundaryFiles.length}: ${bf.name}`);
      if (tilesGot === 0) { appendLog(`⚠ Skipping ${bf.name} — no tiles.`); continue; }

      // land_plots.kmz is the fixed output of the scraper; rename to temp
      const scraperOut = `${outputFolder}/land_plots.kmz`;
      const fs_rename  = await window.api.mergeKmz([scraperOut], tempPath, true);
      if (!fs_rename.success) { appendLog(`⚠ Could not save temp KMZ for ${bf.name}`); continue; }

      kmzPaths.push(tempPath);
      folderNames.push(folderName);
    }

    if (!kmzPaths.length) { appendLog('❌ All files failed.'); setBusy(false); return; }

    appendLog('\n📦 Merging into Parcels.kmz…');
    const mergeResult = await window.api.mergeKmz(kmzPaths, finalOutput, true, folderNames);
    if (mergeResult.success) {
      appendLog(`\n✅ Done → ${finalOutput}`);
      window.api.copyIcons(outputFolder);
      window.api.showInFolder(finalOutput);
    } else {
      appendLog(`[ERROR] Merge failed: ${mergeResult.error}`);
    }
    setBusy(false);
    return;
  }

  // ══════════════════════════════════════════════════════════
  // MULTI-AREA MODE — save each area as its own KMZ file
  // ══════════════════════════════════════════════════════════
  if (isMultiArea) {
    if (!layers.length) { appendLog('⚠ Select at least one OSM layer.'); setBusy(false); return; }

    let successCount = 0;
    for (let i = 0; i < areas.length; i++) {
      const area = areas[i];
      appendLog(`\n━━━ Area ${i + 1}/${areas.length}: ${area} ━━━`);
      const areaFilename = sanitizeFilename(area);
      const areaOutput   = await window.api.resolveOutputPath(outputFolder, areaFilename);
      const osmResult = await window.api.fetchOSM({
        territory: area, layers, outputPath: areaOutput,
        format: 'kmz', windOptions, fallbackBbox: null,
      });
      if (!osmResult.success) { appendLog(`[ERROR] Failed for "${area}": ${osmResult.error}`); continue; }
      appendLog(`✅ ${area} → ${areaOutput}`);
      successCount++;
    }
    if (!successCount) { appendLog('❌ All areas failed.'); setBusy(false); return; }
    appendLog(`\n✅ Done — ${successCount}/${areas.length} areas saved to ${outputFolder}`);
    window.api.copyIcons(outputFolder);
    window.api.showInFolder(outputFolder);
    setBusy(false);
    return;
  }

  // ══════════════════════════════════════════════════════════
  // SINGLE AREA MODE
  // ══════════════════════════════════════════════════════════
  const safeFilename = sanitizeFilename(territory || 'land_plots');
  const finalOutput  = await window.api.resolveOutputPath(outputFolder, safeFilename);
  const kadastrTemp  = outputFolder + '/land_plots.kmz';
  const osmTemp      = outputFolder + '/_osm_temp.kmz';
  const bf           = boundaryFiles[0] || null;
  let hasKadastr     = false;

  if (bf) {
    const tilesGot = await scrapeOne(bf, territory || bf.name);
    if (tilesGot === 0) {
      appendLog('❌ No tiles after 6 attempts — kadastr.live unreachable. Stopping.');
      setBusy(false); return;
    }
    hasKadastr = true;
    if (userStopped) { appendLog('ℹ Stopped — saved as land_plots.kmz'); setBusy(false); return; }
  }

  if (layers.length > 0) {
    appendLog(`\n━━━ Phase 2: OSM layers [${layers.join(', ')}] ━━━`);
    const osmResult = await window.api.fetchOSM({
      territory, layers, outputPath: osmTemp, format: 'kmz',
      windOptions, fallbackBbox: bf?.bbox || null,
    });
    if (!osmResult.success) {
      appendLog(`[ERROR] OSM fetch failed: ${osmResult.error}`);
      if (hasKadastr) appendLog(`ℹ Kadastr data saved as land_plots.kmz`);
      setBusy(false); return;
    }
    const toMerge = hasKadastr ? [kadastrTemp, osmTemp] : [osmTemp];
    appendLog(hasKadastr ? '\n📦 Merging KMZ files…' : '');
    const mergeResult = await window.api.mergeKmz(toMerge, finalOutput, true);
    if (mergeResult.success) {
      appendLog(`\n✅ Done → ${finalOutput}`);
      window.api.copyIcons(outputFolder);
      window.api.showInFolder(finalOutput);
    } else { appendLog(`[ERROR] Merge failed: ${mergeResult.error}`); }
  } else {
    appendLog(`\n✅ Done → ${kadastrTemp}`);
    window.api.copyIcons(outputFolder);
    window.api.showInFolder(kadastrTemp);
  }

  setBusy(false);
});
