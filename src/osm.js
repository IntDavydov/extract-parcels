'use strict';

const https = require('https');
const http  = require('http');
const path  = require('path');
const fs    = require('fs');
const osmtogeojson = require('osmtogeojson');
const turfBuffer   = require('@turf/buffer').default || require('@turf/buffer');

// ── HTTP helper ────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'land-management-app/1.0', ...headers } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const buf = Buffer.from(body);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
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
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('Overpass request timeout')); });
    req.write(buf);
    req.end();
  });
}

// ── Nominatim: territory name → bbox ──────────────────────
async function getBbox(territory, onProgress) {
  onProgress(`🔍 Looking up "${territory}" via Nominatim…`);
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(territory)}&format=json&limit=1&addressdetails=1&countrycodes=ua`;
  const raw = await httpGet(url);
  const results = JSON.parse(raw);
  if (!results.length) throw new Error(`Territory "${territory}" not found on Nominatim`);
  const r = results[0];
  // Nominatim bbox: [south, north, west, east]
  const [south, north, west, east] = r.boundingbox.map(Number);
  onProgress(`📍 Found: ${r.display_name}`);
  onProgress(`📦 Bbox: S${south} W${west} N${north} E${east}`);
  return { south, north, west, east };
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

// ── Main export ────────────────────────────────────────────
async function fetchOSM(territory, layers, outputPath, format, onProgress) {
  // 1. Resolve bbox
  const bbox = await getBbox(territory, onProgress);

  // 2. Build + run Overpass query
  const query = buildQuery(layers, bbox);
  onProgress('📡 Sending query to Overpass API…');
  const rawResponse = await httpPost('https://overpass-api.de/api/interpreter', `data=${encodeURIComponent(query)}`);

  let osmData;
  try { osmData = JSON.parse(rawResponse); }
  catch (_) { throw new Error('Invalid response from Overpass API'); }

  if (osmData.remark) onProgress(`ℹ Overpass remark: ${osmData.remark}`);
  onProgress(`✅ Got ${osmData.elements?.length || 0} OSM elements`);

  // 3. Convert to GeoJSON
  onProgress('🔄 Converting to GeoJSON…');
  const geojson = osmtogeojson(osmData);
  onProgress(`  → ${geojson.features.length} features`);

  // 4. Split into layers
  const layerMap = {};
  for (const f of geojson.features) {
    const layerName = classifyFeature(f.properties);
    if (!layerName) continue;
    if (!layerMap[layerName]) layerMap[layerName] = [];
    f.properties._layer = layerName;
    f.properties._type  = layerName === 'Settlements' ? 'settlement' : layerName.toLowerCase();
    layerMap[layerName].push(f);
  }

  // 5. Add 700m buffer for settlements
  if (layerMap['Settlements']) {
    onProgress('📐 Creating 700m buffer zones for settlements…');
    const buffers = [];
    for (const f of layerMap['Settlements']) {
      if (f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')) {
        try {
          const buf = turfBuffer(f, 0.7, { units: 'kilometers' });
          if (buf) {
            buf.properties = { ...f.properties, _type: 'buffer_700m', name: f.properties.name };
            buffers.push(buf);
          }
        } catch (_) {}
      }
    }
    if (buffers.length) {
      if (!layerMap['Settlement Buffers']) layerMap['Settlement Buffers'] = [];
      layerMap['Settlement Buffers'].push(...buffers);
      onProgress(`  → ${buffers.length} buffer zones created`);
    }
  }

  // 6. Print summary
  for (const [name, features] of Object.entries(layerMap)) {
    onProgress(`  ${name}: ${features.length} features`);
  }

  // 7. Save output
  if (format === 'kmz') {
    const { exportKMZ } = require('./kmz.js');
    await exportKMZ(layerMap, outputPath, onProgress);
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
