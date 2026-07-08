import { useCallback, useEffect, useRef, useState } from 'react';
import { MicVAD, utils } from '@ricky0123/vad-web';
import { SentenceChunker } from '../lib/sentenceChunker';
import { TtsPlayer } from '../lib/ttsPlayer';

// Static assets copied by vite-plugin-static-copy (dev server and dist build);
// in the packaged app they are served through the app:// scheme.
const VAD_BASE =
  window.location.protocol === 'app:' ? 'app://bundle/vad/' : `${window.location.origin}/vad/`;

const DEFAULT_VOICE = 'af_heart';
const DEFAULT_SPEED = 1.0;

/**
 * Continuous voice-agent loop: Silero VAD turn detection -> Whisper STT ->
 * auto-send transcript; streamed assistant text -> Kokoro TTS with barge-in.
 *
 * @param {object} params
 * @param {(text: string) => void} params.onTranscript  called with each final user utterance
 * @param {() => void} params.onStopGeneration          cancels the in-flight chat stream (barge-in)
 * @param {{current: boolean}} params.loadingRef        ref mirroring the chat `loading` state
 * @param {(message: string) => void} [params.onError]
 */
export function useVoiceAgent({ onTranscript, onStopGeneration, loadingRef, onError }) {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);
  const [agentState, setAgentState] = useState('idle'); // idle|starting|listening|transcribing|thinking|speaking|error
  const [ttsStatus, setTtsStatus] = useState(null);
  // Muted = voice input only: transcripts still auto-send, replies stay text
  const [muted, setMuted] = useState(() => localStorage.getItem('voice_agent_muted') === 'true');

  const activeRef = useRef(false);
  const mutedRef = useRef(muted);
  const ttsStartedRef = useRef(false);
  const vadRef = useRef(null);
  const playerRef = useRef(null);
  const chunkerRef = useRef(null);
  const unsubsRef = useRef([]);
  const speakSeqRef = useRef(0);
  const discardBelowRef = useRef(0);
  const ttsReadyRef = useRef(false);
  const speakingRef = useRef(false);
  const transcribingRef = useRef(false);
  const errorRef = useRef(false);

  // keep latest callbacks without re-initializing the VAD
  const callbacksRef = useRef({ onTranscript, onStopGeneration, onError });
  callbacksRef.current = { onTranscript, onStopGeneration, onError };

  useEffect(() => {
    window.electron?.tts
      ?.isSupported()
      .then((ok) => setSupported(!!ok))
      .catch(() => setSupported(false));
  }, []);

  // Track the sidecar lifecycle independently of the agent session so the UI
  // can always show whether the Kokoro model is loaded in RAM.
  const [sidecarState, setSidecarState] = useState('stopped');
  useEffect(() => {
    let disposed = false;
    window.electron?.tts
      ?.getState?.()
      .then((state) => {
        if (!disposed && state) setSidecarState(state.running ? state.state : 'stopped');
      })
      .catch(() => {});
    const unsubscribe =
      window.electron?.tts?.onStatus?.((status) => setSidecarState(status.state)) || (() => {});
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  // Preload the Kokoro model without starting a voice session
  const loadTts = useCallback(() => {
    window.electron.tts.start().catch(() => {});
  }, []);

  // Kill the sidecar to free RAM (no-op while a voice session is running)
  const unloadTts = useCallback(() => {
    if (activeRef.current) return;
    window.electron.tts.stop().catch(() => {});
  }, []);

  const deriveState = useCallback(() => {
    if (!activeRef.current) return 'idle';
    if (errorRef.current) return 'error';
    if (speakingRef.current) return 'speaking';
    if (transcribingRef.current) return 'transcribing';
    if (!ttsReadyRef.current && !mutedRef.current) return 'starting';
    if (loadingRef.current) return 'thinking';
    return 'listening';
  }, [loadingRef]);

  const refreshState = useCallback(() => {
    setAgentState(deriveState());
  }, [deriveState]);

  // `thinking` depends on loadingRef which doesn't trigger renders here — poll
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(refreshState, 300);
    return () => clearInterval(timer);
  }, [active, refreshState]);

  const bargeIn = useCallback(() => {
    const player = playerRef.current;
    const busy = player?.isSpeaking || loadingRef.current;
    if (!busy) return;
    // ignore audio still in flight for cancelled sentences
    discardBelowRef.current = speakSeqRef.current + 1;
    chunkerRef.current?.reset();
    player?.stopAll();
    window.electron.tts.cancel().catch(() => {});
    if (loadingRef.current) {
      callbacksRef.current.onStopGeneration?.();
    }
  }, [loadingRef]);

  const waitForIdle = useCallback(
    async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (loadingRef.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return !loadingRef.current;
    },
    [loadingRef]
  );

  const handleSpeechEnd = useCallback(
    async (audio) => {
      if (!activeRef.current) return;
      transcribingRef.current = true;
      refreshState();
      try {
        // 16kHz mono int16 WAV (format 1 = PCM)
        const wav = utils.encodeWAV(audio, 1, 16000, 1, 16);
        const result = await window.electron.speechToText.transcribe(
          Array.from(new Uint8Array(wav)),
          { format: 'wav', model: 'whisper-large-v3-turbo', response_format: 'verbose_json' }
        );
        const text = result?.text?.trim();
        if (text && activeRef.current) {
          const idle = await waitForIdle(4000);
          if (idle && activeRef.current) {
            callbacksRef.current.onTranscript?.(text);
          } else if (activeRef.current) {
            console.warn('[VoiceAgent] Chat still busy, dropping utterance:', text);
          }
        }
      } catch (error) {
        console.error('[VoiceAgent] Transcription failed:', error);
        callbacksRef.current.onError?.(error.message || 'Transcription failed');
      } finally {
        transcribingRef.current = false;
        refreshState();
      }
    },
    [refreshState, waitForIdle]
  );

  const stop = useCallback(async () => {
    activeRef.current = false;
    setActive(false);
    const vad = vadRef.current;
    vadRef.current = null;
    if (vad) {
      try {
        await vad.destroy();
      } catch {
        /* ignore */
      }
    }
    playerRef.current?.stopAll();
    window.electron.tts?.cancel().catch(() => {});
    unsubsRef.current.forEach((unsub) => {
      try {
        unsub();
      } catch {
        /* ignore */
      }
    });
    unsubsRef.current = [];
    chunkerRef.current = null;
    speakingRef.current = false;
    transcribingRef.current = false;
    errorRef.current = false;
    ttsReadyRef.current = false;
    ttsStartedRef.current = false;
    setTtsStatus(null);
    setAgentState('idle');
    // Keep the sidecar warm across toggles; it is killed on app quit.
  }, []);

  const start = useCallback(async () => {
    if (activeRef.current) return;
    errorRef.current = false;
    setAgentState('starting');
    try {
      const granted = await window.electron.speechToText.requestMicPermission();
      if (!granted) {
        window.electron.speechToText.openMicSettings?.();
        throw new Error(
          'Microphone access is blocked. Enable it in System Settings > Privacy & Security > Microphone.'
        );
      }

      activeRef.current = true;
      setActive(true);
      chunkerRef.current = new SentenceChunker();
      if (!playerRef.current) {
        playerRef.current = new TtsPlayer({
          onSpeakingChange: (speaking) => {
            speakingRef.current = speaking;
            refreshState();
          },
        });
      }
      playerRef.current.ensureContext(); // inside the button-click gesture

      unsubsRef.current.push(
        window.electron.tts.onStatus((status) => {
          setTtsStatus(status);
          ttsReadyRef.current = status.state === 'ready';
          if (status.state === 'error') {
            errorRef.current = true;
            callbacksRef.current.onError?.(status.message || 'Kokoro TTS failed to start');
          }
          refreshState();
        }),
        window.electron.tts.onAudioChunk(({ id, sr, chunk }) => {
          if (!activeRef.current || id < discardBelowRef.current) return;
          playerRef.current?.enqueue(chunk, sr);
        }),
        window.electron.tts.onError(({ message }) => {
          console.error('[VoiceAgent] TTS error:', message);
        })
      );

      // Muted mode skips the sidecar entirely — no model load, no RAM
      if (!mutedRef.current) {
        const startResult = await window.electron.tts.start();
        if (startResult && startResult.ok === false) {
          throw new Error(startResult.error || 'Failed to start Kokoro TTS');
        }
        ttsStartedRef.current = true;
      }

      vadRef.current = await MicVAD.new({
        model: 'v5',
        baseAssetPath: VAD_BASE,
        onnxWASMBasePath: VAD_BASE,
        getStream: () =>
          navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          }),
        positiveSpeechThreshold: 0.6,
        negativeSpeechThreshold: 0.35,
        redemptionMs: 800,
        preSpeechPadMs: 300,
        minSpeechMs: 250,
        onSpeechStart: () => {
          if (activeRef.current) bargeIn();
        },
        onSpeechEnd: handleSpeechEnd,
        onVADMisfire: refreshState,
      });
      if (!activeRef.current) {
        // stopped while initializing
        await vadRef.current?.destroy();
        vadRef.current = null;
        return;
      }
      await vadRef.current.start();
      refreshState();
    } catch (error) {
      console.error('[VoiceAgent] Failed to start:', error);
      callbacksRef.current.onError?.(error.message || 'Failed to start voice agent');
      await stop();
    }
  }, [bargeIn, handleSpeechEnd, refreshState, stop]);

  const toggle = useCallback(() => {
    if (activeRef.current) {
      stop();
    } else {
      start();
    }
  }, [start, stop]);

  const speakSentence = useCallback((text) => {
    if (!text || !activeRef.current || mutedRef.current) return;
    const id = ++speakSeqRef.current;
    window.electron.tts
      .speak({ id, text, voice: DEFAULT_VOICE, speed: DEFAULT_SPEED })
      .catch(() => {});
  }, []);

  // Text-only mode toggle: muting silences immediately; unmuting mid-session
  // lazily starts the sidecar if this session began muted.
  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    localStorage.setItem('voice_agent_muted', String(next));
    if (next) {
      discardBelowRef.current = speakSeqRef.current + 1;
      chunkerRef.current?.reset();
      playerRef.current?.stopAll();
      window.electron.tts?.cancel().catch(() => {});
    } else if (activeRef.current && !ttsStartedRef.current) {
      window.electron.tts
        .start()
        .then(() => {
          ttsStartedRef.current = true;
        })
        .catch(() => {});
      ttsStartedRef.current = true;
    }
    refreshState();
  }, [refreshState]);

  // Called with every streamed content delta from the assistant
  const feedAssistantDelta = useCallback(
    (delta) => {
      if (!activeRef.current || !delta) return;
      chunkerRef.current?.feed(delta).forEach(speakSentence);
    },
    [speakSentence]
  );

  // Called when an assistant turn completes (speaks the trailing partial sentence)
  const flushAssistantTurn = useCallback(() => {
    if (!activeRef.current) return;
    const rest = chunkerRef.current?.flush();
    if (rest) speakSentence(rest);
  }, [speakSentence]);

  // Called on stream error/cancel — drop any un-spoken text
  const cancelSpeech = useCallback(() => {
    discardBelowRef.current = speakSeqRef.current + 1;
    chunkerRef.current?.reset();
    playerRef.current?.stopAll();
    window.electron.tts?.cancel().catch(() => {});
  }, []);

  // Cleanup on unmount (incl. HMR)
  useEffect(() => {
    return () => {
      if (activeRef.current) stop();
      playerRef.current?.close();
      playerRef.current = null;
    };
  }, [stop]);

  return {
    supported,
    active,
    agentState,
    ttsStatus,
    muted,
    toggleMute,
    sidecarState,
    sidecarLoaded: sidecarState === 'ready',
    sidecarLoading: sidecarState === 'starting' || sidecarState === 'loading',
    loadTts,
    unloadTts,
    start,
    stop,
    toggle,
    feedAssistantDelta,
    flushAssistantTurn,
    cancelSpeech,
  };
}
