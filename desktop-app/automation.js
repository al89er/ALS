require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const cacheManager = require('./cache-manager');

async function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[TELEGRAM] Token or Chat ID missing. Skipping alert.');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message })
    });
  } catch (err) {
    console.error('[TELEGRAM] Error sending alert:', err.message);
  }
}

async function remoteLog(supabase, action, status, message) {
  try {
    const { error } = await supabase.from('logs').insert({ action, status, message });
    if (error) {
        console.error('[SUPABASE LOG ERROR]', error.message);
    }
  } catch (err) {
    cacheManager.logOffline(action, status, message);
  }
}

async function checkDashboardStatus(page, actionType, supabase) {
  try {
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

    const targetVal = actionType === 'clock_in' ? proofData.clockIn : proofData.clockOut;
    const standardDate = new Date().toISOString().split('T')[0];
    
    if (targetVal && targetVal !== '?' && targetVal.length > 2) {
      console.log(`[PLAYWRIGHT] Pre-Flight Check: Action already completed! Extracted: ${targetVal}`);
      
      try {
        await supabase.from('todays_proof').upsert({
          date: standardDate,
          clock_in: proofData.clockIn,
          clock_out: proofData.clockOut,
          updated_at: new Date().toISOString()
        }, { onConflict: 'date' });
        cacheManager.updateCache('todays_proof', { date: standardDate, clock_in: proofData.clockIn, clock_out: proofData.clockOut, synced: true });
      } catch (err) {
        console.error('[PLAYWRIGHT] Supabase offline! Queueing manual proof to local cache.');
        cacheManager.queueOfflineProof({ date: standardDate, clock_in: proofData.clockIn, clock_out: proofData.clockOut });
      }

      await remoteLog(supabase, actionType, 'skipped', 'Manual entry verified');

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
  try {
    const { data, error } = await supabase.from('system_config').select('*').eq('id', 1).maybeSingle();
    if (error) throw error;
    
    const targetUrl = data?.target_url || 'https://perakamwaktu3.upm.edu.my/';
    const showBrowser = data?.show_browser || false;
    
    cacheManager.mergeSystemConfig({ target_url: targetUrl, show_browser: showBrowser }, true);
    
    return { targetUrl, showBrowser };
  } catch (err) {
    console.warn('[PLAYWRIGHT] Supabase offline! Fetching config from local cache.');
    const cache = cacheManager.readCache();
    return {
      targetUrl: cache.system_config.target_url || 'https://perakamwaktu3.upm.edu.my/',
      showBrowser: cache.system_config.show_browser || false
    };
  }
}

async function executeClockAction(actionType, supabase) {
  let context;
  try {
    const config = await getSystemConfig(supabase);

    // 1. Network / Captive Portal Check
    console.log('[PLAYWRIGHT] Checking network route via neverssl.com...');
    const fetchResponse = await fetch('http://neverssl.com');
    const fetchText = await fetchResponse.text();

    if (!fetchText.includes('<html')) {
      console.warn('[PLAYWRIGHT] Captive Portal detected! Aborting sequence.');
      await remoteLog(supabase, 'network_check', 'error', 'Captive portal intercepted the connection.');
      try {
        await supabase.from('device_status').upsert({
          id: 'home_desktop_agent',
          current_status: 'CAPTIVE_PORTAL',
          last_seen: new Date().toISOString()
        });
      } catch (e) {}
      await sendTelegramAlert(`🚨 [ALS Desktop] CAPTIVE PORTAL DETECTED! Cannot execute ${actionType.toUpperCase()}.`);
      throw new Error('CAPTIVE_PORTAL');
    }

    // 2. Browser Launch
    console.log('[PLAYWRIGHT] Launching persistent browser context (headless: ' + !config.showBrowser + ')...');
    let userDataDir;
    try {
      userDataDir = path.join(require('electron').app.getPath('userData'), 'upm_session');
    } catch (e) {
      userDataDir = path.join(require('os').homedir(), '.als_upm_session');
    }
    context = await chromium.launchPersistentContext(userDataDir, {
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
      await page.fill('input[type="text"]', process.env.UPM_USERNAME);
      await page.fill('input[type="password"]', process.env.UPM_PASSWORD);
      await page.click('button[type="submit"], input[type="submit"]');
      await page.waitForNavigation();
    }

    // 4.5 Pre-Flight
    console.log('[PLAYWRIGHT] Running Pre-Flight Dashboard Verification...');
    const isAlreadyDone = await checkDashboardStatus(page, actionType, supabase);
    if (isAlreadyDone) {
      console.log(`[PLAYWRIGHT] Manual action detected, skipping automated click for ${actionType}`);
      await sendTelegramAlert(`✅ [ALS Desktop] Pre-Flight Check: ${actionType.toUpperCase()} already completed! Skipping automated action.`);
      await context.close();
      return true;
    }
    
    console.log('[PLAYWRIGHT] Pre-Flight cleared. Waiting 60 seconds to hit exact target time...');
    await page.waitForTimeout(60000);

    // 5. Trigger
    console.log(`[PLAYWRIGHT] Executing smart element trigger for action: ${actionType}`);
    const selector = actionType === 'clock_in' ? '#a50' : '#a51';

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
    await targetFrame.click(selector);

    // 6. Post-Flight
    console.log('[PLAYWRIGHT] Element triggered successfully. Verifying DOM for proof...');
    await page.waitForTimeout(2000);
    
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

    const standardDate = new Date().toISOString().split('T')[0];

    try {
      await supabase.from('todays_proof').upsert({
        date: standardDate,
        clock_in: postProofData.clockIn,
        clock_out: postProofData.clockOut,
        updated_at: new Date().toISOString()
      }, { onConflict: 'date' });
      cacheManager.updateCache('todays_proof', { date: standardDate, clock_in: postProofData.clockIn, clock_out: postProofData.clockOut, synced: true });
    } catch (err) {
      console.error('[PLAYWRIGHT] Supabase offline! Queueing automated proof to local cache.');
      cacheManager.queueOfflineProof({ date: standardDate, clock_in: postProofData.clockIn, clock_out: postProofData.clockOut });
    }

    await remoteLog(supabase, actionType, 'success', `Successfully clicked ${selector} at ${new Date().toISOString()}`);
    await sendTelegramAlert(`✅ [ALS Desktop] Successfully executed ${actionType.toUpperCase()} at ${new Date().toLocaleTimeString()}`);

    await context.close();
    return true;

  } catch (error) {
    console.error(`[PLAYWRIGHT] Execution failed: ${error.message}`);
    await remoteLog(supabase, actionType, 'failed', `Error during execution: ${error.message}`);

    if (error.message !== 'CAPTIVE_PORTAL') {
      await sendTelegramAlert(`❌ [ALS Desktop] Execution FAILED for ${actionType.toUpperCase()}: ${error.message}`);
    }

    if (context) await context.close();
    throw error;
  }
}

async function openDebugBrowser(supabase) {
  const config = await getSystemConfig(supabase);
  let userDataDir;
  try {
    userDataDir = path.join(require('electron').app.getPath('userData'), 'upm_session');
  } catch (e) {
    userDataDir = path.join(require('os').homedir(), '.als_upm_session');
  }
  console.log('[PLAYWRIGHT] Opening standalone debug browser...');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 720 }
  });
  const page = await context.newPage();
  await page.goto(config.targetUrl);
  return true;
}

