const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  console.log('Monitoring network requests for: https://decentralization.ua/areas/0432');

  await page.setRequestInterception(true);
  
  page.on('request', request => {
    const url = request.url();
    const resourceType = request.resourceType();
    
    // Log XHR and Fetch requests specifically
    if (resourceType === 'xhr' || resourceType === 'fetch') {
      console.log(`[${resourceType.toUpperCase()}] ${url}`);
    }
    request.continue();
  });

  try {
    await page.goto('https://decentralization.ua/areas/0432', { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('\nPage loaded. Checking for data-heavy responses...');
  } catch (e) {
    console.error('Error loading page:', e.message);
  }

  await browser.close();
})();
