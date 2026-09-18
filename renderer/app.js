'use strict';

// ── Helpers ────────────────────────────────────────────────
const LOG_MAX_LINES = 1500;
const LOG_FLUSH_CHUNK_SIZE = 200;
let logLines = [];
let logFlushScheduled = false;
let logDropNoticeShown = false;

function flushLog() {
  const el = document.getElementById('tab-log');
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

function clearLogs() {
  logLines = [];
  const el = document.getElementById('tab-log');
  if (el) el.textContent = '';
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
  countsEl.textContent = `${runProgress.current}/${runProgress.total} · ok ${runProgress.success} · fail ${runProgress.failed}`;
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

let previewMap = null;
let previewLayer = null;
let boundaryOverlayLayers = []; // shapes drawn for the currently-attached boundaryFiles

// Shows every attached/drawn boundary on the preview map — the KMZ/KML the
// user picked, or a shape finished with the draw tool — as a dashed blue
// outline, so it's visible before a run ever starts. Since the same
// boundaryFiles list is also used to clip OSM layers, this doubles as a
// preview of "where the OSM restriction is applied" too. Called any time
// renderBoundaryList() is, i.e. every add/remove/clear.
async function refreshBoundaryOverlay() {
  if (!previewMap) return;
  boundaryOverlayLayers.forEach((l) => previewMap.removeLayer(l));
  boundaryOverlayLayers = [];
  if (!boundaryFiles.length) return;

  const allBounds = L.latLngBounds();
  for (const f of boundaryFiles) {
    try {
      const res = await window.api.parseKmz(f.path);
      if (!res || !res.success) continue;
      const layersData = res.layers || (res.geojson ? [{ name: 'Boundary', geojson: res.geojson }] : []);
      for (const layerInfo of layersData) {
        const layer = L.geoJSON(layerInfo.geojson, {
          style: { color: '#2563eb', weight: 2, dashArray: '6,4', fillColor: '#2563eb', fillOpacity: 0.06 },
          pointToLayer: (feature, latlng) => L.circleMarker(latlng, { radius: 4, color: '#2563eb', weight: 2, fillOpacity: 0.3 }),
        });
        layer.bindTooltip(f.name, { sticky: true });
        layer.addTo(previewMap);
        boundaryOverlayLayers.push(layer);
        try { allBounds.extend(layer.getBounds()); } catch (_) {}
      }
    } catch (err) {
      console.warn('Boundary preview failed for', f.path, err);
    }
  }

  // Don't yank the view if a generated KMZ is already being inspected —
  // only auto-fit when the map would otherwise still be showing nothing new.
  if (allBounds.isValid() && !previewLayer) {
    previewMap.fitBounds(allBounds, { padding: [30, 30], maxZoom: 15 });
  }
}

// Creates the empty base map (just tiles, no data) the first time it's
// needed — called on startup so the preview panel never sits blank, and
// reused by showMapPreview so loading a KMZ doesn't recreate it.
function ensurePreviewMap() {
  if (previewMap) return previewMap;
  const container = document.getElementById('map-container');
  container.innerHTML = '<i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i><div id="leaflet-map" style="width:100%;height:100%"></div><div id="preview-layer-control" style="display:none;position:absolute;top:10px;right:10px;background:rgba(255,255,255,0.95);border:1px solid var(--color-divider);border-radius:2px;padding:8px;z-index:1000;box-shadow:0 2px 5px rgba(0,0,0,0.1);max-height:80%;overflow-y:auto;min-width:140px;"><div style="font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:var(--color-neutral-700);margin-bottom:6px;border-bottom:1px solid var(--color-divider);padding-bottom:4px;">Map Layers</div><div id="preview-layer-list" style="display:flex;flex-direction:column;gap:4px;"></div></div>';
  previewMap = L.map('leaflet-map', { zoomControl: false }).setView([48.3794, 31.1656], 6);
  L.control.zoom({ position: 'bottomright' }).addTo(previewMap);

  // Base map toggle — satellite imagery by default (shows real terrain,
  // useful for checking parcel boundaries), streets still available via the
  // control below.
  const streetsLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
  });
  const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  }).addTo(previewMap);
  L.control.layers(
    { 'Streets (OSM)': streetsLayer, 'Satellite (Esri)': satelliteLayer },
    null,
    { position: 'topleft', collapsed: false }
  ).addTo(previewMap);

  return previewMap;
}

async function showMapPreview(kmzPath) {
  document.getElementById('map-summary').textContent = kmzPath.split(/[\\/\\\\]/).pop();
  ensurePreviewMap();
  setTimeout(() => previewMap.invalidateSize(), 100);

  if (previewLayer) {
    if (Array.isArray(previewLayer)) {
      previewLayer.forEach(l => previewMap.removeLayer(l));
    } else {
      previewMap.removeLayer(previewLayer);
    }
    previewLayer = null;
  }
  
  const layerControl = document.getElementById('preview-layer-control');
  const layerList = document.getElementById('preview-layer-list');
  if (layerControl) layerControl.style.display = 'none';
  if (layerList) layerList.innerHTML = '';

  const res = await window.api.parseKmz(kmzPath);
  
  if (res && res.success) {
    let layersData = res.layers;
    // Fallback for older parse-kmz that returns a single geojson
    if (!layersData && res.geojson) {
      layersData = [{ name: 'Data', geojson: res.geojson }];
    }
    
    if (layersData && layersData.length > 0) {
      previewLayer = [];
      const allBounds = L.latLngBounds();
      
      layersData.forEach((layerInfo, idx) => {
        // Give every layer its own Leaflet pane with a z-index fixed by its
        // position in the KML document (the same order Google Earth stacks
        // these folders in — later folder = drawn on top). A pane's z-index
        // is independent of DOM add/remove order, so toggling a layer off
        // and back on via the checkboxes below can never bump it above a
        // layer that's supposed to stay more "important"/on top of it —
        // plain map.addLayer()/removeLayer() on a shared pane would.
        const paneName = `preview-layer-${idx}`;
        if (!previewMap.getPane(paneName)) {
          previewMap.createPane(paneName).style.zIndex = String(410 + idx);
        }
        const leafletLayer = L.geoJSON(layerInfo.geojson, {
          pane: paneName,
          style: function(feature) {
            return {
              color: feature.properties.stroke || '#e05',
              weight: feature.properties['stroke-width'] || 2,
              fillColor: feature.properties.fill || feature.properties.stroke || '#e05',
              fillOpacity: feature.properties['fill-opacity'] !== undefined ? feature.properties['fill-opacity'] : 0.2
            };
          },
          pointToLayer: function (feature, latlng) {
            return L.circleMarker(latlng, {
              pane: paneName,
              radius: 4,
              fillColor: feature.properties.fill || feature.properties.stroke || "#e05",
              color: feature.properties.stroke || "#fff",
              weight: 1,
              opacity: 1,
              fillOpacity: feature.properties['fill-opacity'] !== undefined ? feature.properties['fill-opacity'] : 0.8
            });
          },
          onEachFeature: function (feature, layer) {
            // Same info Google Earth shows in its placemark balloon — the
            // KML <name>/<description> survive into these GeoJSON properties
            // via togeojson, description included (our own HTML tables too).
            const props = feature.properties || {};
            const name = props.name || props.Name || '';
            const desc = props.description || props.Description || '';
            if (!name && !desc) return;
            const container = document.createElement('div');
            container.style.cssText = 'max-width:300px;max-height:340px;overflow:auto;font-size:12px;';
            if (name) {
              const title = document.createElement('div');
              title.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:6px;';
              title.textContent = name;
              container.appendChild(title);
            }
            if (desc) {
              const body = document.createElement('div');
              body.innerHTML = desc;
              container.appendChild(body);
            }
            layer.bindPopup(container, { maxWidth: 320 });
          }
        }).addTo(previewMap);
        
        previewLayer.push(leafletLayer);
        
        const bounds = leafletLayer.getBounds();
        if (bounds.isValid()) {
          allBounds.extend(bounds);
        }
        
        // Add to layer control
        if (layerList) {
          const lbl = document.createElement('label');
          lbl.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11.5px;cursor:pointer;word-break:break-word;';
          
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = true;
          cb.style.cssText = 'width:12px;height:12px;accent-color:#5980a6;flex:none;';
          cb.addEventListener('change', (e) => {
            if (e.target.checked) previewMap.addLayer(leafletLayer);
            else previewMap.removeLayer(leafletLayer);
          });
          
          const text = document.createElement('span');
          text.textContent = layerInfo.name || `Layer ${idx + 1}`;
          
          lbl.appendChild(cb);
          lbl.appendChild(text);
          layerList.appendChild(lbl);
        }
      });
      
      if (layerControl && layersData.length > 0) {
        layerControl.style.display = 'block';
      }
      
      if (allBounds.isValid()) {
        previewMap.fitBounds(allBounds, { maxZoom: 16, padding: [20, 20] });
      }
    } else {
      appendLog(`❌ Map Preview: No features found in KMZ`);
    }
  } else {
    appendLog(`❌ Map Preview failed: ${res ? res.error : 'Unknown error'}`);
  }
}

