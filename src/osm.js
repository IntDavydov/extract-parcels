'use strict';

const https   = require('https');
const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const zlib    = require('zlib');
const { pipeline } = require('stream');
const { promisify } = require('util');
const pipelineAsync = promisify(pipeline);
const osmtogeojson = require('osmtogeojson');
const turfBuffer   = require('@turf/buffer').default || require('@turf/buffer');
const turfIntersect = require('@turf/intersect').default || require('@turf/intersect');
const toGeoJSON = require('@mapbox/togeojson');
const { DOMParser } = require('@xmldom/xmldom');

// Approximate polygon area in m² using the Shoelace formula with geodetic scaling
function polygonAreaM2(ring) {
  let area = 0;
  const n = ring.length;
  for (let i = 0; i < n - 1; i++) {
    area += ring[i][0] * ring[i + 1][1];
    area -= ring[i + 1][0] * ring[i][1];
  }
  const avgLat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
  const cosLat = Math.cos(avgLat * Math.PI / 180);
  return (Math.abs(area) / 2) * 111320 * 111320 * cosLat;
}

function featureAreaM2(f) {
  const g = f.geometry;
  if (!g) return 0;
  if (g.type === 'Polygon') return polygonAreaM2(g.coordinates[0]);
  if (g.type === 'MultiPolygon') return g.coordinates.reduce((s, poly) => s + polygonAreaM2(poly[0]), 0);
  return 0;
}

function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const crosses = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, coords) {
  if (!coords || !coords.length || !pointInRing(point, coords[0])) return false;
  for (let i = 1; i < coords.length; i++) if (pointInRing(point, coords[i])) return false;
  return true;
}

