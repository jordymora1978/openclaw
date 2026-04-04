/**
 * Busca productos en ML público después de loguearse
 * Uso: node /home/node/.openclaw/workspace/scripts/search-ml.js "vitaminas prenatales" MCO 2>&1
 */
const { chromium } = require('/app/node_modules/playwright-core');

const BB_KEY = process.env.BROWSERBASE_API_KEY;
const ML_USER = process.env.ML_USER_49;
const ML_PASS = process.env.ML_PASS_49;
const QUERY = process.argv[2] || 'vitaminas prenatales';
const SITE = process.argv[3] || 'MCO';

const SITE_URLS = {
  MCO: 'mercadolibre.com.co',
  MLB: 'mercadolibre.com.br',
  MLA: 'mercadolibre.com.ar',
  MLC: 'mercadolibre.cl',
  MLM: 'mercadolibre.com.mx',
};

(async () => {
  console.log(`=== Buscar en ML: "${QUERY}" (${SITE}) ===`);

  const b = await chromium.connectOverCDP('wss://connect.browserbase.com?apiKey=' + BB_KEY);
  const ctx = b.contexts()[0];
  const p = ctx.pages()[0] || await ctx.newPage();

  // Login
  console.log('[LOGIN]...');
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
  console.log('[LOGIN] OK');

  // Buscar
  const domain = SITE_URLS[SITE] || SITE_URLS.MCO;
  const searchQuery = QUERY.replace(/\s+/g, '-');
  const url = `https://listado.${domain}/${searchQuery}`;
  console.log(`[SEARCH] ${url}`);

  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(5000);

  const text = await p.innerText('body');
  console.log('\n=== RESULTADOS ===');
  console.log(text.substring(0, 4000));

  await b.close();
  console.log('\n=== FIN ===');
})().catch(e => console.error('ERROR:', e.message));
