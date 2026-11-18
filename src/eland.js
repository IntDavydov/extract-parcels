'use strict';

const puppeteer = require('puppeteer');
const ExcelJS   = require('exceljs');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const crypto    = require('crypto');
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
// Baked-in fallback field list — same fields as a stock e-land-options.xlsx
// template — used when no template file can be found anywhere (info/, the
// app dir, or ~/Downloads), so the partial export always has a schema.
const DEFAULT_PARTIAL_FIELDS = [
  'Кадастровий номер земельної ділянки',
  'Цільове призначення',
  'Категорія земель',
  'Площа земельної ділянки',
  'Місце розташування',
  "Прізвище, ім'я та по батькові фізичної особи",
  'Вид речового права',
  'Найменування юридичної особи',
  'Код ЄДРПОУ юридичної особи',
];

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
  if (fmt === 'json') return 'json';
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
    // Last resort: same filename dropped straight in ~/Downloads, so a
    // manually-fetched copy of the schema still works without an info/ folder.
    path.join(os.homedir(), 'Downloads', path.basename(PARTIAL_OPTIONS_REL_PATH)),
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
  let schemaFields;
  try {
    schemaFields = await loadPartialOptionsFields(explicitOptionsPath);
  } catch (err) {
    onProgress(`⚠ ${err.message} — using built-in default field list instead.`);
    schemaFields = DEFAULT_PARTIAL_FIELDS;
  }
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

// ── Merging per-boundary e.land reports into one combined report ──────────
// A multi-boundary run (several KMZ files in one go) looks up e.land for
// each boundary separately, each producing its own partial xlsx/docx. Those
// per-boundary files all land in the same spot in the orchestrator's temp
// scheme, so this concatenates them into a single final report instead of
// letting the last boundary's result silently overwrite the earlier ones.
async function mergeElandPartialExcel(xlsxPaths, outputPath) {
  const outWorkbook = new ExcelJS.Workbook();
  const outSheet = outWorkbook.addWorksheet('Main');
  let rowNum = 0;
  let headerWritten = false;

  for (const p of (xlsxPaths || [])) {
    if (!p || !fs.existsSync(p)) continue;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(p);
    const sheet = wb.worksheets[0];
    if (!sheet) continue;
    sheet.eachRow((row) => {
      const values = (row.values || []).slice(1); // ExcelJS row.values is 1-indexed with a hole at [0]
      if (row.number === 1) {
        if (!headerWritten) { outSheet.addRow(values); headerWritten = true; }
        return;
      }
      rowNum++;
      outSheet.addRow([rowNum, ...values.slice(1)]); // renumber the '#' column across all files
    });
  }

  outSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  outSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  outSheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];
  outSheet.columns.forEach((col) => {
    let maxLen = 12;
    col.eachCell((cell) => { if (cell.value) maxLen = Math.max(maxLen, String(cell.value).length); });
    col.width = Math.min(maxLen + 2, 60);
  });

  await outWorkbook.xlsx.writeFile(outputPath);
  return { success: true, outputPath, count: rowNum };
}

// docx has no reader API, only a writer — so this splices the raw OOXML
// instead of re-parsing/rebuilding. Every per-boundary docx was produced by
// writeDocxReport() above, so they all share the same namespaces, styles and
// <w:sectPr> (page setup); only the <w:body> content differs. Safe to concat
// each file's body content (minus its own trailing <w:sectPr>) into the
// first file's body, right before that one <w:sectPr> that's kept at the end.
async function mergeElandDocx(docxPaths, outputPath) {
  const JSZip = require('jszip');
  const existing = (docxPaths || []).filter((p) => p && fs.existsSync(p));
  if (!existing.length) return { success: false, error: 'No docx files to merge' };

  const baseZip = await JSZip.loadAsync(fs.readFileSync(existing[0]));
  let baseXml = await baseZip.file('word/document.xml').async('string');
  const sectPrAtEnd = /(<w:sectPr\b[\s\S]*?<\/w:sectPr>\s*<\/w:body>)/;

  for (let i = 1; i < existing.length; i++) {
    const zip = await JSZip.loadAsync(fs.readFileSync(existing[i]));
    const xml = await zip.file('word/document.xml').async('string');
    const bodyMatch = xml.match(/<w:body>([\s\S]*)<w:sectPr\b[\s\S]*?<\/w:sectPr>\s*<\/w:body>/);
    if (!bodyMatch) continue;
    const pageBreak = '<w:p><w:pPr><w:pageBreakBefore/></w:pPr></w:p>';
    baseXml = baseXml.replace(sectPrAtEnd, `${pageBreak}${bodyMatch[1]}$1`);
  }

  baseZip.file('word/document.xml', baseXml);
  const outBuffer = await baseZip.generateAsync({ type: 'nodebuffer' });
  fs.writeFileSync(outputPath, outBuffer);
  return { success: true, outputPath };
}

