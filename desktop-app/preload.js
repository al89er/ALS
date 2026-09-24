const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    readSettings: () => ipcRenderer.invoke('read-settings'),
    readCache: () => ipcRenderer.invoke('read-cache'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    getDeviceConfig: () => ipcRenderer.invoke('get-device-config'),
    saveDeviceConfig: (config) => ipcRenderer.invoke('save-device-config', config),
    openBrowser: (deviceId) => ipcRenderer.invoke('open-browser', deviceId),
    getHubAccounts: () => ipcRenderer.invoke('get-hub-accounts'),
    getHubAccountStatus: (deviceId) => ipcRenderer.invoke('get-hub-account-status', deviceId),
    saveHubAccount: (account) => ipcRenderer.invoke('save-hub-account', account),
    removeHubAccount: (deviceId) => ipcRenderer.invoke('remove-hub-account', deviceId),
    requestManualProof: (deviceId) => ipcRenderer.invoke('request-manual-proof', deviceId),
    triggerHubAction: (deviceId, action) => ipcRenderer.invoke('trigger-hub-action', deviceId, action),
    getEnvVariables: () => ipcRenderer.invoke('get-env-variables'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),

    // Modular Hot-Update APIs
    checkModuleUpdates: () => ipcRenderer.invoke('check-module-updates'),
    installModuleUpdate: (moduleName) => ipcRenderer.invoke('install-module-update', moduleName),
    installAllModuleUpdates: () => ipcRenderer.invoke('install-all-module-updates'),
    getModuleVersions: () => ipcRenderer.invoke('get-module-versions'),
    relaunchApp: () => ipcRenderer.invoke('relaunch-app'),
    reloadUI: () => ipcRenderer.invoke('reload-ui'),
    onTriggerUpdateCheck: (callback) => {
        ipcRenderer.on('trigger-update-check', () => callback());
    },
    onEngineUpdate: (callback) => {
        ipcRenderer.on('engine-data-updated', () => callback());
    }
});
