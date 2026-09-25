if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config();
}
const { chromium } = require('playwright');
const path = require('path');
const cacheManager = require('./cache-manager');

async function sendTelegramAlert(message, deviceId = 'home_desktop_agent') {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[TELEGRAM] Token or Chat ID missing. Skipping alert.');
    return;
  }
  const formattedMessage = message.replace('[ALS Desktop]', `[ALS Desktop: ${deviceId}]`);
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

async function executeClockAction(actionType, supabase, options = {}) {
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
      viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();

    // 3. Portal Navigation
    console.log('[PLAYWRIGHT] Navigating to target portal: ' + config.targetUrl);
    await page.goto(config.targetUrl);

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

      await page.fill('#username', username ? username.trim() : '');
      await page.fill('#password', password ? password.trim() : '');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
        page.click('button[type="submit"], input[type="submit"], #btn-login, .btn-login')
      ]);
    }

    // 4.5 Pre-Flight
    console.log('[PLAYWRIGHT] Waiting 5 seconds for dashboard elements to fully render...');
    await page.waitForTimeout(5000);

    console.log('[PLAYWRIGHT] Running Pre-Flight Dashboard Verification...');
    let isAlreadyDone = await checkDashboardStatus(page, actionType, supabase, targetDeviceId);
    if (isAlreadyDone) {
      console.log(`[PLAYWRIGHT] Manual action detected, skipping automated click for ${actionType}`);
      await sendTelegramAlert(`✅ [ALS Desktop] Pre-Flight Check: ${actionType.toUpperCase()} already completed! Skipping automated action.`, targetDeviceId);
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
        await sendTelegramAlert(`✅ [ALS Desktop] Final Pre-Flight Check: ${actionType.toUpperCase()} already completed! Skipping automated action.`, targetDeviceId);
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

    await targetFrame.click(selector);

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

        const { error } = await clientToUse.from('todays_proof').upsert(proofPayload, { onConflict: 'date, device_id' });
        if (error) throw error;
        cacheManager.updateCache('todays_proof', { date: standardDate, clock_in: postProofData.clockIn, clock_out: postProofData.clockOut, synced: true });
      } else {
        cacheManager.updateCache('todays_proof', { date: standardDate, clock_in: postProofData.clockIn, clock_out: postProofData.clockOut, synced: false });
      }
    } catch (err) {
      console.error('[PLAYWRIGHT] Supabase offline! Queueing automated proof to local cache.');
      cacheManager.queueOfflineProof({ date: standardDate, clock_in: postProofData.clockIn, clock_out: postProofData.clockOut });
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
    await sendTelegramAlert(`✅ [ALS Desktop] Successfully executed ${actionType.toUpperCase()} at ${new Date().toLocaleTimeString()}`, targetDeviceId);

    await context.close();
    return true;

  } catch (error) {
    console.error(`[PLAYWRIGHT] Execution failed: ${error.message}`);
    await remoteLog(supabase, actionType, 'failed', `Error during execution: ${error.message}`, targetDeviceId);

    if (error.message !== 'CAPTIVE_PORTAL') {
      await sendTelegramAlert(`❌ [ALS Desktop] Execution FAILED for ${actionType.toUpperCase()}: ${error.message}`, targetDeviceId);
    }

    if (context) await context.close();
    throw error;
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
    viewport: { width: 1280, height: 720 }
  });
  const page = await context.newPage();
  await page.goto(config.targetUrl);
  return true;
}

async function manualFetchProof(supabase, options = {}) {
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
      headless: !config.showBrowser,
      viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();
    await page.goto(config.targetUrl);

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
      await page.fill('#username', username ? username.trim() : '');
      await page.fill('#password', password ? password.trim() : '');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
        page.click('button[type="submit"], input[type="submit"], #btn-login, .btn-login')
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
       let debugDump = '';
       for (const frame of page.frames()) {
          try {
              debugDump += await frame.content() + '\n\n';
          } catch(e) {}
       }
       if (clientToUse && typeof clientToUse.from === 'function') {
         await remoteLog(clientToUse, 'manual_proof_sync', 'failed', `Proof Extraction Failed! Dump: ${debugDump.substring(0, 5000)}`, targetDeviceId);
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
    console.error(`[PLAYWRIGHT] Manual proof sync failed: ${error.message}`);
    await remoteLog(supabase, 'manual_proof_sync', 'failed', `Failed to sync proof manually: ${error.message}`, options && options.hubAccount ? options.hubAccount.device_id : null);
    if (context) await context.close();
    throw error;
  }
}

const VERSION = '1.6.4';

module.exports = {
  VERSION,
  executeClockAction,
  openDebugBrowser,
  manualFetchProof,
  __test: {
    waitUntilTarget
  }
};
