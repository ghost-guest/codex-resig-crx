// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts('data/names.js');

const LOG_PREFIX = '[MultiPage:bg]';
const DUCK_AUTOFILL_URL = 'https://duckduckgo.com/email/settings/autofill';
const STOP_ERROR_MESSAGE = 'Flow stopped by user.';
const HUMAN_STEP_DELAY_MIN = 700;
const HUMAN_STEP_DELAY_MAX = 2200;
const LOCAL_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const LOCAL_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const MAX_RESTARTS_PER_RUN = 2;
const NEXT_RUN_ALARM_NAME = 'multipage-next-run';

initializeSessionStorageAccess();

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
  loginVerificationCode: null,
  signupEmailSubmittedAt: null,
  localhostUrl: null,
  flowStartTime: null,
  tabRegistry: {},
  logs: [],
  vpsUrl: '',
  customPassword: '',
  mailProvider: '163', // 'qq' or '163'
  autoFetchEmailEnabled: true,
  emailPrefix: '',
  inbucketHost: '',
  inbucketMailbox: '',
  oauthCodeVerifier: null,
  oauthState: null,
  manualIntervention: null,
  scheduledNextRun: null,
  scheduledTotalRuns: null,
  scheduledResumeAt: null,
};

async function getState() {
  const state = await chrome.storage.session.get(null);
  return { ...DEFAULT_STATE, ...state };
}

async function initializeSessionStorageAccess() {
  try {
    if (chrome.storage?.session?.setAccessLevel) {
      await chrome.storage.session.setAccessLevel({
        accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
      });
      console.log(LOG_PREFIX, 'Enabled storage.session for content scripts');
    }
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to enable storage.session for content scripts:', err?.message || err);
  }
}

async function setState(updates) {
  console.log(LOG_PREFIX, 'storage.set:', JSON.stringify(updates).slice(0, 200));
  await chrome.storage.session.set(updates);
}

async function clearNextRunSchedule() {
  try {
    await chrome.alarms.clear(NEXT_RUN_ALARM_NAME);
  } catch {}
  await setState({
    scheduledNextRun: null,
    scheduledTotalRuns: null,
    scheduledResumeAt: null,
  });
}

async function scheduleNextRun(nextRun, totalRuns, delayMs = 60000) {
  const resumeAt = Date.now() + delayMs;
  await setState({
    scheduledNextRun: nextRun,
    scheduledTotalRuns: totalRuns,
    scheduledResumeAt: resumeAt,
    autoRunning: true,
  });
  chrome.alarms.create(NEXT_RUN_ALARM_NAME, { when: resumeAt });
  return resumeAt;
}

function broadcastDataUpdate(payload) {
  chrome.runtime.sendMessage({
    type: 'DATA_UPDATED',
    payload,
  }).catch(() => {});
}

async function setEmailState(email) {
  await setState({ email });
  broadcastDataUpdate({ email });
}

async function setPasswordState(password) {
  await setState({ password });
  broadcastDataUpdate({ password });
}

