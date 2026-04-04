/**
 * Busca en ML y extrae los IDs reales de los productos
 * Uso: PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright node /home/node/.openclaw/workspace/scripts/search-ids.js "vitaminas prenatales" CO 2>&1
 */
const { chromium } = require('/app/node_modules/playwright-core');

const BB_KEY = process.env.BROWSERBASE_API_KEY;
const BB_PROJECT = process.env.BROWSERBASE_PROJECT_ID;
const QUERY = process.argv[2] || 'vitaminas prenatales';
const COUNTRY = process.argv[3] || 'CO';

const CFG = {
  CO: { domain: 'mercadolibre.com.co', city: 'BOGOTA', prefix: 'MCO' },
  BR: { domain: 'mercadolibre.com.br', city: 'SAO PAULO', prefix: 'MLB' },
  AR: { domain: 'mercadolibre.com.ar', city: 'BUENOS AIRES', prefix: 'MLA' },
  CL: { domain: 'mercadolibre.cl', city: 'SANTIAGO', prefix: 'MLC' },
  MX: { domain: 'mercadolibre.com.mx', city: 'MEXICO CITY', prefix: 'MLM' },
};

(async () => {
  const c = CFG[COUNTRY];
  console.log(`Buscando "${QUERY}" en ML ${COUNTRY}...`);

  const resp = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'X-BB-API-Key': BB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: BB_PROJECT,
      proxies: [{ type: 'browserbase', geolocation: { country: COUNTRY, city: c.city } }],
    }),
  });
  const session = await resp.json();
  const b = await chromium.connectOverCDP(session.connectUrl);
  const ctx = b.contexts()[0];
  const p = ctx.pages()[0] || await ctx.newPage();

  const url = 'https://listado.' + c.domain + '/' + QUERY.replace(/\s+/g, '-');
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(5000);

  // Extraer todos los links con IDs de productos
  const prefix = c.prefix;
  const allLinks = await p.$$eval('a', els => els.map(e => ({ href: e.href, text: (e.textContent || '').trim().substring(0, 100) })));

  const products = [];
  const seen = new Set();
  for (const link of allLinks) {
    const match = link.href.match(new RegExp(prefix + '\\d+'));
    if (match && !seen.has(match[0])) {
      seen.add(match[0]);
      // Solo links que parecen productos (tienen texto largo = titulo)
      if (link.text.length > 20) {
        products.push({ id: match[0], title: link.text });
      }
    }
  }

  console.log('\nProductos encontrados (' + products.length + '):\n');
  for (const prod of products.slice(0, 10)) {
    console.log(prod.id + ' — ' + prod.title);
  }

  await b.close();
})().catch(e => console.error('ERROR:', e.message));
