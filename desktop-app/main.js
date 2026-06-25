require('dotenv').config();
const { app, BrowserWindow, Tray, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { initSupabase, supabase } = require('./supabase-client');
const scheduler = require('./scheduler');

let mainWindow;
let tray;

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

  mainWindow.loadFile('desktop-ui.html');

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
    return { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
  });

  ipcMain.handle('read-settings', async () => {
    const { data } = await supabase.from('system_config').select('*').eq('id', 1).maybeSingle();
    return {
      targetUrl: data?.target_url || 'https://perakamwaktu.upm.edu.my/',
      showBrowser: data?.show_browser || false
    };
  });

  ipcMain.handle('save-settings', async (event, settings) => {
    await supabase.from('system_config').upsert({
      id: 1,
      target_url: settings.targetUrl,
      show_browser: settings.showBrowser
    });
    return true;
  });

  ipcMain.handle('open-browser', async () => {
    const { openDebugBrowser } = require('./automation');
    try {
      await openDebugBrowser(supabase);
      return true;
    } catch (err) {
      console.error('Failed to open browser:', err);
      throw err;
    }
  });

  ipcMain.handle('request-manual-proof', async () => {
    const { manualFetchProof } = require('./automation');
    try {
      await manualFetchProof(supabase);
      return true;
    } catch (err) {
      console.error('Failed to fetch proof manually:', err);
      throw err;
    }
  });

  // Native OS Auto-Launch on boot
  app.setLoginItemSettings({
    openAtLogin: true,
    path: app.getPath('exe')
  });

  createWindow();

  // Initialize Supabase handshake, heartbeat, and listeners
  initSupabase();
  scheduler.init(supabase);

  // Setup System Tray
  const { nativeImage } = require('electron');
  const iconPath = path.join(__dirname, 'icon.png');
  // Simple 16x16 red square fallback
  const fallbackIcon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAcSURBVDhPYzzP+P8/AwXAhFE1aNqgaYOmDcIEwAAXyA8d9Zt0XAAAAABJRU5ErkJggg==');
  const trayIcon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : fallbackIcon;
  
  tray = new Tray(trayIcon);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => mainWindow.show() },
    { label: 'Quit', click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);
  tray.setToolTip('ALS Automation Engine');
  tray.setContextMenu(contextMenu);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
