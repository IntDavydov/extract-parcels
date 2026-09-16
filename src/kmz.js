'use strict';

const JSZip = require('jszip');
const fs    = require('fs');
const path  = require('path');

// KML color format: aabbggrr (alpha, blue, green, red)
const LAYER_STYLES = {
  'Parcel Boundaries':  { poly: '00000000', line: 'ffffff55', width: 3 },
  'Territory Boundary': { line: 'ffffffff', width: 4 },
  'Land Parcels':       { poly: '00000000', line: 'ffffffff' },
  'Power Lines':        { line: 'ff00ffff', poly: '4000ffff' },
  'Power Lines 750kV':  { line: 'ffffff00', width: 3 }, // #00ffff
  'Power Lines 400kV':  { line: 'ffffaaaa', width: 3 }, // #aaaaff
  'Power Lines 330kV':  { line: 'ffff00aa', width: 3 }, // #aa00ff
  'Power Lines 220kV':  { line: 'ff0000ff', width: 3 }, // #ff0000
  'Power Lines 110kV':  { line: 'ff00ffff', width: 3 }, // #ffff00
  'Power Lines 35kV':   { line: 'ff00ff00', width: 3 }, // #00ff00
  'Power Lines Other':  { line: 'ffb4b4b4', width: 3 },
  'Towers':             { point: 'ff00ffff' },         // fallback (unknown voltage)
  'Towers_Low':         { point: 'ff00ff00' },         // < 20 kV  — Green
  'Towers_Medium':      { point: 'ff00ffff' },         // 20–110 kV — Yellow
  'Towers_High':        { point: 'ff00a5ff' },         // 110–220 kV — Orange
  'Towers_Extra':       { point: 'ff0000ff' },         // > 220 kV  — Red
  'Substations':        { poly: 'ff00ffff', line: 'ff00ffff' },
  'Airoports':          {
    poly: '99ffff00',
    line: 'ffffff00',
    point: 'ffffff00',
    icon: 'http://maps.google.com/mapfiles/kml/paddle/wht-blank.png',
    width: 2,
  },
  'Nuclear Power Plants': {
    poly: '66ff00ff',
    line: 'ffff00ff',
    point: 'ffff00ff',
    icon: 'http://maps.google.com/mapfiles/kml/paddle/wht-blank.png',
    width: 2,
  },
  'Roads':              { line: 'ff000000' },
  'Settlements':                 { poly: 'ffc9c9ff', line: 'ffc9c9ff' },
  'Settlement Pins':             { point: 'ffc9c9ff', icon: 'files/houses.png' },
  'Settlement Buffers':          { poly: 'ccc9c9ff', line: 'ffc9c9ff' },
  'Water':              { poly: 'ccff6600', line: 'ccff6600' },
  'Forests':            { poly: 'cc7fff00', line: '007fff00', noOutline: true },
  'Emerald Network':    { poly: 'cc7fff00', line: '007fff00', noOutline: true },
  'Emerald Buffer':     { poly: '8000ff00', line: '8800ff00', width: 2, noOutline: true },
  'Nature Reserves':    {
    poly: 'cc005555',
    line: 'ff005555',
    point: 'ff005555',
    // Use a neutral icon so KML color is applied (avoids default yellow pushpin rendering)
    icon: 'http://maps.google.com/mapfiles/kml/paddle/wht-blank.png',
    width: 2,
  },
  'Water Buffers':         { poly: '33ff6600', line: '66ff6600', width: 2, noOutline: true },
  'Forest Buffers':        { poly: '807fff00', line: '007fff00', width: 2, noOutline: true },
  'Road Buffers':          { poly: '33000080', line: '66000080', width: 2, noOutline: true },
  'Power Line Buffers':    { poly: '5500ffff', line: '8800ffff', width: 2, noOutline: true },
  'Airoports Buffer':      { poly: '66ffff00', line: 'aaffff00', width: 2, noOutline: true },
  'Nuclear Power Plants Buffer': { poly: '33ff00ff', line: '88ff00ff', width: 2, noOutline: true },
  'Nature Reserve Buffer': {
    poly: '80005555',
    line: '66005555',
    point: 'ff005555',
    icon: 'http://maps.google.com/mapfiles/kml/paddle/wht-blank.png',
    width: 2,
    noOutline: true,
  },
  'Wind Speed':            { point: 'ffffffff', icon: 'http://maps.google.com/mapfiles/kml/pushpin/blue-pushpin.png' },
};

