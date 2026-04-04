/**
 * Setup Browserbase Context for ML Global Selling
 *
 * Run ONCE to create a persistent context with ML login cookies.
 * After running, save the context_id as BB_CONTEXT_49 env var in Railway.
 *
 * Usage:
 *   PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
 *   node /data/.openclaw/workspace/scripts/setup-context.js 2>&1
 *
 * Re-run when ML login cookies expire (agent will alert via Telegram).
 */
const { chromium } = require('/app/node_modules/playwright-core');

const BB_KEY = process.env.BROWSERBASE_API_KEY;
const BB_PROJECT = process.env.BROWSERBASE_PROJECT_ID;
const ML_USER = process.env.ML_USER_49;
const ML_PASS = process.env.ML_PASS_49;

async function createContext() {
  const resp = await fetch('https://api.browserbase.com/v1/contexts', {
    method: 'POST',
    headers: { 'x-bb-api-key': BB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: BB_PROJECT }),
  });
  if (!resp.ok) throw new Error(`Create context failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.id;
}

async function createSession(contextId) {
  const resp = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'x-bb-api-key': BB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: BB_PROJECT,
      browserSettings: {
        solveCaptchas: true,
        context: { id: contextId, persist: true },
      },
      proxies: true,
    }),
  });
  if (!resp.ok) throw new Error(`Create session failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

(async () => {
  // Step 1: Create context
  console.log('[1] Creating Browserbase context...');
  const contextId = await createContext();
  console.log(`[1] Context ID: ${contextId}`);

  // Step 2: Create session with context + captcha solving
  console.log('[2] Creating session with solveCaptchas + proxies...');
  const sess = await createSession(contextId);
  console.log(`[2] Session ID: ${sess.id}`);

  // Step 3: Connect and login
  const b = await chromium.connectOverCDP(sess.connectUrl);
  const ctx = b.contexts()[0];
  const p = ctx.pages()[0] || await ctx.newPage();

  p.on('console', msg => {
    if (msg.text().includes('browserbase-solving')) console.log('[CAPTCHA]', msg.text());
  });

  // Email step
  console.log('[3] Navigating to ML Global Selling...');
  await p.goto('https://global-selling.mercadolibre.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(3000);
  await p.fill('input[name=user_id]', ML_USER);
  await p.click('button[type=submit]');
  console.log('[3] Email submitted, waiting up to 40s for captcha...');
  await p.waitForTimeout(40000);

  // Password step
  const afterEmail = await p.innerText('body');
  if (afterEmail.includes('Complete the reCAPTCHA')) {
    console.error('[FAIL] First captcha NOT solved. Try again or solve manually.');
    await b.close();
    process.exit(1);
  }

  console.log('[4] Selecting password method...');
  await p.locator('button[aria-labelledby*=password]').first().click({ timeout: 10000 });
  await p.waitForTimeout(3000);
  await p.fill('input[type=password]', ML_PASS);
  await p.click('button[type=submit]');
  console.log('[4] Password submitted, waiting up to 40s for 2nd captcha...');
  await p.waitForTimeout(40000);

  // Verify login
  const result = await p.innerText('body');
  if (result.includes('Summary') || result.includes('Add listings')) {
    console.log('[5] LOGIN SUCCESS');
  } else {
    console.error('[5] LOGIN FAILED — page:', result.substring(0, 300));
    console.log('\n[INFO] Context was still created. You can try logging in manually');
    console.log('[INFO] via Browserbase dashboard using this session, then cookies will persist.');
  }

  // Step 4: Close — cookies persist to context
  await b.close();
  console.log('[6] Session closed. Cookies saved to context.');

  // Output
  console.log('\n========================================');
  console.log(`CONTEXT_ID: ${contextId}`);
  console.log('========================================');
  console.log('\nAdd to Railway env vars:');
  console.log(`  BB_CONTEXT_49=${contextId}`);
  console.log('\nTo verify, create a new session with this context and check if login persists.');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
