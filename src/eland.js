'use strict';

const puppeteer = require('puppeteer');
const ExcelJS   = require('exceljs');
const fs        = require('fs');
const path      = require('path');
const {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  TextRun,
  BorderStyle,
} = require('docx');

const ELAND_URL = 'https://e.land.gov.ua/back/cadaster/';
const CADNUM_FIELD = 'Кадастровий номер земельної ділянки';
const TABLE_ROWS_SELECTOR = 'div.box-body.table-responsive.no-padding table tbody tr';
const DOCX_HEADER_FILL = '3C8DBC';
const PARTIAL_OPTIONS_REL_PATH = path.join('info', 'e-land-options.xlsx');

function readCadnums(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  return text.split(/\r?\n/)
    .filter(l => l.trim() && !/^#?,?cadnum/i.test(l))
    .map(l => l.split(',').pop().trim())
    .filter(Boolean);
}

function normalizeLabel(s) {
  return String(s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[’`]/g, '\'')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalSectionTitle(raw) {
  const text = normalizeLabel(raw);
  const m = text.match(/^(.*?)(?:\s+#(\d+))?$/);
  const baseText = m ? normalizeLabel(m[1]) : text;
  const ordinal = m && m[2] ? Number(m[2]) : 1;
  const low = baseText.toLowerCase();
  let canonicalBase = baseText || 'Без секції';
  if (low.includes('відомості про земельну ділянку')) canonicalBase = 'Відомості про земельну ділянку';
  else if (low.includes('відомості про суб\'єктів права власності')) canonicalBase = 'Відомості про суб\'єктів права власності на земельну ділянку';
  else if (low.includes('відомості про суб\'єкта речового права')) canonicalBase = 'Відомості про суб\'єкта речового права на земельну ділянку';
  return ordinal > 1 ? `${canonicalBase} #${ordinal}` : canonicalBase;
}

function canonicalFieldLabel(raw) {
  const text = normalizeLabel(raw);
  const low = text.toLowerCase();
  if (low.includes('кадастровий номер')) return 'Кадастровий номер земельної ділянки';
  if (low.includes('цільове призначення')) return 'Цільове призначення';
  if (low.includes('категорія земель')) return 'Категорія земель';
  if (low.includes('площа земельної ділянки')) return 'Площа земельної ділянки';
  if (low.includes('місце розташування')) return 'Місце розташування';
  if (low.includes('вид речового права')) return 'Вид речового права';
  if (low.includes('прізвище') && low.includes('по батькові')) return 'Прізвище, ім\'я та по батькові фізичної особи';
  if (low.includes('найменування юридичної особи')) return 'Найменування юридичної особи';
  if (low.includes('код єдрпоу')) return 'Код ЄДРПОУ юридичної особи';
  if (low.includes('дата державної реєстрації права') || low.includes('дата державної реєстрації речового права')) {
    return 'Дата державної реєстрації права (в державному реєстрі прав)';
  }
  if (low.includes('номер запису про право') || low.includes('номер запису про речове право')) {
    return 'Номер запису про право (в державному реєстрі прав)';
  }
  if (
    low.includes('орган, що здійснив державну реєстрацію права') ||
    low.includes('орган що здійснив державну реєстрацію права') ||
    low.includes('орган, що здійснив державну реєстрацію речового права') ||
    low.includes('орган що здійснив державну реєстрацію речового права')
  ) {
    return 'Орган, що здійснив державну реєстрацію права (в державному реєстрі прав)';
  }
  if (low.includes('площа, на яку поширюється право суборенди') || low.includes('площа на яку поширюється право суборенди')) {
    return 'Площа, на яку поширюється право суборенди';
  }
  return text;
}

// Extract section-aware fields dynamically from e.land table:
// section separator rows (<td colspan="2" class="td-header">...) create section context;
// repeated section names are indexed (#2, #3, ...).
async function extractFields(page) {
  const parsed = await page.evaluate(() => {
    const out = {};
    const sectionsOut = [];
    const rowEntries = [];
    const rows = document.querySelectorAll('div.box-body.table-responsive.no-padding table tbody tr');
    const sectionCounts = {};
    const rowKeyCounts = {};
    let sectionTitle = 'Без секції';
    let sectionOrdinal = 1;
    let cadnumValue = '';
    const clean = (s) => String(s || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
    const canonicalSection = (s) => {
      const text = clean(s);
      const low = text.toLowerCase();
      if (low.includes('відомості про земельну ділянку')) return 'Відомості про земельну ділянку';
      if (low.includes('відомості про суб\'єктів права власності')) return 'Відомості про суб\'єктів права власності на земельну ділянку';
      if (low.includes('відомості про суб\'єкта речового права')) return 'Відомості про суб\'єкта речового права на земельну ділянку';
      return text || 'Без секції';
    };
    const canonicalLabel = (s) => {
      const text = clean(s);
      const low = text.toLowerCase();
      if (low.includes('кадастровий номер')) return 'Кадастровий номер земельної ділянки';
      if (low.includes('цільове призначення')) return 'Цільове призначення';
      if (low.includes('категорія земель')) return 'Категорія земель';
      if (low.includes('площа земельної ділянки')) return 'Площа земельної ділянки';
      if (low.includes('місце розташування')) return 'Місце розташування';
      if (low.includes('вид речового права')) return 'Вид речового права';
      if (low.includes('прізвище') && low.includes('по батькові')) return 'Прізвище, ім\'я та по батькові фізичної особи';
      if (low.includes('найменування юридичної особи')) return 'Найменування юридичної особи';
      if (low.includes('код єдрпоу')) return 'Код ЄДРПОУ юридичної особи';
      if (low.includes('дата державної реєстрації права')) return 'Дата державної реєстрації права (в державному реєстрі прав)';
      if (low.includes('номер запису про право')) return 'Номер запису про право (в державному реєстрі прав)';
      if (low.includes('орган, що здійснив державну реєстрацію права') || low.includes('орган що здійснив державну реєстрацію права')) {
        return 'Орган, що здійснив державну реєстрацію права (в державному реєстрі прав)';
      }
      if (low.includes('площа, на яку поширюється право суборенди') || low.includes('площа на яку поширюється право суборенди')) {
        return 'Площа, на яку поширюється право суборенди';
      }
      return text;
    };
    const sectionName = () => sectionOrdinal > 1 ? `${sectionTitle} #${sectionOrdinal}` : sectionTitle;

    for (const row of rows) {
      const cells = row.querySelectorAll('td,th');
      if (!cells.length) continue;

      const first = cells[0];
      const firstText = clean(first.innerText);
      const colspan = Number(first.getAttribute('colspan') || '0');
      const isHeader = first.classList.contains('td-header') || cells.length === 1 || colspan >= 2;
      if (isHeader && firstText) {
        sectionTitle = canonicalSection(firstText);
        sectionCounts[sectionTitle] = (sectionCounts[sectionTitle] || 0) + 1;
        sectionOrdinal = sectionCounts[sectionTitle];
        const sName = sectionName();
        if (!sectionsOut.some((s) => s.title === sName)) sectionsOut.push({ title: sName, rows: [] });
        continue;
      }

      if (cells.length < 2) continue;
      const label = canonicalLabel(cells[0].innerText);
      const value = clean(cells[1].innerText);
      if (!label) continue;

      const baseKey = `[${sectionName()}] ${label}`;
      rowKeyCounts[baseKey] = (rowKeyCounts[baseKey] || 0) + 1;
      const key = rowKeyCounts[baseKey] > 1 ? `${baseKey} (${rowKeyCounts[baseKey]})` : baseKey;
      out[key] = value;
      rowEntries.push({ section: sectionName(), label, value });
      const sName = sectionName();
      const sectionRef = sectionsOut.find((s) => s.title === sName);
      if (sectionRef) sectionRef.rows.push({ label, value });
      if (!cadnumValue && label.toLowerCase().includes('кадастровий номер')) cadnumValue = value;
    }

    return { fields: out, cadnumValue, sections: sectionsOut, rowEntries };
  });

  const result = {};
  const fieldOrder = [];
  const rowEntries = Array.isArray(parsed.rowEntries) ? parsed.rowEntries : [];
  const canonicalCounts = {};
  for (const entry of rowEntries) {
    const section = canonicalSectionTitle(entry.section || 'Без секції');
    const label = canonicalFieldLabel(entry.label || '');
    if (!label) continue;
    const baseKey = `[${section}] ${label}`;
    canonicalCounts[baseKey] = (canonicalCounts[baseKey] || 0) + 1;
    const key = canonicalCounts[baseKey] > 1 ? `${baseKey} (${canonicalCounts[baseKey]})` : baseKey;
    result[key] = normalizeLabel(entry.value || '');
    fieldOrder.push(key);
  }
  if (parsed.cadnumValue) result[CADNUM_FIELD] = normalizeLabel(parsed.cadnumValue);
  return { fields: result, fieldOrder, sections: parsed.sections || [] };
}

function detectOutputFormat(outputPath, requestedFormat = null) {
  const fmt = String(requestedFormat || '').trim().toLowerCase();
  if (fmt === 'docx') return 'docx';
  if (fmt === 'xlsx_partial') return 'xlsx_partial';
  if (fmt === 'xlsx' || fmt === 'xlsx_full') return 'xlsx_full';
  return String(outputPath || '').toLowerCase().endsWith('.docx') ? 'docx' : 'xlsx_full';
}

function toDocxOutputPath(outputPath) {
  const parsed = path.parse(String(outputPath || 'eland_lookup.xlsx'));
  return path.join(parsed.dir, `${parsed.name}.docx`);
}

function toXlsxOutputPath(outputPath) {
  const parsed = path.parse(String(outputPath || 'eland_lookup.docx'));
  return path.join(parsed.dir, `${parsed.name}.xlsx`);
}

function buildElandDocxRows(entry) {
  const rows = [];
  for (const section of (entry.sections || [])) {
    rows.push(
      new TableRow({
        children: [
          new TableCell({
            columnSpan: 2,
            shading: { fill: DOCX_HEADER_FILL, color: 'FFFFFF' },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: section.title, bold: true, color: 'FFFFFF' })],
              }),
            ],
          }),
        ],
      })
    );
    for (const item of (section.rows || [])) {
      rows.push(
        new TableRow({
          children: [
            new TableCell({
              width: { size: 50, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ children: [new TextRun({ text: item.label || '' })] })],
            }),
            new TableCell({
              width: { size: 50, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ children: [new TextRun({ text: item.value || '' })] })],
            }),
          ],
        })
      );
    }
  }
  return rows;
}

