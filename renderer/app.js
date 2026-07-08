'use strict';

// ── Helpers ────────────────────────────────────────────────
const LOG_MAX_LINES = 1500;
const LOG_FLUSH_CHUNK_SIZE = 200;
let logLines = [];
let logFlushScheduled = false;
let logDropNoticeShown = false;

function flushLog() {
  const el = document.getElementById('main-log');
  if (!el) {
    logFlushScheduled = false;
    return;
  }
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  if (logLines.length > LOG_FLUSH_CHUNK_SIZE * 2) {
    // Keep UI responsive under heavy logging load.
    const dropped = logLines.length - LOG_FLUSH_CHUNK_SIZE;
    logLines = logLines.slice(-LOG_FLUSH_CHUNK_SIZE);
    if (!logDropNoticeShown) {
      logLines.unshift(`⚠ Log flood detected, dropped ${dropped} pending lines to keep UI responsive`);
      logDropNoticeShown = true;
    }
  }
  const chunk = logLines.splice(0, LOG_FLUSH_CHUNK_SIZE);
  if (chunk.length) {
    const currentLines = el.textContent ? el.textContent.split('\n') : [];
    currentLines.push(...chunk);
    if (currentLines.length > LOG_MAX_LINES) {
      currentLines.splice(0, currentLines.length - LOG_MAX_LINES);
    }
    el.textContent = currentLines.join('\n');
    if (atBottom) el.scrollTop = el.scrollHeight;
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
  const formatted = String(msg || '').replace(/^\[ERR(?:OR)?\]\s*/i, '❌ ');
  logLines.push(formatted);
  scheduleLogFlush();
}

function sanitizeFilename(name) {
  return (name || 'land_management')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .trim() || 'land_management';
}

const runProgress = {
  total: 0,
  current: 0,
  success: 0,
  failed: 0,
  label: 'Idle',
};

const resultEntries = [];
const MAX_RESULT_ENTRIES = 30;

function renderRunProgress() {
  const labelEl = document.getElementById('run-progress-label');
  const countsEl = document.getElementById('run-progress-counts');
  const barEl = document.getElementById('run-progress-bar');
  if (!labelEl || !countsEl || !barEl) return;
  const pct = runProgress.total > 0 ? Math.max(0, Math.min(100, (runProgress.current / runProgress.total) * 100)) : 0;
  labelEl.textContent = runProgress.label || 'Idle';
  countsEl.textContent = `${runProgress.current}/${runProgress.total} • ✅${runProgress.success} ❌${runProgress.failed}`;
  barEl.style.width = `${pct}%`;
}

function resetRunProgress(label = 'Idle') {
  runProgress.total = 0;
  runProgress.current = 0;
  runProgress.success = 0;
  runProgress.failed = 0;
  runProgress.label = label;
  renderRunProgress();
}

function initRunProgress(total, label) {
  runProgress.total = Math.max(1, Number(total) || 1);
  runProgress.current = 0;
  runProgress.success = 0;
  runProgress.failed = 0;
  runProgress.label = label || 'Running';
  renderRunProgress();
}

function setRunProgressLabel(label) {
  runProgress.label = label || runProgress.label;
  renderRunProgress();
}

function tickRunProgress(success, label) {
  runProgress.current = Math.min(runProgress.total, runProgress.current + 1);
  if (success) runProgress.success++;
  else runProgress.failed++;
  if (label) runProgress.label = label;
  renderRunProgress();
}

function getDirname(filePath) {
  const p = String(filePath || '');
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(0, idx) : p;
}

async function copyTextToClipboard(text) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) {}
  ta.remove();
  return ok;
}

function renderResults() {
  const list = document.getElementById('results-list');
  if (!list) return;
  list.innerHTML = '';
  if (!resultEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'result-path';
    empty.textContent = 'No generated files yet.';
    list.appendChild(empty);
    return;
  }
  for (const entry of resultEntries) {
    const item = document.createElement('div');
    item.className = 'result-item';

    const pathLine = document.createElement('div');
    pathLine.className = 'result-path';
    pathLine.textContent = `${entry.label}: ${entry.path}`;
    item.appendChild(pathLine);

    const actions = document.createElement('div');
    actions.className = 'result-actions';

    const openFileBtn = document.createElement('button');
    openFileBtn.className = 'btn btn-secondary btn-sm';
    openFileBtn.type = 'button';
    openFileBtn.textContent = 'Open file';
    openFileBtn.addEventListener('click', () => window.api.openPath(entry.path));

    const openFolderBtn = document.createElement('button');
    openFolderBtn.className = 'btn btn-secondary btn-sm';
    openFolderBtn.type = 'button';
    openFolderBtn.textContent = 'Open folder';
    openFolderBtn.addEventListener('click', () => window.api.openPath(getDirname(entry.path)));

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-secondary btn-sm';
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy path';
    copyBtn.addEventListener('click', async () => {
      const ok = await copyTextToClipboard(entry.path);
      appendLog(ok ? `📋 Copied path: ${entry.path}` : '⚠ Could not copy path');
    });

    actions.appendChild(openFileBtn);
    actions.appendChild(openFolderBtn);
    actions.appendChild(copyBtn);
    item.appendChild(actions);
    list.appendChild(item);
  }
}

function addResultEntry(path, label = 'Output') {
  const p = String(path || '').trim();
  if (!p) return;
  const existingIdx = resultEntries.findIndex((x) => x.path === p);
  if (existingIdx >= 0) resultEntries.splice(existingIdx, 1);
  resultEntries.unshift({ path: p, label });
  if (resultEntries.length > MAX_RESULT_ENTRIES) resultEntries.length = MAX_RESULT_ENTRIES;
  renderResults();
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
  const fetchModeField = document.querySelector('.global-fetch-mode');
  function syncFetchModeVisibility(activePanelId) {
    if (!fetchModeField) return;
    fetchModeField.style.display = activePanelId === 'tab-panel-parcels' ? 'block' : 'none';
  }
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.tabTarget;
      tabButtons.forEach((b) => {
        const isActive = b === btn;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      tabPanels.forEach((panel) => panel.classList.toggle('active', panel.id === targetId));
      syncFetchModeVisibility(targetId);
    });
  });
  const initiallyActive = tabPanels.find((p) => p.classList.contains('active'));
  syncFetchModeVisibility(initiallyActive ? initiallyActive.id : 'tab-panel-parcels');
}

initLeftTabs();
resetRunProgress();
renderResults();
document.getElementById('btn-results-clear')?.addEventListener('click', () => {
  resultEntries.length = 0;
  renderResults();
});

