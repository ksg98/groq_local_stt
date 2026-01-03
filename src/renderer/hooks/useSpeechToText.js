import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * Custom hook for speech-to-text functionality using Groq's Whisper API
 *
 * Features:
 * - Recording with MediaRecorder API
 * - Timer display
 * - Push-to-talk support (space bar)
 * - Automatic transcription via Groq API
 */
export function useSpeechToText({ onTranscription, onError }) {
  const [isRecording, setIsRecording] = useState(false);
  const [isPushToTalk, setIsPushToTalk] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [error, setError] = useState(null);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const startTimeRef = useRef(null);
  const isCancelledRef = useRef(false);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopRecording();
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  // Start the recording timer
  const startTimer = useCallback(() => {
    startTimeRef.current = Date.now();
    setRecordingDuration(0);

    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      setRecordingDuration(elapsed);
    }, 100);
  }, []);

  // Stop the recording timer
  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Get the best supported MIME type for recording
  const getSupportedMimeType = useCallback(() => {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
      'audio/mpeg',
    ];

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        console.log('[SpeechToText] Using MIME type:', type);
        return type;
      }
    }

    console.warn('[SpeechToText] No preferred MIME type supported, using default');
    return '';
  }, []);

  // Request microphone permission and start recording
  const startRecording = useCallback(async (pushToTalk = false) => {
    try {
      setError(null);
      setIsPushToTalk(pushToTalk);
      isCancelledRef.current = false; // Reset cancel flag

      // Request microphone access with high quality settings
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1,
        },
      });

      streamRef.current = stream;
      audioChunksRef.current = [];

      // Get the best supported MIME type
      const mimeType = getSupportedMimeType();

      // Create MediaRecorder with optimal settings
      const mediaRecorderOptions = mimeType ? { mimeType } : {};
      const mediaRecorder = new MediaRecorder(stream, mediaRecorderOptions);

      console.log('[SpeechToText] MediaRecorder created with:', {
        mimeType: mediaRecorder.mimeType,
        state: mediaRecorder.state,
      });

      mediaRecorder.ondataavailable = (event) => {
        console.log('[SpeechToText] Data available:', event.data.size, 'bytes');
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        console.log('[SpeechToText] Recording stopped, chunks:', audioChunksRef.current.length, 'cancelled:', isCancelledRef.current);

        // Stop all tracks
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }

        // Skip processing if cancelled
        if (isCancelledRef.current) {
          console.log('[SpeechToText] Recording was cancelled, skipping processing');
          setRecordingDuration(0);
          audioChunksRef.current = [];
          return;
        }

        // Process the recorded audio if we have chunks
        if (audioChunksRef.current.length > 0) {
          const totalSize = audioChunksRef.current.reduce((acc, chunk) => acc + chunk.size, 0);
          console.log('[SpeechToText] Total audio size:', totalSize, 'bytes');

          // Need at least 5KB of audio data for meaningful transcription
          if (totalSize < 5000) {
            console.log('[SpeechToText] Recording too short, skipping transcription');
            setRecordingDuration(0);
            return;
          }

          const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType || 'audio/webm' });
          await processAudio(audioBlob);
        }
      };

      mediaRecorderRef.current = mediaRecorder;
      // Start recording and collect data every 250ms for better chunks
      mediaRecorder.start(250);

      setIsRecording(true);
      startTimer();

      console.log('[SpeechToText] Recording started', pushToTalk ? '(push-to-talk)' : '');
    } catch (err) {
      console.error('[SpeechToText] Error starting recording:', err);

      let errorMessage = 'Failed to access microphone';
      if (err.name === 'NotAllowedError') {
        errorMessage = 'Microphone access denied. Please allow microphone access in your browser settings.';
      } else if (err.name === 'NotFoundError') {
        errorMessage = 'No microphone found. Please connect a microphone and try again.';
      }

      setError(errorMessage);
      onError?.(errorMessage);
    }
  }, [startTimer, onError, getSupportedMimeType]);

  // Stop recording and process audio
  const stopRecording = useCallback(() => {
    stopTimer();
    setIsRecording(false);
    setIsPushToTalk(false);

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      console.log('[SpeechToText] Recording stopped');
    }
  }, [stopTimer]);

  // Cancel recording without processing
  const cancelRecording = useCallback(() => {
    console.log('[SpeechToText] Cancelling recording...');

    // Set cancelled flag FIRST so onstop handler will skip processing
    isCancelledRef.current = true;

    stopTimer();
    setIsRecording(false);
    setIsPushToTalk(false);

    // Stop the stream first to prevent more data
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    // Then stop the media recorder - onstop will check cancelled flag
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    setRecordingDuration(0);
    console.log('[SpeechToText] Recording cancelled');
  }, [stopTimer]);

  // Process recorded audio through Groq API
  const processAudio = useCallback(async (audioBlob) => {
    try {
      setIsTranscribing(true);
      setError(null);

      // Convert blob to array buffer, then to regular array for IPC
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioData = Array.from(new Uint8Array(arrayBuffer));

      console.log('[SpeechToText] Sending audio for transcription, size:', audioData.length);

      // Send to main process for transcription
      const result = await window.electron.speechToText.transcribe(audioData, {
        model: 'whisper-large-v3-turbo',
        response_format: 'verbose_json',
      });

      console.log('[SpeechToText] Transcription result:', result);

      if (result.text && result.text.trim()) {
        onTranscription?.(result.text.trim());
      } else {
        console.log('[SpeechToText] No speech detected');
      }
    } catch (err) {
      console.error('[SpeechToText] Transcription error:', err);
      const errorMessage = err.message || 'Failed to transcribe audio';
      setError(errorMessage);
      onError?.(errorMessage);
    } finally {
      setIsTranscribing(false);
      setRecordingDuration(0);
    }
  }, [onTranscription, onError]);

  // Toggle recording on/off
  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording(false);
    }
  }, [isRecording, startRecording, stopRecording]);

  // Format duration for display (MM:SS)
  const formatDuration = useCallback((seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }, []);

  return {
    isRecording,
    isPushToTalk,
    isTranscribing,
    recordingDuration,
    formattedDuration: formatDuration(recordingDuration),
    error,
    startRecording,
    stopRecording,
    cancelRecording,
    toggleRecording,
  };
}

