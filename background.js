// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts('data/names.js');

const LOG_PREFIX = '[MultiPage:bg]';
const LOCAL_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const LOCAL_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const MAX_RESTARTS_PER_RUN = 2;

// ============================================================
// State Management (chrome.storage.session)
// ============================================================

const DEFAULT_STATE = {
  currentStep: 0,
  stepStatuses: {
    1: 'pending', 2: 'pending', 3: 'pending', 4: 'pending', 5: 'pending',
    6: 'pending', 7: 'pending', 8: 'pending', 9: 'pending',
  },
  oauthUrl: null,
  email: null,
  password: null,
  accounts: [], // { email, password, createdAt }
  lastEmailTimestamp: null,
  signupVerificationCode: null,
  localhostUrl: null,
  flowStartTime: null,
  tabRegistry: {},
  logs: [],
  vpsUrl: '',
  mailProvider: '163', // 'qq' or '163'
  emailPrefix: '',
  oauthCodeVerifier: null,
  oauthState: null,
  manualIntervention: null,
};

async function getState() {
  const state = await chrome.storage.session.get(null);
  return { ...DEFAULT_STATE, ...state };
}

async function setState(updates) {
  console.log(LOG_PREFIX, 'storage.set:', JSON.stringify(updates).slice(0, 200));
  await chrome.storage.session.set(updates);
}

async function resetState() {
  console.log(LOG_PREFIX, 'Resetting all state');
  // Preserve settings and persistent data across resets
  const prev = await chrome.storage.session.get(['seenCodes', 'accounts', 'tabRegistry', 'vpsUrl', 'mailProvider', 'emailPrefix']);
  await chrome.storage.session.clear();
  await chrome.storage.session.set({
    ...DEFAULT_STATE,
    seenCodes: prev.seenCodes || [],
    accounts: prev.accounts || [],
    tabRegistry: prev.tabRegistry || {},
    vpsUrl: prev.vpsUrl || '',
    mailProvider: prev.mailProvider || '163',
    emailPrefix: prev.emailPrefix || '',
  });
}

/**
 * Generate a random password: 14 chars, mix of uppercase, lowercase, digits, symbols.
 */
function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*?';
  const all = upper + lower + digits + symbols;

  // Ensure at least one of each type
  let pw = '';
  pw += upper[Math.floor(Math.random() * upper.length)];
  pw += lower[Math.floor(Math.random() * lower.length)];
  pw += digits[Math.floor(Math.random() * digits.length)];
  pw += symbols[Math.floor(Math.random() * symbols.length)];

  // Fill remaining 10 chars
  for (let i = 0; i < 10; i++) {
    pw += all[Math.floor(Math.random() * all.length)];
  }

  // Shuffle
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

function base64UrlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function buildLocalOAuthUrl() {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const codeVerifier = base64UrlEncode(verifierBytes);

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64UrlEncode(new Uint8Array(digest));
  const state = randomHex(16);

  const params = new URLSearchParams({
    client_id: LOCAL_OAUTH_CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    codex_cli_simplified_flow: 'true',
    id_token_add_organizations: 'true',
    prompt: 'login',
    redirect_uri: LOCAL_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile offline_access',
    state,
  });

  return {
    oauthUrl: `https://auth.openai.com/oauth/authorize?${params.toString()}`,
    codeVerifier,
    state,
  };
}

function parseCallbackFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return {
      code: u.searchParams.get('code') || '',
      state: u.searchParams.get('state') || '',
      error: u.searchParams.get('error') || '',
    };
  } catch {
    return null;
  }
}

