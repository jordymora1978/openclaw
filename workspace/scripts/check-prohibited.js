/**
 * Check prohibited products per destination per store — REAL TIME from ML API
 *
 * Flow:
 * 1. Get token for each store (49, 51)
 * 2. Get ALL CBT parent IDs
 * 3. For each parent, check /items/{cbt_id}/marketplace_items
 * 4. Filter under_review + inactive children
 * 5. Get detail via /marketplace/items/{id} for infraction_reason
 * 6. Report counts by country + reason
 *
 * Usage:
 *   node /data/.openclaw/workspace/scripts/check-prohibited.js 2>&1
 */

const PROXY_URL = 'https://mcp-ml-proxy-production.up.railway.app';
const PROXY_KEY = 'dropux-mcp-proxy-2026';
const ML_API = 'https://api.mercadolibre.com';
const STORES = [49, 51];
const SITE_TO_COUNTRY = { MLM: 'MX', MLB: 'BR', MLA: 'AR', MLC: 'CL', MCO: 'CO' };
const TARGET_REASONS = [
  'The product is prohibited.',
  'Your listing was paused because it apparently offered a forbidden product.',
  'It did not comply with our policies.',
];

async function getToken(storeId) {
  const resp = await fetch(`${PROXY_URL}/token/${storeId}`, {
    headers: { 'Authorization': `Bearer ${PROXY_KEY}` },
  });
  if (!resp.ok) throw new Error(`Token failed for store ${storeId}: ${resp.status}`);
  const data = await resp.json();
  return data.access_token;
}

async function fetchJSON(url, token) {
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!resp.ok) return null;
  return resp.json();
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scanStore(storeId) {
  console.log(`\n=== Store ${storeId} ===`);
  const token = await getToken(storeId);

  // Step 1: Get user info
  const me = await fetchJSON(`${ML_API}/users/me`, token);
  console.log(`User: ${me.nickname} (${me.id})`);

  // Step 2: Get ALL parent CBT IDs (use scroll to bypass 1000 offset limit)
  const allParents = [];
  let scrollId = '';
  while (true) {
    const url = scrollId
      ? `${ML_API}/users/${me.id}/items/search?search_type=scan&scroll_id=${scrollId}&limit=100`
      : `${ML_API}/users/${me.id}/items/search?search_type=scan&limit=100`;
    const data = await fetchJSON(url, token);
    if (!data || !data.results || data.results.length === 0) break;
    allParents.push(...data.results);
    scrollId = data.scroll_id || '';
    if (!scrollId) break;
    await sleep(50);
  }
  console.log(`Total CBT parents: ${allParents.length}`);

  // Step 3: Expand marketplace_items, collect under_review + inactive
  const problematic = []; // { localId, country, parentId }
  let checked = 0;
  for (const cbtId of allParents) {
    const mp = await fetchJSON(`${ML_API}/items/${cbtId}/marketplace_items`, token);
    if (!mp || !mp.marketplace_items) continue;
    for (const li of mp.marketplace_items) {
      const localStatus = li.status || '';
      if (localStatus === 'under_review' || localStatus === 'inactive') {
        const country = SITE_TO_COUNTRY[li.site_id] || li.site_id;
        problematic.push({ localId: li.item_id, country, parentId: cbtId, status: localStatus });
      }
    }
    checked++;
    if (checked % 500 === 0) console.log(`  Checked ${checked}/${allParents.length} parents...`);
    await sleep(30);
  }
  console.log(`Problematic children (under_review + inactive): ${problematic.length}`);

  // Step 4: Get detail for each problematic item
  const results = [];
  for (const item of problematic) {
    const detail = await fetchJSON(`${ML_API}/marketplace/items/${item.localId}`, token);
    if (!detail) continue;
    const subs = detail.sub_status || [];
    const isForbidden = subs.includes('forbidden');
    const title = (detail.title || '').substring(0, 60);
    const asin = detail.seller_custom_field || '';
    results.push({
      localId: item.localId,
      country: item.country,
      status: detail.status,
      subs,
      isForbidden,
      title,
      parentId: item.parentId,
      asin,
    });
    await sleep(50);
  }

  // Step 5: Filter only forbidden (causes suspension)
  const prohibited = results.filter(r => r.isForbidden);

  // Report
  const byCountry = {};
  for (const p of prohibited) {
    if (!byCountry[p.country]) byCountry[p.country] = [];
    byCountry[p.country].push(p);
  }

  console.log(`\n--- Store ${storeId}: Productos que causan suspension ---`);
  console.log(`Total: ${prohibited.length}`);
  for (const [country, items] of Object.entries(byCountry).sort()) {
    console.log(`\n  ${country} (${items.length}):`);
    for (const item of items) {
      console.log(`    ${item.localId} | ${item.asin || 'no-asin'} | ${item.subs.join(',')} | ${item.title}`);
    }
  }

  // Also report non-forbidden problematic items
  const notForbidden = results.filter(r => !r.isForbidden);
  if (notForbidden.length > 0) {
    console.log(`\n  Otros problematicos (no forbidden): ${notForbidden.length}`);
    for (const r of notForbidden) {
      console.log(`    ${r.localId} | ${r.country} | ${r.subs.join(',')} | ${r.title}`);
    }
  }

  return { storeId, prohibited, byCountry, totalProblematic: problematic.length };
}

(async () => {
  console.log('=== Check Prohibited Products — Real Time ML API ===');
  const allResults = [];

  for (const storeId of STORES) {
    try {
      const result = await scanStore(storeId);
      allResults.push(result);
    } catch (e) {
      console.error(`Store ${storeId} FAILED:`, e.message);
    }
  }

  // Grand total
  console.log('\n\n========== RESUMEN TOTAL ==========');
  for (const r of allResults) {
    console.log(`\nStore ${r.storeId}: ${r.prohibited.length} productos prohibidos (de ${r.totalProblematic} problematicos)`);
    for (const [country, items] of Object.entries(r.byCountry).sort()) {
      console.log(`  ${country}: ${items.length}`);
    }
  }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
