import { useEffect, useState } from 'react';

// Reading & focus preferences from Settings: how read-aloud follows along on
// screen, and how transcript text is set (size, spacing, font).

export const READING_DEFAULTS = {
  ttsAutoRead: false,
  readHighlight: 'word', // 'word' | 'sentence' | 'off'
  readDim: true,
  readFollowScroll: true,
  readingTextSize: 'default', // 'default' | 'large' | 'xlarge'
  readingComfort: false,
  readingFont: 'system', // 'system' | 'hyperlegible'
  readingBoldStarts: false,
};

export function pickReadingPrefs(settings) {
  const s = settings || {};
  return {
    ttsAutoRead: !!s.ttsAutoRead,
    readHighlight: ['word', 'sentence', 'off'].includes(s.readHighlight) ? s.readHighlight : 'word',
    readDim: s.readDim !== false,
    readFollowScroll: s.readFollowScroll !== false,
    readingTextSize: ['default', 'large', 'xlarge'].includes(s.readingTextSize) ? s.readingTextSize : 'default',
    readingComfort: !!s.readingComfort,
    readingFont: s.readingFont === 'hyperlegible' ? 'hyperlegible' : 'system',
    readingBoldStarts: !!s.readingBoldStarts,
  };
}

function samePrefs(a, b) {
  return Object.keys(READING_DEFAULTS).every((key) => a[key] === b[key]);
}

// Text presentation is plain CSS keyed off classes on <html>
export function applyReadingClasses(prefs) {
  const el = document.documentElement;
  el.classList.toggle('reading-comfort', !!prefs.readingComfort);
  el.classList.toggle('reading-font-legible', prefs.readingFont === 'hyperlegible');
  el.classList.toggle('reading-size-lg', prefs.readingTextSize === 'large');
  el.classList.toggle('reading-size-xl', prefs.readingTextSize === 'xlarge');
}

export function useReadingPrefs() {
  const [prefs, setPrefs] = useState(READING_DEFAULTS);

  useEffect(() => {
    let disposed = false;
    const load = () =>
      window.electron
        ?.getSettings?.()
        .then((settings) => {
          if (disposed) return;
          const next = pickReadingPrefs(settings);
          setPrefs((prev) => (samePrefs(prev, next) ? prev : next));
        })
        .catch(() => {});
    load();
    window.addEventListener('focus', load);
    return () => {
      disposed = true;
      window.removeEventListener('focus', load);
    };
  }, []);

  useEffect(() => {
    applyReadingClasses(prefs);
  }, [prefs]);

  return prefs;
}
