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
  const settingsPath = path.join(__dirname, 'local_settings.json');
  
  ipcMain.handle('read-settings', () => {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
    return { targetUrl: 'https://perakamwaktu.upm.edu.my/', showBrowser: false };
  });

  ipcMain.handle('save-settings', (event, settings) => {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return true;
  });

  ipcMain.handle('open-browser', async () => {
    const { openDebugBrowser } = require('./automation');
    try {
      await openDebugBrowser();
      return true;
    } catch (err) {
      console.error('Failed to open browser:', err);
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