// ── State ──────────────────────────────────────────────────
let outputFolder   = '';
let boundaryFiles  = []; // [{path, url, bbox, name}]
let userStopped    = false;
let areaNames      = [];
let preTabOutputFolder = '';
let elandCsvPath = '';
let elandBusy    = false;
let elandOutputFormat = 'xlsx_partial';
let researchBusy   = false;
let offlineDownloadBusy = false;
let parcelSource = 'kadastrova_karta';
const appRole = String(window.api.getAppRole?.() || 'user');
const isAdminRole = appRole === 'admin';
const USER_VISIBLE_MODES = new Set(['kadastr', 'eland']);
const PARCEL_SOURCE_CONFIG = {
  kadastrova_karta: {
    baseUrl: 'https://kadastrova-karta.com',
    label: 'kadastrova-karta.com',
  },
  kadastrova_karta_ua: {
    baseUrl: 'https://kadastrova-karta.com.ua/kadastr2026',
    label: 'kadastrova-karta.com.ua',
  },
};
const MODE_BUTTON_LABELS = {
  boundary: '▶ Start boundary + OSM',
  custom: '▶ Start custom settlement fetch',
  kadastr: '▶ Start Parcels by KMZ/KML',
  cadnum: '▶ Start Parcels by cadastral numbers',
  coords: '▶ Extract polygon coordinates',
  eland: '🔍 Lookup on e.land',
};

function setFieldError(id, message) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message || '';
}

function setStepStatus(id, done) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = done ? '✓' : '○';
  el.classList.toggle('done', !!done);
}

function syncModeCards(mode) {
  document.querySelectorAll('#parcel-mode-cards .mode-card[data-fetch-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.fetchMode === mode);
  });
}

function updateStartButtonLabel(mode) {
  const startBtn = document.getElementById('btn-start');
  if (!startBtn) return;
  startBtn.textContent = MODE_BUTTON_LABELS[mode] || MODE_BUTTON_LABELS.boundary;
}

function setElandFormat(value) {
  const fmt = String(value || 'xlsx_partial');
  elandOutputFormat = fmt;
  const preSel = document.getElementById('eland-output-format');
  const modeSel = document.getElementById('eland-output-format-main');
  if (preSel && preSel.value !== fmt) preSel.value = fmt;
  if (modeSel && modeSel.value !== fmt) modeSel.value = fmt;
}

function syncAreaNamesValue() {
  const areaNameEl = document.getElementById('area-name');
  if (areaNameEl) areaNameEl.value = areaNames.join(' ... ');
}

function renderAreaChips() {
  const wrap = document.getElementById('area-chips');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (let i = 0; i < areaNames.length; i++) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = areaNames[i];
    const removeBtn = document.createElement('button');
    removeBtn.className = 'chip-remove';
    removeBtn.type = 'button';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => {
      areaNames.splice(i, 1);
      syncAreaNamesValue();
      renderAreaChips();
      const isMulti = areaNames.length > 1;
      document.getElementById('drop-zone').style.pointerEvents = isMulti ? 'none' : '';
      document.getElementById('drop-zone').style.opacity = isMulti ? '0.4' : '';
      if (isMulti && boundaryFiles.length) {
        boundaryFiles = [];
        renderBoundaryList();
      }
      checkStartReady();
    });
    chip.appendChild(removeBtn);
    wrap.appendChild(chip);
  }
}

function tryAddAreaChip(rawValue) {
  const values = String(rawValue || '')
    .split(/\.\.\.|[\n\r]+/)
    .map((v) => v.trim())
    .filter(Boolean);
  if (!values.length) return false;
  let added = false;
  for (const value of values) {
    if (areaNames.includes(value)) continue;
    areaNames.push(value);
    added = true;
  }
  if (!added) return false;
  syncAreaNamesValue();
  renderAreaChips();
  const isMulti = areaNames.length > 1;
  document.getElementById('drop-zone').style.pointerEvents = isMulti ? 'none' : '';
  document.getElementById('drop-zone').style.opacity = isMulti ? '0.4' : '';
  if (isMulti && boundaryFiles.length) {
    boundaryFiles = [];
    renderBoundaryList();
  }
  checkStartReady();
  return added;
}

function getParcelSource() {
  return PARCEL_SOURCE_CONFIG[parcelSource] ? parcelSource : 'kadastrova_karta';
}

function getParcelSourceBaseUrl(source) {
  const key = PARCEL_SOURCE_CONFIG[source] ? source : 'kadastrova_karta';
  return PARCEL_SOURCE_CONFIG[key].baseUrl;
}

function getParcelSourceLabel(source) {
  const key = PARCEL_SOURCE_CONFIG[source] ? source : 'kadastrova_karta';
  return PARCEL_SOURCE_CONFIG[key].label;
}

function getFallbackParcelSource(source) {
  return 'kadastrova_karta';
}

function applyRoleVisibility() {
  if (isAdminRole) return;

  const leftTabs = document.querySelector('.left-tabs');
  if (leftTabs) leftTabs.style.display = 'none';

  const preResearchPanel = document.getElementById('tab-panel-pre-research');
  if (preResearchPanel) preResearchPanel.style.display = 'none';

  document.querySelectorAll('#parcel-mode-cards .mode-card[data-fetch-mode]').forEach((btn) => {
    const mode = btn.dataset.fetchMode || '';
    btn.style.display = USER_VISIBLE_MODES.has(mode) ? '' : 'none';
    btn.style.order = mode === 'kadastr' ? '1' : mode === 'eland' ? '2' : '';
    btn.style.gridColumn = mode === 'eland'
      ? '1 / -1'
      : (mode === 'kadastr' ? 'span 3' : '');
  });

  const modeSelect = document.getElementById('parcel-fetch-mode');
  if (modeSelect) {
    [...modeSelect.options].forEach((option) => {
      option.hidden = !USER_VISIBLE_MODES.has(option.value);
    });
  }
  if (modeSelect && !USER_VISIBLE_MODES.has(modeSelect.value)) {
    modeSelect.value = 'kadastr';
  }

  const parcelPanel = document.getElementById('tab-panel-parcels');
  if (parcelPanel) parcelPanel.style.display = 'block';
}

function makeParcelUrlForBbox(bbox, source = getParcelSource()) {
  const base = getParcelSourceBaseUrl(source);
  return `${base}/#${bbox.zoom}/${bbox.centerLat.toFixed(5)}/${bbox.centerLng.toFixed(5)}`;
}

function makeParcelUrlForBoundary(boundaryFile, source = getParcelSource()) {
  const bbox = boundaryFile?.bbox || {};
  const zoomFromUrl = (() => {
    const hash = (boundaryFile?.url || '').split('#')[1] || '';
    const [z] = hash.split('/');
    const n = Number(z);
    return Number.isFinite(n) ? n : null;
  })();
  const zoom = Number.isFinite(Number(bbox.zoom)) ? Number(bbox.zoom) : (zoomFromUrl ?? 14);
  const centerLat = Number.isFinite(Number(bbox.centerLat))
    ? Number(bbox.centerLat)
    : ((Number(bbox.south) + Number(bbox.north)) / 2);
  const centerLng = Number.isFinite(Number(bbox.centerLng))
    ? Number(bbox.centerLng)
    : ((Number(bbox.west) + Number(bbox.east)) / 2);
  if (Number.isFinite(centerLat) && Number.isFinite(centerLng)) {
    return `${getParcelSourceBaseUrl(source)}/#${zoom}/${centerLat.toFixed(5)}/${centerLng.toFixed(5)}`;
  }
  const hash = (boundaryFile?.url || '').split('#')[1];
  return hash ? `${getParcelSourceBaseUrl(source)}/#${hash}` : '';
}

