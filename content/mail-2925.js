// content/mail-2925.js — Content script for 2925 Mail (steps 4, 7)
// Injected on: 2925.com

const MAIL2925_PREFIX = '[MultiPage:mail-2925]';
const isTopFrame = window === window.top;
// 2925 list time text is often minute-level only (no seconds),
// so allow a small grace window when comparing with cycle start timestamp.
const MAIL_TIME_GRACE_MS = 65 * 1000;

console.log(MAIL2925_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

if (!isTopFrame) {
  console.log(MAIL2925_PREFIX, 'Skipping child frame');
} else {

// ============================================================
// Message Handler
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
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
    return true;
  }
});

// ============================================================
// 尝试多组已知 2925.com SPA 邮件列表选择器
// ============================================================

const MAIL_ITEM_SELECTORS = [
  '.mail-item',
  '.letter-item',
  '[class*="mailItem"]',
  '[class*="mail-item"]',
  '[class*="MailItem"]',
  '.el-table__row',
  'tr[class*="mail"]',
  '[class*="listItem"]',
  '[class*="list-item"]',
  'li[class*="mail"]',
];

function findMailItems() {
  for (const sel of MAIL_ITEM_SELECTORS) {
    const items = document.querySelectorAll(sel);
    if (items.length > 0) return Array.from(items);
  }
  return [];
}

function extractCodeFromLatestRow(item) {
  if (!item) return null;

  // 2925 当前列表结构：td.content -> .mail-content-title / .mail-content-text
  const contentCell = item.querySelector('td.content, .content, .mail-content');
  const titleEl = item.querySelector('.mail-content-title');
  const textEl = item.querySelector('.mail-content-text');

  const candidateText = [
    titleEl?.getAttribute('title') || '',
    titleEl?.textContent || '',
    textEl?.textContent || '',
    contentCell?.textContent || '',
  ].join(' ');

  return extractVerificationCode(candidateText);
}

function getMailItemText(item) {
  if (!item) return '';
  const contentCell = item.querySelector('td.content, .content, .mail-content');
  const titleEl = item.querySelector('.mail-content-title');
  const textEl = item.querySelector('.mail-content-text');
  return [
    titleEl?.getAttribute('title') || '',
    titleEl?.textContent || '',
    textEl?.textContent || '',
    contentCell?.textContent || '',
    item.textContent || '',
  ].join(' ');
}

function getMailItemTimeText(item) {
  const timeEl = item?.querySelector('.date-time-text, [class*="date-time"], [class*="time"], td.time');
  return (timeEl?.textContent || '').replace(/\s+/g, ' ').trim();
}

function isUnreadMailItem(item) {
  if (!item) return false;
  const className = typeof item.className === 'string' ? item.className : '';
  return /unread/i.test(className)
    || item.classList.contains('unread-mail')
    || item.querySelector('.unread, [class*="unread"]') !== null;
}

function matchesMailFilters(text, senderFilters, subjectFilters) {
  const lower = (text || '').toLowerCase();
  const senderMatch = senderFilters.some(f => lower.includes(f.toLowerCase()));
  const subjectMatch = subjectFilters.some(f => lower.includes(f.toLowerCase()));
  return senderMatch || subjectMatch;
}

function parseMailItemTimestamp(item) {
  const timeText = getMailItemTimeText(item);
  if (!timeText) return null;

  const now = new Date();
  const date = new Date(now);

  if (/刚刚/.test(timeText)) {
    return now.getTime();
  }

  let m = timeText.match(/(\d+)\s*分(?:钟)?前/);
  if (m) {
    return now.getTime() - Number(m[1]) * 60 * 1000;
  }

  m = timeText.match(/(\d+)\s*秒前/);
  if (m) {
    return now.getTime() - Number(m[1]) * 1000;
  }

  m = timeText.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    date.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return date.getTime();
  }

  // 格式: 今天 14:14
  m = timeText.match(/今天\s*(\d{1,2}):(\d{2})/);
  if (m) {
    date.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return date.getTime();
  }

  // 格式: 昨天 14:14
  m = timeText.match(/昨天\s*(\d{1,2}):(\d{2})/);
  if (m) {
    date.setDate(date.getDate() - 1);
    date.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return date.getTime();
  }

  // 格式: 04-05 14:14
  m = timeText.match(/(\d{1,2})-(\d{1,2})\s*(\d{1,2}):(\d{2})/);
  if (m) {
    date.setMonth(Number(m[1]) - 1, Number(m[2]));
    date.setHours(Number(m[3]), Number(m[4]), 0, 0);
    return date.getTime();
  }

  // 格式: 2026-04-05 14:14
  m = timeText.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s*(\d{1,2}):(\d{2})/);
  if (m) {
    const d = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      0,
      0
    );
    return d.getTime();
  }

  return null;
}