// ── Draw a custom boundary directly on the preview map ──────────────────────
// Google-Earth-style polygon tool: click to place vertices, click the first
// vertex again (or press Finish) to close the shape. Reuses the same
// createBoundaryKmz + readKmlBbox pipeline that Full-area parcels mode
// already uses to turn a computed bbox into a real boundary file, so the
// drawn shape becomes a normal boundaryFiles entry.
let drawingBoundary = false;
let drawPoints = [];
let drawPreviewShape = null;
let drawVertexMarkers = [];
let drawToolbar = null;

function updateDrawPreview() {
  if (drawPreviewShape) { previewMap.removeLayer(drawPreviewShape); drawPreviewShape = null; }
  if (drawPoints.length >= 2) {
    drawPreviewShape = L.polygon(drawPoints, { color: '#e05', weight: 2, dashArray: '5,5', fillOpacity: 0.08 }).addTo(previewMap);
  }
}

// Vertex marker icon — plain divIcon so we control the look fully (no default
// leaflet-div-icon white-square styling). The first/closing point is drawn
// slightly larger so it stays visually distinct even after other points move.
function vertexIcon(isFirst) {
  const size = isFirst ? 16 : 14;
  return L.divIcon({
    className: 'draw-vertex-marker',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:#e05;border:2px solid #fff;box-shadow:0 0 3px rgba(0,0,0,0.5);cursor:move;"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// Re-attaches the "click first point to finish" handler to whichever marker
// is currently first (indices shift as points get removed), and keeps the
// first-point icon visually distinct.
function rebindDrawVertexHandlers() {
  drawVertexMarkers.forEach((m, i) => {
    m.off('click');
    m.setIcon(vertexIcon(i === 0));
    if (i === 0) {
      m.on('click', (ev) => {
        L.DomEvent.stopPropagation(ev);
        if (drawPoints.length >= 3) finishDrawingBoundary();
      });
    }
  });
}

// Right-click (or long-press-equivalent contextmenu) on a vertex removes it,
// like Google Earth's polygon tool.
function removeDrawPoint(marker) {
  const idx = drawVertexMarkers.indexOf(marker);
  if (idx === -1) return;
  previewMap.removeLayer(marker);
  drawVertexMarkers.splice(idx, 1);
  drawPoints.splice(idx, 1);
  rebindDrawVertexHandlers();
  updateDrawPreview();
  updateDrawToolbar();
}

function updateDrawToolbar() {
  if (!drawToolbar) return;
  const hint = drawToolbar.querySelector('[data-draw-hint]');
  const finishBtn = drawToolbar.querySelector('[data-draw-finish]');
  if (hint) {
    hint.textContent = drawPoints.length < 3
      ? `Click to add points (${drawPoints.length} so far, need 3+) · drag to move · right-click to remove`
      : `${drawPoints.length} points — click the first point again, or press Finish · drag to move · right-click to remove`;
  }
  if (finishBtn) finishBtn.disabled = drawPoints.length < 3;
}

function cleanupDrawLayers() {
  if (drawPreviewShape) { previewMap.removeLayer(drawPreviewShape); drawPreviewShape = null; }
  drawVertexMarkers.forEach((m) => previewMap.removeLayer(m));
  drawVertexMarkers = [];
  drawPoints = [];
}

function onDrawMapClick(e) {
  drawPoints.push(e.latlng);
  const isFirst = drawPoints.length === 1;
  const marker = L.marker(e.latlng, {
    icon: vertexIcon(isFirst), draggable: true, autoPan: true, zIndexOffset: 1000,
  }).addTo(previewMap);

  // Drag to reposition a misplaced point — keep drawPoints in sync live so
  // the dashed preview polygon follows the marker as it moves.
  marker.on('drag', (ev) => {
    const idx = drawVertexMarkers.indexOf(marker);
    if (idx === -1) return;
    drawPoints[idx] = ev.target.getLatLng();
    updateDrawPreview();
  });

  // Right-click to remove this point, like Google Earth's polygon tool.
  marker.on('contextmenu', (ev) => {
    L.DomEvent.stop(ev);
    removeDrawPoint(marker);
  });

  drawVertexMarkers.push(marker);
  rebindDrawVertexHandlers();
  updateDrawPreview();
  updateDrawToolbar();
}

function stopDrawingBoundary() {
  drawingBoundary = false;
  previewMap.off('click', onDrawMapClick);
  const mapEl = document.getElementById('leaflet-map');
  if (mapEl) mapEl.style.cursor = '';
  if (drawToolbar) { drawToolbar.remove(); drawToolbar = null; }
  cleanupDrawLayers();
}

async function finishDrawingBoundary() {
  if (drawPoints.length < 3) return;
  const ring = drawPoints.map((p) => [p.lng, p.lat]);
  ring.push(ring[0]);
  const geometry = { type: 'Polygon', coordinates: [ring] };

  if (!outputFolder) {
    appendLog('⚠ Choose an output folder (Step 2) before drawing a boundary.');
    stopDrawingBoundary();
    return;
  }

  const name = `drawn_boundary_${Date.now()}`;
  const filePath = `${outputFolder}/_${name}.kmz`;
  const kmzRes = await window.api.createBoundaryKmz(geometry, filePath);
  if (!kmzRes || !kmzRes.success) {
    appendLog(`⚠ Could not save drawn boundary: ${kmzRes ? kmzRes.error : 'unknown error'}`);
    stopDrawingBoundary();
    return;
  }
  const bbox = await window.api.readKmlBbox(filePath);
  if (!bbox || bbox.error) {
    appendLog(`⚠ Could not read bbox from drawn boundary: ${bbox ? bbox.error : 'unknown error'}`);
    stopDrawingBoundary();
    return;
  }
  const url = makeParcelUrlForBbox(bbox);
  boundaryFiles.push({
    path: filePath,
    url,
    bbox: {
      west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north,
      centerLat: bbox.centerLat, centerLng: bbox.centerLng, zoom: bbox.zoom,
    },
    name: `${name}.kmz`,
  });
  appendLog(`✏️ Drawn boundary added: zoom=${bbox.zoom}, center=${bbox.centerLat.toFixed(4)},${bbox.centerLng.toFixed(4)}`);
  renderBoundaryList();
  checkStartReady();
  stopDrawingBoundary();
}

function startDrawingBoundary() {
  ensurePreviewMap();
  if (drawingBoundary) return;
  drawingBoundary = true;
  cleanupDrawLayers();

  const mapEl = document.getElementById('leaflet-map');
  if (mapEl) mapEl.style.cursor = 'crosshair';

  drawToolbar = document.createElement('div');
  drawToolbar.style.cssText = 'position:absolute;bottom:14px;left:50%;transform:translateX(-50%);z-index:1200;background:rgba(255,255,255,0.97);border:1px solid var(--color-divider);border-radius:3px;padding:8px 10px;box-shadow:0 2px 8px rgba(0,0,0,0.15);display:flex;align-items:center;gap:10px;font-size:11.5px;';
  drawToolbar.innerHTML = `
    <span data-draw-hint>Click to add points (0 so far, need 3+)</span>
    <button type="button" data-draw-finish class="btn btn-primary" style="height:24px;padding:0 10px;font-size:11px;" disabled>Finish</button>
    <button type="button" data-draw-cancel class="btn btn-secondary" style="height:24px;padding:0 10px;font-size:11px;">Cancel</button>
  `;
  document.getElementById('map-container').appendChild(drawToolbar);
  drawToolbar.querySelector('[data-draw-finish]').addEventListener('click', () => finishDrawingBoundary());
  drawToolbar.querySelector('[data-draw-cancel]').addEventListener('click', () => stopDrawingBoundary());

  previewMap.on('click', onDrawMapClick);
}

document.addEventListener('keydown', (e) => {
  if (drawingBoundary && e.key === 'Escape') stopDrawingBoundary();
});

document.getElementById('btn-draw-boundary')?.addEventListener('click', () => {
  startDrawingBoundary();
});

function renderResults() {
  const list = document.getElementById('results-list');
  const countEl = document.getElementById('result-count');
  if(countEl) countEl.textContent = resultEntries.length;
  if (!list) return;
  list.innerHTML = '';
  if (!resultEntries.length) {
    list.innerHTML = '<div style="display:flex;flex-direction:column;gap:2px;color:var(--color-neutral-700);font-size:12.5px;"><span>No generated files yet.</span><span style="font-size:11.5px;">Файлів ще немає.</span></div>';
    return;
  }
  for (const entry of resultEntries) {
    const item = document.createElement('div');
    item.className = 'blueprint';
    item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 10px;background:var(--color-neutral-200);';

    const pathLine = document.createElement('span');
    pathLine.style.cssText = 'min-width:0;line-height:1.3;';
    pathLine.innerHTML = `<span style="display:block;font-family:var(--font-heading);font-size:13.5px;">${entry.label}</span><span style="display:block;font-size:11px;color:var(--color-neutral-700);word-break:break-all;font-family:ui-monospace, Menlo, monospace;">${entry.path}</span>`;
    item.appendChild(pathLine);

    const actions = document.createElement('span');
    actions.style.cssText = 'display:flex;gap:6px;flex:none;';

    const openFileBtn = document.createElement('button');
    openFileBtn.className = 'btn btn-secondary';
    openFileBtn.type = 'button';
    openFileBtn.style.cssText = 'height:26px;padding:0 9px;font-size:11.5px;';
    openFileBtn.textContent = 'Open file';
    openFileBtn.addEventListener('click', () => window.api.openPath(entry.path));

    const openFolderBtn = document.createElement('button');
    openFolderBtn.className = 'btn btn-secondary';
    openFolderBtn.type = 'button';
    openFolderBtn.style.cssText = 'height:26px;padding:0 9px;font-size:11.5px;';
    openFolderBtn.textContent = 'Folder';
    openFolderBtn.addEventListener('click', () => window.api.openPath(getDirname(entry.path)));

    actions.appendChild(openFileBtn);
    actions.appendChild(openFolderBtn);
    
    if (entry.path.toLowerCase().endsWith('.kmz')) {
      const previewBtn = document.createElement('button');
      previewBtn.className = 'btn btn-secondary';
      previewBtn.type = 'button';
      previewBtn.style.cssText = 'height:26px;padding:0 9px;font-size:11.5px;';
      previewBtn.textContent = 'Preview';
      previewBtn.addEventListener('click', () => showMapPreview(entry.path));
      actions.appendChild(previewBtn);
    }
    
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
  
  // Always auto-open KMZ/KML into the in-app preview — not user-configurable.
  // Only KMZ/KML, since only those have an in-app viewer — show it in our
  // own preview map instead of handing it off to whatever the OS has
  // associated with .kmz (usually Google Earth). Everything else (XLSX,
  // DOCX, CSV) is left for the user to open manually via the result list.
  if (/\.(kmz|kml)$/i.test(p)) {
    showMapPreview(p);
  }
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

document.getElementById('tab-btn-log').addEventListener('click', () => {
  expandBottomPanel();
  document.getElementById('tab-log').style.display = 'block';
  document.getElementById('tab-results').style.display = 'none';
  document.getElementById('tab-btn-log').querySelector('.active-bg').style.display = 'block';
  document.getElementById('tab-btn-log').style.color = 'inherit';
  document.getElementById('tab-btn-results').querySelector('.active-bg').style.display = 'none';
  document.getElementById('tab-btn-results').style.color = 'var(--color-neutral-600)';
  setTimeout(() => { const el = document.getElementById('tab-log'); el.scrollTop = el.scrollHeight; }, 10);
});

document.getElementById('tab-btn-results').addEventListener('click', () => {
  expandBottomPanel();
  document.getElementById('tab-log').style.display = 'none';
  document.getElementById('tab-results').style.display = 'flex';
  document.getElementById('tab-btn-log').querySelector('.active-bg').style.display = 'none';
  document.getElementById('tab-btn-log').style.color = 'var(--color-neutral-600)';
  document.getElementById('tab-btn-results').querySelector('.active-bg').style.display = 'block';
  document.getElementById('tab-btn-results').style.color = 'inherit';
});

// ── Collapse the Log/Files panel so the map preview can use its space ──────
const BOTTOM_PANEL_HEIGHT = '246px';
const BOTTOM_PANEL_COLLAPSED_HEIGHT = '37px';
let bottomPanelCollapsed = false;

function expandBottomPanel() {
  if (!bottomPanelCollapsed) return;
  bottomPanelCollapsed = false;
  const panel = document.getElementById('bottom-panel');
  const icon = document.getElementById('toggle-bottom-panel-icon');
  const btn = document.getElementById('btn-toggle-bottom-panel');
  if (panel) panel.style.height = BOTTOM_PANEL_HEIGHT;
  if (icon) icon.style.transform = '';
  if (btn) btn.title = 'Collapse';
  // Restore whichever tab was active before collapsing.
  const logActive = document.getElementById('tab-btn-log').querySelector('.active-bg').style.display !== 'none';
  document.getElementById('tab-log').style.display = logActive ? 'block' : 'none';
  document.getElementById('tab-results').style.display = logActive ? 'none' : 'flex';
  setTimeout(() => previewMap && previewMap.invalidateSize(), 160);
}

function collapseBottomPanel() {
  if (bottomPanelCollapsed) return;
  bottomPanelCollapsed = true;
  const panel = document.getElementById('bottom-panel');
  const icon = document.getElementById('toggle-bottom-panel-icon');
  const btn = document.getElementById('btn-toggle-bottom-panel');
  if (panel) panel.style.height = BOTTOM_PANEL_COLLAPSED_HEIGHT;
  if (icon) icon.style.transform = 'rotate(180deg)';
  if (btn) btn.title = 'Expand';
  document.getElementById('tab-log').style.display = 'none';
  document.getElementById('tab-results').style.display = 'none';
  setTimeout(() => previewMap && previewMap.invalidateSize(), 160);
}

document.getElementById('btn-toggle-bottom-panel')?.addEventListener('click', () => {
  if (bottomPanelCollapsed) expandBottomPanel();
  else collapseBottomPanel();
});
resetRunProgress();
renderResults();
ensurePreviewMap();
setTimeout(() => previewMap && previewMap.invalidateSize(), 100);
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
let parcelSource = 'kadastrova_karta_ua';
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
      if (document.getElementById('btn-pick-boundary')) {
        document.getElementById('btn-pick-boundary').style.pointerEvents = isMulti ? 'none' : '';
        document.getElementById('btn-pick-boundary').style.opacity = isMulti ? '0.4' : '';
      }
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
  if (document.getElementById('btn-pick-boundary')) {
    document.getElementById('btn-pick-boundary').style.pointerEvents = isMulti ? 'none' : '';
    document.getElementById('btn-pick-boundary').style.opacity = isMulti ? '0.4' : '';
  }
  if (isMulti && boundaryFiles.length) {
    boundaryFiles = [];
    renderBoundaryList();
  }
  checkStartReady();
  return added;
}

function getParcelSource() {
  return PARCEL_SOURCE_CONFIG[parcelSource] ? parcelSource : 'kadastrova_karta_ua';
}

function getParcelSourceBaseUrl(source) {
  const key = PARCEL_SOURCE_CONFIG[source] ? source : 'kadastrova_karta_ua';
  return PARCEL_SOURCE_CONFIG[key].baseUrl;
}

function getParcelSourceLabel(source) {
  const key = PARCEL_SOURCE_CONFIG[source] ? source : 'kadastrova_karta_ua';
  return PARCEL_SOURCE_CONFIG[key].label;
}

function getFallbackParcelSource(source) {
  return 'kadastrova_karta_ua';
}

function applyRoleVisibility() {
  if (isAdminRole) return;

  document.querySelectorAll('.nav-link').forEach((btn) => {
    const mode = btn.id.replace('mode-', '');
    if (!USER_VISIBLE_MODES.has(mode)) {
      btn.style.display = 'none';
    }
  });

  if (!USER_VISIBLE_MODES.has(currentMode)) {
    setMode('kadastr');
  }
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
  const display = document.getElementById('boundary-file-display');
  const btnClear = document.getElementById('btn-clear-boundary');
  const list = document.getElementById('boundary-file-list');
  if (!display) return;
  if (boundaryFiles.length === 0) {
    display.textContent = 'not selected';
    if(btnClear) btnClear.style.display = 'none';
  } else if (boundaryFiles.length === 1) {
    display.textContent = boundaryFiles[0].name;
    if(btnClear) btnClear.style.display = '';
  } else {
    display.textContent = boundaryFiles.length + ' files selected';
    if(btnClear) btnClear.style.display = '';
  }

  // Per-file rows, each with its own × button to remove just that one file.
  if (list) {
    list.innerHTML = '';
    boundaryFiles.forEach((f, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;color:var(--color-neutral-700);background:var(--color-neutral-200);border-radius:2px;padding:3px 6px;';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = f.name;
      nameSpan.style.cssText = 'word-break:break-all;';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = '×';
      removeBtn.title = `Remove ${f.name}`;
      removeBtn.setAttribute('data-remove-boundary', String(idx));
      removeBtn.style.cssText = 'flex:none;border:none;background:none;cursor:pointer;color:var(--color-neutral-700);font-size:14px;line-height:1;padding:0 2px;';
      row.appendChild(nameSpan);
      row.appendChild(removeBtn);
      list.appendChild(row);
    });
  }

  const isMultiKmz  = boundaryFiles.length > 1;
  const isKadastrMode = currentMode === 'kadastr';
  if (isKadastrMode && isMultiKmz) {
    document.querySelectorAll('input[name="layer"]').forEach(cb => { cb.checked = false; });
  }

  refreshBoundaryOverlay();
}

// Remove one specific boundary file via its row's × button (event delegation
// so this keeps working across re-renders without piling up listeners).
document.getElementById('boundary-file-list')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove-boundary]');
  if (!btn) return;
  const idx = parseInt(btn.getAttribute('data-remove-boundary'), 10);
  if (Number.isInteger(idx) && idx >= 0 && idx < boundaryFiles.length) {
    boundaryFiles.splice(idx, 1);
    renderBoundaryList();
    checkStartReady();
  }
});

// ── Boundary picker ────────────────────────────────────────
document.getElementById('btn-pick-boundary')?.addEventListener('click', async (e) => {
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

document.getElementById('btn-clear-boundary')?.addEventListener('click', () => {
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

const dropZone = document.body;
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
  const windChecked = !!document.querySelector('input[name="layer"][value="wind"]')?.checked;
  const forestsChecked = !!document.querySelector('input[name="layer"][value="forests"]')?.checked;
  const windSettings = document.getElementById('wind-settings');
  const forestSettings = document.getElementById('forest-settings');
  if (windSettings) windSettings.style.display = windChecked ? 'block' : 'none';
  if (forestSettings) forestSettings.style.display = forestsChecked ? 'block' : 'none';
}

document.getElementById('btn-select-all')?.addEventListener('click', () => {
  document.querySelectorAll('input[name="layer"]').forEach(cb => cb.checked = true);
  updateLayerSettingsVisibility();
  checkStartReady();
});

document.getElementById('btn-clear-all')?.addEventListener('click', () => {
  document.querySelectorAll('input[name="layer"]').forEach(cb => cb.checked = false);
  updateLayerSettingsVisibility();
  checkStartReady();
});

// Since checkboxes are dynamically injected, we rely on event delegation or attach it during creation.
// In the injection loop, we already call checkStartReady(), let's make sure updateLayerSettingsVisibility is called there.

function applyFullParcelsMode(enabled) {
  const dropZone   = document.getElementById('btn-pick-boundary');
  const areaInput  = document.getElementById('area-name');
  
  if (dropZone) { dropZone.style.pointerEvents = enabled ? 'none' : ''; dropZone.style.opacity = enabled ? '0.5' : ''; }
  if (areaInput) { areaInput.disabled = enabled; }
  
  const btnSelectAll = document.getElementById('btn-select-all');
  const btnClearAll = document.getElementById('btn-clear-all');
  if (btnSelectAll) btnSelectAll.disabled = enabled;
  if (btnClearAll) btnClearAll.disabled = enabled;

  document.querySelectorAll('input[name="layer"]').forEach(cb => { cb.disabled = enabled; if (enabled) cb.checked = false; });
  if (enabled) updateLayerSettingsVisibility();
  if (enabled && boundaryFiles.length) { boundaryFiles = []; renderBoundaryList(); }
  // Keep only first area in full-parcels mode
  if (enabled) {
    if (areaNames.length > 1) areaNames = [areaNames[0]];
    syncAreaNamesValue();
    renderAreaChips();
  }
  // btn-add-area does not exist in new UI, safely ignore
  const btnAddArea = document.getElementById('btn-add-area');
  if (btnAddArea) btnAddArea.disabled = enabled;
  updateLayerSettingsVisibility();
  checkStartReady();
}

const MODES = {
  boundary: { title: 'Boundary + OSM', ua: 'Межа + шари OSM', show: ['sect-parcel-flow', 'sect-area', 'sect-boundary', 'sect-layers', 'sect-folder'], optBoundary: true },
  kadastr: { title: 'Parcels by KMZ/KML', ua: 'Ділянки за KMZ/KML', show: ['sect-parcel-flow', 'sect-boundary', 'sect-source', 'sect-kadastropts', 'sect-folder'], reqBoundary: true },
  eland: { title: 'e.land Lookup', ua: 'Пошук в e.land.gov.ua', show: ['sect-parcel-flow', 'sect-csv', 'sect-format', 'sect-folder'] },
  cadnum: { title: 'By cadastral numbers', ua: 'За кадастровими номерами', show: ['sect-parcel-flow', 'sect-cadnum', 'sect-source', 'sect-kadastropts', 'sect-folder'] },
  custom: { title: 'Settlement boundary', ua: 'Межа населеного пункту', show: ['sect-parcel-flow', 'sect-boundary', 'sect-folder'], reqBoundary: true },
  coords: { title: 'Polygon coordinates', ua: 'Координати полігону', show: ['sect-parcel-flow', 'sect-boundary', 'sect-folder'], reqBoundary: true },
  research: { title: 'Pre-Research XLSX', ua: 'Перед-дослідження', show: ['sect-research', 'sect-folder'] },
  offline: { title: 'Offline data', ua: 'Офлайн-дані', show: ['sect-offline'] }
};

let currentMode = 'boundary';

function setElandFormat(value) {
  const fmt = String(value || 'xlsx_partial');
  elandOutputFormat = fmt;
  const modeSel = document.getElementById('eland-output-format-main');
  if (modeSel && modeSel.value !== fmt) modeSel.value = fmt;
}

function updateStartButtonLabel(mode) {
  const startBtn = document.getElementById('start-btn-label');
  if (!startBtn) return;
  startBtn.textContent = MODE_BUTTON_LABELS[mode] ? MODE_BUTTON_LABELS[mode].replace('▶ Start ', '').replace('▶ ', '').replace('🔍 ', '') : 'Start';
}

function setMode(mode) {
  currentMode = mode;
  const m = MODES[mode];
  
  const headerTitle = document.getElementById('header-title');
  if (headerTitle) headerTitle.textContent = m.title;
  const headerUa = document.getElementById('header-title-ua');
  if (headerUa) headerUa.textContent = m.ua;
  
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.toggle('active', link.id === 'mode-' + mode);
  });
  
  // Hide all sections first
  ['sect-parcel-flow', 'sect-area', 'sect-cadnum', 'sect-csv', 'sect-boundary', 'sect-source', 'sect-folder', 'sect-format', 'sect-layers', 'sect-kadastropts', 'sect-research', 'sect-offline'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.style.display = 'none';
  });
  
  // Show active sections
  m.show.forEach(id => {
    const el = document.getElementById(id);
    if(el) el.style.display = '';
  });
  
  // Boundary labels
  const lbl = document.getElementById('lbl-boundary');
  const req = document.getElementById('req-boundary');
  if(lbl && req) {
    if(m.reqBoundary) {
      req.style.display = 'inline-block';
      req.textContent = 'REQUIRED';
      req.className = 'tag tag-accent';
    } else if(m.optBoundary) {
      req.style.display = 'inline-block';
      req.textContent = 'OPTIONAL';
      req.className = 'tag tag-outline';
    } else {
      req.style.display = 'none';
    }
    
    if(mode === 'custom') lbl.textContent = 'Settlement KMZ/KML · Межа НП';
    else if(mode === 'coords') lbl.textContent = 'Polygon source KML/KMZ';
    else lbl.textContent = 'Boundary KMZ/KML · Межа';
  }
  
  updateStartButtonLabel(mode);
  checkStartReady();
}

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', () => {
    setMode(link.id.replace('mode-', ''));
  });
});