function pointInGeometry(point, geom) {
  if (!point || !geom) return false;
  if (geom.type === 'Polygon') return pointInPolygon(point, geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some((poly) => pointInPolygon(point, poly));
  return false;
}

function featureInsideGeometry(feature, geom) {
  if (!feature || !feature.geometry || !geom) return false;
  if (feature.geometry.type === 'Point') return pointInGeometry(feature.geometry.coordinates, geom);
  const centroid = featureCentroid(feature);
  return !!(centroid && pointInGeometry(centroid, geom));
}

function clipPolygonFeatureToGeometry(feature, geom) {
  if (!feature || !feature.geometry || !geom) return null;
  if (feature.geometry.type !== 'Polygon' && feature.geometry.type !== 'MultiPolygon') return null;
  const boundaryFeature = { type: 'Feature', properties: {}, geometry: geom };
  let clipped = null;
  try {
    clipped = turfIntersect({
      type: 'FeatureCollection',
      features: [feature, boundaryFeature],
    });
  } catch (_) {
    try { clipped = turfIntersect(feature, boundaryFeature); } catch (_) { clipped = null; }
  }
  if (!clipped || !clipped.geometry) return null;
  return { ...feature, geometry: clipped.geometry };
}

function featureProbePoint(f) {
  const g = f && f.geometry;
  if (!g) return null;
  if (g.type === 'Point') return g.coordinates;
  if (g.type === 'Polygon') return g.coordinates?.[0]?.[0] || null;
  if (g.type === 'MultiPolygon') return g.coordinates?.[0]?.[0]?.[0] || null;
  return null;
}

function featureCentroid(f) {
  const g = f && f.geometry;
  if (!g) return null;
  if (g.type === 'Point') return g.coordinates;
  
  // For Polygon/MultiPolygon, compute centroid from all exterior ring coordinates
  let allCoords = [];
  if (g.type === 'Polygon') {
    allCoords = g.coordinates[0] || [];
  } else if (g.type === 'MultiPolygon') {
    for (const poly of g.coordinates) {
      allCoords = allCoords.concat(poly[0] || []);
    }
  }
  
  if (allCoords.length === 0) return null;
  
  let sumLon = 0, sumLat = 0;
  for (const [lon, lat] of allCoords) {
    sumLon += lon;
    sumLat += lat;
  }
  return [sumLon / allCoords.length, sumLat / allCoords.length];
}

function cleanTextKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[’'`]/g, '\'')
    .replace(/[.,/\\()\-–—_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickSettlementName(props = {}) {
  return (
    props.name ||
    props.name1 ||
    props['name:uk'] ||
    props.official_name ||
    props.adm4_name1 ||
    props.adm4_name ||
    props.place_name ||
    ''
  );
}

function settlementSourceRank(source) {
  const s = String(source || '');
  if (s === 'hotosm_preferred') return 5;
  if (s === 'hotosm') return 4;
  if (s === 'osm_overpass_preferred') return 3;
  if (s === 'osm') return 2;
  if (s === 'admin4') return 1;
  return 0;
}

function dedupeAndNameSettlements(features, fallbackPrefix = 'Settlement') {
  const buckets = new Map();
  for (const f of features || []) {
    if (!f?.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) continue;
    const centroid = featureCentroid(f) || [0, 0];
    const area = featureAreaM2(f);
    const name = pickSettlementName(f.properties);
    const nameKey = cleanTextKey(name);
    const spatialKey = `${Math.round(centroid[0] * 1000)}|${Math.round(centroid[1] * 1000)}|${Math.round(area / 5000)}`;
    const key = `${nameKey || '__noname__'}|${spatialKey}`;
    const rank = settlementSourceRank(f.properties?._source);
    const prev = buckets.get(key);
    if (!prev || rank > prev.rank) buckets.set(key, { feature: f, rank });
  }

  const deduped = [...buckets.values()].map((x) => x.feature);
  let unnamedCounter = 1;
  return deduped.map((f) => {
    const rawName = pickSettlementName(f.properties);
    const safeName = String(rawName || '').trim();
    return {
      ...f,
      properties: {
        ...(f.properties || {}),
        name: safeName || `${fallbackPrefix} ${unnamedCounter++}`,
        _layer: 'Settlements',
        _type: 'settlement',
      },
    };
  });
}

function dedupeSettlementPins(pins) {
  const seen = new Set();
  const out = [];
  for (const p of pins || []) {
    const c = p?.geometry?.coordinates;
    if (!c || c.length < 2) continue;
    const name = pickSettlementName(p.properties);
    const key = `${Math.round(c[0] * 1e6)}|${Math.round(c[1] * 1e6)}|${cleanTextKey(name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...p,
      properties: {
        ...(p.properties || {}),
        name: String(name || '').trim() || 'Settlement Pin',
      },
    });
  }
  return out;
}

// Returns true if the polygon is at least minWidthM wide at its narrowest point
function isWideEnough(f, minWidthM) {
  try {
    const shrunk = turfBuffer(f, -(minWidthM / 2) / 1000, { units: 'kilometers' });
    return !!(shrunk && shrunk.geometry);
  } catch (_) {
    return false; // thin/degenerate polygons that fail turf are excluded
  }
}

function buildTieredSettlementBuffers(boundaries, options = {}) {
  const force700m = options.force700m !== false;
  const buffersSmall = [], buffersMedium = [], buffersLarge = [];
  let smallCount = 0, mediumCount = 0, largeCount = 0, partsCount = 0;
  for (const f of boundaries) {
    if (!f.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) continue;
    const polygonParts = f.geometry.type === 'Polygon'
      ? [f]
      : f.geometry.coordinates.map((coords, idx) => ({
          ...f,
          geometry: { type: 'Polygon', coordinates: coords },
          properties: { ...f.properties, _part_index: idx + 1, _part_total: f.geometry.coordinates.length },
        }));

    for (const part of polygonParts) {
      partsCount++;
      try {
        const areaM2 = featureAreaM2(part);
        const areaKm2 = areaM2 / 1_000_000;

        let bufferKm, tier, bufferType;
        if (force700m) {
          bufferKm = 0.7;
          tier = 'large';
          bufferType = 'buffer_700m';
          largeCount++;
        } else if (areaKm2 < 0.5) {
          bufferKm = 0.3;
          tier = 'small';
          bufferType = 'buffer_300m';
          smallCount++;
        } else if (areaKm2 < 2) {
          bufferKm = 0.5;
          tier = 'medium';
          bufferType = 'buffer_500m';
          mediumCount++;
        } else {
          bufferKm = 0.7;
          tier = 'large';
          bufferType = 'buffer_700m';
          largeCount++;
        }

        const buf = turfBuffer(part, bufferKm, { units: 'kilometers' });
        if (!buf) continue;
        const bufferFeature = {
          ...buf,
          properties: {
            name: f.properties.name,
            adm4_pcode: f.properties.adm4_pcode,
            area_km2: areaKm2.toFixed(3),
            buffer_size: `${bufferKm * 1000}m`,
            tier,
            part_index: part.properties?._part_index || 1,
            part_total: part.properties?._part_total || 1,
            _layer: 'Settlement Buffers',
            _type: bufferType,
          },
        };
        if (tier === 'small') buffersSmall.push(bufferFeature);
        else if (tier === 'medium') buffersMedium.push(bufferFeature);
        else buffersLarge.push(bufferFeature);
      } catch (_) {}
    }
  }
  return {
    buffersSmall,
    buffersMedium,
    buffersLarge,
    stats: { smallCount, mediumCount, largeCount, partsCount, totalBuffers: buffersSmall.length + buffersMedium.length + buffersLarge.length },
  };
}

const HUMDATA_ZIP_URL  = 'https://data.humdata.org/dataset/d23f529f-31e4-4021-a65b-13987e5cfb42/resource/681beb86-391b-4a08-8140-ca52e80fcdce/download/ukr_admin_boundaries.geojson.zip';
const HOTOSM_SETTLEMENTS_URL = 'https://s3.dualstack.us-east-1.amazonaws.com/production-raw-data-api/ISO3/UKR/populated_places/polygons/hotosm_ukr_populated_places_polygons_geojson.zip';
const HUMDATA_CACHE_DIR = path.join(os.homedir(), '.land-management-cache');
const HUMDATA_CACHE_ZIP = path.join(HUMDATA_CACHE_DIR, 'ukr_admin_boundaries.geojson.zip');
const HOTOSM_CACHE_ZIP = path.join(HUMDATA_CACHE_DIR, 'hotosm_ukr_populated_places.zip');

// ── HTTP helper ────────────────────────────────────────────
function httpGet(url, headers = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'land-management-app/1.0', ...headers } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpGet(res.headers.location, headers, timeoutMs));
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function httpGetBuffer(url, headers = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'land-management-app/1.0', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpGetBuffer(res.headers.location, headers, timeoutMs));
      }
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function httpPost(url, body, headers = {}, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const buf = Buffer.from(body);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + (urlObj.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': buf.length,
        'User-Agent': 'land-management-app/1.0',
        ...headers,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(buf);
    req.end();
  });
}

// ── HUMDATA: download zip once, cache to disk ─────────────
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(HUMDATA_CACHE_DIR)) fs.mkdirSync(HUMDATA_CACHE_DIR, { recursive: true });
    const file = fs.createWriteStream(destPath + '.tmp');
    const request = https.get(url, { headers: { 'User-Agent': 'land-management-app/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFile(res.headers.location, destPath, onProgress).then(resolve).catch(reject);
      }
      const total = parseInt(res.headers['content-length'] || '0');
      let received = 0;
      let lastPct = -1;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total) {
          const pct = Math.floor(received / total * 100);
          if (pct !== lastPct && pct % 10 === 0) { onProgress(`  ${pct}%…`); lastPct = pct; }
        }
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); fs.renameSync(destPath + '.tmp', destPath); resolve(); });
    });
    request.on('error', reject);
    request.setTimeout(120000, () => { request.destroy(); reject(new Error('Download timeout')); });
  });
}

// Extract one file from a zip using JSZip (cross-platform, no system deps)
function extractFileFromZip(zipPath, fileName) {
  const JSZip = require('jszip');
  const zipData = fs.readFileSync(zipPath);
  // JSZip is async — use a sync workaround via a temp promise resolution trick
  // We do it synchronously by running in a blocking-wait pattern via a shared buffer
  // Since Node doesn't have sync Promise resolution, write to tmp file from async context
  // — but callers can be made async. For now we use a sync-compatible approach:
  // Read zip synchronously using a simple PK/ZIP parser for single-file extraction.

  // Find the file entry using ZIP local file header parsing
  const buf = zipData;
  let offset = 0;
  while (offset < buf.length - 4) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // local file header signature
    const flags      = buf.readUInt16LE(offset + 6);
    const compression= buf.readUInt16LE(offset + 8);
    const compSize   = buf.readUInt32LE(offset + 18);
    const uncompSize = buf.readUInt32LE(offset + 22);
    const fnLen      = buf.readUInt16LE(offset + 26);
    const extraLen   = buf.readUInt16LE(offset + 28);
    const entryName  = buf.slice(offset + 30, offset + 30 + fnLen).toString('utf8');
    const dataOffset = offset + 30 + fnLen + extraLen;

    if (entryName === fileName || entryName.endsWith('/' + fileName)) {
      const compData = buf.slice(dataOffset, dataOffset + compSize);
      if (compression === 0) return compData; // stored
      if (compression === 8) {               // deflate
        const zlib = require('zlib');
        return zlib.inflateRawSync(compData);
      }
      throw new Error(`Unsupported ZIP compression method ${compression} for ${fileName}`);
    }
    offset = dataOffset + compSize;
    // skip data descriptor if present
    if (flags & 0x08) offset += 16;
  }
  throw new Error(`Cannot extract ${fileName} from zip: file not found in archive`);
}

async function ensureHumdataZip(onProgress) {
  const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  let needsDownload = false;
  
  if (!fs.existsSync(HUMDATA_CACHE_ZIP)) {
    needsDownload = true;
  } else {
    // Check cache age
    const stats = fs.statSync(HUMDATA_CACHE_ZIP);
    const ageMs = Date.now() - stats.mtimeMs;
    if (ageMs > CACHE_MAX_AGE_MS) {
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      onProgress(`⏰ HUMDATA cache is ${ageDays} days old (max 7), re-downloading…`);
      needsDownload = true;
      fs.unlinkSync(HUMDATA_CACHE_ZIP); // Delete old cache
    } else {
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      onProgress(`📦 Using cached HUMDATA boundaries (${ageDays} day(s) old): ${HUMDATA_CACHE_ZIP}`);
    }
  }
  
  if (needsDownload) {
    onProgress('📥 Downloading Ukraine admin boundaries from HUMDATA (81MB)…');
    await downloadFile(HUMDATA_ZIP_URL, HUMDATA_CACHE_ZIP, onProgress);
    onProgress('✅ Download complete, cached to: ' + HUMDATA_CACHE_ZIP);
  }
}

async function ensureHotosmSettlementsZip(onProgress) {
  const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  let needsDownload = false;
  
  if (!fs.existsSync(HOTOSM_CACHE_ZIP)) {
    needsDownload = true;
  } else {
    // Check cache age
    const stats = fs.statSync(HOTOSM_CACHE_ZIP);
    const ageMs = Date.now() - stats.mtimeMs;
    if (ageMs > CACHE_MAX_AGE_MS) {
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      onProgress(`⏰ HOTOSM cache is ${ageDays} days old (max 7), re-downloading…`);
      needsDownload = true;
      fs.unlinkSync(HOTOSM_CACHE_ZIP); // Delete old cache
    } else {
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      onProgress(`📦 Using cached HOTOSM settlements (${ageDays} day(s) old): ${HOTOSM_CACHE_ZIP}`);
    }
  }
  
  if (needsDownload) {
    onProgress('📥 Downloading HOTOSM Ukraine populated places from HUMDATA (~50MB)…');
    await downloadFile(HOTOSM_SETTLEMENTS_URL, HOTOSM_CACHE_ZIP, onProgress);
    onProgress('✅ HOTOSM settlements cached to: ' + HOTOSM_CACHE_ZIP);
  }
}

// ── HUMDATA: fetch settlements for territory ──────────────
async function fetchSettlementsFromHumdata(territory, bbox, onProgress, areaGeometry = null) {
  await ensureHumdataZip(onProgress);

  const usingCustomBoundary = !!areaGeometry;
  let matchedPcode = null;
  let matchedFeature = null;

  // Helper: get centroid of a feature geometry
  function featureCentroid(f) {
    if (!f.geometry) return null;
    const coords = f.geometry.type === 'Polygon'
      ? f.geometry.coordinates[0]
      : f.geometry.type === 'MultiPolygon'
        ? f.geometry.coordinates[0][0]
        : null;
    if (!coords || !coords.length) return null;
    let sumLon = 0, sumLat = 0;
    for (const [lon, lat] of coords) { sumLon += lon; sumLat += lat; }
    return [sumLon / coords.length, sumLat / coords.length];
  }

  function inBbox(centroid) {
    if (!centroid) return false;
    const [lon, lat] = centroid;
    return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
  }

  if (usingCustomBoundary) {
    matchedFeature = { type: 'Feature', geometry: areaGeometry, properties: { adm3_name: 'Custom boundary' } };
    onProgress('🔍 Using custom KMZ boundary filter for settlements…');
  } else {
    // 1. Find matching adm3_pcode by territory name
    onProgress('🔍 Matching territory to hromada pcode…');
    const admin3Raw = extractFileFromZip(HUMDATA_CACHE_ZIP, 'ukr_admin3.geojson');
    const admin3 = JSON.parse(admin3Raw.toString('utf8'));
    const searchName = normalizeTerritoryName(territory);

    for (const f of admin3.features) {
      const p = f.properties;
      const names = [p.adm3_name, p.adm3_name1, p.adm3_name2, p.adm3_name3].filter(Boolean).map(normalizeTerritoryName);
      // Require the core name token to match AND centroid to be inside the Nominatim bbox
      const nameHit = names.some(n => {
        const core = n.trim();
        return core === searchName || core.includes(searchName) || searchName.includes(core);
      });
      if (nameHit && inBbox(featureCentroid(f))) {
        matchedPcode = p.adm3_pcode;
        matchedFeature = f;
        onProgress(`  ✅ Matched hromada: ${p.adm3_name1 || p.adm3_name} (pcode: ${matchedPcode})`);
        break;
      }
    }

    // fallback: bbox intersection if name not matched
    if (!matchedPcode) {
      onProgress('  ⚠ No exact name match — using bbox intersection');
      for (const f of admin3.features) {
        if (!f.geometry) continue;
        const p = f.properties;
        // Compute centroid from geometry coordinates
        const coords = f.geometry.type === 'Polygon'
          ? f.geometry.coordinates[0]
          : f.geometry.coordinates[0][0]; // MultiPolygon
        let sumLon = 0, sumLat = 0, count = 0;
        for (const [lon, lat] of coords) { sumLon += lon; sumLat += lat; count++; }
        const cl = sumLon / count, clat = sumLat / count;
        if (cl >= bbox.west && cl <= bbox.east && clat >= bbox.south && clat <= bbox.north) {
          matchedPcode = p.adm3_pcode;
          matchedFeature = f;
          onProgress(`  → Using: ${p.adm3_name1 || p.adm3_name} (pcode: ${matchedPcode})`);
          break;
        }
      }
    }

    if (!matchedPcode) {
      const fuzzy = fuzzyMatchHumdata(territory, admin3.features);
      if (fuzzy) {
        const fb = featureBbox(fuzzy.f);
        if (bboxesIntersect(fb, bbox) || fuzzy.dist <= 3) {
          matchedPcode = fuzzy.f.properties.adm3_pcode;
          matchedFeature = fuzzy.f;
          onProgress(`  → Fuzzy fallback: ${fuzzy.name} (pcode: ${matchedPcode})`);
        }
      }
    }

    if (!matchedPcode) throw new Error('Could not match territory to a hromada in HUMDATA');
  }

  // Prepare bbox array for filtering
  const bboxArr = [bbox.south, bbox.west, bbox.north, bbox.east];

  //  2a. Fetch HOTOSM populated places (more accurate settlement boundaries from OSM)
  onProgress('🏘 Fetching HOTOSM populated places (OSM-derived settlement boundaries)…');
  await ensureHotosmSettlementsZip(onProgress);
  
  let hotosmSettlements = [];
  try {
    const geojsonRaw = extractFileFromZip(HOTOSM_CACHE_ZIP, 'hotosm_ukr_populated_places_polygons_geojson.geojson');
    const hotosmGeoJSON = JSON.parse(geojsonRaw.toString('utf8'));
    
    // Filter by bbox and hromada boundary
    for (const f of hotosmGeoJSON.features) {
      if (!f.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) continue;
      
      const fb = featureBbox(f);
      const fbArr = [fb.south, fb.west, fb.north, fb.east];
      if (!bboxesIntersect(fbArr, bboxArr)) continue;
      
      if (matchedFeature && matchedFeature.geometry) {
        const centroid = featureCentroid(f);
        if (!centroid || !pointInGeometry(centroid, matchedFeature.geometry)) continue;
      }
      
      hotosmSettlements.push({
        ...f,
        properties: {
          ...f.properties,
          name: f.properties.name || 'Settlement',
          _layer: 'Settlements',
          _type: 'settlement',
          _source: 'hotosm',
        },
      });
    }
    onProgress(`  → ${hotosmSettlements.length} HOTOSM settlement polygons found in area`);
  } catch (err) {
    onProgress(`  ⚠ HOTOSM extraction failed: ${err.message}, continuing with admin4 only`);
  }

  // 2b. Filter admin4 polygons by adm3_pcode → settlement boundaries (administrative)
  onProgress('📐 Extracting settlement boundaries from admin4 (administrative)…');
  const admin4Raw = extractFileFromZip(HUMDATA_CACHE_ZIP, 'ukr_admin4.geojson');
  const admin4 = JSON.parse(admin4Raw.toString('utf8'));
  const rawSettlementPolygons = usingCustomBoundary
    ? admin4.features.filter((f) => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
    : admin4.features.filter((f) => f.properties.adm3_pcode === matchedPcode);
  let settlementPolygons = rawSettlementPolygons.filter((f) => {
    const fb = featureBbox(f);
    const fbArr = [fb.south, fb.west, fb.north, fb.east];
    return bboxesIntersect(fbArr, bboxArr);
  });
  const afterBboxFilter = settlementPolygons.length;
  if (matchedFeature && matchedFeature.geometry && (matchedFeature.geometry.type === 'Polygon' || matchedFeature.geometry.type === 'MultiPolygon')) {
    const beforeCentroidFilter = settlementPolygons.length;
    settlementPolygons = settlementPolygons.filter((f) => {
      const centroid = featureCentroid(f);
      return centroid && pointInGeometry(centroid, matchedFeature.geometry);
    });
    const afterCentroidFilter = settlementPolygons.length;
    onProgress(`  → Bbox filter: ${rawSettlementPolygons.length} → ${afterBboxFilter}, Centroid filter: ${beforeCentroidFilter} → ${afterCentroidFilter}`);
  } else {
    onProgress(`  → ${settlementPolygons.length}/${rawSettlementPolygons.length} settlement polygons intersect selected area`);
  }

  // 3. Filter adminpoints by adm3_pcode and admin_level=4 → settlement pins
  onProgress('📍 Extracting settlement pins from adminpoints…');
  const pointsRaw = extractFileFromZip(HUMDATA_CACHE_ZIP, 'ukr_adminpoints.geojson');
  const pointsData = JSON.parse(pointsRaw.toString('utf8'));
  const rawSettlementPins = pointsData.features.filter(f =>
    f.properties.admin_level === 4 && (usingCustomBoundary || f.properties.adm3_pcode === matchedPcode)
  );
  let settlementPins = rawSettlementPins.filter((f) => {
    const c = f?.geometry?.coordinates;
    if (!c || c.length < 2) return false;
    const [lon, lat] = c;
    return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
  });
  if (matchedFeature && matchedFeature.geometry && (matchedFeature.geometry.type === 'Polygon' || matchedFeature.geometry.type === 'MultiPolygon')) {
    settlementPins = settlementPins.filter((f) => {
      const point = f?.geometry?.coordinates;
      return point && pointInGeometry(point, matchedFeature.geometry);
    });
  }
  onProgress(`  → ${settlementPins.length}/${rawSettlementPins.length} settlement pins inside selected area`);

  // 4. Merge HOTOSM and admin4: prefer HOTOSM (OSM-derived precise) over admin4 (administrative)
  onProgress('🔀 Merging HOTOSM and admin4 settlement boundaries…');
  const mergedBoundaries = [];
  const usedAdmin4Indices = new Set();
  
  // First, try to match HOTOSM settlements to admin4 by name and location
  for (const hotosmSett of hotosmSettlements) {
    const hotosmName = (hotosmSett.properties.name || '').toLowerCase().trim();
    const hotosmCentroid = featureCentroid(hotosmSett);
    
    let bestMatch = null;
    let bestScore = 0;
    
    for (let i = 0; i < settlementPolygons.length; i++) {
      if (usedAdmin4Indices.has(i)) continue;
      
      const admin4Sett = settlementPolygons[i];
      const admin4Name = (admin4Sett.properties.adm4_name1 || admin4Sett.properties.adm4_name || '').toLowerCase().trim();
      const admin4Centroid = featureCentroid(admin4Sett);
      
      if (hotosmCentroid && admin4Centroid) {
        const dx = hotosmCentroid[0] - admin4Centroid[0];
        const dy = hotosmCentroid[1] - admin4Centroid[1];
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        // Within ~3km
        if (dist < 0.03) {
          const nameMatch = hotosmName.includes(admin4Name) || admin4Name.includes(hotosmName) || hotosmName === admin4Name;
          const score = nameMatch ? (1 - dist * 20) : (0.2 - dist * 20);
          
          if (score > bestScore && score > 0.1) {
            bestScore = score;
            bestMatch = i;
          }
        }
      }
    }
    
    if (bestMatch !== null) {
      usedAdmin4Indices.add(bestMatch);
      // Use HOTOSM geometry (more precise), keep admin4 properties for consistency
      mergedBoundaries.push({
        ...hotosmSett,
        properties: {
          ...settlementPolygons[bestMatch].properties,
          name: settlementPolygons[bestMatch].properties.adm4_name1 || settlementPolygons[bestMatch].properties.adm4_name,
          _layer: 'Settlements',
          _type: 'settlement',
          _source: 'hotosm_preferred',
        },
      });
    } else {
      // HOTOSM settlement without admin4 match
      mergedBoundaries.push(hotosmSett);
    }
  }
  
  // Add remaining admin4 settlements that weren't matched by HOTOSM
  for (let i = 0; i < settlementPolygons.length; i++) {
    if (!usedAdmin4Indices.has(i)) {
      mergedBoundaries.push({
        ...settlementPolygons[i],
        properties: {
          ...settlementPolygons[i].properties,
          name: settlementPolygons[i].properties.adm4_name1 || settlementPolygons[i].properties.adm4_name,
          _layer: 'Settlements',
          _type: 'settlement',
          _source: 'admin4',
        },
      });
    }
  }
  
  const mergedBeforeDedupe = mergedBoundaries.length;
  let cleanedMergedBoundaries = dedupeAndNameSettlements(mergedBoundaries);
  onProgress(`  → Merged: ${hotosmSettlements.length} HOTOSM + ${settlementPolygons.length - usedAdmin4Indices.size} admin4-only = ${mergedBeforeDedupe} total (${cleanedMergedBoundaries.length} after dedupe)`);
  
  let boundaries = cleanedMergedBoundaries;
  if (usingCustomBoundary && areaGeometry) {
    const beforeBoundaries = boundaries.length;
    const beforePins = settlementPins.length;
    boundaries = boundaries
      .map((f) => clipPolygonFeatureToGeometry(f, areaGeometry))
      .filter(Boolean);
    boundaries = dedupeAndNameSettlements(boundaries, 'Custom Settlement');
    settlementPins = dedupeSettlementPins(settlementPins.filter((f) => featureInsideGeometry(f, areaGeometry)));
    onProgress(`  → Custom boundary clip: settlements ${beforeBoundaries} → ${boundaries.length}, pins ${beforePins} → ${settlementPins.length}`);
  }

  const pins = dedupeSettlementPins(settlementPins).map(f => ({
    ...f,
    properties: {
      ...f.properties,
      name: f.properties.name1 || f.properties.name,
      _layer: 'Settlements',
      _type: 'settlement_pin',
    },
  }));

  // 5. Create settlement buffers (default 700m)
  onProgress('📐 Creating settlement buffer zones…');
  const { buffersSmall, buffersMedium, buffersLarge, stats } = buildTieredSettlementBuffers(boundaries, {
    force700m: true,
  });
  onProgress(`  → ${stats.totalBuffers} buffers from ${stats.partsCount} settlement parts: forced 700m`);

  return { boundaries, pins, buffersSmall, buffersMedium, buffersLarge };
}
// Simple Levenshtein distance for fuzzy name matching
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function normalizeTerritoryName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.,/\\()\-–—_]/g, ' ')
    .replace(/\b(україна|ukraine)\b/g, ' ')
    .replace(/\b(область|район|громада|територіальна|міська|селищна|сільська|тергромада)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractNameTokens(s) {
  return [...new Set(normalizeTerritoryName(s).split(/\s+/).filter(w => w.length >= 3))];
}

function scoreNominatimResult(territory, result) {
  const queryTokens = extractNameTokens(territory);
  const text = `${result.display_name || ''} ${result.name || ''} ${result.type || ''} ${result.class || ''} ${
    result.address ? Object.values(result.address).join(' ') : ''
  }`.toLowerCase();
  const textNorm = normalizeTerritoryName(text);
  const textTokens = new Set(textNorm.split(/\s+/).filter(Boolean));
  let missing = 0;
  for (const t of queryTokens) {
    let matched = textTokens.has(t);
    if (!matched) {
      for (const token of textTokens) {
        if (token.startsWith(t) || t.startsWith(token)) { matched = true; break; }
      }
    }
    if (!matched) missing += 1;
  }
  let score = missing * 8;
  if ((result.class || '') === 'boundary') score -= 2;
  if ((result.type || '') === 'administrative') score -= 2;
  if ((result.addresstype || '') === 'administrative') score -= 1;
  if ((result.display_name || '').toLowerCase().includes('громада')) score -= 1;
  const importance = Number(result.importance || 0);
  if (Number.isFinite(importance)) score -= Math.min(3, importance * 3);
  return score;
}

// Fuzzy-match territory name against HUMDATA admin3 list
function fuzzyMatchHumdata(territory, admin3Features) {
  const q = normalizeTerritoryName(territory);
  let best = null, bestScore = Infinity;
  for (const f of admin3Features) {
    const p = f.properties;
    const names = [p.adm3_name, p.adm3_name1, p.adm3_name2, p.adm3_name3].filter(Boolean);
    for (const name of names) {
      const n = normalizeTerritoryName(name);
      const dist = levenshtein(q, n);
      // also check word-level overlap for long names
      const qWords = q.split(/\s+/);
      const nWords = n.split(/\s+/);
      const overlap = qWords.filter(w => nWords.some(nw => nw.startsWith(w) || w.startsWith(nw))).length;
      const score = dist - overlap * 2;
      if (score < bestScore) { bestScore = score; best = { f, name, dist, overlap }; }
    }
  }
  // Accept match if distance is reasonable relative to query length
  if (best && best.dist <= Math.max(4, Math.floor(q.length * 0.35))) return best;
  return null;
}

// Get bbox from a GeoJSON feature geometry
function featureBbox(f) {
  const coords = f.geometry.type === 'Polygon'
    ? f.geometry.coordinates[0]
    : f.geometry.coordinates.flat(2);
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < west) west = lon; if (lon > east) east = lon;
    if (lat < south) south = lat; if (lat > north) north = lat;
  }
  return { west, south, east, north };
}

async function getBbox(territory, onProgress, fallbackBbox) {
  // 1. Try Nominatim exact + short form
  const attempts = [
    territory,
    territory.replace(/\s+громада$/i, '').trim(),
    `${territory}, Україна`,
  ];
  let bestNominatim = null;
  let bestNominatimScore = Infinity;
  for (const q of [...new Set(attempts)]) {
    onProgress(`🔍 Looking up "${q}" via Nominatim…`);
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=8&addressdetails=1&countrycodes=ua&polygon_geojson=1`;
    try {
      const raw = await httpGet(url);
      const results = JSON.parse(raw);
      if (results.length) {
        for (const r of results) {
          const score = scoreNominatimResult(territory, r);
          if (score < bestNominatimScore) {
            bestNominatimScore = score;
            bestNominatim = r;
          }
        }
      }
    } catch (_) {}
  }
  if (bestNominatim && bestNominatimScore <= 3) {
    const [south, north, west, east] = bestNominatim.boundingbox.map(Number);
    onProgress(`📍 Found: ${bestNominatim.display_name}`);
    return { south, north, west, east, boundaryGeojson: bestNominatim.geojson || null, displayName: bestNominatim.display_name };
  }

  // 2. Fuzzy match against HUMDATA admin3 list (already cached)
  onProgress(`  ⚠ Nominatim ambiguous/miss — trying fuzzy match against Ukraine admin boundaries…`);
  try {
    await ensureHumdataZip(onProgress);
    const admin3Raw = extractFileFromZip(HUMDATA_CACHE_ZIP, 'ukr_admin3.geojson');
    const admin3 = JSON.parse(admin3Raw.toString('utf8'));
    const match = fuzzyMatchHumdata(territory, admin3.features);
    if (match) {
      onProgress(`  ✅ Fuzzy matched: "${match.name}" (edit distance: ${match.dist})`);
      const bbox = featureBbox(match.f);
      onProgress(`📦 Bbox: S${bbox.south} W${bbox.west} N${bbox.north} E${bbox.east}`);
      return { ...bbox, boundaryGeojson: match.f.geometry || null, displayName: match.name };
    }
    onProgress(`  ⚠ No close fuzzy match found`);
  } catch (e) {
    onProgress(`  ⚠ Fuzzy match failed: ${e.message}`);
  }

  if (bestNominatim) {
    const [south, north, west, east] = bestNominatim.boundingbox.map(Number);
    onProgress(`  ⚠ Using best Nominatim candidate: ${bestNominatim.display_name}`);
    return { south, north, west, east, boundaryGeojson: bestNominatim.geojson || null, displayName: bestNominatim.display_name };
  }

  // 3. Fall back to boundary KMZ bbox if provided
  if (fallbackBbox) {
    onProgress(`  ⚠ Using boundary KMZ bbox as final fallback`);
    const { west, south, east, north } = fallbackBbox;
    return { south, north, west, east, boundaryGeojson: null, displayName: territory };
  }

  throw new Error(`Territory "${territory}" not found — check spelling or attach a boundary KMZ`);
}

// ── Build Overpass QL query ────────────────────────────────
function buildQuery(layers, bbox) {
  const { south, west, north, east } = bbox;
  const b = `${south},${west},${north},${east}`;
  const expandBBoxKm = (km) => {
    const latPad = km / 111.32;
    const midLat = (south + north) / 2;
    const lonPad = km / (111.32 * Math.max(0.2, Math.cos(midLat * Math.PI / 180)));
    return `${south - latPad},${west - lonPad},${north + latPad},${east + lonPad}`;
  };
  const parts = [];

  if (layers.includes('power_lines'))  parts.push(`way[power=line](${b});`);
  if (layers.includes('towers')) {
    parts.push(`node[power=tower](${b});`);
    parts.push(`node[power=pole](${b});`);
  }
  if (layers.includes('substations')) {
    parts.push(`way[power=substation](${b});`);
    parts.push(`relation[power=substation](${b});`);
  }
  if (layers.includes('roads'))        parts.push(`way[highway](${b});`);
  if (layers.includes('settlements')) {
    parts.push(`relation[place~"^(city|town|village|hamlet|suburb)$"](${b});`);
    parts.push(`way[place~"^(city|town|village|hamlet|suburb)$"](${b});`);
    parts.push(`node[place~"^(city|town|village|hamlet|suburb)$"](${b});`);
  }
  if (layers.includes('water')) {
    parts.push(`way[waterway~"^(river|stream|canal|drain)$"](${b});`);
    parts.push(`relation[natural=water](${b});`);
    parts.push(`way[natural=water](${b});`);
    parts.push(`way[landuse=reservoir](${b});`);
  }
  if (layers.includes('forests')) {
    parts.push(`way[landuse=forest](${b});`);
    parts.push(`way[natural=wood](${b});`);
    parts.push(`relation[landuse=forest](${b});`);
    parts.push(`relation[natural=wood](${b});`);
  }
  if (layers.includes('emerald')) {
    parts.push(`relation[boundary=protected_area](${b});`);
    parts.push(`way[boundary=protected_area](${b});`);
  }
  if (layers.includes('airports')) {
    const b50 = expandBBoxKm(50);
    parts.push(`node["aeroway"~"^(aerodrome|airstrip|heliport|helipad)$"](${b50});`);
    parts.push(`way["aeroway"~"^(aerodrome|airstrip|heliport|helipad)$"](${b50});`);
    parts.push(`relation["aeroway"~"^(aerodrome|airstrip|heliport|helipad)$"](${b50});`);
    parts.push(`node["military"="airfield"](${b50});`);
    parts.push(`way["military"="airfield"](${b50});`);
    parts.push(`relation["military"="airfield"](${b50});`);
  }
  if (layers.includes('nuclear_plants')) {
    const b30 = expandBBoxKm(30);
    // Keep this query lightweight: relations for power infrastructure can be huge and slow.
    // For this layer we use node/way variants that cover practical NPP mapping in OSM.
    parts.push(`node["power"="plant"]["plant:source"="nuclear"](${b30});`);
    parts.push(`way["power"="plant"]["plant:source"="nuclear"](${b30});`);
    parts.push(`node["power"="generator"]["generator:source"="nuclear"](${b30});`);
    parts.push(`way["power"="generator"]["generator:source"="nuclear"](${b30});`);
    parts.push(`node["power"="plant"]["source"~"nuclear",i](${b30});`);
    parts.push(`way["power"="plant"]["source"~"nuclear",i](${b30});`);
    parts.push(`node["industrial"="nuclear"](${b30});`);
    parts.push(`way["industrial"="nuclear"](${b30});`);
  }

  return `[out:json][timeout:180];\n(\n  ${parts.join('\n  ')}\n);\nout body;\n>;\nout skel qt;`;
}

// ── Tag → layer name ───────────────────────────────────────
function classifyFeature(props) {
  const p = props || {};
  const asStr = (v) => String(v || '').toLowerCase();
  const hydroLike = /(^|[;,\s])(hydro|hydroelectric|water)([;,\s]|$)/i;
  const hydroFlag = hydroLike.test(asStr(p.source)) ||
    hydroLike.test(asStr(p['plant:source'])) ||
    hydroLike.test(asStr(p['generator:source'])) ||
    /(^|[;,\s])(ges|гес|hpp)([;,\s]|$)/i.test(asStr(p.name));
  if (p.power === 'line')                            return 'Power Lines';
  if (p.power === 'tower' || p.power === 'pole')     return 'Towers';
  if (p.power === 'substation')                      return 'Substations';
  if (p.highway)                                     return 'Roads';
  if (p.place && ['city','town','village','hamlet','suburb'].includes(p.place)) return 'Settlements';
  if (p.waterway || p.natural === 'water' || p.landuse === 'reservoir') return 'Water';
  if (p.landuse === 'forest' || p.natural === 'wood') return 'Forests';
  if (p.aeroway || p.military === 'airfield') return 'Airoports';
  if (
    !hydroFlag && (
      (p.power === 'plant' && (/nuclear/i.test(String(p['plant:source'] || '')) || /nuclear/i.test(String(p.source || '')))) ||
      (p.power === 'generator' && /nuclear/i.test(String(p['generator:source'] || ''))) ||
      p.industrial === 'nuclear'
    )
  ) return 'Nuclear Power Plants';
  if (p.boundary === 'protected_area' || p.protect_class) return 'Emerald Network';
  return null;
}

function isAirportActiveMajorOrMilitary(props) {
  const p = props || {};
  const asStr = (v) => String(v || '').trim().toLowerCase();
  const yes = (v) => ['yes', 'true', '1'].includes(asStr(v));

  const aeroway = asStr(p.aeroway);
  const military = asStr(p.military);
  const status = asStr(p.status);
  const airportType = asStr(p['aerodrome:type']);

  // Inactive/obsolete features
  const inactive = (
    asStr(p.disused) === 'yes' ||
    asStr(p.abandoned) === 'yes' ||
    asStr(p.demolished) === 'yes' ||
    asStr(p.proposed) === 'yes' ||
    asStr(p.construction) === 'yes' ||
    asStr(p['disused:aeroway']) !== '' ||
    asStr(p['abandoned:aeroway']) !== '' ||
    status === 'closed' ||
    status === 'inactive'
  );
  if (inactive) return false;

  const isMilitary = military === 'airfield' || military === 'yes';
  if (isMilitary) return true;

  // Exclude small/private/training-focused aviation facilities
  if (aeroway === 'airstrip' || aeroway === 'helipad' || aeroway === 'heliport') return false;
  if (airportType === 'private' || airportType === 'recreational' || airportType === 'gliding' || airportType === 'ultralight') return false;
  if (asStr(p['access']) === 'private') return false;
  if (asStr(p['usage']) === 'training') return false;
  if (asStr(p['sport']) === 'gliding') return false;

  // Keep only major/public-like aerodromes
  const hasMajorCode = !!asStr(p.iata) || !!asStr(p.icao) || !!asStr(p.ref);
  const scheduled = yes(p.scheduled_service);
  const publicType = ['international', 'domestic', 'regional', 'public', 'civil'].includes(airportType);
  return aeroway === 'aerodrome' && (hasMajorCode || scheduled || publicType);
}

function expandBBoxByKm(bbox, km) {
  const { south, west, north, east } = bbox;
  const latPad = km / 111.32;
  const midLat = (south + north) / 2;
  const lonPad = km / (111.32 * Math.max(0.2, Math.cos(midLat * Math.PI / 180)));
  return {
    south: south - latPad,
    west: west - lonPad,
    north: north + latPad,
    east: east + lonPad,
  };
}

function bboxCenterAndRadiusKm(bbox, extraKm = 0) {
  const centerLat = (bbox.south + bbox.north) / 2;
  const centerLon = (bbox.west + bbox.east) / 2;
  const dxKm = (bbox.east - bbox.west) * 111.32 * Math.cos(centerLat * Math.PI / 180);
  const dyKm = (bbox.north - bbox.south) * 111.32;
  const radiusKm = Math.max(1, Math.sqrt(dxKm * dxKm + dyKm * dyKm) / 2 + extraKm);
  return { centerLat, centerLon, radiusKm };
}

async function fetchNuclearFromWikidata(bbox, onProgress) {
  const expanded = expandBBoxByKm(bbox, 30);
  const { centerLat, centerLon, radiusKm } = bboxCenterAndRadiusKm(expanded, 0);
  const sparql = `
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX bd: <http://www.bigdata.com/rdf#>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
SELECT ?item ?itemLabel ?coord WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${centerLon} ${centerLat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm.toFixed(2)}" .
  }
  ?item wdt:P31/wdt:P279* wd:Q159719 .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "uk,en". }
}
LIMIT 250`;

  const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(sparql);
  const raw = await httpGet(url, { Accept: 'application/sparql-results+json' }, 40000);
  const data = JSON.parse(raw);
  const bindings = (data.results && data.results.bindings) || [];
  const features = [];
  for (const b of bindings) {
    const label = (b.itemLabel && b.itemLabel.value) || '';
    if (/(^|\s)(гес|hpp)(\s|$)/i.test(label) || /hydro/i.test(label)) continue;
    const wkt = b.coord && b.coord.value;
    const m = wkt && wkt.match(/^Point\(([-0-9.]+)\s+([-0-9.]+)\)$/);
    if (!m) continue;
    const lon = parseFloat(m[1]);
    const lat = parseFloat(m[2]);
    if (lon < expanded.west || lon > expanded.east || lat < expanded.south || lat > expanded.north) continue;
    const itemUrl = (b.item && b.item.value) || '';
    const qid = itemUrl.split('/').pop() || '';
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        name: label || qid || 'Nuclear plant',
        wikidata: qid,
        _layer: 'Nuclear Power Plants',
        _type: 'nuclear_power_plant',
        _source: 'Wikidata',
      },
    });
  }
  onProgress(`  → Wikidata fallback: ${features.length} nuclear site(s)`);
  return features;
}