function isFreshTimestamp(itemTimestamp, filterAfterTimestamp) {
  if (!filterAfterTimestamp) return true;
  if (itemTimestamp === null) return false;
  return itemTimestamp + MAIL_TIME_GRACE_MS >= filterAfterTimestamp;
}

// ============================================================
// 刷新收件箱
// ============================================================

async function refreshInbox() {
  // 优先点刷新按钮
  const refreshBtn = document.querySelector(
    '[class*="refresh"], [title*="刷新"], [aria-label*="刷新"], [class*="Refresh"]'
  );
  if (refreshBtn) {
    simulateClick(refreshBtn);
    await sleepRandom(700, 1200);
    return;
  }
  // 点击收件箱链接
  const inboxLink = document.querySelector(
    'a[href*="mailList"], [class*="inbox"], [class*="Inbox"], [title*="收件箱"]'
  );
  if (inboxLink) {
    simulateClick(inboxLink);
    await sleepRandom(700, 1200);
  }
}

// ============================================================
// 验证码提取（复用与其他邮箱相同的逻辑）
// ============================================================

function extractVerificationCode(text, strictChatGPTCodeOnly = false) {
  if (strictChatGPTCodeOnly) {
    const strictMatch = text.match(/your\s+chatgpt\s+code\s+is\s+(\d{6})/i);
    return strictMatch ? strictMatch[1] : null;
  }

  const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  const matchChatGPT = text.match(/your\s+chatgpt\s+code\s+is\s+(\d{6})/i);
  if (matchChatGPT) return matchChatGPT[1];

  const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  const match6 = text.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
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
  const confirmedMailKeys = new Set();

  log(`Step ${step}: Starting email poll on 2925 Mail (max ${maxAttempts} attempts)`);

  // 等待页面基本加载
  await sleepRandom(1800, 3200);

  log(`Step ${step}: Refreshing 2925 inbox before polling...`);
  await refreshInbox();
  await sleepRandom(900, 1500);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Polling 2925 Mail... attempt ${attempt}/${maxAttempts}`);

    if (attempt > 1) {
      await refreshInbox();
      await sleepRandom(900, 1500);
    }

    // 策略一：通过已知选择器找邮件列表项
    const items = findMailItems();
    if (items.length > 0) {
      log(`Step ${step}: Found ${items.length} mail items via selector`);

      // 优先取第一条（最新邮件）
      const latest = items[0];
      const latestText = getMailItemText(latest);
      const latestUnread = isUnreadMailItem(latest);
      const latestTimestamp = parseMailItemTimestamp(latest);
      const latestIsFresh = isFreshTimestamp(latestTimestamp, filterAfterTimestamp);
      if (!latestIsFresh) {
        if (filterAfterTimestamp && latestTimestamp === null) {
          log(`Step ${step}: Latest row timestamp could not be parsed: ${getMailItemTimeText(latest) || 'empty'}`, 'info');

          const latestCode = extractVerificationCode(latestText, strictChatGPTCodeOnly);
          const latestMatches = matchesMailFilters(latestText, senderFilters, subjectFilters);

          if (latestCode && latestMatches && !excludeCodes.includes(latestCode)) {
            // Step 7: even without a parsable timestamp, if the latest mail clearly contains a code,
            // wait 30s first, then 15s more (max ~60s total), confirm before using it.
            if (step === 7) {
              const latestKey = `no-ts|${latestCode}`;
              if (!confirmedMailKeys.has(latestKey)) {
                confirmedMailKeys.add(latestKey);
                log(`Step ${step}: Latest row has code but no parsed timestamp, waiting 30s before first check...`, 'info');
                await sleep(30000);
                await refreshInbox();
                await sleepRandom(900, 1500);

                const after30sItems = findMailItems();
                if (after30sItems.length === 0) {
                  log(`Step ${step}: Mail list empty after 30s wait, continue polling...`, 'warn');
                  continue;
                }

                const confirmed30s = after30sItems[0];
                const confirmed30sText = getMailItemText(confirmed30s);
                const confirmed30sCode = extractVerificationCode(confirmed30sText, strictChatGPTCodeOnly);
                const confirmed30sMatches = matchesMailFilters(confirmed30sText, senderFilters, subjectFilters);

                if (confirmed30sCode === latestCode && confirmed30sMatches && !excludeCodes.includes(confirmed30sCode)) {
                  log(`Step ${step}: Confirmed latest row code after 30s without parsed timestamp: ${confirmed30sCode}`, 'ok');
                  return { ok: true, code: confirmed30sCode, emailTimestamp: Date.now() };
                }

                // Not confirmed after 30s — wait 15s more
                log(`Step ${step}: Code not confirmed after 30s, waiting another 15s...`, 'info');
                await sleep(15000);
                await refreshInbox();
                await sleepRandom(900, 1500);

                const after45sItems = findMailItems();
                if (after45sItems.length === 0) {
                  log(`Step ${step}: Mail list empty after 45s confirmation wait, continue polling...`, 'warn');
                  continue;
                }

                const confirmed45s = after45sItems[0];
                const confirmed45sText = getMailItemText(confirmed45s);
                const confirmed45sCode = extractVerificationCode(confirmed45sText, strictChatGPTCodeOnly);
                const confirmed45sMatches = matchesMailFilters(confirmed45sText, senderFilters, subjectFilters);

                if (confirmed45sCode === latestCode && confirmed45sMatches && !excludeCodes.includes(confirmed45sCode)) {
                  log(`Step ${step}: Confirmed latest row code after 45s without parsed timestamp: ${confirmed45sCode}`, 'ok');
                  return { ok: true, code: confirmed45sCode, emailTimestamp: Date.now() };
                }

                // Still not confirmed after 60s total — continue polling
                log(`Step ${step}: Code not confirmed after 45s, continue polling...`, 'info');
                continue;
              }
            }

            if (latestUnread) {
              log(`Step ${step}: Using latest row without parsed timestamp, code: ${latestCode}`, 'ok');
              return { ok: true, code: latestCode, emailTimestamp: Date.now() };
            }
          }
        } else {
          log(`Step ${step}: Latest row considered older (row=${latestTimestamp}, filter=${filterAfterTimestamp}), waiting for new mail...`, 'info');
        }
      } else {
        let latestCandidate = latest;
        let latestCandidateTimestamp = latestTimestamp;

        // Step 7: don't rush to use the newest mail immediately.
        // Wait 30s first, refresh, confirm still fresh, extract code.
        // If not confirmed → wait 15s more (max ~60s total).
        if (step === 7 && filterAfterTimestamp) {
          const latestKey = `${latestTimestamp}|${getMailItemTimeText(latest)}`;
          if (!confirmedMailKeys.has(latestKey)) {
            confirmedMailKeys.add(latestKey);
            log(`Step ${step}: New latest mail detected, waiting 30s before first check...`, 'info');
            await sleep(30000);
            await refreshInbox();
            await sleepRandom(900, 1500);

            const after30sItems = findMailItems();
            if (after30sItems.length === 0) {
              log(`Step ${step}: Mail list empty after 30s confirmation wait, continue polling...`, 'warn');
              continue;
            }

            latestCandidate = after30sItems[0];
            latestCandidateTimestamp = parseMailItemTimestamp(latestCandidate);
            const latestStillFreshAfter30s = isFreshTimestamp(latestCandidateTimestamp, filterAfterTimestamp);
            if (latestStillFreshAfter30s) {
              const codeAfter30s = extractVerificationCode(getMailItemText(latestCandidate), strictChatGPTCodeOnly);
              if (codeAfter30s && !excludeCodes.includes(codeAfter30s)) {
                log(`Step ${step}: Confirmed code after 30s: ${codeAfter30s}`, 'ok');
                return { ok: true, code: codeAfter30s, emailTimestamp: latestCandidateTimestamp || Date.now() };
              }
            }

            // Not confirmed after 30s — wait 15s more
            log(`Step ${step}: Code not confirmed after 30s, waiting another 15s...`, 'info');
            await sleep(15000);
            await refreshInbox();
            await sleepRandom(900, 1500);

            const after45sItems = findMailItems();
            if (after45sItems.length === 0) {
              log(`Step ${step}: Mail list empty after 45s confirmation wait, continue polling...`, 'warn');
              continue;
            }

            latestCandidate = after45sItems[0];
            latestCandidateTimestamp = parseMailItemTimestamp(latestCandidate);
            const latestStillFreshAfter45s = isFreshTimestamp(latestCandidateTimestamp, filterAfterTimestamp);
            if (!latestStillFreshAfter45s) {
              log(`Step ${step}: Latest mail not fresh after 45s, continue polling...`, 'info');
              continue;
            }

            const latestCodeAfter45s = extractVerificationCode(getMailItemText(latestCandidate), strictChatGPTCodeOnly);
            if (latestCodeAfter45s) {
              if (excludeCodes.includes(latestCodeAfter45s)) {
                log(`Step ${step}: Skipping excluded code after 45s confirmation: ${latestCodeAfter45s}`, 'info');
              } else {
                log(`Step ${step}: Confirmed code after 45s: ${latestCodeAfter45s}`, 'ok');
                return { ok: true, code: latestCodeAfter45s, emailTimestamp: latestCandidateTimestamp || Date.now() };
              }
            }

            // Still not confirmed after 60s total — continue polling
            log(`Step ${step}: Code not confirmed after 45s, continue polling...`, 'info');
            continue;
          }
        }

        const latestCode = extractVerificationCode(getMailItemText(latestCandidate), strictChatGPTCodeOnly);
        if (latestCode) {
          if (excludeCodes.includes(latestCode)) {
            log(`Step ${step}: Skipping excluded code from latest row: ${latestCode}`, 'info');
          } else {
          log(`Step ${step}: Code found in latest row: ${latestCode}`, 'ok');
          return { ok: true, code: latestCode, emailTimestamp: latestCandidateTimestamp || Date.now() };
          }
        }
      }

      for (const item of items) {
        const itemTimestamp = parseMailItemTimestamp(item);
        const isFresh = isFreshTimestamp(itemTimestamp, filterAfterTimestamp);
        if (!isFresh) continue;

        const text = getMailItemText(item);

        if (matchesMailFilters(text, senderFilters, subjectFilters)) {
          // 先从列表摘要里提取
          const code = extractVerificationCode(text, strictChatGPTCodeOnly);
          if (code) {
            if (excludeCodes.includes(code)) {
              log(`Step ${step}: Skipping excluded code in list item: ${code}`, 'info');
              continue;
            }
            log(`Step ${step}: Code found in list item: ${code}`, 'ok');
            return { ok: true, code, emailTimestamp: itemTimestamp || Date.now() };
          }
          // 点击打开邮件，再从正文提取
          simulateClick(item);
          await sleepRandom(1200, 2200);
          const bodyCode = extractVerificationCode(document.body?.textContent || '', strictChatGPTCodeOnly);
          if (bodyCode) {
            if (excludeCodes.includes(bodyCode)) {
              log(`Step ${step}: Skipping excluded code in opened email: ${bodyCode}`, 'info');
              continue;
            }
            log(`Step ${step}: Code found in opened email: ${bodyCode}`, 'ok');
            return { ok: true, code: bodyCode, emailTimestamp: itemTimestamp || Date.now() };
          }
        }
      }
    }

    // 策略二：全页面文本扫描（SPA 页面 DOM 可能不符合预期选择器）
    // 当要求时间过滤时，避免从全页文本误提取旧验证码
    if (!filterAfterTimestamp) {
      const pageText = document.body?.textContent || '';
      const anyFilter = [...senderFilters, ...subjectFilters].some(f =>
        pageText.toLowerCase().includes(f.toLowerCase())
      );
      if (anyFilter) {
        const code = extractVerificationCode(pageText, strictChatGPTCodeOnly);
        if (code) {
          log(`Step ${step}: Code found via page text scan: ${code}`, 'ok');
          return { ok: true, code, emailTimestamp: Date.now() };
        }
      }
    }

    if (attempt < maxAttempts) {
      await sleepRandom(intervalMs, intervalMs + 1200);
    }
  }

  throw new Error(
    `No matching email found on 2925 Mail after ${(maxAttempts * intervalMs / 1000).toFixed(0)}s. ` +
    'Check inbox manually. Email may be delayed or in spam folder.'
  );
}

} // end isTopFrame block
