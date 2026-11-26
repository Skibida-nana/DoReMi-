import type { TimedLyricLine } from './vietnamese-search';

export type PhysicalVinylPhase =
  | 'idle'
  | 'tonearm-lift'
  | 'disc-lift'
  | 'disc-exit'
  | 'empty-platter'
  | 'disc-enter'
  | 'disc-settle'
  | 'tonearm-drop';

export interface VinylSwapSnapshot {
  displayedTrackId: string;
  targetTrackId: string;
  phase: PhysicalVinylPhase;
  isSwapping: boolean;
}

export interface SwapScheduler {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/**
 * 8-step physical vinyl swap timeline (~1080ms total):
 * 1. tonearm-lift  (0ms   -> 170ms) : Tonearm lifts & pivots off disc
 * 2. disc-lift     (170ms -> 340ms) : Old disc lifts vertically off platter with depth shadow
 * 3. disc-exit     (340ms -> 490ms) : Old disc exits platter smoothly
 * 4. empty-platter (490ms -> 630ms) : Empty platter visibly exposed for 140ms (100-150ms spec)
 * 5. disc-enter    (630ms -> 810ms) : New disc with new track artwork descends toward spindle
 * 6. disc-settle   (810ms -> 920ms) : New disc seats onto platter
 * 7. tonearm-drop  (920ms -> 1080ms): Tonearm lowers onto vinyl groove
 * 8. idle          (1080ms+)        : Vinyl spins at 33 1/3 RPM when AudioEngine is playing
 */
export const VINYL_SWAP_TIMINGS = {
  tonearmLiftMs: 170,
  discLiftMs: 170,
  discExitMs: 150,
  emptyPlatterMs: 140,
  discEnterMs: 180,
  discSettleMs: 110,
  tonearmDropMs: 160,
} as const;

export const TOTAL_VINYL_SWAP_MS =
  VINYL_SWAP_TIMINGS.tonearmLiftMs +
  VINYL_SWAP_TIMINGS.discLiftMs +
  VINYL_SWAP_TIMINGS.discExitMs +
  VINYL_SWAP_TIMINGS.emptyPlatterMs +
  VINYL_SWAP_TIMINGS.discEnterMs +
  VINYL_SWAP_TIMINGS.discSettleMs +
  VINYL_SWAP_TIMINGS.tonearmDropMs; // 1080ms

const defaultScheduler: SwapScheduler = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Pure, decoupled state machine for the physical vinyl swap animation.
 * - Never blocks or delays audio playback.
 * - Rapid Next/Previous cancels stale timers via monotonic sequence token and always lands on latest trackId.
 */
export class VinylSwapController {
  private state: VinylSwapSnapshot;
  private readonly scheduler: SwapScheduler;
  private readonly listeners = new Set<(snapshot: VinylSwapSnapshot) => void>();
  private timers: unknown[] = [];
  private sequenceId = 0;

  constructor(initialTrackId: string, scheduler: SwapScheduler = defaultScheduler) {
    this.scheduler = scheduler;
    this.state = {
      displayedTrackId: initialTrackId,
      targetTrackId: initialTrackId,
      phase: 'idle',
      isSwapping: false,
    };
  }

  getSnapshot(): VinylSwapSnapshot {
    return this.state;
  }

