const puppeteer = require("puppeteer");
const fsSync = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const VectorTile = require("@mapbox/vector-tile").VectorTile;
const Pbf = require("pbf");
const turfUnion = require("@turf/union");
const turfBuffer = require("@turf/buffer");

const SNAP_BUFFER_KM = 0.000005; // ~5mm — closes tile-boundary gaps without distorting shapes

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
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
    ];
    for (const p of candidates) {
      if (fsSync.existsSync(p)) return p;
    }
  }
  return undefined; // let puppeteer use bundled Chromium on other platforms
}

// Configuration
const CONFIG = {
  kmzPath: process.env.OUTPUT_PATH
    ? path.join(process.env.OUTPUT_PATH, "land_plots.kmz")
    : path.join(process.cwd(), "land_plots.kmz"),
  startUrl: process.argv[2] || "https://kadastr.live/#13.95/46.64265/31.4905",
  headless: process.env.HEADLESS === "1",
  boundaryFilter: process.env.BOUNDARY_FILTER || null,
  proxy: process.env.KADASTR_PROXY || null,
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
        ...(CONFIG.proxy ? [`--proxy-server=${CONFIG.proxy}`] : []),
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
      if (url.includes(".pbf") && url.includes("kadastr")) {
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
        const firstUrl = `https://kadastr.live/#14/${lat0}/${lng0}`;
        console.log(`🌍 Full-area sweep: ${gridCells.length} cells`);
        if (CONFIG.proxy) console.log(`🔒 Using proxy: ${CONFIG.proxy}`);
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
        if (CONFIG.proxy) console.log(`🔒 Using proxy: ${CONFIG.proxy}`);
        await page.goto(startUrl, { timeout: 60000, waitUntil: "domcontentloaded" });
        console.log("  → Page loaded, waiting for tiles to start…");
        await waitForFirstTile(30000);
        if (state.processedTiles.size === 0) console.log("  ⚠ No tiles arrived in 30s — saving empty result.");
        console.log("  → Tiles arriving, waiting to settle…");
        await waitForTilesToSettle(CONFIG.proxy ? 8000 : 4000);
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
    const PbfConstructor = Pbf.default || Pbf;
    const pbf = new PbfConstructor(buffer);
    const tile = new VectorTile(pbf);

    let newFragments = 0;

    for (let layerName in tile.layers) {
      const layer = tile.layers[layerName];
      for (let i = 0; i < layer.length; i++) {
        try {
          const feature = layer.feature(i).toGeoJSON(x, y, z);
          if (!feature.properties?.cadnum) continue;
          const cadnum = feature.properties.cadnum;
          if (!parcelFragments.has(cadnum)) {
            parcelFragments.set(cadnum, { properties: feature.properties, fragments: [] });
          }
          parcelFragments.get(cadnum).fragments.push(feature);
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
  } catch (error) {
    state.errorCount++;
    console.error(`Error processing tile ${tileKey}:`, error.message);
  }
}

function mergeFeatures() {
  const unionFn = turfUnion.default || turfUnion;
  const bufferFn = turfBuffer.default || turfBuffer;
  const results = [];
  let merged = 0;
  let single = 0;

  for (const [cadnum, { properties, fragments }] of parcelFragments) {
    try {
      let finalFeature;
      if (fragments.length === 1) {
        finalFeature = fragments[0];
        single++;
      } else {
        const buffered = fragments.map(f => {
          try { return bufferFn(f, SNAP_BUFFER_KM, { units: "kilometers" }); }
          catch (_) { return f; }
        });
        const fc = { type: "FeatureCollection", features: buffered.filter(Boolean) };
        let unioned;
        try { unioned = unionFn(fc); } catch (_) { unioned = buffered[0]; }
        try { unioned = bufferFn(unioned, -SNAP_BUFFER_KM, { units: "kilometers" }) || unioned; } catch (_) {}
        finalFeature = { ...unioned, properties };
        merged++;
      }
      results.push(finalFeature);
    } catch (err) {
      console.warn(`Failed to merge parcel ${cadnum}:`, err.message);
    }
  }

  console.log(`Merged: ${merged} parcels from multiple fragments, ${single} single-tile parcels`);
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
        await exportKMZ(layers, CONFIG.kmzPath, (msg) => console.log(msg));
        console.log(`💾 Saved → ${CONFIG.kmzPath}`);
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
