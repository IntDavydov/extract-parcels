const puppeteer = require("puppeteer");
const fsSync = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const VectorTile = require("@mapbox/vector-tile").VectorTile;
const Pbf = require("pbf");
const turfUnion = require("@turf/union");
const turfBuffer = require("@turf/buffer");

const SNAP_BUFFER_KM = 0.000005; // first-pass seam snap (~5mm)
const SNAP_BUFFER_STEPS_KM = [SNAP_BUFFER_KM, 0.0002, 0.001, 0.002]; // up to 2m for stubborn tile seams

function exportCadnumsToExcel(features, xlsxPath) {
  const fs = require('fs');
  // Write CSV with BOM so Excel opens it correctly with UTF-8
  const csvPath = xlsxPath.replace(/\.xlsx$/i, '.csv');
  const rows = ['#,cadnum'];
  let idx = 1;
  for (const f of features) {
    const cadnum = f.properties?.cadnum || '';
    if (cadnum) rows.push(`${idx++},${cadnum}`);
  }
  fs.writeFileSync(csvPath, '\uFEFF' + rows.join('\r\n'), 'utf8');
  return csvPath;
}


// ── KMZ/KML boundary filter ────────────────────────────────

// Extract all polygon rings from KML text as arrays of [lng, lat] pairs
function parseKmlRings(kml) {
  const rings = [];
  const re = /<coordinates>([\s\S]*?)<\/coordinates>/g;
  let m;
  while ((m = re.exec(kml)) !== null) {
    const coords = m[1].trim().split(/\s+/)
      .map(c => { const p = c.split(','); return [parseFloat(p[0]), parseFloat(p[1])]; })
      .filter(c => !isNaN(c[0]) && !isNaN(c[1]));
    if (coords.length >= 3) rings.push(coords);
  }
  return rings;
}

// Returns { rings, features } — rings for spatial filter, features for KMZ layer
async function loadBoundary(filePath) {
  if (!filePath) return null;
  let kmlText;
  try {
    if (filePath.toLowerCase().endsWith('.kmz')) {
      const JSZip = require('jszip');
      const buf = fsSync.readFileSync(filePath);
      const zip = await JSZip.loadAsync(buf);
      const kmlName = Object.keys(zip.files).find(n => n.toLowerCase().endsWith('.kml'));
      if (!kmlName) throw new Error('No .kml file found inside KMZ');
      kmlText = await zip.files[kmlName].async('text');
    } else {
      kmlText = fsSync.readFileSync(filePath, 'utf8');
    }
  } catch (e) {
    console.error(`⚠ Could not load boundary file: ${e.message}`);
    return null;
  }
  const rings = parseKmlRings(kmlText);
  const features = rings.map((ring, i) => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { name: `Boundary ${i + 1}` },
  }));
  console.log(`🗂 Boundary loaded: ${rings.length} polygon(s) from ${path.basename(filePath)}`);
  return { rings, features };
}

// Ray-casting point-in-polygon for a single ring [[lng,lat],...]
function pointInRing(point, ring) {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

// Returns true if the feature's centroid falls inside any boundary ring
function featureInBoundary(feature, rings) {
  // Collect all coordinate rings from the feature geometry
  const geom = feature.geometry;
  const outerRings = geom.type === 'Polygon'
    ? [geom.coordinates[0]]
    : geom.type === 'MultiPolygon'
      ? geom.coordinates.map(p => p[0])
      : [];
  for (const fRing of outerRings) {
    // Compute centroid of this ring
    const centroid = fRing.reduce((acc, c) => [acc[0] + c[0], acc[1] + c[1]], [0, 0])
      .map(v => v / fRing.length);
    if (rings.some(r => pointInRing(centroid, r))) return true;
  }
  return false;
}

// Resolve Chrome executable path for the current platform
function getChromePath() {
  // Prefer the path resolved and passed by main.js
  if (process.env.CHROME_PATH && fsSync.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      (process.env.LOCALAPPDATA || '') + "\\Google\\Chrome\\Application\\chrome.exe",
      (process.env.LOCALAPPDATA || '') + "\\Chromium\\Application\\chrome.exe",
    ];
    for (const p of candidates) {
      if (p && fsSync.existsSync(p)) return p;
    }
  }

  // Fall back to puppeteer's bundled Chrome (any platform)
  try {
    const execPath = puppeteer.executablePath();
    if (fsSync.existsSync(execPath)) return execPath;
  } catch (_) {}

  return undefined;
}