async function exchangeTokenWithOpenAI(code, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: LOCAL_OAUTH_REDIRECT_URI,
    client_id: LOCAL_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
  }).toString();

  const resp = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Token exchange failed ${resp.status}: ${txt}`);
  }

  return resp.json();
}

function parseJwtPayload(token) {
  if (!token || token.split('.').length < 2) return {};
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return {};
  }
}

function toPseudoPlus8ISOString(date) {
  // Keep backward compatibility with existing token file format expectations.
  return date.toISOString().replace(/\.\d{3}Z$/, '+08:00');
}

function buildCodexTokenFile(tokens) {
  const accessPayload = parseJwtPayload(tokens.access_token || '');
  const idPayload = parseJwtPayload(tokens.id_token || '');
  const apiAuth = accessPayload['https://api.openai.com/auth'] || {};
  const accountId = apiAuth.chatgpt_account_id || '';
  const email = idPayload.email || '';

  const now = new Date();
  const expiredAt = new Date(now.getTime() + (tokens.expires_in || 3600) * 1000);

  return {
    access_token: tokens.access_token || '',
    account_id: accountId,
    disabled: false,
    email,
    expired: toPseudoPlus8ISOString(expiredAt),
    id_token: tokens.id_token || '',
    last_refresh: toPseudoPlus8ISOString(now),
    refresh_token: tokens.refresh_token || '',
    type: 'codex',
  };
}

// ============================================================
// Tab Registry
// ============================================================

async function getTabRegistry() {
  const state = await getState();
  return state.tabRegistry || {};
}

async function registerTab(source, tabId) {
  const registry = await getTabRegistry();
  registry[source] = { tabId, ready: true };
  await setState({ tabRegistry: registry });
  console.log(LOG_PREFIX, `Tab registered: ${source} -> ${tabId}`);
}

async function isTabAlive(source) {
  const registry = await getTabRegistry();
  const entry = registry[source];
  if (!entry) return false;
  try {
    await chrome.tabs.get(entry.tabId);
    return true;
  } catch {
    // Tab no longer exists — clean up registry
    registry[source] = null;
    await setState({ tabRegistry: registry });
    return false;
  }
}

async function getTabId(source) {
  const registry = await getTabRegistry();
  return registry[source]?.tabId || null;
}

// ============================================================
// Command Queue (for content scripts not yet ready)
// ============================================================

const pendingCommands = new Map(); // source -> { message, resolve, reject, timer }

function queueCommand(source, message, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(source);
      const err = `Content script on ${source} did not respond in ${timeout / 1000}s. Try refreshing the tab and retry.`;
      console.error(LOG_PREFIX, err);
      reject(new Error(err));
    }, timeout);
    pendingCommands.set(source, { message, resolve, reject, timer });
    console.log(LOG_PREFIX, `Command queued for ${source} (waiting for ready)`);
  });
}

function flushCommand(source, tabId) {
  const pending = pendingCommands.get(source);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCommands.delete(source);
    chrome.tabs.sendMessage(tabId, pending.message).then(pending.resolve).catch(pending.reject);
    console.log(LOG_PREFIX, `Flushed queued command to ${source} (tab ${tabId})`);
  }
}

async function waitForContentScriptReady(source, expectedTabId, timeout = 15000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    const registry = await getTabRegistry();
    const entry = registry[source];
    if (entry?.ready && (!expectedTabId || entry.tabId === expectedTabId)) {
      return true;
    }
    await sleep(250);
  }

  return false;
}

// ============================================================
// Reuse or create tab
// ============================================================

async function reuseOrCreateTab(source, url, options = {}) {
  const alive = await isTabAlive(source);
  if (alive) {
    const tabId = await getTabId(source);

    // Mark as not ready BEFORE navigating — so READY signal from new page is captured correctly
    const registry = await getTabRegistry();
    if (registry[source]) registry[source].ready = false;
    await setState({ tabRegistry: registry });

    // Navigate existing tab to new URL
    await chrome.tabs.update(tabId, { url, active: true });
    console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}), navigated to ${url.slice(0, 60)}`);

    // Wait for page load complete (with 30s timeout)
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    // If dynamic injection needed (VPS panel), re-inject after navigation
    if (options.inject) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: options.inject,
      });
    }

    const ready = await waitForContentScriptReady(source, tabId, options.readyTimeout || 15000);
    if (!ready) {
      throw new Error(`Content script on ${source} did not become ready after navigation`);
    }

    return tabId;
  }

  // Create new tab
  const tab = await chrome.tabs.create({ url, active: true });
  console.log(LOG_PREFIX, `Created new tab ${source} (${tab.id})`);

  // If dynamic injection needed (VPS panel), inject scripts after load
  if (options.inject) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    // Inject utils.js first, then vps-panel.js — separate calls ensure sequential execution
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/utils.js'],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/vps-panel.js'],
    });
  }

  const ready = await waitForContentScriptReady(source, tab.id, options.readyTimeout || 15000);
  if (!ready) {
    throw new Error(`Content script on ${source} did not become ready after tab creation`);
  }

  return tab.id;
}

// ============================================================
// Send command to content script (with readiness check)
// ============================================================

async function sendToContentScript(source, message) {
  const registry = await getTabRegistry();
  const entry = registry[source];

  if (!entry || !entry.ready) {
    console.log(LOG_PREFIX, `${source} not ready, queuing command`);
    return queueCommand(source, message);
  }

  // Verify tab is still alive
  const alive = await isTabAlive(source);
  if (!alive) {
    // Tab was closed — queue the command, it will be sent when tab is reopened
    console.log(LOG_PREFIX, `${source} tab was closed, queuing command`);
    return queueCommand(source, message);
  }

  console.log(LOG_PREFIX, `Sending to ${source} (tab ${entry.tabId}):`, message.type);
  return chrome.tabs.sendMessage(entry.tabId, message);
}

// ============================================================
// Logging
// ============================================================

async function addLog(message, level = 'info') {
  const state = await getState();
  const logs = state.logs || [];
  const entry = { message, level, timestamp: Date.now() };
  logs.push(entry);
  // Keep last 500 logs
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await setState({ logs });
  // Broadcast to side panel
  chrome.runtime.sendMessage({ type: 'LOG_ENTRY', payload: entry }).catch(() => {});
}

// ============================================================
// Step Status Management
// ============================================================

async function setStepStatus(step, status) {
  const state = await getState();
  const statuses = { ...state.stepStatuses };
  statuses[step] = status;
  await setState({ stepStatuses: statuses, currentStep: step });
  // Broadcast to side panel
  chrome.runtime.sendMessage({
    type: 'STEP_STATUS_CHANGED',
    payload: { step, status },
  }).catch(() => {});
}

