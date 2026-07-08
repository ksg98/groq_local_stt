const Groq = require('groq-sdk');
const { systemPreferences, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

let groqClient = null;

/**
 * Initialize the Groq client with API key
 */
function initializeClient(apiKey) {
  if (!apiKey || apiKey === "<replace me>") {
    throw new Error('Valid Groq API key is required for speech-to-text');
  }
  groqClient = new Groq({ apiKey });
  return groqClient;
}

/**
 * Transcribe audio using Groq's Whisper API
 * @param {Buffer} audioBuffer - The audio data as a Buffer
 * @param {string} apiKey - The Groq API key
 * @param {object} options - Additional options
 * @returns {Promise<{text: string, duration?: number}>}
 */
async function transcribeAudio(audioBuffer, apiKey, options = {}) {
  try {
    // Initialize or reinitialize client if needed
    if (!groqClient) {
      initializeClient(apiKey);
    }

    // Validate buffer size - need at least 5KB of audio data
    if (!audioBuffer || audioBuffer.length < 5000) {
      console.log('[SpeechToText] Audio too short:', audioBuffer?.length || 0, 'bytes (need at least 5KB)');
      return { text: '', duration: 0, skipped: true };
    }

    console.log('[SpeechToText] Processing audio buffer:', audioBuffer.length, 'bytes');

    // Check the first few bytes to identify the format
    const header = audioBuffer.slice(0, 12).toString('hex');
    console.log('[SpeechToText] Audio header (hex):', header);

    // Create a temporary file for the audio. Recordings from MediaRecorder are
    // webm/opus; the voice agent sends raw 16kHz WAV instead.
    const ext = options.format === 'wav' ? 'wav' : 'webm';
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, `groq-stt-${Date.now()}.${ext}`);

    // Write the buffer to a temporary file
    fs.writeFileSync(tempFilePath, audioBuffer);

    // Verify file was written
    const stats = fs.statSync(tempFilePath);
    console.log('[SpeechToText] Temp file created:', tempFilePath, 'size:', stats.size);

    try {
      // Use Groq SDK's toFile helper for proper file creation
      const { toFile } = require('groq-sdk');
      const audioFile = await toFile(fs.createReadStream(tempFilePath), `recording.${ext}`, {
        type: ext === 'wav' ? 'audio/wav' : 'audio/webm',
      });

      console.log('[SpeechToText] File object created for API');

      // Call Groq's transcription API
      const transcription = await groqClient.audio.transcriptions.create({
        file: audioFile,
        model: options.model || 'whisper-large-v3-turbo',
        response_format: options.response_format || 'verbose_json',
        language: options.language || undefined, // Auto-detect if not specified
        temperature: options.temperature || 0,
      });

      console.log('[SpeechToText] Transcription successful:', {
        textLength: transcription.text?.length,
        duration: transcription.duration,
      });

      return {
        text: transcription.text || '',
        duration: transcription.duration,
        language: transcription.language,
      };
    } finally {
      // Clean up temp file
      try {
        fs.unlinkSync(tempFilePath);
      } catch (cleanupError) {
        console.warn('[SpeechToText] Failed to clean up temp file:', cleanupError.message);
      }
    }
  } catch (error) {
    console.error('[SpeechToText] Transcription error:', error);

    // Provide more specific error messages
    if (error.status === 401) {
      throw new Error('Invalid API key. Please check your Groq API key in settings.');
    } else if (error.status === 413) {
      throw new Error('Audio file too large. Maximum size is 25MB.');
    } else if (error.status === 400) {
      throw new Error('Recording too short or invalid format. Please record for at least 1 second.');
    }

    throw new Error(error.message || 'Failed to transcribe audio');
  }
}

/**
 * Initialize IPC handlers for speech-to-text
 */
function initializeSpeechToTextHandlers(ipcMain, loadSettings) {
  console.log('[SpeechToText] Initializing IPC handlers...');

  // Handle transcription request
  ipcMain.handle('speech-to-text-transcribe', async (_event, audioData, options = {}) => {
    console.log('[SpeechToText] Received transcription request, size:', audioData?.length || 0);

    const settings = loadSettings();
    if (!settings.GROQ_API_KEY || settings.GROQ_API_KEY === "<replace me>") {
      throw new Error('Groq API key not configured. Please add your API key in Settings.');
    }

    // Convert array to Buffer if needed
    const audioBuffer = Buffer.isBuffer(audioData) ? audioData : Buffer.from(audioData);

    return transcribeAudio(audioBuffer, settings.GROQ_API_KEY, options);
  });

  // Microphone permission (macOS). In dev mode the app runs as the generic
  // Electron binary, so system-level mic access must be requested explicitly —
  // otherwise getUserMedia can succeed but deliver a silent stream.
  ipcMain.handle('speech-to-text-mic-permission-status', () => {
    if (process.platform !== 'darwin') return 'granted';
    return systemPreferences.getMediaAccessStatus('microphone');
  });

  ipcMain.handle('speech-to-text-request-mic-permission', async () => {
    if (process.platform !== 'darwin') return true;
    const status = systemPreferences.getMediaAccessStatus('microphone');
    console.log('[SpeechToText] Microphone access status:', status);
    if (status === 'granted') return true;
    if (status === 'not-determined') {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      console.log('[SpeechToText] Microphone access', granted ? 'granted' : 'denied', 'by user');
      return granted;
    }
    // 'denied' or 'restricted' — must be enabled in System Settings
    return false;
  });

  ipcMain.handle('speech-to-text-open-mic-settings', () => {
    if (process.platform === 'darwin') {
      return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    }
  });

  console.log('[SpeechToText] IPC handlers initialized');
}

module.exports = {
  initializeSpeechToTextHandlers,
  transcribeAudio,
};
