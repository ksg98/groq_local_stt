import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import { formatTokens, MIN_COMPACT_TOKENS } from '../lib/contextWindow';

// How full the context window is, with a manual "Compact now".
function ContextMeter({ usage, onCompact, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!ref.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!usage || !(usage.tokens > 0) || !(usage.limit > 0)) return null;

  const ratio = Math.min(1, usage.tokens / usage.limit);
  const pct = Math.round(ratio * 100);
  const label = ratio < 0.01 ? '<1%' : `${pct}%`;
  const full = ratio >= usage.threshold;
  const warn = !full && ratio >= usage.threshold * 0.8;
  const tone = full ? 'text-destructive' : warn ? 'text-amber-500' : 'text-primary';
  const bar = full ? 'bg-destructive' : warn ? 'bg-amber-500' : 'bg-primary';
  const canCompact = usage.tokens >= MIN_COMPACT_TOKENS;
  const radius = 7;
  const circumference = 2 * Math.PI * radius;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          'flex items-center gap-1.5 rounded-xl px-2 py-1.5 text-xs text-muted-foreground tabular-nums hover:text-foreground hover:bg-accent/60 transition-colors',
          open && 'bg-accent/60 text-foreground'
        )}
        title="Context window"
        aria-label={`Context window ${label} used`}
        aria-expanded={open}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" className="-rotate-90" aria-hidden="true">
          <circle cx="9" cy="9" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
          <circle
            cx="9"
            cy="9"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - Math.max(ratio, 0.02))}
            className={tone}
          />
        </svg>
        <span>{label}</span>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-2 z-50 w-64 glass-card rounded-xl p-3 shadow-lg text-xs space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium text-foreground">Context window</span>
            <span className="tabular-nums text-muted-foreground">{label}</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div className={cn('h-full rounded-full', bar)} style={{ width: `${Math.max(1, pct)}%` }} />
          </div>
          <p className="tabular-nums text-muted-foreground">
            {usage.measured ? '' : '~'}
            {formatTokens(usage.tokens)} of {formatTokens(usage.limit)} tokens
          </p>
          <p className="text-muted-foreground">
            {usage.autoCompact
              ? `Compacts automatically at ${Math.round(usage.threshold * 100)}%.`
              : 'Auto-compact is off.'}{' '}
            {canCompact ? (
              <>
                Type <span className="font-mono text-foreground">/compact</span> to summarize now.
              </>
            ) : (
              `Chats under ${formatTokens(MIN_COMPACT_TOKENS)} tokens are not compacted.`
            )}
          </p>
          <button
            type="button"
            disabled={disabled || !canCompact}
            onClick={() => {
              setOpen(false);
              onCompact?.();
            }}
            className="w-full rounded-lg border border-border px-3 py-1.5 text-foreground hover:bg-accent disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
          >
            Compact now
          </button>
        </div>
      )}
    </div>
  );
}

export default ContextMeter;