let _stopped = false;

// ── Resume support ────────────────────────────────────────────────────────
// A checkpoint file records completed lookups so that a crash, a laptop
// going to sleep mid-run, or the browser window closing doesn't throw away
// hours of progress — the next run picks up right where it left off.
// Keyed by the *sorted* set of cadnums, not their order — a re-scrape can
// legitimately produce the same cadnums in a different order (tile network
// responses don't arrive in a guaranteed sequence), and a position-based key
// would silently miss the checkpoint and restart from zero every time.
function checkpointPathFor(cadnums, outputPath) {
  const dir = outputPath ? path.dirname(outputPath) : os.tmpdir();
  const sorted = [...cadnums].sort();
  const hash = crypto.createHash('md5').update(sorted.join(',')).digest('hex').slice(0, 12);
  return path.join(dir, `.eland-checkpoint-${hash}.json`);
}

function loadCheckpoint(checkpointPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    if (!Array.isArray(parsed.results) || !parsed.results.length) return null;
    return parsed.results;
  } catch (_) {
    return null;
  }
}

function saveCheckpoint(checkpointPath, results) {
  try { fs.writeFileSync(checkpointPath, JSON.stringify({ results, savedAt: Date.now() })); }
  catch (_) { /* best effort — a failed checkpoint write shouldn't abort the run */ }
}

function clearCheckpoint(checkpointPath) {
  try { fs.unlinkSync(checkpointPath); } catch (_) {}
}