  subscribe(listener: (snapshot: VinylSwapSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  private clearTimers(): void {
    for (const handle of this.timers) {
      this.scheduler.clearTimeout(handle);
    }
    this.timers = [];
  }

  private schedule(delayMs: number, seq: number, fn: () => void): void {
    const handle = this.scheduler.setTimeout(() => {
      if (seq !== this.sequenceId) {
        return;
      }
      fn();
    }, delayMs);
    this.timers.push(handle);
  }

  /**
   * Synchronizes to a newly active track ID.
   * If `animate` is false (reduced motion or vinyl animation off), swaps instantaneously.
   */
  transitionTo(nextTrackId: string, animate: boolean): void {
    if (!nextTrackId) {
      return;
    }

    // Already settled on this exact track
    if (
      nextTrackId === this.state.targetTrackId &&
      nextTrackId === this.state.displayedTrackId &&
      this.state.phase === 'idle'
    ) {
      return;
    }

    const seq = ++this.sequenceId;
    this.clearTimers();

    if (!animate) {
      this.state = {
        displayedTrackId: nextTrackId,
        targetTrackId: nextTrackId,
        phase: 'idle',
        isSwapping: false,
      };
      this.emit();
      return;
    }

    // If user rapidly skips while tonearm is already lifted or platter is already empty,
    // keep the platter empty briefly then insert the newest track directly without stuttering.
    const alreadyCleared =
      this.state.phase === 'disc-exit' ||
      this.state.phase === 'empty-platter' ||
      this.state.phase === 'disc-enter';

    if (alreadyCleared) {
      this.state = {
        displayedTrackId: this.state.displayedTrackId,
        targetTrackId: nextTrackId,
        phase: 'empty-platter',
        isSwapping: true,
      };
      this.emit();

      let t = VINYL_SWAP_TIMINGS.emptyPlatterMs;
      this.schedule(t, seq, () => {
        this.state = {
          displayedTrackId: nextTrackId,
          targetTrackId: nextTrackId,
          phase: 'disc-enter',
          isSwapping: true,
        };
        this.emit();
      });

      t += VINYL_SWAP_TIMINGS.discEnterMs;
      this.schedule(t, seq, () => {
        this.state = {
          displayedTrackId: nextTrackId,
          targetTrackId: nextTrackId,
          phase: 'disc-settle',
          isSwapping: true,
        };
        this.emit();
      });

      t += VINYL_SWAP_TIMINGS.discSettleMs;
      this.schedule(t, seq, () => {
        this.state = {
          displayedTrackId: nextTrackId,
          targetTrackId: nextTrackId,
          phase: 'tonearm-drop',
          isSwapping: true,
        };
        this.emit();
      });

      t += VINYL_SWAP_TIMINGS.tonearmDropMs;
      this.schedule(t, seq, () => {
        this.state = {
          displayedTrackId: nextTrackId,
          targetTrackId: nextTrackId,
          phase: 'idle',
          isSwapping: false,
        };
        this.emit();
      });
      return;
    }

    // Full 8-step physical vinyl swap sequence (~1080ms)
    this.state = {
      displayedTrackId: this.state.displayedTrackId,
      targetTrackId: nextTrackId,
      phase: 'tonearm-lift',
      isSwapping: true,
    };
    this.emit();

    let elapsed = VINYL_SWAP_TIMINGS.tonearmLiftMs;
    this.schedule(elapsed, seq, () => {
      this.state = { ...this.state, phase: 'disc-lift' };
      this.emit();
    });

    elapsed += VINYL_SWAP_TIMINGS.discLiftMs;
    this.schedule(elapsed, seq, () => {
      this.state = { ...this.state, phase: 'disc-exit' };
      this.emit();
    });

    elapsed += VINYL_SWAP_TIMINGS.discExitMs;
    this.schedule(elapsed, seq, () => {
      this.state = { ...this.state, phase: 'empty-platter' };
      this.emit();
    });

    elapsed += VINYL_SWAP_TIMINGS.emptyPlatterMs;
    this.schedule(elapsed, seq, () => {
      this.state = {
        displayedTrackId: nextTrackId,
        targetTrackId: nextTrackId,
        phase: 'disc-enter',
        isSwapping: true,
      };
      this.emit();
    });

    elapsed += VINYL_SWAP_TIMINGS.discEnterMs;
    this.schedule(elapsed, seq, () => {
      this.state = { ...this.state, phase: 'disc-settle' };
      this.emit();
    });

    elapsed += VINYL_SWAP_TIMINGS.discSettleMs;
    this.schedule(elapsed, seq, () => {
      this.state = { ...this.state, phase: 'tonearm-drop' };
      this.emit();
    });

    elapsed += VINYL_SWAP_TIMINGS.tonearmDropMs;
    this.schedule(elapsed, seq, () => {
      this.state = {
        displayedTrackId: nextTrackId,
        targetTrackId: nextTrackId,
        phase: 'idle',
        isSwapping: false,
      };
      this.emit();
    });
  }

  /**
   * Immediately cancels any in-flight timed swap steps (e.g. when window hides/minimizes
   * or restores from background) and settles directly onto `targetTrackId` without
   * leaving the platter mid-lift or replaying a stale 1.08s timer backlog.
   */
  settleImmediately(overrideTargetTrackId?: string): void {
    const resolvedTarget = overrideTargetTrackId || this.state.targetTrackId || this.state.displayedTrackId;
    if (
      this.state.displayedTrackId === resolvedTarget &&
      this.state.targetTrackId === resolvedTarget &&
      this.state.phase === 'idle' &&
      !this.state.isSwapping &&
      this.timers.length === 0
    ) {
      return;
    }
    this.sequenceId += 1;
    this.clearTimers();
    this.state = {
      displayedTrackId: resolvedTarget,
      targetTrackId: resolvedTarget,
      phase: 'idle',
      isSwapping: false,
    };
    this.emit();
  }

  dispose(): void {
    this.sequenceId += 1;
    this.clearTimers();
    this.listeners.clear();
  }
}

/**
 * Parses either timestamped LRC lines (`[01:23.45] lyric`) or plain multiline text
 * into TimedLyricLine[] so users can add offline lyrics to any local track.
 */
export function parseLyricsInput(rawText: string, durationSec: number): TimedLyricLine[] {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return [];
  }

  const lrcPattern = /^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.*)$/;
  const timed: TimedLyricLine[] = [];
  let foundTimestamp = false;

  for (const line of lines) {
    const match = lrcPattern.exec(line);
    if (match) {
      foundTimestamp = true;
      const mins = Number(match[1]);
      const secs = Number(match[2]);
      const frac = match[3] ? Number(`0.${match[3]}`) : 0;
      const text = match[4].trim();
      if (text) {
        timed.push({ timeSec: mins * 60 + secs + frac, text });
      }
    }
  }

  if (foundTimestamp && timed.length > 0) {
    return timed.sort((a, b) => a.timeSec - b.timeSec);
  }

  // Distribute plain lyric lines evenly across song duration so user can still read & tap-to-seek
  const safeDuration = Math.max(30, Number.isFinite(durationSec) && durationSec > 0 ? durationSec : lines.length * 8);
  const step = safeDuration / Math.max(1, lines.length);
  return lines.map((text, idx) => ({
    timeSec: Math.round(idx * step),
    text,
  }));
}
