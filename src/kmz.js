'use strict';

const JSZip = require('jszip');
const fs    = require('fs');

// KML color format: aabbggrr (alpha, blue, green, red)
const LAYER_STYLES = {
  'Power Lines':        { line: 'ff00ffff', poly: '4000ffff' },
  'Towers':             { point: 'ff0088ff' },
  'Substations':        { poly: 'ff0000ff', line: 'ff0000ff' },
  'Roads':              { line: 'ffffffff' },
  'Settlements':        { poly: 'ff00cc00', line: 'ff00cc00' },
  'Settlement Buffers': { poly: '5500cc00', line: 'aa00cc00' },
  'Water':              { poly: 'ffff6600', line: 'ffff6600' },
  'Forests':            { poly: 'ff006600', line: 'ff006600' },
  'Emerald Network':    { poly: 'ffccff00', line: 'ffccff00' },
};

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
    lines.push(`<Style id="${id}">
  <IconStyle><color>${pointColor}</color><scale>0.8</scale></IconStyle>
  <LineStyle><color>${lineColor}</color><width>2</width></LineStyle>
  <PolyStyle><color>${polyColor}</color></PolyStyle>
</Style>`);
  }
  return lines.join('\n');
}

async function exportKMZ(layerMap, outputPath, onProgress) {
  onProgress('🗺 Building KML…');
  const styles = buildStyles();
  const folders = [];

  for (const [layerName, features] of Object.entries(layerMap)) {
    const styleId = layerName.replace(/[^a-zA-Z0-9]/g, '_');
    const placemarks = features.map(f => featureToKml(f, styleId)).filter(Boolean);
    folders.push(`<Folder>
  <name>${escXml(layerName)}</name>
  ${placemarks.join('\n  ')}
</Folder>`);
    onProgress(`  ${layerName}: ${placemarks.length} placemarks`);
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
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(outputPath, buffer);
  onProgress(`💾 Saved KMZ → ${outputPath}`);
}

module.exports = { exportKMZ };