// Group definitions — layers are nested inside parent folders in the KMZ
const LAYER_GROUPS = [
  { folder: 'Parcels',     layers: ['Land Parcels'] },
  { folder: 'Nature',      layers: ['Forests', 'Forest Buffers', 'Emerald Network', 'Emerald Buffer', 'Nature Reserves', 'Nature Reserve Buffer', 'Water', 'Water Buffers'] },
  { folder: 'Settlements', layers: ['Settlement Buffers', 'Settlements', 'Settlement Pins'] },
  { folder: 'Energy',      layers: ['Power Lines', 'Power Line Buffers', 'Substations', 'Towers'] },
];
// Layers not in any group render at root level in this order
const ROOT_ORDER = ['Territory Boundary', 'Roads', 'Road Buffers', 'Airoports', 'Airoports Buffer', 'Nuclear Power Plants', 'Nuclear Power Plants Buffer'];

function coordsToKml(coords, depth = 0) {
  if (depth === 0 && typeof coords[0] === 'number') {
    // single point [lng, lat] or [lng, lat, alt]
    return `${coords[0]},${coords[1]},0`;
  }
  if (depth === 0 || (Array.isArray(coords[0]) && typeof coords[0][0] === 'number')) {
    // ring of points
    return coords.map(c => `${c[0]},${c[1]},0`).join(' ');
  }
  return coords.map(c => coordsToKml(c, depth - 1)).join('');
}

function featureToKml(f, styleId) {
  const geom = f.geometry;
  if (!geom) return '';
  const name = f.properties?.name || f.properties?.ref || '';
  
  let desc = '';
  if (f.properties?.sections && Array.isArray(f.properties.sections)) {
    const cadnum = f.properties['Кадастровий номер земельної ділянки'] || f.properties.cadnum || '';
    let html = `<table style="font-family:Arial,sans-serif;font-size:12px;border-collapse:collapse;width:100%;">`;
    html += `<tr><td colspan="2" style="font-weight:bold;font-size:14px;padding-bottom:10px;">Кадастровий номер: ${escXml(String(cadnum))}</td></tr>`;
    if (f.properties.tenantName || f.properties.ownerName) {
      html += `<tr><td colspan="2" style="padding-bottom:8px;">`;
      if (f.properties.tenantName) html += `<div><b>Орендар:</b> ${escXml(String(f.properties.tenantName))}</div>`;
      if (f.properties.ownerName) html += `<div><b>Власник:</b> ${escXml(String(f.properties.ownerName))}</div>`;
      html += `</td></tr>`;
    }
    for (const section of f.properties.sections) {
      for (const row of section.rows) {
        if (row.label.toLowerCase().includes('кадастровий номер')) continue;
        html += `<tr>`;
        html += `<td style="padding:4px;border-bottom:1px solid #ccc;color:#555;width:40%;">[${escXml(String(section.title))}] ${escXml(String(row.label))}</td>`;
        html += `<td style="padding:4px;border-bottom:1px solid #ccc;font-weight:bold;">${escXml(String(row.value))}</td>`;
        html += `</tr>`;
      }
    }
    html += `</table>`;
    desc = `<![CDATA[${html}]]>`;
  } else {
    desc = Object.entries(f.properties || {})
      .filter(([k]) => !k.startsWith('_') && k !== 'name' && k !== 'sections' && k !== 'fieldOrder' && k !== 'error' && k !== 'colorKey')
      .map(([k, v]) => `${escXml(String(k))}: ${escXml(String(v))}`)
      .join('&#10;');
  }

  let geomKml = '';

  if (geom.type === 'Point') {
    geomKml = `<Point><coordinates>${coordsToKml(geom.coordinates, 0)}</coordinates></Point>`;
  } else if (geom.type === 'MultiPoint') {
    geomKml = geom.coordinates.map(c =>
      `<Point><coordinates>${coordsToKml(c, 0)}</coordinates></Point>`).join('');
  } else if (geom.type === 'LineString') {
    geomKml = `<LineString><tessellate>1</tessellate><coordinates>${coordsToKml(geom.coordinates, 0)}</coordinates></LineString>`;
  } else if (geom.type === 'MultiLineString') {
    geomKml = `<MultiGeometry>${geom.coordinates.map(c =>
      `<LineString><tessellate>1</tessellate><coordinates>${coordsToKml(c, 0)}</coordinates></LineString>`).join('')}</MultiGeometry>`;
  } else if (geom.type === 'Polygon') {
    const rings = geom.coordinates.map((ring, i) =>
      i === 0
        ? `<outerBoundaryIs><LinearRing><coordinates>${coordsToKml(ring, 0)}</coordinates></LinearRing></outerBoundaryIs>`
        : `<innerBoundaryIs><LinearRing><coordinates>${coordsToKml(ring, 0)}</coordinates></LinearRing></innerBoundaryIs>`
    ).join('');
    geomKml = `<Polygon>${rings}</Polygon>`;
  } else if (geom.type === 'MultiPolygon') {
    geomKml = `<MultiGeometry>${geom.coordinates.map(poly => {
      const rings = poly.map((ring, i) =>
        i === 0
          ? `<outerBoundaryIs><LinearRing><coordinates>${coordsToKml(ring, 0)}</coordinates></LinearRing></outerBoundaryIs>`
          : `<innerBoundaryIs><LinearRing><coordinates>${coordsToKml(ring, 0)}</coordinates></LinearRing></innerBoundaryIs>`
      ).join('');
      return `<Polygon>${rings}</Polygon>`;
    }).join('')}</MultiGeometry>`;
  }

  if (!geomKml) return '';

  return `<Placemark>
  <name>${escXml(name)}</name>
  <description>${desc}</description>
  <styleUrl>#${styleId}</styleUrl>
  ${geomKml}
</Placemark>`;
}

