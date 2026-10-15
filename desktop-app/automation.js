if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config();
}
const { chromium } = require('playwright');
const path = require('path');
const cacheManager = require('./cache-manager');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const DEFAULT_BROWSER_ARGS = [
  '--disable-blink-features=AutomationControlled'
];

/**
 * Injects anti-bot stealth scripts to mask navigator and browser runtime properties
 */
async function applyStealthHardening(context) {
  if (!context || typeof context.addInitScript !== 'function') return;
  try {
    await context.addInitScript(() => {
      // 1. Mask navigator.webdriver
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch (e) {}

      // 2. Mock chrome runtime object expected by Blink security checks
      try {
        if (!window.chrome) {
          window.chrome = {
            runtime: {},
            loadTimes: function() {},
            csi: function() {},
            app: {}
          };
        }
      } catch (e) {}

      // 3. Mock realistic plugin array
      try {
        if (!navigator.plugins || navigator.plugins.length === 0) {
          const fakePlugins = [
            { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
          ];
          Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins });
        }
      } catch (e) {}

      // 4. Mock regional languages
      try {
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'ms'] });
      } catch (e) {}
    });
  } catch (err) {
    console.warn('[PLAYWRIGHT STEALTH] addInitScript warning:', err.message);
  }
}

/**
 * Humanizes input typing cadence with subtle randomized intervals and pauses
 */
async function humanType(page, selector, text) {
  if (!text) return;
  try {
    if (process.env.NODE_ENV === 'test' || !page || typeof page.fill !== 'function') {
      if (page && typeof page.fill === 'function') await page.fill(selector, text);
      return;
    }

    // Focus field and clear prior content
    await page.click(selector).catch(() => {});
    await page.fill(selector, '').catch(() => {});

    // Realistic human cadence: 45ms to 95ms per keystroke
    for (const char of text) {
      const delay = Math.floor(Math.random() * 50) + 45;
      if (typeof page.type === 'function') {
        await page.type(selector, char, { delay }).catch(async () => {
          await page.fill(selector, text);
        });
      } else {
        await page.fill(selector, text);
        break;
      }

      // 5% chance of a slight reading hesitation (100ms - 200ms)
      if (Math.random() < 0.05 && typeof page.waitForTimeout === 'function') {
        await page.waitForTimeout(Math.floor(Math.random() * 100) + 100);
      }
    }
  } catch (err) {
    console.warn(`[PLAYWRIGHT STEALTH] humanType fallback for ${selector}:`, err.message);
    if (page && typeof page.fill === 'function') {
      await page.fill(selector, text).catch(() => {});
    }
  }
}

/**
 * Moves cursor with smooth trajectory and clicks within natural element bounds
 */
async function humanClick(page, targetFrame, selector, targetHandle) {
  try {
    if (process.env.NODE_ENV === 'test') {
      if (targetHandle && typeof targetHandle.click === 'function') {
        await targetHandle.click();
      } else if (targetFrame && typeof targetFrame.click === 'function') {
        await targetFrame.click(selector);
      }
      return;
    }

    let box = null;
    if (targetHandle && typeof targetHandle.boundingBox === 'function') {
      box = await targetHandle.boundingBox().catch(() => null);
    }
    if (!box && targetFrame && typeof targetFrame.locator === 'function') {
      box = await targetFrame.locator(selector).first().boundingBox().catch(() => null);
    }

    if (box && box.width > 0 && box.height > 0) {
      // Pick random coordinates within inner 25% - 75% of button
      const offsetX = box.width * (0.25 + Math.random() * 0.5);
      const offsetY = box.height * (0.25 + Math.random() * 0.5);

      // Smooth mouse approach if page.mouse is available
      if (page && page.mouse && typeof page.mouse.move === 'function') {
        const steps = Math.floor(Math.random() * 6) + 4;
        await page.mouse.move(box.x + offsetX, box.y + offsetY, { steps }).catch(() => {});
        if (typeof page.waitForTimeout === 'function') {
          await page.waitForTimeout(Math.floor(Math.random() * 150) + 120);
        }
      }

      const clickOptions = {
        position: { x: offsetX, y: offsetY },
        delay: Math.floor(Math.random() * 40) + 30
      };

      if (targetHandle && typeof targetHandle.click === 'function') {
        await targetHandle.click(clickOptions);
      } else if (targetFrame && typeof targetFrame.click === 'function') {
        await targetFrame.click(selector, clickOptions);
      }
    } else {
      if (targetHandle && typeof targetHandle.click === 'function') {
        await targetHandle.click();
      } else if (targetFrame && typeof targetFrame.click === 'function') {
        await targetFrame.click(selector);
      }
    }
  } catch (err) {
    console.warn(`[PLAYWRIGHT STEALTH] humanClick fallback for ${selector}:`, err.message);
    if (targetHandle && typeof targetHandle.click === 'function') {
      await targetHandle.click().catch(() => {});
    } else if (targetFrame && typeof targetFrame.click === 'function') {
      await targetFrame.click(selector).catch(() => {});
    }
  }
}

