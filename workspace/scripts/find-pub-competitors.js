/**
 * Find competitors for individual publications.
 * Searches ML with Browserbase, verifies USA origin, saves to publication_history.
 *
 * No LLM. No tokens. Only Browserbase.
 *
 * Usage: node find-pub-competitors.js [store_id]
 * Default: processes all stores with configured context
 */
const { chromium } = require('/app/node_modules/playwright-core');

const BB_KEY = process.env.BROWSERBASE_API_KEY;
const BB_PROJECT = process.env.BROWSERBASE_PROJECT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const CATALOG_URL = process.env.SUPABASE_CATALOG_URL;
const CATALOG_KEY = process.env.SUPABASE_CATALOG_ANON_KEY;

const SEARCH_URLS = {
  BR: 'https://lista.mercadolivre.com.br/',
  CO: 'https://listado.mercadolibre.com.co/',
  AR: 'https://listado.mercadolibre.com.ar/',
  MX: 'https://listado.mercadolibre.com.mx/',
  CL: 'https://listado.mercadolibre.cl/',
};

function log(level, action, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, action, ...data }));
}

async function getPublicationsWithoutCompetitors(storeId) {
  // Get prohibited publications
  const pubResp = await fetch(
    `${CATALOG_URL}/rest/v1/ml_publications?select=ml_item_id,title,destination_country,status` +
    `&store_id=eq.${storeId}` +
    `&or=(infraction_reason.eq.The%20product%20is%20prohibited.,infraction_reason.like.*forbidden%20product*,infraction_reason.eq.It%20did%20not%20comply%20with%20our%20policies.)` +
    `&status=in.(under_review,inactive)` +
    `&order=destination_country.asc`,
    { headers: { 'apikey': CATALOG_KEY, 'Authorization': `Bearer ${CATALOG_KEY}` } }
  );
  const pubs = await pubResp.json();

  // Get publications that already have competitors in publication_history
  const histResp = await fetch(
    `${SUPABASE_URL}/rest/v1/publication_history?select=ml_item_id&event_type=eq.competidores_usa&store_id=eq.${storeId}`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  const existing = new Set((await histResp.json()).map(h => h.ml_item_id));

  return pubs.filter(p => !existing.has(p.ml_item_id));
}

async function searchAndVerify(page, country, searchTerm) {
  const baseUrl = SEARCH_URLS[country];
  if (!baseUrl) return [];

  const encoded = encodeURIComponent(searchTerm).replace(/%20/g, '+');
  const url = baseUrl + encoded + '#D[A:' + encoded + ',L:INTERNATIONAL]';

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(4000);

  // Collect all product links
  const items = await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    document.querySelectorAll('a').forEach(a => {
      if ((a.href.includes('/p/') || a.href.includes('_JM')) && a.href.includes('mercadoli')) {
        const text = a.textContent.trim();
        const href = a.href.split('?')[0].split('#')[0];
        if (text.length > 15 && !seen.has(href)) {
          seen.add(href);
          const match = href.match(/(MLB|MCO|MLA|MLC|MLM)\d+/);
          results.push({ title: text.substring(0, 80), url: href, id: match ? match[0] : '' });
        }
      }
    });
    return results.slice(0, 8);
  });

  // Verify each — only keep USA sellers
  const verified = [];
  for (const item of items) {
    if (!item.url || verified.length >= 3) break;
    try {
      await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);
      const pageText = await page.innerText('body');

      const isUSA = pageText.includes('Envío desde USA') ||
        pageText.includes('Envío desde Estados Unidos') ||
        pageText.includes('Envío desde EE.UU') ||
        pageText.includes('Envio de EUA') ||
        pageText.includes('Envio desde USA') ||
        pageText.includes('Shipped from USA') ||
        pageText.includes('Ships from USA') ||
        pageText.includes('Envío desde USA');
      const isOurs = pageText.includes('USAGLOBAL') || pageText.includes('USAMIAMI') ||
        pageText.includes('GLOBAL SELLER') || pageText.includes('Global Seller') ||
        pageText.includes('Global technology');

      if (isUSA && !isOurs) {
        verified.push(item);
      }
    } catch {}
  }
  return verified;
}

