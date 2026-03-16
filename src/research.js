'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getBbox, fetchNatureReservesFromPZF, fetchEmeraldFromEEA, fetchWindHeatmap, httpGet, httpPost, polygonAreaM2 } = require('./osm');

// ── Overpass endpoint ─────────────────────────────────────
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_ALT = 'https://overpass.kumi.systems/api/interpreter';
const OVERPASS_ALT_2 = 'https://maps.mail.ru/osm/tools/overpass/api/interpreter';
const OVERPASS_TIMEOUT_FAST_MS = 35000;
const OVERPASS_TIMEOUT_NORMAL_MS = 55000;
const OVERPASS_FOREST_TOTAL_TIMEOUT_MS = 25000;
const TASK_TIMEOUTS_MS = {
  osm: 90000,
  wind: 45000,
  emerald: 90000,
  pzf: 90000,
  page: 60000,
};
const LOCAL_WIND_TIFF_CANDIDATES = [
  'test-files/UKR_wind-speed_150m.tif',
  'test-files/ukr_wind_speed_150m.tif',
  'test-files/wind-speed-150m-ukraine.tif',
  'test-files/gwa_wind_150m.tif',
  'UKR_wind-speed_150m.tif',
  'ukr_wind_speed_150m.tif',
  'wind-speed-150m-ukraine.tif',
  'gwa_wind_150m.tif',
];
let _localWindDatasetPromise = null;
const LOCAL_INFRA_CACHE_CANDIDATES = [
  'test-files/ukraine-infra-cache.json',
  'test-files/infra-cache.json',
  'test-files/ukraine-infra-cache.geojson',
  'ukraine-infra-cache.json',
  'infra-cache.json',
  'ukraine-infra-cache.geojson',
];
let _localInfraCachePromise = null;
const GENERATED_INFRA_CACHE_PATH = path.join(os.homedir(), '.land-management-cache', 'ukraine-infra-cache.json');
const LOCAL_PBF_CANDIDATES = [
  'test-files/ukraine-latest.osm.pbf',
  'test-files/ukraine.osm.pbf',
  'test-files/ukraine-latest.pbf',
  'ukraine-latest.osm.pbf',
  'ukraine.osm.pbf',
  'ukraine-latest.pbf',
];
const LOCAL_WORLDCOVER_TIFF_CANDIDATES = [
  'extra/ESA_WORLDCOVER_10M_2021_V200/MAP',
  'test-files/ESA_WorldCover_2021_Ukraine.tif',
  'test-files/ESA_WorldCover_Ukraine.tif',
  'test-files/worldcover-ukraine.tif',
  'test-files/worldcover_ukraine.tif',
  'ESA_WorldCover_2021_Ukraine.tif',
  'ESA_WorldCover_Ukraine.tif',
  'worldcover-ukraine.tif',
  'worldcover_ukraine.tif',
];
const TREE_COVER_CLASSES = new Set([10]);
let _localWorldCoverDatasetPromise = null;
const LOCAL_GEOLOGY_CANDIDATES = [
  'test-files/geology-karst.geojson',
  'test-files/geology.geojson',
  'test-files/karst.geojson',
  'geology-karst.geojson',
  'geology.geojson',
  'karst.geojson',
];
let _localGeologyDatasetPromise = null;

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function getGeometryCentroid(geometry, fallbackBbox = null) {
  if (!geometry) {
    if (!fallbackBbox) return null;
    return [(fallbackBbox.west + fallbackBbox.east) / 2, (fallbackBbox.south + fallbackBbox.north) / 2];
  }
  const rings = [];
  if (geometry.type === 'Polygon') {
    if (Array.isArray(geometry.coordinates[0])) rings.push(geometry.coordinates[0]);
  } else if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates) {
      if (Array.isArray(poly[0])) rings.push(poly[0]);
    }
  }
  let sumLon = 0;
  let sumLat = 0;
  let count = 0;
  for (const ring of rings) {
    for (const p of ring) {
      if (!Array.isArray(p) || p.length < 2) continue;
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      sumLon += p[0];
      sumLat += p[1];
      count += 1;
    }
  }
  if (count > 0) return [sumLon / count, sumLat / count];
  if (!fallbackBbox) return null;
  return [(fallbackBbox.west + fallbackBbox.east) / 2, (fallbackBbox.south + fallbackBbox.north) / 2];
}

function pointInRing(point, ring) {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInGeometry(point, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') {
    const [outer = [], ...holes] = geometry.coordinates || [];
    if (!outer.length || !pointInRing(point, outer)) return false;
    return !holes.some(h => h.length && pointInRing(point, h));
  }
  if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates || []) {
      const [outer = [], ...holes] = poly || [];
      if (!outer.length || !pointInRing(point, outer)) continue;
      if (!holes.some(h => h.length && pointInRing(point, h))) return true;
    }
  }
  return false;
}

function getSearchRoots() {
  const isPackaged = __dirname.includes('app.asar');
  const appRoot = isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : path.join(__dirname, '..');
  const appAsarRoot = isPackaged ? path.join(process.resourcesPath, 'app.asar') : null;
  const cacheRoot = path.dirname(GENERATED_INFRA_CACHE_PATH);
  return [appRoot, appAsarRoot, process.cwd(), cacheRoot].filter(Boolean);
}

