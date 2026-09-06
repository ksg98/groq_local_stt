// Screen frames for a voice turn: which ones to keep, and how old ones leave
// the history. Frames carry a tiny grayscale signature so near-duplicates can
// be spotted without decoding the JPEG.

export const SIG_SIZE = 24;
// Mean absolute pixel difference (0..1) below which two frames count as the
// same screen. Cursor blink, clocks and notification badges land well under it.
export const DUP_THRESHOLD = 0.04;

export function signatureDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / (a.length * 255);
}

// Frames banked while the floor is held. One is offered per utterance;
// duplicates of the previous keeper are dropped, and past the budget the
// least distinct interior frame goes, so survivors spread across the turn.
export class FrameBank {
  constructor({ budget = 4, threshold = DUP_THRESHOLD } = {}) {
    this.budget = Math.max(1, budget);
    this.threshold = threshold;
    this.frames = [];
  }

  add(frame) {
    if (!frame?.url || !frame.sig) return false;
    const last = this.frames[this.frames.length - 1];
    if (last && signatureDistance(last.sig, frame.sig) < this.threshold) return false;
    this.frames.push(frame);
    while (this.frames.length > this.budget) this.dropLeastDistinct();
    return true;
  }

  dropLeastDistinct() {
    if (this.frames.length <= 2) {
      this.frames.shift();
      return;
    }
    let worst = Infinity;
    let idx = 1;
    for (let i = 1; i < this.frames.length - 1; i += 1) {
      const d = signatureDistance(this.frames[i - 1].sig, this.frames[i].sig);
      if (d < worst) {
        worst = d;
        idx = i;
      }
    }
    this.frames.splice(idx, 1);
  }

  take() {
    const out = this.frames;
    this.frames = [];
    return out;
  }
}

// The frame grabbed at send time is what the user is most likely pointing at,
// so it is always kept. If it matches the last banked frame it replaces it
// (the send-time grab is the higher-resolution one).
export function mergeFinalFrame(held, finalShot, heldMs) {
  if (!finalShot) return held;
  const at = heldMs != null ? heldMs / 1000 : null;
  if (!held.length) return [{ ...finalShot, at }];
  const last = held[held.length - 1];
  if (signatureDistance(last.sig, finalShot.sig) < DUP_THRESHOLD) {
    return [...held.slice(0, -1), { ...finalShot, at: at ?? last.at }];
  }
  return [...held, { ...finalShot, at }];
}

// Content parts for a set of frames. A lone frame goes out bare, as today.
// Several get a short timeline first so the model can order them.
export function buildFrameParts(frames) {
  if (!frames?.length) return [];
  const images = frames.map((f) => ({ type: 'image_url', image_url: { url: f.url } }));
  if (frames.length === 1) return images;
  const fmt = (s) => (s == null ? 'send time' : `${Math.round(s)}s`);
  const list = frames
    .map((f, i) => `#${i + 1} at ${fmt(f.at)}${i === frames.length - 1 ? ' (current screen)' : ''}`)
    .join(', ');
  return [
    {
      type: 'text',
      text: `[${frames.length} screen captures taken while I was speaking, in order. Times are seconds into my turn: ${list}.]`,
    },
    ...images,
  ];
}

// Strip images from user turns older than the last `keepTurns` image-bearing
// ones, replacing them with a text stub. Only the API payload is pruned; the
// chat on screen keeps its pictures. Pruning waits until two turns past the
// window so the oldest messages stay byte-identical between requests, which
// keeps provider prefix caches warm.
export function pruneHistoryImages(messages, keepTurns = 2) {
  const keep = Math.max(0, Number(keepTurns) || 0);
  const hasImage = (m) =>
    m?.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url');
  const idxs = [];
  messages.forEach((m, i) => {
    if (hasImage(m)) idxs.push(i);
  });
  if (idxs.length <= keep + 2) return messages;
  const cutoff = new Set(idxs.slice(0, idxs.length - keep));
  return messages.map((m, i) => {
    if (!cutoff.has(i)) return m;
    const n = m.content.filter((p) => p.type === 'image_url').length;
    const text = m.content
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
      .trim();
    const stub = `[${n} screenshot${n === 1 ? '' : 's'} were attached here earlier and have been removed from context]`;
    return { ...m, content: [{ type: 'text', text: text ? `${text}\n${stub}` : stub }] };
  });
}
