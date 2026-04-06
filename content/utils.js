// content/utils.js — Shared utilities for all content scripts

var SCRIPT_SOURCE = (() => {
  if (window.__MULTIPAGE_SOURCE) return window.__MULTIPAGE_SOURCE;
  const url = location.href;
  if (url.includes('auth0.openai.com') || url.includes('auth.openai.com') || url.includes('accounts.openai.com')) return 'signup-page';
  if (url.includes('mail.qq.com')) return 'qq-mail';
  if (url.includes('mail.163.com')) return 'mail-163';
  if (url.includes('2925.com')) return 'mail-2925';
  if (url.includes('duckduckgo.com/email/settings/autofill')) return 'duck-mail';
  if (url.includes('chatgpt.com')) return 'chatgpt';
  return 'vps-panel';
})();

var LOG_PREFIX = `[MultiPage:${SCRIPT_SOURCE}]`;
var STOP_ERROR_MESSAGE = 'Flow stopped by user.';
var flowStopped = false;

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'STOP_FLOW') {
    flowStopped = true;
    console.warn(LOG_PREFIX, STOP_ERROR_MESSAGE);
  }
});

function resetStopState() {
  flowStopped = false;
}

function isStopError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return message === STOP_ERROR_MESSAGE;
}

function throwIfStopped() {
  if (flowStopped) {
    throw new Error(STOP_ERROR_MESSAGE);
  }
}

function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    throwIfStopped();

    const existing = document.querySelector(selector);
    if (existing) {
      console.log(LOG_PREFIX, `Found immediately: ${selector}`);
      log(`Found element: ${selector}`);
      resolve(existing);
      return;
    }

    console.log(LOG_PREFIX, `Waiting for: ${selector} (timeout: ${timeout}ms)`);
    log(`Waiting for selector: ${selector}...`);

    let settled = false;
    let stopTimer = null;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(stopTimer);
    };

    const observer = new MutationObserver(() => {
      if (flowStopped) {
        cleanup();
        reject(new Error(STOP_ERROR_MESSAGE));
        return;
      }
      const el = document.querySelector(selector);
      if (el) {
        cleanup();
        console.log(LOG_PREFIX, `Found after wait: ${selector}`);
        log(`Found element: ${selector}`);
        resolve(el);
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });

    const timer = setTimeout(() => {
      cleanup();
      const msg = `Timeout waiting for ${selector} after ${timeout}ms on ${location.href}`;
      console.error(LOG_PREFIX, msg);
      reject(new Error(msg));
    }, timeout);

    const pollStop = () => {
      if (settled) return;
      if (flowStopped) {
        cleanup();
        reject(new Error(STOP_ERROR_MESSAGE));
        return;
      }
      stopTimer = setTimeout(pollStop, 100);
    };
    pollStop();
  });
}

function waitForElementByText(containerSelector, textPattern, timeout = 10000) {
  return new Promise((resolve, reject) => {
    throwIfStopped();

    function search() {
      const candidates = document.querySelectorAll(containerSelector);
      for (const el of candidates) {
        if (textPattern.test(el.textContent)) {
          return el;
        }
      }
      return null;
    }

    const existing = search();
    if (existing) {
      console.log(LOG_PREFIX, `Found by text immediately: ${containerSelector} matching ${textPattern}`);
      log(`Found element by text: ${textPattern}`);
      resolve(existing);
      return;
    }

    console.log(LOG_PREFIX, `Waiting for text match: ${containerSelector} / ${textPattern}`);
    log(`Waiting for element with text: ${textPattern}...`);

    let settled = false;
    let stopTimer = null;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(stopTimer);
    };

    const observer = new MutationObserver(() => {
      if (flowStopped) {
        cleanup();
        reject(new Error(STOP_ERROR_MESSAGE));
        return;
      }
      const el = search();
      if (el) {
        cleanup();
        console.log(LOG_PREFIX, `Found by text after wait: ${textPattern}`);
        log(`Found element by text: ${textPattern}`);
        resolve(el);
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });

    const timer = setTimeout(() => {
      cleanup();
      const msg = `Timeout waiting for text "${textPattern}" in "${containerSelector}" after ${timeout}ms on ${location.href}`;
      console.error(LOG_PREFIX, msg);
      reject(new Error(msg));
    }, timeout);

    const pollStop = () => {
      if (settled) return;
      if (flowStopped) {
        cleanup();
        reject(new Error(STOP_ERROR_MESSAGE));
        return;
      }
      stopTimer = setTimeout(pollStop, 100);
    };
    pollStop();
  });
}

