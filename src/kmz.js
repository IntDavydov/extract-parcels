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
  const desc = Object.entries(f.properties || {})
    .filter(([k]) => !k.startsWith('_') && k !== 'name')
    .map(([k, v]) => `${escXml(String(k))}: ${escXml(String(v))}`)
    .join('&#10;');

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
  const folders = [];

  function layerFolder(layerName) {
    // For dynamically-named parcel layers (coords-based), fall back to Land Parcels style
    const styleId = LAYER_STYLES[layerName]
      ? layerName.replace(/[^a-zA-Z0-9]/g, '_')
      : 'Land_Parcels';
    const placemarks = layerMap[layerName].map(f => featureToKml(f, styleId)).filter(Boolean);
    onProgress(`  ${layerName}: ${placemarks.length} placemarks`);
    return `<Folder><name>${escXml(layerName)}</name>${placemarks.join('')}</Folder>`;
  }

  // Build grouped folders
  const grouped = new Set();
  for (const { folder, layers } of LAYER_GROUPS) {
    const subFolders = [];
    for (const layerName of layers) {
      if (!layerMap[layerName]) continue;
      grouped.add(layerName);
      // Nest Emerald Buffer inside the Emerald Network folder
      if (layerName === 'Emerald Network' && layerMap['Emerald Buffer']) {
        const emeraldFolder  = layerFolder(layerName);
        const bufferFolder   = layerFolder('Emerald Buffer');
        grouped.add('Emerald Buffer');
        // Wrap both inside a parent "Emerald Network" folder
        subFolders.push(`<Folder><name>${escXml('Emerald Network')}</name>${emeraldFolder}${bufferFolder}</Folder>`);
        continue;
      }
      if (layerName === 'Emerald Buffer') continue; // already nested above
      // Nest Water Buffers inside the Water folder
      if (layerName === 'Water' && layerMap['Water Buffers']) {
        const waterFolder  = layerFolder(layerName);
        const bufferFolder = layerFolder('Water Buffers');
        grouped.add('Water Buffers');
        subFolders.push(`<Folder><name>${escXml('Water')}</name>${waterFolder}${bufferFolder}</Folder>`);
        continue;
      }
      if (layerName === 'Water Buffers') continue; // already nested above
      // Nest Forest Buffers inside the Forests folder
      if (layerName === 'Forests' && layerMap['Forest Buffers']) {
        const forestFolder = layerFolder(layerName);
        const bufferFolder = layerFolder('Forest Buffers');
        grouped.add('Forest Buffers');
        subFolders.push(`<Folder><name>${escXml('Forests')}</name>${forestFolder}${bufferFolder}</Folder>`);
        continue;
      }
      if (layerName === 'Forest Buffers') continue; // already nested above
      // Nature Reserves: group by subcategory (_subtype), nest Nature Reserve Buffer inside
      if (layerName === 'Nature Reserves') {
        const styleId = 'Nature_Reserves';
        const byCategory = {};
        for (const f of layerMap['Nature Reserves']) {
          const cat = f.properties._subtype || 'Інше';
          if (!byCategory[cat]) byCategory[cat] = [];
          byCategory[cat].push(featureToKml(f, styleId));
        }
        const catFolders = Object.entries(byCategory)
          .map(([cat, pms]) => `<Folder><name>${escXml(cat)}</name>${pms.join('')}</Folder>`)
          .join('');
        let natContent = catFolders;
        if (layerMap['Nature Reserve Buffer']) {
          natContent += layerFolder('Nature Reserve Buffer');
          grouped.add('Nature Reserve Buffer');
        }
        subFolders.push(`<Folder><name>${escXml('Nature Reserves')}</name>${natContent}</Folder>`);
        continue;
      }
      if (layerName === 'Nature Reserve Buffer') continue; // already nested above
      // Nest Power Line Buffers inside the Power Lines folder
      if (layerName === 'Power Lines' && layerMap['Power Line Buffers']) {
        const powerLinesFolder = layerFolder(layerName);
        const bufferFolder     = layerFolder('Power Line Buffers');
        grouped.add('Power Line Buffers');
        subFolders.push(`<Folder><name>${escXml('Power Lines')}</name>${powerLinesFolder}${bufferFolder}</Folder>`);
        continue;
      }
      if (layerName === 'Power Line Buffers') continue; // already nested above
      // Towers: color-coded by voltage tier
      if (layerName === 'Towers') {
        const towerPms = layerMap['Towers'].map(f =>
          featureToKml(f, towerStyleId(f.properties && f.properties.voltage))
        ).filter(Boolean);
        subFolders.push(`<Folder><name>Towers</name>${towerPms.join('')}</Folder>`);
        continue;
      }
      // Default: add layer as a plain folder
      subFolders.push(layerFolder(layerName));
    }
    if (subFolders.length) {
      folders.push(`<Folder><name>${escXml(folder)}</name>${subFolders.join('')}</Folder>`);
    }
  }

  // Root-level layers (not in any group)
  const allGrouped = LAYER_GROUPS.flatMap(g => g.layers);
  const rootOrder = [
    ...ROOT_ORDER.filter(k => layerMap[k] && !grouped.has(k)),
    // Coords-named parcel layers before 'Parcel Boundaries' so nesting logic fires correctly
    ...Object.keys(layerMap).filter(k => !allGrouped.includes(k) && !grouped.has(k) && !ROOT_ORDER.includes(k) && k !== 'Parcel Boundaries' && k !== 'Wind Speed'),
    // 'Parcel Boundaries' last — will be nested inside the coords folder above
    ...( layerMap['Parcel Boundaries'] ? ['Parcel Boundaries'] : [] ),
  ];
  const addedRoot = new Set();
  for (const layerName of rootOrder) {
    if (!layerMap[layerName] || addedRoot.has(layerName)) continue;
    addedRoot.add(layerName);
    // Roads: nest Road Buffers inside Roads folder
    if (layerName === 'Roads' && layerMap['Road Buffers']) {
      const roadsFolder  = layerFolder('Roads');
      const bufferFolder = layerFolder('Road Buffers');
      addedRoot.add('Road Buffers');
      folders.push(`<Folder><name>${escXml('Roads')}</name>${roadsFolder}${bufferFolder}</Folder>`);
      continue;
    }
    if (layerName === 'Road Buffers' && addedRoot.has('Road Buffers')) continue; // already nested above
    // Airoports: nest 45km buffer inside the Airoports folder
    if (layerName === 'Airoports' && layerMap['Airoports Buffer']) {
      const airportsFolder = layerFolder('Airoports');
      const bufferFolder = layerFolder('Airoports Buffer');
      addedRoot.add('Airoports Buffer');
      folders.push(`<Folder><name>${escXml('Airoports')}</name>${airportsFolder}${bufferFolder}</Folder>`);
      continue;
    }
    if (layerName === 'Airoports Buffer' && addedRoot.has('Airoports Buffer')) continue;
    // Nuclear Power Plants: nest 30km buffer inside the Nuclear Power Plants folder
    if (layerName === 'Nuclear Power Plants' && layerMap['Nuclear Power Plants Buffer']) {
      const nppFolder = layerFolder('Nuclear Power Plants');
      const bufferFolder = layerFolder('Nuclear Power Plants Buffer');
      addedRoot.add('Nuclear Power Plants Buffer');
      folders.push(`<Folder><name>${escXml('Nuclear Power Plants')}</name>${nppFolder}${bufferFolder}</Folder>`);
      continue;
    }
    if (layerName === 'Nuclear Power Plants Buffer' && addedRoot.has('Nuclear Power Plants Buffer')) continue;
    // Coords-named parcel layer: wrap in Parcels > coords/folder > Boundary + Parcels subfolder
    if (!LAYER_STYLES[layerName] && !addedRoot.has('Parcel Boundaries')) {
      addedRoot.add('Parcel Boundaries');
      const styleId    = 'Land_Parcels';
      const placemarks = layerMap[layerName].map(f => featureToKml(f, styleId)).filter(Boolean);
      const boundaryFolder = layerMap['Parcel Boundaries'] ? layerFolder('Parcel Boundaries') : '';
      const parcelsSubFolder = `<Folder><name>Parcels</name>${placemarks.join('')}</Folder>`;
      const coordsFolder = `<Folder><name>${escXml(layerName)}</name>${boundaryFolder}${parcelsSubFolder}</Folder>`;
      folders.push(`<Folder><name>Parcels</name>${coordsFolder}</Folder>`);
      continue;
    }
    if (layerName === 'Parcel Boundaries' && addedRoot.has('Parcel Boundaries')) continue; // already nested above
    folders.push(layerFolder(layerName));
  }

  // Build Wind Speed folder: "Average Pins" sub-folder + heatmap overlay
  const hasWindPoints   = !!(layerMap['Wind Speed'] && layerMap['Wind Speed'].length);
  const hasWindOverlays = groundOverlays.length > 0;
  if (hasWindPoints || hasWindOverlays) {
    const hubHeight = hasWindOverlays ? (groundOverlays[0].hubHeight || '') : '';
    const parts = [];

    if (hasWindPoints) {
      const styleId = 'Wind_Speed';
      const pms = layerMap['Wind Speed'].map(f => featureToKml(f, styleId)).filter(Boolean);
      parts.push(`<Folder><name>Average Pins</name>${pms.join('')}</Folder>`);
    }

    if (hasWindOverlays) {
      const overlayItems = groundOverlays.map((ov) => {
        const fname = `files/wind_tile_${ov.tileKey || '0'}.png`;
        return `<GroundOverlay><name>Wind Heatmap ${hubHeight}m</name><altitudeMode>clampToSeaFloor</altitudeMode><Icon><href>${fname}</href></Icon><LatLonBox><north>${ov.north}</north><south>${ov.south}</south><east>${ov.east}</east><west>${ov.west}</west></LatLonBox></GroundOverlay>`;
      });
      parts.push(...overlayItems);
    }

    folders.push(`<Folder><name>Wind Speed${hubHeight ? ` ${hubHeight}m` : ''}</name>${parts.join('')}</Folder>`);
  }

  if (customIconNames.length) {
    const [tplLon, tplLat] = findTemplatePoint(layerMap);
    const templatePlacemarks = customIconNames.map((iconName) => {
      const id = customIconStyleId(iconName);
      return `<Placemark><name>${escXml(`Template: ${iconName}`)}</name><styleUrl>#${id}</styleUrl><Point><coordinates>${tplLon},${tplLat},0</coordinates></Point></Placemark>`;
    }).join('');
    folders.push(`<Folder><name>Custom Icon Templates</name><visibility>0</visibility>${templatePlacemarks}</Folder>`);
  }

  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${escXml(docName)}</name>
  ${styles}
  ${folders.join('\n  ')}