function getRandomDelay(minMs, maxMs = minMs) {
  const lower = Math.max(0, Math.min(minMs, maxMs));
  const upper = Math.max(minMs, maxMs);
  return lower + Math.floor(Math.random() * (upper - lower + 1));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sleepRandom(minMs, maxMs = minMs) {
  return new Promise(resolve => setTimeout(resolve, getRandomDelay(minMs, maxMs)));
}

// ============================================================
// Message Handler (central router)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG_PREFIX, `Received: ${message.type} from ${message.source || 'sidepanel'}`, message);

  handleMessage(message, sender).then(response => {
    sendResponse(response);
  }).catch(err => {
    console.error(LOG_PREFIX, 'Handler error:', err);
    sendResponse({ error: err.message });
  });

  return true; // async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'CONTENT_SCRIPT_READY': {
      const tabId = sender.tab?.id;
      if (tabId && message.source) {
        await registerTab(message.source, tabId);
        flushCommand(message.source, tabId);
        await addLog(`Content script ready: ${message.source} (tab ${tabId})`);
      }
      return { ok: true };
    }

    case 'LOG': {
      const { message: msg, level } = message.payload;
      await addLog(`[${message.source}] ${msg}`, level);
      return { ok: true };
    }

    case 'STEP_COMPLETE': {
      await setStepStatus(message.step, 'completed');
      await addLog(`Step ${message.step} completed`, 'ok');
      await handleStepData(message.step, message.payload);
      notifyStepComplete(message.step, message.payload);
      return { ok: true };
    }

    case 'STEP_ERROR': {
      const isMailPollTransient = (message.step === 4 || message.step === 7)
        && /^mail-/.test(message.source || '')
        && /No matching email found/i.test(message.error || '');

      if (isMailPollTransient) {
        await addLog(
          `Step ${message.step} transient poll timeout from ${message.source}: ${message.error} (will continue retry/resend cycle)`,
          'warn'
        );
        return { ok: true };
      }

      await setStepStatus(message.step, 'failed');
      await addLog(`Step ${message.step} failed: ${message.error}`, 'error');
      notifyStepError(message.step, message.error);
      return { ok: true };
    }

    case 'GET_STATE': {
      return await getState();
    }

    case 'RESET': {
      await resetState();
      await addLog('Flow reset', 'info');
      return { ok: true };
    }

    case 'EXECUTE_STEP': {
      const step = message.payload.step;
      // Save email if provided (from side panel step 3)
      if (message.payload.email) {
        await setState({ email: message.payload.email });
      }
      if (message.payload.emailPrefix !== undefined) {
        await setState({ emailPrefix: message.payload.emailPrefix });
      }
      await executeStep(step);
      return { ok: true };
    }

    case 'AUTO_RUN': {
      const totalRuns = message.payload?.totalRuns || 1;
      autoRunLoop(totalRuns);  // fire-and-forget
      return { ok: true };
    }

    case 'RESUME_AUTO_RUN': {
      if (message.payload.email) {
        await setState({ email: message.payload.email });
      }
      resumeAutoRun();  // fire-and-forget
      return { ok: true };
    }

    case 'RESUME_MANUAL_INTERVENTION': {
      await resumeManualIntervention();
      return { ok: true };
    }

    case 'SAVE_SETTING': {
      const updates = {};
      if (message.payload.vpsUrl !== undefined) updates.vpsUrl = message.payload.vpsUrl;
      if (message.payload.mailProvider !== undefined) updates.mailProvider = message.payload.mailProvider;
      if (message.payload.emailPrefix !== undefined) updates.emailPrefix = message.payload.emailPrefix;
      await setState(updates);
      return { ok: true };
    }

    // Side panel data updates
    case 'SAVE_EMAIL': {
      await setState({ email: message.payload.email });
      return { ok: true };
    }

    default:
      console.warn(LOG_PREFIX, `Unknown message type: ${message.type}`);
      return { error: `Unknown message type: ${message.type}` };
  }
}

// ============================================================
// Step Data Handlers
// ============================================================

async function handleStepData(step, payload) {
  switch (step) {
    case 1:
      if (payload.oauthUrl) {
        await setState({ oauthUrl: payload.oauthUrl });
        // Broadcast OAuth URL to side panel
        chrome.runtime.sendMessage({
          type: 'DATA_UPDATED',
          payload: { oauthUrl: payload.oauthUrl },
        }).catch(() => {});
      }
      break;
    case 3:
      if (payload.email) await setState({ email: payload.email });
      break;
    case 4:
      if (payload.emailTimestamp) await setState({ lastEmailTimestamp: payload.emailTimestamp });
      break;
    case 8:
      if (payload.localhostUrl) {
        await setState({ localhostUrl: payload.localhostUrl });
        chrome.runtime.sendMessage({
          type: 'DATA_UPDATED',
          payload: { localhostUrl: payload.localhostUrl },
        }).catch(() => {});
      }
      break;
  }
}

// ============================================================
// Step Completion Waiting
// ============================================================

// Map of step -> { resolve, reject } for waiting on step completion
const stepWaiters = new Map();