function escXml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Deterministic per-name colors (for coloring parcels by owner/tenant) ─────
// Same name always maps to the same color, run to run, regardless of the
// order names are first encountered in — a plain string hash into HSL space.
function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// Returns a KML color string (aabbggrr) deterministically derived from `name`.
function nameToKmlColor(name, alpha = 'cc') {
  const h = hashString(String(name));
  const hue = h % 360;
  const sat = 0.55 + ((h >>> 8) % 30) / 100;   // 0.55–0.84
  const light = 0.40 + ((h >>> 16) % 25) / 100; // 0.40–0.64
  const [r, g, b] = hslToRgb(hue, sat, light);
  const hex = (n) => n.toString(16).padStart(2, '0');
  return `${alpha}${hex(b)}${hex(g)}${hex(r)}`; // KML order is aabbggrr
}

function colorKeyStyleId(name) {
  return `by_name_${hashString(String(name)).toString(36)}`;
}

// Map OSM voltage tag (volts or kV string) to a tower style ID
function towerStyleId(voltageTag) {
  if (!voltageTag) return 'Towers';
  // OSM stores voltage in volts (e.g. "110000") or sometimes kV ("110")
  let kv = parseFloat(String(voltageTag).split(';')[0]); // take first value if semicolon-separated
  if (!isFinite(kv)) return 'Towers';
  if (kv > 1000) kv /= 1000; // convert V → kV
  if (kv < 20)  return 'Towers_Low';
  if (kv < 110) return 'Towers_Medium';
  if (kv < 220) return 'Towers_High';
  return 'Towers_Extra';
}

function parseVoltageKv(voltageTag) {
  if (!voltageTag) return null;
  const values = String(voltageTag)
    .split(/[;,/]/)
    .map((part) => parseFloat(part.trim()))
    .filter((n) => isFinite(n) && n > 0)
    .map((n) => (n > 1000 ? n / 1000 : n));
  if (!values.length) return null;
  return Math.max(...values);
}

function powerLineBucketName(voltageTag) {
  const kv = parseVoltageKv(voltageTag);
  if (kv == null) return 'Other';
  if (kv >= 700) return '750kV';
  if (kv >= 360) return '400kV';
  if (kv >= 300) return '330kV';
  if (kv >= 200) return '220kV';
  if (kv >= 90)  return '110kV';
  if (kv >= 30)  return '35kV';
  return 'Other';
}

function powerLineStyleId(voltageTag) {
  return `Power Lines ${powerLineBucketName(voltageTag)}`.replace(/[^a-zA-Z0-9]/g, '_');
}

