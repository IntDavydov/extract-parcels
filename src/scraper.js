const puppeteer = require('puppeteer');
const ExcelJS = require('exceljs');

async function scrapeRegion(regionId) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const url = `https://decentralization.ua/areas/${regionId}`;
  
  console.log(`Scraping region: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2' });

  // Extract data from the table
  const communities = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    return rows.map(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 3) return null;
      
      const linkElement = cells[1].querySelector('a');
      return {
        name: linkElement ? linkElement.innerText.trim() : cells[1].innerText.trim(),
        url: linkElement ? linkElement.href : '',
        type: cells[2].innerText.trim(),
        district: cells[3].innerText.trim()
      };
    }).filter(item => item !== null);
  });

  console.log(`Found ${communities.length} communities.`);
  await browser.close();
  return communities;
}

async function saveToExcel(communities, regionId) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Communities');
  
  sheet.columns = [
    { header: 'No.', key: 'id' },
    { header: 'Community Name', key: 'name' },
    { header: 'Type', key: 'type' },
    { header: 'District', key: 'district' },
    { header: 'Link', key: 'url' }
  ];

  communities.forEach((c, index) => {
    sheet.addRow({
      id: index + 1,
      name: c.name,
      type: c.type,
      district: c.district,
      url: c.url
    });
  });

  const fileName = `test-files/communities_${regionId}.xlsx`;
  await workbook.xlsx.writeFile(fileName);
  console.log(`Saved to ${fileName}`);
}

// Example usage for Vinnytsia (0432)
scrapeRegion('0432').then(data => saveToExcel(data, '0432')).catch(console.error);