function resolveFromCandidates(candidates) {
  const roots = getSearchRoots();
  for (const root of roots) {
    for (const rel of candidates) {
      const full = path.join(root, rel);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

function resolveLocalWindTiffPath() {
  return resolveFromCandidates(LOCAL_WIND_TIFF_CANDIDATES);
}

async function loadLocalWindDataset(onProgress) {
  if (!_localWindDatasetPromise) {
    _localWindDatasetPromise = (async () => {
      const tiffPath = resolveLocalWindTiffPath();
      if (!tiffPath) return null;
      const geotiff = require('geotiff');
      const tiffBuffer = fs.readFileSync(tiffPath);
      const tiff = await geotiff.fromArrayBuffer(
        tiffBuffer.buffer.slice(tiffBuffer.byteOffset, tiffBuffer.byteOffset + tiffBuffer.byteLength)
      );
      const image = await tiff.getImage();
      const [minLon, minLat, maxLon, maxLat] = image.getBoundingBox();
      const width = image.getWidth();
      const height = image.getHeight();
      const noDataRaw = image.getGDALNoData && image.getGDALNoData();
      const noData = noDataRaw == null ? null : Number(noDataRaw);
      if (onProgress) onProgress(`  → Local wind GeoTIFF loaded: ${path.basename(tiffPath)} (${width}x${height})`);
      return { tiffPath, image, minLon, minLat, maxLon, maxLat, width, height, noData };
    })().catch((err) => {
      _localWindDatasetPromise = Promise.resolve(null);
      if (onProgress) onProgress(`  ⚠ Local wind GeoTIFF unavailable: ${err.message}`);
      return null;
    });
  }
  return _localWindDatasetPromise;
}

async function getLocalWindSpeedAtCentroid(boundaryGeometry, bbox, onProgress) {
  const dataset = await loadLocalWindDataset(onProgress);
  if (!dataset) return null;
  const centroid = getGeometryCentroid(boundaryGeometry, bbox);
  if (!centroid) return null;
  const [lon, lat] = centroid;
  const { minLon, minLat, maxLon, maxLat, width, height } = dataset;
  if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return null;
  const xRes = (maxLon - minLon) / width;
  const yRes = (maxLat - minLat) / height;
  if (!isFinite(xRes) || !isFinite(yRes) || xRes <= 0 || yRes <= 0) return null;
  const px = Math.max(0, Math.min(width - 1, Math.floor((lon - minLon) / xRes)));
  const py = Math.max(0, Math.min(height - 1, Math.floor((maxLat - lat) / yRes)));
  const values = await dataset.image.readRasters({ window: [px, py, px + 1, py + 1] });
  const v = values && values[0] ? Number(values[0][0]) : NaN;
  if (!isFinite(v)) return null;
  if (dataset.noData != null && Number.isFinite(dataset.noData) && Math.abs(v - dataset.noData) < 1e-6) return null;
  if (v <= 0 || v > 80) return null;
  return Math.round(v * 100) / 100;
}

async function loadLocalWorldCoverDatasets(onProgress) {
  if (!_localWorldCoverDatasetPromise) {
    _localWorldCoverDatasetPromise = (async () => {
      const resolvedPath = resolveFromCandidates(LOCAL_WORLDCOVER_TIFF_CANDIDATES);
      if (!resolvedPath) return [];

      const geotiff = require('geotiff');
      const datasets = [];

      async function loadTiff(tiffPath) {
        const tiffBuffer = fs.readFileSync(tiffPath);
        const tiff = await geotiff.fromArrayBuffer(
          tiffBuffer.buffer.slice(tiffBuffer.byteOffset, tiffBuffer.byteOffset + tiffBuffer.byteLength)
        );
        const image = await tiff.getImage();
        const [minLon, minLat, maxLon, maxLat] = image.getBoundingBox();
        const width = image.getWidth();
        const height = image.getHeight();
        const noDataRaw = image.getGDALNoData && image.getGDALNoData();
        const noData = noDataRaw == null ? null : Number(noDataRaw);
        return { tiffPath, image, minLon, minLat, maxLon, maxLat, width, height, noData };
      }

      const stat = fs.statSync(resolvedPath);
      if (stat.isDirectory()) {
        if (onProgress) onProgress(`  → Scanning directory for WorldCover tiles: ${resolvedPath}`);
        
        function findTifs(dir) {
          let results = [];
          const list = fs.readdirSync(dir);
          for (const file of list) {
            const fullPath = path.join(dir, file);
            const s = fs.statSync(fullPath);
            if (s.isDirectory()) {
              results = results.concat(findTifs(fullPath));
            } else if (file.endsWith('_Map.tif')) {
              results.push(fullPath);
            }
          }
          return results;
        }

        const tifs = findTifs(resolvedPath);
        if (onProgress) onProgress(`  → Found ${tifs.length} WorldCover tiles. Loading...`);
        for (const t of tifs) {
          try {
            datasets.push(await loadTiff(t));
          } catch (e) {
            if (onProgress) onProgress(`  ⚠ Failed to load tile ${t}: ${e.message}`);
          }
        }
      } else {
        try {
          datasets.push(await loadTiff(resolvedPath));
          if (onProgress) onProgress(`  → Local WorldCover loaded: ${path.basename(resolvedPath)}`);
        } catch (e) {
          if (onProgress) onProgress(`  ⚠ Failed to load WorldCover file ${resolvedPath}: ${e.message}`);
        }
      }

      return datasets;
    })().catch((err) => {
      _localWorldCoverDatasetPromise = Promise.resolve([]);
      if (onProgress) onProgress(`  ⚠ Local WorldCover unavailable: ${err.message}`);
      return [];
    });
  }
  return _localWorldCoverDatasetPromise;
}

async function getLocalForestPct(boundaryGeometry, bbox, onProgress) {
  const datasets = await loadLocalWorldCoverDatasets(onProgress);
  if (!datasets || datasets.length === 0 || !boundaryGeometry) return null;

  let totalPixels = 0;
  let treePixels = 0;

  for (const dataset of datasets) {
    const { minLon, minLat, maxLon, maxLat, width, height } = dataset;
    
    // Check if tile intersects the hromada bbox at all
    if (bbox.west > maxLon || bbox.east < minLon || bbox.south > maxLat || bbox.north < minLat) {
      continue;
    }

    const clipWest = Math.max(minLon, bbox.west);
    const clipEast = Math.min(maxLon, bbox.east);
    const clipSouth = Math.max(minLat, bbox.south);
    const clipNorth = Math.min(maxLat, bbox.north);
    if (!(clipWest < clipEast && clipSouth < clipNorth)) continue;

    const xRes = (maxLon - minLon) / width;
    const yRes = (maxLat - minLat) / height;
    if (!isFinite(xRes) || !isFinite(yRes) || xRes <= 0 || yRes <= 0) continue;

    const left = Math.max(0, Math.floor((clipWest - minLon) / xRes));
    const right = Math.min(width, Math.ceil((clipEast - minLon) / xRes));
    const top = Math.max(0, Math.floor((maxLat - clipNorth) / yRes));
    const bottom = Math.min(height, Math.ceil((maxLat - clipSouth) / yRes));
    if (!(left < right && top < bottom)) continue;

    const rasters = await dataset.image.readRasters({ window: [left, top, right, bottom] });
    const data = rasters && rasters[0] ? rasters[0] : null;
    if (!data) continue;

    const winWidth = right - left;
    const winHeight = bottom - top;
    
    for (let y = 0; y < winHeight; y++) {
      for (let x = 0; x < winWidth; x++) {
        const idx = y * winWidth + x;
        const cls = Number(data[idx]);
        if (!Number.isFinite(cls)) continue;
        if (dataset.noData != null && Number.isFinite(dataset.noData) && Math.abs(cls - dataset.noData) < 1e-6) continue;
        
        const lon = minLon + (left + x + 0.5) * xRes;
        const lat = maxLat - (top + y + 0.5) * yRes;
        
        if (!pointInGeometry([lon, lat], boundaryGeometry)) continue;
        totalPixels += 1;
        if (TREE_COVER_CLASSES.has(cls)) treePixels += 1;
      }
    }
  }

  if (!totalPixels) return null;
  return Math.max(0, Math.min(1, Math.round((treePixels / totalPixels) * 1000) / 1000));
}

async function loadLocalGeologyDataset(onProgress) {
  if (!_localGeologyDatasetPromise) {
    _localGeologyDatasetPromise = (async () => {
      const geoPath = resolveFromCandidates(LOCAL_GEOLOGY_CANDIDATES);
      if (!geoPath) return null;
      const raw = fs.readFileSync(geoPath, 'utf8');
      const parsed = JSON.parse(raw);
      const features = parsed && parsed.type === 'FeatureCollection' ? (parsed.features || []) : [];
      if (onProgress) onProgress(`  → Local geology dataset loaded: ${path.basename(geoPath)} (${features.length} features)`);
      return { geoPath, features };
    })().catch((err) => {
      _localGeologyDatasetPromise = Promise.resolve(null);
      if (onProgress) onProgress(`  ⚠ Local geology dataset unavailable: ${err.message}`);
      return null;
    });
  }
  return _localGeologyDatasetPromise;
}

async function getLocalGeologyAndKarst(boundaryGeometry, bbox, onProgress) {
  const ds = await loadLocalGeologyDataset(onProgress);
  if (!ds || !boundaryGeometry) return { karstRisk: '', geologicalConditions: '' };
  const centroid = getGeometryCentroid(boundaryGeometry, bbox);
  if (!centroid) return { karstRisk: '', geologicalConditions: '' };
  const found = ds.features.find(f => pointInGeometry(centroid, f.geometry));
  if (!found) return { karstRisk: '', geologicalConditions: '' };
  const p = found.properties || {};
  const karstRisk = p.karst_risk || p.karstRisk || p.karst || p.risk || p['Ризик'] || '';
  const geologicalConditions =
    p.geology || p.geological || p.lithology || p.formation || p.name || p['Характеристика'] || '';
  return { karstRisk: String(karstRisk || ''), geologicalConditions: String(geologicalConditions || '') };
}

async function overpassQuery(ql, onProgress, timeoutMs = OVERPASS_TIMEOUT_NORMAL_MS, totalTimeoutMs = 0) {
  const body = 'data=' + encodeURIComponent(ql);
  let rawResponse = '';
  const startedAt = Date.now();
  for (const url of [OVERPASS_URL, OVERPASS_ALT, OVERPASS_ALT_2]) {
    let reqTimeoutMs = timeoutMs;
    if (totalTimeoutMs > 0) {
      const elapsed = Date.now() - startedAt;
      const remaining = totalTimeoutMs - elapsed;
      if (remaining <= 0) throw new Error(`Overpass total timeout (${Math.round(totalTimeoutMs / 1000)}s)`);
      reqTimeoutMs = Math.min(timeoutMs, remaining);
    }
    try {
      rawResponse = await httpPost(
        url,
        body,
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        reqTimeoutMs
      );
      const trimmed = rawResponse.trimStart();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        onProgress && onProgress(`  ⚠ Overpass ${url} returned non-JSON, trying next mirror…`);
        continue;
      }
      return JSON.parse(rawResponse);
    } catch (e) {
      onProgress && onProgress(`  ⚠ Overpass ${url} failed: ${e.message}`);
    }
  }
  if (rawResponse) {
    const preview = rawResponse.slice(0, 300).replace(/\s+/g, ' ');
    throw new Error(`All Overpass endpoints failed (last response was non-JSON): ${preview}`);
  }
  throw new Error('All Overpass endpoints failed');
}

// ── decentralization.ua helpers ───────────────────────────

async function getOblastId(oblastName) {
  const raw = await httpGet('https://decentralization.ua/state', { 'Accept': 'application/json' });
  const list = JSON.parse(raw);
  const norm = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const needle = norm(oblastName);
  // Try exact match first, then partial
  let match = list.find(o => norm(o.title) === needle);
  if (!match) match = list.find(o => norm(o.title).includes(needle) || needle.includes(norm(o.title)));
  if (!match) {
    // Try stripping "область" suffix
    const short = needle.replace(/\s*область\s*$/i, '').trim();
    match = list.find(o => norm(o.title).replace(/\s*область\s*$/i, '').trim() === short);
  }
  if (!match) throw new Error(`Oblast "${oblastName}" not found. Available: ${list.map(o => o.title).join(', ')}`);
  return { id: match.id, title: match.title };
}

// Scrape hromada list from decentralization.ua via Puppeteer
// The site uses /newgromada with a filter dropdown; pagination via ?area_id=&page=N
async function getHromadaList(stateId, browser, onProgress) {
  onProgress(`  → Opening decentralization.ua hromada list for oblast id=${stateId}…`);

  // Helper: extract all hromada rows from the current page DOM
  function extractRows(page) {
    return page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.row.resize-row.title-align.new-grid, .row.new-area-grid'))
        .filter(r => r.querySelector('a[href*="/newgromada/"]'));
      return rows.map(row => {
        const link = row.querySelector('a[href*="/newgromada/"]');
        const href = link ? link.getAttribute('href') : '';
        const idMatch = href.match(/\/newgromada\/(\d+)/);
        // Each content cell has label + value separated by whitespace: "Район\n\nВараський"
        let type = '', district = '';
        row.querySelectorAll('.new-community-content, .new-content').forEach(div => {
          const parts = div.innerText ? div.innerText.split('\n').map(s => s.trim()).filter(Boolean) : div.textContent.split('\n').map(s => s.trim()).filter(Boolean);
          if (parts[0] === 'Район' && parts[1]) district = parts[1];
          if (parts[0] === 'Тип громади' && parts[1]) type = parts[1];
        });
        return {
          id: idMatch ? idMatch[1] : null,
          name: link ? link.textContent.trim() : '',
          type,
          district,
          url: href.startsWith('http') ? href : 'https://decentralization.ua' + href,
        };
      }).filter(h => h.id && h.name);
    });
  }

  // Navigate page 1 with area_id filter directly in URL
  const page = await browser.newPage();
  try {
    const baseUrl = `https://decentralization.ua/newgromada?area_id=${stateId}&page=1`;
    await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    try { await page.waitForSelector('a[href*="/newgromada/"]', { timeout: 15000 }); } catch (_) {}

    // Find total number of pages
    const maxPage = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('.pagination a[href*="page="], a[href*="page="]'));
      let max = 1;
      links.forEach(a => {
        const m = (a.getAttribute('href') || '').match(/[?&]page=(\d+)/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      });
      return max;
    });

    onProgress(`  → Found ${maxPage} page(s) of results`);

    const all = [];
    const seen = new Set();

    // Collect page 1 rows
    const page1Rows = await extractRows(page);
    for (const h of page1Rows) { if (!seen.has(h.id)) { seen.add(h.id); all.push(h); } }

    // Collect remaining pages
    for (let p = 2; p <= maxPage; p++) {
      await page.goto(`https://decentralization.ua/newgromada?area_id=${stateId}&page=${p}`, { waitUntil: 'networkidle2', timeout: 60000 });
      try { await page.waitForSelector('a[href*="/newgromada/"]', { timeout: 10000 }); } catch (_) {}
      const rows = await extractRows(page);
      for (const h of rows) { if (!seen.has(h.id)) { seen.add(h.id); all.push(h); } }
      onProgress(`  → Page ${p}/${maxPage}: ${all.length} hromadas so far`);
    }

    onProgress(`  ✅ Found ${all.length} hromadas`);
    return all;
  } finally {
    await page.close();
  }
}

