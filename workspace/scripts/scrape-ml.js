/**
 * Dropux ML Scraper - Recolecta datos de soporte y reputación de MercadoLibre
 *
 * Usa Browserbase Contexts para mantener sesión de ML persistente.
 * Primera corrida: crea contexto + login. Siguientes: reutiliza contexto (sin login).
 *
 * Recolecta SOLO:
 * - Estado de cuenta y métricas de reputación por país
 * - Inquiries de soporte con conversaciones
 *
 * Uso: PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright node /home/node/.openclaw/workspace/scripts/scrape-ml.js
 */

const { chromium } = require('/app/node_modules/playwright-core');

// ─── Config ────────────────────────────────────────────
const STORE_ID = 49;
const COUNTRIES = ['Mexico', 'Brazil', 'Argentina', 'Chile', 'Colombia'];
const COUNTRY_CODES = { Mexico: 'MX', Brazil: 'BR', Argentina: 'AR', Chile: 'CL', Colombia: 'CO' };
const ML_SITE_IDS = { Mexico: 'MLM-remote', Brazil: 'MLB-remote', Argentina: 'MLA-remote', Chile: 'MLC-remote', Colombia: 'MCO-remote' };

const BB_KEY = process.env.BROWSERBASE_API_KEY;
const ML_USER = process.env.ML_USER_49;
const ML_PASS = process.env.ML_PASS_49;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

