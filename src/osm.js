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

const HUMDATA_ZIP_URL  = 'https://data.humdata.org/dataset/d23f529f-31e4-4021-a65b-13987e5cfb42/resource/681beb86-391b-4a08-8140-ca52e80fcdce/download/ukr_admin_boundaries.geojson.zip';
const HUMDATA_CACHE_DIR = path.join(os.homedir(), '.land-management-cache');
const HUMDATA_CACHE_ZIP = path.join(HUMDATA_CACHE_DIR, 'ukr_admin_boundaries.geojson.zip');

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

function httpPost(url, body, headers = {}) {
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
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('Request timeout')); });
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
  if (!fs.existsSync(HUMDATA_CACHE_ZIP)) {
    onProgress('📥 Downloading Ukraine admin boundaries from HUMDATA (81MB, one-time)…');
    await downloadFile(HUMDATA_ZIP_URL, HUMDATA_CACHE_ZIP, onProgress);
    onProgress('✅ Download complete, cached to: ' + HUMDATA_CACHE_ZIP);
  } else {
    onProgress('📦 Using cached HUMDATA boundaries: ' + HUMDATA_CACHE_ZIP);
  }
}

// ── HUMDATA: fetch settlements for territory ──────────────
async function fetchSettlementsFromHumdata(territory, bbox, onProgress) {
  await ensureHumdataZip(onProgress);

  // 1. Find matching adm3_pcode by territory name
  onProgress('🔍 Matching territory to hromada pcode…');
  const admin3Raw = extractFileFromZip(HUMDATA_CACHE_ZIP, 'ukr_admin3.geojson');
  const admin3 = JSON.parse(admin3Raw.toString('utf8'));

  const searchName = territory.toLowerCase();
  let matchedPcode = null;
  let matchedFeature = null;
  for (const f of admin3.features) {
    const p = f.properties;
    const names = [p.adm3_name, p.adm3_name1, p.adm3_name2, p.adm3_name3].filter(Boolean).map(n => n.toLowerCase());
    if (names.some(n => n.includes(searchName) || searchName.includes(n.split(' ')[0]))) {
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

  if (!matchedPcode) throw new Error('Could not match territory to a hromada in HUMDATA');

  // 2. Filter admin4 polygons by adm3_pcode → settlement boundaries
  onProgress('📐 Extracting settlement boundaries from admin4…');
  const admin4Raw = extractFileFromZip(HUMDATA_CACHE_ZIP, 'ukr_admin4.geojson');
  const admin4 = JSON.parse(admin4Raw.toString('utf8'));
  const settlementPolygons = admin4.features.filter(f => f.properties.adm3_pcode === matchedPcode);
  onProgress(`  → ${settlementPolygons.length} settlement polygons`);

  // 3. Filter adminpoints by adm3_pcode and admin_level=4 → settlement pins
  onProgress('📍 Extracting settlement pins from adminpoints…');
  const pointsRaw = extractFileFromZip(HUMDATA_CACHE_ZIP, 'ukr_adminpoints.geojson');
  const pointsData = JSON.parse(pointsRaw.toString('utf8'));
  const settlementPins = pointsData.features.filter(f =>
    f.properties.adm3_pcode === matchedPcode && f.properties.admin_level === 4
  );
  onProgress(`  → ${settlementPins.length} settlement pins`);

  // 4. Tag features
  const boundaries = settlementPolygons.map(f => ({
    ...f,
    properties: {
      ...f.properties,
      name: f.properties.adm4_name1 || f.properties.adm4_name,
      _layer: 'Settlements',
      _type: 'settlement',
    },
  }));

  const pins = settlementPins.map(f => ({
    ...f,
    properties: {
      ...f.properties,
      name: f.properties.name1 || f.properties.name,
      _layer: 'Settlements',
      _type: 'settlement_pin',
    },
  }));

  // 5. Create 700m buffers for polygons
  onProgress('📐 Creating 700m buffer zones for settlements…');
  const buffers = [];
  for (const f of boundaries) {
    if (!f.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) continue;
    try {
      const buf = turfBuffer(f, 0.7, { units: 'kilometers' });
      if (buf) {
        buffers.push({
          ...buf,
          properties: {
            name: f.properties.name,
            adm4_pcode: f.properties.adm4_pcode,
            _layer: 'Settlement Buffers',
            _type: 'buffer_700m',
          },
        });
      }
    } catch (_) {}
  }
  onProgress(`  → ${buffers.length} buffer zones created`);

  return { boundaries, pins, buffers };
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

// Fuzzy-match territory name against HUMDATA admin3 list
function fuzzyMatchHumdata(territory, admin3Features) {
  const q = territory.toLowerCase().replace(/\s+громада$/i, '').trim();
  let best = null, bestScore = Infinity;
  for (const f of admin3Features) {
    const p = f.properties;
    const names = [p.adm3_name, p.adm3_name1, p.adm3_name2, p.adm3_name3].filter(Boolean);
    for (const name of names) {
      const n = name.toLowerCase().replace(/\s+громада$/i, '').trim();
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
  const attempts = [territory, territory.replace(/\s+громада$/i, '').trim()];
  for (const q of [...new Set(attempts)]) {
    onProgress(`🔍 Looking up "${q}" via Nominatim…`);
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=1&countrycodes=ua&polygon_geojson=1`;
    try {
      const raw = await httpGet(url);
      const results = JSON.parse(raw);
      if (results.length) {
        const r = results[0];
        const [south, north, west, east] = r.boundingbox.map(Number);
        onProgress(`📍 Found: ${r.display_name}`);
        return { south, north, west, east, boundaryGeojson: r.geojson || null, displayName: r.display_name };
      }
    } catch (_) {}
  }

  // 2. Fuzzy match against HUMDATA admin3 list (already cached)
  onProgress(`  ⚠ Nominatim miss — trying fuzzy match against Ukraine admin boundaries…`);
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

  return `[out:json][timeout:180];\n(\n  ${parts.join('\n  ')}\n);\nout body;\n>;\nout skel qt;`;
}

// ── Tag → layer name ───────────────────────────────────────
function classifyFeature(props) {
  const p = props || {};
  if (p.power === 'line')                            return 'Power Lines';
  if (p.power === 'tower' || p.power === 'pole')     return 'Towers';
  if (p.power === 'substation')                      return 'Substations';
  if (p.highway)                                     return 'Roads';
  if (p.place && ['city','town','village','hamlet','suburb'].includes(p.place)) return 'Settlements';
  if (p.waterway || p.natural === 'water' || p.landuse === 'reservoir') return 'Water';
  if (p.landuse === 'forest' || p.natural === 'wood') return 'Forests';
  if (p.boundary === 'protected_area' || p.protect_class) return 'Emerald Network';
  return null;
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
const GWA_COG_URLS = {
  80:  'https://gwa.cdn.nazkamapps.com/country_tifs_v4/UKR_wind-speed_80m.tif',
  100: 'https://gwa.cdn.nazkamapps.com/country_tifs_v4/UKR_wind-speed_100m.tif',
  120: 'https://gwa.cdn.nazkamapps.com/country_tifs_v4/UKR_wind-speed_120m.tif',
  160: 'https://gwa.cdn.nazkamapps.com/country_tifs_v4/UKR_wind-speed_160m.tif',
  200: 'https://gwa.cdn.nazkamapps.com/country_tifs_v4/UKR_wind-speed_200m.tif',
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
  onProgress(`🌬 Fetching wind speed from Global Wind Atlas (${hubHeight}m)…`);

  const cogUrl = GWA_COG_URLS[hubHeight] || GWA_COG_URLS[100];
  let geotiff;
  try {
    geotiff = require('geotiff');
  } catch (e) {
    throw new Error('geotiff module not available: ' + e.message);
  }

  const tiff = await geotiff.fromUrl(cogUrl);
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
  const { width, height } = rasters;

  onProgress(`  → Raster ${width}×${height} px, building PNG…`);
  const png = windArrayToPng(Array.from(data), width, height);
  onProgress(`  → GWA wind PNG generated (${png.length} bytes)`);

  return [{ imageBuffer: png, west: w, south: s, east: e, north: n, tileKey: 'wind_heatmap' }];
}

async function fetchOSM(territory, layers, outputPath, format, onProgress, windOptions, fallbackBbox) {
  const layerMap = {};

  // 1. Resolve bbox + boundary polygon
  const bbox = await getBbox(territory, onProgress, fallbackBbox);

  // Always add the territory boundary as a layer — as lines only so it never blocks clicks
  if (bbox.boundaryGeojson) {
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

  // 2. Build + run Overpass query (only if there are OSM vector layers to fetch)
  const osmLayers = layers.filter(l => l !== 'wind');
  if (osmLayers.length > 0) {
    const query = buildQuery(osmLayers, bbox);
    onProgress('📡 Sending query to Overpass API…');

    let rawResponse;
    const overpassEndpoints = [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    ];
    for (const endpoint of overpassEndpoints) {
      try {
        rawResponse = await httpPost(endpoint, `data=${encodeURIComponent(query)}`);
        if (rawResponse.trimStart().startsWith('{') || rawResponse.trimStart().startsWith('[')) break;
        onProgress(`  ⚠ ${endpoint} returned non-JSON, trying next mirror…`);
      } catch (_) {
        onProgress(`  ⚠ ${endpoint} failed, trying next mirror…`);
      }
    }

    let osmData;
    try { osmData = JSON.parse(rawResponse); }
    catch (_) {
      const preview = rawResponse.slice(0, 300).replace(/\n/g, ' ');
      throw new Error(`Overpass returned non-JSON: ${preview}`);
    }

    if (osmData.remark) onProgress(`ℹ Overpass remark: ${osmData.remark}`);
    onProgress(`✅ Got ${osmData.elements?.length || 0} OSM elements`);

    // 3. Convert to GeoJSON
    onProgress('🔄 Converting to GeoJSON…');
    const geojson = osmtogeojson(osmData);
    onProgress(`  → ${geojson.features.length} features`);

    // 4. Split into layers — skip settlements and emerald (fetched from better sources)
    for (const f of geojson.features) {
      const layerName = classifyFeature(f.properties);
      if (!layerName || layerName === 'Emerald Network' || layerName === 'Settlements') continue;
      if (!layerMap[layerName]) layerMap[layerName] = [];
      f.properties._layer = layerName;
      f.properties._type  = layerName.toLowerCase();
      layerMap[layerName].push(f);
    }
  } // end osmLayers block

  // 5. Fetch settlements from HUMDATA (official Ukraine admin boundaries)
  if (layers.includes('settlements')) {
    onProgress('🏘 Fetching settlements from HUMDATA (official Ukraine admin data)…');
    try {
      const { boundaries, pins, buffers } = await fetchSettlementsFromHumdata(territory, bbox, onProgress);
      if (boundaries.length) layerMap['Settlements'] = boundaries;
      if (pins.length)       layerMap['Settlement Pins'] = pins;
      if (buffers.length)    layerMap['Settlement Buffers'] = buffers;
    } catch (err) {
      onProgress(`  ⚠ HUMDATA fetch failed: ${err.message}`);
    }
  }

  // 6. Fetch Emerald Network from EEA official source
  if (layers.includes('emerald')) {
    onProgress('🌿 Fetching Emerald Network from EEA (official data)…');
    try {
      const emeraldFeatures = await fetchEmeraldFromEEA(bbox, onProgress);
      if (emeraldFeatures.length) {
        layerMap['Emerald Network'] = emeraldFeatures;
        onProgress(`  → ${emeraldFeatures.length} Emerald sites fetched from EEA`);
      } else {
        onProgress('  ⚠ No Emerald sites found in this area');
      }
    } catch (err) {
      onProgress(`  ⚠ EEA fetch failed: ${err.message}`);
    }
  }

  // 7. Fetch Wind Speed from NREL Sup3rWind Ukraine + GWA heatmap
  const groundOverlays = [];
  if (layers.includes('wind') && windOptions) {
    try {
      const windFeatures = await fetchWindData(bbox.boundaryGeojson, bbox, windOptions, onProgress);
      if (windFeatures.length) layerMap['Wind Speed'] = windFeatures;
    } catch (err) {
      onProgress(`  ⚠ NREL unavailable: ${err.message}`);
      onProgress(`  → Falling back to Global Wind Atlas (GWA) heatmap…`);
    }
    // Always try GWA heatmap regardless of NREL result
    try {
      const tiles = await fetchWindHeatmap(bbox, windOptions.hubHeight, onProgress);
      groundOverlays.push(...tiles);
    } catch (err) {
      onProgress(`  ⚠ Wind heatmap fetch failed: ${err.message}`);
    }
  }

  // 8. Print summary
  for (const [name, features] of Object.entries(layerMap)) {
    onProgress(`  ${name}: ${features.length} features`);
  }

  // 9. Save output
  if (format === 'kmz') {
    const { exportKMZ } = require('./kmz.js');
    await exportKMZ(layerMap, outputPath, onProgress, groundOverlays);
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

module.exports = { fetchOSM };