async function captureProofSnapshot(page) {
  if (!page || typeof page.screenshot !== 'function') return null;
  try {
    // Redact sensitive personal identity info (NRIC / Staff ID / IC) before capturing visual proof
    const blurSensitiveData = () => {
      try {
        const sensitiveSelectors = [
          '#no_kp', '#nokp', '#ic_no', '#staff_id', '#no_pekerja',
          '.user-id', '.user-ic', '.staff-info', '.profile-info',
          'input[type="password"]', '[name*="password"]'
        ];
        document.querySelectorAll(sensitiveSelectors.join(',')).forEach(el => {
          el.style.filter = 'blur(6px)';
          el.style.userSelect = 'none';
        });

        // Scan text nodes for Malaysian NRIC pattern (\d{6}-\d{2}-\d{4} or 12 consecutive digits)
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
          const val = node.nodeValue || '';
          if (/\b\d{6}-\d{2}-\d{4}\b/.test(val) || /\b\d{12}\b/.test(val)) {
            if (node.parentElement && !node.parentElement.dataset.blurred) {
              node.parentElement.style.filter = 'blur(6px)';
              node.parentElement.style.userSelect = 'none';
              node.parentElement.dataset.blurred = 'true';
            }
          }
        }
      } catch (_) {}
    };

    if (typeof page.evaluate === 'function') {
      await page.evaluate(blurSensitiveData).catch(() => null);
    }
    const frames = typeof page.frames === 'function' ? page.frames() : [];
    for (const frame of frames) {
      if (typeof frame.evaluate === 'function') {
        await frame.evaluate(blurSensitiveData).catch(() => null);
      }
    }

    // 1. Try finding specific attendance summary card / table inside frames
    for (const frame of frames) {
      try {
        const targetElement = await frame.$('table.table, .table-responsive, #table-perakam, form[name="form1"]').catch(() => null);
        if (targetElement && typeof targetElement.screenshot === 'function') {
          const buffer = await targetElement.screenshot({ type: 'jpeg', quality: 80 }).catch(() => null);
          if (buffer && buffer.length > 500) {
            return buffer;
          }
        }
      } catch (_) {}
    }

    // 2. Try on main page
    try {
      const mainElement = await page.$('table.table, .table-responsive, #table-perakam, form[name="form1"]').catch(() => null);
      if (mainElement && typeof mainElement.screenshot === 'function') {
        const buffer = await mainElement.screenshot({ type: 'jpeg', quality: 80 }).catch(() => null);
        if (buffer && buffer.length > 500) {
          return buffer;
        }
      }
    } catch (_) {}

    // 3. Viewport fallback
    return await page.screenshot({ type: 'jpeg', quality: 80 }).catch(() => null);
  } catch (err) {
    console.warn('[PLAYWRIGHT] Proof snapshot capture skipped:', err.message);
    return null;
  }
}

async function testTelegramAlert(credentials = {}) {
  const config = (typeof cacheManager.getDeviceConfig === 'function') ? cacheManager.getDeviceConfig() : {};
  const token = credentials.token || credentials.botToken || credentials.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN || config.telegram_bot_token;
  const chatId = credentials.chatId || credentials.telegram_chat_id || process.env.TELEGRAM_CHAT_ID || config.telegram_chat_id;
  if (!token || !chatId) {
    return { success: false, error: 'Both Telegram Bot Token and Chat ID are required.' };
  }
  const botIdFromToken = token.split(':')[0];
  if (String(chatId).trim() === botIdFromToken) {
    return {
      success: false,
      error: `Invalid Chat ID: ${chatId} is your Bot's own ID! The Chat ID must be your personal Telegram User ID (e.g. from @userinfobot) so the bot can send messages to your account.`
    };
  }
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const messageText = credentials.message || '⚡ <b>[ALS Desktop Engine]</b>\nTest notification successful!\nYour Telegram bot is properly configured and ready to receive real-time attendance alerts and verified visual proof snapshots.';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: messageText,
        parse_mode: 'HTML'
      })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && (data.ok || data.ok === undefined)) {
      return { success: true };
    }
    return { success: false, error: data.description || `HTTP ${res.status}: ${res.statusText}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function sendTelegramAlert(message, deviceId = 'home_desktop_agent', options = {}) {
  const config = (typeof cacheManager.getDeviceConfig === 'function') ? cacheManager.getDeviceConfig() : {};
  const token = process.env.TELEGRAM_BOT_TOKEN || config.telegram_bot_token;
  const chatId = process.env.TELEGRAM_CHAT_ID || config.telegram_chat_id;
  if (!token || !chatId) {
    console.warn('[TELEGRAM] Token or Chat ID missing. Skipping alert.');
    return;
  }
  const formattedMessage = message.replace('[ALS Desktop]', `[ALS Desktop: ${deviceId}]`);
  const photoBuffer = options.photoBuffer || options.screenshotBuffer;

  if (photoBuffer && Buffer.isBuffer(photoBuffer)) {
    try {
      const formData = new FormData();
      formData.append('chat_id', chatId);
      formData.append('caption', formattedMessage);
      formData.append('photo', new Blob([photoBuffer], { type: 'image/jpeg' }), 'attendance_proof.jpg');

      const url = `https://api.telegram.org/bot${token}/sendPhoto`;
      const res = await fetch(url, {
        method: 'POST',
        body: formData
      });
      if (res && res.ok) {
        console.log('[TELEGRAM] Visual proof photo sent successfully.');
        return;
      } else {
        const errText = res ? await res.text().catch(() => '') : 'no response';
        console.warn(`[TELEGRAM] Failed to send photo (${res ? res.status : 'error'}: ${errText}), falling back to text message...`);
      }
    } catch (photoErr) {
      console.warn('[TELEGRAM] Error uploading photo, falling back to text message:', photoErr.message);
    }
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: formattedMessage })
    });
  } catch (err) {
    console.error('[TELEGRAM] Error sending alert:', err.message);
  }
}

async function remoteLog(supabase, action, status, message, deviceId = null) {
  try {
    const payload = { action, status, message };
    if (deviceId) {
      payload.device_id = deviceId;
    } else {
      try { payload.device_id = cacheManager.getDeviceConfig().device_id; } catch(e) {}
    }
    const { error } = await supabase.from('logs').insert(payload);
    if (error) {
        console.error('[SUPABASE LOG ERROR]', error.message);
    }
  } catch (err) {
    cacheManager.logOffline(action, status, message);
  }
}

