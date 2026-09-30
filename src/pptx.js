const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');
const pptxgen = require('pptxgenjs');
const { getPrimaryAiConfig, getFallbackAiConfig } = require('./config');

let _stopped = false;
let _currentReq = null;

function stopPresentationGenerate() {
  _stopped = true;
  if (_currentReq) {
    try { _currentReq.destroy(); } catch (_) {}
    _currentReq = null;
  }
}

function checkStopped() {
  if (_stopped) throw new Error('Cancelled by user');
}

// ── HTTP: JSON POST over http or https, matching src/osm.js's httpPost() shape ──
function httpsPostJson(baseUrl, path_, body, headers = {}, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(baseUrl.replace(/\/+$/, '') + path_);
    } catch (err) {
      return reject(new Error(`Invalid AI endpoint URL: ${baseUrl}`));
    }
    const mod = urlObj.protocol === 'http:' ? http : https;
    const buf = Buffer.from(JSON.stringify(body));
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'http:' ? 80 : 443),
      path: urlObj.pathname + (urlObj.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': buf.length,
        'User-Agent': 'land-management-app/1.0',
        ...headers,
      },
    };
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        _currentReq = null;
        resolve({ statusCode: res.statusCode, body: data });
      });
    });
    _currentReq = req;
    req.on('error', (err) => { _currentReq = null; reject(err); });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(buf);
    req.end();
  });
}

// ── Theme extraction ────────────────────────────────────────────────────────
function matchAll(re, str) {
  const out = [];
  let m;
  const r = new RegExp(re, 'g');
  while ((m = r.exec(str))) out.push(m);
  return out;
}

async function extractPptxTheme(templatePath) {
  const data = fs.readFileSync(templatePath);
  const zip = await JSZip.loadAsync(data);

  const theme = {
    colors: {},
    fonts: { major: 'Calibri', minor: 'Calibri' },
    widescreen: true,
    layoutSummary: [],
  };

  const themeFile = zip.file('ppt/theme/theme1.xml');
  if (themeFile) {
    const xml = await themeFile.async('string');
    const schemeNames = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
    for (const name of schemeNames) {
      const block = xml.match(new RegExp(`<a:${name}>([\\s\\S]*?)<\\/a:${name}>`));
      if (!block) continue;
      const srgb = block[1].match(/<a:srgbClr val="([0-9A-Fa-f]{6})"/);
      const sys = block[1].match(/<a:sysClr[^>]*lastClr="([0-9A-Fa-f]{6})"/);
      const hex = srgb ? srgb[1] : (sys ? sys[1] : null);
      if (hex) theme.colors[name] = hex.toUpperCase();
    }
    const majorMatch = xml.match(/<a:majorFont>[\s\S]*?<a:latin typeface="([^"]+)"/);
    const minorMatch = xml.match(/<a:minorFont>[\s\S]*?<a:latin typeface="([^"]+)"/);
    if (majorMatch && majorMatch[1] && majorMatch[1] !== '+mj-lt') theme.fonts.major = majorMatch[1];
    if (minorMatch && minorMatch[1] && minorMatch[1] !== '+mn-lt') theme.fonts.minor = minorMatch[1];
  }

  const presFile = zip.file('ppt/presentation.xml');
  if (presFile) {
    const xml = await presFile.async('string');
    const sz = xml.match(/<p:sldSz cx="(\d+)" cy="(\d+)"/);
    if (sz) {
      const cx = parseInt(sz[1], 10);
      const cy = parseInt(sz[2], 10);
      theme.widescreen = cx / cy > 1.5;
    }
  }

  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml/)[1], 10);
      const nb = parseInt(b.match(/slide(\d+)\.xml/)[1], 10);
      return na - nb;
    })
    .slice(0, 30);

  for (const name of slideFiles) {
    const xml = await zip.file(name).async('string');
    const shapes = matchAll('<p:sp>', xml).length;
    const pics = matchAll('<p:pic>', xml).length;
    const charts = matchAll('<c:chart|<p:graphicFrame>[\\s\\S]{0,200}chart', xml).length;
    const tables = matchAll('<a:tbl>', xml).length;
    const parts = [];
    if (shapes) parts.push(`${shapes} text block(s)`);
    if (pics) parts.push(`${pics} image(s)`);
    if (charts) parts.push(`${charts} chart(s)`);
    if (tables) parts.push(`${tables} table(s)`);
    theme.layoutSummary.push(`${name}: ${parts.join(', ') || 'empty/decorative'}`);
  }

  return theme;
}

