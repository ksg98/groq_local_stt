// Word timing for read-aloud follow-along. Engine timings (Kokoro reports a
// start and end for every word it speaks) are used when present; otherwise a
// sentence's measured audio length is spread across its words by size.

const WORD_RE = /\S+/g;

// Average speaking rate at 1x, used before an engine has said how long a
// sentence really is (chars per second).
export const CHARS_PER_SECOND = 15;

export function splitWords(sentence) {
  const words = [];
  WORD_RE.lastIndex = 0;
  let match;
  while ((match = WORD_RE.exec(sentence)) !== null) {
    words.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return words;
}

export function estimateDuration(text, speed = 1) {
  const chars = String(text || '').length;
  return Math.max(0.3, chars / (CHARS_PER_SECOND * (Number(speed) || 1)));
}

// Align engine tokens [{ text, start, end }] (seconds from the start of the
// sentence's audio) to character offsets in the sentence. A sequential search
// keeps repeated words in order; tokens that cannot be found are skipped.
export function alignTokens(sentence, tokens) {
  const aligned = [];
  const lower = sentence.toLowerCase();
  let cursor = 0;
  for (const token of tokens || []) {
    const text = String(token.text || '').trim();
    if (!text || !(token.end > token.start)) continue;
    const at = lower.indexOf(text.toLowerCase(), cursor);
    if (at === -1) continue;
    aligned.push({ charStart: at, charEnd: at + text.length, t0: token.start, t1: token.end });
    cursor = at + text.length;
  }
  return aligned;
}

// Per-word { t0, t1 } for a sentence.
export function wordTimings(sentence, words, tokens, duration) {
  if (tokens && tokens.length) {
    const aligned = alignTokens(sentence, tokens);
    if (aligned.length) {
      const out = words.map((word) => {
        const hits = aligned.filter((a) => a.charStart < word.end && a.charEnd > word.start);
        if (!hits.length) return null;
        return {
          t0: Math.min(...hits.map((h) => h.t0)),
          t1: Math.max(...hits.map((h) => h.t1)),
        };
      });
      // Words the engine did not time (punctuation-only, numbers it read
      // differently) borrow the gap between their neighbours.
      for (let i = 0; i < out.length; i++) {
        if (out[i]) continue;
        let prev = null;
        for (let j = i - 1; j >= 0; j--) if (out[j]) { prev = out[j]; break; }
        let next = null;
        for (let j = i + 1; j < out.length; j++) if (out[j]) { next = out[j]; break; }
        const t0 = prev ? prev.t1 : 0;
        const t1 = next ? next.t0 : Math.max(t0, duration || t0 + 0.2);
        out[i] = { t0, t1: Math.max(t0, t1) };
      }
      return out;
    }
  }
  const total = duration || estimateDuration(sentence);
  const weights = words.map((w) => w.text.length + (/[.,;:!?]$/.test(w.text) ? 3 : 0) + 0.5);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let t = 0;
  return weights.map((w) => {
    const t0 = t;
    t += (w / sum) * total;
    return { t0, t1: t };
  });
}

export function wordIndexAt(timings, offset) {
  if (!timings || !timings.length) return -1;
  for (let i = 0; i < timings.length; i++) {
    if (offset < timings[i].t1) return i;
  }
  return timings.length - 1;
}

export function formatSeconds(total) {
  const s = Math.max(0, Math.round(total));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
