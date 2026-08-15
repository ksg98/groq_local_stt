import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

// Single source of truth for syntax-highlighted code: markdown blocks, tool
// calls, and the approval modal all share one dark code surface (kept dark in
// both themes — light token text on it would be unreadable).
export const codeTheme = oneDark;
export const codeBackground = '#282c34';