async function checkDashboardStatus(page, actionType, supabase, targetDeviceId) {
  try {
    const devId = targetDeviceId || (cacheManager.getDeviceConfig ? cacheManager.getDeviceConfig()?.device_id : null) || 'home_desktop_agent';
    const proofData = await page.evaluate(() => {
      const docs = [document, ...Array.from(document.querySelectorAll('iframe')).map(f => f.contentDocument).filter(Boolean)];
      let twm = '--:--', wm = '?', wk = '?';
      for (const doc of docs) {
        if (doc.querySelector('#twm')) twm = doc.querySelector('#twm').innerText.trim();
        if (doc.querySelector('#wm')) wm = doc.querySelector('#wm').innerText.trim();
        if (doc.querySelector('#wk')) wk = doc.querySelector('#wk').innerText.trim();
      }
      return { date: twm, clockIn: wm, clockOut: wk };
    });

    const targetVal = actionType === 'clock_in' ? proofData.clockIn : (actionType === 'clock_out' ? proofData.clockOut : null);
    const standardDate = new Date().toLocaleDateString('en-CA');
    
    if (targetVal && targetVal !== '?' && targetVal.length > 2) {
      console.log(`[PLAYWRIGHT] Pre-Flight Check: Action already completed! Extracted: ${targetVal}`);
      try {
        const { error } = await supabase.from('todays_proof').upsert({
          date: standardDate,
          clock_in: proofData.clockIn,
          clock_out: proofData.clockOut,
          device_id: devId,
          updated_at: new Date().toISOString()
        }, { onConflict: 'date, device_id' });
        if (error) throw error;
        cacheManager.updateCache('todays_proof', { date: standardDate, clock_in: proofData.clockIn, clock_out: proofData.clockOut, synced: true });
      } catch (err) {
        console.error('[PLAYWRIGHT] Supabase offline! Queueing manual proof to local cache.');
        cacheManager.queueOfflineProof({ date: standardDate, clock_in: proofData.clockIn, clock_out: proofData.clockOut });
      }

      if (global.updateTrayTooltip) global.updateTrayTooltip();

      await remoteLog(supabase, actionType, 'skipped', 'Manual entry verified', devId);

      return true;
    }
    console.log('[PLAYWRIGHT] Pre-Flight Check: Action not yet completed.');
    return false;
  } catch (err) {
    console.error('[PLAYWRIGHT] Error in checkDashboardStatus:', err);
    return false;
  }
}

async function getSystemConfig(supabase) {
  const localConfig = cacheManager.getEngineConfig ? cacheManager.getEngineConfig() : null;
  const localTargetUrl = localConfig?.target_url || cacheManager.getDeviceConfig()?.target_url || cacheManager.readCache()?.system_config?.target_url || 'https://perakamwaktu.upm.edu.my/';
  const localShowBrowser = localConfig ? localConfig.show_browser : (cacheManager.getDeviceConfig()?.show_browser ?? cacheManager.readCache()?.system_config?.show_browser ?? false);
  const isCustomLocal = localConfig && localConfig.target_url && localConfig.target_url !== 'https://perakamwaktu.upm.edu.my/';

  try {
    const { data, error } = await supabase.from('system_config').select('*').eq('id', 1).maybeSingle();
    if (error) throw error;
    
    const targetUrl = isCustomLocal ? localTargetUrl : (data?.target_url || localTargetUrl);
    const showBrowser = isCustomLocal ? localShowBrowser : (typeof data?.show_browser === 'boolean' ? data.show_browser : localShowBrowser);
    
    cacheManager.mergeSystemConfig({ target_url: targetUrl, show_browser: showBrowser }, true);
    
    return { targetUrl, showBrowser };
  } catch (err) {
    console.warn('[PLAYWRIGHT] Supabase offline or unavailable! Fetching config from local cache/settings.');
    const cache = cacheManager.readCache();
    return {
      targetUrl: localTargetUrl || cache?.system_config?.target_url || 'https://perakamwaktu.upm.edu.my/',
      showBrowser: localShowBrowser
    };
  }
}

async function waitUntilTarget(page, targetAt, maxLateMs = 5 * 60 * 1000) {
  if (!targetAt) return;
  const targetTime = new Date(targetAt).getTime();
  
  if (!Number.isFinite(targetTime)) {
    throw new Error('INVALID_TARGET_TIME');
  }
  
  while (true) {
    const now = Date.now();
    const remainingMs = targetTime - now;

    if (remainingMs <= 0) {
      if (-remainingMs > maxLateMs) {
        throw new Error('MISSED_TARGET_WINDOW');
      }
      break;
    }

    const waitMs = Math.min(remainingMs, 5000); // Check every 5 seconds
    await page.waitForTimeout(waitMs);
  }
}

function isRetryableGatewayError(error) {
  if (!error) return false;
  const msg = String(error.message || error).toLowerCase();

  // Explicit non-retryable errors
  if (msg.includes('captive_portal')) return false;
  if (msg.includes('target time has already passed')) return false;
  if (msg.includes('expired')) return false;
  if (msg.includes('invalid target time')) return false;
  if (msg.includes('invalid action type')) return false;

  // Retryable transient gateway/WAF/network errors
  if (
    msg.includes('portal_blocked') ||
    msg.includes('blocked by security gateway') ||
    msg.includes('fortiguard') ||
    msg.includes('fortiweb') ||
    msg.includes('access denied') ||
    msg.includes('not found in any frame') ||
    msg.includes('timeout') ||
    msg.includes('net::err_') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504')
  ) {
    return true;
  }
  return false;
}

