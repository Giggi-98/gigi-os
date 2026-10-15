import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

function read(): Theme {
  try {
    const t = localStorage.getItem('gigi-theme');
    if (t === 'light' || t === 'dark') return t;
  } catch {}
  return 'dark';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('gigi-theme', theme);
    } catch {}
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) };
}

// Applica subito il tema salvato per evitare il flash al caricamento.
document.documentElement.dataset.theme = read();
