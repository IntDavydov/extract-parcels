'use strict';

const puppeteer = require('puppeteer');
const ExcelJS   = require('exceljs');
const fs        = require('fs');

const ELAND_URL = 'https://e.land.gov.ua/back/cadaster/';

const FIELDS = [
  'Кадастровий номер земельної ділянки',
  'Цільове призначення',
  'Категорія земель',
  'Площа земельної ділянки',
  'Місце розташування',
  'Прізвище, ім\'я та по батькові фізичної особи',
  'Вид речового права',
  'Найменування юридичної особи',
];

function readCadnums(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  return text.split(/\r?\n/)
    .filter(l => l.trim() && !/^#?,?cadnum/i.test(l))
    .map(l => l.split(',').pop().trim())
    .filter(Boolean);
}

// Extract field values — page is a 2-column table: <td>label</td><td>value</td>
async function extractFields(page) {
  return page.evaluate((fieldList) => {
    const result = {};
    const rows = document.querySelectorAll('tr');
    // Build a map: normalised label text → value text
    const labelMap = {};
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        const label = cells[0].innerText.replace(/\s+/g, ' ').trim();
        const value = cells[1].innerText.replace(/\s+/g, ' ').trim();
        if (label) labelMap[label] = value;
      }
    }
    for (const field of fieldList) {
      // Try exact match first, then partial match (first 25 chars)
      if (labelMap[field] !== undefined) {
        result[field] = labelMap[field];
      } else {
        const partial = field.slice(0, 25);
        const found = Object.keys(labelMap).find(k => k.includes(partial));
        result[field] = found ? labelMap[found] : '';
      }
    }
    return result;
  }, FIELDS);  // pass FIELDS (module-level constant) into browser context
}

let _stopped = false;

async function lookupEland(csvPath, outputXlsx, onProgress, chromePath) {
  _stopped = false;
  onProgress('🌐 Opening e.land.gov.ua — please log in with your digital signature key…');

  const launchOpts = {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1200,800'],
    defaultViewport: null,
  };
  if (chromePath) launchOpts.executablePath = chromePath;

  const browser = await puppeteer.launch(launchOpts);

  try {
    const page = await browser.newPage();
    await page.goto(ELAND_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    onProgress('⏳ Waiting for you to complete login… (up to 5 minutes)');
    try {
      await page.waitForSelector('#cadastr_find_by_cadnum_cadNum', { timeout: 300000 });
    } catch {
      throw new Error('Login timeout (5 min). Please try again.');
    }
    onProgress('✅ Logged in. Starting batch lookup…');

    const cadnums = readCadnums(csvPath);
    onProgress(`📋 ${cadnums.length} cadastral numbers to look up`);

    const results = [];
    for (let i = 0; i < cadnums.length; i++) {
      if (_stopped) { onProgress('⛔ Stopped by user.'); break; }
      const cadnum = cadnums[i];
      onProgress(`[${i + 1}/${cadnums.length}] ${cadnum}`);

      try {
        // Fill input: type only digits — the inputmask inserts colons automatically
        const digits = cadnum.replace(/\D/g, '');
        await page.evaluate(() => {
          const el = document.getElementById('cadastr_find_by_cadnum_cadNum');
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.click('#cadastr_find_by_cadnum_cadNum', { clickCount: 3 });
        await page.type('#cadastr_find_by_cadnum_cadNum', digits, { delay: 20 });

        // Submit and wait for the page to reload with results
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
          page.evaluate(() => {
            const form = document.querySelector('form');
            if (form) form.submit();
          }),
        ]);

        // Small wait for DOM to settle
        await new Promise(r => setTimeout(r, 800));

        const data = await extractFields(page);
        const filled = Object.values(data).filter(Boolean).length;
        if (filled === 0) onProgress(`  ⚠ No data found for ${cadnum}`);
        results.push({ cadnum, ...data });

        // After seeing results, navigate back to the blank form for the next query
        await page.goto(ELAND_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('#cadastr_find_by_cadnum_cadNum', { timeout: 10000 });

      } catch (err) {
        onProgress(`  ⚠ Error for ${cadnum}: ${err.message}`);
        results.push({ cadnum, error: err.message });
      }

      // Polite delay between requests
      await new Promise(r => setTimeout(r, 600));
    }

    await browser.close();

    // Write Excel
    onProgress('📊 Writing Excel file…');
    const workbook = new ExcelJS.Workbook();
    const sheet    = workbook.addWorksheet('e.land дані');

    const headers = ['#', ...FIELDS, 'Помилка'];
    sheet.addRow(headers);
    sheet.getRow(1).font    = { bold: true };
    sheet.getRow(1).fill    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    sheet.getRow(1).font    = { bold: true, color: { argb: 'FFFFFFFF' } };

    results.forEach((row, idx) => {
      sheet.addRow([
        idx + 1,
        ...FIELDS.map(f => row[f] || ''),
        row.error || '',
      ]);
    });

    sheet.columns.forEach(col => {
      let maxLen = 12;
      col.eachCell(cell => {
        if (cell.value) maxLen = Math.max(maxLen, String(cell.value).length);
      });
      col.width = Math.min(maxLen + 2, 60);
    });

    await workbook.xlsx.writeFile(outputXlsx);
    onProgress(`✅ Saved ${results.length} records → ${outputXlsx}`);
    return { success: true, outputPath: outputXlsx, count: results.length };

  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

function stopLookup() { _stopped = true; }

module.exports = { lookupEland, stopLookup };