async function executeClockActionSingleAttempt(actionType, supabase, options = {}) {
  const targetDeviceId = options && options.hubAccount ? options.hubAccount.device_id : cacheManager.getDeviceConfig().device_id;
  let context;
  try {
    const config = await getSystemConfig(supabase);

    // 1. Network / Captive Portal Check
    console.log('[PLAYWRIGHT] Checking network route via neverssl.com...');
    let fetchText = '';
    try {
      const fetchResponse = await fetch('http://neverssl.com', { signal: AbortSignal.timeout(5000) });
      fetchText = await fetchResponse.text();
    } catch (e) {
      console.warn(`[PLAYWRIGHT] Pre-flight ping to neverssl.com failed (${e.message}). Skipping Captive Portal check and attempting direct portal navigation...`);
      fetchText = '<html'; // Mock a clean response to bypass captive portal logic
    }

    if (!fetchText.includes('<html')) {
      console.warn('[PLAYWRIGHT] Captive Portal detected! Attempting autonomous bypass...');
      global.connectivityState = 'Captive Portal Flag';
      if (global.updateTrayTooltip) global.updateTrayTooltip();
      await remoteLog(supabase, 'network_check', 'warning', 'Captive portal intercepted the connection. Attempting bypass.', targetDeviceId);
      
      try {
        const { error } = await supabase.from('device_status').upsert({
          id: 'home_desktop_agent',
          current_status: 'CAPTIVE_PORTAL',
          last_seen: new Date().toISOString()
        });
        if (error) throw error;
      } catch (e) {}

      let cpContext;
      try {
        cpContext = await chromium.launch({ channel: 'msedge', headless: true });
        const cpPage = await cpContext.newPage();
        await cpPage.goto('http://neverssl.com', { waitUntil: 'networkidle', timeout: 20000 });
        
        const hasUserInput = await cpPage.$('input[type="text"], input[type="email"], input[name="username"], input[name="user"]');
        const hasPassInput = await cpPage.$('input[type="password"]');
        
        if (hasUserInput && hasPassInput && process.env.WIFI_USERNAME && process.env.WIFI_PASSWORD) {
          console.log('[PLAYWRIGHT] Captive Portal login fields found. Injecting credentials...');
          await cpPage.fill('input[type="text"], input[type="email"], input[name="username"], input[name="user"]', process.env.WIFI_USERNAME);
          await cpPage.fill('input[type="password"]', process.env.WIFI_PASSWORD);
          
          await cpPage.click('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Submit"), button:has-text("Sign In")');
          
          console.log('[PLAYWRIGHT] Captive Portal credentials submitted. Waiting for network clearance...');
          await cpPage.waitForTimeout(5000);
          
          const postFetch = await fetch('http://neverssl.com');
          const postText = await postFetch.text();
          if (postText.includes('<html')) {
            console.log('[PLAYWRIGHT] Captive Portal bypassed successfully!');
            await remoteLog(supabase, 'network_check', 'success', 'Captive portal bypassed successfully.', targetDeviceId);
            global.connectivityState = 'Connected to Supabase';
            if (global.updateTrayTooltip) global.updateTrayTooltip();
          } else {
            throw new Error('Bypass failed, still intercepted.');
          }
        } else {
          throw new Error('Missing WIFI credentials or login fields not found.');
        }
      } catch (cpErr) {
        console.error('[PLAYWRIGHT] Captive Portal bypass failed:', cpErr.message);
        await sendTelegramAlert(`🚨 [ALS Desktop] CAPTIVE PORTAL BYPASS FAILED! Cannot execute ${actionType.toUpperCase()}. Reason: ${cpErr.message}`, targetDeviceId);
        throw new Error('CAPTIVE_PORTAL');
      } finally {
        if (cpContext) await cpContext.close();
      }
    }

    // 2. Browser Launch
    console.log('[PLAYWRIGHT] Launching persistent browser context (headless: ' + !config.showBrowser + ')...');
    let userDataDir;
    try {
      const basePath = require('electron').app.getPath('userData');
      if (options && options.hubAccount) {
        const primarySession = path.join(basePath, `upm_session_${options.hubAccount.device_id}`);
        if (!fs.existsSync(primarySession)) {
          const legacySession = path.join(require('electron').app.getPath('appData'), 'ALS-Full', `upm_session_${options.hubAccount.device_id}`);
          userDataDir = fs.existsSync(legacySession) ? legacySession : primarySession;
        } else {
          userDataDir = primarySession;
        }
      } else {
        userDataDir = path.join(basePath, 'upm_session');
      }
    } catch (e) {
      const basePath = require('os').homedir();
      userDataDir = (options && options.hubAccount) 
        ? path.join(basePath, `.als_upm_session_${options.hubAccount.device_id}`) 
        : path.join(basePath, '.als_upm_session');
    }
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'msedge',
      headless: !config.showBrowser,
      viewport: { width: 1280, height: 720 },
      args: DEFAULT_BROWSER_ARGS,
      userAgent: DEFAULT_USER_AGENT
    });

    await applyStealthHardening(context);

    const page = await context.newPage();

    // 3. Portal Navigation
    console.log('[PLAYWRIGHT] Navigating to target portal: ' + config.targetUrl);
    await page.goto(config.targetUrl);

    const pageTitle = typeof page.title === 'function' ? await page.title().catch(() => '') : '';
    const titleLower = pageTitle.toLowerCase();
    if (
      titleLower.includes('blocked') ||
      titleLower.includes('forbidden') ||
      titleLower.includes('fortiguard') ||
      titleLower.includes('fortiweb') ||
      titleLower.includes('access denied')
    ) {
      throw new Error(`PORTAL_BLOCKED: Target portal access was blocked by security gateway (${pageTitle}).`);
    }

    // 4. Auth
    const isLoginPage = page.url().toLowerCase().includes('login') || await page.isVisible('input[type="password"]');

    if (isLoginPage) {
      console.log('[PLAYWRIGHT] Login context detected. Injecting credentials...');
      let username, password;
      if (options && options.hubAccount) {
        username = options.hubAccount.upm_username;
        password = options.hubAccount.upm_password;
      } else {
        const deviceConfig = cacheManager.getDeviceConfig();
        username = deviceConfig.upm_username || process.env.UPM_USERNAME || '';
        password = deviceConfig.upm_password || process.env.UPM_PASSWORD || '';
      }
      
      if (!username || !password) {
        console.warn('[PLAYWRIGHT] Missing UPM Username or Password in device settings!');
      }

      await humanType(page, '#username', username ? username.trim() : '');
      await humanType(page, '#password', password ? password.trim() : '');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
        humanClick(page, page, 'button[type="submit"], input[type="submit"], #btn-login, .btn-login')
      ]);
    }

    // 4.5 Pre-Flight
    console.log('[PLAYWRIGHT] Waiting 5 seconds for dashboard elements to fully render...');
    await page.waitForTimeout(5000);

    console.log('[PLAYWRIGHT] Running Pre-Flight Dashboard Verification...');
    let isAlreadyDone = await checkDashboardStatus(page, actionType, supabase, targetDeviceId);
    if (isAlreadyDone) {
      console.log(`[PLAYWRIGHT] Manual action detected, skipping automated click for ${actionType}`);
      const proofSnapshot = await captureProofSnapshot(page);
      await sendTelegramAlert(`✅ [ALS Desktop] Pre-Flight Check: ${actionType.toUpperCase()} already completed! Skipping automated action.`, targetDeviceId, { photoBuffer: proofSnapshot });
      await context.close();
      return true;
    }
    
    if (options.targetAt) {
      console.log(`[PLAYWRIGHT] Pre-Flight cleared. Waiting dynamically for exact target time: ${options.targetAt}...`);
      await waitUntilTarget(page, options.targetAt);

      console.log('[PLAYWRIGHT] Target time reached. Running final pre-flight check...');
      isAlreadyDone = await checkDashboardStatus(page, actionType, supabase, targetDeviceId);
      if (isAlreadyDone) {
        console.log(`[PLAYWRIGHT] Manual action detected during wait, skipping automated click for ${actionType}`);
        const proofSnapshot = await captureProofSnapshot(page);
        await sendTelegramAlert(`✅ [ALS Desktop] Final Pre-Flight Check: ${actionType.toUpperCase()} already completed! Skipping automated action.`, targetDeviceId, { photoBuffer: proofSnapshot });
        await context.close();
        return true;
      }
    } else {
      console.log('[PLAYWRIGHT] Pre-Flight cleared. Executing immediately (no target time provided)...');
    }

    // 5. Trigger
    console.log(`[PLAYWRIGHT] Executing smart element trigger for action: ${actionType}`);
    let selector = '#a50';
    if (actionType === 'clock_out') selector = '#a51';
    else if (actionType === 'ot_in') selector = '#a52';
    else if (actionType === 'ot_out') selector = '#a53';

    let targetFrame = page;
    let targetHandle = null;

    for (const frame of page.frames()) {
      targetHandle = await frame.$(selector);
      if (targetHandle) {
        targetFrame = frame;
        break;
      }
    }

    if (!targetHandle) {
      throw new Error(`Element ${selector} not found in any frame.`);
    }

    await targetFrame.evaluate((selectorStr) => {
      const el = document.querySelector(selectorStr);
      if (!el) return;
      
      let li = el.closest('li');
      while (li && !li.closest('ul.nav.side-menu')) {
        li = li.parentElement ? li.parentElement.closest('li') : null;
      }
      if (!li) return;

      const cls = (li.getAttribute('class') || '').trim();
      const anchor = li.querySelector(':scope > a, a');
      const style = window.getComputedStyle(el);
      const hidden = (el.offsetParent === null && style.position !== 'fixed') || style.display === 'none' || style.visibility === 'hidden';

      if (hidden || cls === '' || cls.includes('vn') || !cls.includes('active')) {
        if (anchor) anchor.click();
      }
    }, selector);

    await new Promise(r => setTimeout(r, 1000));
    await targetFrame.waitForSelector(selector, { state: 'visible', timeout: 15000 });

    const actualClickAt = new Date();
    const targetMs = options.targetAt
      ? new Date(options.targetAt).getTime()
      : null;

    const driftMs = targetMs === null
      ? null
      : actualClickAt.getTime() - targetMs;

    await humanClick(page, targetFrame, selector, targetHandle);

    // 6. Post-Flight
    console.log('[PLAYWRIGHT] Element triggered successfully. Verifying DOM for proof...');
    
    const targetProofSelector = actionType === 'clock_in' ? '#wm' : (actionType === 'clock_out' ? '#wk' : null);
    
    if (targetProofSelector) {
      try {
        await page.waitForFunction((selector) => {
          const docs = [document, ...Array.from(document.querySelectorAll('iframe')).map(f => f.contentDocument).filter(Boolean)];
          for (const doc of docs) {
            const el = doc.querySelector(selector);
            if (el) {
              const text = el.innerText.trim();
              if (text && text !== '?' && text !== '--:--' && text.length > 2) {
                return true;
              }
            }
          }
          return false;
        }, targetProofSelector, { timeout: 15000 });
      } catch (timeoutErr) {
        throw new Error('[TIMEOUT] Portal dashboard failed to update time values within 15s');
      }
    } else {
      // Overtime trigger (a52 / a53) - allow brief settle time for portal submission
      await new Promise(r => setTimeout(r, 2500));
    }
    
    const postProofData = await page.evaluate(() => {
      const docs = [document, ...Array.from(document.querySelectorAll('iframe')).map(f => f.contentDocument).filter(Boolean)];
      let twm = '--:--', wm = '--:--', wk = '--:--';
      for (const doc of docs) {
        if (doc.querySelector('#twm')) twm = doc.querySelector('#twm').innerText.trim();
        if (doc.querySelector('#wm')) wm = doc.querySelector('#wm').innerText.trim();
        if (doc.querySelector('#wk')) wk = doc.querySelector('#wk').innerText.trim();
      }
      return { date: twm, clockIn: wm, clockOut: wk };
    });

    const standardDate = new Date().toLocaleDateString('en-CA');

    // Resolve authenticated client for targetDeviceId if possible
    let clientToUse = supabase;
    let hubAccount = options && options.hubAccount;
    if (!hubAccount && targetDeviceId) {
      const accounts = cacheManager.getHubAccounts();
      hubAccount = accounts.find(a => a.device_id === targetDeviceId);
    }
    if (hubAccount && hubAccount.supabase_email && hubAccount.supabase_password) {
      try {
        let needNewClient = !clientToUse || !clientToUse.auth;
        if (!needNewClient) {
          const { data: userData } = await clientToUse.auth.getUser();
          if (!userData?.user || userData.user.email !== hubAccount.supabase_email) {
            needNewClient = true;
          }
        }
        if (needNewClient) {
          const { createClient } = require('@supabase/supabase-js');
          const envVars = cacheManager.getDeviceConfig();
          if (envVars.supabase_url && envVars.supabase_key) {
            const authClient = createClient(envVars.supabase_url, envVars.supabase_key, {
              auth: { persistSession: false }
            });
            const { data: authData, error: signInErr } = await authClient.auth.signInWithPassword({
              email: hubAccount.supabase_email,
              password: hubAccount.supabase_password
            });
            if (!signInErr && authData?.user) {
              clientToUse = authClient;
            }
          }
        }
      } catch (authErr) {
        console.warn('[AUTOMATION] Self-auth check warning in executeClockAction:', authErr.message);
      }
    }

    // 1. Capture visual proof snapshot (with sensitive personal data blurred)
    const proofSnapshot = await captureProofSnapshot(page);
    let proofThumbnail = null;
    let thumbnailDataUrl = null;
    if (proofSnapshot && typeof cacheManager.saveProofThumbnail === 'function') {
      proofThumbnail = cacheManager.saveProofThumbnail(proofSnapshot, standardDate);
      thumbnailDataUrl = typeof proofThumbnail === 'object' && proofThumbnail ? proofThumbnail.dataUrl : proofThumbnail;
    }

    try {
      if (clientToUse && typeof clientToUse.from === 'function') {
        let authUserId;
        if (clientToUse.auth) {
          const { data: userData } = await clientToUse.auth.getUser();
          if (userData && userData.user) authUserId = userData.user.id;
        }
        const proofPayload = {
          date: standardDate,
          clock_in: postProofData.clockIn,
          clock_out: postProofData.clockOut,
          device_id: targetDeviceId,
          updated_at: new Date().toISOString()
        };
        if (authUserId) proofPayload.user_id = authUserId;
        if (thumbnailDataUrl) proofPayload.proof_thumbnail = thumbnailDataUrl;

        let synced = false;
        try {
          const { error } = await clientToUse.from('todays_proof').upsert(proofPayload, { onConflict: 'date, device_id' });
          if (!error) {
            synced = true;
          } else if (proofPayload.proof_thumbnail) {
            delete proofPayload.proof_thumbnail;
            const retry = await clientToUse.from('todays_proof').upsert(proofPayload, { onConflict: 'date, device_id' });
            if (!retry.error) synced = true;
          }
        } catch (_) {
          if (proofPayload.proof_thumbnail) {
            delete proofPayload.proof_thumbnail;
            try {
              const retry = await clientToUse.from('todays_proof').upsert(proofPayload, { onConflict: 'date, device_id' });
              if (!retry.error) synced = true;
            } catch (_) {}
          }
        }
        cacheManager.updateCache('todays_proof', {
          date: standardDate,
          clock_in: postProofData.clockIn,
          clock_out: postProofData.clockOut,
          thumbnail: thumbnailDataUrl,
          synced
        });
      } else {
        cacheManager.updateCache('todays_proof', {
          date: standardDate,
          clock_in: postProofData.clockIn,
          clock_out: postProofData.clockOut,
          thumbnail: thumbnailDataUrl,
          synced: false
        });
      }
    } catch (err) {
      console.error('[PLAYWRIGHT] Supabase offline! Queueing automated proof to local cache.');
      cacheManager.queueOfflineProof({
        date: standardDate,
        clock_in: postProofData.clockIn,
        clock_out: postProofData.clockOut,
        thumbnail: proofThumbnail
      });
    }

    if (global.updateTrayTooltip) global.updateTrayTooltip();

    const source = options.source || 'unknown';
    const timingDescription = options.targetAt
      ? `source=${source}; target=${options.targetAt}; actual=${actualClickAt.toISOString()}; drift_ms=${driftMs}`
      : `source=${source}; actual=${actualClickAt.toISOString()}`;

    try {
      if (clientToUse && typeof clientToUse.from === 'function') {
        let authUserId;
        if (clientToUse.auth) {
          const { data: userData } = await clientToUse.auth.getUser();
          if (userData && userData.user) authUserId = userData.user.id;
        }
        const cmdPayload = {
          device_id: targetDeviceId,
          action: actionType,
          status: 'completed',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        if (authUserId) cmdPayload.user_id = authUserId;

        await clientToUse.from('commands').insert(cmdPayload);
      }
    } catch (cmdErr) {
      console.warn('[PLAYWRIGHT] Could not record command history:', cmdErr.message);
    }

    if (clientToUse && typeof clientToUse.from === 'function') {
      await remoteLog(clientToUse, actionType, 'success', `Successfully clicked ${selector}. ${timingDescription}`, targetDeviceId);
    }
    const inTime = postProofData?.clockIn || '--:--';
    const outTime = postProofData?.clockOut || '--:--';
    const proofDate = postProofData?.date || standardDate;
    const caption = `✅ [ALS Desktop] Successfully executed ${actionType.toUpperCase()} at ${new Date().toLocaleTimeString()}\n📅 Date: ${proofDate}\n🟢 In: ${inTime}\n🔴 Out: ${outTime}`;
    await sendTelegramAlert(caption, targetDeviceId, { photoBuffer: proofSnapshot });

    await context.close();
    return true;

  } catch (error) {
    if (context) {
      try {
        await context.close();
      } catch (closeErr) {
        console.warn('[PLAYWRIGHT] Error closing context on failure:', closeErr.message);
      }
    }
    throw error;
  }
}

