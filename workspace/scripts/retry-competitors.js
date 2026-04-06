/**
 * Retry competitor search for publications that found no competitors.
 * Uses LLM to extract main ingredient from title, then searches
 * "suplemento [ingredient]" with INTERNATIONAL filter.
 *
 * Usage: node retry-competitors.js [store_id]
 */
const { chromium } = require('/app/node_modules/playwright-core');

const BB_KEY = process.env.BROWSERBASE_API_KEY;
const BB_PROJECT = process.env.BROWSERBASE_PROJECT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const CATALOG_URL = process.env.SUPABASE_CATALOG_URL;
const CATALOG_KEY = process.env.SUPABASE_CATALOG_ANON_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

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

async function getNoCompetitorPubs(storeId) {
  // Get publication_history entries with no competitors found
  const histResp = await fetch(
    `${SUPABASE_URL}/rest/v1/publication_history?select=ml_item_id,metadata,country` +
    `&event_type=eq.competidores_usa&store_id=eq.${storeId}` +
    `&or=(content.like.*No%20competidores*,content.like.*No%20se%20encontraron*)`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  const history = await histResp.json();

  // Get titles from catalog
  const itemIds = history.map(h => h.ml_item_id);
  if (itemIds.length === 0) return [];

  const pubResp = await fetch(
    `${CATALOG_URL}/rest/v1/ml_publications?select=ml_item_id,title,destination_country` +
    `&ml_item_id=in.(${itemIds.join(',')})`,
    { headers: { 'apikey': CATALOG_KEY, 'Authorization': `Bearer ${CATALOG_KEY}` } }
  );
  const pubs = await pubResp.json();

  // Merge: add title to history entries
  const titleMap = {};
  for (const p of pubs) titleMap[p.ml_item_id] = p.title;

  return history
    .filter(h => titleMap[h.ml_item_id])
    .map(h => ({
      ml_item_id: h.ml_item_id,
      title: titleMap[h.ml_item_id],
      country: h.country,
      old_search_term: h.metadata?.search_term || '',
    }));
}

async function extractIngredients(pubs) {
  const titles = pubs.map((p, i) => `${i + 1}. [${p.ml_item_id}] ${p.title}`).join('\n');

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 4000,
      messages: [
        {
          role: 'system',
          content: `Extraes el ingrediente principal de títulos de suplementos. Responde SOLO en JSON válido.

Para cada título, extrae el ingrediente o producto principal SIN marca, SIN dosis, SIN formato.

Ejemplos:
- "Himalaya Boswellia Serrata 250mg 60 caps" → "boswellia"
- "Now Foods Glicinato De Magnésio 400mg" → "magnésio"
- "Nature's Bounty Ginseng Complex 75 caps" → "ginseng"
- "Suplemento Osteo Bi-flex Triple Strength" → "glucosamina condroitina"
- "Multivitamínico Feminino Centrum Silver" → "multivitamínico feminino"
- "Tylenol Para Músculos E Articulações" → "paracetamol articulações"
- "Loção Corporal Jergens Ultra Healing" → null (no es suplemento)

Responde con formato: {"results": [{"id": "MLB123", "ingredient": "ingrediente"}, ...]}`
        },
        {
          role: 'user',
          content: titles
        },
      ],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI error: ${resp.status} ${err.substring(0, 200)}`);
  }

  const data = await resp.json();
  const text = data.choices[0].message.content.trim();
  try {
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(jsonStr).results || [];
  } catch (e) {
    log('error', 'parse_failed', { raw: text.substring(0, 500) });
    return [];
  }
}

async function searchAndVerify(page, country, searchTerm) {
  const baseUrl = SEARCH_URLS[country];
  if (!baseUrl) return [];

  const encoded = encodeURIComponent(searchTerm).replace(/%20/g, '+');
  const url = baseUrl + encoded + '#D[A:' + encoded + ',L:INTERNATIONAL]';

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(4000);

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
        pageText.includes('Ships from USA');
      const isOurs = pageText.includes('USAGLOBAL') || pageText.includes('USAMIAMI') ||
        pageText.includes('GLOBAL SELLER') || pageText.includes('Global Seller') ||
        pageText.includes('Global technology');

      if (isUSA && !isOurs) verified.push(item);
    } catch {}
  }
  return verified;
}

(async () => {
  const storeFilter = process.argv[2] ? parseInt(process.argv[2]) : null;
  const stores = [{ id: 49 }, { id: 51 }].filter(s => !storeFilter || s.id === storeFilter);

  log('info', 'retry_start', { stores: stores.map(s => s.id) });

  for (const store of stores) {
    const pubs = await getNoCompetitorPubs(store.id);
    log('info', 'no_competitor_pubs', { store: store.id, total: pubs.length });
    if (pubs.length === 0) continue;

    // Step 1: Extract ingredients via LLM (batch all titles in one call)
    log('info', 'extracting_ingredients', { count: pubs.length });
    const ingredients = await extractIngredients(pubs);
    log('info', 'ingredients_extracted', { count: ingredients.length });

    // Build ingredient map
    const ingredientMap = {};
    for (const r of ingredients) {
      if (r.ingredient) ingredientMap[r.id] = r.ingredient;
    }

    // Filter: only retry pubs with valid ingredients
    const toRetry = pubs.filter(p => ingredientMap[p.ml_item_id]);
    log('info', 'to_retry', {
      store: store.id,
      withIngredient: toRetry.length,
      skipped: pubs.length - toRetry.length,
    });

    // Group by country
    const byCountry = {};
    for (const p of toRetry) {
      if (!byCountry[p.country]) byCountry[p.country] = [];
      byCountry[p.country].push(p);
    }

    for (const [country, countryPubs] of Object.entries(byCountry)) {
      log('info', 'country_start', { store: store.id, country, count: countryPubs.length });

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
        const ingredient = ingredientMap[pub.ml_item_id];
        const searchTerm = country === 'BR'
          ? `suplemento ${ingredient}`
          : `suplemento ${ingredient}`;

        try {
          log('info', 'retry_searching', {
            pub: pub.ml_item_id,
            oldTerm: pub.old_search_term,
            newTerm: searchTerm,
            country,
          });

          let competitors;
          try {
            competitors = await searchAndVerify(page, country, searchTerm);
          } catch (sessErr) {
            if (sessErr.message.includes('browser has been closed') || sessErr.message.includes('Target page')) {
              log('warn', 'session_reconnecting', { pub: pub.ml_item_id });
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
              competitors = await searchAndVerify(page, country, searchTerm);
            } else { throw sessErr; }
          }

          if (competitors.length > 0) {
            // Update existing record
            await fetch(
              `${SUPABASE_URL}/rest/v1/publication_history?ml_item_id=eq.${pub.ml_item_id}&event_type=eq.competidores_usa&store_id=eq.${store.id}`,
              {
                method: 'PATCH',
                headers: {
                  'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
                  'Content-Type': 'application/json', 'Prefer': 'return=minimal',
                },
                body: JSON.stringify({
                  content: competitors.map(c => `${c.id}: ${c.title}`).join('\n'),
                  metadata: {
                    competitor_ids: competitors.map(c => c.id),
                    competitor_links: competitors.map(c => c.url),
                    search_term: searchTerm,
                    retry: true,
                    original_search_term: pub.old_search_term,
                  },
                }),
              }
            );
            found++;
            log('info', 'retry_found', { pub: pub.ml_item_id, competitors: competitors.length });
          } else {
            // Update metadata to mark as retried
            await fetch(
              `${SUPABASE_URL}/rest/v1/publication_history?ml_item_id=eq.${pub.ml_item_id}&event_type=eq.competidores_usa&store_id=eq.${store.id}`,
              {
                method: 'PATCH',
                headers: {
                  'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
                  'Content-Type': 'application/json', 'Prefer': 'return=minimal',
                },
                body: JSON.stringify({
                  metadata: {
                    competitor_ids: [],
                    search_term: searchTerm,
                    retry: true,
                    original_search_term: pub.old_search_term,
                    ingredient: ingredient,
                  },
                }),
              }
            );
            notFound++;
            log('info', 'retry_not_found', { pub: pub.ml_item_id, term: searchTerm });
          }
        } catch (e) {
          log('error', 'retry_failed', { pub: pub.ml_item_id, error: e.message.split('\n')[0] });
        }
      }

      try { await browser.close(); } catch {}
      log('info', 'country_done', { store: store.id, country, found, notFound });
    }
  }

  log('info', 'retry_done');
})().catch(e => { log('error', 'fatal', { error: e.message }); process.exit(1); });
