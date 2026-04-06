// content/vps-panel.js — Content script for VPS panel (steps 1, 9)
// Injected on: VPS panel (user-configured URL)
//
// Supported page layouts for Step 1:
//
// 1. Codex VPS Panel (default):
//    Page starts at #/inlineLogin, auto-redirects or shows "Codex OAuth" card
//    with a Login button that generates the OAuth URL.
//
// 2. CPA Panel (URL contains #/oauth or ?cpa=true):
//    Has explicit nav item: <a class="nav-item" href="#/oauth">OAuth 登录</a>
//    Clicking it navigates to the OAuth page where the auth URL is shown directly.
//
// DOM for Codex VPS panel (after inlineLogin click):
// <div class="card">
//   <div class="card-header">
//     <span class="OAuthPage-module__cardTitle___yFaP0">Codex OAuth</span>
//     <button class="btn btn-primary"><span>登录</span></button>
//   </div>
//   <div class="OAuthPage-module__cardContent___1sXLA">
//     <div class="OAuthPage-module__authUrlBox___Iu1d4">
//       <div class="OAuthPage-module__authUrlLabel___mYFJB">授权链接:</div>
//       <div class="OAuthPage-module__authUrlValue___axvUJ">https://auth.openai.com/...</div>
//       <div class="OAuthPage-module__authUrlActions___venPj">
//         <button class="btn btn-secondary btn-sm"><span>复制链接</span></button>
//         <button class="btn btn-secondary btn-sm"><span>打开链接</span></button>
//       </div>
//     </div>
//     <div class="OAuthPage-module__callbackSection___8kA31">
//       <input class="input" placeholder="http://localhost:1455/auth/callback?code=...&state=...">
//       <button class="btn btn-secondary btn-sm"><span>提交回调 URL</span></button>
//     </div>
//   </div>
// </div>

// ── Defensive inline utilities (guaranteed available even if utils.js fails) ──
if (typeof console.inlineLog !== 'function') {
  console.inlineLog = (...args) => console.log(...args);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sleepRandom(minMs, maxMs) {
  const lower = Math.max(0, Math.min(minMs, maxMs));
  const upper = Math.max(minMs, maxMs);
  const delay = lower + Math.floor(Math.random() * (upper - lower + 1));
  return sleep(delay);
}
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(selector);
    if (existing) { resolve(existing); return; }
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { observer.disconnect(); clearTimeout(timer); resolve(el); }
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Timeout: ' + selector)); }, timeout);
  });
}
function waitForElementByText(containerSelector, textPattern, timeout = 10000) {
  return new Promise((resolve, reject) => {
    function search() {
      const candidates = document.querySelectorAll(containerSelector);
      for (const el of candidates) { if (textPattern.test(el.textContent)) return el; }
      return null;
    }
    const existing = search();
    if (existing) { resolve(existing); return; }
    const observer = new MutationObserver(() => {
      const el = search();
      if (el) { observer.disconnect(); clearTimeout(timer); resolve(el); }
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Timeout text: ' + textPattern)); }, timeout);
  });
}
function fillInput(el, value) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nativeSetter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function simulateClick(el) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}
function debugLog(...args) {
  console.log(...args);
}
function inlineLog(msg, level) {
  debugLog('[vps-panel:inlineLog]', msg);
  chrome.runtime.sendMessage({ type: 'LOG', source: 'vps-panel', step: null, payload: { message: msg, level: level || 'info', timestamp: Date.now() }, error: null }).catch(() => {});
}
function inlineReportReady() {
  chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', source: 'vps-panel', step: null, payload: {}, error: null }).catch(() => {});
}
function inlineReportComplete(step, data) {
  debugLog('[vps-panel]', 'Step', step, 'complete', data);
  chrome.runtime.sendMessage({ type: 'STEP_COMPLETE', source: 'vps-panel', step, payload: data || {}, error: null }).catch(() => {});
}
function inlineReportError(step, msg) {
  console.error('[vps-panel]', 'Step', step, 'error:', msg);
  chrome.runtime.sendMessage({ type: 'STEP_ERROR', source: 'vps-panel', step, payload: {}, error: msg }).catch(() => {});
}

debugLog('[MultiPage:vps-panel] Content script loaded on', location.href);

// Verify utils.js loaded correctly
if (typeof sleep !== 'function' || typeof sleepRandom !== 'function') {
  console.error('[vps-panel] FATAL: utils.js did not define sleep/sleepRandom! Utils not loaded properly.');
  console.error('[vps-panel] typeof sleep =', typeof sleep, 'typeof sleepRandom =', typeof sleepRandom);
}

// Report ready so background knows this tab's content script is alive
inlineReportReady();

// Listen for commands from Background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXECUTE_STEP') {
    handleStep(message.step, message.payload).then(() => {
      sendResponse({ ok: true });
    }).catch(err => {
      inlineReportError(message.step, err.message);
      sendResponse({ error: err.message });
    });
    return true;
  }
});

