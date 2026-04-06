/**
 * Scrape ALL countries in a single Browserbase session.
 * Auto-reconnects if session dies mid-scrape.
 *
 * Professional standards:
 * - Auto-reconnect on session death
 * - Structured JSON logging with timestamps
 * - Per-country stats saved to scrape_logs
 * - Circuit breaker per country (in scrape-country.js)
 * - Retry with exponential backoff (in scrape-country.js)
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

async function createSession() {
  const resp = await fetch('https://api.browserbase.com/v1/sessions', {
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

(async () => {
  const startTime = Date.now();
  log('info', 'scrape_start', { store: STORE_ID, countries: COUNTRIES });

  // Initial session
  let sess = await createSession();
  log('info', 'session_created', { id: sess.id });
  let { browser, page } = await connectAndVerify(sess);
  log('info', 'auth_ok', { session: sess.id });

  // Scrape each country
  const allStats = [];
  const countriesOk = [];
  const countriesFail = [];
  const allErrors = [];
  let sessionCount = 1;

  for (const country of COUNTRIES) {
    let retried = false;

    try {
      const stats = await scrapeCountry(page, country, STORE_ID);
      allStats.push(stats);

      // Check if circuit breaker triggered (session probably dead)
      const sessionDied = stats.errors.some(e => e.includes('browser has been closed') || e.includes('Target page'));

      if (sessionDied && stats.inquiries_saved < stats.inquiries_found) {
        // Session died mid-country — reconnect and retry remaining
        log('warn', 'session_died', { country, saved: stats.inquiries_saved, found: stats.inquiries_found });

        try {
          await browser.close().catch(() => {});
        } catch {}

        sess = await createSession();
        sessionCount++;
        log('info', 'session_reconnected', { id: sess.id, session_number: sessionCount, for_country: country });
        ({ browser, page } = await connectAndVerify(sess));
        log('info', 'auth_ok', { session: sess.id });

        // Retry the country with fresh session
        const retryStats = await scrapeCountry(page, country, STORE_ID);
        retried = true;

        // Merge stats: add new saves to previous
        const mergedSaved = stats.inquiries_saved + retryStats.inquiries_saved;
        const mergedConv = stats.inquiries_with_conversation + retryStats.inquiries_with_conversation;
        const mergedErrors = retryStats.errors.length > 0 ? retryStats.errors : [];

        // Replace stats with merged
        allStats[allStats.length - 1] = {
          ...retryStats,
          inquiries_saved: mergedSaved,
          inquiries_with_conversation: mergedConv,
          errors: mergedErrors,
        };

        if (mergedErrors.length === 0) {
          countriesOk.push(country);
        } else {
          countriesFail.push(country);
          allErrors.push(...mergedErrors.map(e => `${country} (retry): ${e}`));
        }
      } else if (stats.errors.length === 0) {
        countriesOk.push(country);
      } else {
        countriesFail.push(country);
        allErrors.push(...stats.errors.map(e => `${country}: ${e}`));
      }

    } catch (e) {
      const errMsg = e.message.split('\n')[0];
      const isBrowserDead = errMsg.includes('browser has been closed') || errMsg.includes('Target page');

      if (isBrowserDead && !retried) {
        // Session died before we could even start — reconnect
        log('warn', 'session_died_fatal', { country, error: errMsg });

        try { await browser.close().catch(() => {}); } catch {}

        try {
          sess = await createSession();
          sessionCount++;
          log('info', 'session_reconnected', { id: sess.id, session_number: sessionCount, for_country: country });
          ({ browser, page } = await connectAndVerify(sess));
          log('info', 'auth_ok', { session: sess.id });

          const retryStats = await scrapeCountry(page, country, STORE_ID);
          allStats.push(retryStats);
          if (retryStats.errors.length === 0) {
            countriesOk.push(country);
          } else {
            countriesFail.push(country);
            allErrors.push(...retryStats.errors.map(e => `${country} (reconnect): ${e}`));
          }
        } catch (reconnectErr) {
          log('error', 'reconnect_failed', { country, error: reconnectErr.message.split('\n')[0] });
          countriesFail.push(country);
          allErrors.push(`${country}: reconnect failed — ${reconnectErr.message.split('\n')[0]}`);
        }
      } else {
        log('error', 'country_fatal', { country, error: errMsg });
        countriesFail.push(country);
        allErrors.push(`${country}: FATAL — ${errMsg}`);
      }
    }
  }

  try { await browser.close(); } catch {}

  // Summary
  const elapsed = Date.now() - startTime;
  const totalFound = allStats.reduce((s, c) => s + (c.inquiries_found || 0), 0);
  const totalSaved = allStats.reduce((s, c) => s + (c.inquiries_saved || 0), 0);
  const totalConv = allStats.reduce((s, c) => s + (c.inquiries_with_conversation || 0), 0);
  const totalFailed = allStats.reduce((s, c) => s + (c.failed_inquiries || []).length, 0);
  const status = countriesFail.length === 0 ? 'success' : countriesOk.length === 0 ? 'error' : 'partial';

  log('info', 'scrape_done', {
    status, duration_ms: elapsed, sessions_used: sessionCount,
    countries_ok: countriesOk, countries_fail: countriesFail,
    total_found: totalFound, total_saved: totalSaved,
    total_with_conversation: totalConv, total_failed: totalFailed,
    errors: allErrors,
  });

  // Save to scrape_logs
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/scrape_logs`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        scrape_type: 'inquiries', store_id: STORE_ID,
        countries_scraped: countriesOk, countries_failed: countriesFail,
        new_inquiries: totalSaved, total_inquiries: totalFound,
        errors: allErrors, duration_ms: elapsed, status,
      }),
    });
    log('info', 'scrape_log_saved');
  } catch (e) {
    log('error', 'scrape_log_failed', { error: e.message });
  }
})().catch(e => { log('error', 'fatal', { error: e.message }); process.exit(1); });
