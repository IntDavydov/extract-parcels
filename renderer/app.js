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
window.api.onDownloadProgress((data) => {
  const progress = document.getElementById('offline-download-progress');
  const status = document.getElementById('offline-download-status');
  if (!progress || !status || !data) return;
  const overall = Math.max(0, Math.min(100, Number(data.overallPercent || 0)));
  progress.style.width = `${overall}%`;
  if (data.status === 'already_installed') {
    status.textContent = `${data.file || 'Dataset'}: already installed (overall ${overall}%)`;
    return;
  }
  const perFile = Number.isFinite(Number(data.percent)) ? `${Math.max(0, Math.min(100, Number(data.percent)))}%` : '?';
  status.textContent = `${data.file || 'Downloading'}: ${perFile} (overall ${overall}%)`;
});

function initLeftTabs() {
  const tabButtons = [...document.querySelectorAll('.left-tab-btn')];
  const tabPanels = [...document.querySelectorAll('.left-tab-panel')];
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.tabTarget;
      tabButtons.forEach((b) => {
        const isActive = b === btn;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      tabPanels.forEach((panel) => panel.classList.toggle('active', panel.id === targetId));
    });
  });
}

initLeftTabs();

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
    document.getElementById('area-name').disabled = false;
  } else {
    list.textContent = boundaryFiles.map((f, i) => `${i + 1}. ${f.name}`).join('\n');
    btn.style.display = '';
    hint.style.display = 'none';
  }
  // When multiple KMZ: disable area name + OSM layers
  // When exactly one KMZ: disable + clear area name (not needed — folder named by coords)
  const isMultiKmz  = boundaryFiles.length > 1;
  const areaInput   = document.getElementById('area-name');
  areaInput.disabled = isMultiKmz;
  if (isMultiKmz) areaInput.value = '';
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

function applyFullParcelsMode(enabled) {
  const dropZone   = document.getElementById('drop-zone');
  const areaInput  = document.getElementById('area-name');
  dropZone.style.pointerEvents = enabled ? 'none' : '';
  dropZone.style.opacity       = enabled ? '0.4' : '';
  document.querySelectorAll('input[name="layer"]').forEach(cb => { cb.disabled = enabled; if (enabled) cb.checked = false; });
  document.getElementById('btn-select-all').disabled = enabled;
  document.getElementById('btn-clear-all').disabled  = enabled;
  if (enabled) document.getElementById('wind-settings').style.display = 'none';
  if (enabled && boundaryFiles.length) { boundaryFiles = []; renderBoundaryList(); }
  // Disable ... multi-area when in full-parcels mode
  if (enabled) {
    const val = areaInput.value;
    const dotIdx = val.indexOf('...');
    if (dotIdx >= 0) areaInput.value = val.slice(0, dotIdx).trim();
  }
  checkStartReady();
}

document.getElementById('chk-full-parcels').addEventListener('change', (e) => {
  applyFullParcelsMode(e.target.checked);
});

