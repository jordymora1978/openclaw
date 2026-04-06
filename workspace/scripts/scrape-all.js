/**
 * Scrape ALL countries in a single Browserbase session.
 *
 * Professional standards:
 * - Structured JSON logging with timestamps
 * - Per-country stats saved to scrape_logs
 * - Circuit breaker per country (in scrape-country.js)
 * - Retry with exponential backoff (in scrape-country.js)
 * - Dead letter for failed inquiries
 */
const { chromium } = require('/app/node_modules/playwright-core');
const { scrapeCountry } = require('./scrape-country.js');

const BB_KEY = process.env.BROWSERBASE_API_KEY;
const BB_PROJECT = process.env.BROWSERBASE_PROJECT_ID;
const BB_CONTEXT = process.env.BB_CONTEXT_49;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const STORE_ID = 49;
const COUNTRIES = ['Mexico', 'Brazil', 'Argentina', 'Chile', 'Colombia'];

function log(level, action, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, action, ...data }));
}

if (!BB_CONTEXT) {
  log('error', 'missing_config', { var: 'BB_CONTEXT_49' });
  process.exit(1);
}

(async () => {
  const startTime = Date.now();
  log('info', 'scrape_start', { store: STORE_ID, countries: COUNTRIES });

  // Create session
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
  if (!sess.connectUrl) {
    log('error', 'session_failed', { response: JSON.stringify(sess).substring(0, 200) });
    process.exit(1);
  }
  log('info', 'session_created', { id: sess.id });

  const b = await chromium.connectOverCDP(sess.connectUrl);
  const ctx = b.contexts()[0];
  const p = ctx.pages()[0] || await ctx.newPage();

  // Verify login
  await p.goto('https://global-selling.mercadolibre.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(3000);
  const check = await p.innerText('body');
  if (!check.includes('Summary') && !check.includes('Add listings')) {
    log('error', 'auth_failed', { reason: 'not_logged_in' });
    await b.close();
    process.exit(1);
  }
  log('info', 'auth_ok');

  // Scrape each country
  const allStats = [];
  const countriesOk = [];
  const countriesFail = [];
  const allErrors = [];

  for (const country of COUNTRIES) {
    try {
      const stats = await scrapeCountry(p, country, STORE_ID);
      allStats.push(stats);
      if (stats.errors.length === 0) {
        countriesOk.push(country);
      } else {
        countriesFail.push(country);
        allErrors.push(...stats.errors.map(e => `${country}: ${e}`));
      }
    } catch (e) {
      log('error', 'country_fatal', { country, error: e.message.split('\n')[0] });
      countriesFail.push(country);
      allErrors.push(`${country}: FATAL — ${e.message.split('\n')[0]}`);
      allStats.push({
        country: country.substring(0, 2).toUpperCase(),
        store_id: STORE_ID,
        inquiries_found: 0,
        inquiries_saved: 0,
        inquiries_with_conversation: 0,
        errors: [e.message.split('\n')[0]],
        failed_inquiries: [],
        account_status: null,
      });
    }
  }

  await b.close();

  // Summary
  const elapsed = Date.now() - startTime;
  const totalFound = allStats.reduce((s, c) => s + c.inquiries_found, 0);
  const totalSaved = allStats.reduce((s, c) => s + c.inquiries_saved, 0);
  const totalConv = allStats.reduce((s, c) => s + c.inquiries_with_conversation, 0);
  const totalFailed = allStats.reduce((s, c) => s + c.failed_inquiries.length, 0);
  const status = countriesFail.length === 0 ? 'success' : countriesOk.length === 0 ? 'error' : 'partial';

  log('info', 'scrape_done', {
    status,
    duration_ms: elapsed,
    countries_ok: countriesOk,
    countries_fail: countriesFail,
    total_found: totalFound,
    total_saved: totalSaved,
    total_with_conversation: totalConv,
    total_failed: totalFailed,
    errors: allErrors,
  });

  // Save to scrape_logs
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
        new_inquiries: totalSaved,
        total_inquiries: totalFound,
        errors: allErrors,
        duration_ms: elapsed,
        status,
      }),
    });
    log('info', 'scrape_log_saved');
  } catch (e) {
    log('error', 'scrape_log_failed', { error: e.message });
  }
})().catch(e => { log('error', 'fatal', { error: e.message }); process.exit(1); });
