const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    readSettings: () => ipcRenderer.invoke('read-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    openBrowser: () => ipcRenderer.invoke('open-browser')
});
