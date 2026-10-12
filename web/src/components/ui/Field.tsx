import { clsx } from 'clsx';
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

/** 16px text so iOS doesn't zoom on focus; solid ink focus outline (≥3:1) per WCAG 2.2 focus visibility. */
const control =
  'w-full rounded-control border border-line-strong bg-surface px-3 text-base text-ink placeholder:text-ink-3 focus:border-ink focus:outline-2 focus:outline-offset-1 focus:outline-ink disabled:bg-sunken disabled:text-ink-3 aria-[invalid=true]:border-chili aria-[invalid=true]:border-2';

interface A11yProps {
  id: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
  required?: boolean;
  children: (props: A11yProps) => ReactNode;
}

export function Field({ label, hint, error, className, required, children }: FieldProps) {
  const id = useId();
  const descId = `${id}-desc`;
  return (
    <div className={clsx('flex flex-col gap-1', className)}>
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-ink-2">
          {label}
          {required && <span className="text-chili"> *</span>}
        </label>
      )}
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': error || hint ? descId : undefined })}
      {error ? (
        <p id={descId} className="text-sm text-chili" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={descId} className="text-sm text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

type Extra = { label?: ReactNode; hint?: ReactNode; error?: string | null; wrapClassName?: string };

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & Extra>(function Input(
  { label, hint, error, wrapClassName, className, required, ...rest },
  ref,
) {
  return (
    <Field label={label} hint={hint} error={error} className={wrapClassName} required={required}>
      {(a) => <input ref={ref} {...a} {...rest} required={required} className={clsx(control, 'h-10 pointer-coarse:h-11', className)} />}
    </Field>
  );
});

export function Select({ label, hint, error, wrapClassName, className, children, required, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & Extra) {
  return (
    <Field label={label} hint={hint} error={error} className={wrapClassName} required={required}>
      {(a) => (
        <select {...a} {...rest} required={required} className={clsx(control, 'h-10 pr-8 pointer-coarse:h-11', className)}>
          {children}
        </select>
      )}
    </Field>
  );
}

export function Textarea({ label, hint, error, wrapClassName, className, required, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & Extra) {
  return (
    <Field label={label} hint={hint} error={error} className={wrapClassName} required={required}>
      {(a) => <textarea {...a} {...rest} required={required} className={clsx(control, 'min-h-20 py-2', className)} />}
    </Field>
  );
}

export function Checkbox({ label, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={clsx('inline-flex min-h-10 cursor-pointer items-center gap-2 py-1 text-sm pointer-coarse:min-h-11', className)}>
      <input type="checkbox" className="size-5 shrink-0 accent-brand" {...rest} />
      {label}
    </label>
  );
}

/** Money input in baht; value/onChange are strings so users can type freely. */
export function MoneyInput(props: InputHTMLAttributes<HTMLInputElement> & Extra) {
  return <Input inputMode="decimal" pattern="^\d+(\.\d{0,2})?$" placeholder="0.00" {...props} className={clsx('num text-right', props.className)} />;
}
