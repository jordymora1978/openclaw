/**
 * Busca productos en ML público usando proxy del país correspondiente
 * NO necesita login — usa proxy de Browserbase para parecer un usuario local
 *
 * Uso: PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright node /home/node/.openclaw/workspace/scripts/search-ml.js "vitaminas prenatales" CO 2>&1
 */
const { chromium } = require('/app/node_modules/playwright-core');

const BB_KEY = process.env.BROWSERBASE_API_KEY;
const BB_PROJECT = process.env.BROWSERBASE_PROJECT_ID;
const QUERY = process.argv[2] || 'vitaminas prenatales';
const COUNTRY = process.argv[3] || 'CO';

const COUNTRY_CONFIG = {
  CO: { domain: 'mercadolibre.com.co', city: 'BOGOTA', name: 'Colombia' },
  BR: { domain: 'mercadolibre.com.br', city: 'SAO PAULO', name: 'Brasil' },
  AR: { domain: 'mercadolibre.com.ar', city: 'BUENOS AIRES', name: 'Argentina' },
  CL: { domain: 'mercadolibre.cl', city: 'SANTIAGO', name: 'Chile' },
  MX: { domain: 'mercadolibre.com.mx', city: 'MEXICO CITY', name: 'Mexico' },
};

(async () => {
  const config = COUNTRY_CONFIG[COUNTRY];
  if (!config) { console.error('Pais no valido:', COUNTRY); process.exit(1); }

  console.log(`=== Buscar en ML ${config.name}: "${QUERY}" ===`);

  // Crear sesion con proxy del pais
  const sessionResp = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'X-BB-API-Key': BB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: BB_PROJECT,
      proxies: [{
        type: 'browserbase',
        geolocation: { country: COUNTRY, city: config.city },
      }],
    }),
  });
  const session = await sessionResp.json();
  if (!session.connectUrl) {
    console.error('Error creando sesion:', JSON.stringify(session));
    process.exit(1);
  }
  console.log('[SESSION] Proxy:', config.city, COUNTRY);

  const b = await chromium.connectOverCDP(session.connectUrl);
  const ctx = b.contexts()[0];
  const p = ctx.pages()[0] || await ctx.newPage();

  // Buscar directamente — no necesita login con proxy local
  const searchQuery = QUERY.replace(/\s+/g, '-');
  const url = `https://listado.${config.domain}/${searchQuery}`;
  console.log('[URL]', url);

  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(5000);

  const text = await p.innerText('body');

  // Verificar si pide login
  if (text.includes('ingresa a') && text.includes('tu cuenta')) {
    console.log('[ERROR] ML sigue pidiendo login incluso con proxy local');
    console.log(text.substring(0, 500));
  } else {
    console.log('\n=== RESULTADOS ===');
    console.log(text.substring(0, 4000));
  }

  await b.close();
  console.log('\n=== FIN ===');
})().catch(e => console.error('ERROR:', e.message));