async function writeDocxReport(results, outputPath, onProgress) {
  const children = [];
  results.forEach((entry, idx) => {
    if (idx > 0) children.push(new Paragraph({ pageBreakBefore: true }));
    children.push(new Paragraph({ children: [new TextRun({ text: `${idx + 1}. ${entry.cadnum || ''}`, bold: true })] }));
    if (entry.error) children.push(new Paragraph({ children: [new TextRun({ text: entry.error })] }));
    const tableRows = buildElandDocxRows(entry);
    if (tableRows.length) {
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: tableRows,
          borders: {
            top: { style: BorderStyle.SINGLE, size: 1, color: 'BFBFBF' },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: 'BFBFBF' },
            left: { style: BorderStyle.SINGLE, size: 1, color: 'BFBFBF' },
            right: { style: BorderStyle.SINGLE, size: 1, color: 'BFBFBF' },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'D9D9D9' },
            insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'D9D9D9' },
          },
        })
      );
    }
  });

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
  onProgress(`✅ Saved ${results.length} records → ${outputPath}`);
  return { success: true, outputPath, count: results.length };
}

function getSchemaFieldsInOrder(row) {
  if (Array.isArray(row?.fieldOrder) && row.fieldOrder.length) return [...row.fieldOrder];
  const fields = [];
  for (const [k, v] of Object.entries(row || {})) {
    if (k === 'cadnum' || k === 'error' || k === 'sections' || k === 'fieldOrder' || k === CADNUM_FIELD) continue;
    fields.push(k);
  }
  return fields;
}

