'use strict';

const JSZip = require('jszip');
const fs    = require('fs');
const path  = require('path');

// KML color format: aabbggrr (alpha, blue, green, red)
const LAYER_STYLES = {
  'Boundary Filter':    { poly: '00000000', line: 'ff0064ff', width: 3 },
  'Territory Boundary': { poly: '00000000', line: 'ff6435ff', width: 4 },
  'Land Parcels':       { poly: '4000aaff', line: 'ff00aaff' },
  'Power Lines':        { line: 'ff00ffff', poly: '4000ffff' },
  'Towers':             { point: 'ff0088ff' },
  'Substations':        { poly: 'ff00ffff', line: 'ff00ffff' },
  'Roads':              { line: 'ff000000' },
  'Settlements':        { poly: 'ffc9c9ff', line: 'ffc9c9ff' },
  'Settlement Pins':    { point: 'ffc9c9ff', icon: 'files/houses.png' },
  'Settlement Buffers': { poly: '80c9c9ff', line: 'ffc9c9ff' },
  'Water':              { poly: '80ff6600', line: '80ff6600' },
  'Forests':            { poly: '807fff00', line: '807fff00' },
  'Emerald Network':    { poly: '807fff00', line: '807fff00' },
  'Wind Speed':         { point: 'ff00d7ff' },
};

// Layers rendered first appear underneath — forests/emerald below settlements
const LAYER_ORDER = [
  'Boundary Filter',
  'Territory Boundary',
  'Wind Speed',
  'Forests',
  'Emerald Network',
  'Water',
  'Roads',
  'Power Lines',
  'Substations',
  'Towers',
  'Settlements',
  'Settlement Buffers',
  'Settlement Pins',
];

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
    .map(([k, v]) => `${k}: ${v}`)
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
  <description>${escXml(desc)}</description>
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

  // Render in defined order so forests/emerald appear below settlements
  const orderedKeys = [
    ...LAYER_ORDER.filter(k => layerMap[k]),
    ...Object.keys(layerMap).filter(k => !LAYER_ORDER.includes(k)),
  ];

  for (const layerName of orderedKeys) {
    const features = layerMap[layerName];
    const styleId = layerName.replace(/[^a-zA-Z0-9]/g, '_');
    const placemarks = features.map(f => featureToKml(f, styleId)).filter(Boolean);
    folders.push(`<Folder>
  <name>${escXml(layerName)}</name>
  ${placemarks.join('\n  ')}
</Folder>`);
    onProgress(`  ${layerName}: ${placemarks.length} placemarks`);
  }

  // Build GroundOverlay elements (wind heatmap etc.)
  const overlayKml = groundOverlays.map((ov) => {
    const fname = `files/wind_tile_${ov.tileKey || '0'}.png`;
    return `<GroundOverlay>
  <name>Wind Speed ${ov.hubHeight}m</name>
  <Icon><href>${fname}</href></Icon>
  <LatLonBox>
    <north>${ov.north}</north><south>${ov.south}</south>
    <east>${ov.east}</east><west>${ov.west}</west>
  </LatLonBox>
</GroundOverlay>`;
  }).join('\n');

  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Land Management Data</name>
  ${styles}
  ${overlayKml}
  ${folders.join('\n  ')}
</Document>
</kml>`;

  onProgress('📦 Zipping into KMZ…');
  const zip = new JSZip();
  zip.file('doc.kml', kml);

  // Bundle any icon files referenced in styles
  for (const colors of Object.values(LAYER_STYLES)) {
    if (colors.icon) {
      // In packaged app __dirname contains 'app.asar'; in dev it's the real src/ folder
      const isPackaged = __dirname.includes('app.asar');
      const appRoot = isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked')
        : path.join(__dirname, '..');
      const iconSrc = path.join(appRoot, path.basename(colors.icon));
      if (fs.existsSync(iconSrc)) {
        zip.file(colors.icon, fs.readFileSync(iconSrc));
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
