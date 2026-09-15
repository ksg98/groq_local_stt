import React, { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';

// Speaking-rate picker. A menu rather than a cycle button, so any rate is one
// click away instead of four.
function SpeedControl({ speed = 1, steps = [0.75, 1, 1.25, 1.5, 1.75, 2], onChange, className, placement = 'up' }) {
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

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          'flex items-center justify-center px-1.5 py-1 rounded hover:bg-accent transition-colors font-medium tabular-nums',
          open && 'bg-accent',
          className
        )}
        title="Speaking speed"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {speed}x
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            'absolute right-0 z-50 glass-card rounded-lg p-1 shadow-lg min-w-[4.25rem]',
            placement === 'down' ? 'top-full mt-2' : 'bottom-full mb-2'
          )}
        >
          {steps.map((step) => (
            <button
              key={step}
              type="button"
              role="menuitemradio"
              aria-checked={step === speed}
              onClick={() => {
                onChange?.(step);
                setOpen(false);
              }}
              className={cn(
                'w-full text-left px-2 py-1 rounded text-xs tabular-nums hover:bg-accent transition-colors',
                step === speed ? 'text-primary font-semibold' : 'text-foreground'
              )}
            >
              {step}x
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default SpeedControl;
