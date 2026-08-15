const { desktopCapturer, session, systemPreferences, shell, screen } = require('electron');

// Screenshare/camera IPC. Screenshare flow: renderer fetches sources
// (thumbnails), user picks one, renderer calls capture-select-source, then
// navigator.mediaDevices.getDisplayMedia() which is fulfilled by the
// display-media request handler below with the chosen source.

let pendingSource = null;
let lastSources = [];

function initializeCaptureHandlers(ipcMain) {
  ipcMain.handle('capture-get-sources', async () => {
    lastSources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false,
    });
    return lastSources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
    }));
  });

  ipcMain.handle('capture-select-source', (_event, sourceId) => {
    pendingSource = lastSources.find((source) => source.id === sourceId) || null;
    return !!pendingSource;
  });

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    if (pendingSource) {
      callback({ video: pendingSource });
    } else {
      callback(null); // no source selected — deny
    }
    pendingSource = null;
  });

  // Without an explicit handler Chromium can reject getUserMedia (mic/camera)
  // outright instead of deferring to the OS-level permission
  const ALLOWED_PERMISSIONS = ['media', 'display-capture', 'clipboard-sanitized-write'];
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) =>
    ALLOWED_PERMISSIONS.includes(permission)
  );

  ipcMain.handle('capture-screen-access-status', () => {
    if (process.platform !== 'darwin') return 'granted';
    return systemPreferences.getMediaAccessStatus('screen');
  });

  ipcMain.handle('capture-open-screen-settings', () => {
    if (process.platform === 'darwin') {
      return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    }
  });

  ipcMain.handle('capture-request-camera-permission', async () => {
    if (process.platform !== 'darwin') return true;
    const status = systemPreferences.getMediaAccessStatus('camera');
    if (status === 'granted') return true;
    if (status === 'not-determined') {
      return systemPreferences.askForMediaAccess('camera');
    }
    return false; // denied/restricted — needs System Settings
  });

  console.log('[Capture] IPC handlers initialized');
}

// --- Cmd/Ctrl+H: screenshot straight into the chat input --------------------

async function captureScreenshot(win) {
  if (
    process.platform === 'darwin' &&
    systemPreferences.getMediaAccessStatus('screen') !== 'granted'
  ) {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    );
    throw new Error(
      'Screen Recording permission is required for screenshots. Enable it in System Settings > Privacy & Security > Screen Recording, then try again.'
    );
  }

  const display = screen.getDisplayMatching(win.getBounds());

  // Hide our own window so the shot shows what's behind it. Skipped in
  // fullscreen, where hide() would yank the user to another Space.
  const shouldHide = win.isVisible() && !win.isFullScreen();
  if (shouldHide) {
    win.hide();
    await new Promise((resolve) => setTimeout(resolve, 250)); // let the compositor drop us
  }
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      },
    });
    const source =
      sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error('No screen available to capture');
    }
    let image = source.thumbnail;
    // 1920px-wide JPEG keeps text legible while staying well under provider
    // request-size limits (a full Retina PNG is several MB of base64).
    if (image.getSize().width > 1920) image = image.resize({ width: 1920 });
    return `data:image/jpeg;base64,${image.toJPEG(88).toString('base64')}`;
  } finally {
    if (shouldHide && !win.isDestroyed()) win.show();
  }
}

// Registered per window by windowManager. Hooked on before-input-event so it
// wins over the macOS Hide (Cmd+H) menu accelerator; the renderer receives
// the image (or the error) on 'screenshot-captured'.
function registerScreenshotShortcut(win) {
  let busy = false;
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.shift || input.alt) return;
    if (!(input.meta || input.control)) return;
    if ((input.key || '').toLowerCase() !== 'h') return;
    event.preventDefault();
    if (busy) return;
    busy = true;
    captureScreenshot(win)
      .then((dataUrl) => {
        if (!win.isDestroyed()) win.webContents.send('screenshot-captured', { dataUrl });
      })
      .catch((error) => {
        console.error('[Capture] Screenshot failed:', error);
        if (!win.isDestroyed()) {
          win.webContents.send('screenshot-captured', { error: error.message });
        }
      })
      .finally(() => {
        busy = false;
      });
  });
}

module.exports = { initializeCaptureHandlers, registerScreenshotShortcut };