function waitForStepComplete(step, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stepWaiters.delete(step);
      reject(new Error(`Step ${step} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    stepWaiters.set(step, {
      resolve: (data) => { clearTimeout(timer); stepWaiters.delete(step); resolve(data); },
      reject: (err) => { clearTimeout(timer); stepWaiters.delete(step); reject(err); },
    });
  });
}

function notifyStepComplete(step, payload) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.resolve(payload);
}

function notifyStepError(step, error) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.reject(new Error(error));
}

function makeRunRestartError(message) {
  const err = new Error(message);
  err.code = 'RUN_RESTART';
  return err;
}

function isRunRestartError(err) {
  return err?.code === 'RUN_RESTART';
}

// ============================================================
// Step Execution
// ============================================================

async function executeStep(step) {
  console.log(LOG_PREFIX, `Executing step ${step}`);
  await setStepStatus(step, 'running');
  await addLog(`Step ${step} started`);

  const state = await getState();

  // Set flow start time on first step
  if (step === 1 && !state.flowStartTime) {
    await setState({ flowStartTime: Date.now() });
  }

  try {
    switch (step) {
      case 1: await executeStep1(state); break;
      case 2: await executeStep2(state); break;
      case 3: await executeStep3(state); break;
      case 4: await executeStep4(state); break;
      case 5: await executeStep5(state); break;
      case 6: await executeStep6(state); break;
      case 7: await executeStep7(state); break;
      case 8: await executeStep8(state); break;
      case 9: await executeStep9(state); break;
      default:
        throw new Error(`Unknown step: ${step}`);
    }
  } catch (err) {
    await setStepStatus(step, 'failed');
    await addLog(`Step ${step} failed: ${err.message}`, 'error');
    notifyStepError(step, err.message);
    throw err;
  }
}

/**
 * Execute a step and wait for it to complete before returning.
 * @param {number} step
 * @param {number} minDelayAfter - min ms to wait after completion (for page transitions)
 * @param {number} maxDelayAfter - max ms to wait after completion (for page transitions)
 */
async function executeStepAndWait(step, minDelayAfter = 2000, maxDelayAfter = minDelayAfter, timeoutMs = 120000) {
  const promise = waitForStepComplete(step, timeoutMs);
  await executeStep(step);
  await promise;
  // Extra delay for page transitions / DOM updates
  if (maxDelayAfter > 0) {
    await sleepRandom(minDelayAfter, maxDelayAfter);
  }
}

async function isSignupProfilePageReady() {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) return false;

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: signupTabId },
    func: () => {
      const hasNameInput = !!document.querySelector(
        'input[name="name"], input[autocomplete="name"], input[placeholder*="全名"]'
      );
      const hasCodeInput = !!document.querySelector(
        'input[name="code"], input[name="otp"], input[maxlength="1"], input[inputmode="numeric"]'
      );
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const hasCodeError = /invalid|incorrect|wrong\s*code|验证码|无效|错误|try again|重新发送/.test(bodyText);
      return {
        hasNameInput,
        hasCodeInput,
        hasCodeError,
        href: location.href,
      };
    },
  });

  const info = result?.result;
  if (!info) return false;
  if (info.hasNameInput) return true;
  if (info.hasCodeInput || info.hasCodeError) return false;
  return false;
}

async function isOAuthConsentPageReady() {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) return false;

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: signupTabId },
    func: () => {
      const continueBtn = document.querySelector(
        'button[data-dd-action-name="Continue"][type="submit"], button._primary_3rdp0_107[type="submit"], button[type="submit"]'
      );
      const hasContinueText = /(^|\s)(继续|continue)(\s|$)/i.test(
        (continueBtn?.textContent || document.body?.innerText || '').replace(/\s+/g, ' ')
      );
      const hasCodeInput = !!document.querySelector(
        'input[name="code"], input[name="otp"], input[maxlength="1"], input[inputmode="numeric"]'
      );
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const hasCodeError = /invalid|incorrect|wrong\s*code|验证码|无效|错误|try again|重新发送/.test(bodyText);
      return {
        hasContinueButton: !!continueBtn,
        hasContinueText,
        hasCodeInput,
        hasCodeError,
        href: location.href,
      };
    },
  });

  const info = result?.result;
  if (!info) return false;
  if ((info.hasContinueButton && info.hasContinueText) || info.hasContinueButton) return true;
  if (info.hasCodeInput || info.hasCodeError) return false;
  return false;
}

async function waitForSignupProfilePageReady(timeoutMs = 20000, intervalMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isSignupProfilePageReady()) return true;
    await sleepRandom(intervalMs, intervalMs + 300);
  }
  return await isSignupProfilePageReady();
}

async function waitForOAuthConsentPageReady(timeoutMs = 20000, intervalMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isOAuthConsentPageReady()) return true;
    await sleepRandom(intervalMs, intervalMs + 300);
  }
  return await isOAuthConsentPageReady();
}

// ============================================================
// Auto Run Flow
// ============================================================

let autoRunActive = false;
let autoRunCurrentRun = 0;
let autoRunTotalRuns = 1;
let manualInterventionResolver = null;

function waitForManualIntervention() {
  return new Promise((resolve) => {
    manualInterventionResolver = resolve;
  });
}

async function resumeManualIntervention() {
  if (manualInterventionResolver) {
    manualInterventionResolver();
    manualInterventionResolver = null;
  }
}

async function requestManualIntervention(step, message, currentRun, totalRuns) {
  const payload = { step, message, currentRun, totalRuns };
  await setState({ manualIntervention: payload });
  await addLog(`Step ${step}: 需要人工介入。${message}。处理完成后点击侧边栏“人工处理完成，继续下一步”。`, 'warn');
  chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'manual_intervention', ...payload } }).catch(() => {});

  await waitForManualIntervention();

  await setState({ manualIntervention: null });
  if (step >= 1 && step <= 9) {
    await setStepStatus(step, 'completed');
    await addLog(`Step ${step}: 人工处理后已继续下一步`, 'ok');
  }
  chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'running', currentRun, totalRuns } }).catch(() => {});
}

async function executeStepWithManualFallback(step, currentRun, totalRuns, minDelayAfter, maxDelayAfter, timeoutMs = 120000) {
  try {
    await executeStepAndWait(step, minDelayAfter, maxDelayAfter, timeoutMs);
  } catch (err) {
    if (isRunRestartError(err)) {
      throw err;
    }
    await requestManualIntervention(step, err.message, currentRun, totalRuns);
  }
}

async function executeStepWithRunRestartFallback(step, currentRun, totalRuns, minDelayAfter, maxDelayAfter, timeoutMs = 120000) {
  try {
    await executeStepAndWait(step, minDelayAfter, maxDelayAfter, timeoutMs);
  } catch (err) {
    throw makeRunRestartError(
      `Step ${step} failed and requires a fresh run restart: ${err.message}`
    );
  }
}

// Outer loop: runs the full flow N times
async function autoRunLoop(totalRuns) {
  if (autoRunActive) {
    await addLog('Auto run already in progress', 'warn');
    return;
  }

  autoRunActive = true;
  autoRunTotalRuns = totalRuns;
  await setState({ autoRunning: true });

  const runRestartCounts = new Map();

  for (let run = 1; run <= totalRuns; run++) {
    autoRunCurrentRun = run;

    // Reset everything at the start of each run (keep VPS/mail settings)
    const prevState = await getState();
    const keepSettings = {
      vpsUrl: prevState.vpsUrl,
      mailProvider: prevState.mailProvider,
      emailPrefix: prevState.emailPrefix || '',
      autoRunning: true,
    };
    await resetState();
    await setState(keepSettings);
    // Tell side panel to reset all UI
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_RESET' }).catch(() => {});
    await sleepRandom(400, 900);

    await addLog(`=== Auto Run ${run}/${totalRuns} — Phase 1: Get OAuth link & open signup ===`, 'info');
    const status = (phase) => ({ type: 'AUTO_RUN_STATUS', payload: { phase, currentRun: run, totalRuns } });

    try {
      chrome.runtime.sendMessage(status('running')).catch(() => {});

      await executeStepWithManualFallback(1, run, totalRuns, 2600, 3800);
      await executeStepWithManualFallback(2, run, totalRuns, 2600, 3800);


      // 2925 模式跳过暂停，其余等待用户粘贴邮箱
      const runState = await getState();
      if (runState.mailProvider === '2925') {
        if (!runState.emailPrefix) {
          await addLog('Cannot continue: 2925 邮箱前缀未设置，请在侧边栏填写。', 'error');
          chrome.runtime.sendMessage(status('stopped')).catch(() => {});
          break;
        }
        await addLog(`=== Run ${run}/${totalRuns} — 2925 模式，将在步骤3自动生成邮箱 ===`, 'info');
      } else {
        // Pause for email
        await addLog(`=== Run ${run}/${totalRuns} PAUSED: Paste DuckDuckGo email, click Continue ===`, 'warn');
        chrome.runtime.sendMessage(status('waiting_email')).catch(() => {});
        // Wait for RESUME_AUTO_RUN — sets a promise that resumeAutoRun resolves
        await waitForResume();
        const resumedState = await getState();
        if (!resumedState.email) {
          await addLog('Cannot resume: no email address.', 'error');
          break;
        }
      }

      await addLog(`=== Run ${run}/${totalRuns} — Phase 2: Register, verify, login, complete ===`, 'info');
      chrome.runtime.sendMessage(status('running')).catch(() => {});

      await executeStepWithManualFallback(3, run, totalRuns, 3200, 4800);
      await executeStepWithManualFallback(4, run, totalRuns, 3200, 4800, 600000);

      // Guard: if step 4 used an old/invalid code, the page may still be on verification input.
      // Retry step 4 instead of moving to step 5 and failing downstream.
      let profileReady = await waitForSignupProfilePageReady(20000, 1200);
      for (let retry = 1; !profileReady && retry <= 2; retry++) {
        await addLog(`Step 4 guard: still not on profile page after code submit, retrying step 4 (${retry}/2)...`, 'warn');
        await executeStepWithManualFallback(4, run, totalRuns, 3200, 4800, 600000);
        profileReady = await waitForSignupProfilePageReady(20000, 1200);
      }
      if (!profileReady) {
        await requestManualIntervention(4, '仍未进入姓名/生日页面，请人工确认注册验证码页面并处理，然后继续。', run, totalRuns);
      }

      await executeStepWithManualFallback(5, run, totalRuns, 3200, 4800);
      await executeStepWithManualFallback(6, run, totalRuns, 3200, 4800);
      await executeStepWithManualFallback(7, run, totalRuns, 3200, 4800, 600000);

      // Guard: step 7 may submit a stale/invalid login code and still report completion.
      // Ensure we actually reached OAuth consent page before moving to step 8.
      let consentReady = await waitForOAuthConsentPageReady(20000, 1200);
      for (let retry = 1; !consentReady && retry <= 2; retry++) {
        await addLog(`Step 7 guard: consent page not ready after code submit, retrying step 7 (${retry}/2)...`, 'warn');
        await executeStepWithManualFallback(7, run, totalRuns, 3200, 4800, 600000);
        consentReady = await waitForOAuthConsentPageReady(20000, 1200);
      }
      if (!consentReady) {
        await requestManualIntervention(7, '仍未进入 OAuth 同意页，请人工确认登录验证码页面并处理，然后继续。', run, totalRuns);
      }

      await executeStepWithRunRestartFallback(8, run, totalRuns, 2400, 3600);
      await executeStepWithManualFallback(9, run, totalRuns, 1600, 2600);

      await addLog(`=== Run ${run}/${totalRuns} COMPLETE! ===`, 'ok');

    } catch (err) {
      if (isRunRestartError(err)) {
        const restartCount = (runRestartCounts.get(run) || 0) + 1;
        runRestartCounts.set(run, restartCount);

        if (restartCount <= MAX_RESTARTS_PER_RUN) {
          await addLog(
            `Run ${run}/${totalRuns} 命中需重开错误，正在重启本轮 (${restartCount}/${MAX_RESTARTS_PER_RUN})：${err.message}`,
            'warn'
          );
          chrome.runtime.sendMessage(status('running')).catch(() => {});
          run -= 1;
          continue;
        }

        await addLog(
          `Run ${run}/${totalRuns} 已达到本轮重启上限 (${MAX_RESTARTS_PER_RUN})：${err.message}`,
          'error'
        );
      }

      await addLog(`Run ${run}/${totalRuns} failed: ${err.message}`, 'error');
      chrome.runtime.sendMessage(status('stopped')).catch(() => {});
      break; // Stop on error
    }
  }

  const completedRuns = autoRunCurrentRun;
  if (completedRuns >= autoRunTotalRuns) {
    await addLog(`=== All ${autoRunTotalRuns} runs completed successfully ===`, 'ok');
  } else {
    await addLog(`=== Stopped after ${completedRuns}/${autoRunTotalRuns} runs ===`, 'warn');
  }
  chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'complete', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  autoRunActive = false;
  await setState({ autoRunning: false });
}

// Promise-based pause/resume mechanism
let resumeResolver = null;

function waitForResume() {
  return new Promise((resolve) => {
    resumeResolver = resolve;
  });
}

async function resumeAutoRun() {
  const state = await getState();
  if (!state.email) {
    await addLog('Cannot resume: no email address. Paste email in Side Panel first.', 'error');
    return;
  }
  if (resumeResolver) {
    resumeResolver();
    resumeResolver = null;
  }
}

// ============================================================
// Step 1: Get OAuth Link (via vps-panel.js)
// ============================================================

async function executeStep1(state) {
  if (!state.vpsUrl) {
    const local = await buildLocalOAuthUrl();
    await setState({
      oauthUrl: local.oauthUrl,
      oauthCodeVerifier: local.codeVerifier,
      oauthState: local.state,
    });
    await addLog('Step 1: CPA 接口为空，已本地生成 OAuth 链接。', 'ok');
    chrome.runtime.sendMessage({
      type: 'DATA_UPDATED',
      payload: { oauthUrl: local.oauthUrl },
    }).catch(() => {});
    await setStepStatus(1, 'completed');
    notifyStepComplete(1, { oauthUrl: local.oauthUrl, mode: 'local' });
    return;
  }

  await addLog('Step 1: Opening VPS panel in a fresh tab...');

  // Always open a fresh tab — reusing/reloading an existing tab leaves stale
  // content-script state that causes "sleep is not defined" errors.
  const existingTabId = await getTabId('vps-panel');
  if (existingTabId) {
    try { await chrome.tabs.remove(existingTabId); } catch (_) {}
  }

  // Create new tab
  const tab = await chrome.tabs.create({ url: state.vpsUrl, active: true });
  await addLog('Step 1: Created new VPS panel tab (id=' + tab.id + ')');

  // Update registry with new tab id
  const registry = await getTabRegistry();
  registry['vps-panel'] = { id: tab.id, ready: false, url: state.vpsUrl };
  await setState({ tabRegistry: registry });

  // Wait for page load
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });

  // Inject utils.js first (must be ready before vps-panel.js runs), then vps-panel.js
  await addLog('Step 1: Injecting content scripts...');
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content/utils.js'],
  });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content/vps-panel.js'],
  });

  const tabReady = await waitForContentScriptReady('vps-panel', tab.id, 15000);
  if (!tabReady) {
    throw new Error('Content script on VPS panel did not become ready');
  }
  await addLog('Step 1: Content script ready.', 'ok');

  await sendToContentScript('vps-panel', {
    type: 'EXECUTE_STEP',
    step: 1,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 2: Open Signup Page (Background opens tab, signup-page.js clicks Register)
// ============================================================

async function executeStep2(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }
  await addLog(`Step 2: Opening auth URL...`);
  await reuseOrCreateTab('signup-page', state.oauthUrl);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 2,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 3: Fill Email & Password (via signup-page.js)
// ============================================================

function generateRandomSuffix(length = 6) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < length; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function executeStep3(state) {
  let email = state.email;

  // 2925 模式：用前缀 + 随机后缀 + @2925.com 自动生成邮箱
  if (state.mailProvider === '2925') {
    if (!state.emailPrefix) {
      throw new Error('2925 邮箱前缀未设置，请在侧边栏填写。');
    }
    email = `${state.emailPrefix}${generateRandomSuffix(6)}@2925.com`;
    await setState({ email });
    await addLog(`Step 3: 2925 邮箱已生成: ${email}`);
    chrome.runtime.sendMessage({
      type: 'DATA_UPDATED',
      payload: { generatedEmail: email },
    }).catch(() => {});
  } else {
    if (!email) {
      throw new Error('No email address. Paste email in Side Panel first.');
    }
  }

  // Generate a unique password for this account
  const password = generatePassword();
  await setState({ password });

  // Save account record
  const accounts = state.accounts || [];
  accounts.push({ email, password, createdAt: new Date().toISOString() });
  await setState({ accounts });

  await addLog(`Step 3: Filling email ${email}, password generated (${password.length} chars)`);
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 3,
    source: 'background',
    payload: { email, password },
  });
}

// ============================================================
// Step 4: Get Signup Verification Code (qq-mail.js polls, then fills in signup-page.js)
// ============================================================

function getMailConfig(state) {
  const provider = state.mailProvider || 'qq';
  if (provider === '163') {
    return { source: 'mail-163', url: 'https://mail.163.com/js6/main.jsp?df=mail163_letter#module=mbox.ListModule%7C%7B%22fid%22%3A1%2C%22order%22%3A%22date%22%2C%22desc%22%3Atrue%7D', label: '163 Mail' };
  }
  if (provider === '2925') {
    return { source: 'mail-2925', url: 'https://2925.com/#/mailList', label: '2925 Mail' };
  }
  return { source: 'qq-mail', url: 'https://wx.mail.qq.com/', label: 'QQ Mail' };
}

async function executeStep4(state) {
  const mail = getMailConfig(state);
  await addLog(`Step 4: Opening ${mail.label}...`);

  // For mail tabs, only create if not alive — don't navigate (preserves login session)
  const alive = await isTabAlive(mail.source);
  if (alive) {
    const tabId = await getTabId(mail.source);
    await chrome.tabs.update(tabId, { active: true });
  } else {
    await reuseOrCreateTab(mail.source, mail.url);
  }

  let cycle = 1;
  while (true) {
    const cycleStartedAt = Date.now();
    await addLog(`Step 4: Polling signup verification code, cycle ${cycle}...`);

    const result = await sendToContentScript(mail.source, {
      type: 'POLL_EMAIL',
      step: 4,
      source: 'background',
      payload: {
        filterAfterTimestamp: cycleStartedAt,
        senderFilters: ['openai', 'noreply', 'verify', 'auth'],
        subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm'],
        maxAttempts: 20,
        intervalMs: 3000,
      },
    });

    if (result && result.code) {
      await setState({
        lastEmailTimestamp: result.emailTimestamp,
        signupVerificationCode: result.code,
      });
      await addLog(`Step 4: Got verification code: ${result.code}`);

      const signupTabId = await getTabId('signup-page');
      if (!signupTabId) {
        throw new Error('Signup page tab was closed. Cannot fill verification code.');
      }

      await chrome.tabs.update(signupTabId, { active: true });
      await sendToContentScript('signup-page', {
        type: 'FILL_CODE',
        step: 4,
        source: 'background',
        payload: { code: result.code },
      });
      return;
    }

    await addLog(`Step 4: No signup code found in cycle ${cycle}, requesting resend email...`, 'warn');

    const signupTabId = await getTabId('signup-page');
    if (!signupTabId) {
      throw new Error('Signup page tab was closed. Cannot click resend verification email.');
    }

    await chrome.tabs.update(signupTabId, { active: true });
    await sendToContentScript('signup-page', {
      type: 'EXECUTE_STEP',
      step: 41,
      source: 'background',
      payload: {},
    });
    await addLog(`Step 4: Resend verification email clicked for cycle ${cycle}`, 'info');
    await sleepRandom(1800, 3200);

    const mailTabId = await getTabId(mail.source);
    if (mailTabId) {
      await chrome.tabs.update(mailTabId, { active: true });
    }
    cycle += 1;
  }
}

// ============================================================
// Step 5: Fill Name & Birthday (via signup-page.js)
// ============================================================

async function executeStep5(state) {
  const { firstName, lastName } = generateRandomName();
  const { year, month, day } = generateRandomBirthday();

  await addLog(`Step 5: Generated name: ${firstName} ${lastName}, Birthday: ${year}-${month}-${day}`);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 5,
    source: 'background',
    payload: { firstName, lastName, year, month, day },
  });
}

// ============================================================
// Step 6: Login ChatGPT (Background opens tab, chatgpt.js handles login)
// ============================================================

async function executeStep6(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }
  if (!state.email) {
    throw new Error('No email. Complete step 3 first.');
  }

  await addLog(`Step 6: Opening OAuth URL for login...`);
  // Reuse the signup-page tab — navigate it to the OAuth URL
  await reuseOrCreateTab('signup-page', state.oauthUrl);

  // signup-page.js will inject (same auth.openai.com domain) and handle login
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 6,
    source: 'background',
    payload: { email: state.email, password: state.password },
  });
}

// ============================================================
// Step 7: Get Login Verification Code (qq-mail.js polls, then fills in chatgpt.js)
// ============================================================

async function executeStep7(state) {
  const mail = getMailConfig(state);
  await addLog(`Step 7: Opening ${mail.label}...`);

  const alive = await isTabAlive(mail.source);
  if (alive) {
    const tabId = await getTabId(mail.source);
    await chrome.tabs.update(tabId, { active: true });
  } else {
    await reuseOrCreateTab(mail.source, mail.url);
  }

  let cycle = 1;
  while (true) {
    const cycleStartedAt = Date.now();
    await addLog(`Step 7: Polling login verification code, cycle ${cycle}...`);

    const result = await sendToContentScript(mail.source, {
      type: 'POLL_EMAIL',
      step: 7,
      source: 'background',
      payload: {
        filterAfterTimestamp: cycleStartedAt,
        strictChatGPTCodeOnly: true,
        excludeCodes: state.signupVerificationCode ? [state.signupVerificationCode] : [],
        senderFilters: ['openai', 'noreply', 'verify', 'auth', 'chatgpt'],
        subjectFilters: ['your chatgpt code is'],
        maxAttempts: 20,
        intervalMs: 3000,
      },
    });

    if (result && result.code) {
      await addLog(`Step 7: Got login verification code: ${result.code}`);

      const signupTabId = await getTabId('signup-page');
      if (!signupTabId) {
        throw new Error('Auth page tab was closed. Cannot fill verification code.');
      }

      await chrome.tabs.update(signupTabId, { active: true });
      await sendToContentScript('signup-page', {
        type: 'FILL_CODE',
        step: 7,
        source: 'background',
        payload: { code: result.code },
      });
      return;
    }

    await addLog(`Step 7: No login code found in cycle ${cycle}, requesting resend email...`, 'warn');

    const signupTabId = await getTabId('signup-page');
    if (!signupTabId) {
      throw new Error('Auth page tab was closed. Cannot click resend verification email.');
    }

    await chrome.tabs.update(signupTabId, { active: true });
    await sendToContentScript('signup-page', {
      type: 'EXECUTE_STEP',
      step: 71,
      source: 'background',
      payload: {},
    });
    await addLog(`Step 7: Resend verification email clicked for cycle ${cycle}`, 'info');
    await sleepRandom(1800, 3200);

    const mailTabId = await getTabId(mail.source);
    if (mailTabId) {
      await chrome.tabs.update(mailTabId, { active: true });
    }
    cycle += 1;
  }
}

// ============================================================
// Step 8: Complete OAuth (webNavigation listener + chatgpt.js navigates)
// ============================================================

let webNavListener = null;

async function inspectSignupPageForOAuthFailure(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        const compactText = bodyText.toLowerCase();
        const invalidState = /invalid_state/i.test(bodyText);
        const hasOAuthErrorText = /验证过程中出错|糟糕[，,]?\s*出错了|something went wrong|an error occurred/i.test(bodyText);
        const hasRetryButton = /(^|\s)(重试|retry)(\s|$)/i.test(bodyText);
        return {
          href: location.href,
          invalidState,
          hasOAuthErrorText,
          hasRetryButton,
          bodyText: bodyText.slice(0, 500),
          title: document.title || '',
          readyState: document.readyState,
          stillOnConsent: /\/consent(?:$|[/?#])/.test(location.pathname),
        };
      },
    });

    return result?.result || null;
  } catch {
    return null;
  }
}

async function executeStep8(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }

  await addLog('Step 8: Setting up localhost redirect listener...');

  // Register webNavigation listener (scoped to this step)
  return new Promise((resolve, reject) => {
    let settled = false;
    let monitorTimer = null;

    const cleanup = () => {
      if (webNavListener) {
        chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
        webNavListener = null;
      }
      if (monitorTimer) {
        clearTimeout(monitorTimer);
        monitorTimer = null;
      }
      clearTimeout(timeout);
    };

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error('Localhost redirect not captured after 30s. Check if OAuth authorization completed.'));
    }, 30000);

    webNavListener = (details) => {
      if (settled) {
        return;
      }
      if (details.url.startsWith('http://localhost')) {
        console.log(LOG_PREFIX, `Captured localhost redirect: ${details.url}`);
        settled = true;
        cleanup();

        setState({ localhostUrl: details.url }).then(() => {
          addLog(`Step 8: Captured localhost URL: ${details.url}`, 'ok');
          setStepStatus(8, 'completed');
          notifyStepComplete(8, { localhostUrl: details.url });
          chrome.runtime.sendMessage({
            type: 'DATA_UPDATED',
            payload: { localhostUrl: details.url },
          }).catch(() => {});
          resolve();
        });
      }
    };

    chrome.webNavigation.onBeforeNavigate.addListener(webNavListener);

    const monitorForOAuthFailure = async () => {
      if (settled) {
        return;
      }

      const signupTabId = await getTabId('signup-page');
      if (signupTabId) {
        const info = await inspectSignupPageForOAuthFailure(signupTabId);
        if (info?.invalidState) {
          settled = true;
          cleanup();
          reject(new Error(`OAuth consent failed with invalid_state. Current URL: ${info.href}`));
          return;
        }
        if (info?.hasOAuthErrorText && info?.hasRetryButton) {
          settled = true;
          cleanup();
          reject(new Error(`OAuth consent page returned an error. Current URL: ${info.href}`));
          return;
        }
      }

      monitorTimer = setTimeout(monitorForOAuthFailure, 800);
    };

    // After step 7, the auth page shows a consent screen ("使用 ChatGPT 登录到 Codex")
    // with a "继续" button. We need to click it, which triggers the localhost redirect.
    (async () => {
      try {
        const signupTabId = await getTabId('signup-page');
        if (signupTabId) {
          await chrome.tabs.update(signupTabId, { active: true });
          await addLog('Step 8: Switching to auth page, clicking "继续" to complete OAuth...');
          await sendToContentScript('signup-page', {
            type: 'EXECUTE_STEP',
            step: 8,
            source: 'background',
            payload: {},
          });
        } else {
          await reuseOrCreateTab('signup-page', state.oauthUrl);
          await addLog('Step 8: Auth tab reopened...');
          await sendToContentScript('signup-page', {
            type: 'EXECUTE_STEP',
            step: 8,
            source: 'background',
            payload: {},
          });
        }
        monitorTimer = setTimeout(monitorForOAuthFailure, 800);
      } catch (err) {
        if (!settled) {
          settled = true;
          cleanup();
        }
        reject(err);
      }
    })();
  });
}

// ============================================================
// Step 9: VPS Verify (via vps-panel.js)
// ============================================================

function makeTimestampForFile() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

async function downloadAuthResultFile(state) {
  const callback = parseCallbackFromUrl(state.localhostUrl || '');
  if (!callback || !callback.code) {
    throw new Error('回调 URL 无法解析出 code，无法本地换取 token。');
  }
  if (callback.error) {
    throw new Error(`授权回调返回错误: ${callback.error}`);
  }
  if (!state.oauthCodeVerifier) {
    throw new Error('缺少 PKCE code_verifier，请重新从第1步开始。');
  }
  if (state.oauthState && callback.state !== state.oauthState) {
    throw new Error('回调 state 与本地记录不匹配，请重新开始流程。');
  }

  await addLog('Step 9: 正在本地换取 token...', 'info');
  const tokens = await exchangeTokenWithOpenAI(callback.code, state.oauthCodeVerifier);
  const payload = buildCodexTokenFile(tokens);
  const filename = `token_${Date.now()}.json`;
  const content = JSON.stringify(payload, null, 2);
  const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(content)}`;

  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false,
  });

  await addLog(`Step 9: 本地换取成功，已下载 ${filename}`, 'ok');
}