function renderBoundaryList() {
  const list = document.getElementById('boundary-list');
  const btn  = document.getElementById('btn-clear-boundary');
  const hint = document.getElementById('drop-hint');
  if (!boundaryFiles.length) {
    list.textContent = '';
    btn.style.display = 'none';
    hint.style.display = '';
    document.getElementById('area-chip-input').disabled = false;
    document.getElementById('btn-add-area').disabled = false;
  } else {
    list.textContent = boundaryFiles.map((f, i) => `${i + 1}. ${f.name}`).join('\n');
    btn.style.display = '';
    hint.style.display = 'none';
  }
  // When multiple KMZ: disable area name + OSM layers
  // When exactly one KMZ: disable + clear area name (not needed — folder named by coords)
  const isMultiKmz  = boundaryFiles.length > 1;
  const areaInput = document.getElementById('area-chip-input');
  const addAreaBtn = document.getElementById('btn-add-area');
  areaInput.disabled = isMultiKmz;
  addAreaBtn.disabled = isMultiKmz;
  if (isMultiKmz) {
    areaNames = [];
    syncAreaNamesValue();
    renderAreaChips();
  }
  document.querySelectorAll('input[name="layer"]').forEach(cb => { cb.disabled = isMultiKmz; });
  document.getElementById('btn-select-all').disabled = isMultiKmz;
  document.getElementById('btn-clear-all').disabled  = isMultiKmz;
  const isKadastrMode = document.getElementById('parcel-fetch-mode').value === 'kadastr';
  if (isKadastrMode && isMultiKmz) {
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
        const url = makeParcelUrlForBbox(bbox);
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
      const url = makeParcelUrlForBbox(bbox);
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
function updateLayerSettingsVisibility() {
  const windChecked = !!document.getElementById('layer-wind')?.checked;
  const forestsChecked = !!document.getElementById('layer-forests')?.checked;
  const windSettings = document.getElementById('wind-settings');
  const forestSettings = document.getElementById('forest-settings');
  if (windSettings) windSettings.style.display = windChecked ? 'block' : 'none';
  if (forestSettings) forestSettings.style.display = forestsChecked ? 'block' : 'none';
}

document.getElementById('btn-select-all').addEventListener('click', () => {
  document.querySelectorAll('input[name="layer"]').forEach(cb => cb.checked = true);
  updateLayerSettingsVisibility();
  checkStartReady();
});

document.getElementById('btn-clear-all').addEventListener('click', () => {
  document.querySelectorAll('input[name="layer"]').forEach(cb => cb.checked = false);
  updateLayerSettingsVisibility();
  checkStartReady();
});

document.getElementById('layer-wind').addEventListener('change', (e) => {
  updateLayerSettingsVisibility();
});
document.getElementById('layer-forests').addEventListener('change', () => {
  updateLayerSettingsVisibility();
});

function applyFullParcelsMode(enabled) {
  const dropZone   = document.getElementById('drop-zone');
  const areaInput  = document.getElementById('area-chip-input');
  dropZone.style.pointerEvents = enabled ? 'none' : '';
  dropZone.style.opacity       = enabled ? '0.4' : '';
  document.querySelectorAll('input[name="layer"]').forEach(cb => { cb.disabled = enabled; if (enabled) cb.checked = false; });
  document.getElementById('btn-select-all').disabled = enabled;
  document.getElementById('btn-clear-all').disabled  = enabled;
  if (enabled) updateLayerSettingsVisibility();
  if (enabled && boundaryFiles.length) { boundaryFiles = []; renderBoundaryList(); }
  // Keep only first area in full-parcels mode
  if (enabled) {
    if (areaNames.length > 1) areaNames = [areaNames[0]];
    syncAreaNamesValue();
    renderAreaChips();
  }
  areaInput.disabled = enabled;
  document.getElementById('btn-add-area').disabled = enabled;
  updateLayerSettingsVisibility();
  checkStartReady();
}

// ── Parcel fetch mode switching ─────────────────────────────
document.querySelectorAll('#parcel-mode-cards .mode-card').forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.fetchMode || 'boundary';
    const modeSelect = document.getElementById('parcel-fetch-mode');
    modeSelect.value = mode;
    modeSelect.dispatchEvent(new Event('change'));
  });
});

document.getElementById('parcel-fetch-mode').addEventListener('change', (e) => {
  const mode = e.target.value;
  const isCadnum = mode === 'cadnum';
  const isCustom = mode === 'custom';
  const isKadastr = mode === 'kadastr';
  const isCoords = mode === 'coords';
  const isEland = mode === 'eland';
  
  document.getElementById('field-cadnum').style.display = isCadnum ? 'block' : 'none';
  document.getElementById('field-parcel-source').style.display = (isCadnum || isKadastr) ? 'block' : 'none';
  document.getElementById('field-eland-csv').style.display = isEland ? 'block' : 'none';
  document.getElementById('field-eland-format-main').style.display = isEland ? 'block' : 'none';
  document.getElementById('field-boundary').style.display = (isCadnum || isCustom || isKadastr || isCoords || isEland) ? 'none' : 'block';
  document.getElementById('field-area-names').style.display = (isCustom || isCadnum || isKadastr || isCoords || isEland) ? 'none' : 'block';
  document.getElementById('field-osm-layers').style.display = mode === 'boundary' ? 'block' : 'none';
  document.getElementById('step-options-title').style.display = mode === 'boundary' ? 'flex' : 'none';
  
  // Show boundary file picker for custom/kadastr/coords modes
  if (isCustom) {
    const boundaryField = document.getElementById('field-boundary');
    boundaryField.style.display = 'block';
    const label = boundaryField.querySelector('label');
    label.innerHTML = 'Custom settlement boundary KMZ/KML <span style="color:#e05;">*required</span> <span style="color:#888;font-size:11px;">(one or multiple files; polygons/closed paths are supported)</span>';
    document.querySelectorAll('input[name="layer"]').forEach(cb => { cb.checked = false; });
    updateLayerSettingsVisibility();
  } else if (isKadastr) {
    const boundaryField = document.getElementById('field-boundary');
    boundaryField.style.display = 'block';
    const label = boundaryField.querySelector('label');
    label.innerHTML = 'Boundary KMZ/KML <span style="color:#e05;">*required</span> <span style="color:#888;font-size:11px;">(parcel scraping; single or multiple files)</span>';
    document.querySelectorAll('input[name="layer"]').forEach(cb => { cb.checked = false; });
    updateLayerSettingsVisibility();
  } else if (isCoords) {
    const boundaryField = document.getElementById('field-boundary');
    boundaryField.style.display = 'block';
    const label = boundaryField.querySelector('label');
    label.innerHTML = 'Polygon source KML/KMZ <span style="color:#e05;">*required</span> <span style="color:#888;font-size:11px;">(single file; exports latitude,longitude points)</span>';
    document.querySelectorAll('input[name="layer"]').forEach(cb => { cb.checked = false; });
    updateLayerSettingsVisibility();
  } else if (!isCadnum) {
    const boundaryField = document.getElementById('field-boundary');
    const label = boundaryField.querySelector('label');
    label.innerHTML = 'Boundary KMZ/KML <span style="color:#888;font-size:11px;">(optional — helps constrain area lookup)</span>';
  }

  syncModeCards(mode);
  updateStartButtonLabel(mode);
  updateLayerSettingsVisibility();
  checkStartReady();
});

