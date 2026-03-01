'use strict';

// ── Helpers ────────────────────────────────────────────────
function appendLog(msg) {
  const el = document.getElementById('main-log');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  el.textContent += msg + '\n';
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
let outputFolder      = '';
let boundaryFilterPath = '';
let boundaryUrl       = '';
let boundaryBbox      = null; // {west,south,east,north} from KMZ, used as Nominatim fallback
let userStopped = false;
let proxyCache     = null;  // currently active proxy
let usedProxies    = new Set(); // proxies tried this session

// ── Boundary picker ────────────────────────────────────────
document.getElementById('btn-pick-boundary').addEventListener('click', async () => {
  const result = await window.api.openKmlDialog();
  if (!result.canceled && result.filePaths.length) {
    boundaryFilterPath = result.filePaths[0];
    document.getElementById('boundary-display').textContent =
      boundaryFilterPath.split(/[\\/]/).pop();
    document.getElementById('btn-clear-boundary').style.display = '';

    const bbox = await window.api.readKmlBbox(boundaryFilterPath);
    if (bbox && !bbox.error) {
      boundaryUrl  = `https://kadastr.live/#${bbox.zoom}/${bbox.centerLat.toFixed(5)}/${bbox.centerLng.toFixed(5)}`;
      boundaryBbox = { west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north };
      appendLog(`📍 URL from boundary: zoom=${bbox.zoom}, center=${bbox.centerLat.toFixed(4)},${bbox.centerLng.toFixed(4)}`);
    } else {
      boundaryUrl  = '';
      boundaryBbox = null;
      if (bbox && bbox.error) appendLog(`⚠ Could not read boundary bbox: ${bbox.error}`);
    }
    checkStartReady();
  }
});

document.getElementById('btn-clear-boundary').addEventListener('click', () => {
  boundaryFilterPath = '';
  boundaryUrl = '';
  boundaryBbox = null;
  document.getElementById('boundary-display').textContent = 'not selected';
  document.getElementById('btn-clear-boundary').style.display = 'none';
  checkStartReady();
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

document.getElementById('area-name').addEventListener('input', checkStartReady);

// Track every individual checkbox change
document.querySelectorAll('input[name="layer"]').forEach(cb => {
  cb.addEventListener('change', checkStartReady);
});

// ── Start / Stop ───────────────────────────────────────────
function hasAnything() {
  const hasBoundary = !!boundaryFilterPath;
  const hasLayers   = document.querySelectorAll('input[name="layer"]:checked').length > 0;
  return hasBoundary || hasLayers;
}

function checkStartReady() {
  const territory = document.getElementById('area-name').value.trim();
  const ready = !!outputFolder && !!territory && hasAnything();
  document.getElementById('btn-start').disabled = !ready;
}

function setBusy(busy) {
  document.getElementById('btn-start').disabled = busy;
}


document.getElementById('btn-start').addEventListener('click', async () => {
  // ── Validate ──
  if (!outputFolder) {
    appendLog('⚠ Please select an output folder.'); return;
  }

  const territory = document.getElementById('area-name').value.trim();
  const layers    = [...document.querySelectorAll('input[name="layer"]:checked')].map(cb => cb.value);

  // Without boundary: OSM-only mode — need area name + at least one layer
  if (!boundaryFilterPath) {
    if (!territory) {
      appendLog('⚠ Please enter an area name (required when no boundary is attached).'); return;
    }
    if (!layers.length) {
      appendLog('⚠ Please select at least one layer (no boundary means Kadastr scraping is skipped).'); return;
    }
  }

  // With boundary but with OSM layers: need area name for Overpass
  if (boundaryFilterPath && !boundaryUrl) {
    appendLog('⚠ Boundary file could not be parsed — please re-attach a valid KMZ/KML.'); return;
  }
  if (boundaryFilterPath && layers.length > 0 && !territory) {
    appendLog('⚠ Please enter an area name to fetch OSM layers (used for Overpass query).'); return;
  }

  const windOptions = layers.includes('wind') ? {
    apiKey:    'hWrMKuAzGg0OCHhfidHrcuygKydLiRhyWuhXEUeZ',
    hubHeight: document.getElementById('wind-hub-height').value,
    year:      '2019',
  } : null;

  if (windOptions && !windOptions.apiKey) {
    appendLog('⚠ Please enter your NREL API key to fetch Wind Speed data.'); return;
  }

  // ── Setup ──
  document.getElementById('main-log').textContent = '';
  setBusy(true);
  userStopped = false;

  const safeFilename = sanitizeFilename(territory || 'land_plots');
  const kadastrTemp  = outputFolder + '/land_plots.kmz';
  const osmTemp      = outputFolder + '/_osm_temp.kmz';
  const finalOutput  = outputFolder + '/' + safeFilename + '.kmz';

  let hasKadastr = false;

  // ── Phase 1: Kadastr scraper (only when boundary provided) ──
  if (boundaryFilterPath) {
    appendLog(`━━━ Phase 1: Kadastr parcels ━━━`);

    let tilesGot = 0;

    // Two rounds: first 3 attempts with current proxy pool, then 3 more with fresh refetch
    for (let round = 1; round <= 2 && tilesGot === 0; round++) {
      if (round === 2) {
        appendLog('🔄 Refetching proxy list from external sources…');
        // Clear cache but keep usedProxies so we don't reuse the same ones
        proxyCache = null;
      }

      for (let attempt = 1; attempt <= 3; attempt++) {
        if (!proxyCache) {
          appendLog(`🔎 Searching for a working proxy (round ${round}, attempt ${attempt}/3)…`);
          proxyCache = await window.api.findProxy([...usedProxies]);
          if (proxyCache) usedProxies.add(proxyCache);
        }

        const scrapeResult = await window.api.startScraping(
          boundaryUrl, outputFolder,
          { headless: true, boundaryFilter: boundaryFilterPath, proxy: proxyCache || '' }
        );
        appendLog(`Scraper exited (code ${scrapeResult.code})`);
        tilesGot = scrapeResult.tiles || 0;

        if (tilesGot > 0) break;

        if (attempt < 3) {
          appendLog(`⚠ No tiles — trying next proxy (round ${round}, attempt ${attempt + 1}/3)…`);
          proxyCache = null;
        }
      }
    }

    if (tilesGot === 0) {
      appendLog('❌ No tiles captured after 6 proxy attempts — kadastr.live may be unreachable. Stopping.');
      setBusy(false);
      return;
    }

    hasKadastr = true;

    if (userStopped) {
      appendLog('ℹ Stopped — Kadastr output saved as land_plots.kmz');
      setBusy(false);
      return;
    }
  }

  // ── Phase 2: OSM layers (when layers are selected) ──
  if (layers.length > 0) {
    appendLog(`\n━━━ Phase 2: OSM layers [${layers.join(', ')}] ━━━`);
    const osmResult = await window.api.fetchOSM({
      territory,
      layers,
      outputPath: osmTemp,
      format: 'kmz',
      windOptions,
      fallbackBbox: boundaryBbox,
    });

    if (!osmResult.success) {
      appendLog(`[ERROR] OSM fetch failed: ${osmResult.error}`);
      if (hasKadastr) appendLog(`ℹ Kadastr data saved as land_plots.kmz`);
      setBusy(false);
      return;
    }

    if (hasKadastr) {
      // ── Phase 3: Merge Kadastr + OSM ──
      appendLog('\n📦 Merging KMZ files…');
      const mergeResult = await window.api.mergeKmz([kadastrTemp, osmTemp], finalOutput, true);
      if (mergeResult.success) {
        appendLog(`\n✅ Done → ${finalOutput}`);
        window.api.showInFolder(finalOutput);
      } else {
        appendLog(`[ERROR] Merge failed: ${mergeResult.error}`);
      }
    } else {
      // OSM only — just rename the temp file
      const renameResult = await window.api.mergeKmz([osmTemp], finalOutput, true);
      if (renameResult.success) {
        appendLog(`\n✅ Done → ${finalOutput}`);
        window.api.showInFolder(finalOutput);
      } else {
        appendLog(`[ERROR] ${renameResult.error}`);
      }
    }
  } else {
    // Kadastr only, no OSM layers
    appendLog(`\n✅ Done → ${kadastrTemp}`);
    window.api.showInFolder(kadastrTemp);
  }

  setBusy(false);
});
