import { Repeat, Repeat1, Shuffle } from 'lucide-react';
import type { RepeatMode } from '../../../shared/types/player';

interface AutoNextIconProps {
  className?: string;
}

/**
 * Distinct Auto Next icon: ordered queue bars with an automatic forward-step arrow,
 * visually distinct from SkipForward (Next), Shuffle, Repeat, and ListMusic (Queue).
 */
export function AutoNextIcon({ className = 'h-4 w-4' }: AutoNextIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 6h12" />
      <path d="M3 12h9" />
      <path d="M3 18h7" />
      <path d="M14 15l5 3-5 3v-6z" fill="currentColor" stroke="none" />
      <path d="M19 10V7a2 2 0 0 0-2-2h-1" />
    </svg>
  );
}

interface ControlButtonBaseProps {
  active: boolean;
  accentColor: string;
  label: string;
  tooltip: string;
  onClick: () => void;
  size?: 'sm' | 'md';
  testId?: string;
  dataAttrs?: Record<string, string>;
  neutralClassName?: string;
  children: React.ReactNode;
}

function ModeIconButton({
  active,
  accentColor,
  label,
  tooltip,
  onClick,
  size = 'md',
  testId,
  dataAttrs,
  neutralClassName = 'text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
  children,
}: ControlButtonBaseProps) {
  const sizeClass = size === 'sm' ? 'h-8 w-8' : 'h-9 w-9';

  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active ? 'true' : 'false'}
      {...dataAttrs}
      onClick={onClick}
      title={tooltip}
      aria-label={label}
      aria-pressed={active}
      className={`relative flex ${sizeClass} shrink-0 items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 active:scale-95 ${
        active ? 'bg-[var(--surface-hover)]' : neutralClassName
      }`}
      style={active ? { color: accentColor } : undefined}
    >
      {children}
      {/* Fixed-position indicator dot: zero layout shift when active state toggles */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute bottom-[3px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full transition-opacity duration-150 ${
          active ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ backgroundColor: accentColor }}
      />
    </button>
  );
}

export interface ShuffleButtonProps {
  enabled: boolean;
  accentColor: string;
  onToggle: () => void;
  size?: 'sm' | 'md';
  testId?: string;
  neutralClassName?: string;
}

export function ShuffleButton({
  enabled,
  accentColor,
  onToggle,
  size = 'md',
  testId = 'btn-shuffle',
  neutralClassName,
}: ShuffleButtonProps) {
  const tooltip = enabled ? 'Phát ngẫu nhiên: Bật' : 'Phát ngẫu nhiên: Tắt';
  const iconClass = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  return (
    <ModeIconButton
      active={enabled}
      accentColor={accentColor}
      label={tooltip}
      tooltip={tooltip}
      onClick={onToggle}
      size={size}
      testId={testId}
      neutralClassName={neutralClassName}
    >
      <Shuffle className={iconClass} />
    </ModeIconButton>
  );
}

export interface RepeatButtonProps {
  mode: RepeatMode;
  accentColor: string;
  onCycle: () => void;
  size?: 'sm' | 'md';
  testId?: string;
  neutralClassName?: string;
}

export function RepeatButton({
  mode,
  accentColor,
  onCycle,
  size = 'md',
  testId = 'btn-repeat',
  neutralClassName,
}: RepeatButtonProps) {
  const tooltip =
    mode === 'off'
      ? 'Lặp: Tắt'
      : mode === 'all'
        ? 'Lặp toàn bộ hàng đợi'
        : 'Lặp bài hiện tại';
  const iconClass = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';

  return (
    <ModeIconButton
      active={mode !== 'off'}
      accentColor={accentColor}
      label={tooltip}
      tooltip={tooltip}
      onClick={onCycle}
      size={size}
      testId={testId}
      dataAttrs={{ 'data-repeat-mode': mode }}
      neutralClassName={neutralClassName}
    >
      {mode === 'one' ? <Repeat1 className={iconClass} /> : <Repeat className={iconClass} />}
    </ModeIconButton>
  );
}

export interface AutoNextButtonProps {
  enabled: boolean;
  repeatMode: RepeatMode;
  accentColor: string;
  onToggle: () => void;
  size?: 'sm' | 'md';
  testId?: string;
  neutralClassName?: string;
}

export function AutoNextButton({
  enabled,
  repeatMode,
  accentColor,
  onToggle,
  size = 'md',
  testId = 'btn-auto-next',
  neutralClassName,
}: AutoNextButtonProps) {
  const tooltip = enabled
    ? 'Tự động chuyển bài: Bật'
    : repeatMode === 'one'
      ? 'Tự động chuyển bài: Tắt (Lặp 1 bài vẫn phát lại bài hiện tại)'
      : 'Tự động chuyển bài: Tắt';
  const iconClass = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';

  return (
    <ModeIconButton
      active={enabled}
      accentColor={accentColor}
      label={tooltip}
      tooltip={tooltip}
      onClick={onToggle}
      size={size}
      testId={testId}
      dataAttrs={{ 'data-auto-next': enabled ? 'on' : 'off' }}
      neutralClassName={neutralClassName}
    >
      <AutoNextIcon className={iconClass} />
    </ModeIconButton>
  );
}
