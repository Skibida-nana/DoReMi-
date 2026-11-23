import { useId, type CSSProperties, type ReactNode } from 'react';

export interface ToggleSwitchProps {
  id?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
  accentHex?: string;
  disabled?: boolean;
  testId?: string;
  className?: string;
}

/**
 * Unified accessible Toggle Switch for DoReMi.
 *
 * Geometry (immune to button text-align & DPI scaling):
 * - Track: 44px × 24px (w-11 h-6), inline-flex items-center p-[3px], shrink-0
 * - Thumb: 18px × 18px circular white knob translated 0px (OFF) / 20px (ON)
 *   3px + 18px + 20px + 3px = 44px exact; 3px + 18px + 3px = 24px exact.
 * - Zero position:absolute on thumb or switch container.
 */
export function ToggleSwitch({
  id,
  checked,
  onChange,
  ariaLabel,
  accentHex,
  disabled = false,
  testId,
  className = '',
}: ToggleSwitchProps) {
  const activeColor = accentHex || 'var(--user-accent)';

  const trackStyle: CSSProperties = checked
    ? {
        backgroundColor: activeColor,
        boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.16)',
      }
    : {
        backgroundColor: 'var(--toggle-track-off)',
        boxShadow: 'inset 0 0 0 1px var(--toggle-border-off)',
      };

  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      data-testid={testId}
      data-state={checked ? 'checked' : 'unchecked'}
      onClick={() => {
        if (!disabled) {
          onChange(!checked);
        }
      }}
      style={trackStyle}
      className={`box-border inline-flex h-6 w-11 shrink-0 select-none items-center rounded-full p-[3px] text-left transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--user-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-elevated)] ${
        disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer hover:brightness-105'
      } ${className}`}
    >
      <span
        aria-hidden="true"
        data-toggle-thumb="true"
        className="pointer-events-none block h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.36)] transition-transform duration-200 ease-out"
        style={{
          transform: checked ? 'translateX(20px)' : 'translateX(0px)',
        }}
      />
    </button>
  );
}

export interface SettingToggleRowProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  accentHex?: string;
  disabled?: boolean;
  testId?: string;
  leadingIcon?: ReactNode;
  variant?: 'card' | 'row' | 'compact';
  className?: string;
}

/**
 * Standardized Flexbox setting row pairing a wrappable clickable <label> on the left
 * with a non-shrinking <ToggleSwitch /> on the right (min 16px horizontal gap).
 */
export function SettingToggleRow({
  label,
  description,
  checked,
  onChange,
  accentHex,
  disabled = false,
  testId,
  leadingIcon,
  variant = 'card',
  className = '',
}: SettingToggleRowProps) {
  const generatedId = useId();
  const switchId = testId ? `switch-${testId}` : generatedId;

  const containerClasses =
    variant === 'card'
      ? 'flex items-center justify-between gap-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-4 py-3.5'
      : variant === 'row'
        ? 'flex items-center justify-between gap-4 border-b border-[var(--border-subtle)] py-4 last:border-b-0'
        : 'flex items-center justify-between gap-4';

  const titleClasses =
    variant === 'compact'
      ? 'block text-[13px] font-semibold leading-snug text-[var(--text-primary)] break-words'
      : 'block text-[14px] font-medium leading-snug text-[var(--text-primary)] break-words';

  const descClasses =
    variant === 'compact'
      ? 'mt-0.5 block text-[11px] leading-relaxed text-[var(--text-muted)] break-words'
      : 'mt-0.5 block text-[12.5px] leading-relaxed text-[var(--text-muted)] break-words';

  return (
    <div
      data-testid={testId ? `${testId}-row` : undefined}
      className={`${containerClasses} ${disabled ? 'opacity-70' : ''} ${className}`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {leadingIcon ? <div className="shrink-0">{leadingIcon}</div> : null}
        <label
          htmlFor={switchId}
          data-testid={testId ? `${testId}-label` : undefined}
          className={`min-w-0 flex-1 select-none ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
        >
          <span className={titleClasses}>{label}</span>
          {description ? <span className={descClasses}>{description}</span> : null}
        </label>
      </div>

      <ToggleSwitch
        id={switchId}
        checked={checked}
        onChange={onChange}
        ariaLabel={label}
        accentHex={accentHex}
        disabled={disabled}
        testId={testId}
      />
    </div>
  );
}
