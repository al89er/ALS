const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    readSettings: () => ipcRenderer.invoke('read-settings'),
    readCache: () => ipcRenderer.invoke('read-cache'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    getDeviceConfig: () => ipcRenderer.invoke('get-device-config'),
    saveDeviceConfig: (config) => ipcRenderer.invoke('save-device-config', config),
    openBrowser: () => ipcRenderer.invoke('open-browser'),
    requestManualProof: () => ipcRenderer.invoke('request-manual-proof'),
    getEnvVariables: () => ipcRenderer.invoke('get-env-variables'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version')
});
