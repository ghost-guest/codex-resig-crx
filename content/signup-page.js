// content/signup-page.js — Content script for OpenAI auth pages (steps 2, 3, 4-receive, 5)
// Injected on: auth0.openai.com, auth.openai.com, accounts.openai.com

console.log('[MultiPage:signup-page] Content script loaded on', location.href);

// Listen for commands from Background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXECUTE_STEP' || message.type === 'FILL_CODE') {
    handleCommand(message).then(() => {
      sendResponse({ ok: true });
    }).catch(err => {
      reportError(message.step, err.message);
      sendResponse({ error: err.message });
    });
    return true;
  }
});

async function handleCommand(message) {
  switch (message.type) {
    case 'EXECUTE_STEP':
      switch (message.step) {
        case 2: return await step2_clickRegister();
        case 3: return await step3_fillEmailPassword(message.payload);
        case 5: return await step5_fillNameBirthday(message.payload);
        case 6: return await step6_login(message.payload);
        case 41:
        case 71:
          return await stepResendVerificationEmail(message.step);
        case 8: return await step8_clickContinue();
        default: throw new Error(`signup-page.js does not handle step ${message.step}`);
      }
    case 'FILL_CODE':
      // Step 4 = signup code, Step 7 = login code (same handler)
      return await fillVerificationCode(message.step, message.payload);
  }
}

function getActionElementText(el) {
  return [
    el?.textContent || '',
    el?.value || '',
    el?.getAttribute?.('aria-label') || '',
    el?.getAttribute?.('data-dd-action-name') || '',
    el?.getAttribute?.('title') || '',
  ].join(' ').replace(/\s+/g, ' ').trim();
}

function findActionElement(pattern) {
  const selectors = 'button, a, [role="button"], input[type="submit"], input[type="button"]';
  const candidates = document.querySelectorAll(selectors);
  for (const el of candidates) {
    if (pattern.test(getActionElementText(el))) {
      return el;
    }
  }
  return null;
}

