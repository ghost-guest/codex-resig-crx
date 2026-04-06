// content/signup-page.js — Content script for OpenAI auth pages

console.log('[MultiPage:signup-page] Content script loaded on', location.href);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXECUTE_STEP' || message.type === 'FILL_CODE' || message.type === 'STEP8_FIND_AND_CLICK') {
    resetStopState();
    handleCommand(message).then((result) => {
      sendResponse({ ok: true, ...(result || {}) });
    }).catch(err => {
      if (isStopError(err)) {
        log(`Step ${message.step || 8}: Stopped by user.`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }

      if (message.type === 'STEP8_FIND_AND_CLICK') {
        log(`Step 8: ${err.message}`, 'error');
        sendResponse({ error: err.message });
        return;
      }

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
        case 8: return await step8_findAndClick();
        case 41:
        case 71:
          return await stepResendVerificationEmail(message.step);
        default:
          throw new Error(`signup-page.js does not handle step ${message.step}`);
      }
    case 'FILL_CODE':
      return await fillVerificationCode(message.step, message.payload);
    case 'STEP8_FIND_AND_CLICK':
      return await step8_findAndClick();
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

async function step2_clickRegister() {
  log('Step 2: Waiting for page to render...');
  await humanPause(700, 1500);
  log('Step 2: Looking for Register/Sign up button...');

  let registerBtn = null;
  try {
    registerBtn = await waitForElementByText(
      'a, button, [role="button"], [role="link"]',
      /sign\s*up|register|create\s*account|注册/i,
      10000
    );
  } catch {
    try {
      registerBtn = await waitForElement('a[href*="signup"], a[href*="register"]', 5000);
    } catch {
      throw new Error('Could not find Register/Sign up button. Check auth page DOM in DevTools. URL: ' + location.href);
    }
  }

  reportComplete(2);
  await humanPause(450, 1200);
  simulateClick(registerBtn);
  log('Step 2: Clicked Register button');
}

async function step3_fillEmailPassword(payload) {
  const { email } = payload;
  if (!email) throw new Error('No email provided. Paste email in Side Panel first.');

  log('Step 3: Waiting for signup form to render...');
  await humanPause(1200, 2200);
  log(`Step 3: Filling email: ${email}`);

  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email"], input[placeholder*="Email"]',
      10000
    );
  } catch {
    throw new Error('Could not find email input field on signup page. URL: ' + location.href);
  }

  await humanPause(500, 1400);
  fillInput(emailInput, email);
  log('Step 3: Email filled');

  let passwordInput = document.querySelector('input[type="password"]');
  if (!passwordInput) {
    log('Step 3: No password field yet, submitting email first...');
    const submitBtn = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);

    if (submitBtn) {
      await humanPause(400, 1100);
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
  await humanPause(600, 1500);
  fillInput(passwordInput, payload.password);
  log('Step 3: Password filled');

  await sleepRandom(450, 900);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|sign\s*up|submit|注册|创建|create/i, 5000).catch(() => null);

  if (submitBtn) {
    await humanPause(500, 1300);
    await activateActionElement(submitBtn, 'Step 3 submit');
    log('Step 3: Form submitted, waiting for verification page...');
  } else if (passwordInput.form) {
    passwordInput.form.requestSubmit();
    log('Step 3: Submitted via password form.requestSubmit(), waiting for verification page...');
  } else {
    throw new Error('Could not find submit button on signup page. URL: ' + location.href);
  }

  const verificationReady = await waitForSignupVerificationScreen();
  if (!verificationReady) {
    throw new Error('Signup form submitted but verification page did not appear in time. URL: ' + location.href);
  }

  reportComplete(3, { email, submittedAt: Date.now() });
}

function getSignupSubmissionErrorMessage() {
  const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  if (!bodyText) return '';

  const patterns = [
    /创建[账帐]户失败，请重试/i,
    /创建[账帐]户失败/i,
    /failed to create account/i,
    /create account failed/i,
    /something went wrong/i,
  ];

  const matched = patterns.find((pattern) => pattern.test(bodyText));
  if (!matched) return '';

  const snippet = bodyText.match(/创建[账帐]户失败，请重试|创建[账帐]户失败|failed to create account|create account failed|something went wrong/i);
  return snippet ? snippet[0] : 'Create account failed';
}

