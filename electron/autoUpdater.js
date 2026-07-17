// Auto-update via electron-updater against GitHub Releases.
// On a packaged app it checks the repo's releases on startup (and every few
// hours), downloads a newer version in the background, and prompts to restart.
//
// macOS note: Squirrel.Mac only installs updates that are code-signed with a
// Developer ID. This build is unsigned, so on macOS the download will succeed
// but the install step fails signature validation — we detect that and fall
// back to opening the release page for a manual download. On Windows/Linux the
// full silent update works. Sign the mac build to get silent updates there too.

const { app, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');

const RELEASES_URL = 'https://github.com/ksg98/groq_local_stt/releases/latest';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let initialized = false;

function initAutoUpdater(mainWindow) {
    // Never run in dev — there is no packaged app to replace.
    if (!app.isPackaged || initialized) return;
    initialized = true;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    const send = (channel, payload) => {
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(channel, payload);
            }
        } catch { /* window may be gone */ }
    };

    autoUpdater.on('update-available', (info) => {
        console.log(`[AutoUpdater] Update available: ${info.version}`);
        send('update-status', { state: 'available', version: info.version });
    });

    autoUpdater.on('update-not-available', () => {
        console.log('[AutoUpdater] No update available.');
        send('update-status', { state: 'none' });
    });

    autoUpdater.on('download-progress', (p) => {
        send('update-status', { state: 'downloading', percent: Math.round(p.percent) });
    });

    autoUpdater.on('update-downloaded', async (info) => {
        console.log(`[AutoUpdater] Update downloaded: ${info.version}`);
        send('update-status', { state: 'downloaded', version: info.version });
        const { response } = await dialog.showMessageBox(mainWindow, {
            type: 'info',
            buttons: ['Restart now', 'Later'],
            defaultId: 0,
            cancelId: 1,
            title: 'Update ready',
            message: `Groq Desktop ${info.version} is ready to install.`,
            detail: 'The app will restart to apply the update.'
        });
        if (response === 0) {
            setImmediate(() => autoUpdater.quitAndInstall());
        }
    });

    autoUpdater.on('error', (err) => {
        const msg = err == null ? 'unknown' : (err.message || String(err));
        console.error('[AutoUpdater] Error:', msg);
        send('update-status', { state: 'error', message: msg });
        // Unsigned macOS builds can't self-install — offer a manual download.
        if (process.platform === 'darwin' && /signature|code sign/i.test(msg)) {
            dialog.showMessageBox(mainWindow, {
                type: 'info',
                buttons: ['Open download page', 'Later'],
                defaultId: 0,
                cancelId: 1,
                title: 'Update available',
                message: 'A new version is available but cannot auto-install on this (unsigned) build.',
                detail: 'Open the releases page to download the latest version manually.'
            }).then(({ response }) => {
                if (response === 0) shell.openExternal(RELEASES_URL);
            });
        }
    });

    const check = () => autoUpdater.checkForUpdates().catch((e) => {
        console.error('[AutoUpdater] checkForUpdates failed:', e?.message || e);
    });

    // First check shortly after launch, then on an interval.
    setTimeout(check, 10 * 1000);
    setInterval(check, CHECK_INTERVAL_MS);
}

module.exports = { initAutoUpdater };