syncModeCards(document.getElementById('parcel-fetch-mode').value);
updateStartButtonLabel(document.getElementById('parcel-fetch-mode').value);
setElandFormat(elandOutputFormat);
syncAreaNamesValue();
renderAreaChips();
applyRoleVisibility();
if (!isAdminRole) {
  const modeSelect = document.getElementById('parcel-fetch-mode');
  modeSelect.value = 'kadastr';
  modeSelect.dispatchEvent(new Event('change'));
}
checkStartReady();

document.getElementById('cadnum-input').addEventListener('input', checkStartReady);
document.getElementById('parcel-source-select').addEventListener('change', (e) => {
  parcelSource = String(e.target.value || 'kadastrova_karta');
  checkStartReady();
});

document.getElementById('btn-pick-eland-csv-mode').addEventListener('click', async () => {
  const result = await window.api.openCsvDialog();
  if (result && !result.canceled && result.filePaths && result.filePaths[0]) {
    elandCsvPath = result.filePaths[0];
    const fileName = elandCsvPath.split(/[\\/]/).pop();
    document.getElementById('eland-csv-display-main').textContent = fileName;
    const preDisplay = document.getElementById('cadnums-csv-display');
    if (preDisplay) preDisplay.textContent = fileName;
    checkElandReady();
    checkStartReady();
  }
});

document.getElementById('eland-output-format-main').addEventListener('change', (e) => {
  setElandFormat(e.target.value);
});

document.getElementById('btn-add-area').addEventListener('click', () => {
  const input = document.getElementById('area-chip-input');
  if (tryAddAreaChip(input.value)) input.value = '';
});

document.getElementById('area-chip-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const input = document.getElementById('area-chip-input');
    if (tryAddAreaChip(input.value)) input.value = '';
  }
});

document.getElementById('area-chip-input').addEventListener('blur', () => {
  const input = document.getElementById('area-chip-input');
  if (tryAddAreaChip(input.value)) input.value = '';
});

document.getElementById('chk-full-parcels').addEventListener('change', (e) => {
  applyFullParcelsMode(e.target.checked);
});

// Track every individual checkbox change
document.querySelectorAll('input[name="layer"]').forEach(cb => {
  cb.addEventListener('change', () => {
    updateLayerSettingsVisibility();
    checkStartReady();
  });
});

// ── Start / Stop ───────────────────────────────────────────
function hasAnything() {
  const hasBoundary = boundaryFiles.length > 0;
  const hasLayers   = document.querySelectorAll('input[name="layer"]:checked').length > 0;
  return hasBoundary || hasLayers;
}

function updateInlineValidation(fetchMode, territory, cadnum, hasOutput, hasBoundary, boundaryCount, hasLayers, isFullParcels) {
  setFieldError('err-area-name', '');
  setFieldError('err-cadnum', '');
  setFieldError('err-eland-csv', '');
  setFieldError('err-boundary', '');
  setFieldError('err-output-folder', hasOutput ? '' : 'Output folder is required.');
  setFieldError('err-layers', '');

  if (fetchMode === 'eland') {
    if (!elandCsvPath) setFieldError('err-eland-csv', 'Select cadnums CSV.');
  } else if (fetchMode === 'cadnum') {
    if (!cadnum) setFieldError('err-cadnum', 'Enter at least one cadastral number.');
  } else if (fetchMode === 'coords') {
    if (!hasBoundary) setFieldError('err-boundary', 'Attach one KML/KMZ polygon file.');
    else if (boundaryCount > 1) setFieldError('err-boundary', 'Attach only one file for coordinate extraction.');
  } else if (fetchMode === 'kadastr' || fetchMode === 'custom') {
    if (!hasBoundary) setFieldError('err-boundary', 'Attach at least one KMZ/KML boundary file.');
  } else {
    if (!territory && !hasBoundary && !isFullParcels) {
      setFieldError('err-area-name', 'Add at least one area name or attach a boundary file.');
    }
    if (isFullParcels && !territory) {
      setFieldError('err-area-name', 'Area name is required in full-area mode.');
    }
    if (!hasLayers && !hasBoundary && !isFullParcels && territory) {
      setFieldError('err-layers', 'Select at least one OSM layer.');
    }
  }

  const sourceDone = fetchMode === 'eland'
    ? !!elandCsvPath
    : (fetchMode === 'cadnum'
      ? !!cadnum
      : ((fetchMode === 'coords') ? boundaryCount === 1 : ((fetchMode === 'kadastr' || fetchMode === 'custom') ? hasBoundary : (!!territory || hasBoundary))));
  const outputDone = hasOutput;
  const optionsDone = fetchMode === 'boundary' ? hasLayers || hasBoundary : true;
  setStepStatus('step-input-status', sourceDone);
  setStepStatus('step-output-status', outputDone);
  setStepStatus('step-options-status', optionsDone);
  return sourceDone && outputDone && optionsDone;
}

function checkStartReady() {
  const fetchMode     = document.getElementById('parcel-fetch-mode').value;
  const territory     = document.getElementById('area-name').value.trim();
  const cadnum        = document.getElementById('cadnum-input').value.trim();
  const isMultiKmz    = boundaryFiles.length > 1;
  const isSingleKmz   = boundaryFiles.length === 1;
  const isFullParcels = document.getElementById('chk-full-parcels').checked;
  const hasOutput     = !!outputFolder;
  const hasBoundary   = isSingleKmz || isMultiKmz;
  const hasLayersChecked = document.querySelectorAll('input[name="layer"]:checked').length > 0;
  
  let ready = false;
  if (fetchMode === 'eland') {
    ready = hasOutput && !!elandCsvPath && !elandBusy;
  } else if (fetchMode === 'cadnum') {
    ready = hasOutput && !!cadnum;
  } else if (fetchMode === 'coords') {
    ready = hasOutput && boundaryFiles.length === 1;
  } else if (fetchMode === 'kadastr') {
    ready = hasOutput && hasBoundary;
  } else if (fetchMode === 'custom') {
    ready = hasOutput && hasBoundary;
  } else {
    ready = hasOutput && (
      isMultiKmz  ? true :
      isSingleKmz ? true :
      isFullParcels ? !!territory :
      (!!territory && hasAnything())
    );
  }
  const stepperReady = updateInlineValidation(fetchMode, territory, cadnum, hasOutput, hasBoundary, boundaryFiles.length, hasLayersChecked, isFullParcels);
  setStepStatus('step-run-status', !!stepperReady && ready);
  document.getElementById('btn-start').disabled = !ready;
}

