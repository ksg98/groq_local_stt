import { useCallback, useEffect, useRef } from 'react';
import {
  buildTextIndex,
  isIndexStale,
  locateText,
  normalizeText,
  normOffsetAtPoint,
  rangeFor,
} from '../lib/textLocator';

// Follow-along for read-aloud: paints the sentence and word being spoken
// inside a rendered message (CSS Custom Highlight API, so the DOM is never
// touched), keeps the sentence in view, and turns clicks into a sentence
// index for jumping.

const SENTENCE_HL = 'tts-sentence';
const WORD_HL = 'tts-word';
const USER_SCROLL_HOLD_MS = 4000;

function highlightsApi() {
  return typeof window !== 'undefined' && window.CSS?.highlights && typeof window.Highlight === 'function'
    ? window.CSS.highlights
    : null;
}

export function clearFollowAlongHighlights() {
  const hl = highlightsApi();
  if (hl) {
    hl.delete(SENTENCE_HL);
    hl.delete(WORD_HL);
  }
}

function scrollParentOf(el) {
  let node = el?.parentElement;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * @param {object} params
 * @param {{current: HTMLElement|null}} params.containerRef  rendered message body
 * @param {object|null} params.cursor  { index, sentences, wordStart, wordEnd } for this message
 * @param {string} params.text         the message source; the DOM index is rebuilt when it changes
 * @param {'word'|'sentence'|'off'} params.mode
 * @param {boolean} params.followScroll
 */
export function useFollowAlong({ containerRef, cursor, text, mode = 'word', followScroll = true }) {
  const indexRef = useRef(null);
  const indexTextRef = useRef(null);
  const positionsRef = useRef([]); // sentence i -> { start, end } | null (not found)
  const positionsForRef = useRef(null); // the sentences array the cache belongs to
  const lastUserScrollRef = useRef(0);
  const lastSentenceRef = useRef(-1);
  const active = !!cursor;

  const getIndex = useCallback(() => {
    const root = containerRef.current;
    if (!root) return null;
    if (!indexRef.current || indexTextRef.current !== text || isIndexStale(indexRef.current)) {
      indexRef.current = buildTextIndex(root);
      indexTextRef.current = text;
      positionsRef.current = [];
    }
    return indexRef.current;
  }, [containerRef, text]);

  // Sentences are located in reading order, each search starting where the
  // previous sentence ended, so repeated sentences resolve correctly.
  const sentencePosition = useCallback((index, sentences, i) => {
    if (positionsForRef.current !== sentences) {
      positionsRef.current = [];
      positionsForRef.current = sentences;
    }
    const cache = positionsRef.current;
    let from = 0;
    for (let j = 0; j <= i; j++) {
      if (cache[j] === undefined) cache[j] = locateText(index, sentences[j], from);
      if (cache[j]) from = cache[j].end;
    }
    return cache[i] || null;
  }, []);

  // Paint
  useEffect(() => {
    const hl = highlightsApi();
    if (!hl) return undefined;
    if (!cursor || mode === 'off') {
      hl.delete(SENTENCE_HL);
      hl.delete(WORD_HL);
      lastSentenceRef.current = -1;
      return undefined;
    }
    const index = getIndex();
    const pos = index ? sentencePosition(index, cursor.sentences, cursor.index) : null;
    if (!pos) {
      hl.delete(SENTENCE_HL);
      hl.delete(WORD_HL);
      return undefined;
    }
    const sentenceRange = rangeFor(index, pos.start, pos.end);
    if (sentenceRange) hl.set(SENTENCE_HL, new window.Highlight(sentenceRange));
    else hl.delete(SENTENCE_HL);

    let wordRange = null;
    if (mode === 'word' && cursor.wordStart >= 0) {
      const sentence = cursor.sentences[cursor.index] || '';
      const before = normalizeText(sentence.slice(0, cursor.wordStart)).length;
      const length = normalizeText(sentence.slice(cursor.wordStart, cursor.wordEnd)).length;
      if (length > 0) wordRange = rangeFor(index, pos.start + before, pos.start + before + length);
    }
    if (wordRange) hl.set(WORD_HL, new window.Highlight(wordRange));
    else hl.delete(WORD_HL);

    // Keep the sentence in the upper part of the view, unless the reader
    // scrolled by hand a moment ago
    if (followScroll && sentenceRange && lastSentenceRef.current !== cursor.index) {
      lastSentenceRef.current = cursor.index;
      const parent = scrollParentOf(containerRef.current);
      if (parent && Date.now() - lastUserScrollRef.current > USER_SCROLL_HOLD_MS) {
        const rect = sentenceRange.getBoundingClientRect();
        const box = parent.getBoundingClientRect();
        const upper = box.top + box.height * 0.15;
        const lower = box.top + box.height * 0.7;
        if (rect.top < upper || rect.bottom > lower) {
          parent.scrollBy({ top: rect.top - (box.top + box.height * 0.3), behavior: 'smooth' });
        }
      }
    }
    return undefined;
  }, [cursor, mode, followScroll, getIndex, sentencePosition, containerRef]);

  // Manual scrolling pauses follow-scroll for a few seconds
  useEffect(() => {
    if (!active) return undefined;
    const parent = scrollParentOf(containerRef.current);
    if (!parent) return undefined;
    const mark = () => {
      lastUserScrollRef.current = Date.now();
    };
    parent.addEventListener('wheel', mark, { passive: true });
    parent.addEventListener('touchstart', mark, { passive: true });
    return () => {
      parent.removeEventListener('wheel', mark);
      parent.removeEventListener('touchstart', mark);
    };
  }, [active, containerRef]);

  useEffect(() => () => clearFollowAlongHighlights(), []);

  // Sentence under a point, or -1
  const sentenceAtPoint = useCallback(
    (x, y) => {
      if (!cursor) return -1;
      const index = getIndex();
      if (!index) return -1;
      const at = normOffsetAtPoint(index, x, y);
      if (at < 0) return -1;
      const { sentences } = cursor;
      for (let i = 0; i < sentences.length; i++) {
        const pos = sentencePosition(index, sentences, i);
        if (pos && at >= pos.start && at < pos.end) return i;
      }
      // Between sentences: the one that follows the point
      for (let i = 0; i < sentences.length; i++) {
        const pos = positionsRef.current[i];
        if (pos && pos.start > at) return i;
      }
      return -1;
    },
    [cursor, getIndex, sentencePosition]
  );

  return { sentenceAtPoint };
}
