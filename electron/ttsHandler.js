const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Kokoro TTS sidecar manager. Spawns electron/python/kokoro_server.py via uv
// and bridges its NDJSON stdio protocol to the renderer over IPC events:
//   tts-status { state, ... }   tts-audio-chunk { id, sr, chunk }
//   tts-speak-done { id }       tts-error { id, message }

const MLX_AUDIO_SPEC = 'mlx-audio==0.4.4';

let appInstance = null;
let child = null;
let targetWebContents = null;
let stdoutBuf = '';
let lastStatus = { state: 'stopped' };
let lastStderrForward = 0;

function findUv() {
  if (process.platform !== 'darwin') return null;
  const homeDir = os.homedir();
  const candidates = [
    '/opt/homebrew/bin/uv',
    '/usr/local/bin/uv',
    '/usr/bin/uv',
    path.join(homeDir, '.local', 'bin', 'uv'),
    path.join(homeDir, '.cargo', 'bin', 'uv'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  try {
    const which = execSync('which uv', { encoding: 'utf8' }).trim();
    if (which && fs.existsSync(which)) return which;
  } catch { /* not on PATH */ }
  return null;
}

function isSupported() {
  return process.platform === 'darwin' && process.arch === 'arm64' && !!findUv();
}

function getScriptPath() {
  return appInstance && appInstance.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'python', 'kokoro_server.py')
    : path.join(__dirname, 'python', 'kokoro_server.py');
}

function send(channel, payload) {
  if (targetWebContents && !targetWebContents.isDestroyed()) {
    targetWebContents.send(channel, payload);
  }
}

function setStatus(status) {
  lastStatus = status;
  send('tts-status', status);
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
    case 'audio':
      send('tts-audio-chunk', { id: msg.id, sr: msg.sr, chunk: Buffer.from(msg.b64, 'base64') });
      break;
    case 'done':
      send('tts-speak-done', { id: msg.id });
      break;
    case 'error':
      console.error('[TTS] Sidecar error:', msg.message);
      send('tts-error', { id: msg.id, message: msg.message });
      break;
    default:
      break;
  }
}

function writeCommand(obj) {
  if (!child || !child.stdin.writable) return false;
  child.stdin.write(JSON.stringify(obj) + '\n');
  return true;
}

function startSidecar(webContents) {
  targetWebContents = webContents;
  if (child) {
    // Already running (e.g. renderer reloaded) — replay current status.
    send('tts-status', lastStatus);
    return { ok: true };
  }
  const uvPath = findUv();
  if (!isSupported() || !uvPath) {
    setStatus({ state: 'unsupported' });
    return { ok: false, error: 'Kokoro TTS requires Apple Silicon and uv (https://docs.astral.sh/uv)' };
  }

  const scriptPath = getScriptPath();
  console.log('[TTS] Spawning Kokoro sidecar:', uvPath, scriptPath);
  setStatus({ state: 'starting' });

  child = spawn(
    uvPath,
    ['run', '--no-project', '--python', '3.12', '--with', MLX_AUDIO_SPEC, '--with', 'misaki[en]', 'python', scriptPath],
    {
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
        PYTHONUNBUFFERED: '1',
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
    console.log('[TTS stderr]', line.slice(0, 400));
    // Until the model reports ready, surface progress (uv resolve / HF download)
    const now = Date.now();
    if ((lastStatus.state === 'starting' || lastStatus.state === 'loading') && now - lastStderrForward > 500) {
      lastStderrForward = now;
      send('tts-status', { ...lastStatus, detail: line.split('\n').pop().slice(0, 160) });
    }
  });

  child.on('error', (err) => {
    console.error('[TTS] Failed to spawn sidecar:', err);
    child = null;
    setStatus({ state: 'error', message: err.message });
  });

  child.on('exit', (code, signal) => {
    console.log('[TTS] Sidecar exited', { code, signal });
    child = null;
    stdoutBuf = '';
    if (lastStatus.state !== 'error') {
      setStatus({ state: 'stopped', code });
    }
  });

  return { ok: true };
}

function stopSidecar() {
  if (!child) return;
  const proc = child;
  child = null;
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

function initializeTtsHandlers(ipcMain, app) {
  appInstance = app;

  ipcMain.handle('tts-supported', () => isSupported());

  // Current sidecar state so the UI can show whether the model sits in RAM
  ipcMain.handle('tts-state', () => ({
    running: !!child,
    state: child ? lastStatus.state || 'starting' : 'stopped',
  }));

  ipcMain.handle('tts-start', (event) => startSidecar(event.sender));

  ipcMain.handle('tts-speak', (_event, { id, text, voice, speed } = {}) => {
    if (!text || !String(text).trim()) return false;
    return writeCommand({
      cmd: 'speak',
      id,
      text: String(text),
      voice: voice || 'af_heart',
      speed: speed || 1.0,
    });
  });

  ipcMain.handle('tts-cancel', () => writeCommand({ cmd: 'cancel' }));

  ipcMain.handle('tts-stop', () => {
    stopSidecar();
    return true;
  });

  console.log('[TTS] IPC handlers initialized. Supported:', isSupported());
}

module.exports = {
  initializeTtsHandlers,
  shutdown: stopSidecar,
};
