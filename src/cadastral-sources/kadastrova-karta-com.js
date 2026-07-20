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

async function lookupByCadnum(cadnum) {
  const query = String(cadnum || '').trim();
  if (!query) throw new Error('Cadastral number is required');

  const url = `https://kadastrova-karta.com/search?q=${encodeURIComponent(query)}`;
  const { statusCode, body } = await httpGet(url, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/vnd.turbo-stream.html, text/html, application/xhtml+xml',
    'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://kadastrova-karta.com/',
  });

  if (statusCode !== 200) throw new Error(`Source responded with HTTP ${statusCode}`);

  const latMatch = body.match(/data-lat="([^"]+)"/);
  const lngMatch = body.match(/data-lng="([^"]+)"/);
  if (!latMatch || !lngMatch) throw new Error('Parcel not found in source response');

  const lat = parseFloat(latMatch[1]);
  const lng = parseFloat(lngMatch[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('Source returned invalid coordinates');
  }

  return {
    lat,
    lng,
    responseSize: body.length,
    meta: { cadnum: query, source: 'kadastrova_karta' },
  };
}

module.exports = { lookupByCadnum };

