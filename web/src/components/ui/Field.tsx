import { clsx } from 'clsx';
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

const control =
  'w-full rounded-control border border-line-strong bg-surface px-3 text-ink placeholder:text-ink-3 focus:border-sky focus:outline-none focus:ring-2 focus:ring-sky/25 disabled:bg-sunken disabled:text-ink-3 aria-[invalid=true]:border-chili';

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
      {(a) => <input ref={ref} {...a} {...rest} required={required} className={clsx(control, 'h-10', className)} />}
    </Field>
  );
});

export function Select({ label, hint, error, wrapClassName, className, children, required, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & Extra) {
  return (
    <Field label={label} hint={hint} error={error} className={wrapClassName} required={required}>
      {(a) => (
        <select {...a} {...rest} required={required} className={clsx(control, 'h-10 pr-8', className)}>
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
    <label className={clsx('inline-flex cursor-pointer items-center gap-2 text-sm', className)}>
      <input type="checkbox" className="size-4 accent-basil" {...rest} />
      {label}
    </label>
  );
}

/** Money input in baht; value/onChange are strings so users can type freely. */
export function MoneyInput(props: InputHTMLAttributes<HTMLInputElement> & Extra) {
  return <Input inputMode="decimal" pattern="^\d+(\.\d{0,2})?$" placeholder="0.00" {...props} className={clsx('num text-right', props.className)} />;
}