const topOffline = document.getElementById('btn-top-offline');
if(topOffline) {
  topOffline.addEventListener('click', () => {
    setMode('offline');
  });
}

const LAYERS = [
  ['power_lines', 'Power lines', 'Лінії електропередач', false],
  ['towers', 'Towers', 'Опори', false],
  ['substations', 'Substations', 'Підстанції', false],
  ['roads', 'Roads', 'Дороги', false],
  ['settlements', 'Settlements +700 m', 'Населені пункти +700 м', false],
  ['water', 'Rivers & water', 'Річки та водойми', false],
  ['forests', 'Forests', 'Ліси', false],
  ['emerald', 'Emerald Network', 'Смарагдова мережа', false],
  ['airports', 'Airports +45 km', 'Аеропорти +45 км', false],
  ['nuclear_plants', 'Nuclear plants +30 km', 'АЕС +30 км', false],
  ['nature_reserves', 'Nature reserves (PZF)', 'ПЗФ', false],
  ['wind', 'Wind speed (GWA)', 'Швидкість вітру', false],
];

setTimeout(() => {
  const container = document.getElementById('layers-container');
  if(container) {
    LAYERS.forEach(l => {
      const lbl = document.createElement('label');
      lbl.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 9px;background:#f5f5f8;cursor:pointer;min-height:30px;';
      lbl.innerHTML = `<input type="checkbox" name="layer" value="${l[0]}" ${l[3] ? 'checked' : ''} style="width:14px;height:14px;accent-color:#5980a6;flex:none;" />
                      <span style="font-size:12.5px;flex:none;">${l[1]}</span>
                      <span style="font-size:11.5px;color:var(--color-neutral-700);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">· ${l[2]}</span>`;
      lbl.querySelector('input').addEventListener('change', (e) => {
        lbl.style.background = e.target.checked ? '#eef6ff' : '#f5f5f8';
        updateLayerSettingsVisibility();
        checkStartReady();
      });
      if(l[3]) lbl.style.background = '#eef6ff';
      container.appendChild(lbl);
    });
    updateLayerSettingsVisibility();
    
    const btnAll = document.getElementById('btn-layers-all');
    if (btnAll) {
      btnAll.addEventListener('click', () => {
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
          if (!cb.checked) {
            cb.checked = true;
            cb.dispatchEvent(new Event('change'));
          }
        });
      });
    }
    
    const btnNone = document.getElementById('btn-layers-none');
    if (btnNone) {
      btnNone.addEventListener('click', () => {
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
          if (cb.checked) {
            cb.checked = false;
            cb.dispatchEvent(new Event('change'));
          }
        });
      });
    }
  }
}, 100);