async function fetchNuclearFromOSM(bbox, onProgress, totalTimeoutMs = 90000) {
  const expanded = expandBBoxByKm(bbox, 30);
  const b = `${expanded.south},${expanded.west},${expanded.north},${expanded.east}`;
  const ql = `[out:json][timeout:90];
(
  node["power"="plant"]["plant:source"="nuclear"](${b});
  way["power"="plant"]["plant:source"="nuclear"](${b});
  node["power"="generator"]["generator:source"="nuclear"](${b});
  way["power"="generator"]["generator:source"="nuclear"](${b});
  node["power"="plant"]["source"~"nuclear",i](${b});
  way["power"="plant"]["source"~"nuclear",i](${b});
  node["industrial"="nuclear"](${b});
  way["industrial"="nuclear"](${b});
);
out body;
>;
out skel qt;`;

  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];

  const startedAt = Date.now();
  let lastErr = null;
  for (const endpoint of endpoints) {
    const elapsed = Date.now() - startedAt;
    const remaining = totalTimeoutMs - elapsed;
    if (remaining <= 0) throw new Error(`OSM nuclear timeout after ${Math.round(totalTimeoutMs / 1000)}s`);
    const reqTimeout = Math.min(remaining, 35000);
    try {
      const raw = await httpPost(endpoint, `data=${encodeURIComponent(ql)}`, {}, reqTimeout);
      const trimmed = raw.trimStart();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        onProgress(`  ⚠ ${endpoint} returned non-JSON for nuclear query, trying next mirror…`);
        continue;
      }
      const osmData = JSON.parse(raw);
      const geojson = osmtogeojson(osmData);
      const npp = geojson.features
        .filter(f => classifyFeature(f.properties) === 'Nuclear Power Plants')
        .map(f => ({
          ...f,
          properties: {
            ...(f.properties || {}),
            _layer: 'Nuclear Power Plants',
            _type: 'nuclear_power_plant',
            _source: 'OSM',
          },
        }));
      onProgress(`  → OSM nuclear query returned ${npp.length} feature(s)`);
      return npp;
    } catch (e) {
      lastErr = e;
      onProgress(`  ⚠ ${endpoint} nuclear query failed: ${e.message}`);
    }
  }
  throw new Error(lastErr ? lastErr.message : 'All OSM nuclear query mirrors failed');
}

