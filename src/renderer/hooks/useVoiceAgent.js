import { useCallback, useEffect, useRef, useState } from 'react';
import { MicVAD, utils } from '@ricky0123/vad-web';
import { SentenceChunker } from '../lib/sentenceChunker';
import { TtsPlayer } from '../lib/ttsPlayer';
import { FrameBank } from '../lib/frameBank';
import { splitWords, wordTimings, wordIndexAt, estimateDuration } from '../lib/speechTiming';

// Static assets copied by vite-plugin-static-copy (dev server and dist build);
// in the packaged app they are served through the app:// scheme.
const VAD_BASE =
  window.location.protocol === 'app:' ? 'app://bundle/vad/' : `${window.location.origin}/vad/`;

const DEFAULT_VOICE = 'af_heart';
const DEFAULT_SPEED = 1.0;
export const SPEED_STEPS = [0.75, 1, 1.25, 1.5, 1.75, 2];
// How many sentences may be in synthesis at once during read-aloud. Enough to
// stay gapless, few enough that a speed change is heard within a sentence or two.
const READ_LOOKAHEAD = 2;

// A read-aloud token names what is being read: a message index, 'selection',
// or a getter for a message whose index is only known once it renders (a reply
// read while it streams in).
export function resolveToken(token) {
  return typeof token === 'function' ? token() : token;
}