async function executeClockAction(actionType, supabase, options = {}) {
  const maxAttempts = (options && options.maxAttempts) ? options.maxAttempts : 2;
  const targetDeviceId = options && options.hubAccount ? options.hubAccount.device_id : cacheManager.getDeviceConfig().device_id;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`[PLAYWRIGHT] Retrying clock action ${actionType} (attempt ${attempt}/${maxAttempts})...`);
      }
      return await executeClockActionSingleAttempt(actionType, supabase, options);
    } catch (error) {
      const isRetryable = isRetryableGatewayError(error);
      const hasRetriesLeft = attempt < maxAttempts;

      if (isRetryable && hasRetriesLeft) {
        const defaultDelay = (process.env.NODE_ENV === 'test')
          ? 10
          : (Math.floor(Math.random() * 15000) + 20000); // 20s - 35s jitter in production
        const retryDelayMs = (options && typeof options.retryDelayMs === 'number')
          ? options.retryDelayMs
          : defaultDelay;

        console.warn(`[PLAYWRIGHT] Attempt ${attempt}/${maxAttempts} encountered transient gateway error (${error.message}). Retrying in ${(retryDelayMs / 1000).toFixed(1)}s...`);
        try {
          await remoteLog(supabase, actionType, 'warning', `Attempt ${attempt}/${maxAttempts} encountered gateway issue: ${error.message}. Retrying in ${(retryDelayMs / 1000).toFixed(1)}s...`, targetDeviceId);
        } catch (_) {}

        await new Promise(res => setTimeout(res, retryDelayMs));
        continue;
      }

      console.error(`[PLAYWRIGHT] Execution failed (attempt ${attempt}/${maxAttempts}): ${error.message}`);
      await remoteLog(supabase, actionType, 'failed', `Error during execution: ${error.message}`, targetDeviceId);

      if (error.message !== 'CAPTIVE_PORTAL') {
        await sendTelegramAlert(`❌ [ALS Desktop] Execution FAILED for ${actionType.toUpperCase()}: ${error.message}`, targetDeviceId);
      }

      throw error;
    }
  }
}

