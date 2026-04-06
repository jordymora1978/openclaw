/**
 * Scrape ALL countries for ALL stores.
 * Each store gets its own Browserbase session with auto-reconnect.
 */
const { chromium } = require('/app/node_modules/playwright-core');
const { scrapeCountry } = require('./scrape-country.js');

const BB_KEY = process.env.BROWSERBASE_API_KEY;
const BB_PROJECT = process.env.BROWSERBASE_PROJECT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const COUNTRIES = ['Mexico', 'Brazil', 'Argentina', 'Chile', 'Colombia'];

const STORES = [
  { id: 49, name: 'UGL', context: process.env.BB_CONTEXT_49 },
  { id: 51, name: 'UMI', context: process.env.BB_CONTEXT_51 },
].filter(s => s.context);

function log(level, action, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, action, ...data }));
}

if (STORES.length === 0) {
  log('error', 'no_stores_configured');
  process.exit(1);
}

async function createSession(contextId) {
  const resp = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'x-bb-api-key': BB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: BB_PROJECT, region: 'us-east-1',
      browserSettings: { solveCaptchas: true, context: { id: contextId, persist: true } },
      keepAlive: true,
    }),
  });
  const sess = await resp.json();
  if (!sess.connectUrl) throw new Error(`Session failed: ${JSON.stringify(sess).substring(0, 200)}`);
  return sess;
}

async function connectAndVerify(sess) {
  const b = await chromium.connectOverCDP(sess.connectUrl);
  const ctx = b.contexts()[0];
  const p = ctx.pages()[0] || await ctx.newPage();
  await p.goto('https://global-selling.mercadolibre.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(3000);
  const check = await p.innerText('body');
  if (!check.includes('Summary') && !check.includes('Add listings')) {
    await b.close();
    throw new Error('Not logged in');
  }
  return { browser: b, page: p };
}

async function scrapeStore(store) {
  log('info', 'store_start', { store: store.id, name: store.name });

  let sess = await createSession(store.context);
  let sessionCount = 1;
  log('info', 'session_created', { store: store.id, session: sess.id });
  let { browser, page } = await connectAndVerify(sess);
  log('info', 'auth_ok', { store: store.id });

  const allStats = [];
  const countriesOk = [];
  const countriesFail = [];
  const allErrors = [];

  for (const country of COUNTRIES) {
    let retried = false;
    try {
      const stats = await scrapeCountry(page, country, store.id);
      allStats.push(stats);

      const sessionDied = stats.errors.some(e => e.includes('browser has been closed') || e.includes('Target page'));

      if (sessionDied && (stats.inquiries_new + stats.inquiries_updated + stats.inquiries_unchanged) < stats.inquiries_found) {
        log('warn', 'session_died', { store: store.id, country });
        try { await browser.close().catch(() => {}); } catch {}

        sess = await createSession(store.context);
        sessionCount++;
        log('info', 'session_reconnected', { store: store.id, session: sess.id, for_country: country });
        ({ browser, page } = await connectAndVerify(sess));

        const retryStats = await scrapeCountry(page, country, store.id);
        retried = true;
        allStats[allStats.length - 1] = retryStats;

        if (retryStats.errors.length === 0) countriesOk.push(country);
        else { countriesFail.push(country); allErrors.push(...retryStats.errors.map(e => `${country}: ${e}`)); }
      } else if (stats.errors.length === 0) {
        countriesOk.push(country);
      } else {
        countriesFail.push(country);
        allErrors.push(...stats.errors.map(e => `${country}: ${e}`));
      }
    } catch (e) {
      const errMsg = e.message.split('\n')[0];
      if ((errMsg.includes('browser has been closed') || errMsg.includes('Target page')) && !retried) {
        log('warn', 'session_died_fatal', { store: store.id, country });
        try { await browser.close().catch(() => {}); } catch {}
        try {
          sess = await createSession(store.context);
          sessionCount++;
          ({ browser, page } = await connectAndVerify(sess));
          const retryStats = await scrapeCountry(page, country, store.id);
          allStats.push(retryStats);
          if (retryStats.errors.length === 0) countriesOk.push(country);
          else { countriesFail.push(country); allErrors.push(...retryStats.errors.map(e => `${country}: ${e}`)); }
        } catch (re) {
          countriesFail.push(country);
          allErrors.push(`${country}: reconnect failed`);
        }
      } else {
        countriesFail.push(country);
        allErrors.push(`${country}: ${errMsg}`);
      }
    }
  }

  try { await browser.close(); } catch {}

  return { store, allStats, countriesOk, countriesFail, allErrors, sessionCount };
}

(async () => {
  const startTime = Date.now();
  log('info', 'scrape_start', { stores: STORES.map(s => `${s.id}(${s.name})`), countries: COUNTRIES });

  for (const store of STORES) {
    try {
      const result = await scrapeStore(store);
      const elapsed = Date.now() - startTime;
      const totalFound = result.allStats.reduce((s, c) => s + (c.inquiries_found || 0), 0);
      const totalNew = result.allStats.reduce((s, c) => s + (c.inquiries_new || 0), 0);
      const totalUpdated = result.allStats.reduce((s, c) => s + (c.inquiries_updated || 0), 0);
      const totalUnchanged = result.allStats.reduce((s, c) => s + (c.inquiries_unchanged || 0), 0);
      const totalConv = result.allStats.reduce((s, c) => s + (c.inquiries_with_conversation || 0), 0);
      const totalFailed = result.allStats.reduce((s, c) => s + (c.failed_inquiries || []).length, 0);
      const status = result.countriesFail.length === 0 ? 'success' : result.countriesOk.length === 0 ? 'error' : 'partial';

      log('info', 'store_done', {
        store: store.id, name: store.name, status,
        sessions_used: result.sessionCount,
        countries_ok: result.countriesOk, countries_fail: result.countriesFail,
        total_found: totalFound, total_new: totalNew,
        total_updated: totalUpdated, total_unchanged: totalUnchanged,
        total_with_conversation: totalConv, total_failed: totalFailed,
      });

      // Save to scrape_logs
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/scrape_logs`, {
          method: 'POST',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            scrape_type: 'inquiries', store_id: store.id,
            countries_scraped: result.countriesOk, countries_failed: result.countriesFail,
            new_inquiries: totalNew, updated_inquiries: totalUpdated, total_inquiries: totalFound,
            errors: result.allErrors, duration_ms: elapsed, status,
          }),
        });
      } catch (e) { log('error', 'log_save_failed', { store: store.id, error: e.message }); }

    } catch (e) {
      log('error', 'store_failed', { store: store.id, error: e.message.split('\n')[0] });
    }
  }

  log('info', 'scrape_all_done', { duration_ms: Date.now() - startTime, stores_scraped: STORES.length });
})().catch(e => { log('error', 'fatal', { error: e.message }); process.exit(1); });
