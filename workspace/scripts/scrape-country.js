/**
 * Scraper para UN SOLO país de ML Global Selling
 *
 * Standalone:
 *   PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
 *   node /data/.openclaw/workspace/scripts/scrape-country.js Chile 2>&1
 *
 * Requires BB_CONTEXT_49 env var (created by setup-context.js).
 * Also usable as module: require('./scrape-country.js').scrapeCountry(page, 'Chile', 49)
 */
const { chromium } = require('/app/node_modules/playwright-core');

const COUNTRY_CODES = { Mexico: 'MX', Brazil: 'BR', Argentina: 'AR', Chile: 'CL', Colombia: 'CO' };
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

async function supabaseUpsert(table, data) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal,resolution=merge-duplicates',
    },
    body: JSON.stringify(data),
  });
  if (!resp.ok) console.error(`[DB] Error ${table}: ${await resp.text()}`);
  return resp.ok;
}

/**
 * Scrape a single country. Expects page already logged in to ML Global Selling.
 * @param {import('playwright-core').Page} p - Playwright page (already authenticated)
 * @param {string} country - Country name: Mexico, Brazil, Argentina, Chile, Colombia
 * @param {number} storeId - Store ID (49 or 51)
 */
async function scrapeCountry(p, country, storeId) {
  const code = COUNTRY_CODES[country];
  if (!code) throw new Error(`Unknown country: ${country}`);

  console.log(`\n=== Scrape ${country} (Store ${storeId}) ===`);

  // Switch country via /help/v2
  console.log(`[SWITCH] ${country}...`);
  await p.goto('https://global-selling.mercadolibre.com/help/v2', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await p.waitForTimeout(3000);
  await p.locator('.nav-header-cbt__site-switcher-trigger').first().click({ timeout: 8000 });
  await p.waitForTimeout(2000);
  await p.getByText(country, { exact: true }).first().click({ timeout: 8000 });
  await p.waitForTimeout(4000);
  const headerVal = await p.locator('.nav-header-cbt__site-switcher-value').first().innerText().catch(() => '?');
  console.log(`[SWITCH] Header: ${headerVal}`);

  // Read Summary
  console.log('[SUMMARY]...');
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
  console.log(`[SUMMARY] ${country}: ${accountStatus} — ${statusReason || 'sin problemas'}`);

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  await supabaseUpsert('ml_account_health', {
    store_id: storeId,
    country: code,
    account_status: accountStatus,
    status_reason: statusReason,
    scraped_date: today,
  });

  // Read inquiries
  console.log('[INQUIRIES]...');
  await p.goto('https://global-selling.mercadolibre.com/help/v2', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await p.waitForTimeout(3000);

  try {
    await p.getByText('Show all').click({ timeout: 5000 });
    await p.waitForTimeout(3000);
  } catch (e) {}

  // Collect all hrefs upfront (avoids re-navigation between inquiries)
  const hrefs = await p.locator('a').filter({ hasText: /Go to the inquir|Go to chat/ })
    .evaluateAll(els => els.map(el => el.href).filter(Boolean));
  console.log(`[INQUIRIES] Found ${hrefs.length} inquiry links`);

  for (let i = 0; i < hrefs.length; i++) {
    try {
      await p.goto(hrefs[i], { waitUntil: 'domcontentloaded', timeout: 20000 });
      await p.waitForTimeout(3000);

      const qText = await p.innerText('body');

      let inquiryNumber = '';
      const numMatch = qText.match(/Number\s*\n?\s*(\d+)/);
      if (numMatch) inquiryNumber = numMatch[1];
      if (!inquiryNumber) {
        console.log(`  [${i + 1}] No number found, skipping`);
        continue;
      }

      let inquiryDate = '';
      const dateMatch = qText.match(/Creation date\s*\n?\s*on\s*(.+?\d{4})/);
      if (dateMatch) inquiryDate = dateMatch[1].trim();

      let inquiryStatus = 'open';
      if (qText.includes('It ended') || qText.includes('Completed')) inquiryStatus = 'completed';

      let summaryT = '';
      const sumMatch = qText.match(/(?:Summarized by artificial intelligence)\s*\n?\s*(.*?)(?:\n|Review|Details)/s);
      if (sumMatch) summaryT = sumMatch[1].trim();

      let conversationText = '';
      try {
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
      } catch (e) {}

      await supabaseUpsert('ml_support_inquiries', {
        store_id: storeId,
        country: code,
        inquiry_number: inquiryNumber,
        inquiry_date: inquiryDate || null,
        inquiry_status: inquiryStatus,
        summary_text: summaryT,
        conversation_text: conversationText,
      });

      console.log(`  [${i + 1}] #${inquiryNumber} (${inquiryStatus}) — ${summaryT.substring(0, 60) || 'sin resumen'}`);
    } catch (e) {
      console.error(`  [${i + 1}] Error: ${e.message.split('\n')[0]}`);
    }
  }

  console.log(`=== Done: ${country} ===`);
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
    // Create session with persistent context (no login needed)
    console.log(`[SESSION] Creating with context ${BB_CONTEXT.substring(0, 8)}...`);
    const sessResp = await fetch('https://api.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: { 'x-bb-api-key': BB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: BB_PROJECT,
        browserSettings: {
          solveCaptchas: true,
          context: { id: BB_CONTEXT, persist: true },
        },
        proxies: true,
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

    await scrapeCountry(p, COUNTRY, STORE_ID);
    await b.close();
  })().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}