const PARCEL_SOURCES = {
  kadastrova_karta: {
    baseUrl: "https://kadastrova-karta.com",
    tileHostHint: "kadastrova-karta.com",
  },
};

const ACTIVE_SOURCE_KEY = process.env.PARCEL_SOURCE && PARCEL_SOURCES[process.env.PARCEL_SOURCE]
  ? process.env.PARCEL_SOURCE
  : "kadastrova_karta";
const ACTIVE_SOURCE = PARCEL_SOURCES[ACTIVE_SOURCE_KEY];

// Configuration
const CONFIG = {
  kmzPath: process.env.OUTPUT_PATH
    ? path.join(process.env.OUTPUT_PATH, "land_plots.kmz")
    : path.join(process.cwd(), "land_plots.kmz"),
  startUrl: process.argv[2] || `${ACTIVE_SOURCE.baseUrl}/#13.95/46.64265/31.4905`,
  headless: process.env.HEADLESS === "1",
  boundaryFilter: process.env.BOUNDARY_FILTER || null,
  cadnumFilter: process.env.CADNUM_FILTER || null,
  maxRetries: 3,
  statsInterval: 5000,
};

// Wait until no new tiles arrive for `quietMs` milliseconds in a row
async function waitForTilesToSettle(quietMs = 4000) {
  let prevSize = state.processedTiles.size;
  return new Promise((resolve) => {
    const check = () => {
      const cur = state.processedTiles.size;
      if (cur === prevSize) {
        resolve();
      } else {
        prevSize = cur;
        setTimeout(check, quietMs);
      }
    };
    setTimeout(check, quietMs);
  });
}

// Wait until at least one NEW tile arrives beyond `prevCount`, or timeout
async function waitForNewTiles(prevCount, maxWaitMs = 8000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      if (state.processedTiles.size > prevCount || Date.now() - start >= maxWaitMs) {
        resolve();
      } else {
        setTimeout(poll, 300);
      }
    };
    setTimeout(poll, 300);
  });
}

// Wait for the first tile to arrive (or timeout), then settle
async function waitForFirstTile(maxWaitMs = 30000) {
  if (state.processedTiles.size > 0) return;
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      if (state.processedTiles.size > 0 || Date.now() - start >= maxWaitMs) {
        resolve();
      } else {
        setTimeout(poll, 500);
      }
    };
    setTimeout(poll, 500);
  });
}

// Global map: cadnum -> { properties, fragments: [GeoJSON feature, ...] }
// Collecting all tile fragments so we can union them at the end
const parcelFragments = new Map();

const state = {
  processedTiles: new Set(),
  totalFeatures: 0,
  errorCount: 0,
  startTime: Date.now(),
  fileClosed: false,
};

