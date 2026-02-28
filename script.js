const puppeteer = require("puppeteer");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const VectorTile = require("@mapbox/vector-tile").VectorTile;
const Pbf = require("pbf");
const turfUnion = require("@turf/union");
const turfBuffer = require("@turf/buffer");

const SNAP_BUFFER_KM = 0.000005; // ~5mm — closes tile-boundary gaps without distorting shapes

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
  filePath: "oster_plots.json",
  // Pass a custom URL as the first CLI argument, e.g.:
  //   node script.js "https://kadastr.live/#13.95/46.64265/31.4905"
  startUrl: process.argv[2] || "https://kadastr.live/#13.95/46.64265/31.4905",
  maxRetries: 3,
  statsInterval: 5000,
};

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
    const browser = await puppeteer.launch({
      headless: false,
      ignoreHTTPSErrors: true,
      executablePath: chromePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--window-size=700,520",
        "--window-position=200,150",
      ],
    });

    const pages = await browser.pages();
    const page = pages[0];
    await page.setViewport({ width: 700, height: 520 });

    // Show GUI to get URL if not passed as a valid CLI argument
    const cliArg = process.argv[2];
    const startUrl = (cliArg && cliArg.startsWith("http")) ? cliArg : await showGui(page);

    // Expand to full size for scraping
    await page.setViewport({ width: 1920, height: 1080 });

    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes(".pbf") && url.includes("kadastr")) {
        await processTileResponse(response, url);
      }
    });

    setupGracefulShutdown(browser);

    const statsInterval = setInterval(reportStats, CONFIG.statsInterval);

    console.log("--- ПЕРЕХВАТ ЗАПУЩЕН. ДВИГАЙ КАРТУ ---");
    await page.goto(startUrl);
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

function mergeAndSerializeFeatures() {
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
        // Buffer each fragment slightly outward to close sub-mm gaps at tile
        // boundaries caused by floating-point differences in coordinate conversion,
        // then union, then shrink back to original size.
        const buffered = fragments.map(f => {
          try { return bufferFn(f, SNAP_BUFFER_KM, { units: "kilometers" }); }
          catch (_) { return f; }
        });

        // @turf/union v7 takes a FeatureCollection
        const fc = { type: "FeatureCollection", features: buffered.filter(Boolean) };
        let unioned;
        try {
          unioned = unionFn(fc);
        } catch (_) {
          unioned = buffered[0];
        }

        // Shrink back
        try {
          unioned = bufferFn(unioned, -SNAP_BUFFER_KM, { units: "kilometers" }) || unioned;
        } catch (_) {}

        finalFeature = { ...unioned, properties };
        merged++;
      }
      results.push(JSON.stringify(finalFeature));
    } catch (err) {
      console.warn(`Failed to merge parcel ${cadnum}:`, err.message);
    }
  }

  console.log(`Merged: ${merged} parcels from multiple fragments, ${single} single-tile parcels`);
  return results;
}

function setupGracefulShutdown(browser) {
  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}, writing output...`);

    try {
      const features = mergeAndSerializeFeatures();
      const content = '{"type":"FeatureCollection","features":[\n' +
        features.join(",\n") +
        "\n]}";
      await fs.writeFile(CONFIG.filePath, content);
      state.fileClosed = true;

      const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
      console.log(`\nFinal stats:`);
      console.log(`  Tiles processed: ${state.processedTiles.size}`);
      console.log(`  Parcels written: ${features.length}`);
      console.log(`  Errors: ${state.errorCount}`);
      console.log(`  Time: ${elapsed}s`);
      console.log(`File ${CONFIG.filePath} saved. Open in Mapshaper!`);
    } catch (error) {
      console.error("Error during shutdown:", error.message);
    } finally {
      await browser.close();
      process.exit(0);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", () => {
    if (!state.fileClosed) {
      try {
        const features = mergeAndSerializeFeatures();
        const content = '{"type":"FeatureCollection","features":[\n' +
          features.join(",\n") +
          "\n]}";
        fsSync.writeFileSync(CONFIG.filePath, content);
      } catch (_) {}
    }
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
    await page.goto(guiUrl);
  });
}
