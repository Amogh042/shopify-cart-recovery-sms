const { chromium } = require('playwright');

async function main() {
  const shop = process.env.DASHBOARD_SHOP || 'demo.myshopify.com';
  const url = process.env.DASHBOARD_URL || `http://localhost:3000/dashboard?shop=${encodeURIComponent(shop)}`;
  const outPath = process.env.DASHBOARD_SCREENSHOT || 'dashboard-screenshot.png';

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await page.waitForSelector('text=CartRecovery SMS', { timeout: 10_000 });
  await page.waitForSelector('table', { timeout: 10_000 });

  await page.screenshot({ path: outPath, fullPage: true });
  await browser.close();

  // eslint-disable-next-line no-console
  console.log(`Saved screenshot to ${outPath}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

