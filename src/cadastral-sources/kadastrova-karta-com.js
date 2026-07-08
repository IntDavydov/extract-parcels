'use strict';

const https = require('https');

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode || 0, body });
      });
    }).on('error', reject);
  });
}

async function lookupByCadnum(cadnum) {
  const query = String(cadnum || '').trim();
  if (!query) throw new Error('Cadastral number is required');

  const url = `https://kadastrova-karta.com/search?q=${encodeURIComponent(query)}`;
  const { statusCode, body } = await httpGet(url, {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/vnd.turbo-stream.html, text/html, application/xhtml+xml',
    'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
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