function setBusy(busy) {
  if (busy) {
    document.getElementById('btn-start').disabled = true;
    return;
  }
  checkStartReady();
}


document.getElementById('btn-start').addEventListener('click', async () => {
  if (!outputFolder) { appendLog('⚠ Please select an output folder.'); return; }

  const fetchMode     = document.getElementById('parcel-fetch-mode').value;
  resetRunProgress('Idle');
  if (fetchMode === 'eland') {
    if (!elandCsvPath) { appendLog('⚠ Please select cadnums CSV.'); return; }
    if (elandBusy) { appendLog('⚠ e.land lookup is already running.'); return; }

    document.getElementById('main-log').textContent = '';
    setBusy(true);
    elandBusy = true;
    initRunProgress(1, 'e.land lookup');

    const csvName = elandCsvPath.split(/[\\/]/).pop() || 'cadnums.csv';
    const baseName = csvName.replace(/\.csv$/i, '') || 'cadnums';
    const sep = outputFolder.endsWith('/') || outputFolder.endsWith('\\') ? '' : '/';
    const outputPath = `${outputFolder}${sep}${baseName}_eland.xlsx`;
    const result = await window.api.startElandLookup(elandCsvPath, outputPath, { format: elandOutputFormat });
    if (result && result.success) {
      appendLog(`✅ Done → ${result.outputPath}`);
      addResultEntry(result.outputPath, 'e.land XLSX');
      if (result.docxOutputPath) addResultEntry(result.docxOutputPath, 'e.land DOCX');
      window.api.showInFolder(result.outputPath);
      tickRunProgress(true, 'e.land lookup done');
    } else {
      appendLog(`❌ Failed: ${result?.error || 'unknown error'}`);
      tickRunProgress(false, 'e.land lookup failed');
    }
    elandBusy = false;
    checkElandReady();
    setBusy(false);
    return;
  }

  // ── Polygon coordinates mode ──
  if (fetchMode === 'coords') {
    if (boundaryFiles.length !== 1) {
      appendLog('⚠ Please attach exactly one KML/KMZ file.');
      return;
    }
    const sourceFile = boundaryFiles[0];
    document.getElementById('main-log').textContent = '';
    setBusy(true);
    initRunProgress(1, 'Extract polygon coordinates');
    appendLog(`📍 Extracting polygon coordinates from: ${sourceFile.name}`);
    const result = await window.api.extractKmlCoordinates(sourceFile.path, outputFolder);
    if (result && result.success) {
      appendLog(`✅ Done → ${result.outputPath}`);
      appendLog(`   Polygons: ${result.polygonCount}, points: ${result.pointCount}`);
      addResultEntry(result.outputPath, 'Polygon coordinates CSV');
      window.api.showInFolder(result.outputPath);
      tickRunProgress(true, 'Coordinate extraction done');
    } else {
      appendLog(`❌ Failed: ${result?.error || 'unknown error'}`);
      tickRunProgress(false, 'Coordinate extraction failed');
    }
    setBusy(false);
    return;
  }
  
  // ── Cadastral number mode ──
  if (fetchMode === 'cadnum') {
    const cadnumInput = document.getElementById('cadnum-input').value.trim();
    if (!cadnumInput) { appendLog('⚠ Please enter at least one cadastral number.'); return; }
    
    // Parse multiple cadastral numbers (space, newline, or comma-separated)
    const cadnums = cadnumInput
      .split(/[\s,]+/)
      .map(s => s.trim())
      .filter(Boolean);
    
    if (cadnums.length === 0) { appendLog('⚠ Please enter at least one cadastral number.'); return; }
    
    document.getElementById('main-log').textContent = '';
    setBusy(true);
    userStopped = false;
    initRunProgress(cadnums.length, 'Cadnum lookup');
    
    appendLog(`🔍 Looking up ${cadnums.length} cadastral number(s)...`);
    appendLog(`   (Testing network connection to ${getParcelSourceLabel(parcelSource)}...)\n`);
    
    const allResults = [];
    let tempDir = null;
    let keepTempDir = false;
    try {
      // Create temp directory for individual parcel files (main process)
      tempDir = await window.api.cadnumBatchInit(outputFolder);

      for (let i = 0; i < cadnums.length; i++) {
        const cadnum = cadnums[i];
        setRunProgressLabel(`Cadnum ${i + 1}/${cadnums.length}: ${cadnum}`);
        appendLog(`\n[${i + 1}/${cadnums.length}] Processing: ${cadnum}`);
        appendLog(`  🌐 Searching...`);

        let lat, lng;
        try {
          // Search from main process (avoids renderer fetch hang)
          const result = await window.api.searchCadastralNumber(cadnum, parcelSource);
          lat = result.lat;
          lng = result.lng;
          appendLog(`  ✓ Response: ${result.responseSize} bytes`);
          appendLog(`  ✅ Location: ${lat.toFixed(6)}, ${lng.toFixed(6)}`);

          const startUrl = `https://kadastrova-karta.com/#15/${lat}/${lng}`;
          const parcelSource = getParcelSource();
          const res = await window.api.startScraping(startUrl, tempDir, {
            headless: true,
            boundaryFilter: null,
            parcelSource,
            cadnumFilter: cadnum
          });

          if (res.parcels > 0) {
            appendLog(`  ✅ Found ${res.parcels} parcel(s)`);
            allResults.push({ cadnum, parcels: res.parcels, success: true });
            await window.api.cadnumBatchFinalizeItem(tempDir, cadnum);
            tickRunProgress(true, `Processed ${i + 1}/${cadnums.length}`);
          } else {
            appendLog(`  ⚠ No parcel data found`);
            allResults.push({ cadnum, parcels: 0, success: false });
            tickRunProgress(false, `Processed ${i + 1}/${cadnums.length}`);
          }
        } catch (err) {
          appendLog(`  ❌ Error: ${err.message}`);
          allResults.push({ cadnum, parcels: 0, success: false, error: err.message });
          tickRunProgress(false, `Processed ${i + 1}/${cadnums.length}`);
        }

        if (i < cadnums.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      const successful = allResults.filter(r => r.success).length;
      const totalParcels = allResults.reduce((sum, r) => sum + r.parcels, 0);

      appendLog(`\n━━━ Summary ━━━`);
      appendLog(`  Processed: ${cadnums.length} cadastral number(s)`);
      appendLog(`  Successful: ${successful}`);
      appendLog(`  Total parcels: ${totalParcels}`);

      if (successful > 0) {
        appendLog(`\n📦 Merging ${successful} KMZ file(s)...`);
        try {
          const finalKmz = `${outputFolder.replace(/[\\\/]+$/, '')}/land_plots.kmz`;
          await window.api.mergeKmzFiles(tempDir, finalKmz);
          appendLog(`✅ Results saved to: ${finalKmz}`);
          addResultEntry(finalKmz, 'KMZ');
        } catch (err) {
          appendLog(`⚠ Merge error: ${err.message}`);
          appendLog(`  Individual files available in: ${tempDir}`);
          keepTempDir = true;
        }
      }
    } finally {
      if (tempDir && !keepTempDir) await window.api.cadnumBatchCleanup(tempDir);
      setBusy(false);
    }
    return;
  }

  // ── Custom settlement boundary mode (KMZ/KML) ──
  if (fetchMode === 'custom') {
    if (!boundaryFiles.length) { appendLog('⚠ Please attach at least one KMZ/KML boundary file.'); return; }

    const layerSet = ['settlements'];
    const customName = boundaryFiles.length === 1
      ? sanitizeFilename((boundaryFiles[0].name || 'custom_settlement').replace(/\.(kmz|kml)$/i, ''))
      : 'custom_settlements';
    const finalOutput = await window.api.resolveOutputPath(outputFolder, `${customName}_settlements`);

    document.getElementById('main-log').textContent = '';
    setBusy(true);
    userStopped = false;
    initRunProgress(1, 'Custom settlement fetch');
    appendLog('🧭 Custom settlement boundary mode');
    appendLog(`📎 Boundaries: ${boundaryFiles.length}`);
    boundaryFiles.forEach((f, idx) => appendLog(`   ${idx + 1}. ${f.name}`));
    appendLog('🏘 Fetching settlement areas + 700m buffers from your custom KMZ/KML boundaries…');

    try {
      const osmResult = await window.api.fetchOSM({
        territory: customName || 'Custom boundary',
        layers: layerSet,
        outputPath: finalOutput,
        format: 'kmz',
        windOptions: null,
        fallbackBbox: boundaryFiles[0]?.bbox || null,
        customBoundaryPaths: boundaryFiles.map((f) => f.path),
      });
      if (!osmResult.success) {
        appendLog(`[ERROR] Custom boundary fetch failed: ${osmResult.error}`);
        tickRunProgress(false, 'Custom settlement fetch failed');
      } else {
        appendLog(`\n✅ Done → ${finalOutput}`);
        window.api.copyIcons(outputFolder);
        addResultEntry(finalOutput, 'KMZ');
        window.api.showInFolder(finalOutput);
        tickRunProgress(true, 'Custom settlement fetch done');
      }
    } finally {
      setBusy(false);
    }
    return;
  }

  // ── Standard boundary mode ──
  const isKadastrMode = fetchMode === 'kadastr';
  const rawInput      = document.getElementById('area-name').value.trim();
  const parcelSource  = getParcelSource();
  const isFullParcels = document.getElementById('chk-full-parcels').checked;
  const areas         = rawInput.split('...').map(s => s.trim()).filter(Boolean);
  const territory     = areas[0] || '';
  const isMultiArea   = !isFullParcels && areas.length > 1;
  const isMultiKmz    = boundaryFiles.length > 1;
  const layers        = [...document.querySelectorAll('input[name="layer"]:checked')].map(cb => cb.value);

  // ── Validate ──
  if (isKadastrMode) {
    if (!boundaryFiles.length) { appendLog('⚠ Please attach at least one boundary KMZ/KML file.'); return; }
  } else if (isFullParcels) {
    if (!territory) { appendLog('⚠ Please enter an area name.'); return; }
  } else if (isMultiKmz) {
    if (!layers.length) { appendLog('⚠ Please select at least one OSM layer.'); return; }
  } else if (!boundaryFiles.length) {
    if (!territory) { appendLog('⚠ Please enter an area name.'); return; }
    if (!layers.length) { appendLog('⚠ Please select at least one layer.'); return; }
  } else {
    if (boundaryFiles[0].url === '' ) { appendLog('⚠ Boundary file could not be parsed.'); return; }
    if (!layers.length) { appendLog('⚠ Please select at least one OSM layer.'); return; }
    if (!territory) { appendLog('⚠ Please enter an area name for OSM layers.'); return; }
  }

  const windOptions = layers.includes('wind') ? {
    hubHeight: parseInt(document.getElementById('wind-hub-height').value, 10),
  } : {};
  if (layers.includes('forests')) {
    const forestMeters = parseInt(document.getElementById('forest-buffer-meters').value, 10);
    windOptions.forestBufferMeters = Number.isFinite(forestMeters) && forestMeters > 0 ? forestMeters : 700;
  }
  const layerOptions = Object.keys(windOptions).length ? windOptions : null;

  document.getElementById('main-log').textContent = '';
  setBusy(true);
  userStopped = false;

  async function scrapeWithRetries(startUrl, boundaryPath, source, label) {
    appendLog(`━━━ Parcels (${getParcelSourceLabel(source)}): ${label} ━━━`);
    let tilesGot = 0;
    let parcelsGot = 0;
    for (let round = 1; round <= 2 && tilesGot === 0; round++) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const res = await window.api.startScraping(startUrl, outputFolder,
          { headless: true, boundaryFilter: boundaryPath, parcelSource: source });
        appendLog(`Scraper exited (code ${res.code})`);
        tilesGot = res.tiles || 0;
        parcelsGot = res.parcels || 0;
        if (parcelsGot > 0) break;
        if (attempt < 3) appendLog(`⚠ No parcels yet — retrying (${attempt + 1}/3)…`);
      }
    }
    return { tiles: tilesGot, parcels: parcelsGot };
  }

  // Helper: run parcel scraper with automatic source failover
  async function scrapeOne(bf, label) {
    const primary = parcelSource;
    const sourceOrder = [primary];
    for (let idx = 0; idx < sourceOrder.length; idx++) {
      const source = sourceOrder[idx];
      const startUrl = makeParcelUrlForBoundary(bf, source);
      const res = await scrapeWithRetries(startUrl, bf.path, source, label);
      if (res.parcels > 0) return { tiles: res.tiles, parcels: res.parcels, source };
    }
    return { tiles: 0, parcels: 0, source: primary };
  }

  // ══════════════════════════════════════════════════════════
  // KADASTR MODE — boundary KMZ/KML parcel scraping only
  // ══════════════════════════════════════════════════════════
  if (isKadastrMode && isMultiKmz) {
    const finalOutput = await window.api.resolveOutputPath(outputFolder, 'kadastr');
    const kmzPaths = [], folderNames = [];
    const cadCsvPaths = [];
    initRunProgress(boundaryFiles.length, 'Kadastr multi-KMZ');

    for (let i = 0; i < boundaryFiles.length; i++) {
      const bf = boundaryFiles[i];
      setRunProgressLabel(`Boundary ${i + 1}/${boundaryFiles.length}: ${bf.name}`);
      const folderName = bf.url.includes('#') ? bf.url.split('#')[1] : bf.name.replace(/\.kmz?$/i, '');
      const tempPath   = `${outputFolder}/_kadastr_temp_${i}.kmz`;
      const tempCadCsvPath = `${outputFolder}/_kadastr_temp_${i}_cadnums.csv`;

      const scrapeRes = await scrapeOne(bf, `${i + 1}/${boundaryFiles.length}: ${bf.name}`);
      if (scrapeRes.tiles === 0) { appendLog(`⚠ Skipping ${bf.name} — no tiles.`); tickRunProgress(false); continue; }

      const scraperOut = `${outputFolder}/land_plots.kmz`;
      const fsRename = await window.api.mergeKmz([scraperOut], tempPath, true);
      if (!fsRename.success) { appendLog(`⚠ Could not save temp KMZ for ${bf.name}`); tickRunProgress(false); continue; }

      const scraperCadCsv = `${outputFolder}/land_plots_cadnums.csv`;
      const csvCopy = await window.api.mergeCadnumCsvs([scraperCadCsv], tempCadCsvPath, false);
      if (!csvCopy.success) {
        appendLog(`⚠ Could not save temp cadnums CSV for ${bf.name}: ${csvCopy.error || 'unknown error'}`);
      } else {
        cadCsvPaths.push(tempCadCsvPath);
      }

      kmzPaths.push(tempPath);
      folderNames.push(folderName);
      tickRunProgress(true);
    }

    if (!kmzPaths.length) { appendLog('❌ All files failed.'); setBusy(false); return; }

    appendLog('\n📦 Merging into kadastr.kmz…');
    const mergeResult = await window.api.mergeKmz(kmzPaths, finalOutput, true, folderNames);
    if (cadCsvPaths.length) {
      const finalCadCsv = `${outputFolder}/land_plots_cadnums.csv`;
      const cadMerge = await window.api.mergeCadnumCsvs(cadCsvPaths, finalCadCsv, true);
      if (cadMerge.success) appendLog(`📊 Cadnums merged → ${finalCadCsv} (${cadMerge.count})`);
      else appendLog(`⚠ Cadnums merge failed: ${cadMerge.error || 'unknown error'}`);
      if (cadMerge.success) addResultEntry(finalCadCsv, 'Cadnums CSV');
    }
    if (mergeResult.success) {
      appendLog(`\n✅ Done → ${finalOutput}`);
      window.api.copyIcons(outputFolder);
      addResultEntry(finalOutput, 'KMZ');
      window.api.showInFolder(finalOutput);
    } else {
      appendLog(`[ERROR] Merge failed: ${mergeResult.error}`);
    }
    setBusy(false);
    return;
  }

  if (isKadastrMode && boundaryFiles.length === 1) {
    const bf = boundaryFiles[0];
    initRunProgress(1, `Kadastr: ${bf.name}`);
    const scrapeRes = await scrapeOne(bf, bf.name);
    if (scrapeRes.tiles === 0) {
      appendLog(`❌ No tiles/parcels after retries on ${getParcelSourceLabel(parcelSource)}.`);
      tickRunProgress(false, 'Kadastr scrape failed');
      setBusy(false); return;
    }
    const finalOutput = await window.api.resolveOutputPath(outputFolder, 'kadastr');
    const scraperOut = `${outputFolder}/land_plots.kmz`;
    const mergeResult = await window.api.mergeKmz([scraperOut], finalOutput, true);
    if (mergeResult.success) {
      appendLog(`\n✅ Done → ${finalOutput}`);
      window.api.copyIcons(outputFolder);
      addResultEntry(finalOutput, 'KMZ');
      window.api.showInFolder(finalOutput);
      tickRunProgress(true, 'Kadastr scrape done');
    } else {
      appendLog(`[ERROR] Save failed: ${mergeResult.error}`);
      tickRunProgress(false, 'Kadastr save failed');
    }
    setBusy(false);
    return;
  }

  // ══════════════════════════════════════════════════════════
  // FULL-AREA PARCELS MODE — auto-grid the territory bbox
  // ══════════════════════════════════════════════════════════
  if (isFullParcels) {
    initRunProgress(1, 'Full-area parcels');
    appendLog(`🗺 Resolving bbox for "${territory}"…`);
    const bboxResult = await window.api.resolveBbox(territory);
    if (!bboxResult.success) {
      appendLog(`❌ Could not resolve area: ${bboxResult.error}`);
      tickRunProgress(false, 'Bbox resolve failed');
      setBusy(false); return;
    }
    const { bbox, boundaryGeojson } = bboxResult;
    appendLog(`📐 Bbox: ${bbox.south.toFixed(4)},${bbox.west.toFixed(4)} → ${bbox.north.toFixed(4)},${bbox.east.toFixed(4)}`);

    // Create a temp boundary KMZ (used by scraper to filter parcels)
    const tempBoundaryPath = `${outputFolder}/_full_area_boundary.kmz`;
    const bkmzResult = await window.api.createBoundaryKmz(boundaryGeojson, tempBoundaryPath);
    if (!bkmzResult.success) {
      appendLog(`❌ Could not create boundary KMZ: ${bkmzResult.error}`);
      tickRunProgress(false, 'Boundary prep failed');
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
    let tilesGot = 0;
    let parcelsGot = 0;
    for (let round = 1; round <= 2 && parcelsGot === 0; round++) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const source = parcelSource;
        const baseUrl = getParcelSourceBaseUrl(source);
        const res = await window.api.startScraping(cells[0] ? `${baseUrl}/#14/${cells[0].lat}/${cells[0].lng}` : '', outputFolder, {
          headless: true,
          boundaryFilter: tempBoundaryPath,
          gridCells: cells,
          parcelSource: source,
        });
        appendLog(`Scraper exited (code ${res.code})`);
        tilesGot = res.tiles || 0;
        parcelsGot = res.parcels || 0;
        if (parcelsGot > 0) break;
        if (attempt < 3) appendLog(`⚠ No parcels yet — retrying (${attempt + 1}/3)…`);
      }
    }

    if (parcelsGot === 0) {
      appendLog('❌ No parcels found in area.');
      tickRunProgress(false, 'No parcels found');
      setBusy(false); return;
    }

    const finalOutput = await window.api.resolveOutputPath(outputFolder, sanitizeFilename(territory));
    const scraperOut  = `${outputFolder}/land_plots.kmz`;
    const mergeResult = await window.api.mergeKmz([scraperOut], finalOutput, true);
    if (mergeResult.success) {
      appendLog(`\n✅ Done → ${finalOutput}`);
      window.api.copyIcons(outputFolder);
      addResultEntry(finalOutput, 'KMZ');
      window.api.showInFolder(finalOutput);
      tickRunProgress(true, 'Full-area parcels done');
    } else {
      appendLog(`[ERROR] Rename failed: ${mergeResult.error}`);
      tickRunProgress(false, 'Full-area save failed');
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
    initRunProgress(boundaryFiles.length, 'Boundary batch');

    for (let i = 0; i < boundaryFiles.length; i++) {
      const bf = boundaryFiles[i];
      setRunProgressLabel(`Boundary ${i + 1}/${boundaryFiles.length}: ${bf.name}`);
      // Folder name = coordinates portion of kadastr URL (after #)
      const folderName = bf.url.includes('#') ? bf.url.split('#')[1] : bf.name.replace(/\.kmz?$/i, '');
      const tempPath   = `${outputFolder}/_kadastr_temp_${i}.kmz`;

      const scrapeRes = await scrapeOne(bf, `${i + 1}/${boundaryFiles.length}: ${bf.name}`);
      if (scrapeRes.tiles === 0) { appendLog(`⚠ Skipping ${bf.name} — no tiles.`); tickRunProgress(false); continue; }

      // land_plots.kmz is the fixed output of the scraper; rename to temp
      const scraperOut = `${outputFolder}/land_plots.kmz`;
      const fs_rename  = await window.api.mergeKmz([scraperOut], tempPath, true);
      if (!fs_rename.success) { appendLog(`⚠ Could not save temp KMZ for ${bf.name}`); tickRunProgress(false); continue; }

      kmzPaths.push(tempPath);
      folderNames.push(folderName);
      tickRunProgress(true);
    }

    if (!kmzPaths.length) { appendLog('❌ All files failed.'); setBusy(false); return; }

    appendLog('\n📦 Merging into Parcels.kmz…');
    const mergeResult = await window.api.mergeKmz(kmzPaths, finalOutput, true, folderNames);
    if (mergeResult.success) {
      appendLog(`\n✅ Done → ${finalOutput}`);
      window.api.copyIcons(outputFolder);
      addResultEntry(finalOutput, 'KMZ');
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
    initRunProgress(areas.length, 'Multi-area OSM');

    let successCount = 0;
    for (let i = 0; i < areas.length; i++) {
      const area = areas[i];
      setRunProgressLabel(`Area ${i + 1}/${areas.length}: ${area}`);
      appendLog(`\n━━━ Area ${i + 1}/${areas.length}: ${area} ━━━`);
      const areaFilename = sanitizeFilename(area);
      const areaOutput   = await window.api.resolveOutputPath(outputFolder, areaFilename);
      const osmResult = await window.api.fetchOSM({
        territory: area, layers, outputPath: areaOutput,
        format: 'kmz', windOptions: layerOptions, fallbackBbox: null,
      });
      if (!osmResult.success) { appendLog(`[ERROR] Failed for "${area}": ${osmResult.error}`); tickRunProgress(false); continue; }
      appendLog(`✅ ${area} → ${areaOutput}`);
      addResultEntry(areaOutput, 'KMZ');
      successCount++;
      tickRunProgress(true);
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
  initRunProgress(1, 'Single-area run');
  const finalOutput  = await window.api.resolveOutputPath(outputFolder, safeFilename);
  const kadastrTemp  = outputFolder + '/land_plots.kmz';
  const osmTemp      = outputFolder + '/_osm_temp.kmz';
  const boundaryBbox = boundaryFiles[0] || null;
  const bf           = null;
  let hasKadastr     = false;

  if (bf) {
    const scrapeRes = await scrapeOne(bf, territory || bf.name);
    if (scrapeRes.tiles === 0) {
      appendLog(`❌ No tiles/parcels after retries on ${getParcelSourceLabel(parcelSource)}. Stopping.`);
      tickRunProgress(false, 'Single-area scrape failed');
      setBusy(false); return;
    }
    hasKadastr = true;
    if (userStopped) { appendLog('ℹ Stopped — saved as land_plots.kmz'); setBusy(false); return; }
  }

  if (layers.length > 0) {
    appendLog(`\n━━━ Phase 2: OSM layers [${layers.join(', ')}] ━━━`);
    const osmResult = await window.api.fetchOSM({
      territory, layers, outputPath: osmTemp, format: 'kmz',
      windOptions: layerOptions, fallbackBbox: boundaryBbox?.bbox || null,
    });
    if (!osmResult.success) {
      appendLog(`[ERROR] OSM fetch failed: ${osmResult.error}`);
      if (hasKadastr) appendLog(`ℹ Kadastr data saved as land_plots.kmz`);
      tickRunProgress(false, 'OSM fetch failed');
      setBusy(false); return;
    }
    const toMerge = hasKadastr ? [kadastrTemp, osmTemp] : [osmTemp];
    appendLog(hasKadastr ? '\n📦 Merging KMZ files…' : '');
    const mergeResult = await window.api.mergeKmz(toMerge, finalOutput, true, undefined, 'Analytics');
    if (mergeResult.success) {
      appendLog(`\n✅ Done → ${finalOutput}`);
      window.api.copyIcons(outputFolder);
      addResultEntry(finalOutput, 'KMZ');
      window.api.showInFolder(finalOutput);
      tickRunProgress(true, 'Single-area run done');
    } else { appendLog(`[ERROR] Merge failed: ${mergeResult.error}`); }
    if (!mergeResult.success) tickRunProgress(false, 'Single-area merge failed');
  } else {
    appendLog(`\n✅ Done → ${kadastrTemp}`);
    window.api.copyIcons(outputFolder);
    addResultEntry(kadastrTemp, 'KMZ');
    window.api.showInFolder(kadastrTemp);
    tickRunProgress(true, 'Single-area run done');
  }

  setBusy(false);
});

// ── e.land.gov.ua Lookup ────────────────────────────────────

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
    const fileName = elandCsvPath.split(/[\\/]/).pop();
    document.getElementById('cadnums-csv-display').textContent = fileName;
    const mainDisplay = document.getElementById('eland-csv-display-main');
    if (mainDisplay) mainDisplay.textContent = fileName;
    checkElandReady();
    checkStartReady();
  }
});