// ── Data extraction from attached .docx / .xlsx ─────────────────────────────
const PER_FILE_CHAR_CAP = 20000;
const TOTAL_CHAR_CAP = 60000;

async function extractXlsxText(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const lines = [];
  wb.worksheets.forEach((ws) => {
    lines.push(`# Sheet: ${ws.name}`);
    ws.eachRow((row) => {
      const cells = (row.values || []).slice(1).map((v) => {
        if (v == null) return '';
        if (typeof v === 'object') {
          if (Array.isArray(v.richText)) return v.richText.map((x) => x.text || '').join('');
          if (v.text) return String(v.text);
          if (v.result != null) return String(v.result);
        }
        return String(v);
      });
      if (cells.some((c) => c !== '')) lines.push(cells.join(' | '));
    });
  });
  return lines.join('\n');
}

async function extractDocxText(filePath) {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);
  const docFile = zip.file('word/document.xml');
  if (!docFile) return '';
  const xml = await docFile.async('string');

  const lines = [];
  const paragraphs = matchAll('<w:p[ >][\\s\\S]*?<\\/w:p>', xml);
  for (const p of paragraphs) {
    const runs = matchAll('<w:t[^>]*>([^<]*)<\\/w:t>', p[0]);
    const text = runs.map((r) => r[1]).join('');
    if (text.trim()) lines.push(text.trim());
  }

  const tables = matchAll('<w:tbl>[\\s\\S]*?<\\/w:tbl>', xml);
  for (const t of tables) {
    const rows = matchAll('<w:tr[ >][\\s\\S]*?<\\/w:tr>', t[0]);
    for (const r of rows) {
      const cells = matchAll('<w:tc[ >][\\s\\S]*?<\\/w:tc>', r[0]);
      const cellTexts = cells.map((c) => {
        const runs = matchAll('<w:t[^>]*>([^<]*)<\\/w:t>', c[0]);
        return runs.map((run) => run[1]).join('');
      });
      if (cellTexts.some((c) => c.trim())) lines.push(cellTexts.join(' | '));
    }
  }

  return lines.join('\n');
}

async function extractDataFiles(filePaths, onProgress) {
  const parts = [];
  let total = 0;
  for (const filePath of filePaths) {
    checkStopped();
    const ext = path.extname(filePath).toLowerCase();
    let text = '';
    try {
      if (ext === '.xlsx') text = await extractXlsxText(filePath);
      else if (ext === '.docx') text = await extractDocxText(filePath);
      else {
        onProgress(`⚠ Skipping unsupported file type: ${path.basename(filePath)}`);
        continue;
      }
    } catch (err) {
      onProgress(`⚠ Failed to read ${path.basename(filePath)}: ${err.message}`);
      continue;
    }
    let truncated = false;
    if (text.length > PER_FILE_CHAR_CAP) {
      text = text.slice(0, PER_FILE_CHAR_CAP);
      truncated = true;
    }
    if (total + text.length > TOTAL_CHAR_CAP) {
      text = text.slice(0, Math.max(0, TOTAL_CHAR_CAP - total));
      truncated = true;
    }
    total += text.length;
    if (truncated) onProgress(`⚠ Truncated ${path.basename(filePath)} to fit context limits.`);
    parts.push(`## Source: ${path.basename(filePath)}\n${text}`);
    if (total >= TOTAL_CHAR_CAP) break;
  }
  return parts.join('\n\n');
}

// ── LLM outline request, primary (local 9router) with OpenRouter fallback ──
// 9router selects a preset pipeline ("combo") by name via the `model` field,
// independent of whatever plain model string is configured for the primary
// provider — presentation generation always asks for the "presentation-maker"
// combo rather than the user-configured ai-primary-model value.
const PRIMARY_COMBO_MODEL = 'presentation-maker';
const OUTLINE_SCHEMA_PROMPT = `You are a professional presentation designer. Turn the provided data into a structured slide outline for a PowerPoint deck.

Respond with ONLY valid JSON (no markdown fences, no commentary) matching exactly this schema:
{
  "deckTitle": string,
  "subtitle": string,
  "slides": [{
    "type": "title"|"section"|"content"|"stats"|"chart"|"table"|"closing",
    "title": string,
    "bullets": string[] (optional),
    "stats": [{"label": string, "value": string, "unit": string}] (optional),
    "chart": {"chartType": "bar"|"column"|"line"|"pie"|"doughnut", "stacked": boolean, "title": string, "categories": string[], "series": [{"name": string, "values": number[]}]} (optional),
    "table": {"headers": string[], "rows": string[][]} (optional),
    "notes": string (optional)
  }]
}

Guidelines:
- Start with a "title" slide and end with a "closing" slide.
- Use "stats" slides for headline numbers, "chart" for trends/comparisons, "table" for detailed breakdowns.
- Keep bullet text concise (under ~15 words each).
- Only include numeric data that is actually present in the source material — never invent numbers.
- Produce between 6 and 14 slides depending on how much material is available.`;