async function handleStep(step, payload) {
  switch (step) {
    case 1: return await step1_getOAuthLink();
    case 9: return await step9_vpsVerify(payload);
    default:
      throw new Error(`vps-panel.js does not handle step ${step}`);
  }
}

// ============================================================
// Step 1: Get OAuth Link
// ============================================================
//
// Auto-detection: URL containing #/oauth or ?cpa=true uses CPA layout.

async function step1_getOAuthLink() {
  inlineLog('Step 1: Detecting page layout...');
  await sleepRandom(800, 1500);

  const url = location.href;
  const isCPALayout = url.includes('#/oauth') || url.includes('cpa=true');

  if (isCPALayout) {
    await step1_cpa_getOAuthLink();
  } else {
    await step1_vps_getOAuthLink();
  }
}

// --- CPA layout ---

async function step1_cpa_getOAuthLink() {
  inlineLog('Step 1 [CPA]: Using CPA layout...');

  // If we're not on #/oauth yet, click the nav item
  if (!location.href.includes('#/oauth')) {
    inlineLog('Step 1 [CPA]: Not on OAuth page yet, looking for nav link...');
    let navLink = null;
    try {
      // Primary: explicit anchor with "OAuth 登录" text or #/oauth href
      navLink = await waitForElementByText('a.nav-item', /oauth/i, 8000);
    } catch {
      // Fallback: any anchor with oauth in href
      try {
        navLink = await waitForElement('a[href*="oauth"]', 5000);
      } catch {
        throw new Error(
          'CPA layout: Could not find OAuth nav link (<a href="#/oauth">OAuth 登录</a>). ' +
          'Current URL: ' + location.href
        );
      }
    }
    simulateClick(navLink);
    inlineLog('Step 1 [CPA]: Clicked OAuth nav, waiting for page to update...');
    // Wait for hash navigation to settle
    await sleepRandom(1200, 2200);
  }

  // Now on #/oauth — wait for the auth URL to appear
  let authUrlEl = null;
  try {
    authUrlEl = await waitForElement(
      '[class*="authUrlValue"], [class*="auth-url"], [class*="oauthUrl"]',
      15000
    );
  } catch {
    // Fallback: any link that looks like an OAuth URL
    try {
      authUrlEl = await waitForElement(
        'a[href*="auth"], a[href*="oauth"], a[href*="openai"]',
        5000
      );
    } catch {
      throw new Error(
        'CPA layout: Auth URL not found on page. ' +
        'Check if OAuth page rendered correctly. Current URL: ' + location.href
      );
    }
  }

  const oauthUrl = (authUrlEl.href || authUrlEl.textContent || '').trim();
  if (!oauthUrl || !oauthUrl.startsWith('http')) {
    throw new Error(`Invalid OAuth URL found: "${oauthUrl.slice(0, 50)}". Expected URL starting with http.`);
  }

  inlineLog(`Step 1 [CPA]: OAuth URL obtained: ${oauthUrl.slice(0, 80)}...`, 'ok');
  inlineReportComplete(1, { oauthUrl });
}

// --- VPS Panel (Codex) layout ---