/**
 * Hook for handling push-to-talk with space bar
 * Hold space to record, release to stop and transcribe
 */
export function usePushToTalk({ onStart, onStop, enabled = true, minDuration = 300 }) {
  const isHoldingRef = useRef(false);
  const startTimeRef = useRef(null);
  const textareaFocusedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event) => {
      // Only trigger on space bar
      if (event.code !== 'Space') return;

      // Don't trigger if already holding
      if (isHoldingRef.current) return;

      // Check if we're in a text input
      const activeElement = document.activeElement;
      const isInTextInput = activeElement && (
        activeElement.tagName === 'INPUT' ||
        activeElement.tagName === 'TEXTAREA' ||
        activeElement.isContentEditable
      );

      // Store whether we're in a text input
      textareaFocusedRef.current = isInTextInput;

      // If we're in a text input, only trigger with long press behavior
      // The user needs to hold space for a moment before it triggers
      if (isInTextInput) {
        // Let the normal space behavior happen first
        // We'll check on keyup if it was held long enough
        startTimeRef.current = Date.now();
        return;
      }

      // Not in text input - trigger immediately
      event.preventDefault();
      isHoldingRef.current = true;
      startTimeRef.current = Date.now();
      onStart?.();
    };

    const handleKeyUp = (event) => {
      if (event.code !== 'Space') return;

      const holdDuration = startTimeRef.current ? Date.now() - startTimeRef.current : 0;

      // If we were in a text input and held long enough, this was a push-to-talk
      if (textareaFocusedRef.current && holdDuration >= minDuration && isHoldingRef.current) {
        event.preventDefault();
        onStop?.();
      }
      // If we weren't in text input and were holding
      else if (!textareaFocusedRef.current && isHoldingRef.current) {
        // Only process if held long enough
        if (holdDuration >= minDuration) {
          onStop?.();
        } else {
          // Too short, cancel
          onStop?.(true); // Pass true to indicate cancel
        }
      }

      isHoldingRef.current = false;
      startTimeRef.current = null;
      textareaFocusedRef.current = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [enabled, onStart, onStop, minDuration]);
}

export default useSpeechToText;
