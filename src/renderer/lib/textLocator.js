// Finds spoken sentences inside rendered markdown so they can be highlighted.
//
// The spoken text is a sanitized copy of the markdown while the DOM holds the
// rendered result, so both sides are reduced to their letters and digits
// before matching. Punctuation, emoji, quotes and markup differences all fall
// away, and a sentence that spans bold text or a link still matches as one.

const SKIP_TAGS = new Set(['PRE', 'SCRIPT', 'STYLE', 'SVG', 'TEXTAREA', 'BUTTON']);
const ALNUM = /[\p{L}\p{N}]/u;

function foldChar(ch) {
  return ALNUM.test(ch) ? ch.toLowerCase()[0] : '';
}

export function normalizeText(text) {
  let out = '';
  for (const ch of String(text || '')) out += foldChar(ch);
  return out;
}

function isSkipped(node, root) {
  let el = node.parentElement;
  while (el && el !== root) {
    if (SKIP_TAGS.has(el.tagName) || el.classList.contains('katex') || el.dataset.noSpeech !== undefined) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

// { norm, map } where map[i] is the text node and offset of norm[i]
export function buildTextIndex(root) {
  const norm = [];
  const map = [];
  if (!root) return { norm: '', map, root };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (isSkipped(node, root) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let node;
  while ((node = walker.nextNode())) {
    const data = node.data;
    for (let i = 0; i < data.length; i++) {
      const folded = foldChar(data[i]);
      if (folded) {
        norm.push(folded);
        map.push({ node, offset: i });
      }
    }
  }
  return { norm: norm.join(''), map, root };
}

export function isIndexStale(index) {
  if (!index) return true;
  const first = index.map[0];
  return !!first && !first.node.isConnected;
}

// Normalized [start, end) of `text` in the index, searching forward from
// `from` first so repeated sentences resolve in reading order.
export function locateText(index, text, from = 0) {
  const needle = normalizeText(text);
  if (!needle || !index) return null;
  let at = index.norm.indexOf(needle, from);
  if (at === -1 && from > 0) at = index.norm.indexOf(needle);
  if (at === -1) return null;
  return { start: at, end: at + needle.length };
}

export function rangeFor(index, start, end) {
  if (!index || start < 0 || end > index.map.length || end <= start) return null;
  const a = index.map[start];
  const b = index.map[end - 1];
  if (!a.node.isConnected || !b.node.isConnected) return null;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset + 1);
  return range;
}

// Normalized offset of the character under a point (click-to-jump)
export function normOffsetAtPoint(index, x, y) {
  if (!index || !index.map.length) return -1;
  const caret = document.caretRangeFromPoint?.(x, y);
  if (!caret || !index.root.contains(caret.startContainer)) return -1;
  for (let i = 0; i < index.map.length; i++) {
    const m = index.map[i];
    try {
      if (caret.comparePoint(m.node, m.offset) >= 0) return i;
    } catch {
      /* node not comparable */
    }
  }
  return index.map.length - 1;
}