// ── PZF Ukraine: fetch Nature Reserves from pzf.land.kiev.ua ─
// Downloads KMZ files per category and oblast, parses KML, filters by bbox.

const PZF_BASE = 'https://pzf.land.kiev.ua/object/obj';

// All 17 PZF categories with their numeric IDs
const PZF_CATEGORIES = [
  { id: 1,  name: 'Природні заповідники' },
  { id: 2,  name: 'Біосферні заповідники' },
  { id: 3,  name: 'Національні природні парки' },
  { id: 4,  name: 'Регіональні ландшафтні парки' },
  { id: 5,  name: 'Заповідні урочища' },
  { id: 6,  name: 'Заказники загальнодержавного значення' },
  { id: 12, name: 'Заказники місцевого значення' },
  { id: 7,  name: 'Пам\'ятки природи загальнодержавного значення' },
  { id: 13, name: 'Пам\'ятки природи місцевого значення' },
  { id: 11, name: 'Ботанічні сади загальнодержавного значення' },
  { id: 17, name: 'Ботанічні сади місцевого значення' },
  { id: 9,  name: 'Дендрологічні парки загальнодержавного значення' },
  { id: 15, name: 'Дендрологічні парки місцевого значення' },
  { id: 10, name: 'Зоологічні парки загальнодержавного значення' },
  { id: 16, name: 'Зоологічні парки місцевого значення' },
  { id: 8,  name: 'Парки-пам\'ятки садово-паркового мистецтва загальнодержавного значення' },
  { id: 14, name: 'Парки-пам\'ятки садово-паркового мистецтва місцевого значення' },
];

// Oblast ID → name mapping (pzf.land.kiev.ua numbering)
const PZF_OBLASTS = {
  1: 'АР Крим', 2: 'Вінницька', 3: 'Волинська', 4: 'Дніпропетровська',
  5: 'Донецька', 6: 'Житомирська', 7: 'Закарпатська', 8: 'Запорізька',
  9: 'Івано-Франківська', 10: 'Київська', 11: 'Кіровоградська', 12: 'Луганська',
  13: 'Львівська', 14: 'Миколаївська', 15: 'Одеська', 16: 'Полтавська',
  17: 'Рівненська', 18: 'Сумська', 19: 'Тернопільська', 20: 'Харківська',
  21: 'Херсонська', 22: 'Хмельницька', 23: 'Черкаська', 24: 'Чернівецька',
  25: 'Чернігівська', 26: 'м. Київ',
};

// Rough bounding boxes for each oblast (for determining which oblasts to query)
const PZF_OBLAST_BBOX = {
  1:  [44.3,32.4,46.2,36.7],  // АР Крим
  2:  [48.0,27.3,49.6,30.3],  // Вінницька
  3:  [50.3,23.3,52.4,25.6],  // Волинська
  4:  [47.2,32.8,49.4,36.3],  // Дніпропетровська
  5:  [47.0,36.5,49.0,40.0],  // Донецька
  6:  [49.5,27.3,52.0,30.6],  // Житомирська
  7:  [47.7,22.1,49.1,24.7],  // Закарпатська
  8:  [46.8,34.6,48.0,37.1],  // Запорізька
  9:  [47.8,23.8,49.4,25.6],  // Івано-Франківська
  10: [49.3,29.2,51.6,32.2],  // Київська
  11: [47.7,31.0,49.3,33.3],  // Кіровоградська
  12: [47.5,37.8,50.0,40.3],  // Луганська
  13: [49.1,22.3,50.5,25.0],  // Львівська
  14: [46.6,30.9,48.4,33.3],  // Миколаївська
  15: [44.8,28.8,48.2,31.8],  // Одеська
  16: [48.5,32.8,50.4,35.6],  // Полтавська
  17: [50.0,25.2,51.9,27.7],  // Рівненська
  18: [50.3,33.0,52.4,35.6],  // Сумська
  19: [48.7,25.4,50.1,27.0],  // Тернопільська
  20: [49.0,35.4,50.4,37.6],  // Харківська
  21: [45.8,31.8,47.5,35.0],  // Херсонська
  22: [48.8,25.8,50.6,28.3],  // Хмельницька
  23: [48.7,30.3,50.0,32.3],  // Черкаська
  24: [47.7,25.0,48.6,26.8],  // Чернівецька
  25: [50.5,30.9,52.4,32.6],  // Чернігівська
  26: [50.2,30.2,50.6,30.9],  // м. Київ
};

