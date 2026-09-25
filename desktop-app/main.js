const path = require('path');
const fs = require('fs');
const envPath = fs.existsSync(path.join(__dirname, 'bundled.env')) ? path.join(__dirname, 'bundled.env') : path.join(__dirname, '.env');
require('dotenv').config({ path: envPath });
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');

// Isolate user data between Full, Lite, and Hub editions to prevent settings crossover
let edition = 'full';
if (process.env.ALS_EDITION) {
  edition = process.env.ALS_EDITION.toLowerCase();
} else {
  try {
    const pkg = require('./package.json');
    if (pkg && pkg.edition) {
      edition = pkg.edition.toLowerCase();
    }
  } catch(e) {}
}

const appDataPath = path.join(app.getPath('appData'), edition === 'lite' ? 'ALS-Lite' : (edition === 'hub' ? 'ALS-Hub' : 'ALS-Full'));
app.setPath('userData', appDataPath);
app.setAppUserModelId(edition === 'hub' ? 'com.als.dashboard.hub' : (edition === 'lite' ? 'com.als.dashboard.lite' : 'com.als.dashboard'));

// Enforce single instance per edition
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log(`[APP] Another instance of ALS (${edition}) is already running. Exiting...`);
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Initialize Modular Engine Loader & Updater
const moduleLoader = require('./module-loader');
moduleLoader.init({
  modulesDir: path.join(appDataPath, 'modules'),
  baseDir: __dirname
});
const moduleUpdater = moduleLoader.loadModule('module-updater', require('./module-updater'));
moduleUpdater.init();

// Load modules dynamically with fail-safe factory fallbacks
const cacheManager = moduleLoader.loadModule('cache-manager', require('./cache-manager'));
const supabaseModule = moduleLoader.loadModule('supabase-client', require('./supabase-client'));
const { initSupabase, supabase } = supabaseModule;
const scheduler = moduleLoader.loadModule('scheduler', require('./scheduler'));
const trayManager = moduleLoader.loadModule('tray-manager', require('./tray-manager'));

let mainWindow;
let tray;

global.connectivityState = 'Pending Connection';
global.updateTrayTooltip = function() {
  if (tray) {
    try {
      const cache = cacheManager.readCache();
      const accounts = edition === 'hub' ? cacheManager.getHubAccounts() : [];
      const tooltipText = trayManager.formatTrayTooltip({
        edition,
        connectivityState: global.connectivityState,
        cache,
        accounts
      });

      tray.setToolTip(tooltipText);
    } catch (err) {
      console.error('Failed to update tray tooltip:', err);
    }
  }

  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    try {
      mainWindow.webContents.send('engine-data-updated');
    } catch (e) {}
  }
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  const targetUI = edition === 'hub' ? 'hub-ui.html' : 'desktop-ui.html';
  const resolvedUIPath = moduleLoader.resolveUIPath(targetUI, path.join(__dirname, targetUI));
  mainWindow.loadFile(resolvedUIPath);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Intercept visual closure window event 'close'
  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide(); // Force hide to maintain background persistence
    }
    return false;
  });
}

