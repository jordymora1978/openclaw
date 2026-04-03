/**
 * Test: cambio de país desde la página de Help
 * El dropdown de países del header SOLO aparece en /help/v2
 */
const { chromium } = require('/app/node_modules/playwright-core');

const BB_KEY = process.env.BROWSERBASE_API_KEY;
const ML_USER = process.env.ML_USER_49;
const ML_PASS = process.env.ML_PASS_49;

const COUNTRIES = ['Mexico', 'Brazil', 'Argentina', 'Chile', 'Colombia'];

(async () => {
  console.log('=== Test Country Switch from Help Page ===');

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

  // Ir a Help donde está el dropdown
  console.log('[NAV] Going to /help/v2...');
  await p.goto('https://global-selling.mercadolibre.com/help/v2', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await p.waitForTimeout(3000);

  // Buscar selectores disponibles
  const selectors = [
    '.nav-header-cbt__site-switcher-trigger',
    '.nav-header-cbt__site-switcher',
    '.nav-header-cbt__site-switcher-value',
    '[data-value="MLB-remote"]',
  ];
  for (const sel of selectors) {
    const count = await p.locator(sel).count();
    console.log('Selector ' + sel + ' => ' + count);
  }

  // Probar cambio de país
  for (const country of COUNTRIES) {
    console.log('\n[SWITCH] ' + country + '...');
    try {
      // Ir a Help primero
      await p.goto('https://global-selling.mercadolibre.com/help/v2', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await p.waitForTimeout(2000);

      // Click en trigger
      await p.locator('.nav-header-cbt__site-switcher-trigger').first().click({ timeout: 5000 });
      await p.waitForTimeout(1000);

      // Click en el nombre del país
      await p.getByText(country, { exact: true }).click({ timeout: 5000 });
      await p.waitForTimeout(4000);

      // Verificar
      const val = await p.locator('.nav-header-cbt__site-switcher-value').first().innerText().catch(() => '?');
      const text = await p.innerText('body');
      const hasInquiries = text.includes('inquiries') || text.includes('queries');
      console.log('  Header: ' + val + ' | Has inquiries: ' + hasInquiries);
    } catch (e) {
      console.error('  ERROR: ' + e.message.split('\n')[0]);
    }
  }

  await b.close();
  console.log('\n=== Done ===');
})().catch(e => console.error('FATAL: ' + e.message));