async function resetState() {
  console.log(LOG_PREFIX, 'Resetting all state');
  // Preserve settings and persistent data across resets
  const prev = await chrome.storage.session.get([
    'seenCodes',
    'seenInbucketMailIds',
    'accounts',
    'tabRegistry',
    'vpsUrl',
    'customPassword',
    'mailProvider',
    'autoFetchEmailEnabled',
    'emailPrefix',
    'inbucketHost',
    'inbucketMailbox',
  ]);
  await chrome.storage.session.clear();
  await chrome.storage.session.set({
    ...DEFAULT_STATE,
    seenCodes: prev.seenCodes || [],
    seenInbucketMailIds: prev.seenInbucketMailIds || [],
    accounts: prev.accounts || [],
    tabRegistry: prev.tabRegistry || {},
    vpsUrl: prev.vpsUrl || '',
    customPassword: prev.customPassword || '',
    mailProvider: prev.mailProvider || '163',
    autoFetchEmailEnabled: prev.autoFetchEmailEnabled !== false,
    emailPrefix: prev.emailPrefix || '',
    inbucketHost: prev.inbucketHost || '',
    inbucketMailbox: prev.inbucketMailbox || '',
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

async function unregisterTab(source) {
  const registry = await getTabRegistry();
  if (!registry[source]) return;
  registry[source] = null;
  await setState({ tabRegistry: registry });
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

async function closeRegisteredTab(source) {
  const tabId = await getTabId(source);
  if (tabId) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {}
  }
  await unregisterTab(source);
}

async function cleanupOAuthRunTabs() {
  await closeRegisteredTab('signup-page');
  await closeRegisteredTab('chatgpt');
  await closeRegisteredTab('vps-panel');
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

function cancelPendingCommands(reason = STOP_ERROR_MESSAGE) {
  for (const [source, pending] of pendingCommands.entries()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingCommands.delete(source);
    console.log(LOG_PREFIX, `Cancelled queued command for ${source}`);
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
    const currentTab = await chrome.tabs.get(tabId);
    const sameUrl = currentTab.url === url;

    const registry = await getTabRegistry();
    if (sameUrl) {
      await chrome.tabs.update(tabId, { active: true });

      if (options.inject) {
        if (registry[source]) registry[source].ready = false;
        await setState({ tabRegistry: registry });
        if (options.injectSource) {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (injectedSource) => {
              window.__MULTIPAGE_SOURCE = injectedSource;
            },
            args: [options.injectSource],
          });
        }
        await chrome.scripting.executeScript({
          target: { tabId },
          files: options.inject,
        });
      }

      const ready = await waitForContentScriptReady(source, tabId, options.readyTimeout || 15000);
      if (!ready) {
        throw new Error(`Content script on ${source} did not become ready after reuse`);
      }
      return tabId;
    }

    if (registry[source]) registry[source].ready = false;
    await setState({ tabRegistry: registry });
    await chrome.tabs.update(tabId, { url, active: true });
    console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}), navigated to ${url.slice(0, 60)}`);

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

    if (options.inject) {
      if (options.injectSource) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (injectedSource) => {
            window.__MULTIPAGE_SOURCE = injectedSource;
          },
          args: [options.injectSource],
        });
      }
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

  const tab = await chrome.tabs.create({ url, active: true });
  console.log(LOG_PREFIX, `Created new tab ${source} (${tab.id})`);

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
    if (options.injectSource) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (injectedSource) => {
          window.__MULTIPAGE_SOURCE = injectedSource;
        },
        args: [options.injectSource],
      });
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: options.inject,
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

let stopRequested = false;

function isStopError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return message === STOP_ERROR_MESSAGE;
}

function clearStopRequest() {
  stopRequested = false;
}

function throwIfStopped() {
  if (stopRequested) {
    throw new Error(STOP_ERROR_MESSAGE);
  }
}

async function sleepWithStop(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    throwIfStopped();
    await new Promise(r => setTimeout(r, Math.min(100, ms - (Date.now() - start))));
  }
}

async function humanStepDelay(min = HUMAN_STEP_DELAY_MIN, max = HUMAN_STEP_DELAY_MAX) {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleepWithStop(duration);
}

async function clickWithDebugger(tabId, rect) {
  if (!tabId) {
    throw new Error('No auth tab found for debugger click.');
  }
  if (!rect || !Number.isFinite(rect.centerX) || !Number.isFinite(rect.centerY)) {
    throw new Error('Step 8 debugger fallback needs a valid button position.');
  }

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    throw new Error(
      `Debugger attach failed during step 8 fallback: ${err.message}. ` +
      'If DevTools is open on the auth tab, close it and retry.'
    );
  }

  try {
    const x = Math.round(rect.centerX);
    const y = Math.round(rect.centerY);

    await chrome.debugger.sendCommand(target, 'Page.bringToFront');
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function broadcastStopToContentScripts() {
  const registry = await getTabRegistry();
  for (const entry of Object.values(registry)) {
    if (!entry?.tabId) continue;
    try {
      await chrome.tabs.sendMessage(entry.tabId, {
        type: 'STOP_FLOW',
        source: 'background',
        payload: {},
      });
    } catch {}
  }
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== NEXT_RUN_ALARM_NAME) return;

  (async () => {
    const state = await getState();
    const nextRun = Number(state.scheduledNextRun || 0);
    const totalRuns = Number(state.scheduledTotalRuns || 0);

    if (!nextRun || !totalRuns || state.autoRunning === false) {
      await clearNextRunSchedule();
      return;
    }

    await setState({
      scheduledNextRun: null,
      scheduledTotalRuns: null,
      scheduledResumeAt: null,
    });
    clearStopRequest();
    await addLog(`Resuming scheduled auto run ${nextRun}/${totalRuns} after cooldown...`, 'info');
    autoRunLoop(totalRuns, nextRun);
  })().catch((err) => {
    console.error(LOG_PREFIX, 'Failed to resume auto run from alarm:', err);
  });
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
      if (stopRequested) {
        await setStepStatus(message.step, 'stopped');
        notifyStepError(message.step, STOP_ERROR_MESSAGE);
        return { ok: true };
      }
      await setStepStatus(message.step, 'completed');
      await addLog(`Step ${message.step} completed`, 'ok');
      await handleStepData(message.step, message.payload);
      notifyStepComplete(message.step, message.payload);
      return { ok: true };
    }

    case 'STEP_ERROR': {
      if (isStopError(message.error)) {
        await setStepStatus(message.step, 'stopped');
        await addLog(`Step ${message.step} stopped by user`, 'warn');
        notifyStepError(message.step, message.error);
        return { ok: true };
      }

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
      clearStopRequest();
      await clearNextRunSchedule();
      await resetState();
      await addLog('Flow reset', 'info');
      return { ok: true };
    }

    case 'EXECUTE_STEP': {
      clearStopRequest();
      const step = message.payload.step;
      if (message.payload.email) {
        await setEmailState(message.payload.email);
      }
      if (message.payload.emailPrefix !== undefined) {
        await setState({ emailPrefix: message.payload.emailPrefix });
      }
      await executeStep(step);
      return { ok: true };
    }

    case 'AUTO_RUN': {
      clearStopRequest();
      await clearNextRunSchedule();
      const totalRuns = message.payload?.totalRuns || 1;
      autoRunLoop(totalRuns);  // fire-and-forget
      return { ok: true };
    }

    case 'RESUME_AUTO_RUN': {
      clearStopRequest();
      if (message.payload.email) {
        await setEmailState(message.payload.email);
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
      if (message.payload.customPassword !== undefined) updates.customPassword = message.payload.customPassword;
      if (message.payload.mailProvider !== undefined) updates.mailProvider = message.payload.mailProvider;
      if (message.payload.autoFetchEmailEnabled !== undefined) updates.autoFetchEmailEnabled = !!message.payload.autoFetchEmailEnabled;
      if (message.payload.emailPrefix !== undefined) updates.emailPrefix = message.payload.emailPrefix;
      if (message.payload.inbucketHost !== undefined) updates.inbucketHost = message.payload.inbucketHost;
      if (message.payload.inbucketMailbox !== undefined) updates.inbucketMailbox = message.payload.inbucketMailbox;
      await setState(updates);
      return { ok: true };
    }

    // Side panel data updates
    case 'SAVE_EMAIL': {
      await setEmailState(message.payload.email);
      return { ok: true, email: message.payload.email };
    }

    case 'FETCH_DUCK_EMAIL': {
      clearStopRequest();
      const email = await fetchDuckEmail(message.payload || {});
      return { ok: true, email };
    }

    case 'STOP_FLOW': {
      await requestStop();
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
        broadcastDataUpdate({ oauthUrl: payload.oauthUrl });
      }
      break;
    case 3:
      if (payload.email) await setEmailState(payload.email);
      await setState({ signupEmailSubmittedAt: payload.submittedAt || Date.now() });
      break;
    case 4:
      if (payload.emailTimestamp) await setState({ lastEmailTimestamp: payload.emailTimestamp });
      break;
    case 8:
      if (payload.localhostUrl) {
        await setState({ localhostUrl: payload.localhostUrl });
        broadcastDataUpdate({ localhostUrl: payload.localhostUrl });
      }
      break;
  }
}

// ============================================================
// Step Completion Waiting
// ============================================================

// Map of step -> { resolve, reject } for waiting on step completion
const stepWaiters = new Map();
let resumeWaiter = null;
let manualInterventionWaiter = null;

function waitForStepComplete(step, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    throwIfStopped();
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

async function markRunningStepsStopped() {
  const state = await getState();
  const runningSteps = Object.entries(state.stepStatuses || {})
    .filter(([, status]) => status === 'running')
    .map(([step]) => Number(step));

  for (const step of runningSteps) {
    await setStepStatus(step, 'stopped');
  }
}

async function requestStop() {
  if (stopRequested) return;

  stopRequested = true;
  await clearNextRunSchedule();
  cancelPendingCommands();
  if (webNavListener) {
    chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
    webNavListener = null;
  }

  await addLog('Stop requested. Cancelling current operations...', 'warn');
  await broadcastStopToContentScripts();

  for (const waiter of stepWaiters.values()) {
    waiter.reject(new Error(STOP_ERROR_MESSAGE));
  }
  stepWaiters.clear();

  if (resumeWaiter) {
    resumeWaiter.reject(new Error(STOP_ERROR_MESSAGE));
    resumeWaiter = null;
  }

  if (manualInterventionWaiter) {
    manualInterventionWaiter.reject(new Error(STOP_ERROR_MESSAGE));
    manualInterventionWaiter = null;
  }

  await markRunningStepsStopped();
  autoRunActive = false;
  await setState({ autoRunning: false, manualIntervention: null });
  chrome.runtime.sendMessage({
    type: 'AUTO_RUN_STATUS',
    payload: { phase: 'stopped', currentRun: autoRunCurrentRun, totalRuns: autoRunTotalRuns },
  }).catch(() => {});
}

function makeRunRestartError(message) {
  const err = new Error(message);
  err.code = 'RUN_RESTART';
  return err;
}

function isRunRestartError(err) {
  return err?.code === 'RUN_RESTART';
}

function makeRunSkipError(message) {
  const err = new Error(message);
  err.code = 'RUN_SKIP';
  return err;
}

function isRunSkipError(err) {
  return err?.code === 'RUN_SKIP';
}

function isNavigationChannelClosedError(err) {
  const message = `${err?.message || err || ''}`.toLowerCase();
  return message.includes('message channel is closed')
    || message.includes('message port closed')
    || message.includes('back/forward cache')
    || message.includes('a listener indicated an asynchronous response by returning true');
}

function isStep3AccountCreationError(err) {
  const message = `${err?.message || err || ''}`.toLowerCase();
  return message.includes('account_creation_failed')
    || message.includes('创建帐户失败')
    || message.includes('创建账户失败')
    || message.includes('failed to create account')
    || message.includes('create account failed');
}

async function completeStepFromBackground(step, payload = {}, source = 'background') {
  await setStepStatus(step, 'completed');
  await addLog(`Step ${step} completed (${source})`, 'ok');
  await handleStepData(step, payload);
  notifyStepComplete(step, payload);
}

async function reloadRegisteredTab(source) {
  const tabId = await getTabId(source);
  if (!tabId) {
    throw new Error(`No tab registered for ${source}.`);
  }

  const registry = await getTabRegistry();
  if (registry[source]) {
    registry[source].ready = false;
    await setState({ tabRegistry: registry });
  }

  await chrome.tabs.reload(tabId);
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });

  const ready = await waitForContentScriptReady(source, tabId, 15000);
  if (!ready) {
    throw new Error(`Content script on ${source} did not become ready after reload`);
  }

  return tabId;
}

async function handleStep3AccountCreationFailure(err, state, run, totalRuns) {
  await addLog(`Step 3: Detected account creation failure, refreshing signup page and retrying once...`, 'warn');
  await reloadRegisteredTab('signup-page');
  await sleepRandom(1600, 2600);
  await ensureSignupFormReady(state);

  try {
    await executeStepAndWait(3, 3200, 4800);
    return true;
  } catch (retryErr) {
    if (!isStep3AccountCreationError(retryErr)) {
      throw retryErr;
    }

    if (totalRuns > 1 && run < totalRuns) {
      await addLog(`Step 3: Refresh retry still failed, skipping current run and moving to next run.`, 'warn');
      return false;
    }

    throw retryErr;
  }
}

async function waitBeforeNextRun(run, totalRuns) {
  if (totalRuns <= 1 || run >= totalRuns) return false;
  await addLog(`Run ${run}/${totalRuns} finished. Waiting 60s before next run...`, 'info');
  const resumeAt = await scheduleNextRun(run + 1, totalRuns, 60000);
  chrome.runtime.sendMessage({
    type: 'AUTO_RUN_STATUS',
    payload: {
      phase: 'cooldown',
      currentRun: run,
      nextRun: run + 1,
      totalRuns,
      resumeAt,
    },
  }).catch(() => {});
  return true;
}

// ============================================================
// Step Execution
// ============================================================

async function executeStep(step) {
  console.log(LOG_PREFIX, `Executing step ${step}`);
  throwIfStopped();
  await setStepStatus(step, 'running');
  await addLog(`Step ${step} started`);
  await humanStepDelay();

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
    if (isStopError(err)) {
      await setStepStatus(step, 'stopped');
      await addLog(`Step ${step} stopped by user`, 'warn');
      notifyStepError(step, err.message);
      throw err;
    }
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
  throwIfStopped();
  const promise = waitForStepComplete(step, timeoutMs);
  await executeStep(step);
  await promise;
  if (maxDelayAfter > 0) {
    await sleepWithStop(getRandomDelay(minDelayAfter, maxDelayAfter));
  }
}

async function fetchDuckEmail(options = {}) {
  throwIfStopped();
  const { generateNew = true } = options;

  await addLog(`Duck Mail: Opening autofill settings (${generateNew ? 'generate new' : 'reuse current'})...`);
  await reuseOrCreateTab('duck-mail', DUCK_AUTOFILL_URL);

  const result = await sendToContentScript('duck-mail', {
    type: 'FETCH_DUCK_EMAIL',
    source: 'background',
    payload: { generateNew },
  });

  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result?.email) {
    throw new Error('Duck email not returned.');
  }

  await setEmailState(result.email);
  await addLog(`Duck Mail: ${result.generated ? 'Generated' : 'Loaded'} ${result.email}`, 'ok');
  return result.email;
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

async function isSignupVerificationPageReady() {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) return false;

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: signupTabId },
    func: () => {
      const hasCodeInput = !!document.querySelector(
        'input[name="code"], input[name="otp"], input[maxlength="1"], input[inputmode="numeric"]'
      );
      const hasPasswordInput = !!document.querySelector('input[type="password"]');
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const hasVerificationHints = /verification|verify|验证码|确认邮箱|check your email|代码/.test(bodyText);
      return {
        hasCodeInput,
        hasPasswordInput,
        hasVerificationHints,
        href: location.href,
      };
    },
  });

  const info = result?.result;
  if (!info) return false;
  if (info.hasCodeInput) return true;
  if (info.hasPasswordInput) return false;
  return info.hasVerificationHints;
}

async function inspectSignupPageState() {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) return null;

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: signupTabId },
    func: () => {
      const getActionText = (el) => [
        el?.textContent || '',
        el?.value || '',
        el?.getAttribute?.('aria-label') || '',
        el?.getAttribute?.('title') || '',
      ].join(' ').replace(/\s+/g, ' ').trim();

      const actionSelector = 'button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"]';
      const actions = Array.from(document.querySelectorAll(actionSelector));
      const hasRegisterAction = actions.some((el) => /sign\s*up|register|create\s*account|注册/i.test(getActionText(el)));
      const hasEmailInput = !!document.querySelector(
        'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email" i], input[placeholder*="Email"]'
      );
      const hasPasswordInput = !!document.querySelector('input[type="password"]');
      const hasCodeInput = !!document.querySelector(
        'input[name="code"], input[name="otp"], input[type="text"][maxlength="6"], input[inputmode="numeric"]'
      );
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const hasVerificationHints = /verification|verify|验证码|确认邮箱|check your email|enter code|代码/.test(bodyText);

      return {
        href: location.href,
        title: document.title || '',
        hasRegisterAction,
        hasEmailInput,
        hasPasswordInput,
        hasCodeInput,
        hasVerificationHints,
      };
    },
  });

  return result?.result || null;
}

async function waitForSignupFormReady(timeoutMs = 15000, intervalMs = 800) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const info = await inspectSignupPageState();
    if (info?.hasEmailInput || info?.hasPasswordInput) return true;
    await sleepRandom(intervalMs, intervalMs + 300);
  }

  const finalInfo = await inspectSignupPageState();
  return !!(finalInfo?.hasEmailInput || finalInfo?.hasPasswordInput);
}

async function ensureSignupFormReady(state) {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    throw new Error('Signup page tab was closed. Cannot prepare signup form.');
  }

  await chrome.tabs.update(signupTabId, { active: true });

  let info = await inspectSignupPageState();
  if (info?.hasEmailInput || info?.hasPasswordInput) {
    return true;
  }

  await addLog(`Step 3: Signup form not ready on ${info?.href || 'unknown page'}, trying browser back...`, 'warn');
  const [backResult] = await chrome.scripting.executeScript({
    target: { tabId: signupTabId },
    func: () => {
      if (history.length > 1) {
        history.back();
        return true;
      }
      return false;
    },
  });

  if (backResult?.result) {
    await sleepRandom(1600, 2600);
    if (await waitForSignupFormReady(12000, 900)) {
      await addLog('Step 3: Signup form restored after browser back.', 'ok');
      return true;
    }
  }

  info = await inspectSignupPageState();
  await addLog(`Step 3: Signup form still unavailable (${info?.href || 'unknown page'}), reopening auth page...`, 'warn');
  await reuseOrCreateTab('signup-page', state.oauthUrl);
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 2,
    source: 'background',
    payload: {},
  });

  if (await waitForSignupFormReady(20000, 1000)) {
    await addLog('Step 3: Signup form restored after reopening OAuth page.', 'ok');
    return true;
  }

  info = await inspectSignupPageState();
  throw new Error(`Could not restore signup form before step 3. Current page: ${info?.href || 'unknown'}`);
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

async function inspectSignupFatalRetryPage() {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) return null;

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: signupTabId },
      func: () => {
        const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        const compactText = bodyText.toLowerCase();
        const hasRetryButton = /(^|\s)(重试|retry)(\s|$)/i.test(bodyText);
        const hasMaxCheckAttempts = /max_check_attempts/i.test(bodyText);
        const hasFatalErrorText = /糟糕[，,]?\s*出错了|验证过程中出错|something went wrong|an error occurred/i.test(bodyText);
        return {
          href: location.href,
          bodyText: bodyText.slice(0, 500),
          hasRetryButton,
          hasMaxCheckAttempts,
          hasFatalErrorText,
          isFatalRetryPage: (hasRetryButton && hasFatalErrorText) || hasMaxCheckAttempts,
        };
      },
    });

    return result?.result || null;
  } catch {
    return null;
  }
}

async function waitForSignupVerificationPageReady(timeoutMs = 20000, intervalMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isSignupVerificationPageReady()) return true;
    await sleepRandom(intervalMs, intervalMs + 300);
  }
  return await isSignupVerificationPageReady();
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
 

function waitForManualIntervention() {
  return new Promise((resolve, reject) => {
    throwIfStopped();
    manualInterventionWaiter = { resolve, reject };
  });
}

async function resumeManualIntervention() {
  throwIfStopped();
  if (manualInterventionWaiter) {
    manualInterventionWaiter.resolve();
    manualInterventionWaiter = null;
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
    if (step === 3) {
      await setState({ signupEmailSubmittedAt: Date.now() });
    }
    await setStepStatus(step, 'completed');
    await addLog(`Step ${step}: 人工处理后已继续下一步`, 'ok');
  }
  chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'running', currentRun, totalRuns } }).catch(() => {});
}

async function requestManualInterventionOrSkip(step, message, currentRun, totalRuns) {
  if (totalRuns > 1 && currentRun < totalRuns) {
    throw makeRunSkipError(`Step ${step} requires manual intervention in multi-run mode: ${message}`);
  }
  await requestManualIntervention(step, message, currentRun, totalRuns);
}

async function executeStepWithManualFallback(step, currentRun, totalRuns, minDelayAfter, maxDelayAfter, timeoutMs = 120000) {
  try {
    await executeStepAndWait(step, minDelayAfter, maxDelayAfter, timeoutMs);
  } catch (err) {
    if (isRunRestartError(err) || isRunSkipError(err)) {
      throw err;
    }
    await requestManualInterventionOrSkip(step, err.message, currentRun, totalRuns);
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
async function autoRunLoop(totalRuns, startRun = 1) {
  if (autoRunActive) {
    await addLog('Auto run already in progress', 'warn');
    return;
  }

  clearStopRequest();
  autoRunActive = true;
  autoRunTotalRuns = totalRuns;
  await setState({ autoRunning: true });

  const runRestartCounts = new Map();
  let nextRunScheduled = false;

  for (let run = startRun; run <= totalRuns; run++) {
    autoRunCurrentRun = run;

    // Reset everything at the start of each run (keep VPS/mail settings)
    const prevState = await getState();
    const keepSettings = {
      vpsUrl: prevState.vpsUrl,
      customPassword: prevState.customPassword || '',
      mailProvider: prevState.mailProvider,
      autoFetchEmailEnabled: prevState.autoFetchEmailEnabled !== false,
      emailPrefix: prevState.emailPrefix || '',
      inbucketHost: prevState.inbucketHost || '',
      inbucketMailbox: prevState.inbucketMailbox || '',
      autoRunning: true,
    };
    await resetState();
    await setState(keepSettings);
    await cleanupOAuthRunTabs();
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_RESET' }).catch(() => {});
    await sleepWithStop(500);
    await addLog(`Run ${run}/${totalRuns}: Cleared OAuth-related tabs and state, will fetch a fresh OAuth link.`, 'info');

    await addLog(`=== Auto Run ${run}/${totalRuns} — Phase 1: Get OAuth link & open signup ===`, 'info');
    const status = (phase) => ({ type: 'AUTO_RUN_STATUS', payload: { phase, currentRun: run, totalRuns } });

    try {
      throwIfStopped();
      chrome.runtime.sendMessage(status('running')).catch(() => {});

      await executeStepWithManualFallback(1, run, totalRuns, 2600, 3800);
      await executeStepWithManualFallback(2, run, totalRuns, 2600, 3800);

      const runState = await getState();
      if (runState.mailProvider === '2925') {
        if (!runState.emailPrefix) {
          await addLog('Cannot continue: 2925 邮箱前缀未设置，请在侧边栏填写。', 'error');
          chrome.runtime.sendMessage(status('stopped')).catch(() => {});
          break;
        }
        await addLog(`=== Run ${run}/${totalRuns} — 2925 模式，将在步骤3自动生成邮箱 ===`, 'info');
      } else {
        let emailReady = false;
        if (runState.autoFetchEmailEnabled !== false) {
          try {
            const duckEmail = await fetchDuckEmail({ generateNew: true });
            await addLog(`=== Run ${run}/${totalRuns} — Duck email ready: ${duckEmail} ===`, 'ok');
            emailReady = true;
          } catch (err) {
            await addLog(`Duck Mail auto-fetch failed: ${err.message}`, 'warn');
          }
        } else {
          const existingEmail = (runState.email || '').trim();
          if (existingEmail) {
            await addLog(`=== Run ${run}/${totalRuns} — Manual email mode, using preset email: ${existingEmail} ===`, 'info');
            emailReady = true;
          } else {
            await addLog(`=== Run ${run}/${totalRuns} — Manual email mode enabled, waiting for you to paste email ===`, 'info');
          }
        }

        if (!emailReady) {
          await addLog(`=== Run ${run}/${totalRuns} PAUSED: ${runState.autoFetchEmailEnabled !== false ? 'Fetch Duck email or paste manually' : 'Paste email manually'}, then continue ===`, 'warn');
          chrome.runtime.sendMessage(status('waiting_email')).catch(() => {});
          await waitForResume();
          const resumedState = await getState();
          if (!resumedState.email) {
            await addLog('Cannot resume: no email address.', 'error');
            break;
          }
        }
      }

      await addLog(`=== Run ${run}/${totalRuns} — Phase 2: Register, verify, login, complete ===`, 'info');
      chrome.runtime.sendMessage(status('running')).catch(() => {});

      let continueCurrentRun = true;
      try {
        await executeStepAndWait(3, 3200, 4800);
      } catch (err) {
        if (isStep3AccountCreationError(err)) {
          continueCurrentRun = await handleStep3AccountCreationFailure(err, await getState(), run, totalRuns);
        } else {
          await requestManualInterventionOrSkip(3, err.message, run, totalRuns);
        }
      }

      if (!continueCurrentRun) {
        await addLog(`=== Run ${run}/${totalRuns} skipped after step 3 failure; starting next run ===`, 'warn');
        nextRunScheduled = await waitBeforeNextRun(run, totalRuns);
        if (nextRunScheduled) {
          autoRunActive = false;
          clearStopRequest();
          return;
        }
        continue;
      }

      let signupVerificationReady = await waitForSignupVerificationPageReady(20000, 1200);
      for (let retry = 1; !signupVerificationReady && retry <= 2; retry++) {
        await addLog(`Step 3 guard: signup verification page not ready, retrying step 3 (${retry}/2)...`, 'warn');
        await executeStepWithManualFallback(3, run, totalRuns, 3200, 4800);
        signupVerificationReady = await waitForSignupVerificationPageReady(20000, 1200);
      }
      if (!signupVerificationReady) {
        await requestManualInterventionOrSkip(3, '仍未进入注册验证码页面，请确认已回到注册页并成功提交邮箱/密码，然后继续。', run, totalRuns);
      }

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
        const fatalRetryPage = await inspectSignupFatalRetryPage();
        if (fatalRetryPage?.isFatalRetryPage) {
          await addLog(
            `Step 4: Detected fatal verification error page (${fatalRetryPage.hasMaxCheckAttempts ? 'max_check_attempts' : 'retry page'}).`,
            'warn'
          );
          if (totalRuns > 1 && run < totalRuns) {
            await addLog(`=== Run ${run}/${totalRuns} skipped due to fatal verification error page; starting next run ===`, 'warn');
            nextRunScheduled = await waitBeforeNextRun(run, totalRuns);
            if (nextRunScheduled) {
              autoRunActive = false;
              clearStopRequest();
              return;
            }
            continue;
          }
          await requestManualIntervention(
            4,
            `检测到验证错误页：${fatalRetryPage.hasMaxCheckAttempts ? 'max_check_attempts' : '需要点击重试的错误页'}，请人工处理或重试。`,
            run,
            totalRuns
          );
        } else {
          await requestManualInterventionOrSkip(4, '仍未进入姓名/生日页面，请人工确认注册验证码页面并处理，然后继续。', run, totalRuns);
        }
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
        await requestManualInterventionOrSkip(7, '仍未进入 OAuth 同意页，请人工确认登录验证码页面并处理，然后继续。', run, totalRuns);
      }

      await executeStepWithRunRestartFallback(8, run, totalRuns, 2400, 3600);
      await executeStepWithManualFallback(9, run, totalRuns, 1600, 2600);

      await addLog(`=== Run ${run}/${totalRuns} COMPLETE! ===`, 'ok');
      nextRunScheduled = await waitBeforeNextRun(run, totalRuns);
      if (nextRunScheduled) {
        autoRunActive = false;
        clearStopRequest();
        return;
      }

    } catch (err) {
      if (isStopError(err)) {
        await addLog(`Run ${run}/${totalRuns} stopped by user`, 'warn');
        chrome.runtime.sendMessage(status('stopped')).catch(() => {});
        break;
      }

      if (isRunSkipError(err)) {
        await addLog(`Run ${run}/${totalRuns} 命中需跳过当前轮错误，正在进入下一轮：${err.message}`, 'warn');
        nextRunScheduled = await waitBeforeNextRun(run, totalRuns);
        if (nextRunScheduled) {
          autoRunActive = false;
          clearStopRequest();
          return;
        }
        continue;
      }

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
  if (stopRequested) {
    await addLog(`=== Stopped after ${Math.max(0, completedRuns - 1)}/${autoRunTotalRuns} runs ===`, 'warn');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'stopped', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  } else if (completedRuns >= autoRunTotalRuns) {
    await addLog(`=== All ${autoRunTotalRuns} runs completed successfully ===`, 'ok');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'complete', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  } else {
    await addLog(`=== Stopped after ${completedRuns}/${autoRunTotalRuns} runs ===`, 'warn');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'stopped', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  }
  autoRunActive = false;
  await clearNextRunSchedule();
  await setState({ autoRunning: false });
  clearStopRequest();
}

function waitForResume() {
  return new Promise((resolve, reject) => {
    throwIfStopped();
    resumeWaiter = { resolve, reject };
  });
}

async function resumeAutoRun() {
  throwIfStopped();
  const state = await getState();
  if (!state.email) {
    await addLog('Cannot resume: no email address. Paste email in Side Panel first.', 'error');
    return;
  }
  if (resumeWaiter) {
    resumeWaiter.resolve();
    resumeWaiter = null;
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

  const password = state.customPassword || generatePassword();
  await setPasswordState(password);

  // Save account record
  const accounts = state.accounts || [];
  accounts.push({ email, password, createdAt: new Date().toISOString() });
  await setState({ accounts });

  await addLog(
    `Step 3: Filling email ${email}, password ${state.customPassword ? 'customized' : 'generated'} (${password.length} chars)`
  );

  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    throw new Error('Signup page tab was closed. Cannot fill email/password.');
  }

  await chrome.tabs.update(signupTabId, { active: true });
  await addLog('Step 3: Switched back to signup page tab before filling form...');
  await ensureSignupFormReady(state);

  try {
    await sendToContentScript('signup-page', {
      type: 'EXECUTE_STEP',
      step: 3,
      source: 'background',
      payload: { email, password },
    });
  } catch (err) {
    if (!isNavigationChannelClosedError(err)) {
      throw err;
    }

    await addLog('Step 3: Signup page navigated during submit, waiting for the new page state to settle...', 'info');
    await waitForContentScriptReady('signup-page', signupTabId, 15000).catch(() => false);

    let verificationReady = await waitForSignupVerificationPageReady(25000, 1000);
    if (verificationReady) {
      await addLog('Step 3: Verification page detected after navigation; continuing automatically.', 'ok');
      await completeStepFromBackground(3, { email, submittedAt: Date.now() }, 'background navigation check');
      return;
    }

    const pageState = await inspectSignupPageState();
    if (pageState?.hasEmailInput || pageState?.hasPasswordInput || pageState?.hasRegisterAction) {
      await addLog('Step 3: Page is still on signup form after navigation close, retrying submit once...', 'warn');
      await ensureSignupFormReady(state);

      try {
        await sendToContentScript('signup-page', {
          type: 'EXECUTE_STEP',
          step: 3,
          source: 'background',
          payload: { email, password },
        });
      } catch (retryErr) {
        if (!isNavigationChannelClosedError(retryErr)) {
          throw retryErr;
        }
        await addLog('Step 3: Retry also navigated during reply, verifying verification page state again...', 'info');
      }

      verificationReady = await waitForSignupVerificationPageReady(25000, 1000);
      if (verificationReady) {
        await addLog('Step 3: Verification page detected after retry; continuing automatically.', 'ok');
        await completeStepFromBackground(3, { email, submittedAt: Date.now() }, 'background retry navigation check');
        return;
      }
    }

    throw err;
  }
}

// ============================================================
// Step 4: Get Signup Verification Code (qq-mail.js polls, then fills in signup-page.js)
// ============================================================

function normalizeInbucketOrigin(rawHost) {
  const trimmed = (rawHost || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, '');
  }
  return `https://${trimmed.replace(/\/+$/, '')}`;
}

async function resendSignupVerificationEmail() {
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
}

async function resendLoginVerificationEmail() {
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
}

async function pollMailForVerificationCode(mail, step, payload, navigationRetries = 2) {
  let lastError = null;

  for (let attempt = 1; attempt <= navigationRetries + 1; attempt++) {
    try {
      const result = await sendToContentScript(mail.source, {
        type: 'POLL_EMAIL',
        step,
        source: 'background',
        payload,
      });

      if (result?.stopped) {
        throw new Error(result.error || STOP_ERROR_MESSAGE);
      }
      if (result?.error) {
        if (/No .*email found|No matching verification email found/i.test(result.error)) {
          return null;
        }
        throw new Error(result.error);
      }

      return result?.code ? result : null;
    } catch (err) {
      lastError = err;
      if (!isNavigationChannelClosedError(err) || attempt > navigationRetries) {
        throw err;
      }

      await addLog(
        `Step ${step}: ${mail.label} page reloaded during polling, waiting for content script and retrying (${attempt}/${navigationRetries})...`,
        'warn'
      );
      const mailTabId = await getTabId(mail.source);
      if (mailTabId) {
        await waitForContentScriptReady(mail.source, mailTabId, 15000);
        await chrome.tabs.update(mailTabId, { active: true });
      }
      await sleepRandom(1200, 2200);
    }
  }

  throw lastError || new Error('Unknown mail polling failure.');
}

function getMailConfig(state) {
  const provider = state.mailProvider || 'qq';
  if (provider === '163') {
    return { source: 'mail-163', url: 'https://mail.163.com/js6/main.jsp?df=mail163_letter#module=mbox.ListModule%7C%7B%22fid%22%3A1%2C%22order%22%3A%22date%22%2C%22desc%22%3Atrue%7D', label: '163 Mail' };
  }
  if (provider === '2925') {
    return { source: 'mail-2925', url: 'https://2925.com/#/mailList', label: '2925 Mail' };
  }
  if (provider === 'inbucket') {
    const host = normalizeInbucketOrigin(state.inbucketHost);
    const mailbox = (state.inbucketMailbox || '').trim();
    if (!host) {
      throw new Error('Inbucket host not set. Please enter Inbucket host in the side panel.');
    }
    if (!mailbox) {
      throw new Error('Inbucket mailbox not set. Please enter mailbox name in the side panel.');
    }
    return {
      source: 'inbucket-mail',
      url: `${host}/m/${encodeURIComponent(mailbox)}/`,
      label: 'Inbucket Mailbox',
      inject: ['content/utils.js', 'content/inbucket-mail.js'],
      injectSource: 'inbucket-mail',
    };
  }
  return { source: 'qq-mail', url: 'https://wx.mail.qq.com/', label: 'QQ Mail' };
}

async function executeStep4(state) {
  const mail = getMailConfig(state);
  await addLog(`Step 4: Opening ${mail.label}...`);

  const alive = await isTabAlive(mail.source);
  if (alive) {
    const tabId = await getTabId(mail.source);
    await chrome.tabs.update(tabId, { active: true });
    if (mail.inject) {
      await reuseOrCreateTab(mail.source, mail.url, {
        inject: mail.inject,
        injectSource: mail.injectSource,
      });
    }
  } else {
    await reuseOrCreateTab(mail.source, mail.url, mail.inject ? {
      inject: mail.inject,
      injectSource: mail.injectSource,
    } : {});
  }

  const senderFilters = ['openai', 'noreply', 'verify', 'auth', 'duckduckgo', 'forward'];
  const subjectFilters = ['verify', 'verification', 'code', '验证', 'confirm'];
  let filterAfterTimestamp = mail.source === 'qq-mail' ? null : (state.signupEmailSubmittedAt || Date.now());
  let currentState = state;

  if (currentState.signupVerificationCode) {
    await addLog(`Step 4: Previous signup code ${currentState.signupVerificationCode} was not accepted, requesting a new code before polling...`, 'warn');
    await resendSignupVerificationEmail();
    filterAfterTimestamp = mail.source === 'qq-mail' ? null : Date.now();
    await sleepRandom(1800, 3200);

    const mailTabId = await getTabId(mail.source);
    if (mailTabId) {
      await chrome.tabs.update(mailTabId, { active: true });
    }
  }

  for (let stage = 1; stage <= 2; stage++) {
    const stageLabel = stage === 1 ? 'initial' : 'after resend';

    for (let attempt = 1; attempt <= 2; attempt++) {
      const timeHint = filterAfterTimestamp
        ? `, only accepting emails after ${new Date(filterAfterTimestamp).toLocaleTimeString('zh-CN', { hour12: false })}`
        : ', using latest matching QQ email and excluding previously used codes';
      await addLog(`Step 4: Polling signup verification code (${stageLabel} ${attempt}/2)${timeHint}...`);

      const result = await pollMailForVerificationCode(mail, 4, {
        filterAfterTimestamp,
        senderFilters,
        subjectFilters,
        maxAttempts: 8,
        intervalMs: 3000,
        excludeCodes: currentState.signupVerificationCode ? [currentState.signupVerificationCode] : [],
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

      await addLog(`Step 4: No usable signup code found in ${stageLabel} poll ${attempt}/2.`, 'warn');
      currentState = await getState();
    }

    if (stage === 1) {
      await addLog('Step 4: No usable signup code after 2 polls, requesting resend verification email...', 'warn');
      await resendSignupVerificationEmail();

      filterAfterTimestamp = mail.source === 'qq-mail' ? null : Date.now();
      await addLog(
        filterAfterTimestamp
          ? `Step 4: Resend verification email clicked, switching freshness threshold to ${new Date(filterAfterTimestamp).toLocaleTimeString('zh-CN', { hour12: false })}.`
          : 'Step 4: Resend verification email clicked, QQ mode will fetch the latest matching email and skip the previously used code.',
        'info'
      );
      await sleepRandom(1800, 3200);

      const mailTabId = await getTabId(mail.source);
      if (mailTabId) {
        await chrome.tabs.update(mailTabId, { active: true });
      }
    }
  }

  throw makeRunRestartError('Step 4: No usable signup verification code found after 2 polls, resend, and 2 more polls.');
}

// ============================================================
// Step 5: Fill Name & Birthday (via signup-page.js)
// ============================================================

async function executeStep5(state) {
  const { firstName, lastName } = generateRandomName();
  const { year, month, day } = generateRandomBirthday();
  const age = new Date().getFullYear() - Number(year);

  await addLog(`Step 5: Generated name: ${firstName} ${lastName}, Birthday: ${year}-${month}-${day}`);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 5,
    source: 'background',
    payload: { firstName, lastName, age, year, month, day },
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
    if (mail.inject) {
      await reuseOrCreateTab(mail.source, mail.url, {
        inject: mail.inject,
        injectSource: mail.injectSource,
      });
    }
  } else {
    await reuseOrCreateTab(mail.source, mail.url, mail.inject ? {
      inject: mail.inject,
      injectSource: mail.injectSource,
    } : {});
  }

  const senderFilters = ['openai', 'noreply', 'verify', 'auth', 'chatgpt', 'duckduckgo', 'forward'];
  const subjectFilters = ['your chatgpt code is'];
  let filterAfterTimestamp = mail.source === 'qq-mail' ? null : Date.now();
  let currentState = state;

  if (currentState.loginVerificationCode) {
    await addLog(`Step 7: Previous login code ${currentState.loginVerificationCode} was not accepted, requesting a new code before polling...`, 'warn');
    await resendLoginVerificationEmail();
    filterAfterTimestamp = mail.source === 'qq-mail' ? null : Date.now();
    await sleepRandom(1800, 3200);

    const mailTabId = await getTabId(mail.source);
    if (mailTabId) {
      await chrome.tabs.update(mailTabId, { active: true });
    }
  }

  for (let stage = 1; stage <= 2; stage++) {
    const stageLabel = stage === 1 ? 'initial' : 'after resend';

    for (let attempt = 1; attempt <= 2; attempt++) {
      const timeHint = filterAfterTimestamp
        ? `, only accepting emails after ${new Date(filterAfterTimestamp).toLocaleTimeString('zh-CN', { hour12: false })}`
        : ', using latest matching email and excluding previously used login codes';
      await addLog(`Step 7: Polling login verification code (${stageLabel} ${attempt}/2)${timeHint}...`);

      const result = await pollMailForVerificationCode(mail, 7, {
        filterAfterTimestamp,
        strictChatGPTCodeOnly: true,
        excludeCodes: [
          ...(currentState.loginVerificationCode ? [currentState.loginVerificationCode] : []),
          ...(currentState.signupVerificationCode ? [currentState.signupVerificationCode] : []),
        ],
        senderFilters,
        subjectFilters,
        maxAttempts: 8,
        intervalMs: 3000,
      });

      if (result && result.code) {
        await setState({ loginVerificationCode: result.code });
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

      await addLog(`Step 7: No usable login code found in ${stageLabel} poll ${attempt}/2.`, 'warn');
      currentState = await getState();
    }

    if (stage === 1) {
      await addLog('Step 7: No usable login code after 2 polls, requesting resend email...', 'warn');
      await resendLoginVerificationEmail();

      filterAfterTimestamp = mail.source === 'qq-mail' ? null : Date.now();
      await addLog(
        filterAfterTimestamp
          ? `Step 7: Resend verification email clicked, switching freshness threshold to ${new Date(filterAfterTimestamp).toLocaleTimeString('zh-CN', { hour12: false })}.`
          : 'Step 7: Resend verification email clicked, will fetch the latest matching email and skip previously used login codes.',
        'info'
      );
      await sleepRandom(1800, 3200);

      const mailTabId = await getTabId(mail.source);
      if (mailTabId) {
        await chrome.tabs.update(mailTabId, { active: true });
      }
    }
  }

  throw makeRunRestartError('Step 7: No usable login verification code found after 2 polls, resend, and 2 more polls.');
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

    (async () => {
      try {
        let signupTabId = await getTabId('signup-page');
        if (signupTabId) {
          await chrome.tabs.update(signupTabId, { active: true });
          await addLog('Step 8: Switching to auth page, preparing debugger click...');
        } else {
          signupTabId = await reuseOrCreateTab('signup-page', state.oauthUrl);
          await addLog('Step 8: Auth tab reopened. Preparing debugger click...');
        }

        const clickResult = await sendToContentScript('signup-page', {
          type: 'STEP8_FIND_AND_CLICK',
          source: 'background',
          payload: {},
        });

        if (clickResult?.error) {
          throw new Error(clickResult.error);
        }

        await addLog(
          `Step 8: Clicking OAuth consent via Chrome debugger${clickResult?.buttonText ? ` (${clickResult.buttonText})` : ''}...`
        );
        await clickWithDebugger(signupTabId, clickResult?.rect);
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
