// content/qq-mail.js — Content script for QQ Mail (steps 4, 7)
// Injected on: mail.qq.com, wx.mail.qq.com
// NOTE: all_frames: true
//
// Strategy for avoiding stale codes:
// 1. On poll start, snapshot all existing mail IDs as "old"
// 2. On each poll cycle, refresh inbox and look for NEW items (not in snapshot)
// 3. Only extract codes from NEW items that match sender/subject filters

const QQ_MAIL_PREFIX = '[MultiPage:qq-mail]';
const isTopFrame = window === window.top;
const MAIL_TIME_GRACE_MS = 90 * 1000;

console.log(QQ_MAIL_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

// ============================================================
// Message Handler
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
    if (!isTopFrame) {
      sendResponse({ ok: false, reason: 'wrong-frame' });
      return;
    }
    resetStopState();
    handlePollEmail(message.step, message.payload).then(result => {
      sendResponse(result);
    }).catch(err => {
      if (isStopError(err)) {
        log(`Step ${message.step}: Stopped by user.`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      sendResponse({ error: err.message });
    });
    return true; // async response
  }
});

// ============================================================
// Get all current mail IDs from the list
// ============================================================

function getCurrentMailIds() {
  const ids = new Set();
  document.querySelectorAll('.mail-list-page-item[data-mailid]').forEach(item => {
    ids.add(item.getAttribute('data-mailid'));
  });
  return ids;
}

function getMailItemTimeText(item) {
  const selectors = [
    '[class*="time"]',
    '[class*="Time"]',
    '[class*="date"]',
    '[class*="Date"]',
    'time',
  ];

  for (const selector of selectors) {
    const candidate = item.querySelector(selector);
    const text = candidate?.textContent?.trim();
    if (text) return text;
  }

  const itemText = item.textContent?.replace(/\s+/g, ' ').trim() || '';
  const fallbackMatch = itemText.match(
    /(刚刚|\d+\s*分钟前|\d+\s*小时[前内]|\d{1,2}:\d{2}|(?:昨天|前天)\s*\d{1,2}:\d{2}|\d{4}[-\/]\d{1,2}[-\/]\d{1,2}(?:\s+\d{1,2}:\d{2})?|\d{1,2}[-\/]\d{1,2}(?:\s+\d{1,2}:\d{2})?)/
  );
  return fallbackMatch ? fallbackMatch[1] : '';
}