document.getElementById('area-name').addEventListener('input', () => {
  const isFullParcels = document.getElementById('chk-full-parcels').checked;
  const val = document.getElementById('area-name').value;
  const isMulti = !isFullParcels && val.includes('...');
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
  const territory     = document.getElementById('area-name').value.trim();
  const isMultiKmz   = boundaryFiles.length > 1;
  const isSingleKmz  = boundaryFiles.length === 1;
  const isFullParcels = document.getElementById('chk-full-parcels').checked;
  const ready = !!outputFolder && (
    isMultiKmz  ? true :
    isSingleKmz ? true :
    isFullParcels ? !!territory :
    (!!territory && hasAnything())
  );
  document.getElementById('btn-start').disabled = !ready;
}

function setBusy(busy) {
  document.getElementById('btn-start').disabled = busy;
}


document.getElementById('btn-start').addEventListener('click', async () => {
  if (!outputFolder) { appendLog('⚠ Please select an output folder.'); return; }

  const rawInput      = document.getElementById('area-name').value.trim();
  const isFullParcels = document.getElementById('chk-full-parcels').checked;
  const areas         = rawInput.split('...').map(s => s.trim()).filter(Boolean);
  const territory     = areas[0] || '';
  const isMultiArea   = !isFullParcels && areas.length > 1;
  const isMultiKmz    = boundaryFiles.length > 1;
  const layers        = [...document.querySelectorAll('input[name="layer"]:checked')].map(cb => cb.value);

  // ── Validate ──
  if (isFullParcels) {
    if (!territory) { appendLog('⚠ Please enter an area name.'); return; }
  } else if (isMultiKmz) {
    // Multi-KMZ mode: no other requirements
  } else if (!boundaryFiles.length) {
    if (!territory) { appendLog('⚠ Please enter an area name.'); return; }
    if (!layers.length) { appendLog('⚠ Please select at least one layer.'); return; }
  } else {
    if (boundaryFiles[0].url === '' ) { appendLog('⚠ Boundary file could not be parsed.'); return; }
    if (layers.length > 0 && !territory) { appendLog('⚠ Please enter an area name for OSM layers.'); return; }
  }

  const windOptions = layers.includes('wind') ? {
    hubHeight: parseInt(document.getElementById('wind-hub-height').value, 10),
  } : null;

  document.getElementById('main-log').textContent = '';
  setBusy(true);
  userStopped = false;

  // Helper: run kadastr scraper for one boundary file with proxy retry
  async function scrapeOne(bf, label) {
    appendLog(`━━━ Kadastr: ${label} ━━━`);
    const useVpn = document.getElementById('chk-use-vpn').checked;
    let tilesGot = 0;
    for (let round = 1; round <= 2 && tilesGot === 0; round++) {
      if (round === 2) { appendLog('🔄 Refetching proxy list…'); proxyCache = null; }
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (!useVpn && !proxyCache) {
          appendLog(`🔎 Searching proxy (round ${round}, attempt ${attempt}/3)…`);
          proxyCache = await window.api.findProxy([...usedProxies]);
          if (proxyCache) usedProxies.add(proxyCache);
        }
        const res = await window.api.startScraping(bf.url, outputFolder,
          { headless: true, boundaryFilter: bf.path, proxy: useVpn ? '' : (proxyCache || '') });
        appendLog(`Scraper exited (code ${res.code})`);
        tilesGot = res.tiles || 0;
        if (tilesGot > 0) break;
        if (!useVpn && attempt < 3) { appendLog(`⚠ No tiles — trying next proxy…`); proxyCache = null; }
        if (useVpn) break; // no proxy retries in VPN mode
      }
      if (useVpn) break; // no second round in VPN mode
    }
    return tilesGot;
  }

  // ══════════════════════════════════════════════════════════
  // FULL-AREA PARCELS MODE — auto-grid the territory bbox
  // ══════════════════════════════════════════════════════════
  if (isFullParcels) {
    appendLog(`🗺 Resolving bbox for "${territory}"…`);
    const bboxResult = await window.api.resolveBbox(territory);
    if (!bboxResult.success) {
      appendLog(`❌ Could not resolve area: ${bboxResult.error}`);
      setBusy(false); return;
    }
    const { bbox, boundaryGeojson } = bboxResult;
    appendLog(`📐 Bbox: ${bbox.south.toFixed(4)},${bbox.west.toFixed(4)} → ${bbox.north.toFixed(4)},${bbox.east.toFixed(4)}`);

    // Create a temp boundary KMZ (used by scraper to filter parcels)
    const tempBoundaryPath = `${outputFolder}/_full_area_boundary.kmz`;
    const bkmzResult = await window.api.createBoundaryKmz(boundaryGeojson, tempBoundaryPath);
    if (!bkmzResult.success) {
      appendLog(`❌ Could not create boundary KMZ: ${bkmzResult.error}`);
      setBusy(false); return;
    }

    // Grid: zoom-14 viewport ≈ 0.08°×0.06°, step with ~25% overlap
    const stepLon = 0.060, stepLat = 0.050;
    const cells = [];
    for (let lat = bbox.south + stepLat / 2; lat < bbox.north; lat += stepLat)
      for (let lng = bbox.west + stepLon / 2; lng < bbox.east; lng += stepLon)
        cells.push({ lat: +lat.toFixed(5), lng: +lng.toFixed(5) });

    appendLog(`🔲 Grid: ${cells.length} cells — launching single scraper session…`);

    // Run ONE scraper that pans through all cells internally
    const useVpn = document.getElementById('chk-use-vpn').checked;
    let tilesGot = 0;
    for (let round = 1; round <= 2 && tilesGot === 0; round++) {
      if (round === 2) { appendLog('🔄 Refetching proxy list…'); proxyCache = null; }
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (!useVpn && !proxyCache) {
          appendLog(`🔎 Searching proxy (round ${round}, attempt ${attempt}/3)…`);
          proxyCache = await window.api.findProxy([...usedProxies]);
          if (proxyCache) usedProxies.add(proxyCache);
        }
        const res = await window.api.startScraping(cells[0] ? `https://kadastr.live/#14/${cells[0].lat}/${cells[0].lng}` : '', outputFolder, {
          headless: true,
          boundaryFilter: tempBoundaryPath,
          proxy: useVpn ? '' : (proxyCache || ''),
          gridCells: cells,
        });
        appendLog(`Scraper exited (code ${res.code})`);
        tilesGot = res.tiles || 0;
        if (tilesGot > 0) break;
        if (!useVpn && attempt < 3) { appendLog(`⚠ No tiles — trying next proxy…`); proxyCache = null; }
        if (useVpn) break;
      }
      if (useVpn) break;
    }

    if (tilesGot === 0) {
      appendLog('❌ No parcels found in area.');
      setBusy(false); return;
    }

    const finalOutput = await window.api.resolveOutputPath(outputFolder, sanitizeFilename(territory));
    const scraperOut  = `${outputFolder}/land_plots.kmz`;
    const mergeResult = await window.api.mergeKmz([scraperOut], finalOutput, true);
    if (mergeResult.success) {
      appendLog(`\n✅ Done → ${finalOutput}`);
      window.api.copyIcons(outputFolder);
      window.api.showInFolder(finalOutput);
    } else {
      appendLog(`[ERROR] Rename failed: ${mergeResult.error}`);
    }
    setBusy(false);
    return;
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
    const mergeResult = await window.api.mergeKmz(toMerge, finalOutput, true, undefined, 'Analytics');
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

// ── e.land.gov.ua Lookup ────────────────────────────────────
let preTabOutputFolder = '';
let elandCsvPath = '';
let elandBusy    = false;
let researchBusy   = false;
let offlineDownloadBusy = false;

function checkElandReady() {
  const ready = !!elandCsvPath && !!preTabOutputFolder && !elandBusy;
  document.getElementById('btn-eland-start').disabled = !ready;
}

function checkResearchReady() {
  const oblastVal = document.getElementById('research-oblast').value.trim();
  document.getElementById('btn-research-start').disabled = !oblastVal || !preTabOutputFolder || researchBusy;
}

document.getElementById('btn-pre-tab-folder').addEventListener('click', async () => {
  const result = await window.api.openFolderDialog();
  if (result && !result.canceled && result.filePaths && result.filePaths[0]) {
    preTabOutputFolder = result.filePaths[0];
    document.getElementById('pre-tab-folder-display').textContent = preTabOutputFolder;
    checkResearchReady();
    checkElandReady();
  }
});

document.getElementById('btn-pick-cadnums-csv').addEventListener('click', async () => {
  const result = await window.api.openCsvDialog();
  if (result && !result.canceled && result.filePaths && result.filePaths[0]) {
    elandCsvPath = result.filePaths[0];
    document.getElementById('cadnums-csv-display').textContent = elandCsvPath.split(/[\\/]/).pop();
    checkElandReady();
  }
});

document.getElementById('btn-eland-start').addEventListener('click', async () => {
  if (!elandCsvPath || !preTabOutputFolder || elandBusy) return;
  elandBusy = true;
  checkElandReady();
  document.getElementById('btn-eland-stop').style.display = '';

  const csvName = elandCsvPath.split(/[\\/]/).pop() || 'cadnums.csv';
  const baseName = csvName.replace(/\.csv$/i, '') || 'cadnums';
  const outputXlsx = preTabOutputFolder + (preTabOutputFolder.endsWith('/') || preTabOutputFolder.endsWith('\\') ? '' : '/') + baseName + '_eland.xlsx';
  const result = await window.api.startElandLookup(elandCsvPath, outputXlsx);
  if (result && result.success) window.api.showInFolder(result.outputPath);

  elandBusy = false;
  checkElandReady();
  document.getElementById('btn-eland-stop').style.display = 'none';
});

document.getElementById('btn-eland-stop').addEventListener('click', () => {
  window.api.stopElandLookup();
});

// ── Pre-Research XLSX ───────────────────────────────────────

document.getElementById('research-oblast').addEventListener('input', checkResearchReady);

document.getElementById('btn-research-start').addEventListener('click', async () => {
  const oblastName = document.getElementById('research-oblast').value.trim();
  if (!oblastName || !preTabOutputFolder || researchBusy) return;

  researchBusy = true;
  checkResearchReady();
  document.getElementById('btn-research-stop').style.display = '';

  // Build output path: sanitize oblast name → filename
  const safeName = oblastName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  const outputPath = preTabOutputFolder + (preTabOutputFolder.endsWith('/') || preTabOutputFolder.endsWith('\\') ? '' : '/') + safeName + '_research.xlsx';

  appendLog(`📊 Generating pre-research XLSX for "${oblastName}"…`);
  const result = await window.api.generateResearchXlsx(oblastName, outputPath);

  if (result && result.success) {
    appendLog(`✅ XLSX saved: ${result.outputPath} (${result.count} hromadas)`);
    window.api.showInFolder(result.outputPath);
  } else if (result && result.error) {
    appendLog(`❌ Failed: ${result.error}`);
  }

  researchBusy = false;
  checkResearchReady();
  document.getElementById('btn-research-stop').style.display = 'none';
});

document.getElementById('btn-research-stop').addEventListener('click', () => {
  window.api.stopResearch();
  appendLog('⛔ Stop requested…');
});

document.getElementById('btn-offline-download').addEventListener('click', async () => {
  if (offlineDownloadBusy) return;
  offlineDownloadBusy = true;
  const btn = document.getElementById('btn-offline-download');
  const status = document.getElementById('offline-download-status');
  const progress = document.getElementById('offline-download-progress');
  const geologyUrl = document.getElementById('offline-geology-url').value.trim();
  const forceUpdate = !!document.getElementById('offline-force-update')?.checked;
  btn.disabled = true;
  progress.style.width = '0%';
  status.textContent = 'starting...';
  appendLog('⬇ Starting offline dataset download...');
  const result = await window.api.downloadOfflineData({ worldcoverUrl: '', geologyUrl, forceUpdate });
  if (result && result.success) {
    status.textContent = 'done';
    progress.style.width = '100%';
    appendLog(`✅ Offline datasets downloaded to: ${result.cacheDir}`);
    if (result.skipped && result.skipped.length) {
      appendLog(`ℹ Skipped optional datasets: ${result.skipped.map(s => s.label).join(', ')}`);
    }
    if (result.failed && result.failed.length) {
      appendLog(`⚠ Failed datasets: ${result.failed.map(f => `${f.label} (${f.reason})`).join('; ')}`);
    }
    window.api.showInFolder(result.cacheDir);
  } else {
    status.textContent = 'failed';
    appendLog(`❌ Offline download failed: ${result?.error || 'unknown error'}`);
    if (result?.failed?.length) {
      appendLog(`⚠ Failed datasets: ${result.failed.map(f => `${f.label} (${f.reason})`).join('; ')}`);
    }
  }
  btn.disabled = false;
  offlineDownloadBusy = false;
});
