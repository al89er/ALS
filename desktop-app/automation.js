require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[TELEGRAM] Token or Chat ID missing. Skipping alert.');
    return;
  }
  
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message
      })
    });
    if (!response.ok) {
      console.error('[TELEGRAM] Failed to send message:', await response.text());
    }
  } catch (err) {
    console.error('[TELEGRAM] Error sending alert:', err.message);
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
    
    if (targetVal && targetVal !== '?' && targetVal.length > 2) {
      console.log(`[PLAYWRIGHT] Pre-Flight Check: Action already completed! Extracted: ${targetVal}`);
      await supabase.from('config').upsert({
        key: 'todays_proof',
        value: {
          date: proofData.date,
          clockIn: proofData.clockIn,
          clockOut: proofData.clockOut,
          lastUpdated: new Date().toISOString()
        }
      });
      return true;
    }
    console.log('[PLAYWRIGHT] Pre-Flight Check: Action not yet completed.');
    return false;
  } catch (err) {
    console.error('[PLAYWRIGHT] Error in checkDashboardStatus:', err);
    return false;
  }
}

async function executeClockAction(actionType, supabase) {
  let context;
  try {
    const settingsPath = path.join(__dirname, 'local_settings.json');
    let settings = { targetUrl: 'https://perakamwaktu3.upm.edu.my/', showBrowser: false };
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }

    // 1. Network / Captive Portal Check
    console.log('[PLAYWRIGHT] Checking network route via neverssl.com...');
    const fetchResponse = await fetch('http://neverssl.com');
    const fetchText = await fetchResponse.text();

    if (!fetchText.includes('<html')) {
      console.warn('[PLAYWRIGHT] Captive Portal detected! Aborting sequence.');
      await supabase.from('logs').insert({
        action: 'network_check',
        status: 'error',
        message: 'Captive portal intercepted the connection.'
      });
      await supabase.from('device_status').upsert({
        id: 'home_desktop_agent',
        current_status: 'CAPTIVE_PORTAL',
        last_seen: new Date().toISOString()
      });
      await sendTelegramAlert(`🚨 [ALS Desktop] CAPTIVE PORTAL DETECTED! Cannot execute ${actionType.toUpperCase()}.`);
      throw new Error('CAPTIVE_PORTAL');
    }

    // 2. Browser Launch with Persistent State
    console.log('[PLAYWRIGHT] Launching persistent browser context (headless: ' + !settings.showBrowser + ')...');
    const userDataDir = path.join(__dirname, 'upm_session');
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: !settings.showBrowser,
      viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();

    // 3. Portal Navigation
    console.log('[PLAYWRIGHT] Navigating to target portal: ' + settings.targetUrl);
    await page.goto(settings.targetUrl);

    // 4. Auth Check & Injection
    // If the URL contains 'login' or we can see a specific login field
    const isLoginPage = page.url().toLowerCase().includes('login') ||
      await page.isVisible('input[type="password"]');

    if (isLoginPage) {
      console.log('[PLAYWRIGHT] Login context detected. Injecting credentials...');
      // Adjust these selectors depending on the exact DOM of the UPM portal
      await page.fill('input[type="text"]', process.env.UPM_USERNAME);
      await page.fill('input[type="password"]', process.env.UPM_PASSWORD);
      await page.click('button[type="submit"], input[type="submit"]');
      await page.waitForNavigation();
    }

    // 4.5 Pre-Flight Check
    console.log('[PLAYWRIGHT] Running Pre-Flight Dashboard Verification...');
    const isAlreadyDone = await checkDashboardStatus(page, actionType, supabase);
    if (isAlreadyDone) {
      console.log(`[PLAYWRIGHT] Manual action detected, skipping automated click for ${actionType}`);
      await supabase.from('logs').insert({
        action: actionType,
        status: 'skipped',
        message: `Manual action detected. Skipping automated click. Scraped proof.`
      });
      await sendTelegramAlert(`✅ [ALS Desktop] Pre-Flight Check: ${actionType.toUpperCase()} already completed! Skipping automated action.`);
      await context.close();
      return true;
    }
    
    console.log('[PLAYWRIGHT] Pre-Flight cleared. Waiting 60 seconds to hit exact target time...');
    await page.waitForTimeout(60000);

    // 5. Smart Iframe & Menu Expansion
    console.log(`[PLAYWRIGHT] Executing smart element trigger for action: ${actionType}`);
    const selector = actionType === 'clock_in' ? '#a50' : '#a51';

    let targetFrame = page;
    let targetHandle = null;

    // Search across all frames
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

    // Menu Expansion Logic
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
        if (anchor) {
          anchor.click();
        }
      }
    }, selector);

    // Wait 1s for any UI animation/expansion to complete
    await new Promise(r => setTimeout(r, 1000));

    // Wait for the button to be visibly clickable and click it
    await targetFrame.waitForSelector(selector, { state: 'visible', timeout: 15000 });
    await targetFrame.click(selector);

    // 6. Logging Success
    console.log('[PLAYWRIGHT] Element triggered successfully.');
    await supabase.from('logs').insert({
      action: actionType,
      status: 'success',
      message: `Successfully clicked ${selector} at ${new Date().toISOString()}`
    });

    await sendTelegramAlert(`✅ [ALS Desktop] Successfully executed ${actionType.toUpperCase()} at ${new Date().toLocaleTimeString()}`);

    // 7. Cleanup
    await context.close();
    return true;

  } catch (error) {
    console.error(`[PLAYWRIGHT] Execution failed: ${error.message}`);

    // Log Failure
    await supabase.from('logs').insert({
      action: actionType,
      status: 'failed',
      message: `Error during execution: ${error.message}`
    });

    if (error.message !== 'CAPTIVE_PORTAL') {
      await sendTelegramAlert(`❌ [ALS Desktop] Execution FAILED for ${actionType.toUpperCase()}: ${error.message}`);
    }

    if (context) {
      await context.close();
    }
    throw error;
  }
}

async function openDebugBrowser() {
  const settingsPath = path.join(__dirname, 'local_settings.json');
  let settings = { targetUrl: 'https://perakamwaktu3.upm.edu.my/', showBrowser: false };
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }
  const userDataDir = path.join(__dirname, 'upm_session');
  console.log('[PLAYWRIGHT] Opening standalone debug browser...');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 720 }
  });
  const page = await context.newPage();
  await page.goto(settings.targetUrl);
  return true;
}

module.exports = { executeClockAction, openDebugBrowser };
