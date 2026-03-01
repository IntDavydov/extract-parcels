'use strict';

// ── Tab switching ──────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ── Helpers ────────────────────────────────────────────────
function appendLog(elId, msg) {
  const el = document.getElementById(elId);
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  el.textContent += msg + '\n';
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// ── Register IPC listeners once ────────────────────────────
window.api.onLog((msg) => {
  // Route to whichever log is active
  const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  if (activeTab === 'osm') appendLog('osm-log', msg);
  else appendLog('scraping-log', msg);
});

window.api.onScrapingDone(() => {
  document.getElementById('btn-start-scraping').disabled = false;
  document.getElementById('btn-stop-scraping').disabled  = true;
  appendLog('scraping-log', '--- Done ---');
});

window.api.onOsmDone((data) => {
  document.getElementById('btn-fetch-osm').disabled = false;
  appendLog('osm-log', `--- Done: ${data.path} ---`);
});

// ── Tab 1: Kadastr Scraper ─────────────────────────────────
let outputFolder = '';
let boundaryFilterPath = '';
let boundaryUrl = '';

document.getElementById('btn-pick-folder').addEventListener('click', async () => {
  const result = await window.api.openFolderDialog();
  if (!result.canceled && result.filePaths.length) {
    outputFolder = result.filePaths[0];
    document.getElementById('output-folder-display').textContent = outputFolder;
  }
});

document.getElementById('btn-pick-boundary').addEventListener('click', async () => {
  const result = await window.api.openKmlDialog();
  if (!result.canceled && result.filePaths.length) {
    boundaryFilterPath = result.filePaths[0];
    const name = boundaryFilterPath.split(/[\\/]/).pop();
    document.getElementById('boundary-display').textContent = name;
    document.getElementById('btn-clear-boundary').style.display = '';

    // Compute kadastr URL from boundary bbox
    const bbox = await window.api.readKmlBbox(boundaryFilterPath);
    if (bbox && !bbox.error) {
      boundaryUrl = `https://kadastr.live/#${bbox.zoom}/${bbox.centerLat.toFixed(5)}/${bbox.centerLng.toFixed(5)}`;
      appendLog('scraping-log', `📍 URL from boundary: zoom=${bbox.zoom}, center=${bbox.centerLat.toFixed(4)},${bbox.centerLng.toFixed(4)}`);
    } else if (bbox && bbox.error) {
      boundaryUrl = '';
      appendLog('scraping-log', `⚠ Could not read boundary bbox: ${bbox.error}`);
    }
  }
});

document.getElementById('btn-clear-boundary').addEventListener('click', () => {
  boundaryFilterPath = '';
  boundaryUrl = '';
  document.getElementById('boundary-display').textContent = 'not selected';
  document.getElementById('btn-clear-boundary').style.display = 'none';
});

document.getElementById('btn-start-scraping').addEventListener('click', () => {
  if (!boundaryFilterPath) {
    appendLog('scraping-log', '⚠ Please attach a KMZ/KML boundary file.');
    return;
  }
  if (!boundaryUrl) {
    appendLog('scraping-log', '⚠ Boundary file could not be parsed — please re-attach a valid KMZ/KML.');
    return;
  }
  if (!outputFolder) {
    appendLog('scraping-log', '⚠ Please select an output folder.');
    return;
  }
  const headless = true; // always headless

  document.getElementById('scraping-log').textContent = '';
  document.getElementById('btn-start-scraping').disabled = true;
  document.getElementById('btn-stop-scraping').disabled  = false;
  appendLog('scraping-log', `🗂 Boundary filter: ${boundaryFilterPath.split(/[\\/]/).pop()}`);
  appendLog('scraping-log', `Starting scraper (headless)…`);
  window.api.startScraping(boundaryUrl, outputFolder, { headless, boundaryFilter: boundaryFilterPath });
});

document.getElementById('btn-stop-scraping').addEventListener('click', () => {
  window.api.stopScraping();
  document.getElementById('btn-stop-scraping').disabled = true;
  appendLog('scraping-log', 'Stop signal sent…');
});

// ── Tab 2: OSM Data ────────────────────────────────────────
let osmOutputPath = '';

document.getElementById('btn-pick-osm-output').addEventListener('click', async () => {
  const result = await window.api.saveDialog({
    title: 'Save OSM data as…',
    filters: [{ name: 'KMZ', extensions: ['kmz'] }],
  });
  if (!result.canceled && result.filePath) {
    osmOutputPath = result.filePath;
    document.getElementById('osm-output-display').textContent = osmOutputPath;
  }
});

document.getElementById('btn-select-all').addEventListener('click', () => {
  document.querySelectorAll('input[name="layer"]').forEach(cb => cb.checked = true);
  document.getElementById('wind-settings').style.display = 'block';
});

document.getElementById('btn-clear-all').addEventListener('click', () => {
  document.querySelectorAll('input[name="layer"]').forEach(cb => cb.checked = false);
  document.getElementById('wind-settings').style.display = 'none';
});

// Show/hide wind settings when wind checkbox toggled
document.getElementById('layer-wind').addEventListener('change', (e) => {
  document.getElementById('wind-settings').style.display = e.target.checked ? 'block' : 'none';
});

document.getElementById('btn-fetch-osm').addEventListener('click', async () => {
  const territory = document.getElementById('osm-territory').value.trim();
  if (!territory) {
    appendLog('osm-log', '⚠ Please enter a territory name.');
    return;
  }
  const layers = [...document.querySelectorAll('input[name="layer"]:checked')].map(cb => cb.value);
  if (!layers.length) {
    appendLog('osm-log', '⚠ Please select at least one layer.');
    return;
  }
  if (!osmOutputPath) {
    appendLog('osm-log', '⚠ Please select an output file path.');
    return;
  }
  const format = 'kmz';

  const windOptions = layers.includes('wind') ? {
    apiKey:    document.getElementById('wind-api-key').value.trim(),
    hubHeight: document.getElementById('wind-hub-height').value,
    year:      document.getElementById('wind-year').value,
  } : null;

  if (windOptions && !windOptions.apiKey) {
    appendLog('osm-log', '⚠ Please enter your NREL API key to fetch Wind Speed data.');
    return;
  }

  document.getElementById('osm-log').textContent = '';
  document.getElementById('btn-fetch-osm').disabled = true;
  appendLog('osm-log', `Fetching OSM data for "${territory}"…`);
  appendLog('osm-log', `Layers: ${layers.join(', ')}`);

  const result = await window.api.fetchOSM({ territory, layers, outputPath: osmOutputPath, format, windOptions });
  if (!result.success) {
    document.getElementById('btn-fetch-osm').disabled = false;
    appendLog('osm-log', `[ERROR] ${result.error}`);
  }
});