(async () => {
  const storeFilter = process.argv[2] ? parseInt(process.argv[2]) : null;
  // No need for BB_CONTEXT — competitor search uses anonymous sessions with country proxy
  const stores = [
    { id: 49 },
    { id: 51 },
  ].filter(s => !storeFilter || s.id === storeFilter);

  log('info', 'start', { stores: stores.map(s => s.id) });

  for (const store of stores) {
    const pubs = await getPublicationsWithoutCompetitors(store.id);
    log('info', 'store_pubs', { store: store.id, total: pubs.length });

    if (pubs.length === 0) continue;

    // Group by country
    const byCountry = {};
    for (const p of pubs) {
      if (!byCountry[p.destination_country]) byCountry[p.destination_country] = [];
      byCountry[p.destination_country].push(p);
    }

    for (const [country, countryPubs] of Object.entries(byCountry)) {
      log('info', 'country_start', { store: store.id, country, count: countryPubs.length });

      // Create session with country proxy
      let sess, browser, page;
      try {
        const sessResp = await fetch('https://api.browserbase.com/v1/sessions', {
          method: 'POST',
          headers: { 'x-bb-api-key': BB_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: BB_PROJECT, region: 'us-east-1',
            timeout: 7200, keepAlive: true,
            proxies: [{ type: 'browserbase', geolocation: { country } }],
          }),
        });
        sess = await sessResp.json();
        if (!sess.connectUrl) { log('error', 'session_failed', { country }); continue; }

        browser = await chromium.connectOverCDP(sess.connectUrl);
        const ctx = browser.contexts()[0];
        page = ctx.pages()[0] || await ctx.newPage();
      } catch (e) {
        log('error', 'connect_failed', { country, error: e.message.split('\n')[0] });
        continue;
      }

      let found = 0;
      let notFound = 0;

      for (const pub of countryPubs) {
        const searchTerm = pub.title
          .replace(/^Suplemento\s+/i, '')
          .replace(/^Supplement\s+/i, '')
          .replace(/\d+\s*(mg|mcg|oz|ml|count|ct|unidades|capsul|tablet|softgel|comprimid|cápsula|gummies).*/i, '')
          .replace(/,\s*\d+.*/i, '')
          .trim()
          .substring(0, 50);

        if (!searchTerm) continue;

        try {
          log('info', 'searching', { pub: pub.ml_item_id, term: searchTerm, country });
          let competitors;
          try {
            competitors = await searchAndVerify(page, country, searchTerm);
          } catch (sessErr) {
            if (sessErr.message.includes('browser has been closed') || sessErr.message.includes('Target page')) {
              log('warn', 'session_reconnecting', { pub: pub.ml_item_id, country });
              try { await browser.close(); } catch {}
              const newSess = await fetch('https://api.browserbase.com/v1/sessions', {
                method: 'POST',
                headers: { 'x-bb-api-key': BB_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  projectId: BB_PROJECT, region: 'us-east-1',
                  timeout: 7200, keepAlive: true,
                  proxies: [{ type: 'browserbase', geolocation: { country } }],
                }),
              }).then(r => r.json());
              browser = await chromium.connectOverCDP(newSess.connectUrl);
              const newCtx = browser.contexts()[0];
              page = newCtx.pages()[0] || await newCtx.newPage();
              log('info', 'session_reconnected', { country });
              competitors = await searchAndVerify(page, country, searchTerm);
            } else { throw sessErr; }
          }

          if (competitors.length > 0) {
            // Save to publication_history
            await fetch(`${SUPABASE_URL}/rest/v1/publication_history`, {
              method: 'POST',
              headers: {
                'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json', 'Prefer': 'return=minimal',
              },
              body: JSON.stringify({
                ml_item_id: pub.ml_item_id,
                store_id: store.id,
                country,
                event_type: 'competidores_usa',
                source: 'browserbase_search',
                content: competitors.map(c => `${c.id}: ${c.title}`).join('\n'),
                metadata: {
                  competitor_ids: competitors.map(c => c.id),
                  competitor_links: competitors.map(c => c.url),
                  search_term: searchTerm,
                },
              }),
            });
            found++;
            log('info', 'found', { pub: pub.ml_item_id, competitors: competitors.length });
          } else {
            // Save that we searched but found nothing
            await fetch(`${SUPABASE_URL}/rest/v1/publication_history`, {
              method: 'POST',
              headers: {
                'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json', 'Prefer': 'return=minimal',
              },
              body: JSON.stringify({
                ml_item_id: pub.ml_item_id,
                store_id: store.id,
                country,
                event_type: 'competidores_usa',
                source: 'browserbase_search',
                content: 'No se encontraron competidores USA',
                metadata: { competitor_ids: [], search_term: searchTerm },
              }),
            });
            notFound++;
            log('info', 'not_found', { pub: pub.ml_item_id });
          }
        } catch (e) {
          log('error', 'search_failed', { pub: pub.ml_item_id, error: e.message.split('\n')[0] });
        }
      }

      try { await browser.close(); } catch {}
      log('info', 'country_done', { store: store.id, country, found, notFound });
    }
  }

  log('info', 'done');
})().catch(e => { log('error', 'fatal', { error: e.message }); process.exit(1); });
