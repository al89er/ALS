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

    // 5. Element Execution
    console.log(`[PLAYWRIGHT] Executing element trigger for action: ${actionType}`);
    const selector = actionType === 'clock_in' ? '#a50' : '#a51';

    // Wait for the button to be ready and click it
    await page.waitForSelector(selector, { state: 'visible', timeout: 15000 });
    await page.click(selector);

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
