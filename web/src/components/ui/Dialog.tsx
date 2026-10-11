import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

/** Accessible modal on the native <dialog> element (focus trapping and Esc handled by the browser). */
export function Dialog({ open, onClose, title, children, footer, size = 'md' }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close?.();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // No close on backdrop tap: a stray tap must never throw away a half-filled form (Esc / ✕ still close).
      className={clsx('m-auto w-[calc(100%-1rem)] rounded-panel bg-surface p-0 text-ink shadow-xl', widths[size])}
      aria-labelledby={titleId}
    >
      {open && (
        <div className="flex max-h-[90dvh] flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-line py-2 pr-2 pl-4 sm:pl-5">
            <h2 id={titleId} className="text-lg font-semibold">
              {title}
            </h2>
            <button type="button" onClick={onClose} className="flex size-11 shrink-0 items-center justify-center rounded-control text-ink-3 hover:bg-sunken hover:text-ink" aria-label="ปิด">
              <X className="size-5" />
            </button>
          </div>
          <div className="overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3 sm:px-5">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