// Where the voice is inside a read, published outside React state so only the
// message being read re-renders as the word moves.
function createCursorStore() {
  let value = null;
  const listeners = new Set();
  return {
    get: () => value,
    set: (next) => {
      value = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// Split arbitrary text into speakable sentences using the same rules the
// streaming path uses, so code blocks and markdown are stripped identically.
export function sentencesForSpeech(text) {
  const chunker = new SentenceChunker();
  const parts = chunker.feed(String(text || ''));
  const rest = chunker.flush();
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

/**
 * Continuous voice-agent loop: Silero VAD turn detection -> Whisper STT ->
 * auto-send transcript; streamed assistant text -> Kokoro TTS with barge-in.
 *
 * @param {object} params
 * @param {(text: string, extra?: {frames?: object[], heldMs?: number}) => void} params.onTranscript
 *        called with each final user utterance; a released held turn also carries the frames banked during it
 * @param {() => ({url: string, sig: Uint8Array}|null)} [params.captureHeldFrame]
 *        grabs the current screen/camera frame; called at the end of each utterance while the floor is held
 * @param {{current: number}} [params.frameBudgetRef]  max frames per held turn, including the send-time frame
 * @param {boolean} [params.autoRead]                   read every reply aloud as it streams, without a voice session
 * @param {() => void} params.onStopGeneration          cancels the in-flight chat stream (barge-in)
 * @param {{current: boolean}} params.loadingRef        ref mirroring the chat `loading` state
 * @param {(message: string) => void} [params.onError]
 */
export function useVoiceAgent({
  onTranscript,
  onStopGeneration,
  loadingRef,
  onError,
  captureHeldFrame,
  frameBudgetRef,
  autoRead = false,
}) {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);
  const [agentState, setAgentState] = useState('idle'); // idle|starting|listening|transcribing|thinking|speaking|error
  const [ttsStatus, setTtsStatus] = useState(null);
  // Muted = voice input only: transcripts still auto-send, replies stay text
  const [muted, setMuted] = useState(() => localStorage.getItem('voice_agent_muted') === 'true');
  // Mic mute = pause the VAD (stop listening) without ending the session. Transient.
  const [micMuted, setMicMuted] = useState(false);
  // Hold the floor = keep listening but never end the turn on silence, so long
  // pauses for thinking don't hand the conversation back. Released manually.
  const [holding, setHolding] = useState(false);
  // Text captured while holding, joined and sent as one utterance on release
  const [heldText, setHeldText] = useState('');
  // Reading a specific message or selection aloud, outside the agent's own
  // replies. `token` identifies what is being read so the UI can mark it.
  const [playback, setPlayback] = useState({ token: null, state: 'idle' });
  // Playback is paused, whichever source it came from: an agent reply or a
  // message being read aloud.
  const [speechPaused, setSpeechPaused] = useState(false);
  const [speed, setSpeedState] = useState(DEFAULT_SPEED);

  const activeRef = useRef(false);
  const mutedRef = useRef(muted);
  const micMutedRef = useRef(false);
  const holdingRef = useRef(false);
  const heldPartsRef = useRef([]);
  // Segments that ended while the floor was held and are still transcribing.
  // Release waits these out so the tail of a sentence isn't split off.
  const pendingHoldRef = useRef(0);
  // Frames banked during the held turn, one offered per utterance
  const frameBankRef = useRef(null);
  const holdStartRef = useRef(0);
  const speedRef = useRef(DEFAULT_SPEED);
  // Read-aloud session: the sentences being read and where the voice is
  const readSessionRef = useRef(null); // { token, getToken, sentences, streaming, starting }
  const segmentInfoRef = useRef(new Map()); // sentence id -> { index, tokens, words, timings, timingKey }
  const cursorTimerRef = useRef(null);
  const cursorRef = useRef(null);
  const cursorStoreRef = useRef(null);
  if (!cursorStoreRef.current) cursorStoreRef.current = createCursorStore();
  const autoReadRef = useRef(!!autoRead);
  autoReadRef.current = !!autoRead;
  const autoChunkerRef = useRef(null); // splits a streaming reply into sentences for auto-read
  const jumpSeqRef = useRef(0);
  const readingRef = useRef(null); // token of the text being read aloud
  const pendingReadIdsRef = useRef(new Set()); // sent for synthesis, not yet done
  const readQueueRef = useRef([]); // sentences not yet sent
  const pumpReadQueueRef = useRef(null);
  const stopSpeechRef = useRef(null);
  const sentenceByIdRef = useRef(new Map()); // id -> { text, retried }
  const audioSeenRef = useRef(new Set()); // ids that actually produced sound
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
  const callbacksRef = useRef({ onTranscript, onStopGeneration, onError, captureHeldFrame });
  callbacksRef.current = { onTranscript, onStopGeneration, onError, captureHeldFrame };

  // tts-supported is provider-aware (kokoro: Apple Silicon + uv; openai: API
  // key) — re-check when the window regains focus so Settings changes apply.
  useEffect(() => {
    const check = () =>
      window.electron?.tts
        ?.isSupported()
        .then((ok) => setSupported(!!ok))
        .catch(() => setSupported(false));
    check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
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

  // Speaking rate lives in Settings; re-read on focus so a change there
  // applies without restarting the app.
  useEffect(() => {
    const load = () =>
      window.electron
        ?.getSettings?.()
        .then((s) => {
          const next = Math.min(4, Math.max(0.25, Number(s?.ttsSpeed) || DEFAULT_SPEED));
          speedRef.current = next;
          setSpeedState(next);
        })
        .catch(() => {});
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);

  const setSpeed = useCallback((value) => {
    const next = Math.min(4, Math.max(0.25, Number(value) || DEFAULT_SPEED));
    speedRef.current = next;
    setSpeedState(next);
    window.electron
      ?.getSettings?.()
      .then((s) => window.electron.saveSettings({ ...s, ttsSpeed: next }))
      .catch(() => {});
  }, []);

  // Preload the Kokoro model without starting a voice session
  const loadTts = useCallback(() => {
    (window.electron.tts.loadKokoro || window.electron.tts.start)().catch(() => {});
  }, []);

  // Kill the sidecar to free RAM (no-op while a voice session is running)
  const unloadTts = useCallback(() => {
    if (activeRef.current) return;
    window.electron.tts.stop().catch(() => {});
  }, []);

  // One player for everything that makes sound: agent replies and read-aloud.
  const ensurePlayer = useCallback(() => {
    if (!playerRef.current) {
      playerRef.current = new TtsPlayer({
        onSpeakingChange: (speaking) => {
          speakingRef.current = speaking;
          if (!speaking) finishReadIfDoneRef.current?.();
          setAgentState(deriveStateRef.current?.() ?? 'idle');
        },
        onPausedChange: (paused) => {
          setSpeechPaused(paused);
          if (readingRef.current) {
            setPlayback({ token: readingRef.current, state: paused ? 'paused' : 'speaking' });
          }
        },
      });
    }
    return playerRef.current;
  }, []);

  // Assigned below; used by the player callback created above.
  const deriveStateRef = useRef(null);
  const finishReadIfDoneRef = useRef(null);
  const endReadSessionRef = useRef(null);
  const tickCursorRef = useRef(null);

  const deriveState = useCallback(() => {
    if (!activeRef.current) return 'idle';
    if (errorRef.current) return 'error';
    // Segments still transcribing in the background are not worth showing —
    // while the floor is held the only thing happening is that you're talking.
    if (holdingRef.current) return 'holding';
    if (speakingRef.current) return 'speaking';
    if (transcribingRef.current) return 'transcribing';
    if (!ttsReadyRef.current && !mutedRef.current) return 'starting';
    if (loadingRef.current) return 'thinking';
    return 'listening';
  }, [loadingRef]);

  deriveStateRef.current = deriveState;

  const refreshState = useCallback(() => {
    setAgentState(deriveState());
  }, [deriveState]);

  // `thinking` depends on loadingRef which doesn't trigger renders here — poll
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(refreshState, 300);
    return () => clearInterval(timer);
  }, [active, refreshState]);

  // Audio arrives for agent replies and for read-aloud alike, so this listener
  // outlives any single session.
  useEffect(() => {
    const offChunk = window.electron?.tts?.onAudioChunk?.(({ id, sr, chunk }) => {
      if (id < discardBelowRef.current) return;
      if (!activeRef.current && !readingRef.current) return;
      audioSeenRef.current.add(id);
      ensurePlayer().enqueue(chunk, sr, id);
    });
    // Word timestamps arrive just before the audio they describe (Kokoro)
    const offWords = window.electron?.tts?.onWords?.(({ id, offset, words }) => {
      const info = segmentInfoRef.current.get(id);
      if (!info) return;
      const base = Number(offset) || 0;
      for (const entry of words || []) {
        if (!Array.isArray(entry)) continue;
        info.tokens.push({ text: entry[0], start: Number(entry[1]) + base, end: Number(entry[2]) + base });
      }
      info.timings = null;
    });
    const offDone = window.electron?.tts?.onSpeakDone?.(({ id }) => {
      playerRef.current?.markDone(id);
      if (!pendingReadIdsRef.current.delete(id)) return;
      const entry = sentenceByIdRef.current.get(id);
      sentenceByIdRef.current.delete(id);
      const madeSound = audioSeenRef.current.delete(id);
      // A synthesis that was cancelled part-way still reports done, just with
      // no audio behind it. Without this the sentence would be silently
      // skipped while the rest of the message carried on.
      if (!madeSound && entry && !entry.retried && readingRef.current) {
        readQueueRef.current.unshift({ text: entry.text, index: entry.index, retried: true });
      }
      pumpReadQueueRef.current?.();
      finishReadIfDoneRef.current?.();
    });
    // A sentence the engine could not synthesise reports an error instead of
    // done. Treat it like a cancelled one: retry once, then move on, so a
    // read never wedges behind it.
    const offError = window.electron?.tts?.onError?.(({ id, message }) => {
      if (id == null || !pendingReadIdsRef.current.delete(id)) return;
      console.warn('[VoiceAgent] Sentence failed to synthesise:', message);
      const entry = sentenceByIdRef.current.get(id);
      sentenceByIdRef.current.delete(id);
      audioSeenRef.current.delete(id);
      if (entry && !entry.retried && readingRef.current) {
        readQueueRef.current.unshift({ text: entry.text, index: entry.index, retried: true });
      }
      pumpReadQueueRef.current?.();
      finishReadIfDoneRef.current?.();
    });
    // The engine went away mid-read (crashed, unloaded, failed to load): no
    // 'done' is coming, so end the read instead of leaving its bar up
    const offStatus = window.electron?.tts?.onStatus?.((status) => {
      if (!readingRef.current) return;
      if (['stopped', 'error', 'unsupported'].includes(status?.state)) {
        console.warn('[VoiceAgent] Speech engine', status.state, 'during read-aloud:', status.message || '');
        stopSpeechRef.current?.();
      }
    });
    return () => {
      offChunk?.();
      offWords?.();
      offDone?.();
      offError?.();
      offStatus?.();
    };
  }, [ensurePlayer]);

  // A read is over once every sentence has been synthesised and the queue has
  // drained. Both conditions are needed: the player falls silent between
  // sentences while the next one is still being generated.
  const finishReadIfDone = useCallback(() => {
    if (!readingRef.current) return;
    if (readQueueRef.current.length > 0) return;
    if (pendingReadIdsRef.current.size > 0) return;
    if (playerRef.current?.isSpeaking) return;
    // A reply still streaming in has more sentences on the way
    if (readSessionRef.current?.streaming || readSessionRef.current?.starting) return;
    readingRef.current = null;
    endReadSessionRef.current?.();
    setPlayback({ token: null, state: 'idle' });
  }, []);
  finishReadIfDoneRef.current = finishReadIfDone;

  // --- Follow-along cursor ---------------------------------------------------
  // Polls the player for the sentence and word being sounded and publishes
  // { token, index, total, sentences, wordStart, wordEnd, streaming, secondsLeft }.

  const stopCursorLoop = useCallback(() => {
    if (cursorTimerRef.current) {
      clearInterval(cursorTimerRef.current);
      cursorTimerRef.current = null;
    }
  }, []);

  const endReadSession = useCallback(() => {
    stopCursorLoop();
    readSessionRef.current = null;
    segmentInfoRef.current.clear();
    autoChunkerRef.current = null;
    if (cursorRef.current) {
      cursorRef.current = null;
      cursorStoreRef.current.set(null);
    }
  }, [stopCursorLoop]);
  endReadSessionRef.current = endReadSession;

  const beginReadSession = useCallback(
    (session) => {
      stopCursorLoop();
      segmentInfoRef.current.clear();
      cursorRef.current = null;
      cursorStoreRef.current.set(null);
      readSessionRef.current = { token: null, getToken: null, streaming: false, starting: false, ...session };
      cursorTimerRef.current = setInterval(() => tickCursorRef.current?.(), 50);
    },
    [stopCursorLoop]
  );

  // Audio still scheduled, plus an estimate for sentences not yet synthesised
  const secondsLeft = useCallback((session) => {
    const player = playerRef.current;
    let left = player?.remaining() || 0;
    for (const item of readQueueRef.current) left += estimateDuration(item.text, speedRef.current);
    for (const id of pendingReadIdsRef.current) {
      const info = segmentInfoRef.current.get(id);
      if (info && !player?.segments.has(id) && session.sentences[info.index] != null) {
        left += estimateDuration(session.sentences[info.index], speedRef.current);
      }
    }
    return left;
  }, []);

  const tickCursor = useCallback(() => {
    const session = readSessionRef.current;
    const player = playerRef.current;
    if (!session || !player) return;
    const pos = player.position();
    const prev = cursorRef.current;
    let next = prev;
    if (pos) {
      const info = segmentInfoRef.current.get(pos.id);
      const sentence = info ? session.sentences[info.index] : null;
      if (info && sentence != null) {
        if (!info.words) info.words = splitWords(sentence);
        // Until every chunk has arrived the sentence may be longer than what
        // has been heard so far
        const duration = pos.complete
          ? pos.duration
          : Math.max(pos.duration, estimateDuration(sentence, speedRef.current));
        const timingKey = `${info.tokens.length}:${duration.toFixed(2)}`;
        if (!info.timings || info.timingKey !== timingKey) {
          info.timings = wordTimings(sentence, info.words, info.tokens, duration);
          info.timingKey = timingKey;
        }
        const wordIndex = pos.ended ? -1 : wordIndexAt(info.timings, pos.offset);
        const word = wordIndex >= 0 ? info.words[wordIndex] : null;
        next = {
          token: session.token ?? (session.getToken ? session.getToken() : null),
          index: info.index,
          total: session.sentences.length,
          sentences: session.sentences,
          wordStart: word ? word.start : -1,
          wordEnd: word ? word.end : -1,
          streaming: !!session.streaming,
          secondsLeft: Math.round(secondsLeft(session)),
        };
      }
    }
    if (!next) return;
    if (
      prev &&
      prev.token === next.token &&
      prev.index === next.index &&
      prev.wordStart === next.wordStart &&
      prev.total === next.total &&
      prev.streaming === next.streaming &&
      prev.secondsLeft === next.secondsLeft
    ) {
      return;
    }
    cursorRef.current = next;
    cursorStoreRef.current.set(next);
  }, [secondsLeft]);
  tickCursorRef.current = tickCursor;

  // Each sentence reads the speed at the moment it is sent, so changing it
  // mid-read takes effect on the next one out of the queue rather than after
  // a stop and restart.
  const pumpReadQueue = useCallback(() => {
    if (!readingRef.current) return;
    if (readSessionRef.current?.starting) return; // engine not up yet
    while (readQueueRef.current.length && pendingReadIdsRef.current.size < READ_LOOKAHEAD) {
      const item = readQueueRef.current.shift();
      const id = ++speakSeqRef.current;
      pendingReadIdsRef.current.add(id);
      sentenceByIdRef.current.set(id, item);
      if (item.index != null) segmentInfoRef.current.set(id, { index: item.index, tokens: [] });
      const abandon = () => {
        // No 'done' is coming for this one, so release its slot by hand
        // rather than leaving the queue wedged behind it.
        if (!pendingReadIdsRef.current.delete(id)) return;
        sentenceByIdRef.current.delete(id);
        audioSeenRef.current.delete(id);
        pumpReadQueueRef.current?.();
        finishReadIfDoneRef.current?.();
      };
      window.electron.tts
        .speak({ id, text: item.text, voice: DEFAULT_VOICE, speed: speedRef.current })
        .then((accepted) => {
          if (accepted === false) abandon();
        })
        .catch(abandon);
    }
  }, []);
  pumpReadQueueRef.current = pumpReadQueue;

  const bargeIn = useCallback(() => {
    // Reading a message aloud was asked for deliberately. If the mic opens
    // mid-read, end the read cleanly — cancelling underneath it would drop
    // whichever sentence was being synthesised and carry on as if it had been
    // spoken, which is how sentences went missing.
    if (readingRef.current) {
      stopSpeechRef.current?.();
      return;
    }
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
      // Whether this segment belongs to a held turn is decided now, at the end
      // of the segment — not after transcription, by which time the floor may
      // already have been released.
      const bank = holdingRef.current;
      if (bank) {
        pendingHoldRef.current += 1;
        // Utterance boundary: what's on screen right now is what this phrase
        // was about. Grab it before transcription, which takes a moment.
        const shot = callbacksRef.current.captureHeldFrame?.();
        if (shot) {
          frameBankRef.current?.add({ ...shot, at: (Date.now() - holdStartRef.current) / 1000 });
        }
      }
      transcribingRef.current = true;
      refreshState();
      try {
        // 16kHz mono int16 WAV (format 1 = PCM); provider + model come from Settings
        const wav = utils.encodeWAV(audio, 1, 16000, 1, 16);
        const result = await window.electron.speechToText.transcribe(
          Array.from(new Uint8Array(wav)),
          { format: 'wav', response_format: 'verbose_json' }
        );
        const text = result?.text?.trim();
        if (text && activeRef.current && bank) {
          // Holding the floor: bank this segment and keep listening. Silence
          // between segments is dropped, which is what we want in the prompt.
          heldPartsRef.current.push(text);
          setHeldText(heldPartsRef.current.join(' '));
        } else if (text && activeRef.current) {
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
        if (bank) pendingHoldRef.current = Math.max(0, pendingHoldRef.current - 1);
        transcribingRef.current = false;
        refreshState();
      }
    },
    [refreshState, waitForIdle]
  );

  const stop = useCallback(async () => {
    activeRef.current = false;
    setActive(false);
    micMutedRef.current = false;
    setMicMuted(false);
    holdingRef.current = false;
    setHolding(false);
    heldPartsRef.current = [];
    pendingHoldRef.current = 0;
    frameBankRef.current = null;
    setHeldText('');
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
    setSpeechPaused(false);
    window.electron.tts?.cancel().catch(() => {});
    readingRef.current = null;
    pendingReadIdsRef.current.clear();
    sentenceByIdRef.current.clear();
    audioSeenRef.current.clear();
    readQueueRef.current = [];
    endReadSessionRef.current?.();
    setPlayback({ token: null, state: 'idle' });
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

      // Local STT: warm the mlx-whisper sidecar so the first utterance
      // doesn't pay the model-load (or download) cost.
      window.electron
        .getSettings?.()
        .then((settings) => {
          if (settings?.sttProvider === 'local') {
            window.electron.sttLocal?.start().catch(() => {});
          }
        })
        .catch(() => {});

      chunkerRef.current = new SentenceChunker();
      ensurePlayer().ensureContext(); // inside the button-click gesture

      unsubsRef.current.push(
        window.electron.tts.onStatus((status) => {
          setTtsStatus(status);
          ttsReadyRef.current = status.state === 'ready';
          if (status.state === 'error') {
            errorRef.current = true;
            callbacksRef.current.onError?.(status.message || 'Text-to-speech failed to start');
          }
          refreshState();
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
  }, [bargeIn, ensurePlayer, handleSpeechEnd, refreshState, stop]);

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
      .speak({ id, text, voice: DEFAULT_VOICE, speed: speedRef.current })
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
      if (readingRef.current) stopSpeechRef.current?.();
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

  // Mic mute: pause/resume the VAD so the agent stops/starts hearing you.
  const toggleMicMute = useCallback(() => {
    const next = !micMutedRef.current;
    micMutedRef.current = next;
    setMicMuted(next);
    // A held turn survives the mic going quiet: the banked text is only sent
    // when the floor is released, never as a side effect of muting.
    if (next) vadRef.current?.pause();
    else vadRef.current?.start();
    refreshState();
  }, [refreshState]);

  // Hold the floor: while on, silence never ends your turn — everything you
  // say is banked and sent as a single message when you release it. Lets you
  // stop mid-thought without the agent jumping in.
  const toggleHold = useCallback(() => {
    const next = !holdingRef.current;
    holdingRef.current = next;
    setHolding(next);
    if (next) {
      heldPartsRef.current = [];
      pendingHoldRef.current = 0;
      setHeldText('');
      holdStartRef.current = Date.now();
      // One slot of the budget is reserved for the send-time frame; a budget
      // of one means "only that frame", so nothing is banked at all.
      const bankBudget = (frameBudgetRef?.current ?? 5) - 1;
      frameBankRef.current = bankBudget >= 1 ? new FrameBank({ budget: bankBudget }) : null;
      // Taking the floor also takes it back from the agent mid-sentence
      bargeIn();
      // Holding implies listening; un-mute the mic so the button can't lie
      if (micMutedRef.current) {
        micMutedRef.current = false;
        setMicMuted(false);
        vadRef.current?.start();
      }
    } else {
      (async () => {
        // Let the last segment finish transcribing so it goes out with the rest
        const deadline = Date.now() + 15000;
        while (pendingHoldRef.current > 0 && activeRef.current && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const text = heldPartsRef.current.join(' ').trim();
        const frames = frameBankRef.current?.take() || [];
        const heldMs = Date.now() - holdStartRef.current;
        heldPartsRef.current = [];
        pendingHoldRef.current = 0;
        frameBankRef.current = null;
        setHeldText('');
        if (!text || !activeRef.current) return;
        const idle = await waitForIdle(4000);
        if (idle && activeRef.current) callbacksRef.current.onTranscript?.(text, { frames, heldMs });
        else console.warn('[VoiceAgent] Chat still busy, dropping held utterance:', text);
      })();
    }
    refreshState();
  }, [bargeIn, refreshState, waitForIdle]);

  // Stop any speech, whether an agent reply or a read-aloud.
  const stopSpeech = useCallback(() => {
    discardBelowRef.current = speakSeqRef.current + 1;
    pendingReadIdsRef.current.clear();
    sentenceByIdRef.current.clear();
    audioSeenRef.current.clear();
    readQueueRef.current = [];
    readingRef.current = null;
    chunkerRef.current?.reset();
    endReadSessionRef.current?.();
    playerRef.current?.stopAll();
    setPlayback({ token: null, state: 'idle' });
    return window.electron.tts?.cancel().catch(() => {}) ?? Promise.resolve();
  }, []);
  stopSpeechRef.current = stopSpeech;

  // Read arbitrary text aloud: a finished reply, or a selection inside one.
  // Works with no voice session running; the engine is started on demand.
  const readAloud = useCallback(
    async (text, token = 'selection') => {
      const sentences = sentencesForSpeech(text);
      if (!sentences.length) return;
      // Await the cancel: the engine drops queued work when it lands, so new
      // sentences must not be in flight while it is still on its way.
      await stopSpeech();
      readingRef.current = token;
      setPlayback({ token, state: 'speaking' });
      const player = ensurePlayer();
      player.ensureContext(); // still inside the click gesture
      try {
        const started = await window.electron.tts.start();
        if (started && started.ok === false) throw new Error(started.error || 'Text-to-speech failed to start');
      } catch (error) {
        readingRef.current = null;
        setPlayback({ token: null, state: 'idle' });
        callbacksRef.current.onError?.(error.message || 'Text-to-speech failed to start');
        return;
      }
      if (readingRef.current !== token) return; // superseded while starting
      beginReadSession({ token, sentences });
      readQueueRef.current = sentences.map((text, index) => ({ text, index, retried: false }));
      pumpReadQueue();
    },
    [beginReadSession, ensurePlayer, pumpReadQueue, stopSpeech]
  );

  // Continue the current read from another sentence (click-to-jump, skip).
  const jumpTo = useCallback(
    async (token, index) => {
      const session = readSessionRef.current;
      if (!session || resolveToken(readingRef.current) !== token) return;
      const total = session.sentences.length;
      if (!total) return;
      const target = Math.max(0, Math.min(total - 1, Math.round(index)));
      const myJump = ++jumpSeqRef.current;
      // Drop what is in flight but keep the session. The queue is refilled
      // before the player stops, so the read does not count as finished.
      discardBelowRef.current = speakSeqRef.current + 1;
      pendingReadIdsRef.current.clear();
      sentenceByIdRef.current.clear();
      audioSeenRef.current.clear();
      segmentInfoRef.current.clear();
      readQueueRef.current = session.sentences
        .slice(target)
        .map((text, i) => ({ text, index: target + i, retried: false }));
      playerRef.current?.stopAll();
      cursorRef.current = {
        token,
        index: target,
        total,
        sentences: session.sentences,
        wordStart: -1,
        wordEnd: -1,
        streaming: !!session.streaming,
        secondsLeft: cursorRef.current?.secondsLeft ?? 0,
      };
      cursorStoreRef.current.set(cursorRef.current);
      setPlayback({ token: readingRef.current, state: 'speaking' });
      // Await the cancel so the new sentences queue behind it in the engine
      await (window.electron.tts?.cancel().catch(() => {}) ?? Promise.resolve());
      if (jumpSeqRef.current !== myJump || readSessionRef.current !== session) return;
      pumpReadQueue();
    },
    [pumpReadQueue]
  );

  const skipSentence = useCallback(
    (delta) => {
      const cursor = cursorRef.current;
      if (!cursor || !readSessionRef.current) return;
      jumpTo(cursor.token, cursor.index + delta);
    },
    [jumpTo]
  );

  // Auto-read: a reply is spoken as it streams in, no voice session needed.
  // Called when the assistant placeholder is added; `getToken` resolves to its
  // message index once it has rendered.
  const onAssistantTurnStart = useCallback(
    (getToken) => {
      if (activeRef.current || !autoReadRef.current) return;
      // Whatever was playing stops now, and the new session opens at once so
      // the first deltas are not lost while the engine starts.
      const cancelled = stopSpeech();
      readingRef.current = getToken;
      setPlayback({ token: getToken, state: 'speaking' });
      autoChunkerRef.current = new SentenceChunker();
      beginReadSession({ getToken, sentences: [], streaming: true, starting: true });
      const session = readSessionRef.current;
      ensurePlayer().ensureContext();
      (async () => {
        await cancelled;
        try {
          const started = await window.electron.tts.start();
          if (started && started.ok === false) throw new Error(started.error || 'Text-to-speech failed to start');
        } catch (error) {
          if (readSessionRef.current === session) stopSpeechRef.current?.();
          callbacksRef.current.onError?.(error.message || 'Text-to-speech failed to start');
          return;
        }
        if (readSessionRef.current !== session) return;
        session.starting = false;
        pumpReadQueue();
        finishReadIfDoneRef.current?.();
      })();
    },
    [beginReadSession, ensurePlayer, pumpReadQueue, stopSpeech]
  );

  // Keyboard while something is being read: arrows skip a sentence, space
  // pauses. Ignored while typing.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (!readSessionRef.current) return;
      const target = event.target;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        skipSentence(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        skipSentence(-1);
      } else if (event.key === ' ') {
        event.preventDefault();
        const player = playerRef.current;
        if (player?.isPaused) player.resume();
        else player?.pause();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [skipSentence]);

  const pauseSpeech = useCallback(() => ensurePlayer().pause(), [ensurePlayer]);
  const resumeSpeech = useCallback(() => ensurePlayer().resume(), [ensurePlayer]);

  // Called with every streamed content delta from the assistant
  const feedAssistantDelta = useCallback(
    (delta) => {
      if (!delta) return;
      if (activeRef.current) {
        chunkerRef.current?.feed(delta).forEach(speakSentence);
        return;
      }
      const session = readSessionRef.current;
      if (!session?.streaming || !autoChunkerRef.current) return;
      for (const text of autoChunkerRef.current.feed(delta)) {
        readQueueRef.current.push({ text, index: session.sentences.length, retried: false });
        session.sentences.push(text);
      }
      pumpReadQueue();
    },
    [pumpReadQueue, speakSentence]
  );

  // Called when an assistant turn completes (speaks the trailing partial sentence)
  const flushAssistantTurn = useCallback(() => {
    if (activeRef.current) {
      const rest = chunkerRef.current?.flush();
      if (rest) speakSentence(rest);
      return;
    }
    const session = readSessionRef.current;
    if (!session?.streaming) return;
    const rest = autoChunkerRef.current?.flush();
    if (rest) {
      readQueueRef.current.push({ text: rest, index: session.sentences.length, retried: false });
      session.sentences.push(rest);
    }
    session.streaming = false;
    if (!session.sentences.length) {
      stopSpeechRef.current?.();
      return;
    }
    pumpReadQueue();
    finishReadIfDoneRef.current?.();
  }, [pumpReadQueue, speakSentence]);

  // Called on stream error/cancel — drop any un-spoken text
  const cancelSpeech = useCallback(() => {
    if (readingRef.current) {
      stopSpeechRef.current?.();
      return;
    }
    discardBelowRef.current = speakSeqRef.current + 1;
    chunkerRef.current?.reset();
    playerRef.current?.stopAll();
    window.electron.tts?.cancel().catch(() => {});
  }, []);

  // Cleanup on unmount (incl. HMR)
  useEffect(() => {
    return () => {
      if (activeRef.current) stop();
      endReadSessionRef.current?.();
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
    micMuted,
    toggleMicMute,
    holding,
    toggleHold,
    heldText,
    playback,
    speechPaused,
    readAloud,
    pauseSpeech,
    resumeSpeech,
    stopSpeech,
    readCursorStore: cursorStoreRef.current,
    jumpTo,
    skipSentence,
    onAssistantTurnStart,
    speed,
    setSpeed,
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
