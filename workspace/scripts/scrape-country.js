/**
 * Scraper para UN SOLO país de ML Global Selling
 *
 * Estándares profesionales:
 * - Retry con backoff exponencial (3 intentos, 2s/4s/8s)
 * - Logging estructurado con timestamps
 * - Circuit breaker (3 fallos seguidos = para)
 * - Idempotente (upsert, no duplica)
 * - Dead letter (inquiries fallidos quedan registrados)
 */
const { chromium } = require('/app/node_modules/playwright-core');

const COUNTRY_CODES = { Mexico: 'MX', Brazil: 'BR', Argentina: 'AR', Chile: 'CL', Colombia: 'CO' };
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const UPSERT_KEYS = {
  ml_support_inquiries: 'store_id,inquiry_number',
  ml_account_health: 'store_id,country,scraped_date',
};

// ── Structured Logger ──
function log(level, action, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    action,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

// ── Retry with exponential backoff ──
async function withRetry(fn, label, maxAttempts = 3) {
  const delays = [2000, 4000, 8000];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const isLast = attempt === maxAttempts;
      log(isLast ? 'error' : 'warn', 'retry', {
        label,
        attempt,
        maxAttempts,
        error: e.message.split('\n')[0],
        willRetry: !isLast,
      });
      if (isLast) throw e;
      await new Promise(r => setTimeout(r, delays[attempt - 1]));
    }
  }
}

// ── Supabase upsert ──
async function supabaseUpsert(table, data) {
  const onConflict = UPSERT_KEYS[table] || '';
  const qs = onConflict ? `?on_conflict=${onConflict}` : '';
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}${qs}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal,resolution=merge-duplicates',
    },
    body: JSON.stringify(data),
  });
  if (!resp.ok) {
    const err = await resp.text();
    log('error', 'supabase_upsert_fail', { table, error: err });
  }
  return resp.ok;
}

/**
 * Scrape a single country.
 * @returns {object} stats — { inquiries_found, inquiries_saved, inquiries_with_conversation, errors, failed_inquiries }
 */
