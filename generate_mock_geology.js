const fs = require('fs');

const geojson = {
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "name": "Волино-Подільська височина",
        "geologicalConditions": "Поширення крейдяних та карбонатних порід. Несуча здатність ґрунтів середня.",
        "karstRisk": "Високий"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [23.5, 51.8], // North-West Volyn
            [27.5, 51.5], // North-East Rivne
            [26.5, 48.5], // South Khmelnytskyi/Ternopil
            [24.0, 49.0], // West Lviv
            [23.5, 51.8]
          ]
        ]
      }
    },
    {
      "type": "Feature",
      "properties": {
        "name": "Український кристалічний щит",
        "geologicalConditions": "Кристалічний щит, граніти та базальти. Висока несуча здатність ґрунтів.",
        "karstRisk": "Низький"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [28.0, 50.5], // Zhytomyr
            [35.0, 48.0], // Dnipro
            [37.0, 47.0], // Zaporizhzhia
            [30.0, 48.0], // Vinnytsia
            [28.0, 50.5]
          ]
        ]
      }
    }
  ]
};

fs.writeFileSync('test-files/geology-karst.geojson', JSON.stringify(geojson, null, 2));
console.log("Mock geology-karst.geojson created in test-files!");