// Scrape individual hromada page for КП stage and official site link
async function getHromadaPageInfo(hromadaId, browser, onProgress) {
  const page = await browser.newPage();
  const result = { kpStage: '', officialSiteUrl: '' };
  try {
    const url = `https://decentralization.ua/newgromada/${hromadaId}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

    const info = await page.evaluate(() => {
      const out = { kpStage: '', officialSiteUrl: '' };

      // Look for КП stage — field-value pattern
      const allText = document.body.innerText;
      const kpMatch = allText.match(/Стадія\s+Комплексного\s+плану[:\s]+([^\n]+)/i);
      if (kpMatch) out.kpStage = kpMatch[1].trim();

      // Also try structured rows/dt-dd/info blocks
      document.querySelectorAll('dt, th, label, .field-label, .info-label').forEach(el => {
        const txt = el.textContent.trim();
        if (/стадія.*комплексного|комплексний.*план/i.test(txt)) {
          const sibling = el.nextElementSibling || el.closest('tr')?.querySelector('td:last-child');
          if (sibling && !out.kpStage) out.kpStage = sibling.textContent.trim();
        }
      });

      // Official site link
      const links = document.querySelectorAll('a');
      for (const a of links) {
        const txt = a.textContent.trim();
        const href = a.getAttribute('href') || '';
        if (/офіційний\s*сайт/i.test(txt) && href) {
          out.officialSiteUrl = href.startsWith('http') ? href : 'https://decentralization.ua' + href;
          break;
        }
      }
      // Fallback: look for external links in info block
      if (!out.officialSiteUrl) {
        document.querySelectorAll('a[href^="http"]').forEach(a => {
          const href = a.getAttribute('href') || '';
          if (/\.gov\.ua|\.rada\.gov|гром/i.test(href) && !href.includes('decentralization.ua') && !out.officialSiteUrl) {
            out.officialSiteUrl = href;
          }
        });
      }

      return out;
    });

    result.kpStage = info.kpStage;
    result.officialSiteUrl = info.officialSiteUrl;
  } catch (e) {
    onProgress && onProgress(`  ⚠ Failed to scrape hromada page ${hromadaId}: ${e.message}`);
  } finally {
    await page.close();
  }
  return result;
}

// Scrape official site for address, head, urban planning link
async function getOfficialSiteInfo(siteUrl, browser, onProgress) {
  const result = { address: '', head: '', urbanPlanningUrl: '' };
  if (!siteUrl) return result;
  const page = await browser.newPage();
  try {
    await page.goto(siteUrl, { waitUntil: 'networkidle2', timeout: 45000 });

    // Find Контакти link and navigate
    const contactUrl = await page.evaluate((base) => {
      for (const a of document.querySelectorAll('a')) {
        const txt = a.textContent.trim();
        const href = a.getAttribute('href') || '';
        if (/контакт/i.test(txt) && href) {
          if (href.startsWith('http')) return href;
          try { return new URL(href, base).href; } catch (_) { return base + '/' + href.replace(/^\/+/, ''); }
        }
      }
      return null;
    }, siteUrl);

    if (contactUrl) {
      await page.goto(contactUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    }

    const info = await page.evaluate(() => {
      const text = document.body.innerText;
      let address = '', head = '';

      // Address patterns
      const addrMatch = text.match(/(?:адреса|місцезнаходження|юридична адреса)[:\s]+([^\n]{5,100})/i);
      if (addrMatch) address = addrMatch[1].trim();

      // Head patterns
      const headMatch = text.match(/голова(?:\s+громади|\s+ради)?[:\s]+([^\n]{3,80})/i);
      if (headMatch) head = headMatch[1].trim();
      if (!head) {
        // Try finding name after "голова" in structured content
        document.querySelectorAll('dt, th, strong, b, .label').forEach(el => {
          if (/голова/i.test(el.textContent) && !head) {
            const sib = el.nextElementSibling || el.closest('tr')?.querySelector('td:last-child');
            if (sib) head = sib.textContent.trim();
          }
        });
      }

      return { address, head };
    });

    result.address = info.address;
    result.head = info.head;

    // Urban planning documentation — search on main site
    const upUrl = await page.evaluate((base) => {
      for (const a of document.querySelectorAll('a')) {
        const txt = a.textContent.trim();
        const href = a.getAttribute('href') || '';
        if (/комплексний\s*план|генеральний\s*план|містобудів|планувальн/i.test(txt) && href) {
          if (href.startsWith('http')) return href;
          try { return new URL(href, base).href; } catch (_) { return null; }
        }
      }
      return null;
    }, siteUrl);

    if (!upUrl) {
      // Try navigating back to main page and look for urban planning section
      await page.goto(siteUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      const upUrl2 = await page.evaluate((base) => {
        for (const a of document.querySelectorAll('a')) {
          const txt = a.textContent.trim();
          const href = a.getAttribute('href') || '';
          if (/комплексний\s*план|генеральний\s*план|містобудів/i.test(txt) && href) {
            if (href.startsWith('http')) return href;
            try { return new URL(href, base).href; } catch (_) { return null; }
          }
        }
        return null;
      }, siteUrl);
      result.urbanPlanningUrl = upUrl2 || '';
    } else {
      result.urbanPlanningUrl = upUrl;
    }
  } catch (e) {
    onProgress && onProgress(`  ⚠ Failed to scrape official site ${siteUrl}: ${e.message}`);
  } finally {
    await page.close();
  }
  return result;
}

// ── Utility: Get bbox from hromada geo_json via REST API ────────────────────────

async function getBboxFromGeoJson(hromadaId, onProgress) {
  const url = `https://decentralization.ua/api/v1/communities/${hromadaId}/geo_json`;
  try {
    const raw = await httpGet(url);
    const geo = JSON.parse(raw);
    if (!geo.geometry || !['Polygon', 'MultiPolygon'].includes(geo.geometry.type)) {
      throw new Error('Invalid polygon geometry');
    }
    const rings = geo.geometry.type === 'Polygon'
      ? [geo.geometry.coordinates[0] || []]
      : geo.geometry.coordinates.map(poly => poly[0] || []);
    const coords = rings.flat();
    if (coords.length < 3) throw new Error('Polygon has less than 3 points');
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    coords.forEach(([lon, lat]) => {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    });
    return {
      bbox: { west, east, south, north },
      boundaryGeojson: geo.geometry,
    };
  } catch (e) {
    throw new Error(`Failed to fetch geo_json for hromada ${hromadaId}: ${e.message}`);
  }
}

// ── OSM Overpass data for research ────────────────────────

function bboxAreaKm2(bbox) {
  const { south, north, west, east } = bbox;
  const latDeg = north - south;
  const lonDeg = east - west;
  const latM = latDeg * 111320;
  const lonM = lonDeg * 111320 * Math.cos((south + north) / 2 * Math.PI / 180);
  return (latM * lonM) / 1e6;
}

function ensureClosedRing(ring) {
  if (!ring || ring.length < 3) return ring || [];
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  if (fx === lx && fy === ly) return ring;
  return [...ring, ring[0]];
}

function boundaryAreaM2(geometry) {
  if (!geometry) return 0;
  if (geometry.type === 'Polygon') {
    const [outer = [], ...holes] = geometry.coordinates;
    const outerArea = polygonAreaM2(ensureClosedRing(outer));
    const holesArea = holes.reduce((sum, h) => sum + polygonAreaM2(ensureClosedRing(h)), 0);
    return Math.max(0, outerArea - holesArea);
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.reduce((sum, poly) => {
      const [outer = [], ...holes] = poly;
      const outerArea = polygonAreaM2(ensureClosedRing(outer));
      const holesArea = holes.reduce((hSum, h) => hSum + polygonAreaM2(ensureClosedRing(h)), 0);
      return sum + Math.max(0, outerArea - holesArea);
    }, 0);
  }
  return 0;
}

function normalizeElementBbox(el) {
  if (typeof el.lon === 'number' && typeof el.lat === 'number') {
    return { west: el.lon, east: el.lon, south: el.lat, north: el.lat };
  }
  if (el.center && typeof el.center.lon === 'number' && typeof el.center.lat === 'number') {
    return { west: el.center.lon, east: el.center.lon, south: el.center.lat, north: el.center.lat };
  }
  if (Array.isArray(el.geometry) && el.geometry.length) {
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    el.geometry.forEach(p => {
      if (typeof p.lon !== 'number' || typeof p.lat !== 'number') return;
      west = Math.min(west, p.lon);
      east = Math.max(east, p.lon);
      south = Math.min(south, p.lat);
      north = Math.max(north, p.lat);
    });
    if (Number.isFinite(west)) return { west, east, south, north };
  }
  return null;
}

function bboxesIntersect(a, b) {
  return !(a.east < b.west || a.west > b.east || a.north < b.south || a.south > b.north);
}

function resolveLocalInfraCachePath() {
  const predefined = resolveFromCandidates(LOCAL_INFRA_CACHE_CANDIDATES);
  if (predefined) return predefined;
  return fs.existsSync(GENERATED_INFRA_CACHE_PATH) ? GENERATED_INFRA_CACHE_PATH : null;
}

function resolveLocalPbfPath() {
  return resolveFromCandidates(LOCAL_PBF_CANDIDATES);
}

function convertGeoJsonFeatureToInfraElement(feature) {
  if (!feature || feature.type !== 'Feature' || !feature.geometry || !feature.properties) return null;
  const tags = feature.properties.tags || feature.properties;
  const g = feature.geometry;
  if (!tags || (!tags.power && !tags.pipeline && !tags.man_made)) return null;
  const el = { type: 'way', tags: { ...tags } };
  if (g.type === 'Point' && Array.isArray(g.coordinates)) {
    el.type = 'node';
    el.lon = Number(g.coordinates[0]);
    el.lat = Number(g.coordinates[1]);
  } else if (g.type === 'LineString' && Array.isArray(g.coordinates)) {
    el.geometry = g.coordinates.map(([lon, lat]) => ({ lon: Number(lon), lat: Number(lat) }));
  } else if (g.type === 'Polygon' && Array.isArray(g.coordinates[0])) {
    el.geometry = g.coordinates[0].map(([lon, lat]) => ({ lon: Number(lon), lat: Number(lat) }));
  } else if (g.type === 'MultiLineString' && Array.isArray(g.coordinates[0])) {
    el.geometry = g.coordinates[0].map(([lon, lat]) => ({ lon: Number(lon), lat: Number(lat) }));
  } else {
    return null;
  }
  return el;
}

function isInfraTagged(tags) {
  if (!tags) return false;
  if (tags.power === 'line') return true;
  if (tags.power === 'substation') return true;
  if (tags.man_made === 'pipeline' && tags.substance === 'gas') return true;
  if (tags.pipeline === 'gas') return true;
  return false;
}

async function parsePbfCollectInfra(pbfPath, onProgress) {
  const parseOSM = require('osm-pbf-parser');
  const wayCandidates = new Map();
  const nodeInfra = [];
  const neededNodeIds = new Set();
  const pass1Stats = { node: 0, way: 0 };
  await new Promise((resolve, reject) => {
    const parser = parseOSM();
    fs.createReadStream(pbfPath)
      .pipe(parser)
      .on('data', (items) => {
        for (const item of items || []) {
          if (!item || !item.tags) continue;
          if (item.type === 'node') {
            if (item.tags.power === 'substation') {
              nodeInfra.push({
                type: 'node',
                lon: Number(item.lon),
                lat: Number(item.lat),
                tags: item.tags,
              });
              pass1Stats.node += 1;
            }
            continue;
          }
          if (item.type !== 'way' || !isInfraTagged(item.tags) || !Array.isArray(item.refs) || !item.refs.length) continue;
          const id = String(item.id);
          if (!wayCandidates.has(id)) {
            wayCandidates.set(id, { id, refs: item.refs.slice(), tags: { ...item.tags } });
            item.refs.forEach((ref) => neededNodeIds.add(String(ref)));
            pass1Stats.way += 1;
          }
        }
      })
      .on('error', reject)
      .on('end', resolve);
  });
  onProgress(`  → PBF pass 1 done: ${pass1Stats.way} ways, ${pass1Stats.node} tagged nodes`);

  const nodeCoords = new Map();
  await new Promise((resolve, reject) => {
    const parser = parseOSM();
    fs.createReadStream(pbfPath)
      .pipe(parser)
      .on('data', (items) => {
        for (const item of items || []) {
          if (!item || item.type !== 'node') continue;
          const id = String(item.id);
          if (!neededNodeIds.has(id)) continue;
          nodeCoords.set(id, [Number(item.lon), Number(item.lat)]);
        }
      })
      .on('error', reject)
      .on('end', resolve);
  });
  onProgress(`  → PBF pass 2 done: ${nodeCoords.size}/${neededNodeIds.size} referenced nodes resolved`);

  const elements = [];
  for (const entry of wayCandidates.values()) {
    const geometry = entry.refs
      .map((ref) => nodeCoords.get(String(ref)))
      .filter(Boolean)
      .map(([lon, lat]) => ({ lon, lat }));
    if (!geometry.length) continue;
    elements.push({ type: 'way', tags: entry.tags, geometry });
  }
  elements.push(...nodeInfra.filter((n) => Number.isFinite(n.lon) && Number.isFinite(n.lat)));
  return elements;
}

async function buildInfraCacheFromPbf(onProgress) {
  const pbfPath = resolveLocalPbfPath();
  if (!pbfPath) return null;
  onProgress(`📦 Building offline infra cache from PBF: ${path.basename(pbfPath)} (one-time)…`);
  const elements = await parsePbfCollectInfra(pbfPath, onProgress);
  const outDir = path.dirname(GENERATED_INFRA_CACHE_PATH);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(GENERATED_INFRA_CACHE_PATH, JSON.stringify({ elements }, null, 2), 'utf8');
  onProgress(`  ✅ Offline infra cache saved: ${GENERATED_INFRA_CACHE_PATH} (${elements.length} elements)`);
  return GENERATED_INFRA_CACHE_PATH;
}

async function loadLocalInfraCache(onProgress) {
  if (_localInfraCachePromise) return _localInfraCachePromise;
  _localInfraCachePromise = (async () => {
    let cachePath = resolveLocalInfraCachePath();
    if (!cachePath) cachePath = await buildInfraCacheFromPbf(onProgress);
    if (!cachePath) return null;
    const raw = fs.readFileSync(cachePath, 'utf8');
    let parsed = JSON.parse(raw);
    let elements = [];
    if (Array.isArray(parsed)) {
      elements = parsed;
    } else if (parsed && Array.isArray(parsed.elements)) {
      elements = parsed.elements;
    } else if (parsed && parsed.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
      elements = parsed.features.map(convertGeoJsonFeatureToInfraElement).filter(Boolean);
    } else {
      throw new Error('Unsupported infra cache format');
    }
    const normalized = elements
      .map((el) => ({ ...el, _bbox: normalizeElementBbox(el) }))
      .filter((el) => el._bbox);
    onProgress(`📦 Using local infra cache: ${path.basename(cachePath)} (${normalized.length} elements)`);
    return normalized;
  })().catch((err) => {
    onProgress(`  ⚠ Local infra cache load failed: ${err.message}`);
    return null;
  });
  return _localInfraCachePromise;
}

async function prefetchOblastInfraData(oblastBbox, onProgress) {
  const { south, west, north, east } = oblastBbox;
  const b = `${south},${west},${north},${east}`;
  const infraQl = `[out:json][timeout:120];
(
  way["power"="line"]["voltage"](${b});
  node["power"="substation"]["name"](${b});
  node["power"="substation"]["voltage"](${b});
  way["power"="substation"]["name"](${b});
  way["power"="substation"]["voltage"](${b});
  way["man_made"="pipeline"]["substance"="gas"](${b});
  way["pipeline"="gas"](${b});
);
out geom tags;`;
  onProgress(`🌍 Prefetching oblast infrastructure (power/substations/gas) once…`);
  const data = await overpassQuery(infraQl, onProgress, OVERPASS_TIMEOUT_NORMAL_MS);
  const elements = (data.elements || []).map(el => ({ ...el, _bbox: normalizeElementBbox(el) }));
  onProgress(`  ✅ Infra cache loaded: ${elements.length} elements`);
  return elements;
}

function infraSummaryFromElements(infraElements) {
  // ── Power lines ──────────────────────────────────────────
  const voltages = new Set();
  infraElements.forEach(el => {
    if (el.type !== 'way') return;
    const tags = el.tags || {};
    if (tags.power !== 'line') return;
    const v = tags.voltage;
    if (v) {
      v.split(/[;,]/).forEach(part => {
        const kv = Math.round(parseFloat(part.trim()) / 1000);
        if (kv > 0) voltages.add(kv);
      });
    }
  });
  const powerLinesText = voltages.size > 0
    ? [...voltages].sort((a, b) => b - a).map(v => `${v} кВ`).join(', ')
    : '';

  // ── Substations ──────────────────────────────────────────
  const substationNames = [];
  infraElements.forEach(el => {
    const tags = el.tags || {};
    if (tags.power !== 'substation') return;
    const name = tags.name || tags['name:uk'] || '';
    const voltage = tags.voltage || '';
    if (name) {
      const kv = voltage ? ` ${Math.round(parseFloat(voltage.split(/[;,]/)[0]) / 1000)}/${Math.round(parseFloat(voltage.split(/[;,]/)[1] || 10) / 1000)} кВ` : '';
      substationNames.push(name + kv);
    }
  });
  const substationsText = substationNames.slice(0, 5).join('; ');

  // ── Gas pipelines ────────────────────────────────────────
  const hasGas = infraElements.some(el => {
    const tags = el.tags || {};
    return (tags.man_made === 'pipeline' && tags.substance === 'gas') || tags.pipeline === 'gas';
  });

  return { powerLinesText, substationsText, hasGas };
}

async function fetchOsmResearchData(bbox, boundaryGeometry, onProgress, infraCacheElements = null, forestOverride = null) {
  const { south, west, north, east } = bbox;
  const b = `${south},${west},${north},${east}`;

  const forestQl = `[out:json][timeout:120];
(
  way["landuse"="forest"](${b});
  way["natural"="wood"](${b});
 );
 out geom tags;`;

  const infraQl = `[out:json][timeout:90];
(
  way["power"="line"]["voltage"](${b});
  node["power"="substation"]["name"](${b});
  node["power"="substation"]["voltage"](${b});
  way["power"="substation"]["name"](${b});
  way["power"="substation"]["voltage"](${b});
  way["man_made"="pipeline"]["substance"="gas"](${b});
  way["pipeline"="gas"](${b});
);
out geom tags;`;

  let forestElements = [];
  if (forestOverride == null) {
    onProgress(`  → Querying Overpass for forest cover…`);
    try {
      const forestData = await overpassQuery(
        forestQl,
        onProgress,
        20000,
        OVERPASS_FOREST_TOTAL_TIMEOUT_MS
      );
      forestElements = forestData.elements || [];
    } catch (e) {
      onProgress(`  ⚠ Forest query timed out/failed: ${e.message}`);
    }
  }

  let infraElements = [];
  if (infraCacheElements && infraCacheElements.length) {
    infraElements = infraCacheElements.filter(el => el._bbox && bboxesIntersect(el._bbox, bbox));
    onProgress(`  → Using oblast infra cache: ${infraElements.length} nearby elements`);
  } else {
    onProgress(`  → Querying Overpass for power/substations/gas…`);
    try {
      const infraData = await overpassQuery(infraQl, onProgress, OVERPASS_TIMEOUT_FAST_MS);
      infraElements = (infraData.elements || []).map(el => ({ ...el, _bbox: normalizeElementBbox(el) }));
    } catch (e) {
      onProgress(`  ⚠ Infra query timed out/failed: ${e.message}`);
    }
  }

  // ── Forest coverage ──────────────────────────────────────
  let forestAreaM2 = 0;
  forestElements.forEach(el => {
    if (el.type !== 'way') return;
    const tags = el.tags || {};
    if (tags.landuse !== 'forest' && tags.natural !== 'wood') return;
    if (!el.geometry) return;
    // Build a ring from geometry if available
    let ring = null;
    if (el.geometry && el.geometry.length >= 3) {
      ring = el.geometry.map(p => [p.lon, p.lat]);
    }
    if (ring) forestAreaM2 += polygonAreaM2(ring);
  });

  const totalAreaM2 = boundaryAreaM2(boundaryGeometry) || (bboxAreaKm2(bbox) * 1e6);
  const forestPctRaw = forestOverride != null
    ? forestOverride
    : (totalAreaM2 > 0 ? (forestAreaM2 / totalAreaM2) : 0);
  const forestPct = Math.max(0, Math.min(1, Math.round(forestPctRaw * 1000) / 1000));

  const { powerLinesText, substationsText, hasGas } = infraSummaryFromElements(infraElements);

  return {
    forestPct,
    powerLinesText,
    substationsText,
    hasGas,
  };
}

// ── Roughness class from forest % ────────────────────────
function estimateRoughnessLength(forestPct) {
  if (forestPct > 0.4) return 1.5;
  if (forestPct > 0.2) return 0.5;
  if (forestPct > 0.05) return 0.1;
  return 0.03;
}

// ── XLSX generation ───────────────────────────────────────

const HEADERS = [
  'No.',
  'Community name',
  'Community type',
  'District',
  'Forest cover %',
  'Emerald Network',
  'Nature reserve fund (https://pzf.land.kiev.ua)',
  'Average wind speed (m/s) altitude of 150 m',
  'Gas mains',
  'Other Risks',
  'Availability of power lines (voltage class)',
  'Availability of substations (SS) and their capacity',
  'Стадія Комплексного плану',
  'Клас шорсткості поверхні',
  'Ризик карстоутворення',
  'Характеристика геологічних умов',
  'My conclusions',
  'Address/contacts',
  'Head community',
  'Link on urban planning documentation',
];

async function buildXlsx(rows, outputPath, oblastName) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(oblastName || 'Research');

  // Column widths
  const colWidths = [5, 30, 18, 22, 14, 16, 45, 20, 14, 22, 30, 35, 25, 18, 18, 35, 25, 35, 25, 40];
  HEADERS.forEach((h, i) => {
    const col = ws.getColumn(i + 1);
    col.width = colWidths[i] || 20;
  });
  // Forest cover is stored as a fraction (e.g. 0.2) — display as percentage in Excel.
  ws.getColumn(5).numFmt = '0%';

  // Header row
  const headerRow = ws.addRow(HEADERS);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
    cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
    cell.border = {
      top: { style: 'thin' }, bottom: { style: 'thin' },
      left: { style: 'thin' }, right: { style: 'thin' },
    };
  });
  headerRow.height = 40;

  // Data rows
  rows.forEach((r, idx) => {
    const row = ws.addRow([
      idx + 1,
      { text: r.name, hyperlink: r.url || '' },
      r.type || '',
      r.district || '',
      r.forestPct != null ? r.forestPct : '',
      r.emerald || '',
      r.natureReserves || '',
      r.windSpeed != null ? r.windSpeed : '',
      r.hasGas ? 'Є' : 'Відсутні',
      '',  // Other risks — blank
      r.powerLines || '',
      r.substations || '',
      r.kpStage || '',
      r.roughness != null ? r.roughness : '',
      r.karstRisk || '',
      r.geologicalConditions || '',
      '',  // Висновки — blank
      r.address || '',
      r.head || '',
      r.urbanPlanningUrl ? { text: r.urbanPlanningUrl, hyperlink: r.urbanPlanningUrl } : '',
    ]);

    row.eachCell((cell, colNum) => {
      cell.alignment = { wrapText: true, vertical: 'top' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFDDDDDD' } },
        bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } },
        left: { style: 'thin', color: { argb: 'FFDDDDDD' } },
        right: { style: 'thin', color: { argb: 'FFDDDDDD' } },
      };
      // Style community name cell as hyperlink
      if (colNum === 2 && r.url) {
        cell.font = { color: { argb: 'FF0563C1' }, underline: true };
      }
      // Style last col as hyperlink
      if (colNum === 20 && r.urbanPlanningUrl) {
        cell.font = { color: { argb: 'FF0563C1' }, underline: true };
      }
      // Alternate row shade
      if (idx % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F9FF' } };
      }
    });
  });

  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
  await wb.xlsx.writeFile(outputPath);
}

