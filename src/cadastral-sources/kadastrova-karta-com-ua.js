'use strict';

const https = require('https');

function httpGet(url, headers = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };
    const timer = setTimeout(() => {
      req.destroy();
      done(reject, new Error(`Request timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    const req = https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        done(resolve, { statusCode: res.statusCode || 0, body });
      });
      res.on('error', (e) => done(reject, e));
    });
    req.on('error', (e) => done(reject, e));
  });
}

function geometryCentroid(geometry) {
  if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) return null;

  const rings = [];
  if (geometry.type === 'Polygon') {
    if (Array.isArray(geometry.coordinates[0])) rings.push(geometry.coordinates[0]);
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates) {
      if (Array.isArray(polygon) && Array.isArray(polygon[0])) rings.push(polygon[0]);
    }
  }

  const points = rings.flat().filter((pt) => Array.isArray(pt) && pt.length >= 2);
  if (!points.length) return null;

  let lonSum = 0;
  let latSum = 0;
  for (const [lon, lat] of points) {
    const nLon = Number(lon);
    const nLat = Number(lat);
    if (!Number.isFinite(nLon) || !Number.isFinite(nLat)) continue;
    lonSum += nLon;
    latSum += nLat;
  }

  const count = points.length;
  if (!count) return null;
  return { lat: latSum / count, lng: lonSum / count };
}

async function lookupByCadnum(cadnum) {
  const query = String(cadnum || '').trim();
  if (!query) throw new Error('Cadastral number is required');

  const url = `https://back.geoserver.click/api/landuse/${encodeURIComponent(query)}`;
  const { statusCode, body } = await httpGet(url, {
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json,text/plain,*/*',
  });

  if (statusCode !== 200) throw new Error(`Source responded with HTTP ${statusCode}`);

  let data;
  try {
    data = JSON.parse(body);
  } catch (_) {
    throw new Error('Source returned invalid JSON');
  }

  const center = geometryCentroid(data.geometry);
  if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)) {
    throw new Error('Source did not return valid parcel geometry');
  }

  return {
    lat: center.lat,
    lng: center.lng,
    responseSize: body.length,
    meta: {
      cadnum: data.cadnum || query,
      area: data.area ?? null,
      unitArea: data.unit_area || null,
      category: data.category || null,
      purposeCode: data.purpose_code || null,
      purpose: data.purpose || null,
      use: data.use || null,
      ownershipCode: data.ownershipcode || null,
      ownership: data.ownership || null,
      address: data.address || null,
      geometry: data.geometry || null,
      source: 'kadastrova_karta_ua',
    },
  };
}

module.exports = { lookupByCadnum };