function buildUserPrompt({ topic, theme, extractedData }) {
  return [
    `Topic / deck name: ${topic || '(untitled)'}`,
    '',
    `Template layout reference (${theme.widescreen ? '16:9' : '4:3'}, ${theme.layoutSummary.length} slides scanned):`,
    theme.layoutSummary.slice(0, 15).join('\n') || '(no layout info available)',
    '',
    'Source data extracted from attached files:',
    extractedData || '(no data attached)',
  ].join('\n');
}

function parseOutlineJson(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) text = text.slice(firstBrace, lastBrace + 1);
  return JSON.parse(text);
}

function validateOutline(outline) {
  if (!outline || typeof outline !== 'object') throw new Error('Outline is not an object');
  if (!outline.deckTitle) throw new Error('Missing deckTitle');
  if (!Array.isArray(outline.slides) || !outline.slides.length) throw new Error('Missing slides[]');
  for (const slide of outline.slides) {
    if (slide.chart) {
      const c = slide.chart;
      const valid = c.chartType && Array.isArray(c.categories) && Array.isArray(c.series) && c.series.length &&
        c.series.every((s) => s.name && Array.isArray(s.values));
      if (!valid) { delete slide.chart; if (!slide.type || slide.type === 'chart') slide.type = 'content'; }
    }
    if (slide.table) {
      const t = slide.table;
      const valid = Array.isArray(t.headers) && t.headers.length && Array.isArray(t.rows);
      if (!valid) { delete slide.table; if (!slide.type || slide.type === 'table') slide.type = 'content'; }
    }
  }
  return outline;
}

