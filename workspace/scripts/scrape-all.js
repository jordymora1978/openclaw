/**
 * Scrape ALL countries in a single Browserbase session.
 *
 * Usage:
 *   PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
 *   node /data/.openclaw/workspace/scripts/scrape-all.js 2>&1
 *
 * Requires BB_CONTEXT_49 env var (created by setup-context.js).
 * Creates 1 session, scrapes 5 countries, closes. Minimal cost.
 */
const { chromium } = require('/app/node_modules/playwright-core');
const { scrapeCountry } = require('./scrape-country.js');

const BB_KEY = process.env.BROWSERBASE_API_KEY;
const BB_PROJECT = process.env.BROWSERBASE_PROJECT_ID;
const BB_CONTEXT = process.env.BB_CONTEXT_49;
const STORE_ID = 49;
const COUNTRIES = ['Mexico', 'Brazil', 'Argentina', 'Chile', 'Colombia'];

if (!BB_CONTEXT) {
  console.error('ERROR: BB_CONTEXT_49 env var not set. Run setup-context.js first.');
  process.exit(1);
}

(async () => {
  const startTime = Date.now();
  console.log('=== Scrape All Countries (Store 49) ===');

  // 1 session for all countries
  console.log(`[SESSION] Creating with context ${BB_CONTEXT.substring(0, 8)}...`);
  const sessResp = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'x-bb-api-key': BB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: BB_PROJECT,
      region: 'us-east-1',
      browserSettings: {
        solveCaptchas: true,
        context: { id: BB_CONTEXT, persist: true },
      },
      keepAlive: true,
    }),
  });
  const sess = await sessResp.json();
  if (!sess.connectUrl) { console.error('[SESSION] Failed:', JSON.stringify(sess)); process.exit(1); }
  console.log(`[SESSION] ${sess.id}`);

  const b = await chromium.connectOverCDP(sess.connectUrl);
  const ctx = b.contexts()[0];
  const p = ctx.pages()[0] || await ctx.newPage();

  // Verify login
  await p.goto('https://global-selling.mercadolibre.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(3000);
  const check = await p.innerText('body');
  if (!check.includes('Summary') && !check.includes('Add listings')) {
    console.error('[AUTH] Not logged in. Run setup-context.js to refresh cookies.');
    await b.close();
    process.exit(1);
  }
  console.log('[AUTH] Logged in via context cookies');

  // Scrape each country sequentially
  const results = [];
  for (const country of COUNTRIES) {
    try {
      await scrapeCountry(p, country, STORE_ID);
      results.push({ country, status: 'ok' });
    } catch (e) {
      console.error(`[ERROR] ${country}: ${e.message.split('\n')[0]}`);
      results.push({ country, status: 'error', error: e.message.split('\n')[0] });
    }
  }

  await b.close();

  // Summary
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const countriesOk = results.filter(r => r.status === 'ok').map(r => r.country);
  const countriesFail = results.filter(r => r.status === 'error').map(r => r.country);
  const errors = results.filter(r => r.error).map(r => `${r.country}: ${r.error}`);
  const status = countriesFail.length === 0 ? 'success' : countriesOk.length === 0 ? 'error' : 'partial';

  console.log(`\n=== All Done (${elapsed}s) — ${status} ===`);
  for (const r of results) {
    console.log(`  ${r.country}: ${r.status}${r.error ? ' — ' + r.error : ''}`);
  }

  // Save log to scrape_logs
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/scrape_logs`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        scrape_type: 'inquiries',
        store_id: STORE_ID,
        countries_scraped: countriesOk,
        countries_failed: countriesFail,
        errors: errors,
        duration_ms: elapsed * 1000,
        status: status,
      }),
    });
    console.log('[LOG] Saved to scrape_logs');
  } catch (e) {
    console.error('[LOG] Failed:', e.message);
  }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