// ── Main entry point ──────────────────────────────────────

let _stopRequested = false;

function stopResearch() {
  _stopRequested = true;
}

async function generateResearchXlsx(oblastName, outputPath, onProgress, chromePath) {
  _stopRequested = false;
  onProgress(`🗺  Pre-Research XLSX: "${oblastName}"`);

  // 1. Resolve oblast
  onProgress(`🔍 Looking up oblast in decentralization.ua…`);
  const oblast = await getOblastId(oblastName);
  onProgress(`  ✅ Found: ${oblast.title} (id=${oblast.id})`);

  // 2. Puppeteer browser
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    throw new Error('Puppeteer not available: ' + e.message);
  }

  const launchOpts = { 
    headless: 'new', 
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox', 
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--ignore-certificate-errors',
      '--window-size=1920,1080',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ] 
  };
  if (chromePath) launchOpts.executablePath = chromePath;
  const browser = await puppeteer.launch(launchOpts);

  try {
    // 3. Get hromada list
    onProgress(`📋 Fetching hromada list…`);
    const hromadas = await getHromadaList(oblast.id, browser, onProgress);
    if (!hromadas.length) throw new Error('No hromadas found — check the oblast name');

    onProgress(`  ✅ ${hromadas.length} hromadas to process`);

    // 4. Preload hromada boundaries + oblast infra cache
    onProgress(`📐 Loading hromada boundaries for cache planning…`);
    const hromadaGeo = new Map();
    let oblastBbox = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
    for (let i = 0; i < hromadas.length; i++) {
      if (_stopRequested) { onProgress('⛔ Stopped by user'); break; }
      const h = hromadas[i];
      try {
        const geo = await getBboxFromGeoJson(h.id, onProgress);
        hromadaGeo.set(h.id, geo);
        oblastBbox.west = Math.min(oblastBbox.west, geo.bbox.west);
        oblastBbox.east = Math.max(oblastBbox.east, geo.bbox.east);
        oblastBbox.south = Math.min(oblastBbox.south, geo.bbox.south);
        oblastBbox.north = Math.max(oblastBbox.north, geo.bbox.north);
      } catch (e) {
        onProgress(`  ⚠ ${h.name}: boundary preload failed: ${e.message}`);
      }
      if ((i + 1) % 10 === 0 || i + 1 === hromadas.length) {
        onProgress(`  → Boundaries loaded: ${i + 1}/${hromadas.length}`);
      }
    }

    let oblastInfraCache = null;
    if (Number.isFinite(oblastBbox.west)) {
      try {
        const localInfraCache = await loadLocalInfraCache(onProgress);
        if (localInfraCache && localInfraCache.length) {
          oblastInfraCache = localInfraCache.filter(el => bboxesIntersect(el._bbox, oblastBbox));
          onProgress(`  ✅ Local infra cache prepared: ${oblastInfraCache.length} elements in oblast bbox`);
        } else {
          oblastInfraCache = await prefetchOblastInfraData(oblastBbox, onProgress);
        }
      } catch (e) {
        onProgress(`  ⚠ Oblast infra prefetch failed, falling back to per-hromada infra queries: ${e.message}`);
      }
    }

    // 5. Process each hromada sequentially (Overpass throttles parallel requests)
    const BATCH = 1;  // Process one at a time to avoid Overpass overload
    const PARTIAL_SAVE_EVERY = 5;
    const results = [];

    for (let i = 0; i < hromadas.length; i += BATCH) {
      if (_stopRequested) { onProgress('⛔ Stopped by user'); break; }
      const batch = hromadas.slice(i, i + BATCH);
      onProgress(`\n📦 Hromada ${i + 1}/${hromadas.length}: ${batch.map(h => h.name).join(', ')}`);

      const batchResults = [];
      for (const hromada of batch) {
        const row = {
          name: hromada.name,
          url: hromada.url,
          type: hromada.type,
          district: hromada.district,
          forestPct: null,
          emerald: '',
          natureReserves: '',
          windSpeed: null,
          hasGas: false,
          powerLines: '',
          substations: '',
          kpStage: '',
          roughness: null,
          karstRisk: '',
          geologicalConditions: '',
          address: '',
          head: '',
          urbanPlanningUrl: '',
        };

        try {
          // Resolve bbox using REST API geo_json endpoint
          onProgress(`  🔍 ${hromada.name}: fetching boundary…`);
          const geo = hromadaGeo.get(hromada.id) || await getBboxFromGeoJson(hromada.id, onProgress);
          const { bbox, boundaryGeojson } = geo;

          const tasks = [
            (async () => {
              try {
                const localForest = await withTimeout(
                  getLocalForestPct(boundaryGeojson, bbox, msg => onProgress(`  [${hromada.name}] ${msg}`)),
                  TASK_TIMEOUTS_MS.osm,
                  'Local forest task'
                );
                const osm = await withTimeout(
                  fetchOsmResearchData(
                    bbox,
                    boundaryGeojson,
                    msg => onProgress(`  [${hromada.name}] ${msg}`),
                    oblastInfraCache,
                    localForest
                  ),
                  TASK_TIMEOUTS_MS.osm,
                  'OSM task'
                );
                row.forestPct = osm.forestPct;
                row.powerLines = osm.powerLinesText;
                row.substations = osm.substationsText;
                row.hasGas = osm.hasGas;
                row.roughness = estimateRoughnessLength(osm.forestPct);
              } catch (e) {
                onProgress(`  ⚠ ${hromada.name}: OSM error: ${e.message}`);
              }
            })(),
            (async () => {
              try {
                const localWind = await withTimeout(
                  getLocalWindSpeedAtCentroid(boundaryGeojson, bbox, msg => onProgress(`  [${hromada.name}] ${msg}`)),
                  TASK_TIMEOUTS_MS.wind,
                  'Local wind task'
                );
                if (localWind != null) {
                  row.windSpeed = localWind;
                  return;
                }
                const wind = await withTimeout(
                  fetchWindHeatmap(bbox, 150, msg => {}),
                  TASK_TIMEOUTS_MS.wind,
                  'Wind task'
                );
                row.windSpeed = wind.avgSpeed;
              } catch (e) {
                onProgress(`  ⚠ ${hromada.name}: Wind error: ${e.message}`);
              }
            })(),
            (async () => {
              try {
                const emerald = await withTimeout(
                  fetchEmeraldFromEEA(bbox, msg => {}),
                  TASK_TIMEOUTS_MS.emerald,
                  'Emerald task'
                );
                row.emerald = emerald.length > 0 ? '+' : '';
              } catch (e) {
                onProgress(`  ⚠ ${hromada.name}: Emerald error: ${e.message}`);
              }
            })(),
            (async () => {
              try {
                const pzf = await withTimeout(
                  fetchNatureReservesFromPZF(bbox, msg => {}),
                  TASK_TIMEOUTS_MS.pzf,
                  'PZF task'
                );
                if (pzf.length > 0) {
                  const names = [...new Set(pzf.map(f => f.properties.name).filter(Boolean))];
                  row.natureReserves = names.slice(0, 5).join('; ');
                }
              } catch (e) {
                onProgress(`  ⚠ ${hromada.name}: PZF error: ${e.message}`);
              }
            })(),
            (async () => {
              if (!hromada.id) return;
              try {
                const pageInfo = await withTimeout(
                  getHromadaPageInfo(hromada.id, browser, onProgress),
                  TASK_TIMEOUTS_MS.page,
                  'Community page task'
                );
                row.kpStage = pageInfo.kpStage;
                if (pageInfo.officialSiteUrl) {
                  try {
                    const siteInfo = await withTimeout(
                      getOfficialSiteInfo(pageInfo.officialSiteUrl, browser, onProgress),
                      TASK_TIMEOUTS_MS.page,
                      'Official site task'
                    );
                    row.address = siteInfo.address;
                    row.head = siteInfo.head;
                    row.urbanPlanningUrl = siteInfo.urbanPlanningUrl;
                  } catch (e) {
                    onProgress(`  ⚠ ${hromada.name}: official site error: ${e.message}`);
                  }
                }
              } catch (e) {
                onProgress(`  ⚠ ${hromada.name}: page scrape error: ${e.message}`);
              }
            })(),
            (async () => {
              try {
                const geoInfo = await withTimeout(
                  getLocalGeologyAndKarst(boundaryGeojson, bbox, msg => onProgress(`  [${hromada.name}] ${msg}`)),
                  12000,
                  'Geology task'
                );
                row.karstRisk = geoInfo.karstRisk || '';
                row.geologicalConditions = geoInfo.geologicalConditions || '';
              } catch (e) {
                onProgress(`  ⚠ ${hromada.name}: geology error: ${e.message}`);
              }
            })(),
          ];
          await Promise.allSettled(tasks);

          const forestLog = row.forestPct != null ? `${(row.forestPct * 100).toFixed(1)}%` : '?';
          onProgress(`  ✅ ${hromada.name}: forest=${forestLog}, wind=${row.windSpeed ?? '?'} m/s, emerald=${row.emerald || '-'}`);
        } catch (e) {
          onProgress(`  ❌ ${hromada.name}: ${e.message}`);
        }

        batchResults.push(row);
        
        // Pause between requests to avoid overwhelming Overpass
        await new Promise(r => setTimeout(r, 1000));
      }

      results.push(...batchResults);

      // Save periodically to reduce IO overhead
      if (results.length % PARTIAL_SAVE_EVERY === 0 || results.length === hromadas.length) {
        await buildXlsx(results, outputPath, oblastName);
        onProgress(`  💾 Partial save: ${results.length}/${hromadas.length} rows written`);
      }
    }

    // Final save
    await buildXlsx(results, outputPath, oblastName);
    onProgress(`\n✅ Done! ${results.length} hromadas → ${outputPath}`);
    return { success: true, outputPath, count: results.length };
  } finally {
    await browser.close();
  }
}

module.exports = { generateResearchXlsx, stopResearch };