function lonLatToTile(lon, lat, z) {
  const n = Math.pow(2, z);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

async function processTileBuffer(buffer, tileKey, x, y, z) {
  if (state.processedTiles.has(tileKey)) return;
  state.processedTiles.add(tileKey);
  const PbfConstructor = Pbf.default || Pbf;
  const pbf = new PbfConstructor(buffer);
  const tile = new VectorTile(pbf);

  let newFragments = 0;
  let fallbackIdSeq = 0;
  for (let layerName in tile.layers) {
    const layer = tile.layers[layerName];
    for (let i = 0; i < layer.length; i++) {
      try {
        const feature = layer.feature(i).toGeoJSON(x, y, z);
        const props = feature.properties || {};
        const cadnum = String(
          props.cadnum ||
          props.cad_num ||
          props.cadastral_number ||
          props.cadastre_number ||
          ''
        ).trim();
        const key = cadnum || `no-cadnum:${tileKey}:${fallbackIdSeq++}`;
        if (!parcelFragments.has(key)) {
          parcelFragments.set(key, { properties: feature.properties || {}, fragments: [] });
        }
        parcelFragments.get(key).fragments.push(feature);
        newFragments++;
      } catch (featureError) {
        console.warn(`Feature error in ${tileKey}:`, featureError.message);
      }
    }
  }

  if (newFragments > 0) {
    state.totalFeatures = parcelFragments.size;
    console.log(`Tile ${tileKey}: +${newFragments} fragments, total parcels: ${parcelFragments.size}`);
  }
}

async function fetchKadastrovaTilesDirect(onProgress) {
  if (ACTIVE_SOURCE_KEY !== "kadastrova_karta") return false;
  const boundary = await loadBoundary(CONFIG.boundaryFilter);
  
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  
  if (boundary && boundary.rings.length) {
    // Use boundary if provided
    for (const ring of boundary.rings) {
      for (const [lon, lat] of ring) {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        west = Math.min(west, lon); east = Math.max(east, lon);
        south = Math.min(south, lat); north = Math.max(north, lat);
      }
    }
  } else if (CONFIG.cadnumFilter && CONFIG.startUrl.includes('#')) {
    // No boundary but cadnum filter: derive bbox from URL coordinates
    const hashPart = CONFIG.startUrl.split('#')[1];
    const match = hashPart.match(/(\d+(?:\.\d+)?)\/([\d.-]+)\/([\d.-]+)/);
    if (match) {
      const lat = parseFloat(match[2]);
      const lng = parseFloat(match[3]);
      // Create ~1km bounding box around the point for single parcel lookup
      const delta = 0.005; // ~0.5km at mid-latitudes
      west = lng - delta; east = lng + delta;
      south = lat - delta; north = lat + delta;
      onProgress(`  → Cadnum mode: using ${delta*2*100}km bbox around ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
    }
  }
  
  if (!Number.isFinite(west)) return false;
  const zooms = [16, 15, 14];
  const endpointTemplates = [
    `${ACTIVE_SOURCE.baseUrl}/tiles/maps/kadastr/land_polygons/{z}/{x}/{y}.pbf`,
    `${ACTIVE_SOURCE.baseUrl}/tiles/maps/kadastr/{z}/{x}/{y}.pbf`,
  ];
  let anyOk = 0;
  let anyNonEmpty = 0;
  let anyParsedLayers = 0;

  for (const z of zooms) {
    const t1 = lonLatToTile(west, north, z);
    const t2 = lonLatToTile(east, south, z);
    const minX = Math.min(t1.x, t2.x), maxX = Math.max(t1.x, t2.x);
    const minY = Math.min(t1.y, t2.y), maxY = Math.max(t1.y, t2.y);
    const allTiles = [];
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) allTiles.push({ x, y });
    onProgress(`  → Direct tile mode: trying z${z}, ${allTiles.length} tile(s)`);

    const beforeParcels = parcelFragments.size;
    for (const tpl of endpointTemplates) {
      let okCount = 0;
      let nonEmptyCount = 0;
      let parsedLayersCount = 0;
      for (const { x, y } of allTiles) {
        const tileKey = `${z}/${x}/${y}`;
        const url = tpl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
        try {
          const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (!res.ok) continue;
          okCount++;
          const arr = await res.arrayBuffer();
          if (arr.byteLength > 0) nonEmptyCount++;
          if (arr.byteLength > 0) {
            try {
              const pbf = new (Pbf.default || Pbf)(Buffer.from(arr));
              const vt = new VectorTile(pbf);
              if (Object.keys(vt.layers || {}).length > 0) parsedLayersCount++;
            } catch (_) {}
          }
          await processTileBuffer(Buffer.from(arr), tileKey, x, y, z);
        } catch (_) {
          // keep going
        }
      }
      anyOk += okCount;
      anyNonEmpty += nonEmptyCount;
      anyParsedLayers += parsedLayersCount;
      onProgress(`    · ${tpl.includes('land_polygons') ? 'land_polygons' : 'kadastr'} endpoint OK tiles: ${okCount}, non-empty: ${nonEmptyCount}, with layers: ${parsedLayersCount}`);
      if (parcelFragments.size > beforeParcels) break;
    }
    if (parcelFragments.size > beforeParcels) {
      onProgress(`  ✅ Direct mode captured ${parcelFragments.size - beforeParcels} parcel feature(s) at z${z}`);
      return true;
    }
  }
  if (anyOk > 0 && anyNonEmpty === 0) {
    onProgress(`  ⚠ kadastrova-karta.com returned ${anyOk} tile responses but all were empty (0 bytes) for this area.`);
    onProgress(`  ⚠ This usually means no cadastral vector coverage at requested tiles (source-side no-data), not a parser failure.`);
  } else if (anyNonEmpty > 0 && anyParsedLayers === 0) {
    onProgress(`  ⚠ Non-empty tiles received (${anyNonEmpty}) but no vector layers decoded.`);
  }
  onProgress(`  ⚠ Direct tile mode found no parcel features in z14-z16 range`);
  return false;
}

(async () => {
  try {
    const chromePath = getChromePath();
    const isHeadless = CONFIG.headless;

    const browser = await puppeteer.launch({
      headless: isHeadless,
      ignoreHTTPSErrors: true,
      executablePath: chromePath,
      defaultViewport: isHeadless ? { width: 1600, height: 900 } : null,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        ...(isHeadless ? [] : ["--start-maximized"]),
      ],
    });

    const pages = await browser.pages();
    const page = pages[0];
    page.setDefaultNavigationTimeout(60000);

    // In headless mode the URL must be provided; otherwise show GUI
    const cliArg = process.argv[2];
    const startUrl = (cliArg && cliArg.startsWith("http")) ? cliArg : await showGui(page);

    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes(".pbf") && url.includes(ACTIVE_SOURCE.tileHostHint)) {
        await processTileResponse(response, url);
      }
    });

    setupGracefulShutdown(browser);

    const statsInterval = setInterval(reportStats, CONFIG.statsInterval);

    if (isHeadless) {
      // ── Headless mode: load URL, wait for visible tiles, auto-save ──
      const gridCells = process.env.GRID_CELLS ? JSON.parse(process.env.GRID_CELLS) : null;

      if (gridCells && gridCells.length > 0) {
        // ── Full-area sweep: one browser session, pan via hash changes ──
        const { lat: lat0, lng: lng0 } = gridCells[0];
        const firstUrl = `${ACTIVE_SOURCE.baseUrl}/#14/${lat0}/${lng0}`;
        console.log(`🌍 Full-area sweep: ${gridCells.length} cells`);
        await page.goto(firstUrl, { timeout: 60000, waitUntil: 'domcontentloaded' });
        console.log(`  [1/${gridCells.length}] Waiting for first tile…`);
        await waitForFirstTile(30000);
        if (state.processedTiles.size === 0) console.log('  ⚠ No tiles from first cell.');
        await waitForTilesToSettle(3000);
        console.log(`  [1/${gridCells.length}] Tiles: ${state.processedTiles.size}`);

        for (let i = 1; i < gridCells.length; i++) {
          const { lat, lng } = gridCells[i];
          const prevCount = state.processedTiles.size;
          // Pan the map by updating the URL hash (no full page reload)
          await page.evaluate((lt, ln) => { window.location.hash = `#14/${lt}/${ln}`; }, lat, lng);
          await waitForNewTiles(prevCount, 8000);
          await waitForTilesToSettle(2500);
          console.log(`  [${i + 1}/${gridCells.length}] +${state.processedTiles.size - prevCount} tiles (total: ${state.processedTiles.size}, parcels: ${parcelFragments.size})`);
        }

        console.log(`  → All cells done. ${parcelFragments.size} parcels captured.`);
      } else {
        // ── Single-URL headless mode ──
        console.log(`🤖 Headless mode — loading ${startUrl}`);
        await page.goto(startUrl, { timeout: 60000, waitUntil: "domcontentloaded" });
        console.log("  → Page loaded, waiting for tiles to start…");
        await waitForFirstTile(30000);
        if (state.processedTiles.size === 0) console.log("  ⚠ No tiles arrived in 30s — saving empty result.");
        console.log("  → Tiles arriving, waiting to settle…");
        await waitForTilesToSettle(4000);
        if (ACTIVE_SOURCE_KEY === "kadastrova_karta" && parcelFragments.size === 0) {
          console.log("  ⚠ Base tiles loaded but no parcel features captured — switching to direct z14 tile fetch…");
          await fetchKadastrovaTilesDirect((m) => console.log(m));
        }
        console.log(`  → Tiles settled. ${parcelFragments.size} parcels captured.`);
      }

      clearInterval(statsInterval);
      process.emit("SIGINT");
    } else {
      // ── Interactive mode ─────────────────────────────────
      console.log("--- ПЕРЕХВАТ ЗАПУЩЕН. ДВИГАЙ КАРТУ. Автозбереження через 10с після останнього тайлу. ---");
      await page.goto(startUrl, { timeout: 60000, waitUntil: "domcontentloaded" });
      // Auto-stop after 10 s of no new tiles (resets every time a new tile arrives)
      waitForTilesToSettle(10000).then(() => {
        if (!state.fileClosed) {
          console.log("\n⏱ No new tiles for 10s — auto-saving…");
          clearInterval(statsInterval);
          process.emit("SIGINT");
        }
      });
    }
  } catch (error) {
    console.error("Critical error during startup:", error.message);
    process.exit(1);
  }
})();

