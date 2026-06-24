require('dotenv').config();
const { app, BrowserWindow, Tray, Menu } = require('electron');
const path = require('path');
const { initSupabase } = require('./supabase-client');

let mainWindow;
let tray;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false, // Start completely minimized/hidden
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
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
  // Native OS Auto-Launch on boot
  app.setLoginItemSettings({
    openAtLogin: true,
    path: app.getPath('exe')
  });

  createWindow();

  // Initialize Supabase handshake, heartbeat, and listeners
  initSupabase();

  // Setup System Tray
  const fs = require('fs');
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