async function openDebugBrowser(supabase, options = {}) {
  const config = await getSystemConfig(supabase);
  let userDataDir;
  try {
    const basePath = require('electron').app.getPath('userData');
    if (options && options.hubAccount) {
      const primarySession = path.join(basePath, `upm_session_${options.hubAccount.device_id}`);
      if (!fs.existsSync(primarySession)) {
        const legacySession = path.join(require('electron').app.getPath('appData'), 'ALS-Full', `upm_session_${options.hubAccount.device_id}`);
        userDataDir = fs.existsSync(legacySession) ? legacySession : primarySession;
      } else {
        userDataDir = primarySession;
      }
    } else {
      userDataDir = path.join(basePath, 'upm_session');
    }
  } catch (e) {
    userDataDir = path.join(require('os').homedir(), '.als_upm_session');
  }
  console.log('[PLAYWRIGHT] Opening standalone debug browser at:', userDataDir);
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'msedge',
    headless: false,
    viewport: { width: 1280, height: 720 },
    args: DEFAULT_BROWSER_ARGS,
    userAgent: DEFAULT_USER_AGENT
  });
  await applyStealthHardening(context);
  const page = await context.newPage();
  await page.goto(config.targetUrl);
  return true;
}

async function manualFetchProofSingleAttempt(supabase, options = {}) {
  const targetDeviceId = options && options.hubAccount ? options.hubAccount.device_id : (options && options.deviceId ? options.deviceId : cacheManager.getDeviceConfig().device_id);
  let context;
  try {
    const config = await getSystemConfig(supabase);

    console.log('[PLAYWRIGHT] Launching persistent browser for MANUAL PROOF SYNC...');
    let userDataDir;
    try {
      const basePath = require('electron').app.getPath('userData');
      if (options && options.hubAccount) {
        const primarySession = path.join(basePath, `upm_session_${options.hubAccount.device_id}`);
        if (!fs.existsSync(primarySession)) {
          const legacySession = path.join(require('electron').app.getPath('appData'), 'ALS-Full', `upm_session_${options.hubAccount.device_id}`);
          userDataDir = fs.existsSync(legacySession) ? legacySession : primarySession;
        } else {
          userDataDir = primarySession;
        }
      } else {
        userDataDir = path.join(basePath, 'upm_session');
      }
    } catch (e) {
      const basePath = require('os').homedir();
      userDataDir = (options && options.hubAccount) 
        ? path.join(basePath, `.als_upm_session_${options.hubAccount.device_id}`) 
        : path.join(basePath, '.als_upm_session');
    }
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'msedge',
      headless: !config.showBrowser,
      viewport: { width: 1280, height: 720 },
      args: DEFAULT_BROWSER_ARGS,
      userAgent: DEFAULT_USER_AGENT
    });

    await applyStealthHardening(context);

    const page = await context.newPage();
    await page.goto(config.targetUrl);

    const pageTitleManual = typeof page.title === 'function' ? await page.title().catch(() => '') : '';
    const titleLowerManual = pageTitleManual.toLowerCase();
    if (
      titleLowerManual.includes('blocked') ||
      titleLowerManual.includes('forbidden') ||
      titleLowerManual.includes('fortiguard') ||
      titleLowerManual.includes('fortiweb') ||
      titleLowerManual.includes('access denied')
    ) {
      throw new Error(`PORTAL_BLOCKED: Target portal access was blocked by security gateway (${pageTitleManual}).`);
    }

    const isLoginPage = page.url().toLowerCase().includes('login') || await page.isVisible('input[type="password"]');

    if (isLoginPage) {
      console.log('[PLAYWRIGHT] Login context detected. Injecting credentials...');
      let username, password;
      if (options && options.hubAccount) {
        username = options.hubAccount.upm_username;
        password = options.hubAccount.upm_password;
      } else {
        const deviceConfig = cacheManager.getDeviceConfig();
        username = deviceConfig.upm_username || process.env.UPM_USERNAME || '';
        password = deviceConfig.upm_password || process.env.UPM_PASSWORD || '';
      }
      await humanType(page, '#username', username ? username.trim() : '');
      await humanType(page, '#password', password ? password.trim() : '');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
        humanClick(page, page, 'button[type="submit"], input[type="submit"], #btn-login, .btn-login')
      ]);
    }

    console.log('[PLAYWRIGHT] Waiting 5 seconds for dashboard elements to fully render...');
    await page.waitForTimeout(5000);

    console.log('[PLAYWRIGHT] Scraping DOM for proof...');
    const proofData = await page.evaluate(() => {
      const docs = [document, ...Array.from(document.querySelectorAll('iframe')).map(f => f.contentDocument).filter(Boolean)];
      let twm = '--:--', wm = '--:--', wk = '--:--';
      for (const doc of docs) {
        if (doc.querySelector('#twm')) twm = doc.querySelector('#twm').innerText.trim();
        if (doc.querySelector('#wm')) wm = doc.querySelector('#wm').innerText.trim();
        if (doc.querySelector('#wk')) wk = doc.querySelector('#wk').innerText.trim();
      }
      return { date: twm, clockIn: wm, clockOut: wk };
    });

    console.log(`[PLAYWRIGHT] Manual Proof Extracted: ${JSON.stringify(proofData)}`);
    
    // Resolve authenticated Supabase client for this device
    let clientToUse = supabase;
    let hubAccount = options && options.hubAccount;
    if (!hubAccount && targetDeviceId) {
      const accounts = cacheManager.getHubAccounts();
      hubAccount = accounts.find(a => a.device_id === targetDeviceId);
    }
    if (hubAccount && hubAccount.supabase_email && hubAccount.supabase_password) {
      try {
        let needNewClient = !clientToUse || !clientToUse.auth;
        if (!needNewClient) {
          const { data: userData } = await clientToUse.auth.getUser();
          if (!userData?.user || userData.user.email !== hubAccount.supabase_email) {
            needNewClient = true;
          }
        }
        if (needNewClient) {
          const { createClient } = require('@supabase/supabase-js');
          const envVars = cacheManager.getDeviceConfig();
          if (envVars.supabase_url && envVars.supabase_key) {
            const authClient = createClient(envVars.supabase_url, envVars.supabase_key, {
              auth: { persistSession: false }
            });
            const { data: authData, error: signInErr } = await authClient.auth.signInWithPassword({
              email: hubAccount.supabase_email,
              password: hubAccount.supabase_password
            });
            if (!signInErr && authData?.user) {
              clientToUse = authClient;
            }
          }
        }
      } catch (authErr) {
        console.warn('[AUTOMATION] Self-auth check warning:', authErr.message);
      }
    }

    if (proofData.clockIn === '--:--' && proofData.clockOut === '--:--') {
       console.warn('[PLAYWRIGHT] Proof Extraction: Selectors #wm and #wk returned empty values.');
       if (clientToUse && typeof clientToUse.from === 'function') {
         await remoteLog(clientToUse, 'manual_proof_sync', 'failed', 'Proof Extraction Failed: Target portal did not render dashboard proof selectors (#twm, #wm, #wk).', targetDeviceId);
       }
    }
    
    const standardDate = new Date().toLocaleDateString('en-CA');
    
    try {
      if (clientToUse && typeof clientToUse.from === 'function') {
        let authUserId;
        if (clientToUse.auth) {
          const { data: userData } = await clientToUse.auth.getUser();
          if (userData && userData.user) authUserId = userData.user.id;
        }
        const proofPayload = {
          date: standardDate,
          clock_in: proofData.clockIn,
          clock_out: proofData.clockOut,
          device_id: targetDeviceId,
          updated_at: new Date().toISOString()
        };
        if (authUserId) proofPayload.user_id = authUserId;

        const { error } = await clientToUse.from('todays_proof').upsert(proofPayload, { onConflict: 'date, device_id' });
        if (error) {
          console.error('[PLAYWRIGHT] Supabase upsert error:', error.message || error);
          throw error;
        }
        cacheManager.updateCache('todays_proof', { date: standardDate, clock_in: proofData.clockIn, clock_out: proofData.clockOut, synced: true });
      } else {
        cacheManager.updateCache('todays_proof', { date: standardDate, clock_in: proofData.clockIn, clock_out: proofData.clockOut, synced: false });
      }
    } catch (err) {
      console.error('[PLAYWRIGHT] Supabase error during proof save:', err.message);
      cacheManager.queueOfflineProof({ date: standardDate, clock_in: proofData.clockIn, clock_out: proofData.clockOut });
    }

    try {
      if (clientToUse && typeof clientToUse.from === 'function') {
        let authUserId;
        if (clientToUse.auth) {
          const { data: userData } = await clientToUse.auth.getUser();
          if (userData && userData.user) authUserId = userData.user.id;
        }
        const cmdPayload = {
          device_id: targetDeviceId,
          action: 'manual_proof_sync',
          status: 'completed',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        if (authUserId) cmdPayload.user_id = authUserId;

        const { error: cmdErr } = await clientToUse.from('commands').insert(cmdPayload);
        if (cmdErr) {
          console.warn('[PLAYWRIGHT] Supabase commands insert error:', cmdErr.message || cmdErr);
        }
      }
    } catch (cmdErr) {
      console.warn('[PLAYWRIGHT] Could not record command history:', cmdErr.message);
    }

    if (global.updateTrayTooltip) global.updateTrayTooltip();

    if (clientToUse && typeof clientToUse.from === 'function') {
      await remoteLog(clientToUse, 'manual_proof_sync', 'success', `Proof fetched manually. Date: ${standardDate}, IN: ${proofData.clockIn}, OUT: ${proofData.clockOut}`, targetDeviceId);
    }
    
    await context.close();
    return {
      date: standardDate,
      clockIn: proofData.clockIn,
      clockOut: proofData.clockOut
    };

  } catch (error) {
    if (context) {
      try {
        await context.close();
      } catch (closeErr) {
        console.warn('[PLAYWRIGHT] Error closing context on proof sync failure:', closeErr.message);
      }
    }
    throw error;
  }
}