async function waitForSignupVerificationScreen(timeout = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    throwIfStopped();

    const hasCodeInput = !!document.querySelector(
      'input[name="code"], input[name="otp"], input[type="text"][maxlength="6"], input[aria-label*="code"], input[placeholder*="code"], input[placeholder*="Code"], input[inputmode="numeric"]'
    );
    const hasEmailInput = !!document.querySelector(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email" i], input[placeholder*="Email"]'
    );
    const hasPasswordInput = !!document.querySelector('input[type="password"]');
    const bodyText = (document.body?.innerText || '').toLowerCase();
    const hasVerificationHints = /verification|verify|验证码|确认邮箱|check your email|enter code|输入验证码|代码/.test(bodyText);
    const signupSubmitError = getSignupSubmissionErrorMessage();

    if (hasCodeInput || (hasVerificationHints && !hasEmailInput && !hasPasswordInput)) {
      return true;
    }
    if (signupSubmitError) {
      throw new Error(`ACCOUNT_CREATION_FAILED: ${signupSubmitError}. URL: ${location.href}`);
    }

    await sleepRandom(500, 900);
  }

  return false;
}

async function fillVerificationCode(step, payload) {
  const { code } = payload;
  if (!code) throw new Error('No verification code provided.');

  log(`Step ${step}: Waiting for verification code page to render...`);
  await humanPause(1200, 2200);
  log(`Step ${step}: Filling verification code: ${code}`);

  let codeInput = null;
  try {
    codeInput = await waitForElement(
      'input[name="code"], input[name="otp"], input[type="text"][maxlength="6"], input[aria-label*="code"], input[placeholder*="code"], input[placeholder*="Code"], input[inputmode="numeric"]',
      10000
    );
  } catch {
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

  reportComplete(step);

  await sleepRandom(450, 900);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /verify|confirm|submit|continue|确认|验证/i, 5000).catch(() => null);

  if (submitBtn) {
    await humanPause(450, 1200);
    simulateClick(submitBtn);
    log(`Step ${step}: Verification submitted`);
  }
}

async function stepResendVerificationEmail(step) {
  log(`Step ${step}: Waiting for resend verification email button...`);
  await humanPause(1200, 2200);

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

async function step6_login(payload) {
  const { email, password } = payload;
  if (!email) throw new Error('No email provided for login.');

  log('Step 6: Waiting for login page to render...');
  await humanPause(1800, 3200);
  log(`Step 6: Logging in with ${email}...`);

  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email" i], input[placeholder*="Email"]',
      15000
    );
  } catch {
    throw new Error('Could not find email input on login page. URL: ' + location.href);
  }

  await humanPause(500, 1400);
  fillInput(emailInput, email);
  log('Step 6: Email filled');

  await sleepRandom(450, 900);
  const submitBtn1 = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);
  if (submitBtn1) {
    await humanPause(400, 1100);
    simulateClick(submitBtn1);
    log('Step 6: Submitted email');
  }

  await humanPause(1800, 3200);

  const passwordInput = document.querySelector('input[type="password"]');
  if (passwordInput) {
    log('Step 6: Password field found, filling password...');
    await humanPause(550, 1450);
    fillInput(passwordInput, password);

    await sleepRandom(450, 900);
    const submitBtn2 = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|log\s*in|submit|sign\s*in|登录|继续/i, 5000).catch(() => null);
    reportComplete(6, { needsOTP: true });

    if (submitBtn2) {
      await humanPause(450, 1200);
      simulateClick(submitBtn2);
      log('Step 6: Submitted password, may need verification code (step 7)');
    }
    return;
  }

  log('Step 6: No password field. OTP flow or auto-redirect.');
  reportComplete(6, { needsOTP: true });
}

async function step8_findAndClick() {
  log('Step 8: Looking for OAuth consent "继续" button...');

  const continueBtn = await findContinueButton();
  await waitForButtonEnabled(continueBtn);

  await humanPause(350, 900);
  continueBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  continueBtn.focus();
  await sleep(250);

  const rect = getSerializableRect(continueBtn);
  log('Step 8: Found "继续" button and prepared debugger click coordinates.');
  return {
    rect,
    buttonText: (continueBtn.textContent || '').trim(),
    url: location.href,
  };
}

async function findContinueButton() {
  try {
    return await waitForElement(
      'button[type="submit"][data-dd-action-name="Continue"], button[type="submit"]._primary_3rdp0_107',
      10000
    );
  } catch {
    try {
      return await waitForElementByText('button', /继续|Continue/, 5000);
    } catch {
      throw new Error('Could not find "继续" button on OAuth consent page. URL: ' + location.href);
    }
  }
}

async function waitForButtonEnabled(button, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (isButtonEnabled(button)) return;
    await sleep(150);
  }
  throw new Error('"继续" button stayed disabled for too long. URL: ' + location.href);
}

function isButtonEnabled(button) {
  return Boolean(button)
    && !button.disabled
    && button.getAttribute('aria-disabled') !== 'true';
}

