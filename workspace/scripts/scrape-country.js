/**
 * Scraper para UN SOLO país de ML
 * Uso: PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright node /home/node/.openclaw/workspace/scripts/scrape-country.js Colombia 2>&1
 */
const { chromium } = require('/app/node_modules/playwright-core');

const STORE_ID = 49;
const COUNTRY_CODES = { Mexico: 'MX', Brazil: 'BR', Argentina: 'AR', Chile: 'CL', Colombia: 'CO' };
const BB_KEY = process.env.BROWSERBASE_API_KEY;
const ML_USER = process.env.ML_USER_49;
const ML_PASS = process.env.ML_PASS_49;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const COUNTRY = process.argv[2] || 'Colombia';

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

(async () => {
  console.log(`=== Scrape ${COUNTRY} (Store ${STORE_ID}) ===`);

  const b = await chromium.connectOverCDP('wss://connect.browserbase.com?apiKey=' + BB_KEY);
  const ctx = b.contexts()[0];
  const p = ctx.pages()[0] || await ctx.newPage();

  // Login
  console.log('[LOGIN]...');
  await p.goto('https://global-selling.mercadolibre.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(3000);
  await p.fill('input[name=user_id]', ML_USER);
  await p.click('button[type=submit]');
  await p.waitForTimeout(5000);
  await p.locator('button[aria-labelledby*=password]').first().click();
  await p.waitForTimeout(3000);
  await p.fill('input[type=password]', ML_PASS);
  await p.click('button[type=submit]');
  await p.waitForTimeout(5000);

  const loginText = await p.innerText('body');
  if (!loginText.includes('Summary') && !loginText.includes('Add listings')) {
    console.error('[LOGIN] Failed');
    await b.close();
    process.exit(1);
  }
  console.log('[LOGIN] OK');

  // Cambiar a país desde /help/v2
  console.log(`[SWITCH] ${COUNTRY}...`);
  await p.goto('https://global-selling.mercadolibre.com/help/v2', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await p.waitForTimeout(3000);
  await p.locator('.nav-header-cbt__site-switcher-trigger').first().click({ timeout: 8000 });
  await p.waitForTimeout(2000);
  await p.getByText(COUNTRY, { exact: true }).first().click({ timeout: 8000 });
  await p.waitForTimeout(4000);
  const headerVal = await p.locator('.nav-header-cbt__site-switcher-value').first().innerText().catch(() => '?');
  console.log(`[SWITCH] Header: ${headerVal}`);

  // Leer Summary
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
  console.log(`[SUMMARY] ${COUNTRY}: ${accountStatus} — ${statusReason || 'sin problemas'}`);

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  await supabaseUpsert('ml_account_health', {
    store_id: STORE_ID,
    country: COUNTRY_CODES[COUNTRY],
    account_status: accountStatus,
    status_reason: statusReason,
    scraped_date: today,
  });

  // Ir a Help y leer TODOS los inquiries
  console.log('[INQUIRIES]...');
  await p.goto('https://global-selling.mercadolibre.com/help/v2', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await p.waitForTimeout(3000);

  // Show all
  try {
    await p.getByText('Show all').click({ timeout: 5000 });
    await p.waitForTimeout(3000);
  } catch (e) {}

  // Contar inquiries
  const links = await p.locator('a, button').filter({ hasText: /Go to the inquir|Go to chat/ }).all();
  console.log(`[INQUIRIES] Found ${links.length}`);

  for (let i = 0; i < links.length; i++) {
    try {
      // Re-navegar para evitar stale
      await p.goto('https://global-selling.mercadolibre.com/help/v2', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await p.waitForTimeout(2000);
      try { await p.getByText('Show all').click({ timeout: 3000 }); await p.waitForTimeout(2000); } catch (e) {}

      const currentLinks = await p.locator('a, button').filter({ hasText: /Go to the inquir|Go to chat/ }).all();
      if (i >= currentLinks.length) break;

      await currentLinks[i].click();
      await p.waitForTimeout(3000);

      const qText = await p.innerText('body');

      // Numero
      let inquiryNumber = '';
      const numMatch = qText.match(/Number\s*\n?\s*(\d+)/);
      if (numMatch) inquiryNumber = numMatch[1];
      if (!inquiryNumber) {
        console.log(`  [${i + 1}] No number found, skipping`);
        continue;
      }

      // Fecha
      let inquiryDate = '';
      const dateMatch = qText.match(/Creation date\s*\n?\s*on\s*(.+?\d{4})/);
      if (dateMatch) inquiryDate = dateMatch[1].trim();

      // Status
      let inquiryStatus = 'open';
      if (qText.includes('It ended') || qText.includes('Completed')) inquiryStatus = 'completed';

      // Resumen
      let summaryT = '';
      const sumMatch = qText.match(/(?:Summarized by artificial intelligence)\s*\n?\s*(.*?)(?:\n|Review|Details)/s);
      if (sumMatch) summaryT = sumMatch[1].trim();

      // Leer conversacion completa
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
        store_id: STORE_ID,
        country: COUNTRY_CODES[COUNTRY],
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

  await b.close();
  console.log(`\n=== Done: ${COUNTRY} ===`);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