function bboxesIntersect(a, b) {
  // a, b = [south, west, north, east]
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function kmlCoords(text) {
  return text.trim().split(/\s+/).map(pt => {
    const parts = pt.split(',').map(Number);
    return [parts[0], parts[1]];
  }).filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
}

function pathCoordsToClosedRing(coords) {
  if (!Array.isArray(coords) || coords.length < 3) return null;
  const ring = coords.map(([lng, lat]) => [lng, lat]).filter(([lng, lat]) =>
    Number.isFinite(lng) && Number.isFinite(lat)
  );
  if (ring.length < 3) return null;
  const [firstLng, firstLat] = ring[0];
  const [lastLng, lastLat] = ring[ring.length - 1];
  const isClosed = Math.abs(firstLng - lastLng) < 1e-9 && Math.abs(firstLat - lastLat) < 1e-9;
  if (!isClosed) ring.push([firstLng, firstLat]);
  return ring.length >= 4 ? ring : null;
}

function kmlNodeToGeometry(doc) {
  const DOMParser = require('@xmldom/xmldom').DOMParser;
  // Walk placemarks
  const features = [];
  const placemarks = doc.getElementsByTagName('Placemark');
  for (let i = 0; i < placemarks.length; i++) {
    const pm = placemarks[i];
    const nameEl = pm.getElementsByTagName('name')[0];
    const name = nameEl ? nameEl.textContent.trim() : '';
    let geometry = null;

    const polygon = pm.getElementsByTagName('Polygon')[0];
    const multiGeom = pm.getElementsByTagName('MultiGeometry')[0];
    const lineString = pm.getElementsByTagName('LineString')[0];
    const point = pm.getElementsByTagName('Point')[0];

    if (multiGeom) {
      const polys = multiGeom.getElementsByTagName('Polygon');
      const lines = multiGeom.getElementsByTagName('LineString');
      if (polys.length > 0) {
        const rings = [];
        for (let j = 0; j < polys.length; j++) {
          const outer = polys[j].getElementsByTagName('outerBoundaryIs')[0];
          if (!outer) continue;
          const coords = outer.getElementsByTagName('coordinates')[0];
          if (coords) rings.push([kmlCoords(coords.textContent)]);
        }
        geometry = rings.length === 1
          ? { type: 'Polygon', coordinates: rings[0] }
          : { type: 'MultiPolygon', coordinates: rings };
      } else if (lines.length > 0) {
        const paths = [];
        for (let j = 0; j < lines.length; j++) {
          const coords = lines[j].getElementsByTagName('coordinates')[0];
          if (!coords) continue;
          const path = kmlCoords(coords.textContent);
          if (path.length >= 2) paths.push(path);
        }
        if (paths.length === 1) geometry = { type: 'LineString', coordinates: paths[0] };
        else if (paths.length > 1) geometry = { type: 'MultiLineString', coordinates: paths };
      }
    } else if (polygon) {
      const outer = polygon.getElementsByTagName('outerBoundaryIs')[0];
      if (outer) {
        const coords = outer.getElementsByTagName('coordinates')[0];
        if (coords) {
          const inner = polygon.getElementsByTagName('innerBoundaryIs');
          const rings = [kmlCoords(coords.textContent)];
          for (let j = 0; j < inner.length; j++) {
            const ic = inner[j].getElementsByTagName('coordinates')[0];
            if (ic) rings.push(kmlCoords(ic.textContent));
          }
          geometry = { type: 'Polygon', coordinates: rings };
        }
      }
    } else if (lineString) {
      const coords = lineString.getElementsByTagName('coordinates')[0];
      if (coords) {
        const pathCoords = kmlCoords(coords.textContent);
        if (pathCoords.length >= 2) geometry = { type: 'LineString', coordinates: pathCoords };
      }
    } else if (point) {
      const coords = point.getElementsByTagName('coordinates')[0];
      if (coords) {
        const [lng, lat] = kmlCoords(coords.textContent)[0] || [];
        if (Number.isFinite(lng) && Number.isFinite(lat)) {
          geometry = { type: 'Point', coordinates: [lng, lat] };
        }
      }
    }

    if (geometry) features.push({ name, geometry });
  }
  return features;
}

async function loadBoundaryGeometryFromFile(filePath) {
  const JSZip = require('jszip');
  let kmlText;
  if (String(filePath).toLowerCase().endsWith('.kmz')) {
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    const kmlName = Object.keys(zip.files).find((f) => f.toLowerCase().endsWith('.kml'));
    if (!kmlName) throw new Error('No .kml inside KMZ boundary file');
    kmlText = await zip.files[kmlName].async('string');
  } else {
    kmlText = fs.readFileSync(filePath, 'utf8');
  }

  const doc = new DOMParser().parseFromString(kmlText, 'text/xml');
  const parsed = kmlNodeToGeometry(doc);
  const polygonLike = parsed.filter((f) =>
    f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')
  );
  const pathAsPolygons = parsed.flatMap((f) => {
    if (!f.geometry) return [];
    if (f.geometry.type === 'LineString') {
      const ring = pathCoordsToClosedRing(f.geometry.coordinates);
      if (!ring) return [];
      return [{ ...f, geometry: { type: 'Polygon', coordinates: [ring] } }];
    }
    if (f.geometry.type === 'MultiLineString') {
      const polys = [];
      for (const pathCoords of f.geometry.coordinates || []) {
        const ring = pathCoordsToClosedRing(pathCoords);
        if (ring) polys.push({ ...f, geometry: { type: 'Polygon', coordinates: [ring] } });
      }
      return polys;
    }
    return [];
  });
  const candidates = polygonLike.concat(pathAsPolygons);
  if (!candidates.length) {
    throw new Error('Boundary KMZ/KML has no polygon geometry or convertible paths');
  }

  const fileBaseName = path.basename(filePath, path.extname(filePath));
  const areas = candidates.map((candidate, idx) => ({
    geometry: candidate.geometry,
    name: (candidate.name && candidate.name.trim())
      ? candidate.name.trim()
      : (candidates.length > 1 ? `${fileBaseName} #${idx + 1}` : fileBaseName),
    bbox: featureBbox({ type: 'Feature', geometry: candidate.geometry, properties: {} }),
  }));

  // Use the largest polygon as the custom area filter.
  let selected = areas[0];
  let maxArea = featureAreaM2({ type: 'Feature', geometry: selected.geometry, properties: {} });
  for (let i = 1; i < areas.length; i++) {
    const area = featureAreaM2({ type: 'Feature', geometry: areas[i].geometry, properties: {} });
    if (area > maxArea) {
      maxArea = area;
      selected = areas[i];
    }
  }

  return {
    geometry: selected.geometry,
    name: selected.name || fileBaseName,
    bbox: selected.bbox,
    areas,
  };
}

async function fetchNatureReservesFromPZF(bbox, onProgress) {
  const JSZip = require('jszip');
  const { DOMParser } = require('@xmldom/xmldom');
  const bboxArr = [bbox.south, bbox.west, bbox.north, bbox.east];

  // Determine which oblasts overlap the area bbox
  const oblastIds = Object.entries(PZF_OBLAST_BBOX)
    .filter(([, ob]) => bboxesIntersect(bboxArr, ob))
    .map(([id]) => Number(id));

  onProgress(`  → ${oblastIds.length} oblast(s) intersect area: ${oblastIds.map(id => PZF_OBLASTS[id]).join(', ')}`);
  if (oblastIds.length === 0) return [];

  const allFeatures = [];
  let totalFiles = 0, loadedFiles = 0;

  // Build list of (category, oblast) pairs to fetch
  const jobs = [];
  for (const cat of PZF_CATEGORIES) {
    for (const oblId of oblastIds) {
      jobs.push({ cat, oblId });
    }
  }
  totalFiles = jobs.length;

  // Fetch KMZ files in bounded batches with per-job timeout, so one bad
  // endpoint response cannot stall the whole Nature Reserves step.
  const BATCH = 6;
  const JOB_TIMEOUT_MS = 20000;
  for (let i = 0; i < jobs.length; i += BATCH) {
    const batch = jobs.slice(i, i + BATCH);
    onProgress(`  → PZF progress: ${loadedFiles}/${totalFiles} files, ${allFeatures.length} features`);
    const results = await Promise.allSettled(batch.map(async ({ cat, oblId }) => {
      const url = `${PZF_BASE}/${cat.id}/p${cat.id}-${oblId}.kmz`;
      const fetchJob = (async () => {
        const buf = await httpGetBuffer(url, { 'Referer': 'https://pzf.land.kiev.ua/' }, 30000);
        if (!buf || buf.length < 100) return [];
        const zip = await JSZip.loadAsync(buf);
        const kmlFile = Object.keys(zip.files).find(f => f.endsWith('.kml'));
        if (!kmlFile) return [];
        const kmlText = await zip.files[kmlFile].async('string');
        const doc = new DOMParser().parseFromString(kmlText, 'text/xml');
        const parsed = kmlNodeToGeometry(doc);
        return parsed
          .filter(({ geometry }) => {
            const g = geometry;
            let testPt;
            if (g.type === 'Point') testPt = g.coordinates;
            else if (g.type === 'Polygon') testPt = g.coordinates[0][0];
            else if (g.type === 'MultiPolygon') testPt = g.coordinates[0][0][0];
            if (!testPt) return false;
            return testPt[1] >= bbox.south && testPt[1] <= bbox.north &&
                   testPt[0] >= bbox.west  && testPt[0] <= bbox.east;
          })
          .map(({ name, geometry }) => ({
            type: 'Feature',
            geometry,
            properties: {
              name,
              category: cat.name,
              _layer: 'Nature Reserves',
              _type: 'nature_reserve',
              _subtype: cat.name,
            },
          }));
      })();

      const timeoutJob = new Promise((resolve) => {
        setTimeout(() => resolve([]), JOB_TIMEOUT_MS);
      });

      return Promise.race([fetchJob, timeoutJob]);
    }));
    loadedFiles += batch.length;
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) allFeatures.push(...r.value);
    }
    onProgress(`  → ${loadedFiles}/${totalFiles} files fetched, ${allFeatures.length} features so far…`);
  }

  return allFeatures;
}

// ── EEA ArcGIS REST: fetch Emerald Network sites by bbox ───
// Paginates through all features (ArcGIS returns max 1000 per request)
async function fetchEmeraldFromEEA(bbox, onProgress) {
  const { south, west, north, east } = bbox;
  const BASE = 'https://bio.discomap.eea.europa.eu/arcgis/rest/services/ProtectedSites/EmeraldSites/MapServer/3/query';
  const geometry = encodeURIComponent(JSON.stringify({ xmin: west, ymin: south, xmax: east, ymax: north, spatialReference: { wkid: 4326 } }));
  const baseParams = `geometry=${geometry}&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&outFields=SITENAME,SITECODE,AREAHA,COUNTRY_CODE&returnGeometry=true&outSR=4326&f=json`;

  let allFeatures = [];
  let offset = 0;
  while (true) {
    const url = `${BASE}?${baseParams}&resultOffset=${offset}&resultRecordCount=1000`;
    const raw = await httpGet(url, { 'User-Agent': 'land-management-app/1.0' });
    let data;
    try { data = JSON.parse(raw); } catch (_) { break; }
    if (data.error) { onProgress(`⚠ EEA error: ${JSON.stringify(data.error)}`); break; }

    const features = (data.features || []).map(f => ({
      type: 'Feature',
      geometry: arcgisGeomToGeoJSON(f.geometry, data.geometryType),
      properties: {
        name: f.attributes.SITENAME,
        sitecode: f.attributes.SITECODE,
        area_ha: f.attributes.AREAHA,
        country: f.attributes.COUNTRY_CODE,
        _layer: 'Emerald Network',
        _source: 'EEA',
      },
    })).filter(f => f.geometry);

    allFeatures = allFeatures.concat(features);
    if (!data.exceededTransferLimit) break;
    offset += 1000;
    onProgress(`  → fetched ${allFeatures.length} so far…`);
  }
  return allFeatures;
}

function arcgisGeomToGeoJSON(geom, geomType) {
  if (!geom) return null;
  if (geomType === 'esriGeometryPoint') {
    return { type: 'Point', coordinates: [geom.x, geom.y] };
  }
  if (geomType === 'esriGeometryPolyline') {
    if (geom.paths.length === 1) return { type: 'LineString', coordinates: geom.paths[0] };
    return { type: 'MultiLineString', coordinates: geom.paths };
  }
  if (geomType === 'esriGeometryPolygon') {
    if (geom.rings.length === 1) return { type: 'Polygon', coordinates: geom.rings };
    return { type: 'MultiPolygon', coordinates: geom.rings.map(r => [r]) };
  }
  return null;
}

// ── NREL Sup3rWind Ukraine: fetch wind speed data by WKT polygon ───────────

// Reduce a polygon ring to at most maxPts vertices (keep first/last to stay closed)
function simplifyRing(ring, maxPts) {
  if (ring.length <= maxPts) return ring;
  const step = Math.ceil((ring.length - 1) / (maxPts - 1));
  const out = [];
  for (let i = 0; i < ring.length - 1; i += step) out.push(ring[i]);
  out.push(ring[0]); // close
  return out;
}

// Simplify to a single outer ring polygon with ≤ maxPts vertices
function simplifyGeojsonPolygon(geojson, maxPts = 60) {
  let ring;
  if (geojson.type === 'Polygon') {
    ring = geojson.coordinates[0];
  } else if (geojson.type === 'MultiPolygon') {
    // Use the outer ring of the largest polygon
    ring = geojson.coordinates.reduce((best, poly) =>
      poly[0].length > best.length ? poly[0] : best, []);
  } else {
    throw new Error('Unsupported geometry type for WKT: ' + geojson.type);
  }
  return { type: 'Polygon', coordinates: [simplifyRing(ring, maxPts)] };
}

function geojsonToWkt(geojson) {
  const coordRingToWkt = ring => ring.map(([lng, lat]) => `${lng} ${lat}`).join(',');
  if (geojson.type === 'Polygon') {
    return `POLYGON((${geojson.coordinates.map(coordRingToWkt).join('),(')})`;
  }
  if (geojson.type === 'MultiPolygon') {
    const polys = geojson.coordinates
      .map(poly => `(${poly.map(coordRingToWkt).join(',')})`)
      .join(',');
    return `MULTIPOLYGON(${polys})`;
  }
  throw new Error('Cannot convert geometry type to WKT: ' + geojson.type);
}

// Build a simple bbox rectangle WKT as a fallback
function bboxToWkt(bbox) {
  const { west, east, south, north } = bbox;
  return `POLYGON((${west} ${south},${east} ${south},${east} ${north},${west} ${north},${west} ${south}))`;
}

// Approximate polygon buffer in km — offsets each ring point outward by ~distKm
// Uses flat-earth approximation (fine for small distances up to a few km)
function bufferPolygonFeature(feature, distKm) {
  const DEG_PER_KM_LAT = 1 / 110.574;
  function bufferRing(ring, outward) {
    const n = ring.length;
    return ring.map((pt, i) => {
      const prev = ring[(i - 1 + n) % n];
      const next = ring[(i + 1) % n];
      // Average of the two edge normals
      const dx1 = pt[0] - prev[0], dy1 = pt[1] - prev[1];
      const dx2 = next[0] - pt[0],  dy2 = next[1] - pt[1];
      const nx = -(dy1 + dy2), ny = dx1 + dx2;
      const len = Math.sqrt(nx * nx + ny * ny) || 1;
      const latScale = Math.cos(pt[1] * Math.PI / 180) || 0.001;
      const dLat = (ny / len) * distKm * DEG_PER_KM_LAT * outward;
      const dLng = (nx / len) * distKm * DEG_PER_KM_LAT / latScale * outward;
      return [pt[0] + dLng, pt[1] + dLat];
    });
  }
  function bufferGeom(geom) {
    if (geom.type === 'Polygon') {
      return { type: 'Polygon', coordinates: geom.coordinates.map((ring, i) => bufferRing(ring, i === 0 ? 1 : -1)) };
    }
    if (geom.type === 'MultiPolygon') {
      return { type: 'MultiPolygon', coordinates: geom.coordinates.map(poly =>
        poly.map((ring, i) => bufferRing(ring, i === 0 ? 1 : -1))) };
    }
    return geom;
  }
  return { ...feature, geometry: bufferGeom(feature.geometry) };
}