function hasValue(v) {
  return normalizeLabel(v || '') !== '';
}

async function writeCompactExcelReport(results, outputPath, onProgress) {
  const workbook = new ExcelJS.Workbook();
  const fieldFrequency = new Map();
  const fieldFirstSeen = new Map();
  const rowsWithFields = results.map((row) => {
    const fieldsOrdered = getSchemaFieldsInOrder(row);
    const nonEmptyFields = fieldsOrdered.filter((f) => hasValue(row[f]));
    for (const f of nonEmptyFields) {
      fieldFrequency.set(f, (fieldFrequency.get(f) || 0) + 1);
      if (!fieldFirstSeen.has(f)) fieldFirstSeen.set(f, fieldFirstSeen.size);
    }
    for (const f of fieldsOrdered) {
      if (!fieldFirstSeen.has(f)) fieldFirstSeen.set(f, fieldFirstSeen.size);
    }
    return { row, fieldsOrdered };
  });

  const frequencyThreshold = Math.max(2, Math.ceil(results.length * 0.35));
  const coreFields = [...fieldFrequency.entries()]
    .filter(([, cnt]) => cnt >= frequencyThreshold)
    .map(([f]) => f)
    .sort((a, b) => (fieldFirstSeen.get(a) || 0) - (fieldFirstSeen.get(b) || 0));

  const mainRows = [];
  const outlierRows = [];
  for (const item of rowsWithFields) {
    const missingCoreCount = coreFields.reduce((acc, f) => acc + (hasValue(item.row[f]) ? 0 : 1), 0);
    if (coreFields.length > 0 && missingCoreCount >= 3) outlierRows.push(item);
    else mainRows.push(item);
  }

  const usedSheetNames = new Set();
  const makeSheetName = (base) => {
    let name = String(base || 'Sheet').slice(0, 31);
    let idx = 2;
    while (usedSheetNames.has(name)) {
      const suffix = `_${idx++}`;
      name = `${String(base || 'Sheet').slice(0, Math.max(1, 31 - suffix.length))}${suffix}`;
    }
    usedSheetNames.add(name);
    return name;
  };

  const writeSheet = (name, rows, fields) => {
    const sheet = workbook.addWorksheet(makeSheetName(name));
    const headers = ['#', CADNUM_FIELD, ...fields, 'Помилка'];
    sheet.addRow(headers);
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    sheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];

    rows.forEach((item, rowIdx) => {
      const row = item.row;
      sheet.addRow([
        rowIdx + 1,
        row[CADNUM_FIELD] || row.cadnum || '',
        ...fields.map((f) => row[f] || ''),
        row.error || '',
      ]);
    });

    sheet.columns.forEach((col) => {
      let maxLen = 12;
      col.eachCell((cell) => {
        if (cell.value) maxLen = Math.max(maxLen, String(cell.value).length);
      });
      col.width = Math.min(maxLen + 2, 60);
    });
  };

  if (mainRows.length) {
    const extraMainFields = [];
    const seen = new Set(coreFields);
    for (const item of mainRows) {
      for (const f of item.fieldsOrdered) {
        if (seen.has(f)) continue;
        seen.add(f);
        extraMainFields.push(f);
      }
    }
    writeSheet('Main', mainRows, [...coreFields, ...extraMainFields]);
  }

  outlierRows.forEach((item, idx) => {
    const cad = String(item.row[CADNUM_FIELD] || item.row.cadnum || `Outlier_${idx + 1}`);
    const safeCad = cad.replace(/[\\/*?:[\]]/g, '_').slice(0, 20);
    writeSheet(`Diff_${safeCad}`, [item], item.fieldsOrdered);
  });

  if (!mainRows.length && !outlierRows.length) workbook.addWorksheet(makeSheetName('Main'));
  await workbook.xlsx.writeFile(outputPath);
  const sheetCount = workbook.worksheets.length;
  onProgress(`✅ Saved ${results.length} records in ${sheetCount} sheet(s) → ${outputPath}`);
  return { success: true, outputPath, count: results.length };
}

function toCellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((x) => x.text || '').join('');
    if (v.text) return String(v.text);
    if (v.result != null) return String(v.result);
  }
  return String(v);
}

function resolvePartialOptionsPath(explicitPath = null) {
  const candidates = [
    explicitPath,
    path.join(process.cwd(), PARTIAL_OPTIONS_REL_PATH),
    path.resolve(__dirname, '..', PARTIAL_OPTIONS_REL_PATH),
    path.resolve(__dirname, '..', '..', PARTIAL_OPTIONS_REL_PATH),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  throw new Error(`Partial schema file not found: ${PARTIAL_OPTIONS_REL_PATH}`);
}

async function loadPartialOptionsFields(explicitPath = null) {
  const optionsPath = resolvePartialOptionsPath(explicitPath);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(optionsPath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error(`No worksheets in ${optionsPath}`);

  const fields = [];
  const seen = new Set();
  ws.eachRow((row) => {
    const values = (row.values || []).slice(1).map((v) => normalizeLabel(toCellText(v)));
    const labelRaw = values.find((v) => v && !/^\d+$/.test(v));
    if (!labelRaw) return;
    const field = canonicalFieldLabel(labelRaw);
    if (!field || seen.has(field)) return;
    seen.add(field);
    fields.push(field);
  });
  if (!fields.length) throw new Error(`No fields found in ${optionsPath}`);
  return fields;
}

function normalizeFieldKeyBaseLabel(fieldKey) {
  const plain = normalizeLabel(String(fieldKey || '').replace(/\s*\(\d+\)\s*$/, ''));
  const m = plain.match(/^\[[^\]]+\]\s+(.+)$/);
  return canonicalFieldLabel(m ? m[1] : plain);
}

function getOrderedRowFieldKeys(row) {
  const ordered = getSchemaFieldsInOrder(row);
  const seen = new Set(ordered);
  const extras = Object.keys(row || {}).filter((k) =>
    !seen.has(k) && k !== 'cadnum' && k !== 'error' && k !== 'sections' && k !== 'fieldOrder' && k !== CADNUM_FIELD
  );
  return ordered.concat(extras);
}

function getPartialFieldValue(row, fieldLabel) {
  const target = canonicalFieldLabel(fieldLabel);
  if (target === CADNUM_FIELD) return normalizeLabel(row[CADNUM_FIELD] || row.cadnum || '');
  if (hasValue(row[target])) return normalizeLabel(row[target]);
  const keys = getOrderedRowFieldKeys(row);
  for (const key of keys) {
    if (normalizeFieldKeyBaseLabel(key) !== target) continue;
    const value = normalizeLabel(row[key] || '');
    if (value) return value;
  }
  return '';
}

async function writePartialExcelReport(results, outputPath, onProgress, explicitOptionsPath = null) {
  const workbook = new ExcelJS.Workbook();
  const schemaFields = await loadPartialOptionsFields(explicitOptionsPath);
  const fields = schemaFields.filter((f) => f !== CADNUM_FIELD);
  const sheet = workbook.addWorksheet('Main');
  const headers = ['#', CADNUM_FIELD, ...fields, 'Помилка'];
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  sheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];

  results.forEach((row, idx) => {
    sheet.addRow([
      idx + 1,
      normalizeLabel(row[CADNUM_FIELD] || row.cadnum || ''),
      ...fields.map((f) => getPartialFieldValue(row, f)),
      row.error || '',
    ]);
  });

  sheet.columns.forEach((col) => {
    let maxLen = 12;
    col.eachCell((cell) => {
      if (cell.value) maxLen = Math.max(maxLen, String(cell.value).length);
    });
    col.width = Math.min(maxLen + 2, 60);
  });

  await workbook.xlsx.writeFile(outputPath);
  onProgress(`✅ Saved ${results.length} records in 1 sheet (partial schema) → ${outputPath}`);
  return { success: true, outputPath, count: results.length };
}

let _stopped = false;

async function lookupEland(csvPath, outputPath, onProgress, chromePath, options = {}) {
  const outputFormat = detectOutputFormat(outputPath, options.format);
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

    const cadnums = Array.isArray(csvPath) ? csvPath : readCadnums(csvPath);
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

      await page.waitForSelector(TABLE_ROWS_SELECTOR, { timeout: 10000 });
      await page.waitForFunction((selector) => {
        const rows = document.querySelectorAll(selector).length;
        const now = Date.now();
        if (window.__elandRowsCount !== rows) {
          window.__elandRowsCount = rows;
          window.__elandRowsAt = now;
          return false;
        }
        return rows >= 6 && (now - (window.__elandRowsAt || now)) > 500;
      }, { timeout: 10000 }, TABLE_ROWS_SELECTOR);

      await new Promise(r => setTimeout(r, 250));
      return extractFields(page);
    };

    const results = [];
    for (let i = 0; i < cadnums.length; i++) {
      if (_stopped) { onProgress('⛔ Stopped by user.'); break; }
      const cadnum = cadnums[i];
      onProgress(`[${i + 1}/${cadnums.length}] ${cadnum}`);

      try {
        const digits = cadnum.replace(/\D/g, '');
        let data = await submitLookup(digits);
        let filled = Object.entries(data.fields)
          .filter(([k, v]) => k !== 'Кадастровий номер земельної ділянки' && !!v)
          .length;
        const noDataMessage = `⚠ No data found for ${cadnum}`;

        if (filled === 0) {
          onProgress('  ↻ Empty result, retrying once…');
          await page.goto(ELAND_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForSelector('#cadastr_find_by_cadnum_cadNum', { timeout: 30000 });
          data = await submitLookup(digits);
          filled = Object.entries(data.fields)
            .filter(([k, v]) => k !== 'Кадастровий номер земельної ділянки' && !!v)
            .length;
        }

        if (filled === 0) onProgress(`  ${noDataMessage}`);
        const rowData = {
          cadnum,
          [CADNUM_FIELD]: cadnum,
          ...data.fields,
          fieldOrder: data.fieldOrder || [],
          sections: data.sections || [],
          error: filled === 0 ? noDataMessage : '',
        };
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

    if (outputFormat === 'json') {
      await browser.close();
      return { success: true, count: results.length, data: results };
    }

    if (outputFormat === 'docx') {
      onProgress('📄 Writing Word document…');
      await browser.close();
      return writeDocxReport(results, outputPath, onProgress);
    }

    const excelOutputPath = String(outputPath || '').toLowerCase().endsWith('.docx')
      ? toXlsxOutputPath(outputPath)
      : outputPath;

    if (outputFormat === 'xlsx_partial') {
      onProgress('📊 Writing partial Excel file…');
      await writePartialExcelReport(results, excelOutputPath, onProgress, options.partialOptionsPath || null);
    } else {
      onProgress('📊 Writing full Excel file…');
      await writeCompactExcelReport(results, excelOutputPath, onProgress);
    }
    const docxOutputPath = toDocxOutputPath(excelOutputPath);
    onProgress('📄 Writing Word document…');
    await writeDocxReport(results, docxOutputPath, onProgress);
    await browser.close();
    return { success: true, outputPath: excelOutputPath, docxOutputPath, count: results.length };

  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

function stopLookup() { _stopped = true; }

module.exports = { lookupEland, stopLookup };
