const { desktopCapturer, session, systemPreferences, shell } = require('electron');

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

module.exports = { initializeCaptureHandlers };
