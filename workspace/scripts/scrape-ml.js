/**
 * Dropux ML Scraper - Recolecta datos de MercadoLibre Global Selling
 *
 * Recorre 5 países, lee Summary + Help inquiries, guarda en Supabase.
 * Diseñado para ejecutarse via OpenClaw cron cada 4-8 horas.
 *
 * Uso: PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright node /home/node/.openclaw/workspace/scripts/scrape-ml.js
 */

const { chromium } = require('/app/node_modules/playwright-core');

const STORE_ID = 49;
const COUNTRIES = ['Mexico', 'Brazil', 'Argentina', 'Chile', 'Colombia'];
const COUNTRY_CODES = { 'Mexico': 'MX', 'Brazil': 'BR', 'Argentina': 'AR', 'Chile': 'CL', 'Colombia': 'CO' };
const ML_SITE_IDS = { 'Mexico': 'MLM-remote', 'Brazil': 'MLB-remote', 'Argentina': 'MLA-remote', 'Chile': 'MLC-remote', 'Colombia': 'MCO-remote' };
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const BROWSERBASE_KEY = process.env.BROWSERBASE_API_KEY;
const ML_USER = process.env.ML_USER_49;
const ML_PASS = process.env.ML_PASS_49;
const TIMEOUT = 15000;

async function supabasePost(table, data) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal,resolution=merge-duplicates',
      'on-conflict': table === 'ml_support_inquiries'
        ? 'store_id,country,inquiry_number'
        : 'store_id,country,scraped_date'
    },
    body: JSON.stringify(data)
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[DB] Error saving to ${table}:`, err);
  }
  return resp.ok;
}

async function login(page) {
  console.log('[LOGIN] Navigating to ML...');
  await page.goto('https://global-selling.mercadolibre.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Check if already logged in
  const bodyText = await page.innerText('body');
  if (bodyText.includes('Summary') && !bodyText.includes('Fill out your e-mail')) {
    console.log('[LOGIN] Already logged in');
    return true;
  }

  console.log('[LOGIN] Filling email...');
  await page.fill('input[name=user_id]', ML_USER);
  await page.click('button[type=submit]');
  await page.waitForTimeout(5000);

  console.log('[LOGIN] Selecting password...');
  await page.locator('button[aria-labelledby*=password]').first().click();
  await page.waitForTimeout(3000);

  console.log('[LOGIN] Filling password...');
  await page.fill('input[type=password]', ML_PASS);
  await page.click('button[type=submit]');
  await page.waitForTimeout(5000);

  const afterLogin = await page.innerText('body');
  if (afterLogin.includes('Summary') || afterLogin.includes('Add listings')) {
    console.log('[LOGIN] Success');
    return true;
  }

  console.error('[LOGIN] Failed - page content:', afterLogin.substring(0, 200));
  return false;
}

async function switchCountry(page, ctx, country) {
  console.log(`[COUNTRY] Switching to ${country}...`);
  const siteId = ML_SITE_IDS[country];
  try {
    // Set cookies via Playwright context API (not page.evaluate)
    await ctx.addCookies([
      { name: 'cbtSiteId', value: siteId, domain: 'global-selling.mercadolibre.com', path: '/' }
    ]);
    await page.goto('https://global-selling.mercadolibre.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
    const bodyText = await page.innerText('body');
    const countryMatch = bodyText.match(/Country:\s*(\w+)/);
    console.log(`[COUNTRY] Switched to ${country} (page shows: ${countryMatch ? countryMatch[1] : 'unknown'})`);
    return true;
  } catch (e) {
    console.error(`[COUNTRY] Failed to switch to ${country}:`, e.message);
    return false;
  }
}

async function scrapeSummary(page, country) {
  console.log(`[SUMMARY] Reading ${country}...`);
  try {
    await page.goto('https://global-selling.mercadolibre.com', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(3000);

    const text = await page.innerText('body');

    // Extract account status from orange banner
    let accountStatus = 'active';
    let statusReason = '';
    if (text.includes('permanently suspended') || text.includes('permanently disable')) {
      accountStatus = 'suspended';
      const match = text.match(/We (permanently suspended|identified|have repeatedly).*?\./s);
      statusReason = match ? match[0] : 'permanently suspended';
    } else if (text.includes('disabled') || text.includes('will no longer be able to sell')) {
      accountStatus = 'disabled';
      const match = text.match(/Your account is disabled.*?\./s);
      statusReason = match ? match[0] : 'account disabled';
    }

    // Extract reputation
    let reputation = '';
    const repMatch = text.match(/(Green|Yellow|Orange|Red)\s*[✅🟢🟡🟠🔴]?/);
    if (repMatch) reputation = repMatch[1];

    // Extract gross sales
    let grossSales = '';
    const salesMatch = text.match(/US\$\s*[\d,]+/);
    if (salesMatch) grossSales = salesMatch[0];

    // Extract pending tasks
    let pendingQuestions = 0;
    let pendingShipments = 0;
    const qMatch = text.match(/(\d+)\s*to be answered/);
    if (qMatch) pendingQuestions = parseInt(qMatch[1]);
    const sMatch = text.match(/(\d+)\s*to be shipped/);
    if (sMatch) pendingShipments = parseInt(sMatch[1]);

    const data = {
      store_id: STORE_ID,
      country: COUNTRY_CODES[country],
      account_status: accountStatus,
      status_reason: statusReason,
      reputation: reputation,
      gross_sales: grossSales,
      pending_questions: pendingQuestions,
      pending_shipments: pendingShipments,
    };

    console.log(`[SUMMARY] ${country}: status=${accountStatus}, rep=${reputation}, sales=${grossSales}, Q=${pendingQuestions}, S=${pendingShipments}`);
    await supabasePost('ml_account_health', data);
    return data;
  } catch (e) {
    console.error(`[SUMMARY] Error reading ${country}:`, e.message);
    return null;
  }
}

async function getExistingInquiries(country) {
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/ml_support_inquiries?select=inquiry_number,inquiry_status&store_id=eq.${STORE_ID}&country=eq.${COUNTRY_CODES[country]}`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const data = await resp.json();
    const map = {};
    for (const row of data) map[row.inquiry_number] = row.inquiry_status;
    return map;
  } catch (e) {
    return {};
  }
}

