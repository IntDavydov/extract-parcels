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
  'Towers':             { point: 'ff00ffff' },
  'Substations':        { poly: 'ff00ffff', line: 'ff00ffff' },
  'Roads':              { line: 'ff000000' },
  'Settlements':        { poly: 'ffc9c9ff', line: 'ffc9c9ff' },
  'Settlement Pins':    { point: 'ffc9c9ff', icon: 'files/houses.png' },
  'Settlement Buffers': { poly: 'ccc9c9ff', line: 'ffc9c9ff' },
  'Water':              { poly: 'ccff6600', line: 'ccff6600' },
  'Forests':            { poly: 'cc7fff00', line: '007fff00' },
  'Emerald Network':    { poly: 'cc7fff00', line: '007fff00' },
  'Emerald Buffer':     { poly: '3300ff00', line: '8800ff00', width: 2 },
  'Wind Speed':         { point: 'ff00d7ff' },
};

// Group definitions — layers are nested inside parent folders in the KMZ
const LAYER_GROUPS = [
  { folder: 'Parcels',     layers: ['Parcel Boundaries', 'Land Parcels'] },
  { folder: 'Nature',      layers: ['Forests', 'Emerald Network', 'Emerald Buffer', 'Water'] },
  { folder: 'Settlements', layers: ['Settlements', 'Settlement Pins', 'Settlement Buffers'] },
  { folder: 'Energy',      layers: ['Power Lines', 'Substations', 'Towers'] },
];
// Layers not in any group render at root level in this order
const ROOT_ORDER = ['Wind Speed', 'Territory Boundary', 'Roads'];

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

function buildStyles() {
  const lines = [];
  for (const [layerName, colors] of Object.entries(LAYER_STYLES)) {
    const id = layerName.replace(/[^a-zA-Z0-9]/g, '_');
    const pointColor = colors.point || colors.line || 'ffffffff';
    const lineColor  = colors.line  || 'ffffffff';
    const polyColor  = colors.poly  || '4400ff00';
    const iconStyle  = colors.icon
      ? `<IconStyle><color>${pointColor}</color><scale>1.0</scale><Icon><href>${colors.icon}</href></Icon></IconStyle>`
      : `<IconStyle><color>${pointColor}</color><scale>0.8</scale></IconStyle>`;
    const lineWidth = colors.width || 2;
    lines.push(`<Style id="${id}">
  ${iconStyle}
  <LineStyle><color>${lineColor}</color><width>${lineWidth}</width></LineStyle>
  <PolyStyle><color>${polyColor}</color></PolyStyle>
</Style>`);
  }
  return lines.join('\n');
}

async function exportKMZ(layerMap, outputPath, onProgress, groundOverlays = []) {
  onProgress('🗺 Building KML…');
  const styles = buildStyles();
  const folders = [];

  function layerFolder(layerName) {
    const styleId = layerName.replace(/[^a-zA-Z0-9]/g, '_');
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
    ...Object.keys(layerMap).filter(k => !allGrouped.includes(k) && !grouped.has(k) && !ROOT_ORDER.includes(k)),
  ];
  const addedRoot = new Set();
  for (const layerName of rootOrder) {
    if (!layerMap[layerName] || addedRoot.has(layerName)) continue;
    addedRoot.add(layerName);
    folders.push(layerFolder(layerName));
  }

  // Merge Wind Speed points + GroundOverlays into one folder
  if (groundOverlays.length) {
    const hubHeight = groundOverlays[0].hubHeight || '';
    const overlayKmlItems = groundOverlays.map((ov) => {
      const fname = `files/wind_tile_${ov.tileKey || '0'}.png`;
      return `<GroundOverlay><name>Wind Heatmap ${hubHeight}m</name><altitudeMode>clampToSeaFloor</altitudeMode><Icon><href>${fname}</href></Icon><LatLonBox><north>${ov.north}</north><south>${ov.south}</south><east>${ov.east}</east><west>${ov.west}</west></LatLonBox></GroundOverlay>`;
    });
    // Find existing Wind Speed points folder and wrap together, or create folder with overlays only
    const wsIdx = folders.findIndex(f => f.startsWith('<Folder><name>Wind Speed</name>'));
    if (wsIdx >= 0) {
      // Insert overlays inside the existing Wind Speed folder (before closing tag)
      folders[wsIdx] = folders[wsIdx].replace('</Folder>', overlayKmlItems.join('') + '</Folder>');
    } else {
      folders.push(`<Folder><name>Wind Speed</name>${overlayKmlItems.join('')}</Folder>`);
    }
  }

  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Land Management Data</name>
  ${styles}
  ${folders.join('\n  ')}
</Document>
</kml>`;

  onProgress('📦 Zipping into KMZ…');
  const zip = new JSZip();
  zip.file('doc.kml', kml);

  // Bundle icon files into files/ so they're available for use in Google Earth
  const isPackaged = __dirname.includes('app.asar');
  const appRoot = isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : path.join(__dirname, '..');
  const bundledIcons = ['houses.png', 'windmill.png'];
  for (const icon of bundledIcons) {
    const src = path.join(appRoot, icon);
    if (fs.existsSync(src)) zip.file(`files/${icon}`, fs.readFileSync(src));
  }
  // Also bundle any additional icons referenced in layer styles
  for (const colors of Object.values(LAYER_STYLES)) {
    if (colors.icon) {
      const iconName = path.basename(colors.icon);
      if (!bundledIcons.includes(iconName)) {
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