async function callChatCompletion(providerConfig, systemPrompt, userPrompt, onProgress, label) {
  if (!providerConfig.apiKey) throw new Error(`${label} has no API key configured`);
  const body = {
    model: providerConfig.model,
    temperature: 0.4,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };
  const res = await httpsPostJson(providerConfig.baseUrl, '/chat/completions', body, {
    Authorization: `Bearer ${providerConfig.apiKey}`,
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let message = res.body;
    try {
      const parsed = JSON.parse(res.body);
      message = (parsed.error && (parsed.error.message || parsed.error)) || res.body;
    } catch (_) {}
    throw new Error(`${label} returned HTTP ${res.statusCode}: ${message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (err) {
    throw new Error(`${label} returned a non-JSON response`);
  }
  const content = parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
  if (!content) throw new Error(`${label} response had no message content`);
  return content;
}

async function requestSlideOutline({ theme, extractedData, topic }, onProgress) {
  const userPrompt = buildUserPrompt({ topic, theme, extractedData });
  const primary = { ...getPrimaryAiConfig(), model: PRIMARY_COMBO_MODEL };
  const fallback = getFallbackAiConfig();

  const attempts = [];
  if (primary.apiKey || primary.baseUrl.includes('localhost') || primary.baseUrl.includes('127.0.0.1')) {
    attempts.push({ config: primary, label: 'Primary AI (9router, presentation-maker combo)' });
  }
  attempts.push({ config: fallback, label: 'Fallback AI (OpenRouter)' });

  let lastError = null;
  for (const attempt of attempts) {
    checkStopped();
    if (!attempt.config.apiKey) {
      onProgress(`⚠ ${attempt.label}: no API key configured, skipping.`);
      continue;
    }
    onProgress(`🤖 Requesting slide outline from ${attempt.label} (${attempt.config.model})…`);
    try {
      const raw = await callChatCompletion(attempt.config, OUTLINE_SCHEMA_PROMPT, userPrompt, onProgress, attempt.label);
      try {
        const outline = validateOutline(parseOutlineJson(raw));
        onProgress(`✅ Outline received from ${attempt.label} (${outline.slides.length} slides).`);
        return outline;
      } catch (parseErr) {
        onProgress(`⚠ ${attempt.label} returned malformed JSON, retrying once with a stricter prompt…`);
        checkStopped();
        const retryPrompt = `${userPrompt}\n\nIMPORTANT: your previous response could not be parsed as JSON (${parseErr.message}). Respond with ONLY the raw JSON object, nothing else.`;
        const raw2 = await callChatCompletion(attempt.config, OUTLINE_SCHEMA_PROMPT, retryPrompt, onProgress, attempt.label);
        const outline2 = validateOutline(parseOutlineJson(raw2));
        onProgress(`✅ Outline received from ${attempt.label} after retry (${outline2.slides.length} slides).`);
        return outline2;
      }
    } catch (err) {
      lastError = err;
      onProgress(`❌ ${attempt.label} failed: ${err.message}`);
    }
  }
  throw lastError || new Error('No AI provider is configured. Add an API key in Presentation settings.');
}

// ── Slide building via pptxgenjs ────────────────────────────────────────────
const SAFE_FONTS = ['Calibri', 'Arial', 'Georgia', 'Verdana', 'Cambria', 'Segoe UI', 'Times New Roman'];

function safeFont(name) {
  if (!name) return 'Calibri';
  const found = SAFE_FONTS.find((f) => f.toLowerCase() === String(name).toLowerCase());
  return found || 'Calibri';
}

function buildPptx(outline, theme, outputPath) {
  const pres = new pptxgen();
  pres.layout = theme.widescreen ? 'LAYOUT_WIDE' : 'LAYOUT_4x3';

  const accent = theme.colors.accent1 || '416180';
  const accent2 = theme.colors.accent2 || '5980A6';
  const dark = theme.colors.dk2 || theme.colors.dk1 || '1D2D3D';
  const light = theme.colors.lt1 || 'FFFFFF';
  const bodyText = theme.colors.dk1 || '1D1F20';
  const headingFont = safeFont(theme.fonts.major);
  const bodyFont = safeFont(theme.fonts.minor);

  const chartPalette = [accent, accent2, theme.colors.accent3 || '749DC4', theme.colors.accent4 || '94BCE3', theme.colors.accent5 || 'B5D9FD', theme.colors.accent6 || 'D6EBFF'];

  outline.slides.forEach((slide, idx) => {
    const s = pres.addSlide();

    if (slide.type === 'title' || idx === 0) {
      s.background = { color: dark };
      s.addText(outline.deckTitle || slide.title || '', {
        x: 0.7, y: 2.0, w: '85%', h: 1.4, isTextBox: true, margin: 0,
        fontFace: headingFont, fontSize: 40, bold: true, color: light,
      });
      if (outline.subtitle) {
        s.addText(outline.subtitle, {
          x: 0.7, y: 3.35, w: '80%', h: 0.7, isTextBox: true, margin: 0,
          fontFace: bodyFont, fontSize: 18, color: accent2,
        });
      }
      return;
    }

    if (slide.type === 'section') {
      s.background = { color: accent };
      s.addText(slide.title || '', {
        x: 0.7, y: 2.3, w: '85%', h: 1.2, isTextBox: true, margin: 0,
        fontFace: headingFont, fontSize: 32, bold: true, color: light,
      });
      return;
    }

    if (slide.type === 'closing') {
      s.background = { color: dark };
      s.addText(slide.title || 'Thank you', {
        x: 0.7, y: 2.2, w: '85%', h: 1.2, isTextBox: true, margin: 0,
        fontFace: headingFont, fontSize: 34, bold: true, color: light,
      });
      if (Array.isArray(slide.bullets) && slide.bullets.length) {
        s.addText(slide.bullets.join('\n'), {
          x: 0.7, y: 3.4, w: '80%', h: 1.5, isTextBox: true, margin: 0,
          fontFace: bodyFont, fontSize: 16, color: accent2,
        });
      }
      return;
    }

    s.background = { color: light };
    s.addText(slide.title || '', {
      x: 0.6, y: 0.45, w: '88%', h: 0.7, isTextBox: true, margin: 0,
      fontFace: headingFont, fontSize: 26, bold: true, color: dark,
    });

    if (slide.type === 'stats' && Array.isArray(slide.stats) && slide.stats.length) {
      const n = Math.min(slide.stats.length, 4);
      const colW = 12.0 / n;
      slide.stats.slice(0, n).forEach((stat, i) => {
        const x = 0.65 + i * colW;
        s.addText(`${stat.value || ''}${stat.unit ? ' ' + stat.unit : ''}`, {
          x, y: 1.6, w: colW - 0.3, h: 1.0, isTextBox: true, margin: 0, align: 'left',
          fontFace: headingFont, fontSize: 40, bold: true, color: accent,
        });
        s.addText(stat.label || '', {
          x, y: 2.6, w: colW - 0.3, h: 0.8, isTextBox: true, margin: 0, align: 'left',
          fontFace: bodyFont, fontSize: 13, color: bodyText,
        });
      });
    } else if (slide.type === 'chart' && slide.chart) {
      const c = slide.chart;
      const chartTypeMap = { bar: pres.ChartType.bar, column: pres.ChartType.bar, line: pres.ChartType.line, pie: pres.ChartType.pie, doughnut: pres.ChartType.doughnut };
      const chartType = chartTypeMap[c.chartType] || pres.ChartType.bar;
      const isPieLike = c.chartType === 'pie' || c.chartType === 'doughnut';
      const dataObj = isPieLike
        ? [{ name: c.series[0].name, labels: c.categories, values: c.series[0].values }]
        : c.series.map((series) => ({ name: series.name, labels: c.categories, values: series.values }));

      const chartOpts = {
        x: 0.6, y: 1.5, w: 12.1, h: 5.2,
        chartColors: chartPalette,
        showTitle: !!c.title,
        title: c.title || '',
        showLegend: c.series.length > 1 || isPieLike,
        showValue: true,
        catAxisLabelColor: bodyText,
        valAxisLabelColor: bodyText,
        valGridLine: { color: 'E7E7EA', size: 1 },
        catGridLine: { style: 'none' },
        barDir: c.chartType === 'bar' ? 'bar' : 'col',
      };
      if (!isPieLike && c.stacked) {
        chartOpts.barGrouping = 'stacked';
        chartOpts.dataLabelPosition = 'ctr';
      } else if (!isPieLike) {
        chartOpts.dataLabelPosition = 'outEnd';
      }
      s.addChart(chartType, dataObj, chartOpts);
    } else if (slide.type === 'table' && slide.table) {
      const rows = [
        slide.table.headers.map((h) => ({ text: h, options: { bold: true, color: light, fill: { color: accent } } })),
        ...slide.table.rows.map((row) => row.map((cell) => ({ text: String(cell == null ? '' : cell) }))),
      ];
      s.addTable(rows, {
        x: 0.6, y: 1.5, w: 12.1, h: 5.0,
        fontFace: bodyFont, fontSize: 12, color: bodyText,
        border: { type: 'solid', color: 'E7E7EA', pt: 1 },
        autoPage: false,
      });
    } else if (Array.isArray(slide.bullets) && slide.bullets.length) {
      s.addText(
        slide.bullets.map((b, i) => ({ text: b, options: { bullet: true, breakLine: i < slide.bullets.length - 1, paraSpaceAfter: 10 } })),
        { x: 0.65, y: 1.55, w: '85%', h: 5.0, isTextBox: true, margin: 0, fontFace: bodyFont, fontSize: 16, color: bodyText }
      );
    }

    if (slide.notes) s.addNotes(slide.notes);
  });

  return pres.writeFile({ fileName: outputPath });
}

// ── Orchestration ────────────────────────────────────────────────────────
async function generatePresentation(options, onProgress) {
  _stopped = false;
  const { templatePath, dataFilePaths, topic, outputPath } = options;

  try {
    if (!templatePath || !fs.existsSync(templatePath)) throw new Error('Template .pptx file was not found');
    if (!Array.isArray(dataFilePaths) || !dataFilePaths.length) throw new Error('No data files attached');
    if (!outputPath) throw new Error('No output path specified');

    onProgress('🎨 Extracting theme from template…');
    checkStopped();
    const theme = await extractPptxTheme(templatePath);
    onProgress(`✅ Theme extracted: ${Object.keys(theme.colors).length} colors, fonts ${theme.fonts.major}/${theme.fonts.minor}.`);

    onProgress('📄 Reading attached data files…');
    checkStopped();
    const extractedData = await extractDataFiles(dataFilePaths, onProgress);
    if (!extractedData.trim()) onProgress('⚠ No usable text extracted from attached files — outline will be generic.');

    checkStopped();
    const outline = await requestSlideOutline({ theme, extractedData, topic }, onProgress);

    onProgress('🏗️ Building slides…');
    checkStopped();
    await buildPptx(outline, theme, outputPath);

    onProgress(`✅ Presentation saved → ${outputPath}`);
    return { success: true, outputPath, slideCount: outline.slides.length };
  } catch (err) {
    if (_stopped) {
      onProgress('⏹ Presentation generation stopped.');
      return { success: false, error: 'Stopped by user' };
    }
    onProgress(`❌ Presentation generation failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = {
  generatePresentation,
  stopPresentationGenerate,
  extractPptxTheme,
  extractDataFiles,
};
