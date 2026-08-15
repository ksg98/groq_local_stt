import { useCallback, useEffect, useState } from 'react';

// Theme preference: 'system' | 'light' | 'dark'. Source of truth is
// settings.json; localStorage mirrors it so index.html can apply the class
// before first paint (no flash of the wrong theme).
const STORAGE_KEY = 'groq-theme';

const media = window.matchMedia('(prefers-color-scheme: dark)');

function resolveDark(theme) {
  return theme === 'dark' || (theme !== 'light' && media.matches);
}

export function applyTheme(theme) {
  document.documentElement.classList.toggle('dark', resolveDark(theme));
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // localStorage unavailable — theme still applies for this session
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'system';
    } catch {
      return 'system';
    }
  });

  // Adopt the persisted preference once settings load
  useEffect(() => {
    let cancelled = false;
    window.electron
      .getSettings()
      .then((settings) => {
        if (!cancelled && settings?.theme && settings.theme !== theme) {
          setThemeState(settings.theme);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    const onChange = () => applyTheme('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback(async (next) => {
    setThemeState(next);
    applyTheme(next);
    try {
      const settings = await window.electron.getSettings();
      await window.electron.saveSettings({ ...settings, theme: next });
    } catch (error) {
      console.error('Failed to persist theme:', error);
    }
  }, []);

  return { theme, setTheme, isDark: resolveDark(theme) };
}
