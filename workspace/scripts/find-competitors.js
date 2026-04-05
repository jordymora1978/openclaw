/**
 * Find competitors for appeal_cases with status pendiente_investigacion.
 *
 * Reads cases from Supabase, searches ML with Browserbase proxy,
 * saves competitor_ids and competitor_links, updates status to listo.
 *
 * No LLM. No tokens. Only Browserbase + Supabase.
 *
 * Usage: node /data/.openclaw/workspace/scripts/find-competitors.js
 */

const { chromium } = require('/app/node_modules/playwright-core');

const BB_KEY = process.env.BROWSERBASE_API_KEY;
const BB_PROJECT = process.env.BROWSERBASE_PROJECT_ID;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;

const SEARCH_URLS = {
  BR: 'https://lista.mercadolivre.com.br/',
  CO: 'https://listado.mercadolibre.com.co/',
  AR: 'https://listado.mercadolibre.com.ar/',
  MX: 'https://listado.mercadolibre.com.mx/',
  CL: 'https://listado.mercadolibre.cl/',
};

async function supabaseGet(path) {
  const resp = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` },
  });
  return resp.json();
}

async function supabasePatch(table, id, data) {
  const resp = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  return resp.ok;
}

async function searchCompetitors(country, searchTerm) {
  const baseUrl = SEARCH_URLS[country];
  if (!baseUrl) return [];

  const sess = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'x-bb-api-key': BB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: BB_PROJECT,
      region: 'us-east-1',
      proxies: [{ type: 'browserbase', geolocation: { country } }],
    }),
  }).then(r => r.json());

  if (!sess.connectUrl) {
    console.error(`[SEARCH] Failed to create session for ${country}`);
    return [];
  }

  const b = await chromium.connectOverCDP(sess.connectUrl);
  const ctx = b.contexts()[0];
  const p = ctx.pages()[0] || await ctx.newPage();

  const url = baseUrl + encodeURIComponent(searchTerm).replace(/%20/g, '+');
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await p.waitForTimeout(4000);

  const items = await p.evaluate(() => {
    const results = [];
    const seen = new Set();
    document.querySelectorAll('a').forEach(a => {
      if ((a.href.includes('/p/') || a.href.includes('_JM')) && a.href.includes('mercadoli')) {
        const text = a.textContent.trim();
        const url = a.href.split('?')[0].split('#')[0];
        if (text.length > 15 && !seen.has(url)) {
          seen.add(url);
          // Extract MLB/MCO/MLA ID from URL
          const match = url.match(/(MLB|MCO|MLA|MLC|MLM)\d+/);
          const id = match ? match[0] : '';
          results.push({ title: text.substring(0, 80), url, id });
        }
      }
    });
    return results.slice(0, 5);
  });

  await b.close();
  return items;
}

(async () => {
  console.log('=== Find Competitors for Appeal Cases ===');

  // Get pending cases
  const cases = await supabaseGet(
    'appeal_cases?select=id,case_id,country,ml_item_ids,store_id&status=eq.pendiente_investigacion&order=created_at.asc'
  );

  if (!cases.length) {
    console.log('No pending cases.');
    return;
  }

  console.log(`Found ${cases.length} pending cases`);

  // Get product titles for search terms
  const CATALOG_URL = process.env.SUPABASE_CATALOG_URL;
  const CATALOG_KEY = process.env.SUPABASE_CATALOG_ANON_KEY;

  for (const c of cases) {
    console.log(`\n--- ${c.case_id} (${c.country}) ---`);

    // Get first item's title as search term
    const firstId = (c.ml_item_ids || [])[0];
    if (!firstId) { console.log('No items'); continue; }

    let searchTerm = '';
    try {
      const pubResp = await fetch(
        `${CATALOG_URL}/rest/v1/ml_publications?select=title&ml_item_id=eq.${firstId}&limit=1`,
        { headers: { 'apikey': CATALOG_KEY, 'Authorization': `Bearer ${CATALOG_KEY}` } }
      );
      const pubs = await pubResp.json();
      if (pubs[0]) {
        // Clean title: remove brand prefixes, take main product name
        searchTerm = pubs[0].title.replace(/^Suplemento\s+/i, '').substring(0, 50);
      }
    } catch {}

    if (!searchTerm) {
      console.log('Could not get search term');
      continue;
    }

    console.log(`Searching: "${searchTerm}" in ${c.country}`);

    try {
      const competitors = await searchCompetitors(c.country, searchTerm);
      console.log(`Found ${competitors.length} competitors`);

      if (competitors.length > 0) {
        const ids = competitors.map(x => x.id).filter(Boolean);
        const links = competitors.map(x => x.url);

        await supabasePatch('appeal_cases', c.id, {
          competitor_ids: ids,
          competitor_links: links,
          status: 'listo',
          updated_at: new Date().toISOString(),
        });
        console.log(`Updated ${c.case_id}: ${ids.length} competitors, status=listo`);

        for (const comp of competitors) {
          console.log(`  ${comp.id} | ${comp.title}`);
        }
      } else {
        console.log('No competitors found — keeping pendiente_investigacion');
      }
    } catch (e) {
      console.error(`Error searching for ${c.case_id}: ${e.message}`);
    }
  }

  console.log('\n=== Done ===');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
