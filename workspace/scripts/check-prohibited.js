/**
 * Check prohibited products — verify current ML status of known items
 *
 * Does NOT scan 24K items. Gets known prohibited IDs from Supabase,
 * then checks their CURRENT status in ML API. Takes seconds, not minutes.
 *
 * Usage:
 *   node /data/.openclaw/workspace/scripts/check-prohibited.js 2>&1
 */

const PROXY_URL = 'https://mcp-ml-proxy-production.up.railway.app';
const PROXY_KEY = 'dropux-mcp-proxy-2026';
const ML_API = 'https://api.mercadolibre.com';
const STORES = [49, 51];
const SB_URL = process.env.SUPABASE_CATALOG_URL;
const SB_KEY = process.env.SUPABASE_CATALOG_ANON_KEY;
const SITE_TO_COUNTRY = { MLM: 'MX', MLB: 'BR', MLA: 'AR', MLC: 'CL', MCO: 'CO' };

async function getToken(storeId) {
  const resp = await fetch(`${PROXY_URL}/token/${storeId}`, {
    headers: { 'Authorization': `Bearer ${PROXY_KEY}` },
  });
  return (await resp.json()).access_token;
}

async function getKnownProhibited() {
  const resp = await fetch(
    `${SB_URL}/rest/v1/ml_publications?select=ml_item_id,store_id,destination_country,title,asin` +
    `&or=(infraction_reason.eq.The%20product%20is%20prohibited.,infraction_reason.like.*forbidden%20product*,infraction_reason.eq.It%20did%20not%20comply%20with%20our%20policies.)` +
    `&store_id=in.(49,51)&order=store_id.asc,destination_country.asc`,
    { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
  );
  return resp.json();
}

(async () => {
  console.log('=== Prohibited Products — ML API Real Time ===\n');

  // Step 1: Get known prohibited IDs from Supabase
  const known = await getKnownProhibited();
  console.log(`Known prohibited in Supabase: ${known.length}`);

  // Step 2: Group by store
  const byStore = {};
  for (const item of known) {
    if (!byStore[item.store_id]) byStore[item.store_id] = [];
    byStore[item.store_id].push(item);
  }

  const summary = { apelable: [], cerrado: [], otro: [] };

  for (const [storeId, items] of Object.entries(byStore)) {
    console.log(`\n=== Store ${storeId} (${items.length} items) ===`);
    const token = await getToken(storeId);

    for (const item of items) {
      const resp = await fetch(`${ML_API}/marketplace/items/${item.ml_item_id}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!resp.ok) {
        console.log(`  ${item.ml_item_id} | ${item.destination_country} | ERROR ${resp.status}`);
        continue;
      }
      const d = await resp.json();
      const subs = d.sub_status || [];
      const isForbidden = subs.includes('forbidden');
      const isDeleted = subs.includes('deleted');
      const title = (d.title || '').substring(0, 55);

      if (d.status === 'under_review' && isForbidden && !isDeleted) {
        console.log(`  ✅ APELABLE | ${item.ml_item_id} | ${item.destination_country} | ${item.asin || 'no-asin'} | ${title}`);
        summary.apelable.push({ ...item, status: d.status, subs });
      } else if (d.status === 'closed' || isDeleted) {
        console.log(`  ❌ CERRADO  | ${item.ml_item_id} | ${item.destination_country} | ${title}`);
        summary.cerrado.push(item);
      } else {
        console.log(`  ⚪ OTRO     | ${item.ml_item_id} | ${item.destination_country} | ${d.status} | ${subs.join(',')} | ${title}`);
        summary.otro.push({ ...item, status: d.status, subs });
      }
    }
  }

  // Grand summary
  console.log('\n========== RESUMEN ==========');
  console.log(`Apelables: ${summary.apelable.length}`);
  console.log(`Cerrados/eliminados: ${summary.cerrado.length}`);
  console.log(`Otro estado: ${summary.otro.length}`);

  if (summary.apelable.length > 0) {
    console.log('\n--- APELABLES por destino ---');
    const byCountry = {};
    for (const a of summary.apelable) {
      const key = `Store ${a.store_id} → ${a.destination_country}`;
      if (!byCountry[key]) byCountry[key] = [];
      byCountry[key].push(a);
    }
    for (const [key, items] of Object.entries(byCountry).sort()) {
      console.log(`\n${key} (${items.length}):`);
      for (const i of items) {
        console.log(`  ${i.ml_item_id} | ${i.asin || 'no-asin'} | ${(i.title || '').substring(0, 55)}`);
      }
    }
  }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