// Parse NREL Sup3rWind CSV format:
// Row 1: "SiteID,12345,...,Longitude,30.75,Latitude,51.07" (inline key-value pairs)
// Row 2: "Year,Month,Day,Hour,Minute,wind speed at 100m (m/s)"
// Remaining rows: time-series data — average all values per site
function parseNrelCsv(csvText, attr) {
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 3) throw new Error('NREL CSV too short');

  // Parse first row as flat key-value pairs: k1,v1,k2,v2,...
  const metaCells = lines[0].split(',');
  const meta = {};
  for (let i = 0; i < metaCells.length - 1; i += 2) {
    meta[metaCells[i].trim().toLowerCase()] = metaCells[i + 1].trim();
  }

  const lat = parseFloat(meta['latitude']);
  const lon = parseFloat(meta['longitude']);
  if (isNaN(lat) || isNaN(lon)) {
    throw new Error(`Could not parse lat/lon from metadata: ${lines[0].slice(0, 120)}`);
  }

  // Row 2 is the data header
  const colHeaders = lines[1].split(',').map(h => h.trim().toLowerCase());

  // Match wind column: "wind speed at 100m (m/s)" or "windspeed_100m" etc.
  const hubM = attr.match(/(\d+)/);
  const hubNum = hubM ? hubM[1] : '';
  const windColIdx = colHeaders.findIndex(h =>
    h.includes(`${hubNum}m`) || h.includes('wind speed') || h.includes('windspeed')
  );
  if (windColIdx === -1) {
    throw new Error(`No wind column found. Headers: ${colHeaders.join(', ')}`);
  }

  // Average the wind speed over all time steps
  let sum = 0, count = 0;
  for (let i = 2; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const v = parseFloat(cells[windColIdx]);
    if (!isNaN(v)) { sum += v; count++; }
  }

  const avg = count > 0 ? Math.round((sum / count) * 10) / 10 : null;
  return [{
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      name:         `Wind ${avg != null ? avg : '?'} m/s avg`,
      windspeed_ms: avg,
      samples:      count,
      _layer:       'Wind Speed',
    },
  }];
}

async function fetchWindData(boundaryGeojson, bbox, windOptions, onProgress) {
  const { apiKey, hubHeight, year, email } = windOptions;
  const attr = `windspeed_${hubHeight}m`;
  onProgress(`💨 Requesting NREL Sup3rWind data at ${hubHeight}m (year ${year})…`);

  const endpoint = `https://developer.nrel.gov/api/wind-toolkit/v2/wind/sup3rwind-ukraine-download.json?api_key=${encodeURIComponent(apiKey)}`;

  // Sup3rWind Ukraine only reliably works with a bbox rectangle — skip polygon to save rate limit
  const wktAttempts = [
    { label: 'bounding box', wkt: bboxToWkt(bbox) },
  ];

  let json;
  for (const attempt of wktAttempts) {
    onProgress(`  → Trying ${attempt.label}…`);
    const postBody = [
      `wkt=${encodeURIComponent(attempt.wkt)}`,
      `attributes=${encodeURIComponent(attr)}`,
      `names=${year}`,
      `email=${encodeURIComponent(email)}`,
    ].join('&');

    const body = await httpPost(endpoint, postBody);
    onProgress(`  → NREL response received (${body.length} bytes)`);

    try { json = JSON.parse(body); } catch (_) {
      throw new Error('Non-JSON response from NREL API: ' + body.slice(0, 200));
    }

    // Check for data processing failure — retry with next attempt
    const hasError = json.errors && json.errors.length;
    const isProcessingError = hasError && JSON.stringify(json.errors).includes('processing');
    if (hasError) onProgress(`  ⚠ NREL full response: ${JSON.stringify(json).slice(0, 600)}`);
    if (isProcessingError && wktAttempts.indexOf(attempt) < wktAttempts.length - 1) {
      onProgress(`  ⚠ ${attempt.label} failed (${JSON.stringify(json.errors)}), retrying…`);
      json = null;
      continue;
    }
    if (hasError) throw new Error('NREL API error: ' + JSON.stringify(json.errors));
    break;
  }

  if (!json) throw new Error('All NREL polygon attempts failed');

  // NREL download APIs return a downloadUrl — fetch the CSV from it
  const downloadUrl =
    json.outputs?.downloadUrl ||
    json.outputs?.download_url ||
    json.download_url ||
    json.downloadUrl;

    if (!downloadUrl) {
    const rateLimited = json.error?.code === 'OVER_RATE_LIMIT';
    if (rateLimited) throw new Error('NREL rate limit hit — wait a minute and try again.');
    throw new Error('NREL API did not return a downloadUrl. Response: ' + JSON.stringify(json).slice(0, 400));
  }

  onProgress(`  → Downloading CSV from NREL…`);
  // NREL processes requests async — S3 file may not be ready immediately, poll with retries
  let rawBuf;
  for (let attempt = 1; attempt <= 20; attempt++) {
    rawBuf = await httpGetBuffer(downloadUrl);
    // Detect 404/XML error response (not a real ZIP or CSV)
    const preview = rawBuf.slice(0, 50).toString('utf8');
    if (preview.includes('<') && (preview.includes('404') || preview.includes('NoSuchKey') || preview.includes('Error'))) {
      if (attempt === 20) throw new Error('NREL file not ready after 20 attempts — falling back to GWA');
      onProgress(`  → File not ready yet, retrying in 30s (attempt ${attempt}/20)…`);
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }
    break;
  }
  onProgress(`  → Downloaded ${rawBuf.length} bytes`);

  let csv;
  // NREL returns a ZIP containing the CSV
  if (rawBuf[0] === 0x50 && rawBuf[1] === 0x4B) { // PK magic = ZIP
    onProgress(`  → Extracting CSV from ZIP…`);
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(rawBuf);
    const csvFile = Object.values(zip.files).find(f => f.name.endsWith('.csv') && !f.dir);
    if (!csvFile) throw new Error('No CSV file found inside NREL ZIP');
    csv = await csvFile.async('string');
    onProgress(`  → Extracted ${csvFile.name} (${csv.length} chars)`);
  } else {
    csv = rawBuf.toString('utf8');
  }

  onProgress(`  → CSV preview: ${csv.slice(0, 400).replace(/\n/g, ' | ')}`);
  const features = parseNrelCsv(csv, attr);
  onProgress(`  → ${features.length} wind data points created`);
  return features;
}

// ── Global Wind Atlas: fetch wind speed from COG via range requests ────────
// GWA3 Cloud-Optimized GeoTIFF sources for Ukraine.
// Each height lists candidate URLs tried in order; the first successful read wins.
const GWA_COG_URLS = {
  100: [
    'https://gwa.cdn.nazkamapps.com/country_tifs_v3/UKR_wind-speed_100m.tif',
    'https://gwa.cdn.nazkamapps.com/country_tifs_v4/UKR_wind-speed_100m.tif',
  ],
  150: [
    'https://gwa.cdn.nazkamapps.com/country_tifs_v3/UKR_wind-speed_150m.tif',
    'https://gwa.cdn.nazkamapps.com/country_tifs_v4/UKR_wind-speed_150m.tif',
  ],
};

// GWA color scale: wind speed (m/s) → [R, G, B]
function windSpeedToColor(v) {
  const stops = [
    [0,   [0x33, 0x33, 0xcc]],  // deep blue
    [3,   [0x33, 0x99, 0xff]],  // light blue
    [4,   [0x66, 0xdd, 0x00]],  // green
    [5,   [0xff, 0xee, 0x00]],  // yellow
    [6,   [0xff, 0xaa, 0x00]],  // amber
    [7,   [0xff, 0x66, 0x00]],  // orange
    [8,   [0xff, 0x22, 0x00]],  // red-orange
    [10,  [0xcc, 0x00, 0x00]],  // dark red
    [12,  [0x88, 0x00, 0x44]],  // maroon
  ];
  if (v <= stops[0][0]) return stops[0][1];
  if (v >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const t = (v - stops[i-1][0]) / (stops[i][0] - stops[i-1][0]);
      return stops[i-1][1].map((c, j) => Math.round(c + t * (stops[i][1][j] - c)));
    }
  }
  return stops[stops.length - 1][1];
}

// Build a PNG from a 2D array of wind speeds
function windArrayToPng(data, width, height) {
  const zlib = require('zlib');
  // Build raw RGBA scanlines
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let row = 0; row < height; row++) {
    raw[row * (1 + width * 4)] = 0; // filter byte
    for (let col = 0; col < width; col++) {
      const v = data[row * width + col];
      const [r, g, b] = isNaN(v) || v <= 0 ? [0, 0, 0] : windSpeedToColor(v);
      const a = (isNaN(v) || v <= 0) ? 0 : 180; // 70% opacity
      const off = row * (1 + width * 4) + 1 + col * 4;
      raw[off] = r; raw[off+1] = g; raw[off+2] = b; raw[off+3] = a;
    }
  }
  const compressed = zlib.deflateSync(raw);

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (const b of buf) {
      crc ^= b;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type);
    const crcBuf = Buffer.concat([typeB, data]);
    const crcVal = Buffer.alloc(4); crcVal.writeUInt32BE(crc32(crcBuf));
    return Buffer.concat([len, typeB, data, crcVal]);
  }

  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0); ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; ihdrData[9] = 6; // 8-bit RGBA
  const png = Buffer.concat([sig, chunk('IHDR', ihdrData), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
  return png;
}

async function fetchWindHeatmap(bbox, hubHeight, onProgress) {
  const { west, south, east, north } = bbox;
  const height = Number(hubHeight);
  onProgress(`🌬 Fetching wind speed from Global Wind Atlas GWA3 (${height}m)…`);

  let geotiff;
  try {
    geotiff = require('geotiff');
  } catch (e) {
    throw new Error('geotiff module not available: ' + e.message);
  }

  const candidates = GWA_COG_URLS[height] || GWA_COG_URLS[100];
  let tiff, lastErr;
  for (const url of candidates) {
    try {
      onProgress(`  → Trying ${url}`);
      tiff = await geotiff.fromUrl(url);
      break;
    } catch (e) {
      lastErr = e;
      onProgress(`  ⚠ Failed: ${e.message}`);
    }
  }
  if (!tiff) throw new Error(`No GWA source available for ${height}m: ${lastErr && lastErr.message}`);

  const image = await tiff.getImage(0);
  const cogBbox = image.getBoundingBox(); // [west, south, east, north]
  const W = image.getWidth(), H = image.getHeight();

  // Clamp request bbox to COG bounds
  const w = Math.max(west,  cogBbox[0]);
  const s = Math.max(south, cogBbox[1]);
  const e = Math.min(east,  cogBbox[2]);
  const n = Math.min(north, cogBbox[3]);

  // Convert geographic bbox to pixel window (COG stores north-to-south)
  const scaleX = W / (cogBbox[2] - cogBbox[0]);
  const scaleY = H / (cogBbox[3] - cogBbox[1]);
  const left   = Math.round((w - cogBbox[0]) * scaleX);
  const right  = Math.round((e - cogBbox[0]) * scaleX);
  const top    = Math.round((cogBbox[3] - n) * scaleY);
  const bottom = Math.round((cogBbox[3] - s) * scaleY);

  onProgress(`  → Reading ${right - left}×${bottom - top}px window from COG…`);
  const rasters = await image.readRasters({ window: [left, top, right, bottom] });
  const data = rasters[0]; // Float32Array of wind speeds
  const { width, height: h } = rasters;

  // Compute average wind speed from valid pixels
  let sum = 0, count = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v > 0 && isFinite(v)) { sum += v; count++; }
  }
  const avgSpeed = count > 0 ? Math.round((sum / count) * 10) / 10 : null;
  if (avgSpeed !== null) {
    onProgress(`  🌬 Average wind speed (${height}m): ${avgSpeed} m/s over ${count} pixels`);
  }

  // Sample a sparse grid of point placemarks (~8×8 max across the area)
  const GRID_STEPS = 8;
  const stepX = Math.max(1, Math.floor(width  / GRID_STEPS));
  const stepY = Math.max(1, Math.floor(h / GRID_STEPS));
  const windPoints = [];
  for (let row = Math.floor(stepY / 2); row < h; row += stepY) {
    for (let col = Math.floor(stepX / 2); col < width; col += stepX) {
      const v = data[row * width + col];
      if (!v || v <= 0 || !isFinite(v)) continue;
      const lon = w + (col + 0.5) / width  * (e - w);
      const lat = n - (row + 0.5) / h * (n - s);
      const spd = Math.round(v * 10) / 10;
      windPoints.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          name: `${spd} m/s`,
          windspeed_ms: spd,
          hub_height_m: height,
          source: 'GWA3',
          _layer: 'Wind Speed',
        },
      });
    }
  }

  onProgress(`  → Raster ${width}×${h} px, building PNG…`);
  const png = windArrayToPng(Array.from(data), width, h);
  onProgress(`  → GWA wind PNG generated (${png.length} bytes)`);

  return {
    overlays: [{ imageBuffer: png, west: w, south: s, east: e, north: n, tileKey: 'wind_heatmap', hubHeight: height }],
    points: windPoints,
    avgSpeed,
  };
}

