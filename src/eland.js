'use strict';

const puppeteer = require('puppeteer');
const ExcelJS   = require('exceljs');
const fs        = require('fs');

const ELAND_URL = 'https://e.land.gov.ua/back/cadaster/';
const CADNUM_FIELD = 'Кадастровий номер земельної ділянки';

function readCadnums(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  return text.split(/\r?\n/)
    .filter(l => l.trim() && !/^#?,?cadnum/i.test(l))
    .map(l => l.split(',').pop().trim())
    .filter(Boolean);
}

// Extract section-aware fields dynamically from e.land table:
// section separator rows (<td colspan="2" class="td-header">...) create section context;
// repeated section names are indexed (#2, #3, ...).
async function extractFields(page) {
  const parsed = await page.evaluate(() => {
    const out = {};
    const rows = document.querySelectorAll('div.box-body.table-responsive.no-padding tr');
    const sectionCounts = {};
    let sectionTitle = 'Без секції';
    let sectionOrdinal = 1;
    let cadnumValue = '';

    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const sectionName = () => sectionOrdinal > 1 ? `${sectionTitle} #${sectionOrdinal}` : sectionTitle;

    for (const row of rows) {
      const cells = row.querySelectorAll('td,th');
      if (!cells.length) continue;

      const first = cells[0];
      const firstText = clean(first.innerText);
      const colspan = Number(first.getAttribute('colspan') || '0');
      const isHeader = first.classList.contains('td-header') || cells.length === 1 || colspan >= 2;
      if (isHeader && firstText) {
        sectionTitle = firstText;
        sectionCounts[sectionTitle] = (sectionCounts[sectionTitle] || 0) + 1;
        sectionOrdinal = sectionCounts[sectionTitle];
        continue;
      }

      if (cells.length < 2) continue;
      const label = clean(cells[0].innerText);
      const value = clean(cells[1].innerText);
      if (!label) continue;

      const key = `[${sectionName()}] ${label}`;
      out[key] = value;
      if (!cadnumValue && label.toLowerCase().includes('кадастровий номер')) cadnumValue = value;
    }

    return { fields: out, cadnumValue };
  });

  const result = { ...parsed.fields };
  if (parsed.cadnumValue) result[CADNUM_FIELD] = parsed.cadnumValue;
  return result;
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

    const ensureLookupPage = async () => {
      const hasInput = await page.$('#cadastr_find_by_cadnum_cadNum');
      if (hasInput) return;
      await page.goto(ELAND_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('#cadastr_find_by_cadnum_cadNum', { timeout: 30000 });
    };

    const typeCadnum = async (digits, delayMs) => {
      await page.evaluate(() => {
        const el = document.getElementById('cadastr_find_by_cadnum_cadNum');
        if (!el) throw new Error('Cadnum input not found');
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.click('#cadastr_find_by_cadnum_cadNum', { clickCount: 3 });
      await page.type('#cadastr_find_by_cadnum_cadNum', digits, { delay: delayMs });
      await page.evaluate(() => {
        const el = document.getElementById('cadastr_find_by_cadnum_cadNum');
        if (el) {
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        }
      });
      const appliedDigits = await page.$eval('#cadastr_find_by_cadnum_cadNum', (el) =>
        String(el.value || '').replace(/\D/g, '')
      );
      return appliedDigits === digits;
    };

    const submitLookup = async (digits) => {
      await ensureLookupPage();

      let typed = await typeCadnum(digits, 45);
      if (!typed) typed = await typeCadnum(digits, 65);
      if (!typed) throw new Error('Cadnum input was not filled correctly');

      await page.evaluate(() => {
        const form = document.querySelector('form');
        if (!form) throw new Error('Lookup form not found');
        const submit = form.querySelector('button[type="submit"], input[type="submit"]');
        if (submit) submit.click();
        else if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      });

      const navWait = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 })
        .then(() => 'navigation')
        .catch(() => null);
      const domWait = page.waitForFunction(() => document.querySelectorAll('tr td').length >= 6, { timeout: 45000 })
        .then(() => 'dom')
        .catch(() => null);
      const firstSignal = await Promise.race([navWait, domWait]);
      if (!firstSignal) {
        const [navRes, domRes] = await Promise.all([navWait, domWait]);
        if (!navRes && !domRes) throw new Error('Lookup response timeout (45s)');
      }

      await new Promise(r => setTimeout(r, 250));
      return extractFields(page);
    };

    const discoveredFields = [CADNUM_FIELD];
    const discoveredSet = new Set(discoveredFields);
    const rememberFields = (obj) => {
      for (const key of Object.keys(obj || {})) {
        if (key === 'cadnum' || key === 'error') continue;
        if (!discoveredSet.has(key)) {
          discoveredSet.add(key);
          discoveredFields.push(key);
        }
      }
    };

    const results = [];
    for (let i = 0; i < cadnums.length; i++) {
      if (_stopped) { onProgress('⛔ Stopped by user.'); break; }
      const cadnum = cadnums[i];
      onProgress(`[${i + 1}/${cadnums.length}] ${cadnum}`);

      try {
        const digits = cadnum.replace(/\D/g, '');
        let data = await submitLookup(digits);
        let filled = Object.entries(data)
          .filter(([k, v]) => k !== 'Кадастровий номер земельної ділянки' && !!v)
          .length;
        const noDataMessage = `⚠ No data found for ${cadnum}`;

        if (filled === 0) {
          onProgress('  ↻ Empty result, retrying once…');
          await page.goto(ELAND_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForSelector('#cadastr_find_by_cadnum_cadNum', { timeout: 30000 });
          data = await submitLookup(digits);
          filled = Object.entries(data)
            .filter(([k, v]) => k !== 'Кадастровий номер земельної ділянки' && !!v)
            .length;
        }

        if (filled === 0) onProgress(`  ${noDataMessage}`);
        const rowData = {
          cadnum,
          [CADNUM_FIELD]: cadnum,
          ...data,
          error: filled === 0 ? noDataMessage : '',
        };
        rememberFields(rowData);
        results.push(rowData);

        // Keep current page; next iteration ensures input exists and only reloads if needed.

      } catch (err) {
        onProgress(`  ⚠ Error for ${cadnum}: ${err.message}`);
        results.push({
          cadnum,
          [CADNUM_FIELD]: cadnum,
          error: err.message,
        });
        try {
          await page.goto(ELAND_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForSelector('#cadastr_find_by_cadnum_cadNum', { timeout: 30000 });
        } catch (_) {}
      }

      await new Promise(r => setTimeout(r, 200));
    }

    await browser.close();

    // Write Excel
    onProgress('📊 Writing Excel file…');
    const workbook = new ExcelJS.Workbook();
    const sheet    = workbook.addWorksheet('e.land дані');

    const headers = ['#', ...discoveredFields, 'Помилка'];
    sheet.addRow(headers);
    sheet.getRow(1).font    = { bold: true };
    sheet.getRow(1).fill    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    sheet.getRow(1).font    = { bold: true, color: { argb: 'FFFFFFFF' } };

    results.forEach((row, idx) => {
      sheet.addRow([
        idx + 1,
        ...discoveredFields.map(f => row[f] || ''),
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
