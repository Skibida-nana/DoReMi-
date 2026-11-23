import type { SleepTimerPreset, SleepTimerState } from '../types/stage6';

export const SLEEP_TIMER_PRESET_MINUTES: Partial<Record<SleepTimerPreset, number>> = {
  '15m': 15,
  '30m': 30,
  '45m': 45,
  '60m': 60,
  '90m': 90,
};

export interface SleepTimerControllerOptions {
  nowMs?: () => number;
  onExpire: (reason: 'countdown' | 'end-of-track') => void;
  onChange?: (state: SleepTimerState) => void;
  /** Countdown check interval in ms (default: 1000ms; injectable for fast deterministic unit tests) */
  tickIntervalMs?: number;
}

/**
 * Deterministic, single-instance Sleep Timer controller.
 *
 * Safety guarantees:
 * - Only ONE timer can ever be active at a time (setting a new preset cancels any old timer).
 * - Countdown runs against wall-clock `endsAtMs` so Pause/Resume never drifts or duplicates timers.
 * - Zero background timers run when timer is `off` or `end-of-track`.
 * - In `end-of-track` mode, `handleNaturalTrackEnd()` returns `true` ONCE so caller stops playback
 *   instead of auto-advancing Shuffle/Repeat, then immediately clears the timer so it can never double-fire.
 * - Calling `onTrackChanged()` in `end-of-track` mode updates `armedTrackId` cleanly to the user's newly
 *   chosen track without firing prematurely.
 */
export class SleepTimerController {
  private readonly nowMs: () => number;
  private readonly onExpire: (reason: 'countdown' | 'end-of-track') => void;
  private readonly onChange?: (state: SleepTimerState) => void;
  private readonly tickIntervalMs: number;

  private preset: SleepTimerPreset = 'off';
  private endsAtMs: number | null = null;
  private armedTrackId: string | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private cachedState: SleepTimerState;

  constructor(options: SleepTimerControllerOptions) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.onExpire = options.onExpire;
    this.onChange = options.onChange;
    this.tickIntervalMs = Math.max(20, options.tickIntervalMs ?? 1000);
    this.cachedState = this.buildState();
  }

  getState(): SleepTimerState {
    return this.cachedState;
  }

  /**
   * Starts a preset sleep timer, replacing any previously active timer.
   * For deterministic tests, optional `customDurationMs` overrides preset minutes.
   */
  start(
    preset: SleepTimerPreset,
    options?: { currentTrackId?: string | null; customDurationMs?: number },
  ): SleepTimerState {
    this.clearIntervalOnly();

    if (preset === 'off') {
      this.preset = 'off';
      this.endsAtMs = null;
      this.armedTrackId = null;
      return this.emit();
    }

    if (preset === 'end-of-track') {
      this.preset = 'end-of-track';
      this.endsAtMs = null;
      this.armedTrackId = options?.currentTrackId ?? null;
      return this.emit();
    }

    const minutes = SLEEP_TIMER_PRESET_MINUTES[preset];
    const durationMs =
      typeof options?.customDurationMs === 'number' && options.customDurationMs > 0
        ? options.customDurationMs
        : (minutes ?? 15) * 60 * 1000;

    this.preset = preset;
    this.armedTrackId = null;
    this.endsAtMs = this.nowMs() + durationMs;

    this.intervalHandle = setInterval(() => {
      this.checkTick();
    }, this.tickIntervalMs);

    return this.emit();
  }

  cancel(): SleepTimerState {
    this.clearIntervalOnly();
    if (this.preset === 'off' && this.endsAtMs === null && this.armedTrackId === null) {
      return this.cachedState;
    }
    this.preset = 'off';
    this.endsAtMs = null;
    this.armedTrackId = null;
    return this.emit();
  }

  /**
   * Updates the armed track when the user manually switches songs while `end-of-track` is active.
   * Never fires the timer prematurely.
   */
  notifyTrackChanged(trackId: string | null): void {
    if (this.preset !== 'end-of-track') {
      return;
    }
    if (this.armedTrackId !== trackId) {
      this.armedTrackId = trackId;
      this.emit();
    }
  }

  /**
   * Called when the current track reaches natural playback end (`ended`).
   * If `end-of-track` mode is active, consumes the timer ONCE, notifies `onExpire('end-of-track')`,
   * and returns `true` so the caller pauses instead of auto-advancing to the next track.
   */
  handleNaturalTrackEnd(): boolean {
    if (this.preset !== 'end-of-track') {
      return false;
    }
    this.clearIntervalOnly();
    this.preset = 'off';
    this.endsAtMs = null;
    this.armedTrackId = null;
    this.emit();
    this.onExpire('end-of-track');
    return true;
  }

  /**
   * Manually evaluates the countdown clock (used internally by interval and available for deterministic tests).
   */
  checkTick(): boolean {
    if (this.preset === 'off' || this.preset === 'end-of-track' || this.endsAtMs === null) {
      this.clearIntervalOnly();
      return false;
    }

    const remainingMs = this.endsAtMs - this.nowMs();
    if (remainingMs <= 0) {
      this.clearIntervalOnly();
      this.preset = 'off';
      this.endsAtMs = null;
      this.armedTrackId = null;
      this.emit();
      this.onExpire('countdown');
      return true;
    }

    this.emit();
    return false;
  }

  dispose(): void {
    this.clearIntervalOnly();
  }

  private clearIntervalOnly(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private buildState(): SleepTimerState {
    if (this.preset === 'off') {
      return {
        active: false,
        preset: 'off',
        endsAtMs: null,
        remainingSeconds: null,
        armedTrackId: null,
      };
    }

    if (this.preset === 'end-of-track') {
      return {
        active: true,
        preset: 'end-of-track',
        endsAtMs: null,
        remainingSeconds: null,
        armedTrackId: this.armedTrackId,
      };
    }

    const remainingMs = this.endsAtMs !== null ? Math.max(0, this.endsAtMs - this.nowMs()) : 0;
    return {
      active: true,
      preset: this.preset,
      endsAtMs: this.endsAtMs,
      remainingSeconds: Math.ceil(remainingMs / 1000),
      armedTrackId: null,
    };
  }

  private emit(): SleepTimerState {
    this.cachedState = this.buildState();
    this.onChange?.(this.cachedState);
    return this.cachedState;
  }
}

export function formatSleepTimerRemaining(state: SleepTimerState): string {
  if (!state.active) {
    return 'Đang tắt';
  }
  if (state.preset === 'end-of-track') {
    return 'Dừng khi hết bài hiện tại';
  }
  const totalSec = Math.max(0, state.remainingSeconds ?? 0);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) {
    return `Còn ${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `Còn ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}
