import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { cn, inputClass, readOnlyFieldClass } from '@/lib/utils';

export function FormSection({
  title,
  hint,
  children,
  className,
  id,
}: {
  title?: string;
  hint?: string;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn('panel soft-shadow space-y-4 p-4 md:p-5', className)}>
      {title ? (
        <div>
          <h2 className="text-sm font-bold">{title}</h2>
          {hint ? <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{hint}</p> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function FormField({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('block text-xs font-semibold', className)}>
      <span className="mb-1.5 flex items-center gap-1 text-[hsl(var(--muted-foreground))]">
        <span>{label}</span>
        {required ? <span className="text-[hsl(var(--destructive))]">*</span> : null}
      </span>
      {children}
      {hint && !error ? <span className="mt-1 block text-[10px] font-medium text-[hsl(var(--muted-foreground))]">{hint}</span> : null}
      {error ? <span className="mt-1 block text-[11px] font-semibold text-[hsl(var(--destructive))]">{error}</span> : null}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(inputClass, props.className)} />;
}

export function NumberInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      type={props.type ?? 'number'}
      inputMode={props.inputMode ?? 'decimal'}
      className={cn(inputClass, 'font-mono tabular-nums', props.className)}
    />
  );
}

export function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(inputClass, 'cursor-pointer', props.className)} />;
}

export function ReadOnlyValue({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(readOnlyFieldClass, 'number', className)}>{children}</div>;
}

export function PrimaryButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={props.type ?? 'button'}
      {...props}
      className={cn('btn-primary rounded-xl px-4 py-2.5 text-xs font-bold disabled:opacity-60', className)}
    />
  );
}

export function SecondaryButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={props.type ?? 'button'}
      {...props}
      className={cn(
        'rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 py-2.5 text-xs font-bold hover:bg-[hsl(var(--muted))] disabled:opacity-60',
        className,
      )}
    />
  );
}

export function ChoiceCard({
  selected,
  title,
  subtitle,
  onClick,
}: {
  selected: boolean;
  title: string;
  subtitle?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'min-w-[140px] flex-1 rounded-xl border-2 px-4 py-3 text-start transition-colors',
        selected
          ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] shadow-[0_3px_0_hsl(17_78%_32%)]'
          : 'border-[hsl(var(--border))] bg-[hsl(var(--card))] hover:border-[hsl(var(--primary)/.45)] hover:bg-[hsl(var(--muted))]',
      )}
    >
      <div className="text-sm font-bold">{title}</div>
      {subtitle ? (
        <div className={cn('mt-1 text-[11px] font-medium', selected ? 'opacity-85' : 'text-[hsl(var(--muted-foreground))]')}>
          {subtitle}
        </div>
      ) : null}
    </button>
  );
}

export function Modal({
  title,
  children,
  onClose,
  wide,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center" role="dialog" aria-modal="true">
      <div className={cn('max-h-[92vh] w-full overflow-auto rounded-2xl bg-[hsl(var(--card))] p-4 shadow-xl md:p-5', wide ? 'max-w-2xl' : 'max-w-lg')}>
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold">{title}</h2>
          <SecondaryButton onClick={onClose} className="px-3 py-1.5">×</SecondaryButton>
        </div>
        {children}
      </div>
    </div>
  );
}

export function PageHint({ children }: { children: ReactNode }) {
  return (
    <p className="mb-4 max-w-3xl text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
      {children}
    </p>
  );
}