async function step1_vps_getOAuthLink() {
  inlineLog('Step 1 [VPS]: Using VPS layout — waiting for Codex OAuth card...');
  await sleepRandom(1500, 2600);

  // The page may start at #/inlineLogin and auto-redirect to #/oauth.
  // Wait for the Codex OAuth card to appear (up to 30s for auto-inlineLogin + redirect).
  let inlineLoginBtn = null;
  try {
    // Wait for any card-header containing "Codex" to appear
    const header = await waitForElementByText('.card-header', /codex/i, 30000);
    inlineLoginBtn = header.querySelector('button.btn.btn-primary, button.btn');
    inlineLog('Step 1 [VPS]: Found Codex OAuth card');
  } catch {
    throw new Error(
      'Codex OAuth card did not appear after 30s. Page may still be loading or not inlineLogged in. ' +
      'Current URL: ' + location.href
    );
  }

  if (!inlineLoginBtn) {
    throw new Error('Found Codex OAuth card but no inlineLogin button inside it. URL: ' + location.href);
  }

  // Check if button is disabled (already clicked / loading)
  if (inlineLoginBtn.disabled) {
    inlineLog('Step 1 [VPS]: Login button is disabled (already loading), waiting for auth URL...');
  } else {
    simulateClick(inlineLoginBtn);
    inlineLog('Step 1 [VPS]: Clicked inlineLogin button, waiting for auth URL...');
  }

  // Wait for the auth URL to appear in the specific div
  let authUrlEl = null;
  try {
    authUrlEl = await waitForElement('[class*="authUrlValue"]', 15000);
  } catch {
    throw new Error(
      'Auth URL did not appear after clicking inlineLogin. ' +
      'Check if VPS panel is inlineLogged in and Codex service is running. URL: ' + location.href
    );
  }

  const oauthUrl = (authUrlEl.textContent || '').trim();
  if (!oauthUrl || !oauthUrl.startsWith('http')) {
    throw new Error(`Invalid OAuth URL found: "${oauthUrl.slice(0, 50)}". Expected URL starting with http.`);
  }

  inlineLog(`Step 1 [VPS]: OAuth URL obtained: ${oauthUrl.slice(0, 80)}...`, 'ok');
  inlineReportComplete(1, { oauthUrl });
}

// ============================================================
// Step 9: VPS Verify — paste localhost URL and submit
// ============================================================

async function step9_vpsVerify(payload) {
  // Get localhostUrl from payload (passed directly by background) or fallback to state
  let localhostUrl = payload?.localhostUrl;
  if (!localhostUrl) {
    inlineLog('Step 9: localhostUrl not in payload, fetching from state...');
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    localhostUrl = state.localhostUrl;
  }
  if (!localhostUrl) {
    throw new Error('No localhost URL found. Complete step 8 first.');
  }
  inlineLog(`Step 9: Got localhostUrl: ${localhostUrl.slice(0, 60)}...`);
  await sleepRandom(1200, 2200);

  inlineLog('Step 9: Looking for callback URL input...');

  // Find the callback URL input
  // Actual DOM: <input class="input" placeholder="http://localhost:1455/auth/callback?code=...&state=...">
  let urlInput = null;
  try {
    urlInput = await waitForElement('[class*="callbackSection"] input.input', 10000);
  } catch {
    try {
      urlInput = await waitForElement('input[placeholder*="localhost"]', 5000);
    } catch {
      throw new Error('Could not find callback URL input on VPS panel. URL: ' + location.href);
    }
  }

  fillInput(urlInput, localhostUrl);
  inlineLog(`Step 9: Filled callback URL: ${localhostUrl.slice(0, 80)}...`);

  // Find and click "提交回调 URL" button
  let submitBtn = null;
  try {
    submitBtn = await waitForElementByText(
      '[class*="callbackActions"] button, [class*="callbackSection"] button',
      /提交/,
      5000
    );
  } catch {
    try {
      submitBtn = await waitForElementByText('button.btn', /提交回调/, 5000);
    } catch {
      throw new Error('Could not find "提交回调 URL" button. URL: ' + location.href);
    }
  }

  simulateClick(submitBtn);
  inlineLog('Step 9: Clicked "提交回调 URL", waiting for authentication result...');

  // Wait for "认证成功！" status badge to appear
  try {
    await waitForElementByText('.status-badge, [class*="status"]', /认证成功/, 30000);
    inlineLog('Step 9: Authentication successful!', 'ok');
  } catch {
    // Check if there's an error message instead
    const statusEl = document.querySelector('.status-badge, [class*="status"]');
    const statusText = statusEl ? statusEl.textContent : 'unknown';
    if (/成功|success/i.test(statusText)) {
      inlineLog('Step 9: Authentication successful!', 'ok');
    } else {
      inlineLog(`Step 9: Status after submit: "${statusText}". May still be processing.`, 'warn');
    }
  }

  inlineReportComplete(9);
}
