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
let userStopped       = false;

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
      boundaryUrl = `https://kadastr.live/#${bbox.zoom}/${bbox.centerLat.toFixed(5)}/${bbox.centerLng.toFixed(5)}`;
      appendLog(`📍 URL from boundary: zoom=${bbox.zoom}, center=${bbox.centerLat.toFixed(4)},${bbox.centerLng.toFixed(4)}`);
    } else {
      boundaryUrl = '';
      if (bbox && bbox.error) appendLog(`⚠ Could not read boundary bbox: ${bbox.error}`);
    }
  }
});

document.getElementById('btn-clear-boundary').addEventListener('click', () => {
  boundaryFilterPath = '';
  boundaryUrl = '';
  document.getElementById('boundary-display').textContent = 'not selected';
  document.getElementById('btn-clear-boundary').style.display = 'none';
});

// ── Output folder picker ───────────────────────────────────
document.getElementById('btn-pick-folder').addEventListener('click', async () => {
  const result = await window.api.openFolderDialog();
  if (!result.canceled && result.filePaths.length) {
    outputFolder = result.filePaths[0];
    document.getElementById('output-folder-display').textContent = outputFolder;
  }
});

// ── Layer checkboxes ───────────────────────────────────────
document.getElementById('btn-select-all').addEventListener('click', () => {
  document.querySelectorAll('input[name="layer"]').forEach(cb => cb.checked = true);
  document.getElementById('wind-settings').style.display = 'block';
});

document.getElementById('btn-clear-all').addEventListener('click', () => {
  document.querySelectorAll('input[name="layer"]').forEach(cb => cb.checked = false);
  document.getElementById('wind-settings').style.display = 'none';
});

document.getElementById('layer-wind').addEventListener('change', (e) => {
  document.getElementById('wind-settings').style.display = e.target.checked ? 'block' : 'none';
});

// ── Start / Stop ───────────────────────────────────────────
function setBusy(busy) {
  document.getElementById('btn-start').disabled = busy;
  document.getElementById('btn-stop').disabled  = !busy;
}

document.getElementById('btn-stop').addEventListener('click', () => {
  userStopped = true;
  window.api.stopScraping();
  appendLog('Stop signal sent…');
  document.getElementById('btn-stop').disabled = true;
});

document.getElementById('btn-start').addEventListener('click', async () => {
  // ── Validate ──
  if (!boundaryFilterPath) {
    appendLog('⚠ Please attach a KMZ/KML boundary file.'); return;
  }
  if (!boundaryUrl) {
    appendLog('⚠ Boundary file could not be parsed — please re-attach a valid KMZ/KML.'); return;
  }
  if (!outputFolder) {
    appendLog('⚠ Please select an output folder.'); return;
  }

  const territory = document.getElementById('area-name').value.trim();
  const layers    = [...document.querySelectorAll('input[name="layer"]:checked')].map(cb => cb.value);

  if (layers.length > 0 && !territory) {
    appendLog('⚠ Please enter an area name to fetch OSM layers (used for Overpass query).'); return;
  }

  const windOptions = layers.includes('wind') ? {
    apiKey:    document.getElementById('wind-api-key').value.trim(),
    hubHeight: document.getElementById('wind-hub-height').value,
    year:      document.getElementById('wind-year').value,
  } : null;

  if (windOptions && !windOptions.apiKey) {
    appendLog('⚠ Please enter your NREL API key to fetch Wind Speed data.'); return;
  }

  // ── Setup ──
  document.getElementById('main-log').textContent = '';
  setBusy(true);
  userStopped = false;

  const safeFilename  = sanitizeFilename(territory);
  const kadastrTemp   = outputFolder + '/land_plots.kmz';
  const osmTemp       = outputFolder + '/_osm_temp.kmz';
  const finalOutput   = outputFolder + '/' + safeFilename + '.kmz';

  // ── Phase 1: Kadastr scraper ──
  appendLog('━━━ Phase 1/2: Kadastr parcels ━━━');
  const scrapeResult = await window.api.startScraping(
    boundaryUrl, outputFolder,
    { headless: true, boundaryFilter: boundaryFilterPath }
  );
  appendLog(`Scraper exited (code ${scrapeResult.code})`);

  if (userStopped) {
    appendLog('ℹ Stopped — output saved as land_plots.kmz in the output folder.');
    setBusy(false);
    return;
  }

  // ── Phase 2: OSM layers (optional) ──
  if (layers.length > 0) {
    appendLog(`\n━━━ Phase 2/2: OSM layers [${layers.join(', ')}] ━━━`);
    const osmResult = await window.api.fetchOSM({
      territory,
      layers,
      outputPath: osmTemp,
      format: 'kmz',
      windOptions,
    });

    if (!osmResult.success) {
      appendLog(`[ERROR] OSM fetch failed: ${osmResult.error}`);
      appendLog(`ℹ Kadastr data saved as land_plots.kmz`);
      setBusy(false);
      return;
    }

    // ── Phase 3: Merge ──
    appendLog('\n📦 Merging KMZ files…');
    const mergeResult = await window.api.mergeKmz(
      [kadastrTemp, osmTemp],
      finalOutput,
      true   // cleanup temp files
    );

    if (mergeResult.success) {
      appendLog(`\n✅ Done → ${finalOutput}`);
    } else {
      appendLog(`[ERROR] Merge failed: ${mergeResult.error}`);
    }
  } else {
    // No OSM layers — rename kadastr output to final name
    const fs = null; // can't use fs in renderer; call a rename via main if needed
    // Emit log, output is already at kadastrTemp
    appendLog(`\n✅ Done → ${kadastrTemp}`);
    appendLog(`ℹ (No OSM layers selected — output is land_plots.kmz)`);
  }

  setBusy(false);
});
