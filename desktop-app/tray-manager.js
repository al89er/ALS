// Tray Manager - Modular Tray Tooltip & Menu Formatter
// Version: 1.5.8

const VERSION = '1.5.8';

/**
 * Formats the tray tooltip string according to the active edition and current state.
 * @param {Object} params
 * @param {string} params.edition - 'hub', 'lite', or 'full'
 * @param {string} params.connectivityState - Realtime / Supabase connection status string
 * @param {Object} params.cache - Cache data containing daily_schedule and todays_proof
 * @param {Array} [params.accounts] - List of managed accounts (for Hub edition)
 * @returns {string} Formatted tooltip text
 */
function formatTrayTooltip({ edition = 'full', connectivityState = 'Pending Connection', cache = {}, accounts = [] }) {
  try {
    const todayStr = new Date().toLocaleDateString('en-CA');
    
    let inTarget = 'Pending Generation';
    let outTarget = 'Pending Generation';
    let isSkipped = false;
    
    if (cache.daily_schedule && cache.daily_schedule.date === todayStr) {
      inTarget = cache.daily_schedule.scheduled_clock_in || 'Pending Generation';
      outTarget = cache.daily_schedule.scheduled_clock_out || 'Pending Generation';
      isSkipped = !!cache.daily_schedule.skipped;
    }
    
    let inProof = '--:--';
    let outProof = '--:--';
    if (cache.todays_proof && cache.todays_proof.date === todayStr) {
      inProof = cache.todays_proof.clock_in || '--:--';
      outProof = cache.todays_proof.clock_out || '--:--';
    }

    const skipText = isSkipped ? ' (Skipped)' : '';

    if (edition === 'hub') {
      const activeCount = Array.isArray(accounts) ? accounts.length : 0;
      return `[HUB v${VERSION}] Active Accounts: ${activeCount}\nStatus: ${connectivityState}`;
    } else if (edition === 'lite') {
      return `[LITE v${VERSION}] Connectivity: ${connectivityState}\nProof In: ${inProof} | Out: ${outProof}`;
    } else {
      return `[ALS v${VERSION}] Connectivity: ${connectivityState}\nTarget In: ${inTarget}${skipText} | Out: ${outTarget}${skipText}\nProof In: ${inProof} | Out: ${outProof}`;
    }
  } catch (err) {
    return `ALS Automation Engine v${VERSION}`;
  }
}

/**
 * Builds the Electron context menu for the system tray.
 * @param {Object} params
 * @param {Object} params.Menu - Electron Menu class
 * @param {Object} params.mainWindow - Main BrowserWindow instance
 * @param {Object} params.app - Electron app instance
 * @param {Function} [params.onCheckUpdates] - Callback to check for updates
 * @returns {Object} Built Menu instance
 */
function buildContextMenu({ Menu, mainWindow, app, onCheckUpdates }) {
  const menuTemplate = [
    {
      label: 'Show App',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' }
  ];

  if (typeof onCheckUpdates === 'function') {
    menuTemplate.push({
      label: 'Check for Module Updates',
      click: () => onCheckUpdates()
    });
    menuTemplate.push({ type: 'separator' });
  }

  menuTemplate.push({
    label: 'Quit',
    click: () => {
      if (app) {
        app.isQuiting = true;
        app.quit();
      }
    }
  });

  return Menu.buildFromTemplate(menuTemplate);
}

module.exports = {
  VERSION,
  formatTrayTooltip,
  buildContextMenu
};
