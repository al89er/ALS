require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');

async function executeClockAction(actionType, supabase) {
  let context;
  try {
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
      throw new Error('CAPTIVE_PORTAL');
    }

    // 2. Browser Launch with Persistent State
    console.log('[PLAYWRIGHT] Launching persistent hidden browser context...');
    const userDataDir = path.join(__dirname, 'upm_session');
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true, // Hidden Chromium instance
      viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();

    // 3. Portal Navigation
    console.log('[PLAYWRIGHT] Navigating to target portal...');
    await page.goto('https://perakamwaktu.upm.edu.my/');

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

    if (context) {
      await context.close();
    }
    throw error;
  }
}

module.exports = {
  executeClockAction
};