app.whenReady().then(() => {
  ipcMain.handle('get-env-variables', () => {
    const config = cacheManager.getDeviceConfig();
    return {
      SUPABASE_URL: config.supabase_url,
      SUPABASE_PUBLISHABLE_KEY: config.supabase_key
    };
  });

  ipcMain.handle('get-app-version', () => {
    try {
      const dynamicManifestPath = path.join(moduleLoader.getModulesDir(), 'modules-manifest.json');
      if (fs.existsSync(dynamicManifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(dynamicManifestPath, 'utf8'));
        if (manifest.version) return manifest.version;
      }
      const bundledManifestPath = path.join(__dirname, 'modules-manifest.json');
      if (fs.existsSync(bundledManifestPath)) {
        const bundled = JSON.parse(fs.readFileSync(bundledManifestPath, 'utf8'));
        if (bundled.version) return bundled.version;
      }
    } catch (e) {}
    return app.getVersion();
  });

  ipcMain.handle('read-cache', () => {
    return cacheManager.readCache();
  });

  ipcMain.handle('read-settings', async () => {
    const local = cacheManager.getEngineConfig ? cacheManager.getEngineConfig() : {
      target_url: 'https://perakamwaktu.upm.edu.my/',
      show_browser: false
    };

    if (edition !== 'hub' && supabase && typeof supabase.from === 'function') {
      try {
        const { data, error } = await supabase.from('system_config').select('*').eq('id', 1).maybeSingle();
        if (!error && data && data.target_url && !local.target_url) {
          return {
            targetUrl: data.target_url,
            showBrowser: typeof data.show_browser === 'boolean' ? data.show_browser : local.show_browser
          };
        }
      } catch (e) {}
    }

    return {
      targetUrl: local.target_url || 'https://perakamwaktu.upm.edu.my/',
      showBrowser: local.show_browser || false
    };
  });

  ipcMain.handle('get-device-config', () => {
    return cacheManager.getDeviceConfig();
  });

  ipcMain.handle('save-device-config', (event, config) => {
    const updated = cacheManager.saveDeviceConfig(config);
    return updated;
  });

  ipcMain.handle('save-settings', async (event, settings) => {
    const targetUrl = settings.targetUrl || 'https://perakamwaktu.upm.edu.my/';
    const showBrowser = !!settings.showBrowser;

    // 1. Save locally first (authoritative local configuration)
    if (cacheManager.saveEngineConfig) {
      cacheManager.saveEngineConfig({ targetUrl, showBrowser });
    } else {
      cacheManager.saveDeviceConfig({ target_url: targetUrl, show_browser: showBrowser });
      cacheManager.mergeSystemConfig({ target_url: targetUrl, show_browser: showBrowser }, false);
    }

    // 2. Best-effort sync to Supabase system_config (if client initialized)
    if (supabase && typeof supabase.from === 'function') {
      try {
        const { error } = await supabase.from('system_config').upsert({
          id: 1,
          target_url: targetUrl,
          show_browser: showBrowser
        });
        if (error) {
          console.warn('[SUPABASE] Could not sync system_config to cloud (fail-closed RLS or permissions):', error.message);
        } else {
          cacheManager.mergeSystemConfig({ target_url: targetUrl, show_browser: showBrowser }, true);
        }
      } catch (cloudErr) {
        console.warn('[SUPABASE] Failed to upsert system_config:', cloudErr.message);
      }
    }

    return true;
  });

  ipcMain.handle('open-browser', async (event, deviceId) => {
    const automation = moduleLoader.loadModule('automation', require('./automation'));
    try {
      let options = {};
      if (deviceId) {
        const accounts = cacheManager.getHubAccounts();
        const account = accounts.find(a => a.device_id === deviceId);
        if (account) {
          options.hubAccount = account;
        }
      }
      await automation.openDebugBrowser(supabase, options);
      return true;
    } catch (err) {
      console.error('Failed to open browser:', err);
      throw err;
    }
  });

  ipcMain.handle('request-manual-proof', async (event, deviceId) => {
    const automation = moduleLoader.loadModule('automation', require('./automation'));
    try {
      let options = {};
      let targetClient = supabase;
      if (deviceId) {
        const accounts = cacheManager.getHubAccounts();
        const account = accounts.find(a => a.device_id === deviceId);
        if (account) {
          options.hubAccount = account;
        }
        if (edition === 'hub') {
          const hubClient = moduleLoader.loadModule('hub-client', require('./hub-client'));
          if (hubClient.getHubClientForDevice) {
            const client = await hubClient.getHubClientForDevice(deviceId);
            if (client) targetClient = client;
          }
        }
      }
      const res = await automation.manualFetchProof(targetClient, options);
      return { success: true, result: res };
    } catch (err) {
      console.error('Failed to fetch proof manually:', err);
      return { success: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('trigger-hub-action', async (event, deviceId, action) => {
    const automation = moduleLoader.loadModule('automation', require('./automation'));
    try {
      const accounts = cacheManager.getHubAccounts();
      const account = accounts.find(a => a.device_id === deviceId);
      if (!account) throw new Error(`Hub account ${deviceId} not found`);
      let targetClient = supabase;
      if (edition === 'hub') {
        const hubClient = moduleLoader.loadModule('hub-client', require('./hub-client'));
        if (hubClient.getHubClientForDevice) {
          const client = await hubClient.getHubClientForDevice(deviceId);
          if (client) targetClient = client;
        }
      }
      const res = await automation.executeClockAction(action, targetClient, {
        hubAccount: account,
        source: 'hub_manual'
      });
      return { success: true, result: res };
    } catch (err) {
      console.error(`Failed to trigger hub action ${action} for ${deviceId}:`, err);
      return { success: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('reload-ui', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const currentTargetUI = edition === 'hub' ? 'hub-ui.html' : 'desktop-ui.html';
      const latestUIPath = moduleLoader.resolveUIPath(currentTargetUI, path.join(__dirname, currentTargetUI));
      mainWindow.loadFile(latestUIPath);
      return true;
    }
    return false;
  });

  ipcMain.handle('get-hub-accounts', () => {
    return cacheManager.getHubAccounts();
  });
  
  ipcMain.handle('get-hub-account-status', async (event, deviceId) => {
    if (edition === 'hub') {
      const hubClient = moduleLoader.loadModule('hub-client', require('./hub-client'));
      return await hubClient.getHubAccountStatus(deviceId);
    }
    return null;
  });
  
  ipcMain.handle('save-hub-account', (event, account) => {
    const res = cacheManager.saveHubAccount(account);
    if (edition === 'hub') {
      try {
        const hubClient = moduleLoader.loadModule('hub-client', require('./hub-client'));
        if (typeof hubClient.initSingleAccount === 'function') {
          hubClient.initSingleAccount(account);
        } else {
          hubClient.initHubAccounts();
        }
      } catch (err) {
        console.error('[HUB] Error dynamically initializing account:', err.message);
      }
    }
    return res;
  });
  
  ipcMain.handle('remove-hub-account', (event, deviceId) => {
    const res = cacheManager.removeHubAccount(deviceId);
    if (edition === 'hub') {
      try {
        const hubClient = moduleLoader.loadModule('hub-client', require('./hub-client'));
        if (typeof hubClient.removeSingleAccount === 'function') {
          hubClient.removeSingleAccount(deviceId);
        } else {
          hubClient.initHubAccounts();
        }
      } catch (err) {
        console.error('[HUB] Error dynamically removing account:', err.message);
      }
    }
    return res;
  });

  // Modular Hot-Update IPC Handlers
  ipcMain.handle('check-module-updates', async () => {
    return await moduleUpdater.checkForUpdates();
  });

  ipcMain.handle('install-module-update', async (event, moduleName) => {
    const check = await moduleUpdater.checkForUpdates();
    if (!check.success || !check.availableUpdates) {
      return { success: false, error: check.error || 'No updates found.' };
    }
    const updateInfo = check.availableUpdates.find(u => u.name === moduleName);
    if (!updateInfo) {
      return { success: false, error: `Module "${moduleName}" is already up to date.` };
    }
    return await moduleUpdater.installModuleUpdate(moduleName, updateInfo);
  });

  ipcMain.handle('install-all-module-updates', async () => {
    const check = await moduleUpdater.checkForUpdates();
    if (!check.success || !check.availableUpdates || check.availableUpdates.length === 0) {
      return { success: false, error: check.error || 'No updates available.' };
    }
    return await moduleUpdater.installAllUpdates(check.availableUpdates);
  });

  ipcMain.handle('get-module-versions', () => {
    return moduleLoader.getLoadedModuleInfo();
  });

  ipcMain.handle('relaunch-app', () => {
    return moduleUpdater.relaunchApp();
  });

  // Native OS Auto-Launch on boot
  app.setLoginItemSettings({
    openAtLogin: true,
    path: app.getPath('exe')
  });

  createWindow();

  // Initialize Supabase handshake, heartbeat, and listeners
  if (edition === 'hub') {
    const hubClient = moduleLoader.loadModule('hub-client', require('./hub-client'));
    hubClient.initHubAccounts();
  } else {
    initSupabase();
    scheduler.init(supabase);
  }

  // Setup System Tray with modular manager
  const iconFileName = edition === 'hub' ? 'tray-hub.png' : 'tray.png';
  const iconPath = path.join(__dirname, 'assets', iconFileName);
  const defaultIconPath = path.join(__dirname, 'assets', 'tray.png');
  const fallbackIcon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAcSURBVDhPYzzP+P8/AwXAhFE1aNqgaYOmDcIEwAAXyA8d9Zt0XAAAAABJRU5ErkJggg==');
  const trayIcon = fs.existsSync(iconPath) 
    ? nativeImage.createFromPath(iconPath) 
    : (fs.existsSync(defaultIconPath) ? nativeImage.createFromPath(defaultIconPath) : fallbackIcon);
  
  tray = new Tray(trayIcon);
  const contextMenu = trayManager.buildContextMenu({
    Menu,
    mainWindow,
    app,
    onCheckUpdates: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('trigger-update-check');
      }
    }
  });
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
      if (mainWindow.webContents) {
        try { mainWindow.webContents.send('engine-data-updated'); } catch (e) {}
      }
    }
  });
  tray.on('double-click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      if (mainWindow.webContents) {
        try { mainWindow.webContents.send('engine-data-updated'); } catch (e) {}
      }
    }
  });
  global.updateTrayTooltip();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('before-quit', () => {
    app.isQuiting = true;
    if (tray) {
      try { tray.destroy(); } catch (e) {}
    }
  });
});
