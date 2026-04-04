/**
 * Setup Browserbase Context for ML Global Selling
 *
 * Creates a persistent context, automates email step, then provides a
 * Live View URL for manual captcha solving if needed.
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
      browserSettings: {
        solveCaptchas: true,
        context: { id: contextId, persist: true },
      },
      proxies: true,
      keepAlive: true,
    }),
  });
  if (!resp.ok) throw new Error(`Create session failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function getDebugUrl(sessionId) {
  const resp = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/debug`, {
    headers: { 'x-bb-api-key': BB_KEY },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.debuggerFullscreenUrl;
}

(async () => {
  // Step 1: Create context
  console.log('[1] Creating Browserbase context...');
  const contextId = await createContext();
  console.log(`[1] Context ID: ${contextId}`);

  // Step 2: Create session with context + captcha solving + keepAlive
  console.log('[2] Creating session...');
  const sess = await createSession(contextId);
  console.log(`[2] Session ID: ${sess.id}`);

  // Get Live View URL for manual intervention
  const debugUrl = await getDebugUrl(sess.id);
  if (debugUrl) {
    console.log('\n=== LIVE VIEW (open in browser if captcha needs manual solving) ===');
    console.log(debugUrl);
    console.log('===================================================================\n');
  }

  // Step 3: Connect
  const b = await chromium.connectOverCDP(sess.connectUrl);
  const ctx = b.contexts()[0];
  const p = ctx.pages()[0] || await ctx.newPage();

  p.on('console', msg => {
    if (msg.text().includes('browserbase-solving')) console.log('[CAPTCHA]', msg.text());
  });

  // Step 4: Automate email step
  console.log('[3] Navigating to ML Global Selling...');
  await p.goto('https://global-selling.mercadolibre.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(3000);
  await p.fill('input[name=user_id]', ML_USER);
  await p.click('button[type=submit]');
  console.log('[3] Email submitted, waiting 40s for captcha auto-solve...');
  await p.waitForTimeout(40000);

  // Check if first captcha was solved
  const afterEmail = await p.innerText('body');
  if (afterEmail.includes('Complete the reCAPTCHA')) {
    console.log('[!] First captcha NOT auto-solved. Use Live View URL above to solve manually.');
    console.log('[!] Waiting up to 120s for manual solve...');
    // Poll for captcha resolution
    for (let i = 0; i < 24; i++) {
      await p.waitForTimeout(5000);
      const t = await p.innerText('body');
      if (!t.includes('Complete the reCAPTCHA') && !t.includes('Fill out your e-mail')) break;
      if (i % 4 === 3) console.log(`[!] Still waiting... (${(i + 1) * 5}s)`);
    }
  }

  // Step 5: Password step
  const prePwd = await p.innerText('body');
  if (prePwd.includes('Password') && prePwd.includes('Choose a verification')) {
    console.log('[4] Selecting password method...');
    await p.locator('button[aria-labelledby*=password]').first().click({ timeout: 10000 });
    await p.waitForTimeout(3000);
    await p.fill('input[type=password]', ML_PASS);
    await p.click('button[type=submit]');
    console.log('[4] Password submitted...');
    await p.waitForTimeout(5000);

    // Check for second captcha
    const afterPwd = await p.innerText('body');
    if (afterPwd.includes('Complete the reCAPTCHA')) {
      console.log('[!] Second captcha detected. Use Live View URL above to solve manually.');
      console.log('[!] Waiting up to 120s for manual solve...');
      for (let i = 0; i < 24; i++) {
        await p.waitForTimeout(5000);
        const t = await p.innerText('body');
        if (t.includes('Summary') || t.includes('Add listings')) break;
        if (!t.includes('Complete the reCAPTCHA') && !t.includes('Enter your password')) break;
        if (i % 4 === 3) console.log(`[!] Still waiting... (${(i + 1) * 5}s)`);
      }
    }
  }

  // Step 6: Verify login
  await p.waitForTimeout(3000);
  const result = await p.innerText('body');
  if (result.includes('Summary') || result.includes('Add listings')) {
    console.log('[5] LOGIN SUCCESS');
  } else {
    console.log('[5] Login not detected yet. Page:', result.substring(0, 200));
    console.log('[!] If you solved captcha in Live View, the page may need a refresh.');
    console.log('[!] Session stays alive (keepAlive). Cookies will save when you close it.');
  }

  // Step 7: Close — cookies persist to context
  await b.close();
  console.log('[6] Session closed. Cookies saved to context.');

  console.log('\n========================================');
  console.log(`CONTEXT_ID: ${contextId}`);
  console.log('========================================');
  console.log('\nAdd to Railway env vars:');
  console.log(`  BB_CONTEXT_49=${contextId}`);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