function waitForActionElement(pattern, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const existing = findActionElement(pattern);
    if (existing) {
      resolve(existing);
      return;
    }

    const observer = new MutationObserver(() => {
      const el = findActionElement(pattern);
      if (el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for action element ${pattern} on ${location.href}`));
    }, timeout);
  });
}

async function activateActionElement(el, label) {
  if (!el) throw new Error(`No element provided for ${label}`);

  const target = el.closest('button, a, [role="button"], input[type="submit"], input[type="button"]') || el;
  target.scrollIntoView({ block: 'center', inline: 'nearest' });
  await sleepRandom(120, 240);
  if ('focus' in target) target.focus();
  await sleepRandom(120, 240);

  if ('click' in target) {
    target.click();
    log(`${label}: Clicked via native click()`);
  }
  simulateClick(target);

  const form = target.form || target.closest('form');
  if (form) {
    try {
      form.requestSubmit(target.tagName === 'BUTTON' || target.tagName === 'INPUT' ? target : undefined);
      log(`${label}: Triggered form.requestSubmit()`);
    } catch {
      try {
        form.submit();
        log(`${label}: Triggered form.submit()`);
      } catch {}
    }
  }
}

// ============================================================
// Step 2: Click Register
// ============================================================

async function step2_clickRegister() {
  log('Step 2: Waiting for page to render...');
  await sleepRandom(1200, 2200);
  log('Step 2: Looking for Register/Sign up button...');

  let registerBtn = null;
  try {
    registerBtn = await waitForElementByText(
      'a, button, [role="button"], [role="link"]',
      /sign\s*up|register|create\s*account|注册/i,
      10000
    );
  } catch {
    // Some pages may have a direct link
    try {
      registerBtn = await waitForElement('a[href*="signup"], a[href*="register"]', 5000);
    } catch {
      throw new Error(
        'Could not find Register/Sign up button. ' +
        'Check auth page DOM in DevTools. URL: ' + location.href
      );
    }
  }

  reportComplete(2);
  simulateClick(registerBtn);
  log('Step 2: Clicked Register button');
}

// ============================================================
// Step 3: Fill Email & Password
// ============================================================

async function step3_fillEmailPassword(payload) {
  const { email } = payload;
  if (!email) throw new Error('No email provided. Paste email in Side Panel first.');

  log('Step 3: Waiting for signup form to render...');
  await sleepRandom(1200, 2200);
  log(`Step 3: Filling email: ${email}`);

  // Find email input
  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email"], input[placeholder*="Email"]',
      10000
    );
  } catch {
    throw new Error('Could not find email input field on signup page. URL: ' + location.href);
  }

  fillInput(emailInput, email);
  log('Step 3: Email filled');

  // Check if password field is on the same page
  let passwordInput = document.querySelector('input[type="password"]');

  if (!passwordInput) {
    // Need to submit email first to get to password page
    log('Step 3: No password field yet, submitting email first...');
    const submitBtn = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);

    if (submitBtn) {
      simulateClick(submitBtn);
      log('Step 3: Submitted email, waiting for password field...');
      await sleepRandom(1800, 3200);
    }

    try {
      passwordInput = await waitForElement('input[type="password"]', 10000);
    } catch {
      throw new Error('Could not find password input after submitting email. URL: ' + location.href);
    }
  }

  if (!payload.password) throw new Error('No password provided. Step 3 requires a generated password.');
  fillInput(passwordInput, payload.password);
  log('Step 3: Password filled');

  // Report complete BEFORE submit, because submit causes page navigation
  // which kills the content script connection
  reportComplete(3, { email });

  // Submit the form (page will navigate away after this)
  await sleepRandom(450, 900);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|sign\s*up|submit|注册|创建|create/i, 5000).catch(() => null);

  if (submitBtn) {
    simulateClick(submitBtn);
    log('Step 3: Form submitted');
  }
}

// ============================================================
// Fill Verification Code (used by step 4 and step 7)
// ============================================================

async function fillVerificationCode(step, payload) {
  const { code } = payload;
  if (!code) throw new Error('No verification code provided.');

  log(`Step ${step}: Waiting for verification code page to render...`);
  await sleepRandom(1200, 2200);
  log(`Step ${step}: Filling verification code: ${code}`);

  // Find code input — could be a single input or multiple separate inputs
  let codeInput = null;
  try {
    codeInput = await waitForElement(
      'input[name="code"], input[name="otp"], input[type="text"][maxlength="6"], input[aria-label*="code"], input[placeholder*="code"], input[placeholder*="Code"], input[inputmode="numeric"]',
      10000
    );
  } catch {
    // Check for multiple single-digit inputs (common pattern)
    const singleInputs = document.querySelectorAll('input[maxlength="1"]');
    if (singleInputs.length >= 6) {
      log(`Step ${step}: Found single-digit code inputs, filling individually...`);
      for (let i = 0; i < 6 && i < singleInputs.length; i++) {
        fillInput(singleInputs[i], code[i]);
        await sleep(100);
      }
      await sleepRandom(900, 1500);
      reportComplete(step);
      return;
    }
    throw new Error('Could not find verification code input. URL: ' + location.href);
  }

  fillInput(codeInput, code);
  log(`Step ${step}: Code filled`);

  // Report complete BEFORE submit (page may navigate away)
  reportComplete(step);

  // Submit
  await sleepRandom(450, 900);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /verify|confirm|submit|continue|确认|验证/i, 5000).catch(() => null);

  if (submitBtn) {
    simulateClick(submitBtn);
    log(`Step ${step}: Verification submitted`);
  }
}

async function stepResendVerificationEmail(step) {
  log(`Step ${step}: Waiting for resend verification email button...`);
  await sleepRandom(1200, 2200);

  let resendBtn = document.querySelector(
    'button[name="intent"][value="resend"][type="submit"], input[name="intent"][value="resend"][type="submit"]'
  );
  if (!resendBtn) {
    const resendPattern = /重新发送电子邮件|重新发送|再次发送|重发|resend|send again|verification email|验证电子邮件/i;
    resendBtn = await waitForActionElement(resendPattern, 15000).catch(() => null);
  }
  if (!resendBtn) {
    throw new Error('Could not find resend verification email button on auth page.');
  }

  const disabled = resendBtn.disabled
    || resendBtn.getAttribute('aria-disabled') === 'true'
    || resendBtn.getAttribute('disabled') !== null;
  if (disabled) {
    throw new Error('Resend verification email button is disabled.');
  }

  await activateActionElement(resendBtn, `Step ${step} resend`);
  log(`Step ${step}: Resend verification email requested`);
}

// ============================================================
// Step 6: Login with registered account (on OAuth auth page)
// ============================================================

async function step6_login(payload) {
  const { email, password } = payload;
  if (!email) throw new Error('No email provided for login.');

  log(`Step 6: Waiting for login page to render...`);
  await sleepRandom(1800, 3200);
  log(`Step 6: Logging in with ${email}...`);

  // Wait for email input on the auth page
  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email" i], input[placeholder*="Email"]',
      15000
    );
  } catch {
    throw new Error('Could not find email input on login page. URL: ' + location.href);
  }

  fillInput(emailInput, email);
  log('Step 6: Email filled');

  // Submit email
  await sleepRandom(450, 900);
  const submitBtn1 = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);
  if (submitBtn1) {
    simulateClick(submitBtn1);
    log('Step 6: Submitted email');
  }

  await sleepRandom(1800, 3200);

  // Check for password field
  const passwordInput = document.querySelector('input[type="password"]');
  if (passwordInput) {
    log('Step 6: Password field found, filling password...');
    fillInput(passwordInput, password);

    await sleepRandom(450, 900);
    const submitBtn2 = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|log\s*in|submit|sign\s*in|登录|继续/i, 5000).catch(() => null);
    // Report complete BEFORE submit in case page navigates
    reportComplete(6, { needsOTP: true });

    if (submitBtn2) {
      simulateClick(submitBtn2);
      log('Step 6: Submitted password, may need verification code (step 7)');
    }
    return;
  }

  // No password field — OTP flow
  log('Step 6: No password field. OTP flow or auto-redirect.');
  reportComplete(6, { needsOTP: true });
}

// ============================================================
// Step 8: Click "继续" on OAuth consent page
// ============================================================
// After login + verification, page shows:
// "使用 ChatGPT 登录到 Codex" with a "继续" submit button.
// Clicking it triggers redirect to localhost URL.

async function step8_clickContinue() {
  log('Step 8: Waiting for OAuth consent page to render...');
  await sleepRandom(1800, 3200);
  log('Step 8: Looking for OAuth consent "继续" button...');

  let continueBtn = document.querySelector('button[data-dd-action-name="Continue"][type="submit"], button._primary_3rdp0_107[type="submit"]');
  const continuePattern = /(^|\s)(继续|continue)(\s|$)/i;
  if (!continueBtn) {
    continueBtn = findActionElement(continuePattern);
  }
  if (!continueBtn) {
    continueBtn = await waitForActionElement(continuePattern, 15000).catch(() => null);
  }
  if (!continueBtn) {
    continueBtn = document.querySelector('[data-dd-action-name="Continue"], button[type="submit"], input[type="submit"]');
  }
  if (!continueBtn) {
    throw new Error('Could not find "继续" button on OAuth consent page. URL: ' + location.href);
  }

  log('Step 8: Found "继续" button, clicking...');

  await activateActionElement(continueBtn, 'Step 8 continue');
  await sleepRandom(450, 900);

  log('Step 8: Redirecting to localhost... (background will capture URL)');

  // Don't reportComplete — background handles it via webNavigation listener
}

// ============================================================
// Step 5: Fill Name & Birthday
// ============================================================

async function step5_fillNameBirthday(payload) {
  const { firstName, lastName, year, month, day } = payload;
  if (!firstName || !lastName) throw new Error('No name data provided.');

  log('Step 5: Waiting for name/birthday page to render...');
  await sleepRandom(1800, 3200);

  const fullName = `${firstName} ${lastName}`;
  log(`Step 5: Filling name: ${fullName}, Birthday: ${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`);

  // Actual DOM structure:
  // - Full name: <input name="name" placeholder="全名" type="text">
  // - Birthday: React Aria DateField with 3 spinbutton divs (year/month/day)
  //   + <input type="hidden" name="birthday" value="2026-04-05">

  // --- Full Name (single field, not first+last) ---
  let nameInput = null;
  try {
    nameInput = await waitForElement(
      'input[name="name"], input[placeholder*="全名"], input[autocomplete="name"]',
      10000
    );
  } catch {
    throw new Error('Could not find name input. URL: ' + location.href);
  }
  fillInput(nameInput, fullName);
  log(`Step 5: Name filled: ${fullName}`);

  // --- Birthday (React Aria DateField with spinbutton segments) ---
  // The date field has three contenteditable divs with role="spinbutton"
  // and data-type="year", data-type="month", data-type="day"
  // There's also a hidden input[name="birthday"] that stores the actual value

  const yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
  const monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
  const daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');

  if (yearSpinner && monthSpinner && daySpinner) {
    log('Step 5: Found React Aria DateField spinbuttons');

    // Helper to set a spinbutton value via focus + keyboard input
    async function setSpinButton(el, value) {
      el.focus();
      await sleep(100);

      // Select all existing text
      document.execCommand('selectAll', false, null);
      await sleep(50);

      // Type the new value digit by digit
      const valueStr = String(value);
      for (const char of valueStr) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: `Digit${char}`, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: `Digit${char}`, bubbles: true }));
        // Also use InputEvent for React Aria
        el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true }));
        el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
        await sleep(50);
      }

      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', code: 'Tab', bubbles: true }));
      el.blur();
      await sleep(100);
    }

    await setSpinButton(yearSpinner, year);
    log(`Step 5: Year set: ${year}`);

    await setSpinButton(monthSpinner, String(month).padStart(2, '0'));
    log(`Step 5: Month set: ${month}`);

    await setSpinButton(daySpinner, String(day).padStart(2, '0'));
    log(`Step 5: Day set: ${day}`);

    // Also update the hidden input directly as a safety measure
    const hiddenBirthday = document.querySelector('input[type="hidden"][name="birthday"]');
    if (hiddenBirthday) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Step 5: Hidden birthday input set: ${dateStr}`);
    }
  } else {
    // Fallback: try setting hidden input directly
    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    if (hiddenBirthday) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Step 5: Birthday set via hidden input: ${dateStr}`);
    } else {
      log('Step 5: WARNING - Could not find birthday fields. May need to adjust selectors.', 'warn');
    }
  }

  // Korean consent page: only click "allCheckboxes" once to accept all required consents.
  await sleepRandom(250, 450);
  const allConsentInput = document.querySelector(
    'input[name="allCheckboxes"], input[id$="-allCheckboxes"]'
  );
  if (allConsentInput) {
    if (!allConsentInput.checked) {
      const clickable = allConsentInput.closest('label') || allConsentInput;
      clickable.scrollIntoView({ block: 'center', inline: 'nearest' });
      await sleepRandom(80, 180);
      // Use native click for checkbox frameworks that rely on internal handlers.
      clickable.click();
      await sleepRandom(150, 300);

      if (!allConsentInput.checked) {
        // Fallback: force state and emit events for reactive forms.
        allConsentInput.checked = true;
        allConsentInput.dispatchEvent(new Event('input', { bubbles: true }));
        allConsentInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      log('Step 5: Clicked "我同意以下所有各项" checkbox');
    } else {
      log('Step 5: "我同意以下所有各项" already checked');
    }
  }

  // Click "完成帐户创建" button
  await sleepRandom(450, 900);
  const completeBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /完成|create|continue|finish|done|agree/i, 5000).catch(() => null);

  // Report complete BEFORE submit (page navigates to add-phone after this)
  reportComplete(5);

  if (completeBtn) {
    simulateClick(completeBtn);
    log('Step 5: Clicked "完成帐户创建"');
  }
}
