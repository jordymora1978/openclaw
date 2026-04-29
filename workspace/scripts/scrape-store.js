/**
 * Scrape ALL countries for a SINGLE store.
 * Usage: node scrape-store.js 49   or   node scrape-store.js 51
 * Each store runs independently with its own Browserbase session.
 */
const { chromium } = require('/app/node_modules/playwright-core');
const { scrapeCountry } = require('./scrape-country.js');

const BB_KEY = process.env.BROWSERBASE_API_KEY;
const BB_PROJECT = process.env.BROWSERBASE_PROJECT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const COUNTRIES = ['Mexico', 'Brazil', 'Argentina', 'Chile', 'Colombia'];

const STORE_ID = parseInt(process.argv[2] || '49');
const STORE_NAME = { 49: 'UGL', 51: 'UMI' }[STORE_ID] || `S${STORE_ID}`;
const BB_CONTEXT = process.env[`BB_CONTEXT_${STORE_ID}`];

function log(level, action, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, action, store: STORE_ID, ...data }));
}

if (!BB_CONTEXT) {
  log('error', 'no_context', { var: `BB_CONTEXT_${STORE_ID}` });
  process.exit(1);
}

async function createSession() {
  const resp = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'x-bb-api-key': BB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: BB_PROJECT, region: 'us-east-1',
      browserSettings: { solveCaptchas: true, context: { id: BB_CONTEXT, persist: true } },
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

async function freshSession(label) {
  const sess = await createSession();
  const { browser, page } = await connectAndVerify(sess);
  log('info', 'session_ready', { session: sess.id, for: label });
  return { sess, browser, page };
}

(async () => {
  const startTime = Date.now();
  log('info', 'start', { name: STORE_NAME, countries: COUNTRIES, strategy: 'session-per-country' });

  let sessionCount = 0;
  const allStats = [];
  const countriesOk = [];
  const countriesFail = [];
  const allErrors = [];

  // ESTRATEGIA POR GRUPOS: una sesión Browserbase fresca por cada país.
  // Evita que la sesión muera tras 5+ min de uso intenso (root cause del fallo previo).
  for (const country of COUNTRIES) {
    let browser, page;
    try {
      ({ browser, page } = await freshSession(country));
      sessionCount++;
    } catch (e) {
      log('error', 'session_init_failed', { country, error: e.message.split('\n')[0] });
      countriesFail.push(country);
      allErrors.push(`${country}: session init failed`);
      continue;
    }

    let retried = false;
    try {
      const stats = await scrapeCountry(page, country, STORE_ID);
      allStats.push(stats);

      const sessionDied = stats.errors.some(e => e.includes('browser has been closed') || e.includes('Target page'));
      const saved = (stats.inquiries_new || 0) + (stats.inquiries_updated || 0) + (stats.inquiries_unchanged || 0);

      if (sessionDied && saved < stats.inquiries_found) {
        log('warn', 'session_died', { country, saved, found: stats.inquiries_found });
        try { await browser.close().catch(() => {}); } catch {}
        ({ browser, page } = await freshSession(country + '-retry'));
        sessionCount++;
        const retryStats = await scrapeCountry(page, country, STORE_ID);
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
        try { await browser.close().catch(() => {}); } catch {}
        try {
          ({ browser, page } = await freshSession(country + '-retry'));
          sessionCount++;
          const retryStats = await scrapeCountry(page, country, STORE_ID);
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
    } finally {
      // Cerrar sesión al final de cada país antes de pasar al siguiente
      try { await browser.close().catch(() => {}); } catch {}
    }
  }

  const elapsed = Date.now() - startTime;
  const totalFound = allStats.reduce((s, c) => s + (c.inquiries_found || 0), 0);
  const totalNew = allStats.reduce((s, c) => s + (c.inquiries_new || 0), 0);
  const totalUpdated = allStats.reduce((s, c) => s + (c.inquiries_updated || 0), 0);
  const totalUnchanged = allStats.reduce((s, c) => s + (c.inquiries_unchanged || 0), 0);
  const totalConv = allStats.reduce((s, c) => s + (c.inquiries_with_conversation || 0), 0);
  const totalFailed = allStats.reduce((s, c) => s + (c.failed_inquiries || []).length, 0);
  const status = countriesFail.length === 0 ? 'success' : countriesOk.length === 0 ? 'error' : 'partial';

  log('info', 'done', {
    status, duration_s: Math.round(elapsed / 1000), sessions: sessionCount,
    ok: countriesOk, fail: countriesFail,
    found: totalFound, new: totalNew, updated: totalUpdated, unchanged: totalUnchanged,
    conversations: totalConv, failed: totalFailed,
  });

  // Save log
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/scrape_logs`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        scrape_type: 'inquiries', store_id: STORE_ID,
        countries_scraped: countriesOk, countries_failed: countriesFail,
        new_inquiries: totalNew, updated_inquiries: totalUpdated, total_inquiries: totalFound,
        errors: allErrors, duration_ms: elapsed, status,
      }),
    });
    log('info', 'log_saved');
  } catch (e) { log('error', 'log_failed', { error: e.message }); }
})().catch(e => { log('error', 'fatal', { error: e.message }); process.exit(1); });
