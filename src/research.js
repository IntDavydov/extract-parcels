'use strict';

const { getBbox, fetchNatureReservesFromPZF, fetchEmeraldFromEEA, fetchWindHeatmap, httpGet, httpPost, polygonAreaM2 } = require('./osm');

// ── Overpass endpoint ─────────────────────────────────────
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_ALT = 'https://overpass.kumi.systems/api/interpreter';

async function overpassQuery(ql, onProgress) {
  const body = 'data=' + encodeURIComponent(ql);
  for (const url of [OVERPASS_URL, OVERPASS_ALT]) {
    try {
      const raw = await httpPost(url, body, { 'Content-Type': 'application/x-www-form-urlencoded' });
      return JSON.parse(raw);
    } catch (e) {
      onProgress && onProgress(`  ⚠ Overpass ${url} failed: ${e.message}`);
    }
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
    if (!geo.geometry || geo.geometry.type !== 'Polygon') throw new Error('Invalid polygon geometry');
    const coords = geo.geometry.coordinates[0] || [];
    if (coords.length < 3) throw new Error('Polygon has less than 3 points');
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    coords.forEach(([lon, lat]) => {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    });
    return { west, east, south, north };
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

async function fetchOsmResearchData(bbox, onProgress) {
  const { south, west, north, east } = bbox;
  const b = `${south},${west},${north},${east}`;

  const ql = `[out:json][timeout:180];
(
  way["landuse"="forest"](${b});
  way["natural"="wood"](${b});
  relation["landuse"="forest"](${b});
  relation["natural"="wood"](${b});
  way["power"="line"](${b});
  node["power"="substation"](${b});
  way["power"="substation"](${b});
  way["man_made"="pipeline"]["substance"="gas"](${b});
  way["pipeline"="gas"](${b});
);
out geom tags;`;

  onProgress(`  → Querying Overpass for forest/power/gas data…`);
  const data = await overpassQuery(ql, onProgress);
  const elements = data.elements || [];

  // ── Forest coverage ──────────────────────────────────────
  let forestAreaM2 = 0;
  elements.forEach(el => {
    if (!['way', 'relation'].includes(el.type)) return;
    const tags = el.tags || {};
    if (tags.landuse !== 'forest' && tags.natural !== 'wood') return;
    if (!el.geometry && !el.members) return;
    // Build a ring from geometry if available
    let ring = null;
    if (el.geometry && el.geometry.length >= 3) {
      ring = el.geometry.map(p => [p.lon, p.lat]);
    }
    if (ring) forestAreaM2 += polygonAreaM2(ring);
  });

  const totalAreaM2 = bboxAreaKm2(bbox) * 1e6;
  const forestPct = totalAreaM2 > 0 ? Math.round((forestAreaM2 / totalAreaM2) * 1000) / 1000 : 0;

  // ── Power lines ──────────────────────────────────────────
  const voltages = new Set();
  elements.forEach(el => {
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
  elements.forEach(el => {
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
  const hasGas = elements.some(el => {
    const tags = el.tags || {};
    return (tags.man_made === 'pipeline' && tags.substance === 'gas') || tags.pipeline === 'gas';
  });

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
      '',  // Карст — blank
      '',  // Геологія — blank
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

  const launchOpts = { headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (chromePath) launchOpts.executablePath = chromePath;
  const browser = await puppeteer.launch(launchOpts);

  try {
    // 3. Get hromada list
    onProgress(`📋 Fetching hromada list…`);
    const hromadas = await getHromadaList(oblast.id, browser, onProgress);
    if (!hromadas.length) throw new Error('No hromadas found — check the oblast name');

    onProgress(`  ✅ ${hromadas.length} hromadas to process`);

    // 4. Process each hromada sequentially (Overpass throttles parallel requests)
    const BATCH = 1;  // Process one at a time to avoid Overpass overload
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
          address: '',
          head: '',
          urbanPlanningUrl: '',
        };

        try {
          // Resolve bbox using REST API geo_json endpoint
          onProgress(`  🔍 ${hromada.name}: fetching boundary…`);
          const bbox = await getBboxFromGeoJson(hromada.id, onProgress);

          // OSM data
          try {
            const osm = await fetchOsmResearchData(bbox, msg => onProgress(`  [${hromada.name}] ${msg}`));
            row.forestPct = osm.forestPct;
            row.powerLines = osm.powerLinesText;
            row.substations = osm.substationsText;
            row.hasGas = osm.hasGas;
            row.roughness = estimateRoughnessLength(osm.forestPct);
          } catch (e) {
            onProgress(`  ⚠ ${hromada.name}: OSM error: ${e.message}`);
          }

          // Wind speed (150m)
          try {
            const wind = await fetchWindHeatmap(bbox, 150, msg => {});
            row.windSpeed = wind.avgSpeed;
          } catch (e) {
            onProgress(`  ⚠ ${hromada.name}: Wind error: ${e.message}`);
          }

          // Emerald Network
          try {
            const emerald = await fetchEmeraldFromEEA(bbox, msg => {});
            row.emerald = emerald.length > 0 ? '+' : '';
          } catch (e) {
            onProgress(`  ⚠ ${hromada.name}: Emerald error: ${e.message}`);
          }

          // Nature reserves (PZF)
          try {
            const pzf = await fetchNatureReservesFromPZF(bbox, msg => {});
            if (pzf.length > 0) {
              const names = [...new Set(pzf.map(f => f.properties.name).filter(Boolean))];
              row.natureReserves = names.slice(0, 5).join('; ');
            }
          } catch (e) {
            onProgress(`  ⚠ ${hromada.name}: PZF error: ${e.message}`);
          }

          // Decentralization.ua hromada page
          if (hromada.id) {
            try {
              const pageInfo = await getHromadaPageInfo(hromada.id, browser, onProgress);
              row.kpStage = pageInfo.kpStage;

              if (pageInfo.officialSiteUrl) {
                try {
                  const siteInfo = await getOfficialSiteInfo(pageInfo.officialSiteUrl, browser, onProgress);
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
          }

          onProgress(`  ✅ ${hromada.name}: forest=${(row.forestPct * 100).toFixed(1)}%, wind=${row.windSpeed ?? '?'} m/s, emerald=${row.emerald || '-'}`);
        } catch (e) {
          onProgress(`  ❌ ${hromada.name}: ${e.message}`);
        }

        batchResults.push(row);
        
        // Pause between requests to avoid overwhelming Overpass
        await new Promise(r => setTimeout(r, 1000));
      }

      results.push(...batchResults);

      // Save after each hromada
      await buildXlsx(results, outputPath, oblastName);
      onProgress(`  💾 Partial save: ${results.length}/${hromadas.length} rows written`);
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
