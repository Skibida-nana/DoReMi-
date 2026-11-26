import type { AppRoute, NowPlayingDisplayMode, NowPlayingRightTab } from '../stores/ui-store';

export const SESSION_PRESENTATION_STORAGE_KEY = 'doremi_session_presentation_v1';

export interface SessionPresentationSnapshot {
  route: AppRoute;
  previousRoute: AppRoute;
  nowPlayingMode: NowPlayingDisplayMode;
  nowPlayingRightTab: NowPlayingRightTab;
  /** Preserved Focus Browse Mode state scoped strictly to the same active track */
  focusLyricsBrowse?: {
    trackId: string;
    viewedIndex: number;
  } | null;
}

export interface AuthoritativePresentationState {
  targetMode: NowPlayingDisplayMode;
  committedMode: NowPlayingDisplayMode;
  isTransitioning: boolean;
  modeGeneration: number;
}

export interface BrowseModeRecoveryState {
  trackId: string;
  isBrowseMode: boolean;
  viewedIndex: number;
}

export interface ForegroundResumeState {
  isHidden: boolean;
  hiddenCycleCount: number;
  resumeGeneration: number;
  shouldSnapNextPaint: boolean;
}

export interface VisibilityTransitionResult {
  nextState: ForegroundResumeState;
  didLeaveHidden: boolean;
  didEnterHidden: boolean;
}

/**
 * Creates initial authoritative mode state matching Store presentation truth.
 */
export function createAuthoritativePresentationState(
  initialMode: NowPlayingDisplayMode = 'standard',
): AuthoritativePresentationState {
  return {
    targetMode: initialMode,
    committedMode: initialMode,
    isTransitioning: false,
    modeGeneration: 0,
  };
}

/**
 * Explicit user mode transition: ONLY explicit user triggers or intentional navigation
 * can alter targetMode. Window blur / visibilitychange / minimize / restore MUST NEVER reset it.
 */
export function applyExplicitModeSelection(
  state: AuthoritativePresentationState,
  nextMode: NowPlayingDisplayMode,
  animateDurationMs: number,
): AuthoritativePresentationState {
  if (state.targetMode === nextMode && !state.isTransitioning && state.committedMode === nextMode) {
    return state;
  }
  const nextGen = state.modeGeneration + 1;
  if (animateDurationMs <= 0) {
    return {
      targetMode: nextMode,
      committedMode: nextMode,
      isTransitioning: false,
      modeGeneration: nextGen,
    };
  }
  return {
    targetMode: nextMode,
    committedMode: state.committedMode,
    isTransitioning: true,
    modeGeneration: nextGen,
  };
}

/**
 * Completes an ongoing mode transition ONLY if generation matches the latest user choice.
 * Stale callbacks from older interrupted transitions are strictly ignored.
 */
export function completeModeTransitionIfCurrent(
  state: AuthoritativePresentationState,
  callbackGeneration: number,
): AuthoritativePresentationState {
  if (callbackGeneration !== state.modeGeneration) {
    return state;
  }
  return {
    targetMode: state.targetMode,
    committedMode: state.targetMode,
    isTransitioning: false,
    modeGeneration: state.modeGeneration,
  };
}

/**
 * Called when window enters background or returns to foreground while a mode transition
 * may be in-flight: settles directly onto `targetMode` (the user's latest explicit choice),
 * never reverting back to `'standard'` on interruption.
 */
export function resolveModeAfterBackgroundInterruption(
  state: AuthoritativePresentationState,
): AuthoritativePresentationState {
  return {
    targetMode: state.targetMode,
    committedMode: state.targetMode,
    isTransitioning: false,
    modeGeneration: state.modeGeneration + 1,
  };
}

/**
 * Deduplicates window visibility & focus/restore lifecycle transitions (`Phase 4.3A–C`):
 * - `window.blur` or regaining focus while NEVER hidden triggers ZERO snap/reset work.
 * - Entering hidden increments `hiddenCycleCount`, cancels stale transitions cleanly.
 * - Leaving hidden (`hidden -> visible`) emits `didLeaveHidden: true` ONCE per cycle with
 *   a monotonic `resumeGeneration` so rapid Alt+Tab / focus / visibility bursts never race.
 */
export function stepForegroundResumeLifecycle(
  prev: ForegroundResumeState,
  event: 'hide' | 'show' | 'window-focus' | 'window-blur' | 'snap-complete',
  generationToken?: number,
): VisibilityTransitionResult {
  if (event === 'window-blur') {
    // Losing focus while remaining visible MUST NOT exit Focus Vinyl, hide UI, or snap visuals
    return { nextState: prev, didLeaveHidden: false, didEnterHidden: false };
  }

  if (event === 'hide') {
    if (prev.isHidden) {
      return { nextState: prev, didLeaveHidden: false, didEnterHidden: false };
    }
    return {
      nextState: {
        isHidden: true,
        hiddenCycleCount: prev.hiddenCycleCount + 1,
        resumeGeneration: prev.resumeGeneration + 1,
        shouldSnapNextPaint: false,
      },
      didLeaveHidden: false,
      didEnterHidden: true,
    };
  }

  if (event === 'show' || event === 'window-focus') {
    if (!prev.isHidden) {
      // Window was never hidden (e.g. simple focus switch between visible side-by-side windows)
      return { nextState: prev, didLeaveHidden: false, didEnterHidden: false };
    }
    return {
      nextState: {
        isHidden: false,
        hiddenCycleCount: prev.hiddenCycleCount,
        resumeGeneration: prev.resumeGeneration + 1,
        shouldSnapNextPaint: true,
      },
      didLeaveHidden: true,
      didEnterHidden: false,
    };
  }

  // 'snap-complete': clear single-frame resume snap ONLY if generation token still matches
  if (
    event === 'snap-complete' &&
    prev.shouldSnapNextPaint &&
    (generationToken === undefined || generationToken === prev.resumeGeneration)
  ) {
    return {
      nextState: { ...prev, shouldSnapNextPaint: false },
      didLeaveHidden: false,
      didEnterHidden: false,
    };
  }

  return { nextState: prev, didLeaveHidden: false, didEnterHidden: false };
}