function formatDuration(ms) {
  if (!isFinite(ms) || ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// A dead Frame/Page/browser session — further calls on it will just keep
// throwing forever. Distinct from a one-off timeout, which is fine to retry.
function isFatalPageError(err) {
  const msg = String(err?.message || '');
  return /detached frame/i.test(msg) || /target closed/i.test(msg)
    || /session closed/i.test(msg) || /protocol error/i.test(msg)
    // Tab is alive but has stopped responding to DevTools commands entirely
    // (frozen/hung renderer) — e.g. "Runtime.callFunctionOn timed out.
    // Increase the 'protocolTimeout' setting…". A fresh tab fixes this the
    // same way it fixes a closed/crashed one.
    || /protocoltimeout/i.test(msg) || /\b\w+\.\w+ timed out\b/i.test(msg);
}

// The OS itself dropped the network (sleep, wifi toggle, no connection) —
// worth pausing and waiting for it to come back rather than burning through
// the rest of the list as instant failures.
function isOfflineError(err) {
  const msg = String(err?.message || '');
  return /net::err_internet_disconnected/i.test(msg) || /net::err_network_changed/i.test(msg)
    || /net::err_name_not_resolved/i.test(msg) || /net::err_connection_(reset|closed|refused)/i.test(msg);
}

// Waits (with growing backoff, capped at 30s between checks) until `page`
// can reach e.land.gov.ua again — used when the OS itself dropped the
// network. There's no correctness reason to ever give up early on a pure
// connectivity problem — waiting costs nothing but time, and the caller
// stops the whole run (not just this one lookup) if this still fails, so a
// long-but-finite cap (24h) only matters for genuinely abandoned runs.
async function waitForConnectionAndPage(page, onProgress, maxWaitMs = 24 * 60 * 60 * 1000) {
  const start = Date.now();
  let delay = 5000;
  while (Date.now() - start < maxWaitMs) {
    if (_stopped) {
      onProgress('  ⛔ Stopped by user while waiting for the connection.');
      return false;
    }
    await new Promise(r => setTimeout(r, delay));
    try {
      await page.goto(ELAND_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForSelector('#cadastr_find_by_cadnum_cadNum', { timeout: 15000 });
      onProgress('  ✅ Connection is back — resuming.');
      return true;
    } catch (_) {
      delay = Math.min(delay * 1.5, 30000);
      onProgress(`  ⏳ Still offline, retrying in ${Math.round(delay / 1000)}s…`);
    }
  }
  onProgress('  ⚠ Gave up waiting for the connection to return.');
  return false;
}

// ── Automated ЕЦП/КЕП (digital signature) login ─────────────────────────────
// Minimal .env reader (no dependency on the `dotenv` package, which is only
// present here transitively) — just enough for a flat KEY=VALUE file.
function readEnvValue(key) {
  if (process.env[key]) return process.env[key];
  const candidates = [path.join(process.cwd(), '.env'), path.join(__dirname, '..', '.env')];
  for (const envPath of candidates) {
    try {
      const text = fs.readFileSync(envPath, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
        if (m && m[1] === key) {
          let v = m[2];
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
          return v;
        }
      }
    } catch (_) {}
  }
  return null;
}

function findEcpKeyFile() {
  const candidates = [
    process.env.ELAND_KEY_PATH,
    '/Users/davydov/Work/tests/something/lmk.jks',
    path.join(os.homedir(), 'Downloads', 'lmk.jks'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

const ECP_LINK_TEXT = 'Ідентифікація з використанням ЕЦП/КЕП';
const ECP_PROVIDER_TEXT = 'ПриватБанк';
const ECP_PASSWORD_LABEL_TEXT = 'Пароль приватного ключа';
const ECP_LOGIN_BUTTON_TEXT = 'Увійти';

// Drives the full digital-signature login: click the ЕЦП/КЕП entry point,
// pick the ПриватБанк КНЕДП provider, attach the key file, fill the private
// key password, submit, and confirm the lookup form is back. Written against
// visible button/label TEXT rather than guessed CSS selectors/ids, since
// those weren't inspectable ahead of time — the real page may need this
// adjusted after a first live run (report back the exact failing step).
async function performEcpAutoLogin(page, onProgress) {
  const password = readEnvValue('ELAND_PASS');
  if (!password) throw new Error('ELAND_PASS not set in .env — cannot auto re-login');
  const keyPath = findEcpKeyFile();
  if (!keyPath) throw new Error('Digital signature key file (lmk.jks) not found');

  onProgress('  🔐 Automating ЕЦП/КЕП login…');

  const clickedEntry = await page.evaluate((linkText) => {
    const el = Array.from(document.querySelectorAll('a, button'))
      .find((e) => e.textContent && e.textContent.trim().includes(linkText));
    if (el) { el.click(); return true; }
    return false;
  }, ECP_LINK_TEXT);
  if (!clickedEntry) throw new Error(`Could not find the "${ECP_LINK_TEXT}" link`);

  await new Promise((r) => setTimeout(r, 10000)); // let the provider dropdown load

  const pickedProvider = await page.evaluate((providerText) => {
    for (const sel of Array.from(document.querySelectorAll('select'))) {
      const opt = Array.from(sel.options).find((o) => o.textContent && o.textContent.includes(providerText));
      if (opt) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    // Fall back to a custom (non-<select>) dropdown option element.
    const el = Array.from(document.querySelectorAll('li, div, span, a'))
      .find((e) => e.children.length === 0 && e.textContent && e.textContent.trim().includes(providerText));
    if (el) { el.click(); return true; }
    return false;
  }, ECP_PROVIDER_TEXT);
  if (!pickedProvider) throw new Error(`Could not find/select the "${ECP_PROVIDER_TEXT}" provider option`);

  await new Promise((r) => setTimeout(r, 1000));

  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) throw new Error('Could not find the key-file upload input');
  await fileInput.uploadFile(keyPath);
  await new Promise((r) => setTimeout(r, 500));

  const filledPassword = await page.evaluate((labelText, pass) => {
    let input = null;
    for (const label of Array.from(document.querySelectorAll('label'))) {
      if (!label.textContent || !label.textContent.includes(labelText)) continue;
      const forId = label.getAttribute('for');
      input = (forId && document.getElementById(forId)) || label.querySelector('input');
      if (input) break;
    }
    if (!input) input = document.querySelector('input[type="password"]');
    if (!input) return false;
    input.value = pass;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, ECP_PASSWORD_LABEL_TEXT, password);
  if (!filledPassword) throw new Error('Could not find the private-key password field');

  // Give a reactive form a moment to enable the button after the password
  // input/change events above (some only flip disabled->enabled async).
  await new Promise((r) => setTimeout(r, 500));

  const clickOutcome = await page.evaluate((btnText) => {
    const isVisible = (e) => {
      const style = window.getComputedStyle(e);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = e.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a'))
      .filter((e) => (e.textContent || e.value || '').trim().includes(btnText));
    // Prefer a real, visible, enabled button/submit-input over e.g. a decoy <a>.
    const el = candidates.find((e) => isVisible(e) && !e.disabled)
      || candidates.find((e) => !e.disabled)
      || candidates[0];
    if (!el) return { found: false, candidateCount: 0 };

    // Exactly ONE submission trigger — stacking click() + a synthetic mouse
    // sequence + form.requestSubmit() on the same element submits the form
    // multiple times in a row, which stalls/reloads the page mid-navigation.
    el.click();
    return { found: true, candidateCount: candidates.length, tag: el.tagName, disabled: !!el.disabled };
  }, ECP_LOGIN_BUTTON_TEXT);

  if (!clickOutcome.found) throw new Error(`Could not find the "${ECP_LOGIN_BUTTON_TEXT}" button`);
  onProgress(`  🖱 Clicked "${ECP_LOGIN_BUTTON_TEXT}" (${clickOutcome.candidateCount} candidate(s) matched, used a <${clickOutcome.tag}>${clickOutcome.disabled ? ', was disabled' : ''})`);

  await new Promise((r) => setTimeout(r, 5000));
  try {
    // Signature verification server-side can be slow — a bit more headroom
    // than the initial page-load waits elsewhere.
    await page.waitForSelector('#cadastr_find_by_cadnum_cadNum', { timeout: 45000 });
  } catch (waitErr) {
    // Surface what's actually on screen instead of a bare timeout — this is
    // what tells us whether login was rejected, is just slow, or landed
    // somewhere unexpected, without needing someone to watch it live.
    const diag = await page.evaluate(() => {
      const errorSelectors = ['.alert', '.error', '.text-danger', '[class*="error" i]', '[class*="alert" i]', '[class*="invalid" i]'];
      const seen = new Set();
      for (const sel of errorSelectors) {
        document.querySelectorAll(sel).forEach((el) => {
          const t = (el.textContent || '').trim();
          if (t) seen.add(t);
        });
      }
      return {
        url: location.href,
        title: document.title,
        errors: [...seen].slice(0, 5),
        bodyPreview: (document.body.innerText || '').trim().slice(0, 300),
      };
    }).catch(() => null);
    if (diag) {
      onProgress(`  🔍 Page after clicking login — url: ${diag.url}${diag.title ? `, title: "${diag.title}"` : ''}`);
      if (diag.errors.length) onProgress(`  🔍 Error text found on page: ${diag.errors.join(' | ')}`);
      else if (diag.bodyPreview) onProgress(`  🔍 Visible page text: ${diag.bodyPreview.replace(/\s+/g, ' ')}`);
    }
    throw waitErr;
  }
  onProgress('  ✅ Re-authenticated automatically.');
}

// Shared by the normal end-of-run path and the "checkpoint was already
// complete" shortcut — turns raw lookup results into the requested output.
async function writeLookupOutput(results, outputFormat, outputPath, onProgress, options) {
  // `data` is attached to every branch's result — callers that just want the
  // raw rows (e.g. to merge into KMZ properties) can rely on it no matter
  // which file format was also requested.
  if (outputFormat === 'json') {
    return { success: true, count: results.length, data: results };
  }
  if (outputFormat === 'docx') {
    onProgress('📄 Writing Word document…');
    const outcome = await writeDocxReport(results, outputPath, onProgress);
    return { ...outcome, data: results };
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
  return { success: true, outputPath: excelOutputPath, docxOutputPath, count: results.length, data: results };
}

async function lookupEland(csvPath, outputPath, onProgress, chromePath, options = {}) {
  const outputFormat = detectOutputFormat(outputPath, options.format);
  _stopped = false;

  const cadnums = Array.isArray(csvPath) ? csvPath : readCadnums(csvPath);
  const checkpointPath = checkpointPathFor(cadnums, outputPath);
  const resumedResults = loadCheckpoint(checkpointPath);
  // Matched by cadnum, not position — a re-scrape can produce the same
  // cadnums in a different order, and this must still recognize them as done.
  const doneSet = new Set((resumedResults || []).map((r) => r.cadnum));
  const remainingCount = cadnums.filter((c) => !doneSet.has(c)).length;

  // Crashed/closed right after the last lookup, before output got written —
  // no need to reopen a browser and ask for login again at all.
  if (resumedResults && remainingCount === 0) {
    onProgress(`♻️ Found a complete checkpoint (${resumedResults.length}/${cadnums.length}) — skipping straight to writing output…`);
    const outcome = await writeLookupOutput(resumedResults, outputFormat, outputPath, onProgress, options);
    clearCheckpoint(checkpointPath);
    return outcome;
  }

  const results = resumedResults ? resumedResults.slice() : [];
  if (doneSet.size > 0) {
    onProgress(`♻️ Resuming from checkpoint: ${doneSet.size}/${cadnums.length} already done, ${remainingCount} left`);
  }

  onProgress('🌐 Opening e.land.gov.ua — please log in with your digital signature key…');

  const launchOpts = {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1200,800'],
    defaultViewport: null,
  };
  if (chromePath) launchOpts.executablePath = chromePath;

  const browser = await puppeteer.launch(launchOpts);

  try {
    let page = await browser.newPage();
    await page.goto(ELAND_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    let alreadyOnForm = false;
    try {
      await page.waitForSelector('#cadastr_find_by_cadnum_cadNum', { timeout: 3000 });
      alreadyOnForm = true;
    } catch (_) {}

    if (!alreadyOnForm) {
      try {
        await performEcpAutoLogin(page, onProgress);
      } catch (autoErr) {
        onProgress(`  ⚠ Automated login didn't work (${autoErr.message}) — falling back to manual login.`);
        onProgress('⏳ Waiting for you to complete login… (up to 5 minutes)');
        try {
          await page.waitForSelector('#cadastr_find_by_cadnum_cadNum', { timeout: 300000 });
        } catch {
          throw new Error('Login timeout (5 min). Please try again.');
        }
      }
    }
    onProgress(`✅ Logged in. Starting batch lookup… (${remainingCount} remaining)`);

    // Re-used any time the lookup form isn't where we expect it — including
    // mid-run, when the session has quietly expired. Tries the automated
    // ЕЦП/КЕП login before giving up, so a dropped session doesn't cascade
    // into every remaining cadnum failing. Circuit breaker: since the auto-
    // login selectors weren't verified against the live page, if it keeps
    // failing (wrong selector somewhere), stop burning ~10s/attempt on every
    // single remaining cadnum and fail fast instead.
    let reloginFailures = 0;
    const MAX_RELOGIN_FAILURES = 3;
    let reloginDisabled = false;
    const ensureLookupPage = async () => {
      const hasInput = await page.$('#cadastr_find_by_cadnum_cadNum');
      if (hasInput) return;
      if (reloginDisabled) throw new Error('SESSION_LOST_NO_AUTO_RELOGIN');
      await page.goto(ELAND_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      try {
        await page.waitForSelector('#cadastr_find_by_cadnum_cadNum', { timeout: 15000 });
        return;
      } catch (_) {
        onProgress('  🔑 Session appears to have expired — re-authenticating…');
        try {
          await performEcpAutoLogin(page, onProgress);
          reloginFailures = 0;
        } catch (loginErr) {
          reloginFailures++;
          if (reloginFailures >= MAX_RELOGIN_FAILURES) {
            reloginDisabled = true;
            onProgress(`  🛑 Auto re-login failed ${reloginFailures} times in a row (${loginErr.message}) — giving up on it for the rest of this run. The login flow's selectors likely need adjusting.`);
          }
          throw loginErr;
        }
      }
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

      const navWait = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 })
        .then(() => 'navigation')
        .catch(() => null);
      const domWait = page.waitForFunction(() => document.querySelectorAll('tr td').length >= 6, { timeout: 5000 })
        .then(() => 'dom')
        .catch(() => null);
      const firstSignal = await Promise.race([navWait, domWait]);
      if (!firstSignal) {
        const [navRes, domRes] = await Promise.all([navWait, domWait]);
        if (!navRes && !domRes) throw new Error('Lookup response timeout (5s)');
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

      await new Promise(r => setTimeout(r, 150));
      return extractFields(page);
    };

    const loopStartTime = Date.now();
    let recoveryAttempts = 0;
    let processedThisRun = 0;
    const MAX_RECOVERY_ATTEMPTS = 5;

    for (let i = 0; i < cadnums.length; i++) {
      if (_stopped) { onProgress('⛔ Stopped by user.'); break; }
      const cadnum = cadnums[i];
      if (doneSet.has(cadnum)) continue; // already resolved in a prior (checkpointed) run

      // ETA based on this run's own pace so far (resumed prior progress doesn't skew it).
      let etaSuffix = '';
      if (processedThisRun >= 5) {
        const avgMs = (Date.now() - loopStartTime) / processedThisRun;
        etaSuffix = ` · ~${formatDuration(avgMs * (remainingCount - processedThisRun))} left`;
      }
      onProgress(`[${i + 1}/${cadnums.length}] ${cadnum}${etaSuffix}`);
      processedThisRun++;

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
          await ensureLookupPage();
          data = await submitLookup(digits);
          filled = Object.entries(data.fields)
            .filter(([k, v]) => k !== 'Кадастровий номер земельної ділянки' && !!v)
            .length;
        }

        if (filled === 0) onProgress(`  ${noDataMessage}`);
        results.push({
          cadnum,
          [CADNUM_FIELD]: cadnum,
          ...data.fields,
          fieldOrder: data.fieldOrder || [],
          sections: data.sections || [],
          error: filled === 0 ? noDataMessage : '',
        });

      } catch (err) {
        // The OS dropped the network (sleep, wifi blip) — pause and retry the
        // SAME cadnum once it's back, instead of burning it (and everything
        // after it) as an instant failure.
        if (isOfflineError(err)) {
          onProgress(`  🌐 Connection lost — pausing and waiting for it to come back before retrying "${cadnum}"…`);
          const backOnline = await waitForConnectionAndPage(page, onProgress);
          if (backOnline) { i--; continue; }
          // Still offline after a very long wait — stop the whole run rather
          // than marking THIS cadnum as a permanent failure: the checkpoint
          // treats anything recorded as "done" and would never retry it,
          // silently losing it forever even once reconnected. Leaving it
          // unrecorded means the next run picks it straight back up.
          onProgress(`  🛑 Connection never came back. Stopping here — progress is saved, re-run to resume from "${cadnum}" (${i + 1}/${cadnums.length}).`);
          saveCheckpoint(checkpointPath, results);
          break;
        }

        // The tab/page itself is dead (closed, crashed, detached frame —
        // typically the laptop was closed or Chrome got killed). If the
        // browser process is still alive, open a fresh tab (same login
        // session — cookies live on the browser, not the tab) and retry.
        if (isFatalPageError(err) && recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
          let recovered = false;
          if (browser.isConnected()) {
            try {
              const freshPage = await browser.newPage();
              await freshPage.goto(ELAND_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
              await freshPage.waitForSelector('#cadastr_find_by_cadnum_cadNum', { timeout: 30000 });
              try { await page.close(); } catch (_) {}
              page = freshPage;
              recovered = true;
            } catch (_) { /* the recovery attempt itself failed */ }
          }
          recoveryAttempts++;
          if (recovered) {
            onProgress('  ♻️ Browser tab had closed/crashed — recovered with a fresh tab, retrying…');
            i--; continue;
          }
        }

        if (isFatalPageError(err)) {
          onProgress(`  🛑 Browser window appears to have closed or crashed (laptop sleep/close is the usual cause). Stopping here — progress is saved, re-run to resume from ${i + 1}/${cadnums.length}.`);
          saveCheckpoint(checkpointPath, results);
          break;
        }

        // Session expired AND auto re-login has already failed 3 times this
        // run — every remaining cadnum would fail the exact same way, so
        // stop now instead of limping through the rest of the list one
        // guaranteed failure at a time. Progress is saved either way.
        if (err.message === 'SESSION_LOST_NO_AUTO_RELOGIN') {
          onProgress(`  🛑 Session expired and automated re-login isn't working. Stopping here — progress is saved. Log in manually (or fix the auto-login selectors) and re-run to resume from ${i + 1}/${cadnums.length}.`);
          saveCheckpoint(checkpointPath, results);
          break;
        }

        onProgress(`  ⚠ Error for ${cadnum}: ${err.message}`);
        results.push({ cadnum, [CADNUM_FIELD]: cadnum, error: err.message });
        try {
          await page.goto(ELAND_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await ensureLookupPage();
        } catch (_) {}
      }

      if (results.length % 25 === 0) saveCheckpoint(checkpointPath, results);
      await new Promise(r => setTimeout(r, 150));
    }

    const fullyDone = results.length >= cadnums.length;
    const outcome = await writeLookupOutput(results, outputFormat, outputPath, onProgress, options);
    await browser.close();
    if (fullyDone) {
      clearCheckpoint(checkpointPath);
    } else {
      saveCheckpoint(checkpointPath, results);
      onProgress(`💾 Progress saved (${results.length}/${cadnums.length}) — re-run with the same list to continue from here.`);
    }
    return outcome;

  } catch (err) {
    await browser.close().catch(() => {});
    saveCheckpoint(checkpointPath, results.length ? results : (resumedResults || []));
    throw err;
  }
}

function stopLookup() { _stopped = true; }

module.exports = { lookupEland, stopLookup, mergeElandPartialExcel, mergeElandDocx };