function parseMailItemTimestamp(item) {
  const raw = getMailItemTimeText(item);
  if (!raw) return null;

  const text = raw.replace(/\s+/g, ' ').trim();
  const now = new Date();

  if (/^刚刚$/.test(text)) return now.getTime();

  const minuteAgo = text.match(/^(\d+)\s*分钟前$/);
  if (minuteAgo) {
    return now.getTime() - Number(minuteAgo[1]) * 60 * 1000;
  }

  const hourAgo = text.match(/^(\d+)\s*小时(?:前|内)?$/);
  if (hourAgo) {
    return now.getTime() - Number(hourAgo[1]) * 60 * 60 * 1000;
  }

  const todayTime = text.match(/^(\d{1,2}):(\d{2})$/);
  if (todayTime) {
    const candidate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      Number(todayTime[1]),
      Number(todayTime[2]),
      0,
      0
    );
    if (candidate.getTime() - now.getTime() > 2 * 60 * 1000) {
      candidate.setDate(candidate.getDate() - 1);
    }
    return candidate.getTime();
  }

  const relativeDay = text.match(/^(昨天|前天)\s*(\d{1,2}):(\d{2})$/);
  if (relativeDay) {
    const offset = relativeDay[1] === '昨天' ? 1 : 2;
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - offset,
      Number(relativeDay[2]),
      Number(relativeDay[3]),
      0,
      0
    ).getTime();
  }

  const fullDate = text.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (fullDate) {
    return new Date(
      Number(fullDate[1]),
      Number(fullDate[2]) - 1,
      Number(fullDate[3]),
      Number(fullDate[4] || 0),
      Number(fullDate[5] || 0),
      0,
      0
    ).getTime();
  }

  const shortDate = text.match(/^(\d{1,2})[-\/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (shortDate) {
    return new Date(
      now.getFullYear(),
      Number(shortDate[1]) - 1,
      Number(shortDate[2]),
      Number(shortDate[3] || 0),
      Number(shortDate[4] || 0),
      0,
      0
    ).getTime();
  }

  return null;
}

function isFreshTimestamp(itemTimestamp, filterAfterTimestamp) {
  if (!filterAfterTimestamp) return true;
  if (itemTimestamp === null || itemTimestamp === undefined) return false;
  return itemTimestamp + MAIL_TIME_GRACE_MS >= filterAfterTimestamp;
}

// ============================================================
// Email Polling
// ============================================================

async function handlePollEmail(step, payload) {
  const {
    senderFilters,
    subjectFilters,
    maxAttempts,
    intervalMs,
    filterAfterTimestamp,
    excludeCodes = [],
    strictChatGPTCodeOnly = false,
  } = payload;

  log(`Step ${step}: Starting email poll (max ${maxAttempts} attempts, every ${intervalMs / 1000}s)`);
  await sleepRandom(1200, 2200);

  // Wait for mail list to load
  try {
    await waitForElement('.mail-list-page-item', 10000);
    log(`Step ${step}: Mail list loaded`);
  } catch {
    throw new Error('Mail list did not load. Make sure QQ Mail inbox is open.');
  }

  // Step 1: Snapshot existing mail IDs BEFORE we start waiting for new email
  const existingMailIds = getCurrentMailIds();
  log(`Step ${step}: Snapshotted ${existingMailIds.size} existing emails as "old"`);

  log(`Step ${step}: Refreshing QQ inbox before polling...`);
  await refreshInbox();
  await sleepRandom(700, 1200);

  // Fallback after just 3 attempts (~10s). In practice, the email is usually
  // already in the list but has the same mailid (page was already open).
  const FALLBACK_AFTER = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Polling QQ Mail... attempt ${attempt}/${maxAttempts}`);

    // Refresh inbox on subsequent attempts
    if (attempt > 1) {
      await refreshInbox();
      await sleepRandom(700, 1200);
    }

    const allItems = document.querySelectorAll('.mail-list-page-item[data-mailid]');
    const useFallback = !filterAfterTimestamp && attempt > FALLBACK_AFTER;

    // Phase 1 (attempt 1~3): only look at NEW emails (not in snapshot)
    // Phase 2 (attempt 4+): fallback to first matching email in list
    for (const item of allItems) {
      const mailId = item.getAttribute('data-mailid');
      const isNewMail = !existingMailIds.has(mailId);
      const itemTimestamp = parseMailItemTimestamp(item);
      const isFresh = isFreshTimestamp(itemTimestamp, filterAfterTimestamp);

      if (!filterAfterTimestamp && !useFallback && !isNewMail) continue;

      const rowText = (item.textContent || '').replace(/\s+/g, ' ').trim();
      const rowTextLower = rowText.toLowerCase();
      const sender = ((item.querySelector('.cmp-account-nick')?.textContent || '') || rowText).toLowerCase();
      const subject = ((item.querySelector('.mail-subject')?.textContent || '') || rowText).toLowerCase();
      const digest = item.querySelector('.mail-digest')?.textContent || rowText;

      const senderMatch = senderFilters.some(f => sender.includes(f.toLowerCase()) || rowTextLower.includes(f.toLowerCase()));
      const subjectMatch = subjectFilters.some(f => subject.includes(f.toLowerCase()) || rowTextLower.includes(f.toLowerCase()));

      if (senderMatch || subjectMatch) {
        if (filterAfterTimestamp) {
          if (itemTimestamp !== null && !isFresh) {
            log(`Step ${step}: Skipping stale QQ mail (time=${getMailItemTimeText(item) || 'unknown'}, filter=${new Date(filterAfterTimestamp).toLocaleTimeString('zh-CN', { hour12: false })})`, 'info');
            continue;
          }

          if (itemTimestamp === null && !isNewMail) {
            log(`Step ${step}: Skipping QQ mail without parsable timestamp because it is not new after poll start.`, 'info');
            continue;
          }
        }

        const code = extractVerificationCode(`${subject} ${digest} ${rowText}`, strictChatGPTCodeOnly);
        if (code) {
          if (excludeCodes.includes(code)) {
            log(`Step ${step}: Skipping excluded code: ${code}`, 'info');
            continue;
          }
          const source = isNewMail ? 'new' : (filterAfterTimestamp ? 'fresh-existing' : 'fallback-first-match');
          log(`Step ${step}: Code found: ${code} (${source}, subject: ${subject.slice(0, 40)})`, 'ok');
          return { ok: true, code, emailTimestamp: itemTimestamp || Date.now(), mailId };
        }
      }
    }

    if (!filterAfterTimestamp && attempt === FALLBACK_AFTER + 1) {
      log(`Step ${step}: No new emails after ${FALLBACK_AFTER} attempts, falling back to first matching email`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleepRandom(intervalMs, intervalMs + 1200);
    }
  }

  throw new Error(
    `No new matching email found after ${(maxAttempts * intervalMs / 1000).toFixed(0)}s. ` +
    'Check QQ Mail manually. Email may be delayed or in spam folder.'
  );
}

// ============================================================
// Inbox Refresh
// ============================================================

async function refreshInbox() {
  // Try multiple strategies to refresh the mail list

  // Strategy 1: Click any visible refresh button
  const refreshBtn = document.querySelector('[class*="refresh"], [title*="刷新"]');
  if (refreshBtn) {
    simulateClick(refreshBtn);
    console.log(QQ_MAIL_PREFIX, 'Clicked refresh button');
    await sleepRandom(400, 800);
    return;
  }

  // Strategy 2: Click inbox in sidebar to reload list
  const sidebarInbox = document.querySelector('a[href*="inbox"], [class*="folder-item"][class*="inbox"], [title="收件箱"]');
  if (sidebarInbox) {
    simulateClick(sidebarInbox);
    console.log(QQ_MAIL_PREFIX, 'Clicked sidebar inbox');
    await sleepRandom(400, 800);
    return;
  }

  // Strategy 3: Click the folder name in toolbar
  const folderName = document.querySelector('.toolbar-folder-name');
  if (folderName) {
    simulateClick(folderName);
    console.log(QQ_MAIL_PREFIX, 'Clicked toolbar folder name');
    await sleepRandom(400, 800);
  }
}

// ============================================================
// Verification Code Extraction
// ============================================================

function extractVerificationCode(text, strictChatGPTCodeOnly = false) {
  if (strictChatGPTCodeOnly) {
    const strictMatch = text.match(/your\s+chatgpt\s+code\s+is\s+(\d{6})/i);
    return strictMatch ? strictMatch[1] : null;
  }

  // Pattern 1: Chinese format "代码为 370794" or "验证码...370794"
  const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  // Pattern 2: English format "code is 370794" or "code: 370794"
  const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  // Pattern 3: standalone 6-digit number (first occurrence)
  const match6 = text.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
}