async function scrapeInquiries(page, country) {
  console.log(`[INQUIRIES] Reading ${country}...`);
  const existing = await getExistingInquiries(country);
  console.log(`[INQUIRIES] Already in DB: ${Object.keys(existing).length} inquiries`);

  try {
    await page.goto('https://global-selling.mercadolibre.com/help', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(3000);

    // Click "Show all" if present
    try {
      await page.getByText('Show all').click({ timeout: 5000 });
      await page.waitForTimeout(3000);
    } catch (e) {
      // No "Show all" button, might be on the full list already
    }

    const text = await page.innerText('body');

    // Find all inquiry links
    const inquiryLinks = await page.locator('a, button').filter({ hasText: /Go to the inquir/ }).all();
    console.log(`[INQUIRIES] Found ${inquiryLinks.length} inquiries in ${country}`);

    const inquiries = [];
    for (let i = 0; i < inquiryLinks.length; i++) {
      try {
        // Re-navigate to help page (links might be stale after navigation)
        await page.goto('https://global-selling.mercadolibre.com/help', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await page.waitForTimeout(2000);

        try {
          await page.getByText('Show all').click({ timeout: 3000 });
          await page.waitForTimeout(2000);
        } catch (e) {}

        // Click the i-th inquiry
        const links = await page.locator('a, button').filter({ hasText: /Go to the inquir/ }).all();
        if (i >= links.length) break;

        await links[i].click();
        await page.waitForTimeout(3000);

        const queryText = await page.innerText('body');

        // Extract inquiry number
        let inquiryNumber = '';
        const numMatch = queryText.match(/Number\s*(\d+)/);
        if (numMatch) inquiryNumber = numMatch[1];

        // Extract date
        let inquiryDate = '';
        const dateMatch = queryText.match(/Creation date\s*on\s*(.+?\d{4})/);
        if (dateMatch) inquiryDate = dateMatch[1];

        // Extract status
        let inquiryStatus = 'open';
        if (queryText.includes('It ended') || queryText.includes('Completed')) {
          inquiryStatus = 'completed';
        }

        // Extract summary
        let summaryText = '';
        const summaryMatch = queryText.match(/(?:It ended|Completed).*?\n(.+?)(?:\n|Review|Details)/s);
        if (summaryMatch) summaryText = summaryMatch[1].trim();
        if (!summaryText) {
          // Fallback: get text between status and "Review the conversation"
          const fallback = queryText.match(/(?:artificial intelligence)\s*(.+?)(?:Review the conversation|Details)/s);
          if (fallback) summaryText = fallback[1].trim();
        }

        // Try to read conversation
        let conversationText = '';
        try {
          const reviewBtn = page.locator('a, button').filter({ hasText: 'Review the conversation' });
          if (await reviewBtn.count() > 0) {
            await reviewBtn.first().click();
            await page.waitForTimeout(3000);
            conversationText = await page.innerText('body');
            // Clean up navigation elements
            conversationText = conversationText.replace(/Mercado Libre International Selling.*?Conversation\s*/s, '');
            conversationText = conversationText.replace(/Investor relations.*$/s, '');
            conversationText = conversationText.substring(0, 5000); // Limit size
          }
        } catch (e) {
          console.log(`[INQUIRIES] Could not read conversation for inquiry ${i + 1}`);
        }

        if (inquiryNumber) {
          // Skip if already in DB and completed (no changes expected)
          if (existing[inquiryNumber] === 'completed' && inquiryStatus === 'completed') {
            console.log(`[INQUIRIES] Skipping ${inquiryNumber} (already completed in DB)`);
            continue;
          }

          const data = {
            store_id: STORE_ID,
            country: COUNTRY_CODES[country],
            inquiry_number: inquiryNumber,
            inquiry_date: inquiryDate || null,
            inquiry_status: inquiryStatus,
            summary_text: summaryText,
            conversation_text: conversationText,
          };

          await supabasePost('ml_support_inquiries', data);
          inquiries.push(data);
          console.log(`[INQUIRIES] Saved inquiry ${inquiryNumber} (${inquiryStatus}) [${existing[inquiryNumber] ? 'updated' : 'new'}]`);
        }
      } catch (e) {
        console.error(`[INQUIRIES] Error reading inquiry ${i + 1}:`, e.message);
      }
    }

    return inquiries;
  } catch (e) {
    console.error(`[INQUIRIES] Error in ${country}:`, e.message);
    return [];
  }
}

async function main() {
  console.log('=== Dropux ML Scraper ===');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Store: ${STORE_ID}`);

  if (!BROWSERBASE_KEY || !ML_USER || !ML_PASS || !SUPABASE_URL) {
    console.error('Missing required environment variables');
    process.exit(1);
  }

  let browser;
  try {
    browser = await chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${BROWSERBASE_KEY}`);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || await ctx.newPage();

    // Login
    const loggedIn = await login(page);
    if (!loggedIn) {
      console.error('Login failed, aborting');
      await browser.close();
      process.exit(1);
    }

    // Scrape each country
    const results = {};
    for (const country of COUNTRIES) {
      console.log(`\n--- ${country} ---`);

      await switchCountry(page, ctx, country);

      const summary = await scrapeSummary(page, country);
      const inquiries = await scrapeInquiries(page, country);

      results[country] = {
        summary,
        inquiries_count: inquiries.length,
      };
    }

    // Print final summary
    console.log('\n=== RESULTS ===');
    for (const [country, data] of Object.entries(results)) {
      const s = data.summary;
      if (s) {
        console.log(`${country}: ${s.account_status} | Rep: ${s.reputation} | Sales: ${s.gross_sales} | Inquiries: ${data.inquiries_count}`);
      } else {
        console.log(`${country}: ERROR reading summary`);
      }
    }

    await browser.close();
    console.log('\n=== DONE ===');
  } catch (e) {
    console.error('Fatal error:', e.message);
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }
}

main();
