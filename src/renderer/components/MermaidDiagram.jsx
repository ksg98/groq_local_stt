import React, { useEffect, useState } from 'react';

// mermaid is ~1.5MB, so it loads lazily on first use and is shared app-wide.
let mermaidPromise = null;
let initializedTheme = null;

function getMermaidTheme() {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'neutral';
}

// Loads mermaid once and (re-)initializes it whenever the requested theme
// differs from the one it was last configured with.
async function loadMermaid(theme) {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => mod.default);
  }
  const mermaid = await mermaidPromise;
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
      fontFamily: 'inherit',
      suppressErrorRendering: true,
    });
    initializedTheme = theme;
  }
  return mermaid;
}

let renderSeq = 0;

// Renders a ```mermaid code block as a diagram. The definition streams in
// token by token, so it won't parse until enough of it has arrived — show the
// code (or the last diagram that parsed) and retry as the content grows.
function MermaidDiagram({ code }) {
  const [svg, setSvg] = useState(null);
  const [theme, setTheme] = useState(getMermaidTheme);

  // Theme can flip live from Settings (the 'dark' class toggles on <html>),
  // so watch documentElement's class attribute and re-render on change.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(getMermaidTheme());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const mermaid = await loadMermaid(theme);
        await mermaid.parse(code); // throws while the block is incomplete/invalid
        const { svg: rendered } = await mermaid.render(`mermaid-${++renderSeq}`, code);
        if (!cancelled) setSvg(rendered);
      } catch {
        // keep the previous good render (mid-stream) or stay on the code view
      }
    }, 150); // debounce re-parses while streaming
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, theme]);

  if (svg) {
    return (
      <div
        className="my-3 p-3 rounded-xl border border-border/40 bg-card overflow-x-auto [&_svg]:max-w-full [&_svg]:h-auto"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  return (
    <pre className="my-3 p-3 rounded-xl bg-[#282c34] text-gray-200 text-sm overflow-x-auto whitespace-pre-wrap">
      {code}
    </pre>
  );
}

export default MermaidDiagram;