async function executeStep9(state) {
  if (!state.localhostUrl) {
    throw new Error('No localhost URL. Complete step 8 first.');
  }
  if (!state.vpsUrl) {
    await addLog('Step 9: 未填写 CPA 接口地址，切换为本地下载结果文件模式。', 'warn');
    await downloadAuthResultFile(state);
    await setStepStatus(9, 'completed');
    notifyStepComplete(9, { mode: 'download' });
    return;
  }

  await addLog('Step 9: Opening VPS panel...');

  let tabId = await getTabId('vps-panel');
  const alive = tabId && await isTabAlive('vps-panel');

  if (!alive) {
    // Create new tab
    const tab = await chrome.tabs.create({ url: state.vpsUrl, active: true });
    tabId = tab.id;
    await new Promise(resolve => {
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  } else {
    await chrome.tabs.update(tabId, { active: true });
  }

  // Inject scripts directly and wait for them to be ready
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/utils.js', 'content/vps-panel.js'],
  });
  await new Promise(r => setTimeout(r, 1000));

  // Send command directly — bypass queue/ready mechanism
  await addLog(`Step 9: Filling callback URL...`);
  await chrome.tabs.sendMessage(tabId, {
    type: 'EXECUTE_STEP',
    step: 9,
    source: 'background',
    payload: { localhostUrl: state.localhostUrl },
  });
}

// ============================================================
// Open Side Panel on extension icon click
// ============================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