async function manualFetchProof(supabase, options = {}) {
  const maxAttempts = (options && options.maxAttempts) ? options.maxAttempts : 2;
  const targetDeviceId = options && options.hubAccount ? options.hubAccount.device_id : (options && options.deviceId ? options.deviceId : cacheManager.getDeviceConfig().device_id);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`[PLAYWRIGHT] Retrying manual proof sync (attempt ${attempt}/${maxAttempts})...`);
      }
      return await manualFetchProofSingleAttempt(supabase, options);
    } catch (error) {
      const isRetryable = isRetryableGatewayError(error);
      const hasRetriesLeft = attempt < maxAttempts;

      if (isRetryable && hasRetriesLeft) {
        const defaultDelay = (process.env.NODE_ENV === 'test')
          ? 10
          : (Math.floor(Math.random() * 15000) + 20000);
        const retryDelayMs = (options && typeof options.retryDelayMs === 'number')
          ? options.retryDelayMs
          : defaultDelay;

        console.warn(`[PLAYWRIGHT] Manual proof sync attempt ${attempt}/${maxAttempts} encountered transient gateway error (${error.message}). Retrying in ${(retryDelayMs / 1000).toFixed(1)}s...`);
        try {
          await remoteLog(supabase, 'manual_proof_sync', 'warning', `Proof fetch attempt ${attempt}/${maxAttempts} encountered gateway issue: ${error.message}. Retrying in ${(retryDelayMs / 1000).toFixed(1)}s...`, targetDeviceId);
        } catch (_) {}

        await new Promise(res => setTimeout(res, retryDelayMs));
        continue;
      }

      console.error(`[PLAYWRIGHT] Manual proof sync failed (attempt ${attempt}/${maxAttempts}): ${error.message}`);
      await remoteLog(supabase, 'manual_proof_sync', 'failed', `Failed to sync proof manually: ${error.message}`, targetDeviceId);
      throw error;
    }
  }
}

const VERSION = '1.6.12';

module.exports = {
  VERSION,
  executeClockAction,
  openDebugBrowser,
  manualFetchProof,
  testTelegramAlert,
  captureProofSnapshot,
  sendTelegramAlert,
  __test: {
    waitUntilTarget,
    applyStealthHardening,
    humanType,
    humanClick,
    isRetryableGatewayError,
    executeClockActionSingleAttempt,
    manualFetchProofSingleAttempt,
    captureProofSnapshot,
    sendTelegramAlert,
    testTelegramAlert
  }
};
