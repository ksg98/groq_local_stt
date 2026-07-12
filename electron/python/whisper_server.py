#!/usr/bin/env python3
"""Local Whisper STT sidecar (mlx-whisper, Apple Silicon).

NDJSON protocol over stdio:
  stdin : {"cmd":"transcribe","id":1,"b64":"<16kHz mono WAV>","language":"en"}
          {"cmd":"shutdown"}
  stdout: {"type":"status","state":"loading|ready|error|stopped",...}
          {"type":"result","id":1,"text":"...","language":"en","duration":1.2}
          {"type":"error","id":1,"message":"..."}

Run via: uv run --no-project --python 3.12 \
  --with "mlx-whisper==0.4.3" python whisper_server.py
"""

import base64
import io
import json
import os
import queue
import sys
import threading
import wave

# The NDJSON protocol owns fd 1. Libraries (huggingface_hub downloads, tqdm)
# print to stdout, which would corrupt it — keep a private dup of the real
# stdout and point fd 1 at stderr for everyone else, incl. child processes.
_protocol_fd = os.dup(1)
os.dup2(2, 1)
_protocol_out = os.fdopen(_protocol_fd, "w", buffering=1)
sys.stdout = sys.stderr

_out_lock = threading.Lock()


def emit(obj):
    with _out_lock:
        _protocol_out.write(json.dumps(obj) + "\n")
        _protocol_out.flush()


MODEL_ID = os.environ.get("WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
SAMPLE_RATE = 16000

emit({"type": "status", "state": "loading", "model": MODEL_ID})
try:
    import numpy as np
    import mlx_whisper

    # Warm up on a second of silence: triggers the HF download and MLX kernel
    # compilation, and mlx_whisper caches the loaded model for later calls —
    # so 'ready' means transcription is instant and the model sits in RAM.
    mlx_whisper.transcribe(
        np.zeros(SAMPLE_RATE, dtype=np.float32), path_or_hf_repo=MODEL_ID
    )
    emit({"type": "status", "state": "ready", "model": MODEL_ID})
except Exception as e:  # noqa: BLE001 - report anything to the host app
    emit({"type": "status", "state": "error", "message": f"{type(e).__name__}: {e}"})
    sys.exit(1)


def decode_wav(b64):
    """WAV bytes -> float32 mono 16kHz numpy array (no ffmpeg needed)."""
    with wave.open(io.BytesIO(base64.b64decode(b64)), "rb") as wav:
        channels = wav.getnchannels()
        width = wav.getsampwidth()
        rate = wav.getframerate()
        frames = wav.readframes(wav.getnframes())
    if width != 2:
        raise ValueError(f"expected 16-bit PCM WAV, got sample width {width}")
    audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != SAMPLE_RATE and audio.size:
        target = int(round(audio.size * SAMPLE_RATE / rate))
        audio = np.interp(
            np.linspace(0.0, audio.size - 1, target),
            np.arange(audio.size),
            audio,
        ).astype(np.float32)
    return audio


def transcribe(job):
    req_id = job.get("id")
    try:
        audio = decode_wav(job.get("b64") or "")
        kwargs = {"path_or_hf_repo": MODEL_ID}
        if job.get("language"):
            kwargs["language"] = job["language"]
        result = mlx_whisper.transcribe(audio, **kwargs)
        emit(
            {
                "type": "result",
                "id": req_id,
                "text": (result.get("text") or "").strip(),
                "language": result.get("language"),
                "duration": round(audio.size / SAMPLE_RATE, 2),
            }
        )
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "id": req_id, "message": f"{type(e).__name__}: {e}"})


jobs = queue.Queue()


def worker():
    while True:
        job = jobs.get()
        if job is None:
            return
        transcribe(job)


worker_thread = threading.Thread(target=worker, daemon=True)
worker_thread.start()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    cmd = msg.get("cmd")
    if cmd == "transcribe":
        jobs.put(msg)
    elif cmd == "shutdown":
        break

jobs.put(None)
worker_thread.join(timeout=120)
emit({"type": "status", "state": "stopped"})
