import { useCallback, useEffect, useRef, useState } from 'react';

// Screenshare/camera capture. While active, captureFrame() grabs the current
// frame as a JPEG data URL (max 1280px wide) to attach to outgoing messages.
export function useMediaCapture({ onError } = {}) {
  const [mode, setMode] = useState(null); // null | 'screen' | 'camera'
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sources, setSources] = useState([]);

  const streamRef = useRef(null);
  const videoRef = useRef(null);
  const modeRef = useRef(null);

  const ensureVideo = () => {
    if (!videoRef.current) {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      videoRef.current = video;
    }
    return videoRef.current;
  };

  const stopCapture = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    modeRef.current = null;
    setMode(null);
  }, []);

  const attachStream = useCallback(
    async (stream, newMode) => {
      streamRef.current = stream;
      const video = ensureVideo();
      video.srcObject = stream;
      await video.play();
      // user can end a share/camera via OS UI — reflect that in our state
      stream.getVideoTracks()[0]?.addEventListener('ended', stopCapture);
      modeRef.current = newMode;
      setMode(newMode);
    },
    [stopCapture]
  );

  const openScreenPicker = useCallback(async () => {
    try {
      const status = await window.electron.capture.getScreenAccessStatus();
      if (status === 'denied' || status === 'restricted') {
        window.electron.capture.openScreenSettings();
        throw new Error(
          'Screen Recording permission is blocked. Enable it in System Settings > Privacy & Security > Screen Recording.'
        );
      }
      const list = await window.electron.capture.getSources();
      setSources(list);
      setPickerOpen(true);
    } catch (error) {
      onError?.(error.message || 'Failed to list screens');
    }
  }, [onError]);

  const startScreenshare = useCallback(
    async (sourceId) => {
      setPickerOpen(false);
      try {
        stopCapture();
        const ok = await window.electron.capture.selectSource(sourceId);
        if (!ok) throw new Error('Selected source is no longer available');
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        await attachStream(stream, 'screen');
      } catch (error) {
        console.error('[Capture] Screenshare failed:', error);
        onError?.(error.message || 'Screen share failed');
      }
    },
    [attachStream, onError, stopCapture]
  );

  const startCamera = useCallback(async () => {
    try {
      stopCapture();
      const granted = await window.electron.capture.requestCameraPermission();
      if (!granted) {
        throw new Error(
          'Camera access is blocked. Enable it in System Settings > Privacy & Security > Camera.'
        );
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 } },
        audio: false,
      });
      await attachStream(stream, 'camera');
    } catch (error) {
      console.error('[Capture] Camera failed:', error);
      onError?.(error.message || 'Camera failed');
    }
  }, [attachStream, onError, stopCapture]);

  const toggleScreenshare = useCallback(() => {
    if (modeRef.current === 'screen') {
      stopCapture();
    } else {
      openScreenPicker();
    }
  }, [openScreenPicker, stopCapture]);

  const toggleCamera = useCallback(() => {
    if (modeRef.current === 'camera') {
      stopCapture();
    } else {
      startCamera();
    }
  }, [startCamera, stopCapture]);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    if (!modeRef.current || !video || video.readyState < 2) return null;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;
    const scale = Math.min(1, 1280 / width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  }, []);

  const getPreviewStream = useCallback(() => streamRef.current, []);

  useEffect(() => () => stopCapture(), [stopCapture]);

  return {
    mode,
    pickerOpen,
    sources,
    setPickerOpen,
    startScreenshare,
    toggleScreenshare,
    toggleCamera,
    stopCapture,
    captureFrame,
    getPreviewStream,
  };
}
