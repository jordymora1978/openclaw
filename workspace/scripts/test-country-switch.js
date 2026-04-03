/**
 * Test: descubrir el selector de país en ML Global Selling
 */
const { chromium } = require('/app/node_modules/playwright-core');

const BB_KEY = process.env.BROWSERBASE_API_KEY;
const ML_USER = process.env.ML_USER_49;
const ML_PASS = process.env.ML_PASS_49;

(async () => {
  console.log('=== Test Country Selector ===');

  const b = await chromium.connectOverCDP('wss://connect.browserbase.com?apiKey=' + BB_KEY);
  const ctx = b.contexts()[0];
  const p = ctx.pages()[0] || await ctx.newPage();

  // Login
  console.log('[LOGIN] Starting...');
  await p.goto('https://global-selling.mercadolibre.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(3000);
  await p.fill('input[name=user_id]', ML_USER);
  await p.click('button[type=submit]');
  await p.waitForTimeout(5000);
  await p.locator('button[aria-labelledby*=password]').first().click();
  await p.waitForTimeout(3000);
  await p.fill('input[type=password]', ML_PASS);
  await p.click('button[type=submit]');
  await p.waitForTimeout(5000);
  console.log('[LOGIN] Done');

  // Imprimir URL actual
  console.log('URL: ' + p.url());

  // Buscar selectores posibles
  const selectors = [
    '.nav-header-cbt__site-switcher-trigger',
    '.nav-header-cbt__site-switcher',
    '.nav-header-cbt__site-switcher-value',
    '[data-value="MLB-remote"]',
    '[data-value]',
    'text=Country',
    'text=Brazil',
    'text=Mexico',
    'text=Colombia',
    'text=Argentina',
    'text=Chile',
  ];

  for (const sel of selectors) {
    try {
      const count = await p.locator(sel).count();
      console.log(sel + ' => ' + count + ' found');
    } catch (e) {
      console.log(sel + ' => error');
    }
  }

  // Imprimir primeros 1500 chars del body
  const text = await p.innerText('body');
  console.log('\nPAGE TEXT (first 1500):');
  console.log(text.substring(0, 1500));

  await b.close();
  console.log('\n=== Done ===');
})().catch(e => console.error('FATAL: ' + e.message));