function customIconStyleId(iconName) {
  return `Custom_Icon_${iconName.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

function buildStyles(stylesMap, customIconNames = []) {
  const lines = [];
  for (const [layerName, colors] of Object.entries(stylesMap || {})) {
    const id = layerName.replace(/[^a-zA-Z0-9]/g, '_');
    const pointColor = colors.point || colors.line || 'ffffffff';
    const lineColor  = colors.line  || 'ffffffff';
    const polyColor  = colors.poly  || '4400ff00';
    const iconStyle  = colors.icon
      ? `<IconStyle><color>${pointColor}</color><scale>1.0</scale><Icon><href>${colors.icon}</href></Icon></IconStyle>`
      : `<IconStyle><color>${pointColor}</color><scale>0.8</scale></IconStyle>`;
    const lineWidth = colors.width || 2;
    const polyOutline = colors.noOutline ? '<outline>0</outline>' : '';
    lines.push(`<Style id="${id}">
  ${iconStyle}
  <LineStyle><color>${lineColor}</color><width>${lineWidth}</width></LineStyle>
  <PolyStyle><color>${polyColor}</color>${polyOutline}</PolyStyle>
</Style>`);
  }
  for (const iconName of customIconNames) {
    const id = customIconStyleId(iconName);
    lines.push(`<Style id="${id}">
  <IconStyle><color>ffffffff</color><scale>1.0</scale><Icon><href>files/${escXml(iconName)}</href></Icon></IconStyle>
  <LineStyle><color>ffffffff</color><width>2</width></LineStyle>
  <PolyStyle><color>00000000</color><outline>0</outline></PolyStyle>
</Style>`);
  }
  return lines.join('\n');
}

function findTemplatePoint(layerMap) {
  for (const features of Object.values(layerMap || {})) {
    for (const f of features || []) {
      const g = f && f.geometry;
      if (!g) continue;
      if (g.type === 'Point' && Array.isArray(g.coordinates)) return g.coordinates;
      if (g.type === 'MultiPoint' && g.coordinates[0]) return g.coordinates[0];
      if (g.type === 'LineString' && g.coordinates[0]) return g.coordinates[0];
      if (g.type === 'MultiLineString' && g.coordinates[0] && g.coordinates[0][0]) return g.coordinates[0][0];
      if (g.type === 'Polygon' && g.coordinates[0] && g.coordinates[0][0]) return g.coordinates[0][0];
      if (g.type === 'MultiPolygon' && g.coordinates[0] && g.coordinates[0][0] && g.coordinates[0][0][0]) return g.coordinates[0][0][0];
    }
  }
  return [30.5234, 50.4501]; // fallback: Kyiv
}


async function exportKMZ(layerMap, outputPath, onProgress, groundOverlays = [], docName = 'Kadastr') {
  onProgress('🗺 Building KML…');
  const os = require('os');
  const tmpKmlPath = path.join(os.tmpdir(), `doc-${Date.now()}.kml`);
  const ws = fs.createWriteStream(tmpKmlPath, { encoding: 'utf8' });

  try {
  const isPackaged = __dirname.includes('app.asar');
  const appRoot = isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : path.join(__dirname, '..');
  const bundledIcons = new Set(['houses.png', 'windmill.png']);
  const iconDirs = [
    path.join(appRoot, 'icons'),
    isPackaged ? path.join(process.resourcesPath, 'app.asar', 'icons') : '',
    path.join(path.dirname(outputPath), 'icons'),
    path.join(process.cwd(), 'icons'),
  ].filter(Boolean);
  for (const iconDir of iconDirs) {
    if (!fs.existsSync(iconDir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(iconDir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!/\.png$/i.test(ent.name)) continue;
      bundledIcons.add(ent.name);
    }
  }
  const iconSearchDirs = [
    appRoot,
    ...iconDirs,
    process.cwd(),
  ];
  const findIconSource = (iconName) => {
    for (const dir of iconSearchDirs) {
      const src = path.join(dir, iconName);
      if (fs.existsSync(src)) return src;
    }
    return null;
  };
  const runtimeStyles = JSON.parse(JSON.stringify(LAYER_STYLES));
  if (!findIconSource('windmill.png')) {
    runtimeStyles['Wind Speed'].icon = 'http://maps.google.com/mapfiles/kml/pushpin/blue-pushpin.png';
  }
  const customIconNames = [...bundledIcons].filter(n => !['houses.png', 'windmill.png'].includes(n)).sort();
  const styles = buildStyles(runtimeStyles, customIconNames);

  ws.write(`<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n  <name>${escXml(docName)}</name>\n  ${styles}\n`);

  // Parcels carrying properties.colorKey (e.g. tenant/owner name) get their
  // own per-name Style, declared the first time that name is seen, instead
  // of the layer's shared style — this is how per-owner/tenant coloring works.
  const declaredNameStyles = new Set();
  function resolveStyleId(f, defaultStyleId) {
    const colorKey = f?.properties?.colorKey;
    if (!colorKey) return defaultStyleId;
    const id = colorKeyStyleId(colorKey);
    if (!declaredNameStyles.has(id)) {
      declaredNameStyles.add(id);
      const color = nameToKmlColor(colorKey);
      ws.write(`<Style id="${id}"><LineStyle><color>ff333333</color><width>1</width></LineStyle><PolyStyle><color>${color}</color></PolyStyle></Style>\n`);
    }
    return id;
  }

  function writeLayerFolder(layerName) {
    const styleId = LAYER_STYLES[layerName]
      ? layerName.replace(/[^a-zA-Z0-9]/g, '_')
      : 'Land_Parcels';
    const features = layerMap[layerName];
    if (!features || features.length === 0) return;

    ws.write(`  <Folder><name>${escXml(layerName)}</name>\n`);
    let count = 0;
    for (const f of features) {
      const p = featureToKml(f, resolveStyleId(f, styleId));
      if (p) {
        ws.write(p + '\n');
        count++;
      }
    }
    ws.write(`  </Folder>\n`);
    onProgress(`  ${layerName}: ${count} placemarks`);
  }

  // To support streaming safely, we'll stream grouped folders sequentially
  const grouped = new Set();
  for (const { folder, layers } of LAYER_GROUPS) {
    let hasContent = false;
    for (const layerName of layers) {
      if (layerMap[layerName] && layerMap[layerName].length > 0) hasContent = true;
    }
    if (!hasContent) continue;
    ws.write(`  <Folder><name>${escXml(folder)}</name>\n`);
    
    for (const layerName of layers) {
      if (!layerMap[layerName] || layerMap[layerName].length === 0) continue;
      grouped.add(layerName);
      
      // Nesting logic
      if (layerName === 'Emerald Network' && layerMap['Emerald Buffer']) {
        ws.write(`  <Folder><name>${escXml('Emerald Network')}</name>\n`);
        writeLayerFolder('Emerald Network');
        writeLayerFolder('Emerald Buffer');
        grouped.add('Emerald Buffer');
        ws.write(`  </Folder>\n`);
        continue;
      }
      if (layerName === 'Emerald Buffer') continue;
      
      if (layerName === 'Water' && layerMap['Water Buffers']) {
        ws.write(`  <Folder><name>${escXml('Water')}</name>\n`);
        writeLayerFolder('Water');
        writeLayerFolder('Water Buffers');
        grouped.add('Water Buffers');
        ws.write(`  </Folder>\n`);
        continue;
      }
      if (layerName === 'Water Buffers') continue;
      
      if (layerName === 'Forests' && layerMap['Forest Buffers']) {
        ws.write(`  <Folder><name>${escXml('Forests')}</name>\n`);
        writeLayerFolder('Forests');
        writeLayerFolder('Forest Buffers');
        grouped.add('Forest Buffers');
        ws.write(`  </Folder>\n`);
        continue;
      }
      if (layerName === 'Forest Buffers') continue;
      
      if (layerName === 'Nature Reserves') {
        const styleId = 'Nature_Reserves';
        ws.write(`  <Folder><name>${escXml('Nature Reserves')}</name>\n`);
        const byCategory = {};
        for (const f of layerMap['Nature Reserves']) {
          const cat = f.properties._subtype || 'Інше';
          if (!byCategory[cat]) byCategory[cat] = [];
          byCategory[cat].push(featureToKml(f, styleId));
        }
        for (const [cat, pms] of Object.entries(byCategory)) {
          ws.write(`    <Folder><name>${escXml(cat)}</name>\n`);
          ws.write(pms.join('\n'));
          ws.write(`    </Folder>\n`);
        }
        if (layerMap['Nature Reserve Buffer']) {
          writeLayerFolder('Nature Reserve Buffer');
          grouped.add('Nature Reserve Buffer');
        }
        ws.write(`  </Folder>\n`);
        continue;
      }
      if (layerName === 'Nature Reserve Buffer') continue;
      
      if (layerName === 'Power Lines') {
        ws.write(`  <Folder><name>${escXml('Power Lines')}</name>\n`);
        const voltageOrder = ['750kV', '400kV', '330kV', '220kV', '110kV', '35kV', 'Other'];
        const bucketed = Object.fromEntries(voltageOrder.map((bucket) => [bucket, []]));
        for (const feature of layerMap['Power Lines']) {
          const bucket = powerLineBucketName(feature?.properties?.voltage);
          if (!bucketed[bucket]) bucketed[bucket] = [];
          bucketed[bucket].push(featureToKml(feature, powerLineStyleId(feature?.properties?.voltage)));
        }
        for (const bucket of voltageOrder) {
          if (bucketed[bucket] && bucketed[bucket].length) {
            ws.write(`    <Folder><name>${escXml(bucket)}</name>\n`);
            ws.write(bucketed[bucket].join('\n'));
            ws.write(`    </Folder>\n`);
          }
        }
        if (layerMap['Power Line Buffers']) {
          writeLayerFolder('Power Line Buffers');
          grouped.add('Power Line Buffers');
        }
        ws.write(`  </Folder>\n`);
        continue;
      }
      if (layerName === 'Power Line Buffers') continue;
      
      if (layerName === 'Towers') {
        ws.write(`  <Folder><name>Towers</name>\n`);
        for (const f of layerMap['Towers']) {
          const p = featureToKml(f, towerStyleId(f.properties && f.properties.voltage));
          if (p) ws.write(p + '\n');
        }
        ws.write(`  </Folder>\n`);
        continue;
      }
      
      writeLayerFolder(layerName);
    }
    ws.write(`  </Folder>\n`);
  }

  // Root-level layers
  const allGrouped = LAYER_GROUPS.flatMap(g => g.layers);
  const rootOrder = [
    ...ROOT_ORDER.filter(k => layerMap[k] && !grouped.has(k)),
    ...Object.keys(layerMap).filter(k => !allGrouped.includes(k) && !grouped.has(k) && !ROOT_ORDER.includes(k) && k !== 'Parcel Boundaries' && k !== 'Wind Speed'),
    ...( layerMap['Parcel Boundaries'] ? ['Parcel Boundaries'] : [] ),
  ];
  const addedRoot = new Set();
  for (const layerName of rootOrder) {
    if (!layerMap[layerName] || addedRoot.has(layerName)) continue;
    addedRoot.add(layerName);
    
    if (layerName === 'Roads' && layerMap['Road Buffers']) {
      ws.write(`  <Folder><name>${escXml('Roads')}</name>\n`);
      writeLayerFolder('Roads');
      writeLayerFolder('Road Buffers');
      addedRoot.add('Road Buffers');
      ws.write(`  </Folder>\n`);
      continue;
    }
    if (layerName === 'Road Buffers' && addedRoot.has('Road Buffers')) continue;
    
    if (layerName === 'Airoports' && layerMap['Airoports Buffer']) {
      ws.write(`  <Folder><name>${escXml('Airoports')}</name>\n`);
      writeLayerFolder('Airoports');
      writeLayerFolder('Airoports Buffer');
      addedRoot.add('Airoports Buffer');
      ws.write(`  </Folder>\n`);
      continue;
    }
    if (layerName === 'Airoports Buffer' && addedRoot.has('Airoports Buffer')) continue;
    
    if (layerName === 'Nuclear Power Plants' && layerMap['Nuclear Power Plants Buffer']) {
      ws.write(`  <Folder><name>${escXml('Nuclear Power Plants')}</name>\n`);
      writeLayerFolder('Nuclear Power Plants');
      writeLayerFolder('Nuclear Power Plants Buffer');
      addedRoot.add('Nuclear Power Plants Buffer');
      ws.write(`  </Folder>\n`);
      continue;
    }
    if (layerName === 'Nuclear Power Plants Buffer' && addedRoot.has('Nuclear Power Plants Buffer')) continue;
    
    if (!LAYER_STYLES[layerName] && !addedRoot.has('Parcel Boundaries')) {
      addedRoot.add('Parcel Boundaries');
      ws.write(`  <Folder><name>Parcels</name>\n  <Folder><name>${escXml(layerName)}</name>\n`);
      if (layerMap['Parcel Boundaries']) writeLayerFolder('Parcel Boundaries');
      ws.write(`    <Folder><name>Parcels</name>\n`);
      writeLayerFolder(layerName);
      ws.write(`    </Folder>\n  </Folder>\n  </Folder>\n`);
      continue;
    }
    if (layerName === 'Parcel Boundaries' && addedRoot.has('Parcel Boundaries')) continue;
    writeLayerFolder(layerName);
  }

  const hasWindPoints = !!(layerMap['Wind Speed'] && layerMap['Wind Speed'].length);
  const hasWindOverlays = groundOverlays.length > 0;
  if (hasWindPoints || hasWindOverlays) {
    const hubHeight = hasWindOverlays ? (groundOverlays[0].hubHeight || '') : '';
    ws.write(`  <Folder><name>Wind Speed${hubHeight ? ` ${hubHeight}m` : ''}</name>\n`);
    
    if (hasWindPoints) {
      ws.write(`    <Folder><name>Average Pins</name>\n`);
      writeLayerFolder('Wind Speed');
      ws.write(`    </Folder>\n`);
    }

    if (hasWindOverlays) {
      for (const ov of groundOverlays) {
        const fname = `files/wind_tile_${ov.tileKey || '0'}.png`;
        ws.write(`    <GroundOverlay><name>Wind Heatmap ${hubHeight}m</name><altitudeMode>clampToSeaFloor</altitudeMode><Icon><href>${fname}</href></Icon><LatLonBox><north>${ov.north}</north><south>${ov.south}</south><east>${ov.east}</east><west>${ov.west}</west></LatLonBox></GroundOverlay>\n`);
      }
    }
    ws.write(`  </Folder>\n`);
  }

  if (customIconNames.length) {
    const [tplLon, tplLat] = findTemplatePoint(layerMap);
    ws.write(`  <Folder><name>Custom Icon Templates</name><visibility>0</visibility>\n`);
    for (const iconName of customIconNames) {
      const id = customIconStyleId(iconName);
      ws.write(`    <Placemark><name>${escXml(`Template: ${iconName}`)}</name><styleUrl>#${id}</styleUrl><Point><coordinates>${tplLon},${tplLat},0</coordinates></Point></Placemark>\n`);
    }
    ws.write(`  </Folder>\n`);
  }

  ws.write(`</Document>\n</kml>`);
  
  await new Promise(resolve => ws.end(resolve));

  onProgress('📦 Zipping into KMZ…');
  const zip = new JSZip();
  zip.file('doc.kml', fs.createReadStream(tmpKmlPath));

  const zippedIcons = new Set();
  for (const icon of bundledIcons) {
    const src = findIconSource(icon);
    if (src && fs.existsSync(src)) {
      zip.file(`files/${icon}`, fs.readFileSync(src));
      zippedIcons.add(icon);
    }
  }

  for (const iconDir of iconDirs) {
    if (!fs.existsSync(iconDir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(iconDir, { withFileTypes: true });
    } catch (_) { continue; }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!/\.png$/i.test(ent.name)) continue;
      if (zippedIcons.has(ent.name)) continue;
      const src = path.join(iconDir, ent.name);
      zip.file(`files/${ent.name}`, fs.readFileSync(src));
      zippedIcons.add(ent.name);
    }
  }
  for (const colors of Object.values(runtimeStyles)) {
    if (colors.icon) {
      const iconName = path.basename(colors.icon);
      if (!bundledIcons.has(iconName)) {
        const src = path.join(appRoot, iconName);
        if (fs.existsSync(src)) zip.file(colors.icon, fs.readFileSync(src));
      }
    }
  }

  for (const ov of groundOverlays) {
    zip.file(`files/wind_tile_${ov.tileKey || '0'}.png`, ov.imageBuffer);
  }

  await new Promise((resolve, reject) => {
    zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' })
      .pipe(fs.createWriteStream(outputPath))
      .on('finish', resolve)
      .on('error', reject);
  });
  onProgress(`💾 Saved KMZ → ${outputPath}`);
  } finally {
    // Always clean up the temp KML, whether we succeeded or blew up partway
    // through (bad geometry, disk full, zip stream error, etc).
    try { ws.destroy(); } catch (_) {}
    try { fs.unlinkSync(tmpKmlPath); } catch (_) {}
  }
}

module.exports = { exportKMZ };
