const fs = require('fs');
const JSZip = require('jszip');
const toGeoJSON = require('@mapbox/togeojson');
const { DOMParser } = require('@xmldom/xmldom');

async function testParse() {
  // Let's create a dummy KML first
  const dummyKml = `<?xml version="1.0" encoding="UTF-8"?>
  <kml xmlns="http://www.opengis.net/kml/2.2">
    <Document>
      <Placemark>
        <name>Test</name>
        <Polygon>
          <outerBoundaryIs>
            <LinearRing>
              <coordinates>
                0,0 0,1 1,1 1,0 0,0
              </coordinates>
            </LinearRing>
          </outerBoundaryIs>
        </Polygon>
      </Placemark>
    </Document>
  </kml>`;
  
  const zip = new JSZip();
  zip.file('doc.kml', dummyKml);
  const kmzBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  fs.writeFileSync('test.kmz', kmzBuffer);

  // Now simulate main.js logic
  const kmzData = fs.readFileSync('test.kmz');
  const unzipped = await JSZip.loadAsync(kmzData);
  const kmlFile = unzipped.file('doc.kml') || unzipped.file('doc.kml'.toLowerCase());
  
  if (!kmlFile) throw new Error('No doc.kml found in KMZ');
  
  const kmlText = await kmlFile.async('string');
  const dom = new DOMParser().parseFromString(kmlText, 'text/xml');
  const geojson = toGeoJSON.kml(dom);
  
  console.log('Parsed GeoJSON:', JSON.stringify(geojson, null, 2));
}

testParse().catch(console.error);
