const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const toGeoJSON = require('@mapbox/togeojson');

const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Style id="redStyle"><LineStyle><color>ff0000ff</color></LineStyle></Style>
    <Folder>
      <name>Layer A</name>
      <Placemark>
        <name>Feature 1</name>
        <styleUrl>#redStyle</styleUrl>
        <Point><coordinates>0,0</coordinates></Point>
      </Placemark>
    </Folder>
    <Folder>
      <name>Layer B</name>
      <Placemark>
        <name>Feature 2</name>
        <Point><coordinates>1,1</coordinates></Point>
      </Placemark>
    </Folder>
  </Document>
</kml>`;

const dom = new DOMParser().parseFromString(kml, 'text/xml');
const documentNode = dom.getElementsByTagName('Document')[0];
const folders = Array.from(dom.getElementsByTagName('Folder'));

// Remove all folders from the document
folders.forEach(f => f.parentNode.removeChild(f));

const layers = [];
folders.forEach(folder => {
  const nameNode = folder.getElementsByTagName('name')[0];
  const folderName = nameNode ? nameNode.textContent : 'Unnamed';
  
  // Create a clean DOM with just this folder
  const tempDom = new DOMParser().parseFromString(new XMLSerializer().serializeToString(dom), 'text/xml');
  const tempDoc = tempDom.getElementsByTagName('Document')[0];
  tempDoc.appendChild(tempDom.importNode(folder, true));
  
  const geojson = toGeoJSON.kml(tempDom);
  layers.push({ name: folderName, geojson });
});

console.log(JSON.stringify(layers, null, 2));