function fillInput(el, value) {
  throwIfStopped();
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  ).set;
  nativeInputValueSetter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  console.log(LOG_PREFIX, `Filled input ${el.name || el.id || el.type} with: ${value}`);
  log(`Filled input [${el.name || el.id || el.type || 'unknown'}]`);
}

function fillSelect(el, value) {
  throwIfStopped();
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  console.log(LOG_PREFIX, `Selected value ${value} in ${el.name || el.id}`);
  log(`Selected [${el.name || el.id || 'unknown'}] = ${value}`);
}

function log(message, level = 'info') {
  chrome.runtime.sendMessage({
    type: 'LOG',
    source: SCRIPT_SOURCE,
    step: null,
    payload: { message, level, timestamp: Date.now() },
    error: null,
  });
}

function reportReady() {
  console.log(LOG_PREFIX, 'Content script ready');
  chrome.runtime.sendMessage({
    type: 'CONTENT_SCRIPT_READY',
    source: SCRIPT_SOURCE,
    step: null,
    payload: {},
    error: null,
  });
}

function reportComplete(step, data = {}) {
  console.log(LOG_PREFIX, `Step ${step} completed`, data);
  log(`Step ${step} completed successfully`, 'ok');
  chrome.runtime.sendMessage({
    type: 'STEP_COMPLETE',
    source: SCRIPT_SOURCE,
    step,
    payload: data,
    error: null,
  });
}

function reportError(step, errorMessage) {
  console.error(LOG_PREFIX, `Step ${step} failed: ${errorMessage}`);
  log(`Step ${step} failed: ${errorMessage}`, 'error');
  chrome.runtime.sendMessage({
    type: 'STEP_ERROR',
    source: SCRIPT_SOURCE,
    step,
    payload: {},
    error: errorMessage,
  });
}

function simulateClick(el) {
  throwIfStopped();
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  console.log(LOG_PREFIX, `Clicked: ${el.tagName} ${el.textContent?.slice(0, 30) || ''}`);
  log(`Clicked [${el.tagName}] "${el.textContent?.trim().slice(0, 30) || ''}"`);
}

function sleep(ms) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    function tick() {
      if (flowStopped) {
        reject(new Error(STOP_ERROR_MESSAGE));
        return;
      }
      if (Date.now() - start >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(100, Math.max(25, ms - (Date.now() - start))));
    }

    tick();
  });
}

function sleepRandom(minMs, maxMs = minMs) {
  const lower = Math.max(0, Math.min(minMs, maxMs));
  const upper = Math.max(minMs, maxMs);
  const delay = lower + Math.floor(Math.random() * (upper - lower + 1));
  return sleep(delay);
}

async function humanPause(min = 250, max = 850) {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleep(duration);
}

const _isMailChildFrame = (
  SCRIPT_SOURCE === 'qq-mail'
  || SCRIPT_SOURCE === 'mail-163'
  || SCRIPT_SOURCE === 'mail-2925'
  || SCRIPT_SOURCE === 'inbucket-mail'
) && window !== window.top;
const _knownSource = SCRIPT_SOURCE !== 'vps-panel';
if (_knownSource && !_isMailChildFrame) {
  reportReady();
}