document.getElementById('btn-source-org')?.addEventListener('click', (e) => {
  e.target.setAttribute('aria-pressed', 'true');
  document.getElementById('btn-source-comua')?.setAttribute('aria-pressed', 'false');
  parcelSource = 'kadastrova_karta';
});
document.getElementById('btn-source-comua')?.addEventListener('click', (e) => {
  e.target.setAttribute('aria-pressed', 'true');
  document.getElementById('btn-source-org')?.setAttribute('aria-pressed', 'false');
  parcelSource = 'kadastrova_karta_ua';
});


setMode('boundary');
setElandFormat(elandOutputFormat);
syncAreaNamesValue();
renderAreaChips();

document.getElementById('cadnums-text')?.addEventListener('input', checkStartReady);
document.getElementById('area-name')?.addEventListener('input', checkStartReady);

// Legacy mode switch elements have been removed

document.getElementById('chk-full-parcels')?.addEventListener('change', (e) => {
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
  const fetchMode     = currentMode;
  const territory     = document.getElementById('area-name')?.value.trim() || '';
  const cadnum        = document.getElementById('cadnums-text')?.value.trim() || '';
  const isMultiKmz    = boundaryFiles.length > 1;
  const isSingleKmz   = boundaryFiles.length === 1;
  const isFullParcels = !!document.getElementById('chk-full-parcels')?.checked;
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
  console.log('[checkStartReady]', { fetchMode, territory, cadnum, isMultiKmz, isSingleKmz, isFullParcels, hasOutput, hasBoundary, hasLayersChecked, ready });
document.getElementById('btn-start').disabled = !ready;
}

// ── Busy state: Start↔Stop swap, tab lock, run-cleanup on Stop ──────────
let appBusy = false;
let runBaselineFiles = null; // filenames present in outputFolder before this run started

function setNavLocked(locked) {
  document.querySelectorAll('.nav-link').forEach((btn) => { btn.disabled = locked; });
}

async function cleanupStoppedRun() {
  if (!outputFolder || !runBaselineFiles) return;
  appendLog('🗑 Removing files created by this run…');
  try {
    const res = await window.api.deleteNewOutputFiles(outputFolder, runBaselineFiles);
    if (res && res.success) {
      const deleted = (res.deleted || []).map(p => String(p).replace(/\\/g, '/'));
      for (let i = resultEntries.length - 1; i >= 0; i--) {
        const p = String(resultEntries[i].path || '').replace(/\\/g, '/');
        if (deleted.some(d => p === d || p.startsWith(d + '/'))) resultEntries.splice(i, 1);
      }
      renderResults();
      appendLog(`🗑 Removed ${deleted.length} item(s) — run discarded.`);
    } else {
      appendLog(`⚠ Cleanup failed: ${res?.error || 'unknown error'}`);
    }
  } catch (err) {
    appendLog(`⚠ Cleanup error: ${err.message}`);
  }
}

function setBusy(busy) {
  appBusy = busy;
  const startBtn = document.getElementById('btn-start');
  const stopBtn  = document.getElementById('btn-stop');
  if (busy) {
    if (startBtn) { startBtn.style.display = 'none'; startBtn.disabled = true; }
    if (stopBtn)  {
      stopBtn.style.display = '';
      stopBtn.disabled = false;
      const stopLabel = document.getElementById('stop-btn-label');
      if (stopLabel) stopLabel.textContent = 'Stop';
    }
    setNavLocked(true);
    runBaselineFiles = null;
    if (outputFolder) {
      window.api.listOutputFolder(outputFolder).then((snap) => {
        runBaselineFiles = (snap && snap.success) ? snap.files : [];
      });
    }
    return;
  }
  if (startBtn) startBtn.style.display = '';
  if (stopBtn)  stopBtn.style.display = 'none';
  setNavLocked(false);
  const wasStopped = userStopped;
  userStopped = false;
  checkStartReady();
  if (wasStopped) {
    cleanupStoppedRun().finally(() => { runBaselineFiles = null; resetRunProgress('Idle'); });
  } else {
    runBaselineFiles = null;
  }
}

document.getElementById('btn-stop')?.addEventListener('click', () => {
  const stopBtn = document.getElementById('btn-stop');
  if (!appBusy || (stopBtn && stopBtn.disabled)) return;
  const ok = window.confirm(
    'Stop this run now?\n\nThis ends the process immediately and permanently deletes every file it has produced so far in this run. This cannot be undone.'
  );
  if (!ok) return;
  userStopped = true;
  if (stopBtn) stopBtn.disabled = true; // one shot — can't be pressed again until the next run starts
  const stopLabel = document.getElementById('stop-btn-label');
  if (stopLabel) stopLabel.textContent = 'Stopping…';
  appendLog('\n⛔ Stop requested by user — ending run…');
  if (currentMode === 'eland') {
    window.api.stopElandLookup();
  } else {
    window.api.stopScraping();
  }
});

document.getElementById('btn-start').addEventListener('click', async () => {
  document.getElementById('tab-btn-log')?.click();
  if (!outputFolder) { appendLog('⚠ Please select an output folder.'); return; }

  const fetchMode     = currentMode;
  resetRunProgress('Idle');
  if (fetchMode === 'eland') {
    if (!elandCsvPath) { appendLog('⚠ Please select cadnums CSV.'); return; }
    if (elandBusy) { appendLog('⚠ e.land lookup is already running.'); return; }

    clearLogs();
    setBusy(true);
    elandBusy = true;
    initRunProgress(1, 'e.land lookup');

    const csvName = elandCsvPath.split(/[\\/]/).pop() || 'cadnums.csv';
    const baseName = csvName.replace(/\.csv$/i, '') || 'cadnums';
    const sep = outputFolder.endsWith('/') || outputFolder.endsWith('\\') ? '' : '/';
    const outputPath = `${outputFolder}${sep}${baseName}_eland.xlsx`;
    const result = await window.api.startElandLookup(elandCsvPath, outputPath, { format: elandOutputFormat });
    if (userStopped) {
      appendLog('⛔ Stopped by user.');
    } else if (result && result.success) {
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
    clearLogs();
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
    const cadnumInput = document.getElementById('cadnums-text').value.trim();
    if (!cadnumInput) { appendLog('⚠ Please enter at least one cadastral number.'); return; }

    const cadnums = cadnumInput
      .split(/[\s,]+/)
      .map(s => s.trim())
      .filter(Boolean);

    if (cadnums.length === 0) { appendLog('⚠ Please enter at least one cadastral number.'); return; }

    clearLogs();
    setBusy(true);
    userStopped = false;
    initRunProgress(cadnums.length, 'Cadnum lookup');

    const activeSource = getParcelSource();
    const isUaSource   = activeSource === 'kadastrova_karta_ua';
    const fetchDetailedRegistry = !!document.getElementById('chk-detailed-registry')?.checked;
    appendLog(`🔍 Fetching ${cadnums.length} cadastral number(s) via ${getParcelSourceLabel(activeSource)}...\n`);

    const allResults = [];
    let tempDir   = null;
    let keepTempDir = false;
    try {
      try {
        tempDir = await window.api.cadnumBatchInit(outputFolder);
      } catch (err) {
        appendLog(`❌ Failed to create temp directory: ${err.message}`);
        setBusy(false);
        return;
      }

      for (let i = 0; i < cadnums.length; i++) {
        if (userStopped) { appendLog('\n⛔ Stopped by user.'); break; }
        const cadnum = cadnums[i];
        setRunProgressLabel(`Cadnum ${i + 1}/${cadnums.length}: ${cadnum}`);
        appendLog(`\n[${i + 1}/${cadnums.length}] Processing: ${cadnum}`);
        appendLog(`  🌐 Looking up...`);

        let lookupResult;
        try {
          lookupResult = await window.api.searchCadastralNumber(cadnum, activeSource);
        } catch (searchErr) {
          appendLog(`  ❌ Lookup failed: ${searchErr.message}`);
          allResults.push({ cadnum, parcels: 0, success: false, error: searchErr.message });
          tickRunProgress(false, `Processed ${i + 1}/${cadnums.length}`);
          if (i < cadnums.length - 1) await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        // ── .com.ua path: full geometry returned by API → export directly, no scraping ──
        if (isUaSource) {
          const geometry = lookupResult.meta && lookupResult.meta.geometry;
          if (!geometry) {
            appendLog(`  ⚠ No geometry in API response`);
            allResults.push({ cadnum, parcels: 0, success: false });
            tickRunProgress(false, `Processed ${i + 1}/${cadnums.length}`);
            if (i < cadnums.length - 1) await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          try {
            appendLog(`  ✓ Got geometry from API`);
            const feature = {
              type: 'Feature',
              geometry,
              properties: {
                name: cadnum,
                cadnum: cadnum,
                ...(lookupResult.meta.area != null    ? { area: lookupResult.meta.area }       : {}),
                ...(lookupResult.meta.purpose         ? { purpose: lookupResult.meta.purpose } : {}),
                ...(lookupResult.meta.address         ? { address: lookupResult.meta.address } : {}),
              },
            };
            const namedKmz = `${tempDir}/${String(cadnum).replace(/:/g, '_')}.kmz`;
            const kmzResult = await window.api.createCadnumKmz([feature], namedKmz, 'Kadastr');
            if (kmzResult.success) {
              appendLog(`  ✅ KMZ created`);
              allResults.push({ cadnum, parcels: 1, success: true });
              tickRunProgress(true, `Processed ${i + 1}/${cadnums.length}`);
            } else {
              appendLog(`  ❌ KMZ export failed: ${kmzResult.error}`);
              allResults.push({ cadnum, parcels: 0, success: false, error: kmzResult.error });
              tickRunProgress(false, `Processed ${i + 1}/${cadnums.length}`);
            }
          } catch (err) {
            appendLog(`  ❌ Export error: ${err.message}`);
            allResults.push({ cadnum, parcels: 0, success: false, error: err.message });
            tickRunProgress(false, `Processed ${i + 1}/${cadnums.length}`);
          }

        } else {
          // ── .com path: scrape tiles via Puppeteer, up to 3 retries (same as KMZ mode) ──
          const { lat, lng } = lookupResult;
          appendLog(`  ✓ Coordinates: ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
          const startUrl = `${getParcelSourceBaseUrl(activeSource)}/#15/${lat}/${lng}`;
          appendLog(`  🗺 Scraping parcel tiles (up to 3 attempts)...`);

          let parcelsGot = 0;
          try {
            for (let attempt = 1; attempt <= 3; attempt++) {
              if (userStopped) break;
              const res = await window.api.startScraping(startUrl, tempDir, {
                headless: true,
                boundaryFilter: null,
                parcelSource: activeSource,
                cadnumFilter: cadnum,
              });
              parcelsGot = res.parcels || 0;
              appendLog(`    Attempt ${attempt}: exited (code ${res.code}), parcels: ${parcelsGot}`);
              if (parcelsGot > 0) break;
              if (attempt < 3) appendLog(`    ⚠ No parcels — retrying (${attempt + 1}/3)…`);
            }

            if (parcelsGot > 0) {
              appendLog(`  ✅ Found ${parcelsGot} parcel(s)`);
              allResults.push({ cadnum, parcels: parcelsGot, success: true });
              await window.api.cadnumBatchFinalizeItem(tempDir, cadnum);
              tickRunProgress(true, `Processed ${i + 1}/${cadnums.length}`);
            } else {
              appendLog(`  ⚠ No parcels found after 3 attempts`);
              allResults.push({ cadnum, parcels: 0, success: false });
              tickRunProgress(false, `Processed ${i + 1}/${cadnums.length}`);
            }
          } catch (err) {
            appendLog(`  ❌ Scraping error: ${err.message}`);
            allResults.push({ cadnum, parcels: 0, success: false, error: err.message });
            tickRunProgress(false, `Processed ${i + 1}/${cadnums.length}`);
          }
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

      if (successful > 0 && !userStopped) {
        appendLog(`\n📦 Merging ${successful} KMZ file(s)...`);
        try {
          const finalKmz = `${outputFolder.replace(/[\\\/]+$/, '')}/land_plots.kmz`;
          await window.api.mergeKmzFiles(tempDir, finalKmz);
          appendLog(`✅ Results saved to: ${finalKmz}`);
          addResultEntry(finalKmz, 'KMZ');
          window.api.showInFolder(finalKmz);
        } catch (err) {
          appendLog(`⚠ Merge error: ${err.message}`);
          appendLog(`  Individual files available in: ${tempDir}`);
          keepTempDir = true;
        }

        if (fetchDetailedRegistry) {
          const foundCadnums = allResults.filter(r => r.success).map(r => r.cadnum);
          appendLog(`\n========================================`);
          appendLog(`Fetching Detailed Registry Data for ${foundCadnums.length} parcel(s)...`);
          appendLog(`========================================\n`);
          try {
            const cadCsvPath = `${outputFolder.replace(/[\\\/]+$/, '')}/land_plots_cadnums.csv`;
            const csvWrite = await window.api.writeCadnumsCsv(foundCadnums, cadCsvPath);
            if (!csvWrite || !csvWrite.success) {
              appendLog(`⚠ Could not write cadnums CSV: ${csvWrite?.error || 'unknown error'}`);
            } else {
              addResultEntry(cadCsvPath, 'Cadnums CSV');
              const elandXlsxPath = `${outputFolder.replace(/[\\\/]+$/, '')}/land_plots_eland_partial.xlsx`;
              const elandResult = await window.api.startElandLookup(cadCsvPath, elandXlsxPath, { format: 'xlsx_partial' });
              if (elandResult && elandResult.success !== false) {
                if (elandResult.outputPath) { appendLog(`📊 e.land partial Excel → ${elandResult.outputPath}`); addResultEntry(elandResult.outputPath, 'e.land XLSX'); }
                if (elandResult.docxOutputPath) { appendLog(`📄 e.land Word doc → ${elandResult.docxOutputPath}`); addResultEntry(elandResult.docxOutputPath, 'e.land DOCX'); }
              } else {
                appendLog(`⚠ Detailed registry lookup failed: ${elandResult?.error || 'unknown error'}`);
              }
            }
          } catch (err) {
            appendLog(`⚠ Detailed registry lookup error: ${err.message}`);
          }
        }
      }
    } catch (outerErr) {
      appendLog(`❌ Unexpected error: ${outerErr.message}`);
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

    clearLogs();
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
  const isFullParcels = document.getElementById('chk-full-parcels')?.checked;
  const fetchDetailedRegistry = !!document.getElementById('chk-detailed-registry')?.checked;
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

  clearLogs();
  setBusy(true);
  userStopped = false;

  async function scrapeWithRetries(startUrl, boundaryPath, source, label) {
    appendLog(`━━━ Parcels (${getParcelSourceLabel(source)}): ${label} ━━━`);
    let tilesGot = 0;
    let parcelsGot = 0;
    for (let round = 1; round <= 2 && tilesGot === 0; round++) {
      if (userStopped) break;
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (userStopped) break;
        const res = await window.api.startScraping(startUrl, outputFolder,
          { headless: true, boundaryFilter: boundaryPath, parcelSource: source, fetchDetailedRegistry });
        appendLog(`Scraper exited (code ${res.code})`);
        tilesGot = res.tiles || 0;
        parcelsGot = res.parcels || 0;
        if (parcelsGot > 0) break;
        if (userStopped) break;
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
      if (userStopped) { appendLog('\n⛔ Stopped by user.'); break; }
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

    if (userStopped) { setBusy(false); return; }
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
      if (fetchDetailedRegistry) {
        // NOTE: each boundary in this loop reuses the same fixed filename
        // (land_plots_eland_partial.*), so only the LAST boundary's e.land
        // files survive here — unlike the KMZ/CSV, they aren't copied to a
        // per-boundary temp name and merged. Fine for a single boundary; for
        // several, only the last one's e.land data ends up on disk.
        addResultEntry(`${outputFolder}/land_plots_eland_partial.xlsx`, 'e.land XLSX');
        addResultEntry(`${outputFolder}/land_plots_eland_partial.docx`, 'e.land DOCX');
      }
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
      if (fetchDetailedRegistry) {
        // Written by script.js next to land_plots.kmz — see CONFIG.kmzPath
        // derivation in the FETCH_DETAILED_REGISTRY step.
        addResultEntry(`${outputFolder}/land_plots_eland_partial.xlsx`, 'e.land XLSX');
        addResultEntry(`${outputFolder}/land_plots_eland_partial.docx`, 'e.land DOCX');
      }
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
      if (userStopped) break;
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (userStopped) break;
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
        if (userStopped) break;
        if (attempt < 3) appendLog(`⚠ No parcels yet — retrying (${attempt + 1}/3)…`);
      }
    }

    if (userStopped) { appendLog('\n⛔ Stopped by user.'); setBusy(false); return; }
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
      if (userStopped) { appendLog('\n⛔ Stopped by user.'); break; }
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

    if (userStopped) { setBusy(false); return; }
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
      if (userStopped) { appendLog('\n⛔ Stopped by user.'); break; }
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
    if (userStopped) { setBusy(false); return; }
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
  try {
    const safeFilename = sanitizeFilename(territory || 'land_plots');
    initRunProgress(1, 'Single-area run');
    const finalOutput  = await window.api.resolveOutputPath(outputFolder, safeFilename);
    const kadastrTemp  = outputFolder + '/land_plots.kmz';
    const osmTemp      = outputFolder + '/_osm_temp.kmz';
    const boundaryBbox = boundaryFiles[0] || null;
    const bf           = fetchMode === 'both' ? boundaryBbox : null;
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
        territory,
        layers,
        outputPath: osmTemp,
        format: 'kmz',
        windOptions: layerOptions,
        fallbackBbox: boundaryBbox?.bbox || null,
        customBoundaryPaths: boundaryFiles.length ? boundaryFiles.map(bf => bf.path) : null,
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
  } catch (err) {
    appendLog(`[ERROR] Unexpected error: ${err.message}`);
    console.error(err);
  } finally {
    setBusy(false);
  }
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

document.getElementById('btn-pre-tab-folder')?.addEventListener('click', async () => {
  const result = await window.api.openFolderDialog();
  if (result && !result.canceled && result.filePaths && result.filePaths[0]) {
    preTabOutputFolder = result.filePaths[0];
    document.getElementById('pre-tab-folder-display').textContent = preTabOutputFolder;
    checkResearchReady();
    checkElandReady();
  }
});

document.getElementById('btn-pick-cadnums-csv')?.addEventListener('click', async () => {
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

document.getElementById('eland-output-format')?.addEventListener('change', (e) => {
  setElandFormat(e.target.value);
});

document.getElementById('btn-eland-start')?.addEventListener('click', async () => {
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

document.getElementById('btn-eland-stop')?.addEventListener('click', () => {
  window.api.stopElandLookup();
});

// ── Pre-Research XLSX ───────────────────────────────────────

document.getElementById('research-oblast')?.addEventListener('input', checkResearchReady);

document.getElementById('btn-research-start')?.addEventListener('click', async () => {
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

document.getElementById('btn-research-stop')?.addEventListener('click', () => {
  window.api.stopResearch();
  appendLog('⛔ Stop requested…');
});

document.getElementById('btn-offline-download')?.addEventListener('click', async () => {
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

// ── Initialization ─────────────────────────────────────────
(async function initTerritories() {
  try {
    const territories = await window.api.getTerritories();
    if (territories && territories.length > 0) {
      const datalist = document.getElementById('territories-list');
      if (datalist) {
        const fragment = document.createDocumentFragment();
        territories.forEach(name => {
          const option = document.createElement('option');
          option.value = name;
          fragment.appendChild(option);
        });
        datalist.appendChild(fragment);
      }
    }
  } catch (err) {
    console.error('Failed to load territories for autocomplete', err);
  }
})();
