/**
 * Setup Browserbase Context for ML Global Selling
 *
 * Creates a persistent context and logs in automatically.
 * Uses us-east-1 region + solveCaptchas (no proxy).
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
  return (await resp.json()).id;
}

async function createSession(contextId) {
  const resp = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'x-bb-api-key': BB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: BB_PROJECT,
      region: 'us-east-1',
      browserSettings: {
        solveCaptchas: true,
        context: { id: contextId, persist: true },
      },
    }),
  });
  if (!resp.ok) throw new Error(`Create session failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

(async () => {
  console.log('[1] Creating Browserbase context...');
  const contextId = await createContext();
  console.log(`[1] Context ID: ${contextId}`);

  console.log('[2] Creating session (us-east-1, solveCaptchas)...');
  const sess = await createSession(contextId);
  console.log(`[2] Session ID: ${sess.id}`);

  const b = await chromium.connectOverCDP(sess.connectUrl);
  const ctx = b.contexts()[0];
  const p = ctx.pages()[0] || await ctx.newPage();

  p.on('console', msg => {
    if (msg.text().includes('browserbase-solving')) console.log('[CAPTCHA]', msg.text());
  });

  // Email
  console.log('[3] Login — email...');
  await p.goto('https://global-selling.mercadolibre.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(3000);
  await p.fill('input[name=user_id]', ML_USER);
  await p.click('button[type=submit]');
  await p.waitForTimeout(10000);

  // Password
  console.log('[4] Login — password...');
  await p.locator('button[aria-labelledby*=password]').first().click({ timeout: 15000 });
  await p.waitForTimeout(3000);
  await p.fill('input[type=password]', ML_PASS);
  await p.click('button[type=submit]');
  await p.waitForTimeout(10000);

  // Verify
  const result = await p.innerText('body');
  if (result.includes('Summary') || result.includes('Add listings')) {
    console.log('[5] LOGIN SUCCESS');
  } else {
    console.error('[5] LOGIN FAILED:', result.substring(0, 200));
    await b.close();
    process.exit(1);
  }

  await b.close();
  console.log('[6] Session closed. Cookies saved to context.');

  console.log('\n========================================');
  console.log(`CONTEXT_ID: ${contextId}`);
  console.log('========================================');
  console.log(`\nAdd to Railway env vars:\n  BB_CONTEXT_49=${contextId}`);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