// ─── Supabase ──────────────────────────────────────────
async function supabaseUpsert(table, data, conflictCols) {
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
  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[DB] Error in ${table}: ${err}`);
    return false;
  }
  return true;
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

// ─── Login ─────────────────────────────────────────────
async function loginIfNeeded(page) {
  await page.goto('https://global-selling.mercadolibre.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const text = await page.innerText('body');
  if (text.includes('Summary') || text.includes('Add listings')) {
    console.log('[LOGIN] Already logged in (context has session)');
    return true;
  }

  if (!text.includes('Fill out your e-mail') && !text.includes('log in')) {
    console.log('[LOGIN] Unknown page state, trying to continue...');
    return true;
  }

  console.log('[LOGIN] Need to login...');
  await page.fill('input[name=user_id]', ML_USER);
  await page.click('button[type=submit]');
  await page.waitForTimeout(5000);

  // Verificar si pide método de verificación
  const afterEmail = await page.innerText('body');
  if (afterEmail.includes('Password') || afterEmail.includes('verification')) {
    await page.locator('button[aria-labelledby*=password]').first().click({ timeout: 10000 });
    await page.waitForTimeout(3000);
    await page.fill('input[type=password]', ML_PASS);
    await page.click('button[type=submit]');
    await page.waitForTimeout(5000);
  }

  const afterLogin = await page.innerText('body');
  if (afterLogin.includes('Summary') || afterLogin.includes('Add listings')) {
    console.log('[LOGIN] Success');
    return true;
  }

  console.error('[LOGIN] Failed:', afterLogin.substring(0, 200));
  return false;
}

// ─── Cambio de País ────────────────────────────────────
async function switchCountry(page, country) {
  console.log(`[COUNTRY] Switching to ${country}...`);
  try {
    // Click header site switcher
    await page.locator('.nav-header-cbt__site-switcher-trigger').first().click({ timeout: 5000 });
    await page.waitForTimeout(1000);
    // Click option by data-value
    await page.locator(`[data-value="${ML_SITE_IDS[country]}"]`).first().click({ timeout: 5000 });
    await page.waitForTimeout(4000);

    const bodyText = await page.innerText('body');
    const match = bodyText.match(/Country:\s*(\w+)/);
    console.log(`[COUNTRY] Now on: ${match ? match[1] : 'unknown'}`);
    return true;
  } catch (e) {
    console.error(`[COUNTRY] Failed: ${e.message}`);
    return false;
  }
}

// ─── Scrape Summary (reputación + estado) ──────────────
async function scrapeSummary(page, country) {
  console.log(`[SUMMARY] Reading ${country}...`);
  try {
    const text = await page.innerText('body');

    // Estado de cuenta
    let accountStatus = 'active';
    let statusReason = '';
    if (text.includes('permanently suspended') || text.includes('permanently disable')) {
      accountStatus = 'suspended';
      const m = text.match(/(We permanently suspended.*?\.)/s) || text.match(/(Your listings have repeatedly.*?\.)/s);
      statusReason = m ? m[1] : 'suspended';
    } else if (text.includes('disabled') || text.includes('will no longer be able to sell')) {
      accountStatus = 'disabled';
      const m = text.match(/(Your account is disabled.*?\.)/s);
      statusReason = m ? m[1] : 'disabled';
    }

    // Reputación
    let reputation = '';
    const repMatch = text.match(/(Green|Yellow|Orange|Red)/);
    if (repMatch) reputation = repMatch[1];

    // Ventas
    let grossSales = '';
    const salesMatch = text.match(/US\$\s*[\d,]+/);
    if (salesMatch) grossSales = salesMatch[0];

    // Métricas de reputación (si están visibles en Summary)
    let complaints = '', mediations = '', cancelled = '', delayed = '';
    const compMatch = text.match(/Complaints[\s\S]*?([\d.]+%)/);
    if (compMatch) complaints = compMatch[1];
    const medMatch = text.match(/Mediations[\s\S]*?([\d.]+%)/);
    if (medMatch) mediations = medMatch[1];
    const canMatch = text.match(/Canceled by you[\s\S]*?([\d.]+%)/);
    if (canMatch) cancelled = canMatch[1];
    const delMatch = text.match(/Delayed handling[\s\S]*?([\d.]+%)/);
    if (delMatch) delayed = delMatch[1];

    const data = {
      store_id: STORE_ID,
      country: COUNTRY_CODES[country],
      account_status: accountStatus,
      status_reason: statusReason,
      reputation,
      gross_sales: grossSales,
    };

    console.log(`[SUMMARY] ${country}: ${accountStatus} | rep=${reputation} | sales=${grossSales}`);
    if (complaints) console.log(`[SUMMARY] Complaints=${complaints} Med=${mediations} Cancel=${cancelled} Delayed=${delayed}`);

    await supabaseUpsert('ml_account_health', data);
    return data;
  } catch (e) {
    console.error(`[SUMMARY] Error: ${e.message}`);
    return null;
  }
}

// ─── Scrape Inquiries ──────────────────────────────────
async function scrapeInquiries(page, country) {
  console.log(`[INQUIRIES] Reading ${country}...`);
  const existing = await getExistingInquiries(country);
  console.log(`[INQUIRIES] Already in DB: ${Object.keys(existing).length}`);

  try {
    await page.goto('https://global-selling.mercadolibre.com/help', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    // Show all
    try {
      await page.getByText('Show all').click({ timeout: 5000 });
      await page.waitForTimeout(3000);
    } catch (e) {}

    // Contar inquiries
    const links = await page.locator('a, button').filter({ hasText: /Go to the inquir/ }).all();
    console.log(`[INQUIRIES] Found ${links.length} on page`);

    const saved = [];
    for (let i = 0; i < links.length; i++) {
      try {
        // Re-navegar para evitar stale elements
        await page.goto('https://global-selling.mercadolibre.com/help', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2000);
        try { await page.getByText('Show all').click({ timeout: 3000 }); await page.waitForTimeout(2000); } catch (e) {}

        const currentLinks = await page.locator('a, button').filter({ hasText: /Go to the inquir/ }).all();
        if (i >= currentLinks.length) break;

        await currentLinks[i].click();
        await page.waitForTimeout(3000);

        const qText = await page.innerText('body');

        // Número de inquiry
        let inquiryNumber = '';
        const numMatch = qText.match(/Number\s*\n?\s*(\d+)/);
        if (numMatch) inquiryNumber = numMatch[1];

        if (!inquiryNumber) {
          console.log(`[INQUIRIES] No number found for inquiry ${i + 1}, skipping`);
          continue;
        }

        // Skip si ya completado en DB
        if (existing[inquiryNumber] === 'completed') {
          console.log(`[INQUIRIES] Skip ${inquiryNumber} (completed)`);
          continue;
        }

        // Fecha
        let inquiryDate = '';
        const dateMatch = qText.match(/Creation date\s*\n?\s*on\s*(.+?\d{4})/);
        if (dateMatch) inquiryDate = dateMatch[1].trim();

        // Status
        let inquiryStatus = 'open';
        if (qText.includes('It ended') || qText.includes('Completed')) inquiryStatus = 'completed';

        // Resumen (del AI)
        let summaryText = '';
        const sumMatch = qText.match(/(?:Summarized by artificial intelligence)\s*\n?\s*(.*?)(?:\n|Review the conversation|Details)/s);
        if (sumMatch) summaryText = sumMatch[1].trim();

        // Leer conversación
        let conversationText = '';
        try {
          const reviewBtn = page.locator('a, button').filter({ hasText: 'Review the conversation' });
          if (await reviewBtn.count() > 0) {
            await reviewBtn.first().click();
            await page.waitForTimeout(4000);
            const convPage = await page.innerText('body');
            // Limpiar header/footer
            conversationText = convPage
              .replace(/^[\s\S]*?Conversation\s*/m, '')
              .replace(/Investor relations[\s\S]*$/, '')
              .substring(0, 8000);
          }
        } catch (e) {
          console.log(`[INQUIRIES] Could not read conversation for ${inquiryNumber}`);
        }

        await supabaseUpsert('ml_support_inquiries', {
          store_id: STORE_ID,
          country: COUNTRY_CODES[country],
          inquiry_number: inquiryNumber,
          inquiry_date: inquiryDate || null,
          inquiry_status: inquiryStatus,
          summary_text: summaryText,
          conversation_text: conversationText,
        });

        saved.push(inquiryNumber);
        console.log(`[INQUIRIES] Saved ${inquiryNumber} (${inquiryStatus}) [${existing[inquiryNumber] ? 'updated' : 'new'}]`);

      } catch (e) {
        console.error(`[INQUIRIES] Error on inquiry ${i + 1}: ${e.message}`);
      }
    }

    return saved;
  } catch (e) {
    console.error(`[INQUIRIES] Error: ${e.message}`);
    return [];
  }
}

// ─── Main ──────────────────────────────────────────────
async function main() {
  console.log('=== Dropux ML Scraper ===');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Store: ${STORE_ID}`);

  // Validar variables
  const missing = [];
  if (!BB_KEY) missing.push('BROWSERBASE_API_KEY');
  if (!ML_USER) missing.push('ML_USER_49');
  if (!ML_PASS) missing.push('ML_PASS_49');
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_KEY) missing.push('SUPABASE_ANON_KEY');
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  let browser;
  try {
    // Conexión directa a Browserbase (resuelve captcha automáticamente)
    console.log('[BB] Connecting...');
    browser = await chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${BB_KEY}`);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || await ctx.newPage();

    // Login (solo si el contexto no tiene sesión)
    const loggedIn = await loginIfNeeded(page);
    if (!loggedIn) {
      console.error('[FATAL] Login failed');
      await browser.close();
      process.exit(1);
    }

    // Recorrer países
    const results = {};
    for (let c = 0; c < COUNTRIES.length; c++) {
      const country = COUNTRIES[c];
      console.log(`\n--- ${country} (${c + 1}/${COUNTRIES.length}) ---`);

      // Primer país no necesita switch (ya está en el default)
      if (c > 0) {
        const switched = await switchCountry(page, country);
        if (!switched) {
          console.error(`[SKIP] Could not switch to ${country}`);
          results[country] = { error: 'switch failed' };
          continue;
        }
      } else {
        // Para el primer país, navegar a Summary
        await page.goto('https://global-selling.mercadolibre.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
      }

      const summary = await scrapeSummary(page, country);
      const inquiries = await scrapeInquiries(page, country);

      results[country] = { summary, inquiries_saved: inquiries.length };
    }

    // Resumen final
    console.log('\n=== RESULTS ===');
    for (const [country, data] of Object.entries(results)) {
      if (data.error) {
        console.log(`${country}: ERROR - ${data.error}`);
      } else {
        const s = data.summary;
        console.log(`${country}: ${s?.account_status || '?'} | rep=${s?.reputation || '?'} | inquiries=${data.inquiries_saved}`);
      }
    }

    await browser.close();
    console.log('\n=== DONE ===');
  } catch (e) {
    console.error(`[FATAL] ${e.message}`);
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }
}

main();
