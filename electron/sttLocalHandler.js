const { spawn } = require('child_process');
const path = require('path');

const { findUv } = require('./ttsHandler');

// Local Whisper STT sidecar manager (mlx-whisper). Spawns
// electron/python/whisper_server.py via uv, keeps the model resident in RAM
// between requests, and exposes a promise-based transcribe RPC plus lifecycle
// IPC so Settings can load/unload the model and show its state:
//   stt-local-status { state, ... }

const MLX_WHISPER_SPEC = 'mlx-whisper==0.4.3';
const TRANSCRIBE_TIMEOUT_MS = 5 * 60 * 1000; // first call may download the model

let appInstance = null;
let child = null;
let currentModel = null;
let targetWebContents = null;
let stdoutBuf = '';
let lastStatus = { state: 'stopped' };
let lastStderrForward = 0;
let nextReqId = 0;
const pending = new Map(); // id -> { resolve, reject, timer }

function isSupported() {
  return process.platform === 'darwin' && process.arch === 'arm64' && !!findUv();
}

function getScriptPath() {
  return appInstance && appInstance.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'python', 'whisper_server.py')
    : path.join(__dirname, 'python', 'whisper_server.py');
}

function send(channel, payload) {
  if (targetWebContents && !targetWebContents.isDestroyed()) {
    targetWebContents.send(channel, payload);
  }
}

function setStatus(status) {
  lastStatus = status;
  send('stt-local-status', status);
}

function rejectAllPending(message) {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(message));
  }
  pending.clear();
}

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  switch (msg.type) {
    case 'status':
      setStatus(msg);
      break;
    case 'result': {
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve({ text: msg.text || '', language: msg.language, duration: msg.duration });
      }
      break;
    }
    case 'error': {
      console.error('[STT local] Sidecar error:', msg.message);
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.reject(new Error(msg.message || 'Local transcription failed'));
      }
      break;
    }
    default:
      break;
  }
}

function startSidecar(model, webContents) {
  if (webContents) targetWebContents = webContents;
  if (child && currentModel === model) {
    send('stt-local-status', lastStatus);
    return { ok: true };
  }
  if (child) {
    // Model changed in Settings — swap the sidecar
    stopSidecar();
  }
  const uvPath = findUv();
  if (!isSupported() || !uvPath) {
    setStatus({ state: 'unsupported' });
    return { ok: false, error: 'Local Whisper requires Apple Silicon and uv (https://docs.astral.sh/uv)' };
  }

  const scriptPath = getScriptPath();
  console.log('[STT local] Spawning whisper sidecar:', model);
  currentModel = model;
  setStatus({ state: 'starting', model });

  child = spawn(
    uvPath,
    ['run', '--no-project', '--python', '3.12', '--with', MLX_WHISPER_SPEC, 'python', scriptPath],
    {
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
        PYTHONUNBUFFERED: '1',
        WHISPER_MODEL: model,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    stdoutBuf += data;
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line) handleLine(line);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (!line) return;
    console.log('[STT local stderr]', line.slice(0, 400));
    // Until the model reports ready, surface progress (uv resolve / HF download)
    const now = Date.now();
    if ((lastStatus.state === 'starting' || lastStatus.state === 'loading') && now - lastStderrForward > 500) {
      lastStderrForward = now;
      send('stt-local-status', { ...lastStatus, detail: line.split('\n').pop().slice(0, 160) });
    }
  });

  child.on('error', (err) => {
    console.error('[STT local] Failed to spawn sidecar:', err);
    child = null;
    currentModel = null;
    setStatus({ state: 'error', message: err.message });
    rejectAllPending(`Local Whisper failed to start: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    console.log('[STT local] Sidecar exited', { code, signal });
    child = null;
    currentModel = null;
    stdoutBuf = '';
    const message =
      lastStatus.state === 'error' && lastStatus.message
        ? lastStatus.message
        : `Local Whisper exited (code ${code})`;
    if (lastStatus.state !== 'error') {
      setStatus({ state: 'stopped', code });
    }
    rejectAllPending(message);
  });

  return { ok: true };
}

function writeCommand(obj) {
  if (!child || !child.stdin.writable) return false;
  child.stdin.write(JSON.stringify(obj) + '\n');
  return true;
}

/**
 * Transcribe a 16-bit PCM WAV buffer with the local mlx-whisper sidecar.
 * Auto-starts the sidecar (and downloads the model) on first use.
 */
function transcribeLocal(wavBuffer, { model, language } = {}) {
  const wanted = model || currentModel || 'mlx-community/whisper-large-v3-turbo';
  const startResult = startSidecar(wanted, null);
  if (!startResult.ok) {
    return Promise.reject(new Error(startResult.error));
  }
  const id = ++nextReqId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Local transcription timed out'));
    }, TRANSCRIBE_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    const written = writeCommand({
      cmd: 'transcribe',
      id,
      b64: wavBuffer.toString('base64'),
      language: language || undefined,
    });
    if (!written) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error('Local Whisper sidecar is not running'));
    }
  });
}

function stopSidecar() {
  rejectAllPending('Local Whisper was stopped');
  if (!child) return;
  const proc = child;
  child = null;
  currentModel = null;
  try {
    proc.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n');
    proc.stdin.end();
  } catch { /* ignore */ }
  const termTimer = setTimeout(() => {
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  }, 1000);
  const killTimer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  }, 3000);
  proc.on('exit', () => {
    clearTimeout(termTimer);
    clearTimeout(killTimer);
  });
}

function initializeSttLocalHandlers(ipcMain, app, loadSettings) {
  appInstance = app;

  ipcMain.handle('stt-local-supported', () => isSupported());

  // Current sidecar state so the UI can show whether the model sits in RAM
  ipcMain.handle('stt-local-state', () => ({
    running: !!child,
    model: currentModel,
    state: child ? lastStatus.state || 'starting' : 'stopped',
  }));

  ipcMain.handle('stt-local-start', (event) => {
    const settings = loadSettings();
    const model = settings.sttModelLocal || 'mlx-community/whisper-large-v3-turbo';
    return startSidecar(model, event.sender);
  });

  ipcMain.handle('stt-local-stop', () => {
    stopSidecar();
    return true;
  });

  console.log('[STT local] IPC handlers initialized. Supported:', isSupported());
}

module.exports = {
  initializeSttLocalHandlers,
  transcribeLocal,
  isSupported,
  getCurrentModel: () => currentModel,
  shutdown: stopSidecar,
};
