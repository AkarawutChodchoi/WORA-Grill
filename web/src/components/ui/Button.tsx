import { clsx } from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './Spinner';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid' | 'danger-ghost' | 'outline';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-600 active:bg-brand-600 disabled:bg-brand/45',
  secondary: 'bg-sunken text-ink hover:bg-line disabled:text-ink-3',
  outline: 'border border-line-strong bg-surface text-ink hover:bg-sunken disabled:text-ink-3',
  ghost: 'text-ink-2 hover:bg-sunken hover:text-ink disabled:text-ink-3',
  /** Opens a destructive flow (outlined so it never looks like the red primary action). */
  danger: 'border border-chili bg-surface text-chili hover:bg-chili-50 disabled:opacity-50',
  /** Low-emphasis destructive action (remove a line, reject). */
  'danger-ghost': 'text-chili hover:bg-chili-50 disabled:opacity-50',
  /** The final confirm of a destructive action. */
  'danger-solid': 'bg-chili text-white hover:bg-chili/90 disabled:bg-chili/50',
};
const sizes: Record<Size, string> = {
  // Touch screens (phones, tablets) get at least 44px-high targets.
  sm: 'h-9 pointer-coarse:h-11 px-3 text-sm gap-1.5',
  md: 'h-10 pointer-coarse:h-11 px-4 gap-2',
  lg: 'h-12 px-5 text-base gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = 'primary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx(
        'inline-flex select-none items-center justify-center rounded-control font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner className="size-4" /> : icon}
      {children}
    </button>
  );
}