document.getElementById('eland-output-format').addEventListener('change', (e) => {
  setElandFormat(e.target.value);
});

document.getElementById('btn-eland-start').addEventListener('click', async () => {
  if (!elandCsvPath || !preTabOutputFolder || elandBusy) return;
  elandBusy = true;
  checkElandReady();
  document.getElementById('btn-eland-stop').style.display = '';

  const csvName = elandCsvPath.split(/[\\/]/).pop() || 'cadnums.csv';
  const baseName = csvName.replace(/\.csv$/i, '') || 'cadnums';
  const outputPath = preTabOutputFolder + (preTabOutputFolder.endsWith('/') || preTabOutputFolder.endsWith('\\') ? '' : '/') + baseName + `_eland.xlsx`;
  const result = await window.api.startElandLookup(elandCsvPath, outputPath, { format: elandOutputFormat });
  if (result && result.success) {
    addResultEntry(result.outputPath, 'e.land XLSX');
    if (result.docxOutputPath) addResultEntry(result.docxOutputPath, 'e.land DOCX');
    window.api.showInFolder(result.outputPath);
  }

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
    addResultEntry(result.outputPath, 'Research XLSX');
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
  const forceUpdateAws = !!document.getElementById('offline-force-update-aws')?.checked;
  btn.disabled = true;
  progress.style.width = '0%';
  status.textContent = 'starting...';
  appendLog('⬇ Starting offline dataset download...');
  const result = await window.api.downloadOfflineData({ worldcoverUrl: '', geologyUrl, forceUpdate, forceUpdateAws });
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
    addResultEntry(result.cacheDir, 'Offline cache');
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
