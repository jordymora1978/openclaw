/**
 * Explore ANVISA website to discover internal API endpoints.
 * Opens consultas.anvisa.gov.br with Browserbase, intercepts all
 * network requests, searches for an ingredient, and logs the APIs found.
 *
 * Usage: node explore-anvisa.js [ingredient]
 * Default ingredient: melatonina
 */
const { chromium } = require('/app/node_modules/playwright-core');

const BB_KEY = process.env.BROWSERBASE_API_KEY;
const BB_PROJECT = process.env.BROWSERBASE_PROJECT_ID;

const ingredient = process.argv[2] || 'melatonina';

function log(level, action, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, action, ...data }));
}

(async () => {
  log('info', 'start', { ingredient });

  // Create Browserbase session with Brazil proxy
  const sessResp = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'x-bb-api-key': BB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: BB_PROJECT,
      region: 'us-east-1',
      timeout: 300,
      proxies: [{ type: 'browserbase', geolocation: { country: 'BR' } }],
    }),
  });
  const sess = await sessResp.json();
  if (!sess.connectUrl) {
    log('error', 'session_failed', { response: JSON.stringify(sess).substring(0, 200) });
    process.exit(1);
  }
  log('info', 'session_created', { id: sess.id });

  const browser = await chromium.connectOverCDP(sess.connectUrl);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();

  // Capture ALL network requests
  const apiCalls = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('anvisa') && (url.includes('api') || url.includes('consulta'))) {
      apiCalls.push({
        method: req.method(),
        url: url,
        headers: req.headers(),
        postData: req.postData() || null,
      });
      log('info', 'api_request', { method: req.method(), url: url.substring(0, 150) });
    }
  });

  page.on('response', async resp => {
    const url = resp.url();
    if (url.includes('anvisa') && (url.includes('api') || url.includes('consulta'))) {
      try {
        const status = resp.status();
        const contentType = resp.headers()['content-type'] || '';
        let body = '';
        if (contentType.includes('json')) {
          body = await resp.text();
          if (body.length > 2000) body = body.substring(0, 2000) + '...[truncated]';
        }
        log('info', 'api_response', {
          status,
          url: url.substring(0, 150),
          contentType: contentType.substring(0, 50),
          bodyPreview: body.substring(0, 500),
        });
      } catch {}
    }
  });

  // Navigate to ANVISA consultas
  log('info', 'navigating', { url: 'https://consultas.anvisa.gov.br/#/alimentos/' });
  try {
    await page.goto('https://consultas.anvisa.gov.br/#/alimentos/', {
      waitUntil: 'networkidle',
      timeout: 30000
    });
  } catch (e) {
    log('warn', 'navigation_timeout', { error: e.message.split('\n')[0] });
  }
  await page.waitForTimeout(5000);

  // Take screenshot of initial page
  log('info', 'page_loaded', { title: await page.title() });

  // Log what we see on the page
  const pageText = await page.innerText('body').catch(() => '');
  log('info', 'page_content', {
    length: pageText.length,
    preview: pageText.substring(0, 500).replace(/\n/g, ' '),
  });

  // Look for search inputs
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input, select, textarea')).map(el => ({
      tag: el.tagName,
      type: el.type,
      name: el.name,
      id: el.id,
      placeholder: el.placeholder,
      class: el.className.substring(0, 50),
    }));
  });
  log('info', 'form_elements', { count: inputs.length, inputs });

  // Look for buttons
  const buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, [role="button"], a.btn')).map(el => ({
      tag: el.tagName,
      text: el.textContent.trim().substring(0, 50),
      class: el.className.substring(0, 50),
    }));
  });
  log('info', 'buttons', { count: buttons.length, buttons: buttons.slice(0, 10) });

  // Try to search for the ingredient
  log('info', 'searching', { ingredient });

  // Try different search strategies
  // Strategy 1: Look for text input and type
  const searchInput = await page.$('input[type="text"], input[type="search"], input[placeholder*="busca"], input[placeholder*="pesquis"], input[name*="nome"], input[name*="produto"]');
  if (searchInput) {
    await searchInput.fill(ingredient);
    log('info', 'filled_input');

    // Look for search/submit button
    const searchBtn = await page.$('button[type="submit"], button:has-text("Pesquisar"), button:has-text("Buscar"), button:has-text("Consultar")');
    if (searchBtn) {
      await searchBtn.click();
      log('info', 'clicked_search');
    } else {
      await searchInput.press('Enter');
      log('info', 'pressed_enter');
    }

    await page.waitForTimeout(8000);

    // Check results
    const resultsText = await page.innerText('body').catch(() => '');
    log('info', 'results', {
      length: resultsText.length,
      preview: resultsText.substring(0, 1000).replace(/\n/g, ' '),
    });
  } else {
    log('warn', 'no_search_input', {
      msg: 'Could not find search input, trying alternate selectors'
    });

    // Try clicking on menu items or tabs
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a, li, [ng-click], [click]')).slice(0, 20).map(el => ({
        tag: el.tagName,
        text: el.textContent.trim().substring(0, 80),
        href: el.href || '',
        class: el.className.substring(0, 50),
      }));
    });
    log('info', 'clickable_elements', { elements: links });
  }

  // Summary of all API calls captured
  log('info', 'summary', {
    total_api_calls: apiCalls.length,
    unique_endpoints: [...new Set(apiCalls.map(c => c.url.split('?')[0]))],
    calls: apiCalls.map(c => ({ method: c.method, url: c.url.substring(0, 200), hasBody: !!c.postData })),
  });

  await browser.close();
  log('info', 'done');
})().catch(e => { log('error', 'fatal', { error: e.message }); process.exit(1); });