async function manualFetchProof(supabase) {
  let context;
  try {
    const config = await getSystemConfig(supabase);

    console.log('[PLAYWRIGHT] Launching persistent browser for MANUAL PROOF SYNC...');
    let userDataDir;
    try {
      userDataDir = path.join(require('electron').app.getPath('userData'), 'upm_session');
    } catch (e) {
      userDataDir = path.join(require('os').homedir(), '.als_upm_session');
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
      await page.fill('input[type="text"]', process.env.UPM_USERNAME);
      await page.fill('input[type="password"]', process.env.UPM_PASSWORD);
      await page.click('button[type="submit"], input[type="submit"]');
      await page.waitForNavigation();
    }

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
    
    const standardDate = new Date().toISOString().split('T')[0];
    
    try {
      await supabase.from('todays_proof').upsert({
        date: standardDate,
        clock_in: proofData.clockIn,
        clock_out: proofData.clockOut,
        updated_at: new Date().toISOString()
      }, { onConflict: 'date' });
      cacheManager.updateCache('todays_proof', { date: standardDate, clock_in: proofData.clockIn, clock_out: proofData.clockOut, synced: true });
    } catch (err) {
      console.error('[PLAYWRIGHT] Supabase offline! Queueing manual proof to local cache.');
      cacheManager.queueOfflineProof({ date: standardDate, clock_in: proofData.clockIn, clock_out: proofData.clockOut });
    }

    await remoteLog(supabase, 'manual_proof_sync', 'success', `Proof fetched manually. Date: ${standardDate}, IN: ${proofData.clockIn}, OUT: ${proofData.clockOut}`);
    
    await context.close();
    return true;

  } catch (error) {
    console.error(`[PLAYWRIGHT] Manual proof sync failed: ${error.message}`);
    await remoteLog(supabase, 'manual_proof_sync', 'failed', `Failed to sync proof manually: ${error.message}`);
    if (context) await context.close();
    throw error;
  }
}

module.exports = { executeClockAction, openDebugBrowser, manualFetchProof };
