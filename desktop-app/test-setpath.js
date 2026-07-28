const { app } = require('electron');
const path = require('path');
const fs = require('fs');

app.on('ready', () => {
    try {
        const appDataPath = path.join(app.getPath('appData'), 'ALS-Test-Dir');
        app.setPath('userData', appDataPath);
        console.log('UserData Path:', app.getPath('userData'));
    } catch (err) {
        console.error('Error setting path:', err);
    }
    app.quit();
});
