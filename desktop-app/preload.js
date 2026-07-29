const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    readSettings: () => ipcRenderer.invoke('read-settings'),
    readCache: () => ipcRenderer.invoke('read-cache'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    getDeviceConfig: () => ipcRenderer.invoke('get-device-config'),
    saveDeviceConfig: (config) => ipcRenderer.invoke('save-device-config', config),
    openBrowser: () => ipcRenderer.invoke('open-browser'),
  getHubAccounts: () => ipcRenderer.invoke('get-hub-accounts'),
  getHubAccountStatus: (deviceId) => ipcRenderer.invoke('get-hub-account-status', deviceId),
  saveHubAccount: (account) => ipcRenderer.invoke('save-hub-account', account),
  removeHubAccount: (deviceId) => ipcRenderer.invoke('remove-hub-account', deviceId),
    requestManualProof: () => ipcRenderer.invoke('request-manual-proof'),
    getEnvVariables: () => ipcRenderer.invoke('get-env-variables'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version')
});
