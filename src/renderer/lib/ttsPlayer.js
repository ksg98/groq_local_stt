// Gapless playback queue for streamed PCM (little-endian int16) chunks.
// Chunks are scheduled back-to-back on a single AudioContext.

export class TtsPlayer {
  constructor({ sampleRate = 24000, onSpeakingChange, onPausedChange } = {}) {
    this.sampleRate = sampleRate;
    this.onSpeakingChange = onSpeakingChange;
    this.onPausedChange = onPausedChange;
    this.ctx = null;
    this.cursor = 0;
    this.sources = new Set();
    this.paused = false;
  }

  ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: this.sampleRate });
    }
    // While paused the context is suspended on purpose — a chunk arriving mid
    // pause must not restart playback. It still schedules correctly, because
    // currentTime is frozen for as long as the context stays suspended.
    if (this.ctx.state === 'suspended' && !this.paused) {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  get isSpeaking() {
    return this.sources.size > 0;
  }

  get isPaused() {
    return this.paused;
  }

  pause() {
    if (!this.ctx || this.paused || this.sources.size === 0) return false;
    this.paused = true;
    this.ctx.suspend().catch(() => {});
    this.onPausedChange?.(true);
    return true;
  }

  resume() {
    if (!this.ctx || !this.paused) return false;
    this.paused = false;
    this.ctx.resume().catch(() => {});
    this.onPausedChange?.(false);
    return true;
  }

  // chunk: Uint8Array of int16 LE PCM; sr: its sample rate
  enqueue(chunk, sr) {
    if (!chunk || chunk.byteLength < 2) return;
    const ctx = this.ensureContext();

    let bytes = chunk;
    if (bytes.byteOffset % 2 !== 0) {
      bytes = new Uint8Array(bytes); // realign copy
    }
    const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    const buffer = ctx.createBuffer(1, float32.length, sr || this.sampleRate);
    buffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime + 0.05, this.cursor);
    source.start(startAt);
    this.cursor = startAt + buffer.duration;

    const wasSilent = this.sources.size === 0;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) {
        this.cursor = 0;
        this.onSpeakingChange?.(false);
      }
    };
    if (wasSilent) this.onSpeakingChange?.(true);
  }

  stopAll() {
    const wasSpeaking = this.sources.size > 0;
    for (const source of this.sources) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.cursor = 0;
    // Leave the context running, or the next thing to speak would be stuck
    // behind a suspension nobody is going to lift.
    if (this.paused) {
      this.paused = false;
      this.ctx?.resume().catch(() => {});
      this.onPausedChange?.(false);
    }
    if (wasSpeaking) this.onSpeakingChange?.(false);
  }

  async close() {
    this.stopAll();
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* ignore */
      }
      this.ctx = null;
    }
  }
}
