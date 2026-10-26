// Auto-update via electron-updater against GitHub Releases.
// On a packaged app it checks the repo's releases on startup (and every few
// hours), downloads a newer version in the background, and prompts to restart.
// Settings and the app menu can also check on demand.
//
// macOS: Squirrel.Mac refuses to install a bundle that isn't signed with an
// Apple Developer ID ("code signature ... did not pass validation"), so on
// darwin we let electron-updater do the detection and download — both of which
// work fine unsigned — and then perform the install ourselves by swapping the
// .app bundle from a detached script. Windows/Linux keep the built-in installer.

const { app, dialog, shell, BrowserWindow } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RELEASES_URL = 'https://github.com/ksg98/groq_local_stt/releases/latest';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let initialized = false;
// Latest updater state, broadcast to every window so Settings can show it
let status = { state: 'idle' };
let downloadedInfo = null;

function getUpdateStatus() {
    return { ...status, currentVersion: app.getVersion(), supported: app.isPackaged };
}

function setStatus(next) {
    status = next;
    const payload = getUpdateStatus();
    for (const win of BrowserWindow.getAllWindows()) {
        try {
            if (!win.isDestroyed()) win.webContents.send('update-status', payload);
        } catch { /* window may be gone */ }
    }
}

// The window that was focused at init is destroyed once the user closes it,
// and a dialog parented to a destroyed window never appears (on macOS it would
// be a sheet attached to nothing). Resolve a live window each time, and fall
// back to an app-modal dialog when there is none.
function showDialog(options) {
    const parent = BrowserWindow.getFocusedWindow()
        || BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
        || null;
    app.focus({ steal: true }); // otherwise it can sit unnoticed behind other apps
    return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

// The installed .app bundle root, derived from the running executable:
// /Applications/Groq Desktop.app/Contents/MacOS/Groq Desktop -> up three levels
function installedBundlePath() {
    const exe = app.getPath('exe');
    const bundle = path.resolve(path.dirname(exe), '..', '..');
    return bundle.endsWith('.app') ? bundle : null;
}

// Swap the bundle from a detached shell script that first waits for this
// process to exit — a running app can't reliably replace its own bundle.
// Keeps a backup and rolls back if the copy fails, so a bad update can't
// leave the user with no app at all.
function installMacUpdate(downloadedFile) {
    const bundle = installedBundlePath();
    if (!bundle) throw new Error('Cannot locate the installed app bundle');

    // electron-updater reports the file it downloaded; fall back to scanning its
    // cache directory if that field is ever missing.
    let zipPath = downloadedFile && fs.existsSync(downloadedFile) ? downloadedFile : null;
    if (!zipPath) {
        const pending = path.join(app.getPath('home'), 'Library', 'Caches', 'groq-desktop-app-updater', 'pending');
        try {
            const zip = fs.readdirSync(pending).find((f) => f.endsWith('.zip'));
            if (zip) zipPath = path.join(pending, zip);
        } catch { /* nothing cached */ }
    }
    if (!zipPath) throw new Error('Could not find the downloaded update file');

    const script = `#!/bin/bash
set -u
APP=${JSON.stringify(bundle)}
ZIP=${JSON.stringify(zipPath)}
PID=${process.pid}
TMP="$(/usr/bin/mktemp -d)"
BACKUP="$APP.old-$$"

# Wait (up to ~60s) for the app to fully exit before touching its bundle
for _ in $(seq 1 120); do
  /bin/kill -0 "$PID" 2>/dev/null || break
  /bin/sleep 0.5
done
/bin/sleep 1

# ditto preserves macOS bundle metadata that plain unzip/cp drop
/usr/bin/ditto -xk "$ZIP" "$TMP" || { /bin/rm -rf "$TMP"; exit 1; }
NEW="$(/usr/bin/find "$TMP" -maxdepth 1 -name '*.app' -print -quit)"
if [ ! -d "$NEW" ]; then /bin/rm -rf "$TMP"; exit 1; fi

/bin/mv "$APP" "$BACKUP" || { /bin/rm -rf "$TMP"; exit 1; }
if /usr/bin/ditto "$NEW" "$APP"; then
  /usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null
  /bin/rm -rf "$BACKUP" "$TMP"
else
  # Roll back to the version that was working
  /bin/rm -rf "$APP"
  /bin/mv "$BACKUP" "$APP"
  /bin/rm -rf "$TMP"
fi
/usr/bin/open "$APP"
/bin/rm -f "$0"
`;

    const scriptPath = path.join(os.tmpdir(), `groq-desktop-update-${Date.now()}.sh`);
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
    const child = spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' });
    child.unref();
}

async function promptRestart(info) {
    const { response } = await showDialog({
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update ready',
        message: `Groq Desktop ${info.version} is ready to install.`,
        detail: 'The app will restart to apply the update.'
    });
    if (response === 0) await installDownloadedUpdate();
}

async function installDownloadedUpdate() {
    const info = downloadedInfo;
    if (!info) return getUpdateStatus();

    if (process.platform !== 'darwin') {
        setImmediate(() => autoUpdater.quitAndInstall());
        return getUpdateStatus();
    }
    // macOS: install it ourselves so an unsigned build can still update.
    try {
        installMacUpdate(info.downloadedFile);
        console.log('[AutoUpdater] Handing off to installer script; quitting.');
        setImmediate(() => app.quit());
    } catch (e) {
        console.error('[AutoUpdater] Self-install failed:', e.message);
        const { response: r } = await showDialog({
            type: 'warning',
            buttons: ['Open download page', 'Later'],
            defaultId: 0,
            cancelId: 1,
            title: 'Could not install update',
            message: `Automatic install failed: ${e.message}`,
            detail: 'You can download the new version manually instead.'
        });
        if (r === 0) shell.openExternal(RELEASES_URL);
    }
    return getUpdateStatus();
}

// A check the user asked for. From the app menu (interactive) the result is
// reported in a dialog; Settings shows it from the broadcast status instead.
async function checkForUpdatesNow({ interactive = false } = {}) {
    const version = app.getVersion();
    if (!app.isPackaged) {
        if (interactive) {
            await showDialog({
                type: 'info',
                buttons: ['OK'],
                message: 'Updates only work in the installed app.',
                detail: `This is a development build (${version}).`
            });
        }
        return getUpdateStatus();
    }
    if (status.state === 'downloaded') {
        if (interactive) await promptRestart(downloadedInfo);
        return getUpdateStatus();
    }

    // Concurrent calls share electron-updater's in-flight check
    await autoUpdater.checkForUpdates().catch((e) => {
        console.error('[AutoUpdater] checkForUpdates failed:', e?.message || e);
    });
    if (!interactive) return getUpdateStatus();

    if (status.state === 'none') {
        await showDialog({
            type: 'info',
            buttons: ['OK'],
            message: 'You\'re up to date.',
            detail: `Groq Desktop ${version} is the latest version.`
        });
    } else if (status.state === 'available' || status.state === 'downloading') {
        await showDialog({
            type: 'info',
            buttons: ['OK'],
            message: `Groq Desktop ${status.version} is downloading.`,
            detail: 'You\'ll be asked to restart when it\'s ready.'
        });
    } else if (status.state === 'error') {
        const { response } = await showDialog({
            type: 'warning',
            buttons: ['Open download page', 'OK'],
            defaultId: 1,
            cancelId: 1,
            message: 'Could not check for updates.',
            detail: status.message
        });
        if (response === 0) shell.openExternal(RELEASES_URL);
    }
    return getUpdateStatus();
}

function initAutoUpdater() {
    // Never run in dev — there is no packaged app to replace.
    if (!app.isPackaged || initialized) return;
    initialized = true;

    autoUpdater.autoDownload = true;
    // On macOS we install via installMacUpdate(); letting Squirrel also try at
    // quit just reproduces the signature-validation failure.
    autoUpdater.autoInstallOnAppQuit = process.platform !== 'darwin';

    autoUpdater.on('checking-for-update', () => {
        setStatus({ state: 'checking' });
    });

    autoUpdater.on('update-available', (info) => {
        console.log(`[AutoUpdater] Update available: ${info.version}`);
        setStatus({ state: 'available', version: info.version });
    });

    autoUpdater.on('update-not-available', () => {
        console.log('[AutoUpdater] No update available.');
        setStatus({ state: 'none', checkedAt: Date.now() });
    });

    autoUpdater.on('download-progress', (p) => {
        setStatus({ state: 'downloading', version: status.version, percent: Math.round(p.percent) });
    });

    autoUpdater.on('update-downloaded', async (info) => {
        console.log(`[AutoUpdater] Update downloaded: ${info.version}`);
        downloadedInfo = info;
        setStatus({ state: 'downloaded', version: info.version });
        await promptRestart(info);
    });

    autoUpdater.on('error', (err) => {
        const msg = err == null ? 'unknown' : (err.message || String(err));
        console.error('[AutoUpdater] Error:', msg);
        setStatus({ state: 'error', message: msg });
        // Unsigned macOS builds can't self-install — offer a manual download.
        if (process.platform === 'darwin' && /signature|code sign/i.test(msg)) {
            showDialog({
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

module.exports = { initAutoUpdater, checkForUpdatesNow, getUpdateStatus, installDownloadedUpdate };
