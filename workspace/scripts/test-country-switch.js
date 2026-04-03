/**
 * Test: cambio de país en ML Global Selling
 * Solo prueba el login + cambio entre los 5 países
 */
const { chromium } = require('/app/node_modules/playwright-core');

const BB_KEY = process.env.BROWSERBASE_API_KEY;
const ML_USER = process.env.ML_USER_49;
const ML_PASS = process.env.ML_PASS_49;

const COUNTRIES = [
  { name: 'Brazil', value: 'MLB-remote' },
  { name: 'Argentina', value: 'MLA-remote' },
  { name: 'Chile', value: 'MLC-remote' },
  { name: 'Colombia', value: 'MCO-remote' },
];

(async () => {
  console.log('=== Test Country Switch ===');

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

  // Leer país actual
  let text = await p.innerText('body');
  let cm = text.match(/Country:\s*(\w+)/);
  console.log('Current country: ' + (cm ? cm[1] : 'unknown'));

  // Probar cada país
  for (const country of COUNTRIES) {
    console.log('\n[SWITCH] ' + country.name + '...');
    try {
      // Primero: ir a Summary para tener el selector visible
      await p.goto('https://global-selling.mercadolibre.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await p.waitForTimeout(2000);

      // Click en el trigger del switcher
      const trigger = p.locator('.nav-header-cbt__site-switcher-trigger').first();
      console.log('  Trigger found: ' + await trigger.count());
      await trigger.click({ timeout: 5000 });
      await p.waitForTimeout(1000);

      // Click en la opción del país
      const option = p.locator('[data-value="' + country.value + '"]').first();
      console.log('  Option found: ' + await option.count());
      await option.click({ timeout: 5000 });
      await p.waitForTimeout(4000);

      // Verificar
      text = await p.innerText('body');
      cm = text.match(/Country:\s*(\w+)/);
      console.log('  Result: ' + (cm ? cm[1] : 'unknown'));
    } catch (e) {
      console.error('  ERROR: ' + e.message.split('\n')[0]);
    }
  }

  await b.close();
  console.log('\n=== Done ===');
})().catch(e => console.error('FATAL: ' + e.message));