async function fetchOSM(territory, layers, outputPath, format, onProgress, windOptions, fallbackBbox, customBoundaryInput = null) {
  const layerMap = {};
  const osmSettlementPolygons = [];

  // 1. Resolve bbox + boundary polygon
  let customBoundaryGeom = null;
  let customBoundaryAreas = [];
  const customBoundaryPaths = Array.isArray(customBoundaryInput)
    ? customBoundaryInput.filter(Boolean)
    : (customBoundaryInput ? [customBoundaryInput] : []);
  let bbox;
  if (customBoundaryPaths.length) {
    const total = customBoundaryPaths.length;
    for (let i = 0; i < total; i++) {
      const customBoundaryPath = customBoundaryPaths[i];
      onProgress(`🧭 Loading custom boundary ${i + 1}/${total}: ${customBoundaryPath}`);
      const customBoundary = await loadBoundaryGeometryFromFile(customBoundaryPath);
      const fileBaseName = path.basename(customBoundaryPath, path.extname(customBoundaryPath));
      const areas = (customBoundary.areas && customBoundary.areas.length)
        ? customBoundary.areas
        : [{ geometry: customBoundary.geometry, name: customBoundary.name || fileBaseName, bbox: customBoundary.bbox }];
      areas.forEach((area, idx) => {
        customBoundaryAreas.push({
          geometry: area.geometry,
          bbox: area.bbox,
          name: area.name || (areas.length > 1 ? `${fileBaseName} #${idx + 1}` : fileBaseName),
          sourceFile: fileBaseName,
        });
      });
      onProgress(`  → ${areas.length} custom area(s) found`);
    }
    if (!customBoundaryAreas.length) {
      throw new Error('No valid custom boundary areas were found');
    }
    const polygonCoords = customBoundaryAreas.flatMap((area) => {
      if (!area.geometry) return [];
      if (area.geometry.type === 'Polygon') return [area.geometry.coordinates];
      if (area.geometry.type === 'MultiPolygon') return area.geometry.coordinates;
      return [];
    });
    if (!polygonCoords.length) {
      throw new Error('Custom boundary areas must be polygons');
    }
    customBoundaryGeom = polygonCoords.length === 1
      ? { type: 'Polygon', coordinates: polygonCoords[0] }
      : { type: 'MultiPolygon', coordinates: polygonCoords };
    const south = Math.min(...customBoundaryAreas.map((a) => a.bbox.south));
    const west = Math.min(...customBoundaryAreas.map((a) => a.bbox.west));
    const north = Math.max(...customBoundaryAreas.map((a) => a.bbox.north));
    const east = Math.max(...customBoundaryAreas.map((a) => a.bbox.east));
    bbox = {
      south,
      west,
      north,
      east,
      boundaryGeojson: customBoundaryGeom,
      displayName: territory || (customBoundaryPaths.length === 1 ? customBoundaryAreas[0].sourceFile : 'Custom boundaries'),
    };
    onProgress(`📐 Custom boundaries bbox: ${bbox.south.toFixed(4)},${bbox.west.toFixed(4)} → ${bbox.north.toFixed(4)},${bbox.east.toFixed(4)}`);
  } else {
    bbox = await getBbox(territory, onProgress, fallbackBbox);
  }

  // Always add the territory boundary as a layer — as lines only so it never blocks clicks
  if (bbox.boundaryGeojson && !customBoundaryPaths.length) {
    onProgress(`🗺 Adding territory boundary: ${bbox.displayName}`);
    const g = bbox.boundaryGeojson;
    // Convert polygon rings → MultiLineString so Google Earth renders outline only (no fill intercepts clicks)
    let lineGeom = null;
    if (g.type === 'Polygon') {
      lineGeom = { type: 'MultiLineString', coordinates: g.coordinates };
    } else if (g.type === 'MultiPolygon') {
      lineGeom = { type: 'MultiLineString', coordinates: g.coordinates.flat() };
    } else {
      lineGeom = g;
    }
    layerMap['Territory Boundary'] = [{
      type: 'Feature',
      geometry: lineGeom,
      properties: { name: bbox.displayName, _layer: 'Territory Boundary', _type: 'boundary' },
    }];
  }

  // 2. Build + run Overpass query (only for non-wind, non-nuclear vector layers)
  const osmLayers = layers.filter(l => l !== 'wind' && l !== 'nuclear_plants');
  if (osmLayers.length > 0) {
    const query = buildQuery(osmLayers, bbox);
    onProgress('📡 Sending query to Overpass API…');

    let rawResponse;
    let osmData = null;
    let lastOverpassError = '';
    const overpassEndpoints = [
      'https://overpass.kumi.systems/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
      'https://overpass-api.de/api/interpreter',
    ];
    const maxRetryRounds = 5;
    const startedAt = Date.now();
    const totalTimeoutMs = 120000;
    for (let round = 1; round <= maxRetryRounds && !osmData; round++) {
      for (const endpoint of overpassEndpoints) {
        const elapsed = Date.now() - startedAt;
        const remaining = totalTimeoutMs - elapsed;
        if (remaining <= 0) {
          lastOverpassError = `Overpass total timeout (${Math.round(totalTimeoutMs / 1000)}s)`;
          onProgress(`  ⚠ ${lastOverpassError}, stopping retries`);
          break;
        }
        const reqTimeoutMs = Math.max(8000, Math.min(22000, remaining));
        try {
          rawResponse = await httpPost(endpoint, `data=${encodeURIComponent(query)}`, {}, reqTimeoutMs);
          const trimmed = rawResponse.trimStart();
          if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
            const preview = rawResponse.slice(0, 180).replace(/\n/g, ' ');
            lastOverpassError = `non-JSON response: ${preview}`;
            onProgress(`  ⚠ ${endpoint} returned non-JSON (attempt ${round}/${maxRetryRounds}), trying next mirror…`);
            continue;
          }
          try {
            osmData = JSON.parse(rawResponse);
            break;
          } catch (parseErr) {
            lastOverpassError = `JSON parse error: ${parseErr.message}`;
            onProgress(`  ⚠ ${endpoint} returned invalid JSON (attempt ${round}/${maxRetryRounds}), trying next mirror…`);
          }
        } catch (e) {
          lastOverpassError = e.message;
          onProgress(`  ⚠ ${endpoint} failed (${e.message}) (attempt ${round}/${maxRetryRounds}), trying next mirror…`);
        }
      }
      if (!osmData && round < maxRetryRounds) {
        const waitMs = round * 1500;
        onProgress(`  ↻ Overpass retry round ${round + 1}/${maxRetryRounds} in ${Math.round(waitMs / 1000)}s…`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    if (!osmData) {
      throw new Error(`Overpass failed after ${maxRetryRounds} retry rounds: ${lastOverpassError || 'no valid JSON response'}`);
    }

    if (osmData.remark) onProgress(`ℹ Overpass remark: ${osmData.remark}`);
    onProgress(`✅ Got ${osmData.elements?.length || 0} OSM elements`);

    // 3. Convert to GeoJSON
    onProgress('🔄 Converting to GeoJSON…');
    const geojson = osmtogeojson(osmData);
    onProgress(`  → ${geojson.features.length} features`);

    // 4. Split into layers — keep OSM settlement polygons as optional precision source.
    const boundaryGeom = bbox.boundaryGeojson && (bbox.boundaryGeojson.type === 'Polygon' || bbox.boundaryGeojson.type === 'MultiPolygon')
      ? bbox.boundaryGeojson
      : null;
    let osmSettlementCandidates = 0;
    let osmSettlementBboxFiltered = 0;
    let osmSettlementCentroidFiltered = 0;
    for (const f of geojson.features) {
      const layerName = classifyFeature(f.properties);
      if (!layerName || layerName === 'Emerald Network') continue;
      if (layerName === 'Settlements') {
        if (f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')) {
          osmSettlementCandidates++;
          const fb = featureBbox(f);
          const fbArr = [fb.south, fb.west, fb.north, fb.east];
          const bboxArr = [bbox.south, bbox.west, bbox.north, bbox.east];
          if (bboxesIntersect(fbArr, bboxArr)) {
            osmSettlementBboxFiltered++;
            if (boundaryGeom) {
              const centroid = featureCentroid(f);
              if (!centroid || !pointInGeometry(centroid, boundaryGeom)) {
                continue;
              }
              osmSettlementCentroidFiltered++;
            }
            osmSettlementPolygons.push({
              ...f,
              properties: {
                ...f.properties,
                name: (f.properties && (f.properties.name || f.properties['name:uk'] || f.properties.official_name)) || 'Settlement',
                _layer: 'Settlements',
                _type: 'settlement',
                _source: 'osm',
              },
            });
          }
        }
        continue;
      }
      if (!layerMap[layerName]) layerMap[layerName] = [];
      f.properties._layer = layerName;
      f.properties._type  = layerName.toLowerCase();
      layerMap[layerName].push(f);
    }

    // 4b. Inherit voltage from power lines onto tower/pole nodes.
    // OSM tower nodes rarely carry a voltage tag — it lives on the line way.
    // We build a flat list of all line segments, then for each tower find the
    // nearest line segment (within 500m) and copy its voltage.
    if (layerMap['Towers'] && layerMap['Power Lines']) {
      // Flatten all power line coords into segments with their voltage
      const segments = [];
      for (const line of layerMap['Power Lines']) {
        const v = line.properties && line.properties.voltage;
        if (!v) continue;
        const coords = line.geometry.type === 'LineString'
          ? line.geometry.coordinates
          : line.geometry.coordinates.flat();
        for (let i = 0; i < coords.length - 1; i++) {
          segments.push({ ax: coords[i][0], ay: coords[i][1], bx: coords[i+1][0], by: coords[i+1][1], voltage: v });
        }
      }

      if (segments.length) {
        // Point-to-segment distance squared (in degrees, good enough for proximity test)
        function distSqToSegment(px, py, ax, ay, bx, by) {
          const dx = bx - ax, dy = by - ay;
          const lenSq = dx*dx + dy*dy;
          if (lenSq === 0) return (px-ax)*(px-ax) + (py-ay)*(py-ay);
          const t = Math.max(0, Math.min(1, ((px-ax)*dx + (py-ay)*dy) / lenSq));
          return (px - ax - t*dx) ** 2 + (py - ay - t*dy) ** 2;
        }
        const MAX_DIST_DEG_SQ = (0.005) ** 2; // ~500m

        for (const tower of layerMap['Towers']) {
          if (tower.properties.voltage) continue; // already has voltage
          if (tower.geometry.type !== 'Point') continue;
          const [px, py] = tower.geometry.coordinates;
          let bestDist = Infinity, bestVoltage = null;
          for (const seg of segments) {
            const d = distSqToSegment(px, py, seg.ax, seg.ay, seg.bx, seg.by);
            if (d < bestDist) { bestDist = d; bestVoltage = seg.voltage; }
          }
          if (bestDist <= MAX_DIST_DEG_SQ && bestVoltage) {
            tower.properties.voltage = bestVoltage;
          }
        }
      }
    }

    // 4c. Build buffer zones from OSM layers
    const PAVED_ROAD_TYPES = new Set([
      'motorway','motorway_link','trunk','trunk_link',
      'primary','primary_link','secondary','secondary_link',
      'tertiary','tertiary_link','residential','unclassified','living_street',
    ]);

    // Water Buffers: 700m around water polygons
    if (layerMap['Water']) {
      const waterBufs = layerMap['Water']
        .filter(f => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
        .map(f => {
          try {
            const buf = turfBuffer(f, 0.7, { units: 'kilometers' });
            return buf ? { ...buf, properties: { ...f.properties, _layer: 'Water Buffers', _type: 'buffer_700m' } } : null;
          } catch (_) { return null; }
        }).filter(Boolean);
      if (waterBufs.length) layerMap['Water Buffers'] = waterBufs;
    }

    // Keep only polygon forests that are:
    //   • at least 50m wide (negative buffer test), AND
    //   • at least 1 ha in area (≥ 10 000 m²)
    // This eliminates narrow windbreaks, tree rows mapped as thin polygons,
    // and hedgerows — they would appear as lines and produce huge buffer corridors.
    // MIN_WIDTH_M=100 uses a −50m inward buffer; the test shows windbreaks
    // mapped up to ~90m wide in OSM still collapse and are excluded.
    if (layerMap['Forests']) {
      const MIN_WIDTH_M = 100;
      const MIN_AREA_M2 = 20000; // 2 hectares
      layerMap['Forests'] = layerMap['Forests'].filter(f => {
        const type = f.geometry && f.geometry.type;
        if (type !== 'Polygon' && type !== 'MultiPolygon') return false;
        if (featureAreaM2(f) < MIN_AREA_M2) return false;
        return isWideEnough(f, MIN_WIDTH_M);
      });
    }

    // Forest Buffers: configurable distance (default 700m) around forest polygons
    if (layerMap['Forests']) {
      const forestBufferMetersRaw = Number(windOptions && windOptions.forestBufferMeters);
      const forestBufferMeters = Number.isFinite(forestBufferMetersRaw) && forestBufferMetersRaw > 0
        ? forestBufferMetersRaw
        : 700;
      const forestBufferKm = forestBufferMeters / 1000;
      const forestBufs = layerMap['Forests']
        .filter(f => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
        .map(f => {
          try {
            const buf = turfBuffer(f, forestBufferKm, { units: 'kilometers' });
            return buf ? {
              ...buf,
              properties: {
                ...f.properties,
                buffer_size: `${Math.round(forestBufferMeters)}m`,
                _layer: 'Forest Buffers',
                _type: `buffer_${Math.round(forestBufferMeters)}m`,
              },
            } : null;
          } catch (_) { return null; }
        }).filter(Boolean);
      if (forestBufs.length) layerMap['Forest Buffers'] = forestBufs;
    }

    // Road Buffers: 400m around paved roads
    if (layerMap['Roads']) {
      const roadBufs = layerMap['Roads']
        .filter(f => f.geometry && PAVED_ROAD_TYPES.has(f.properties && f.properties.highway))
        .map(f => {
          try {
            const buf = turfBuffer(f, 0.4, { units: 'kilometers' });
            return buf ? { ...buf, properties: { ...f.properties, _layer: 'Road Buffers', _type: 'buffer_400m' } } : null;
          } catch (_) { return null; }
        }).filter(Boolean);
      if (roadBufs.length) layerMap['Road Buffers'] = roadBufs;
    }

    // Power Line Buffers: 250m around power lines
    if (layerMap['Power Lines']) {
      const powerLineBufs = layerMap['Power Lines']
        .filter(f => f.geometry)
        .map(f => {
          try {
            const buf = turfBuffer(f, 0.25, { units: 'kilometers' });
            return buf ? { ...buf, properties: { ...f.properties, _layer: 'Power Line Buffers', _type: 'buffer_250m' } } : null;
          } catch (_) { return null; }
        }).filter(Boolean);
      if (powerLineBufs.length) layerMap['Power Line Buffers'] = powerLineBufs;
    }

    // Airoports: keep only active military + major/public airports
    if (layerMap['Airoports']) {
      const before = layerMap['Airoports'].length;
      layerMap['Airoports'] = layerMap['Airoports'].filter(f => isAirportActiveMajorOrMilitary(f.properties));
      onProgress(`  → Airoports filtered: ${layerMap['Airoports'].length}/${before} kept (active military/major only)`);
    }

    // Airoports Buffer: 45km around all airport geometries
    if (layerMap['Airoports']) {
      const airportBufs = layerMap['Airoports']
        .filter(f => f.geometry)
        .map(f => {
          try {
            const buf = turfBuffer(f, 45, { units: 'kilometers' });
            return buf ? { ...buf, properties: { ...f.properties, _layer: 'Airoports Buffer', _type: 'buffer_45km' } } : null;
          } catch (_) { return null; }
        }).filter(Boolean);
      if (airportBufs.length) layerMap['Airoports Buffer'] = airportBufs;
    }

    onProgress(`  → Buffer zones: ${layerMap['Water Buffers'] ? layerMap['Water Buffers'].length : 0} water, ${layerMap['Forest Buffers'] ? layerMap['Forest Buffers'].length : 0} forest, ${layerMap['Road Buffers'] ? layerMap['Road Buffers'].length : 0} road, ${layerMap['Power Line Buffers'] ? layerMap['Power Line Buffers'].length : 0} power line, ${layerMap['Airoports Buffer'] ? layerMap['Airoports Buffer'].length : 0} airport`);
    if (osmSettlementCandidates > 0) {
      onProgress(`  → OSM settlements filter: ${osmSettlementCandidates} candidates → ${osmSettlementBboxFiltered} after bbox → ${boundaryGeom ? osmSettlementCentroidFiltered : osmSettlementBboxFiltered} after centroid → ${osmSettlementPolygons.length} final`);
    }
  } // end osmLayers block

  // 3. Nuclear power plants: OSM (90s cap) -> Wikidata fallback
  if (layers.includes('nuclear_plants')) {
    let nppFeatures = [];
    try {
      onProgress('☢ Fetching nuclear power plants from OSM (timeout: 90s)…');
      nppFeatures = await fetchNuclearFromOSM(bbox, onProgress, 90000);
    } catch (err) {
      onProgress(`  ⚠ OSM nuclear fetch failed/timed out: ${err.message}`);
    }
    if (!nppFeatures.length) {
      onProgress('☢ Falling back to Wikidata (nuclear power plants only)…');
      try {
        nppFeatures = await fetchNuclearFromWikidata(bbox, onProgress);
      } catch (err) {
        onProgress(`  ⚠ Wikidata fallback failed: ${err.message}`);
      }
    }
    if (nppFeatures.length) {
      layerMap['Nuclear Power Plants'] = nppFeatures;
      const nppBufs = nppFeatures
        .filter(f => f.geometry)
        .map(f => {
          try {
            const buf = turfBuffer(f, 30, { units: 'kilometers' });
            return buf ? { ...buf, properties: { ...f.properties, _layer: 'Nuclear Power Plants Buffer', _type: 'buffer_30km' } } : null;
          } catch (_) { return null; }
        }).filter(Boolean);
      if (nppBufs.length) layerMap['Nuclear Power Plants Buffer'] = nppBufs;
      onProgress(`  → Nuclear layer: ${nppFeatures.length} plants, ${nppBufs.length} buffers`);
    } else {
      onProgress('  ⚠ No nuclear power plants found in OSM or Wikidata for this area');
    }
  }

  // 4. Fetch settlements from HUMDATA (official Ukraine admin boundaries)
  if (layers.includes('settlements')) {
    if (customBoundaryAreas.length) {
      onProgress(`🏘 Using ${customBoundaryAreas.length} provided custom boundary area(s) as settlements…`);
      const customSettlements = [];
      const customBuffers = [];
      for (const area of customBoundaryAreas) {
        const customSettlementArea = {
          type: 'Feature',
          geometry: area.geometry,
          properties: {
            name: area.name || bbox.displayName || territory || 'Custom settlement area',
            _layer: 'Settlements',
            _type: 'settlement_area',
            _source: 'custom_boundary',
          },
        };
        const customSettlement = {
          ...customSettlementArea,
          properties: {
            ...customSettlementArea.properties,
            _layer: 'Settlements',
            _type: 'settlement',
          },
        };
        customSettlements.push(customSettlement);
        try {
          const customBuffer = turfBuffer(customSettlementArea, 0.7, { units: 'kilometers' });
          if (customBuffer && customBuffer.geometry) {
            customBuffer.properties = {
              name: customSettlement.properties.name,
              buffer_size: '700m',
              tier: 'large',
              _layer: 'Settlement Buffers',
              _type: 'buffer_700m',
              _source: 'custom_boundary',
            };
            customBuffers.push(customBuffer);
          }
        } catch (err) {
          onProgress(`  ⚠ Could not build custom settlement buffer for "${customSettlement.properties.name}": ${err.message}`);
        }
      }
      layerMap['Settlements'] = customSettlements;
      if (customBuffers.length) layerMap['Settlement Buffers'] = customBuffers;
      onProgress(`  → Created ${customSettlements.length} custom settlement area(s) + ${customBuffers.length} buffer(s) (700m)`);
      // Custom mode intentionally has no settlement pins.
      // Skip external settlement fetch/merge and continue with other requested layers.
    } else {
      onProgress('🏘 Fetching settlements from HUMDATA (official Ukraine admin data)…');
      try {
        const { boundaries, pins, buffersSmall, buffersMedium, buffersLarge } = await fetchSettlementsFromHumdata(
          territory,
          bbox,
          onProgress,
          customBoundaryGeom
        );
        let settlementPins = pins;
        let settlementBoundaries = boundaries;
        let small = buffersSmall, medium = buffersMedium, large = buffersLarge;

        // Merge OSM Overpass with HUMDATA (which already contains HOTOSM-preferred data)
        // Priority: HOTOSM > OSM Overpass > admin4
        if (osmSettlementPolygons.length > 0) {
          onProgress(`  → OSM settlement polygons found: ${osmSettlementPolygons.length}. Merging with HOTOSM/admin4...`);
          
          // Match OSM to existing boundaries by name proximity and location
          const usedBoundaryIndices = new Set();
          const mergedBoundaries = [];
          
          // First pass: keep all HOTOSM settlements (highest priority - never replace)
          for (let i = 0; i < boundaries.length; i++) {
            const boundary = boundaries[i];
            if (boundary.properties._source === 'hotosm_preferred' || boundary.properties._source === 'hotosm') {
              mergedBoundaries.push(boundary);
              usedBoundaryIndices.add(i);
            }
          }
          
          // Second pass: merge OSM Overpass with remaining (non-HOTOSM) boundaries
          for (const osmSett of osmSettlementPolygons) {
            const osmName = (osmSett.properties.name || '').toLowerCase().trim();
            const osmCentroid = featureCentroid(osmSett);
            
            // Try to find matching boundary (within 5km and similar name)
            let bestMatch = null;
            let bestScore = 0;
            
            for (let i = 0; i < boundaries.length; i++) {
              if (usedBoundaryIndices.has(i)) continue; // Skip HOTOSM and already matched
              
              const boundary = boundaries[i];
              const boundaryName = (boundary.properties.name || '').toLowerCase().trim();
              const boundaryCentroid = featureCentroid(boundary);
              
              // Simple distance check (rough)
              if (osmCentroid && boundaryCentroid) {
                const dx = osmCentroid[0] - boundaryCentroid[0];
                const dy = osmCentroid[1] - boundaryCentroid[1];
                const dist = Math.sqrt(dx * dx + dy * dy);
                
                // Within ~5km (rough degrees)
                if (dist < 0.05) {
                  // Name similarity (simple substring check)
                  const nameMatch = osmName.includes(boundaryName) || boundaryName.includes(osmName) || osmName === boundaryName;
                  const score = nameMatch ? (1 - dist * 10) : (0.3 - dist * 10);
                  
                  if (score > bestScore && score > 0.1) {
                    bestScore = score;
                    bestMatch = i;
                  }
                }
              }
            }
            
            if (bestMatch !== null) {
              usedBoundaryIndices.add(bestMatch);
              // Use OSM Overpass geometry, keep properties for consistency
              mergedBoundaries.push({
                ...osmSett,
                properties: {
                  ...boundaries[bestMatch].properties,
                  _layer: 'Settlements',
                  _type: 'settlement',
                  _source: 'osm_overpass_preferred',
                },
              });
            } else {
              // OSM settlement without match - add it
              mergedBoundaries.push(osmSett);
            }
          }
          
          // Add remaining boundaries (admin4-only) that weren't matched
          for (let i = 0; i < boundaries.length; i++) {
            if (!usedBoundaryIndices.has(i)) {
              mergedBoundaries.push(boundaries[i]);
            }
          }
          
          const hotosmCount = boundaries.filter(b => b.properties._source === 'hotosm_preferred' || b.properties._source === 'hotosm').length;
          const mergedBeforeDedupe = mergedBoundaries.length;
          settlementBoundaries = dedupeAndNameSettlements(mergedBoundaries);
          onProgress(`  → Final merge: ${hotosmCount} HOTOSM (kept) + ${osmSettlementPolygons.length} OSM Overpass + ${boundaries.length - hotosmCount - osmSettlementPolygons.length} admin4 = ${mergedBeforeDedupe} total (${settlementBoundaries.length} after dedupe)`);
          
          // Rebuild buffers from merged boundaries
          const mergedBuffers = buildTieredSettlementBuffers(settlementBoundaries, {
            force700m: true,
          });
          small = mergedBuffers.buffersSmall;
          medium = mergedBuffers.buffersMedium;
          large = mergedBuffers.buffersLarge;
          onProgress(`  → Merged settlement buffers: ${mergedBuffers.stats.totalBuffers} from ${mergedBuffers.stats.partsCount} parts`);
        }

        if (settlementBoundaries.length) layerMap['Settlements'] = settlementBoundaries;
        if (!customBoundaryGeom && settlementPins.length) layerMap['Settlement Pins'] = settlementPins;
        const settlementBuffers = [...small, ...medium, ...large];
        if (settlementBuffers.length)    layerMap['Settlement Buffers'] = settlementBuffers;
      } catch (err) {
        onProgress(`  ⚠ HUMDATA fetch failed: ${err.message}`);
      }
    }
  }

  // 5. Fetch Emerald Network from EEA official source
  if (layers.includes('emerald')) {
    onProgress('🌿 Fetching Emerald Network from EEA (official data)…');
    try {
      const emeraldFeatures = await fetchEmeraldFromEEA(bbox, onProgress);
      if (emeraldFeatures.length) {
        layerMap['Emerald Network'] = emeraldFeatures;
        layerMap['Emerald Buffer'] = emeraldFeatures
          .filter(f => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
          .map(f => {
            try {
              const buf = turfBuffer(f, 1, { units: 'kilometers' });
              return buf ? { ...buf, properties: { ...f.properties, _layer: 'Emerald Buffer' } } : null;
            } catch (_) { return null; }
          }).filter(Boolean);
        onProgress(`  → ${emeraldFeatures.length} Emerald sites fetched from EEA`);
      } else {
        onProgress('  ⚠ No Emerald sites found in this area');
      }
    } catch (err) {
      onProgress(`  ⚠ EEA fetch failed: ${err.message}`);
    }
  }

  // 7. Fetch Nature Reserves from pzf.land.kiev.ua
  if (layers.includes('nature_reserves')) {
    onProgress('🌿 Fetching Nature Reserves from PZF Ukraine (pzf.land.kiev.ua)…');
    try {
      const pzfFeatures = await fetchNatureReservesFromPZF(bbox, onProgress);
      if (pzfFeatures.length) {
        layerMap['Nature Reserves'] = pzfFeatures;
        layerMap['Nature Reserve Buffer'] = pzfFeatures
          .filter(f => !!f.geometry)
          .map(f => {
            try {
              const buf = turfBuffer(f, 1, { units: 'kilometers' });
              return buf ? { ...buf, properties: { ...f.properties, _layer: 'Nature Reserve Buffer' } } : null;
            } catch (_) { return null; }
          }).filter(Boolean);
        onProgress(`  → ${pzfFeatures.length} nature reserve features fetched`);
      } else {
        onProgress('  ⚠ No nature reserves found in this area');
      }
    } catch (err) {
      onProgress(`  ⚠ PZF fetch failed: ${err.message}`);
    }
  }

  // 8. Fetch Wind Speed from Global Wind Atlas (GWA3) — heatmap + sampled points
  const groundOverlays = [];
  if (layers.includes('wind') && windOptions) {
    try {
      const result = await fetchWindHeatmap(bbox, windOptions.hubHeight, onProgress);
      groundOverlays.push(...result.overlays);
      if (result.points.length) layerMap['Wind Speed'] = result.points;
      if (result.avgSpeed !== null) {
        onProgress(`📊 Area average wind speed at ${windOptions.hubHeight}m: ${result.avgSpeed} m/s`);
      }
    } catch (err) {
      onProgress(`  ⚠ Wind fetch failed: ${err.message}`);
    }
  }

  // 8. Print summary
  for (const [name, features] of Object.entries(layerMap)) {
    onProgress(`  ${name}: ${features.length} features`);
  }

  // 9. Save output
  if (format === 'kmz') {
    const { exportKMZ } = require('./kmz.js');
    await exportKMZ(layerMap, outputPath, onProgress, groundOverlays, 'Analytics');
  } else {
    const fc = {
      type: 'FeatureCollection',
      features: Object.values(layerMap).flat(),
    };
    fs.writeFileSync(outputPath, JSON.stringify(fc, null, 2));
    onProgress(`💾 Saved GeoJSON → ${outputPath}`);
  }

  return outputPath;
}

module.exports = { fetchOSM, getBbox, fetchNatureReservesFromPZF, fetchEmeraldFromEEA, fetchWindHeatmap, httpGet, httpPost, polygonAreaM2 };