async function scrapeCountry(p, country, storeId) {
  const code = COUNTRY_CODES[country];
  if (!code) throw new Error(`Unknown country: ${country}`);

  // Get existing inquiries for this country to detect new vs updated
  let existingInquiries = {};
  try {
    const existResp = await fetch(
      `${SUPABASE_URL}/rest/v1/ml_support_inquiries?select=inquiry_number,inquiry_status,conversation_text&store_id=eq.${storeId}&country=eq.${code}`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const existData = await existResp.json();
    for (const e of (existData || [])) {
      existingInquiries[e.inquiry_number] = {
        status: e.inquiry_status,
        conv_length: (e.conversation_text || '').length,
      };
    }
  } catch (e) {
    log('warn', 'existing_fetch_failed', { country, error: e.message });
  }

  const stats = {
    country: code,
    store_id: storeId,
    inquiries_found: 0,
    inquiries_new: 0,
    inquiries_updated: 0,
    inquiries_unchanged: 0,
    inquiries_with_conversation: 0,
    errors: [],
    failed_inquiries: [],
    account_status: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  };

  // ── Switch country ──
  log('info', 'switch_country', { country, code });
  await withRetry(async () => {
    await p.goto('https://global-selling.mercadolibre.com/help/v2', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await p.waitForTimeout(3000);
    await p.locator('.nav-header-cbt__site-switcher-trigger').first().click({ timeout: 8000 });
    await p.waitForTimeout(2000);
    await p.getByText(country, { exact: true }).first().click({ timeout: 8000 });
    await p.waitForTimeout(4000);
  }, `switch_${country}`);

  const headerVal = await p.locator('.nav-header-cbt__site-switcher-value').first().innerText().catch(() => '?');
  log('info', 'switch_result', { country, header: headerVal });

  // ── Read Summary ──
  log('info', 'read_summary', { country });
  await p.goto('https://global-selling.mercadolibre.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await p.waitForTimeout(3000);
  const summaryText = await p.innerText('body');

  let accountStatus = 'active';
  let statusReason = '';
  if (summaryText.includes('permanently suspended') || summaryText.includes('permanently disable')) {
    accountStatus = 'suspended';
    const m = summaryText.match(/(We permanently suspended.*?\.)/s) || summaryText.match(/(Your listings have repeatedly.*?\.)/s);
    statusReason = m ? m[1] : 'suspended';
  } else if (summaryText.includes('suspended your account')) {
    accountStatus = 'suspended';
    const m = summaryText.match(/(We.*?suspended.*?\.)/s);
    statusReason = m ? m[1] : 'suspended';
  }
  stats.account_status = accountStatus;
  log('info', 'summary_result', { country, status: accountStatus, reason: statusReason.substring(0, 80) });

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  await supabaseUpsert('ml_account_health', {
    store_id: storeId, country: code,
    account_status: accountStatus, status_reason: statusReason,
    scraped_date: today,
  });

  // ── Read inquiries ──
  log('info', 'read_inquiries', { country });
  await p.goto('https://global-selling.mercadolibre.com/help/v2', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await p.waitForTimeout(3000);
  try { await p.getByText('Show all').click({ timeout: 5000 }); await p.waitForTimeout(3000); } catch (e) {}

  const hrefs = await p.locator('a').filter({ hasText: /Go to the inquir|Go to chat/ })
    .evaluateAll(els => els.map(el => el.href).filter(Boolean));
  stats.inquiries_found = hrefs.length;
  log('info', 'inquiries_found', { country, count: hrefs.length });

  // ── Circuit breaker ──
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;

  for (let i = 0; i < hrefs.length; i++) {
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      log('error', 'circuit_breaker', {
        country, after_inquiry: i,
        reason: `${MAX_CONSECUTIVE_FAILURES} consecutive failures — stopping country`,
      });
      stats.errors.push(`Circuit breaker triggered at inquiry ${i + 1}`);
      break;
    }

    const inquiryStart = Date.now();
    try {
      // ── Navigate to inquiry with retry ──
      await withRetry(async () => {
        await p.goto(hrefs[i], { waitUntil: 'domcontentloaded', timeout: 20000 });
        await p.waitForTimeout(3000);
      }, `inquiry_${i + 1}_navigate`);

      const qText = await p.innerText('body');

      // ── Extract number ──
      let inquiryNumber = '';
      const numMatch = qText.match(/Number\s*\n?\s*(\d+)/);
      if (numMatch) inquiryNumber = numMatch[1];
      if (!inquiryNumber) {
        log('warn', 'inquiry_no_number', { country, index: i + 1 });
        stats.failed_inquiries.push({ index: i + 1, reason: 'no_number' });
        consecutiveFailures++;
        continue;
      }

      // ── Extract date ──
      let inquiryDate = '';
      const dateMatch = qText.match(/Creation date\s*\n?\s*on\s*(.+?\d{4})/);
      if (dateMatch) inquiryDate = dateMatch[1].trim();

      // ── Extract status ──
      let inquiryStatus = 'open';
      if (qText.includes('It ended') || qText.includes('Completed')) inquiryStatus = 'completed';

      // ── Extract summary ──
      let summaryT = '';
      const sumMatch = qText.match(/(?:Summarized by artificial intelligence)\s*\n?\s*(.*?)(?:\n|Review|Details)/s);
      if (sumMatch) summaryT = sumMatch[1].trim();

      // ── Read conversation with retry ──
      let conversationText = '';
      try {
        await withRetry(async () => {
          const reviewBtn = p.locator('a, button').filter({ hasText: /Review the conversation|Go to chat/ });
          if (await reviewBtn.count() > 0) {
            await reviewBtn.first().click();
            await p.waitForTimeout(5000);
            const convPage = await p.innerText('body');
            conversationText = convPage
              .replace(/^[\s\S]*?Conversation\s*/m, '')
              .replace(/Resume consultation[\s\S]*$/m, '')
              .replace(/Investor relations[\s\S]*$/, '')
              .substring(0, 10000);
          }
        }, `inquiry_${inquiryNumber}_conversation`);
      } catch (e) {
        log('warn', 'conversation_failed', {
          country, inquiry: inquiryNumber,
          error: e.message.split('\n')[0],
          reason: 'retry_exhausted',
        });
        stats.failed_inquiries.push({ inquiry: inquiryNumber, reason: 'conversation_failed', error: e.message.split('\n')[0] });
      }

      // ── Classify: new / updated / unchanged ──
      const existing = existingInquiries[inquiryNumber];
      let changeType = 'new';
      if (existing) {
        const statusChanged = existing.status !== inquiryStatus;
        const convChanged = Math.abs(existing.conv_length - conversationText.length) > 10;
        if (statusChanged || convChanged) {
          changeType = 'updated';
        } else {
          changeType = 'unchanged';
        }
      }

      // ── Save to Supabase (always upsert to update scraped_at) ──
      await supabaseUpsert('ml_support_inquiries', {
        store_id: storeId, country: code,
        inquiry_number: inquiryNumber,
        inquiry_date: inquiryDate || null,
        inquiry_status: inquiryStatus,
        summary_text: summaryT,
        conversation_text: conversationText,
      });

      const elapsed = Date.now() - inquiryStart;
      if (changeType === 'new') stats.inquiries_new++;
      else if (changeType === 'updated') stats.inquiries_updated++;
      else stats.inquiries_unchanged++;
      if (conversationText) stats.inquiries_with_conversation++;
      consecutiveFailures = 0;

      log('info', 'inquiry_saved', {
        country, inquiry: inquiryNumber, status: inquiryStatus,
        change: changeType,
        has_conversation: !!conversationText,
        conversation_length: conversationText.length,
        duration_ms: elapsed,
      });

    } catch (e) {
      consecutiveFailures++;
      const elapsed = Date.now() - inquiryStart;
      log('error', 'inquiry_failed', {
        country, index: i + 1,
        error: e.message.split('\n')[0],
        consecutive_failures: consecutiveFailures,
        duration_ms: elapsed,
      });
      stats.errors.push(`inquiry ${i + 1}: ${e.message.split('\n')[0]}`);
      stats.failed_inquiries.push({ index: i + 1, reason: 'exception', error: e.message.split('\n')[0] });
    }
  }

  stats.finished_at = new Date().toISOString();
  log('info', 'country_done', {
    country: code,
    ...stats,
  });

  return stats;
}

// Export for use by scrape-all.js
module.exports = { scrapeCountry, COUNTRY_CODES };

// Standalone execution
if (require.main === module) {
  const BB_KEY = process.env.BROWSERBASE_API_KEY;
  const BB_PROJECT = process.env.BROWSERBASE_PROJECT_ID;
  const BB_CONTEXT = process.env.BB_CONTEXT_49;
  const STORE_ID = 49;
  const COUNTRY = process.argv[2] || 'Colombia';

  if (!BB_CONTEXT) {
    console.error('ERROR: BB_CONTEXT_49 env var not set. Run setup-context.js first.');
    process.exit(1);
  }

  (async () => {
    log('info', 'standalone_start', { country: COUNTRY, store: STORE_ID });

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
        proxies: true,
      }),
    });
    const sess = await sessResp.json();
    if (!sess.connectUrl) { log('error', 'session_failed', { response: JSON.stringify(sess).substring(0, 200) }); process.exit(1); }
    log('info', 'session_created', { id: sess.id });

    const b = await chromium.connectOverCDP(sess.connectUrl);
    const ctx = b.contexts()[0];
    const p = ctx.pages()[0] || await ctx.newPage();

    await p.goto('https://global-selling.mercadolibre.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p.waitForTimeout(3000);
    const check = await p.innerText('body');
    if (!check.includes('Summary') && !check.includes('Add listings')) {
      log('error', 'auth_failed', { reason: 'not_logged_in' });
      await b.close();
      process.exit(1);
    }
    log('info', 'auth_ok');

    const stats = await scrapeCountry(p, COUNTRY, STORE_ID);
    await b.close();
    log('info', 'standalone_done', stats);
  })().catch(e => { log('error', 'fatal', { error: e.message }); process.exit(1); });
}
