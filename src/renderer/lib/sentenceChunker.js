// Incremental sentence splitter for streaming TTS: feed() LLM deltas, get back
// speakable sentences as they complete; flush() returns the remainder.

export function sanitizeForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' Code omitted. ') // fenced code blocks
    .replace(/```+/g, ' ') // stray/unclosed fences
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> label
    .replace(/^#{1,6}\s+/gm, '') // headers
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(\*|_)(.*?)\1/g, '$2') // italics
    .replace(/~~(.*?)~~/g, '$1') // strikethrough
    .replace(/^\s*[-*+]\s+/gm, '') // bullets
    .replace(/^\s*\d+\.\s+/gm, '') // numbered lists
    .replace(/^\s*>\s?/gm, '') // blockquotes
    .replace(/\|/g, ', ') // table pipes
    .replace(/(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F})/gu, '') // emoji
    .replace(/\s+/g, ' ')
    .trim();
}

const BOUNDARY = /[.!?…][)"'’\]]*\s|\n{2,}/g;

export class SentenceChunker {
  constructor({ minChars = 20 } = {}) {
    this.minChars = minChars;
    this.buffer = '';
  }

  feed(delta) {
    this.buffer += delta;
    const sentences = [];
    let idx;
    while ((idx = this._findSplitIndex()) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx);
      const clean = sanitizeForSpeech(raw);
      if (clean) sentences.push(clean);
    }
    return sentences;
  }

  _findSplitIndex() {
    BOUNDARY.lastIndex = 0;
    let match;
    while ((match = BOUNDARY.exec(this.buffer)) !== null) {
      const end = match.index + match[0].length;
      // never split inside an open code fence
      const fences = (this.buffer.slice(0, end).match(/```/g) || []).length;
      if (fences % 2 === 1) continue;
      // too short — merge with the next sentence instead
      if (end < this.minChars) continue;
      return end;
    }
    return -1;
  }

  flush() {
    const clean = sanitizeForSpeech(this.buffer);
    this.buffer = '';
    return clean || null;
  }

  reset() {
    this.buffer = '';
  }
}