async function processTileResponse(response, url) {
  const match = url.match(/\/(\d+)\/(\d+)\/(\d+)\.pbf/);
  if (!match) return;

  const z = parseInt(match[1]);
  const x = parseInt(match[2]);
  const y = parseInt(match[3]);
  const tileKey = `${z}/${x}/${y}`;

  if (state.processedTiles.has(tileKey)) return;
  state.processedTiles.add(tileKey);

  try {
    const buffer = await response.buffer();
    await processTileBuffer(buffer, tileKey, x, y, z);
  } catch (error) {
    state.errorCount++;
    console.error(`Error processing tile ${tileKey}:`, error.message);
  }
}

function mergeFeatures() {
  const unionFn = turfUnion.default || turfUnion;
  const bufferFn = turfBuffer.default || turfBuffer;
  const toPolygonCoords = (feature) => {
    const g = feature?.geometry;
    if (!g) return [];
    if (g.type === 'Polygon') return [g.coordinates];
    if (g.type === 'MultiPolygon') return g.coordinates;
    return [];
  };
  const combineFragments = (fragments, properties) => {
    const coords = [];
    for (const f of fragments) coords.push(...toPolygonCoords(f));
    if (!coords.length) return null;
    return {
      type: 'Feature',
      geometry: coords.length === 1
        ? { type: 'Polygon', coordinates: coords[0] }
        : { type: 'MultiPolygon', coordinates: coords },
      properties,
    };
  };
  const cleanFeature = (feature) => {
    try { return bufferFn(feature, 0, { units: 'kilometers' }) || feature; }
    catch (_) { return feature; }
  };
  const unionCollection = (features) => {
    if (!features.length) return null;
    if (features.length === 1) return features[0];
    try {
      return unionFn({ type: 'FeatureCollection', features });
    } catch (_) {
      return null;
    }
  };
  const dissolvePairwise = (features) => {
    if (!features.length) return null;
    let acc = features[0];
    for (let i = 1; i < features.length; i++) {
      const next = features[i];
      const merged = unionCollection([acc, next]);
      if (!merged || !merged.geometry) return null;
      acc = merged;
    }
    return acc;
  };
  const dissolveWithSnap = (fragments, snapKm, properties) => {
    const expanded = fragments.map((f) => {
      try { return bufferFn(cleanFeature(f), snapKm, { units: 'kilometers' }); }
      catch (_) { return cleanFeature(f); }
    }).filter(Boolean);
    if (!expanded.length) return null;
    const unioned = unionCollection(expanded) || dissolvePairwise(expanded);
    if (!unioned || !unioned.geometry) return null;
    let shrunk = unioned;
    try { shrunk = bufferFn(unioned, -snapKm, { units: 'kilometers' }) || unioned; } catch (_) {}
    if (!shrunk || !shrunk.geometry) return null;
    return { ...shrunk, properties };
  };
  const results = [];
  let merged = 0;
  let single = 0;
  let fallbackCombined = 0;
  let snappedMerges = 0;

  for (const [cadnum, { properties, fragments }] of parcelFragments) {
    try {
      let finalFeature;
      if (fragments.length === 1) {
        finalFeature = fragments[0];
        single++;
      } else {
        let unioned = null;
        for (const snapKm of SNAP_BUFFER_STEPS_KM) {
          unioned = dissolveWithSnap(fragments, snapKm, properties);
          if (unioned && unioned.geometry) {
            if (snapKm > SNAP_BUFFER_KM) snappedMerges++;
            break;
          }
        }
        if (!unioned || !unioned.geometry) {
          unioned = combineFragments(fragments, properties);
          fallbackCombined++;
        }
        finalFeature = unioned;
        merged++;
      }
      // Set cadnum as the name property for the feature
      if (finalFeature && cadnum) {
        if (!finalFeature.properties) finalFeature.properties = {};
        finalFeature.properties.name = cadnum;
      }
      results.push(finalFeature);
    } catch (err) {
      console.warn(`Failed to merge parcel ${cadnum}:`, err.message);
    }
  }

  console.log(`Merged: ${merged} parcels from multiple fragments, ${single} single-tile parcels, ${snappedMerges} hard-snap merges, ${fallbackCombined} fallback-combined`);
  return results;
}