/**
 * Pure Browse Mode preservation resolver (`Phase 4.3B §16 & §26`):
 * - Same track + valid lyrics -> preserves Browse Mode & viewedIndex unconditionally across
 *   background hide/show, blur/focus, and active playback lyric progression (even after 10s+).
 * - Track change OR empty lyrics -> resets cleanly to Follow Mode.
 */
export function resolveBrowseModeAcrossTrackOrResume(input: {
  currentState: BrowseModeRecoveryState;
  nextTrackId: string;
  totalLyricGroups: number;
  isFocusActive: boolean;
}): BrowseModeRecoveryState {
  const { currentState, nextTrackId, totalLyricGroups, isFocusActive } = input;
  if (!isFocusActive || totalLyricGroups <= 0) {
    return {
      trackId: nextTrackId,
      isBrowseMode: false,
      viewedIndex: 0,
    };
  }
  if (currentState.trackId !== nextTrackId) {
    return {
      trackId: nextTrackId,
      isBrowseMode: false,
      viewedIndex: 0,
    };
  }
  const clampedIdx = Math.max(0, Math.min(totalLyricGroups - 1, currentState.viewedIndex));
  return {
    trackId: nextTrackId,
    isBrowseMode: currentState.isBrowseMode,
    viewedIndex: clampedIdx,
  };
}

/**
 * Computes monotonic clamped visual delta / rotation rebasing when restoring a paused rotor,
 * avoiding any multi-revolution jump if an explicit frame delta is accumulated.
 * Does NOT affect audio playback timing.
 */
export function rebaseRotationAngleAfterPause(
  angleAtPauseDeg: number,
  maxAllowedStepDeg = 12,
  deltaDegSinceLastFrame = 0,
): number {
  const normBase = ((angleAtPauseDeg % 360) + 360) % 360;
  if (!Number.isFinite(deltaDegSinceLastFrame)) {
    return normBase;
  }
  const clampedDelta = Math.max(0, Math.min(maxAllowedStepDeg, deltaDegSinceLastFrame));
  return (normBase + clampedDelta) % 360;
}

/**
 * Safely reads in-session presentation snapshot from `window.sessionStorage`.
 * Strictly session-scoped: clears naturally when app window closes, while surviving
 * soft renderer reloads / HMR / context restores inside the running session.
 */
export function readSessionPresentation(
  storage: Pick<Storage, 'getItem'> | null | undefined = typeof window !== 'undefined'
    ? window.sessionStorage
    : undefined,
): Partial<SessionPresentationSnapshot> | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(SESSION_PRESENTATION_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<SessionPresentationSnapshot>;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const result: Partial<SessionPresentationSnapshot> = {};
    if (typeof parsed.route === 'string') {
      result.route = parsed.route as AppRoute;
    }
    if (typeof parsed.previousRoute === 'string') {
      result.previousRoute = parsed.previousRoute as AppRoute;
    }
    if (parsed.nowPlayingMode === 'focus' || parsed.nowPlayingMode === 'standard') {
      result.nowPlayingMode = parsed.nowPlayingMode;
    }
    if (
      parsed.nowPlayingRightTab === 'lyrics' ||
      parsed.nowPlayingRightTab === 'queue' ||
      parsed.nowPlayingRightTab === 'info'
    ) {
      result.nowPlayingRightTab = parsed.nowPlayingRightTab;
    }
    if (
      parsed.focusLyricsBrowse &&
      typeof parsed.focusLyricsBrowse.trackId === 'string' &&
      typeof parsed.focusLyricsBrowse.viewedIndex === 'number' &&
      Number.isFinite(parsed.focusLyricsBrowse.viewedIndex)
    ) {
      result.focusLyricsBrowse = {
        trackId: parsed.focusLyricsBrowse.trackId,
        viewedIndex: Math.max(0, Math.round(parsed.focusLyricsBrowse.viewedIndex)),
      };
    } else if (parsed.focusLyricsBrowse === null) {
      result.focusLyricsBrowse = null;
    }
    return result;
  } catch {
    return null;
  }
}

export function writeSessionPresentation(
  snapshot: SessionPresentationSnapshot,
  storage: Pick<Storage, 'setItem'> | null | undefined = typeof window !== 'undefined'
    ? window.sessionStorage
    : undefined,
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(SESSION_PRESENTATION_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Ignore restricted/sandboxed storage errors
  }
}