function getSerializableRect(el) {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    throw new Error('"继续" button has no clickable size after scrolling. URL: ' + location.href);
  }

  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    centerX: rect.left + (rect.width / 2),
    centerY: rect.top + (rect.height / 2),
  };
}

async function step5_fillNameBirthday(payload) {
  const { firstName, lastName, age, year, month, day } = payload;
  if (!firstName || !lastName) throw new Error('No name data provided.');

  log('Step 5: Waiting for name/birthday page to render...');
  await humanPause(1800, 3200);

  const resolvedAge = age ?? (year ? new Date().getFullYear() - Number(year) : null);
  const hasBirthdayData = [year, month, day].every(value => value != null && !Number.isNaN(Number(value)));
  if (!hasBirthdayData && (resolvedAge == null || Number.isNaN(Number(resolvedAge)))) {
    throw new Error('No birthday or age data provided.');
  }

  const fullName = `${firstName} ${lastName}`;
  log(`Step 5: Filling name: ${fullName}`);

  let nameInput = null;
  try {
    nameInput = await waitForElement(
      'input[name="name"], input[placeholder*="全名"], input[autocomplete="name"]',
      10000
    );
  } catch {
    throw new Error('Could not find name input. URL: ' + location.href);
  }
  await humanPause(500, 1300);
  fillInput(nameInput, fullName);
  log(`Step 5: Name filled: ${fullName}`);

  let birthdayMode = false;
  let ageInput = null;

  for (let i = 0; i < 100; i++) {
    const yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    const monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    const daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');
    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    ageInput = document.querySelector('input[name="age"]');

    if ((yearSpinner && monthSpinner && daySpinner) || hiddenBirthday) {
      birthdayMode = true;
      break;
    }
    if (ageInput) break;
    await sleep(100);
  }

  if (birthdayMode) {
    if (!hasBirthdayData) {
      throw new Error('Birthday field detected, but no birthday data provided.');
    }

    const yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    const monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    const daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');

    if (yearSpinner && monthSpinner && daySpinner) {
      log('Step 5: Birthday fields detected, filling birthday...');

      async function setSpinButton(el, value) {
        el.focus();
        await sleep(100);
        document.execCommand('selectAll', false, null);
        await sleep(50);

        const valueStr = String(value);
        for (const char of valueStr) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: `Digit${char}`, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: `Digit${char}`, bubbles: true }));
          el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true }));
          el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
          await sleep(50);
        }

        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', code: 'Tab', bubbles: true }));
        el.blur();
        await sleep(100);
      }

      await humanPause(450, 1100);
      await setSpinButton(yearSpinner, year);
      await humanPause(250, 650);
      await setSpinButton(monthSpinner, String(month).padStart(2, '0'));
      await humanPause(250, 650);
      await setSpinButton(daySpinner, String(day).padStart(2, '0'));
      log(`Step 5: Birthday filled: ${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }

    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    if (hiddenBirthday) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Step 5: Hidden birthday input set: ${dateStr}`);
    }
  } else if (ageInput) {
    if (resolvedAge == null || Number.isNaN(Number(resolvedAge))) {
      throw new Error('Age field detected, but no age data provided.');
    }
    await humanPause(500, 1300);
    fillInput(ageInput, String(resolvedAge));
    log(`Step 5: Age filled: ${resolvedAge}`);
  } else {
    throw new Error('Could not find birthday or age input. URL: ' + location.href);
  }

  await sleepRandom(250, 450);
  const allConsentInput = document.querySelector(
    'input[name="allCheckboxes"], input[id$="-allCheckboxes"]'
  );
  if (allConsentInput) {
    if (!allConsentInput.checked) {
      const clickable = allConsentInput.closest('label') || allConsentInput;
      clickable.scrollIntoView({ block: 'center', inline: 'nearest' });
      await sleepRandom(80, 180);
      clickable.click();
      await sleepRandom(150, 300);

      if (!allConsentInput.checked) {
        allConsentInput.checked = true;
        allConsentInput.dispatchEvent(new Event('input', { bubbles: true }));
        allConsentInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      log('Step 5: Clicked "我同意以下所有各项" checkbox');
    } else {
      log('Step 5: "我同意以下所有各项" already checked');
    }
  }

  await sleepRandom(450, 900);
  const completeBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /完成|create|continue|finish|done|agree/i, 5000).catch(() => null);

  reportComplete(5);

  if (completeBtn) {
    await humanPause(500, 1300);
    simulateClick(completeBtn);
    log('Step 5: Clicked "完成帐户创建"');
  }
}