function setupGracefulShutdown(browser) {
  const shutdown = async (signal) => {
    if (state.fileClosed) return;
    state.fileClosed = true;
    console.log(`\nReceived ${signal}, building KMZ…`);

    try {
      let features = mergeFeatures();

      // Apply boundary filter if provided
      const boundary = await loadBoundary(CONFIG.boundaryFilter);
      if (boundary && boundary.rings.length > 0) {
        const before = features.length;
        features = features.filter(f => featureInBoundary(f, boundary.rings));
        console.log(`🔍 Boundary filter: ${features.length} of ${before} parcels kept`);
      }

      // Apply cadastral number filter if provided
      if (CONFIG.cadnumFilter) {
        const before = features.length;
        features = features.filter(f => {
          const cadnum = String(
            f.properties?.cadnum ||
            f.properties?.cad_num ||
            f.properties?.cadastral_number ||
            f.properties?.cadastre_number ||
            ''
          ).trim();
          return cadnum === CONFIG.cadnumFilter;
        });
        console.log(`🔍 Cadnum filter (${CONFIG.cadnumFilter}): ${features.length} of ${before} parcels kept`);
      }

      const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
      console.log(`\nFinal stats:`);
      console.log(`  Tiles processed: ${state.processedTiles.size}`);
      console.log(`  Parcels: ${features.length}`);
      console.log(`  Errors: ${state.errorCount}`);
      console.log(`  Time: ${elapsed}s`);

      if (features.length > 0) {
        console.log(`📦 Building KMZ → ${CONFIG.kmzPath}`);
        const { exportKMZ } = require(path.join(__dirname, 'src', 'kmz.js'));
        // Name the parcel folder after the kadastr URL coords (e.g. "14/50.74/31.09")
        const urlHash = CONFIG.startUrl.includes('#') ? CONFIG.startUrl.split('#')[1] : null;
        const parcelFolderName = urlHash || 'Land Parcels';
        const layers = {};
        if (boundary && boundary.features.length > 0) layers['Parcel Boundaries'] = boundary.features;
        layers[parcelFolderName] = features;
        await exportKMZ(layers, CONFIG.kmzPath, (msg) => console.log(msg), [], 'Kadastr');
        console.log(`💾 Saved → ${CONFIG.kmzPath}`);

        // Export cadastral numbers to CSV (Excel-compatible)
        try {
          const xlsxPath = CONFIG.kmzPath.replace(/\.kmz$/i, '_cadnums.xlsx');
          const savedPath = exportCadnumsToExcel(features, xlsxPath);
          console.log(`📊 Cadnums → ${savedPath}`);
        } catch (err) {
          console.warn(`⚠ Cadnum export failed: ${err.message}`);
        }
      } else {
        console.log('⚠ No parcels to export.');
      }
    } catch (error) {
      console.error("Error during shutdown:", error.message);
    } finally {
      await browser.close();
      process.exit(0);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Windows-safe graceful stop: parent writes "SHUTDOWN\n" to our stdin
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data) => {
    if (data.trim() === "SHUTDOWN") shutdown("STDIN");
  });
}

function reportStats() {
  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  console.log(`Stats: ${state.processedTiles.size} tiles, ${parcelFragments.size} parcels, ${state.errorCount} errors (${minutes}m ${seconds}s)`);
}

async function showGui(page) {
  const guiUrl = pathToFileURL(path.join(__dirname, "gui.html")).href;
  return new Promise(async (resolve) => {
    await page.exposeFunction("__startScraping", (url) => resolve(url));
    await page.goto(guiUrl, { timeout: 60000 });
  });
}

// TODO make cuncurent multiple processes of generating parcels and areas, add icons in google earth default pack of icons
