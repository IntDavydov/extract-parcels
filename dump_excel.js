const ExcelJS = require('exceljs');

async function readExcel() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile('test-files/pre-research.xlsx');
  
  console.log('Sheets:', workbook.worksheets.map(s => s.name));
  
  const sheet = workbook.getWorksheet(1) || workbook.worksheets[0];
  if (!sheet) {
    console.log('No sheet found');
    return;
  }
  const data = [];
  
  sheet.eachRow((row, rowNumber) => {
    data.push(row.values);
  });
  
  console.log(JSON.stringify(data.slice(0, 10), null, 2));
}

readExcel().catch(console.error);
