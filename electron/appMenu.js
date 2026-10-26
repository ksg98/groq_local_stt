// Application menu: Electron's default menus, plus "Check for Updates…" in the
// app menu on macOS (Help menu elsewhere).

const { Menu } = require('electron');

// app.name is the package id ("groq-desktop-app"), and changing it would move
// the userData folder, so the menu spells out the product name itself
const APP_NAME = 'Groq Desktop';

function setAppMenu({ onCheckForUpdates }) {
    const isMac = process.platform === 'darwin';
    const checkForUpdates = { label: 'Check for Updates…', click: () => onCheckForUpdates() };

    const template = [
        ...(isMac ? [{
            label: APP_NAME,
            submenu: [
                { role: 'about', label: `About ${APP_NAME}` },
                checkForUpdates,
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide', label: `Hide ${APP_NAME}` },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit', label: `Quit ${APP_NAME}` }
            ]
        }] : []),
        { role: 'fileMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
        ...(isMac ? [] : [{ role: 'help', submenu: [checkForUpdates] }])
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { setAppMenu };