</Document>
</kml>`;

  onProgress('📦 Zipping into KMZ…');
  const zip = new JSZip();
  zip.file('doc.kml', kml);

  // Bundle icon files into files/ so they're available for use in Google Earth
  const zippedIcons = new Set();
  for (const icon of bundledIcons) {
    const src = findIconSource(icon);
    if (src && fs.existsSync(src)) {
      zip.file(`files/${icon}`, fs.readFileSync(src));
      zippedIcons.add(icon);
    }
  }

  // Auto-bundle user custom icons from icons/*.png into files/
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
      if (zippedIcons.has(ent.name)) continue;
      const src = path.join(iconDir, ent.name);
      zip.file(`files/${ent.name}`, fs.readFileSync(src));
      zippedIcons.add(ent.name);
    }
  }
  // Also bundle any additional icons referenced in layer styles
  for (const colors of Object.values(runtimeStyles)) {
    if (colors.icon) {
      const iconName = path.basename(colors.icon);
      if (!bundledIcons.has(iconName)) {
        const src = path.join(appRoot, iconName);
        if (fs.existsSync(src)) zip.file(colors.icon, fs.readFileSync(src));
      }
    }
  }

  // Bundle ground overlay images
  for (const ov of groundOverlays) {
    zip.file(`files/wind_tile_${ov.tileKey || '0'}.png`, ov.imageBuffer);
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(outputPath, buffer);
  onProgress(`💾 Saved KMZ → ${outputPath}`);
}

module.exports = { exportKMZ };
