import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PersonalizationPreferences, UiQualityPreset } from '../../../shared/types/stage5';
import {
  stepForegroundResumeLifecycle,
  type ForegroundResumeState,
} from './presentation-lifecycle';

export type EffectiveMotionLevel = 'full' | 'reduced' | 'none';
export type SidebarAutoHideMode = 'none' | 'standard-idle' | 'focus-immediate';

export const STANDARD_ENTRY_IDLE_HIDE_MS = 3000;
export const OVERLAY_LEAVE_HIDE_DELAY_MS = 950;

/**
 * Resolves mode-specific Sidebar presentation policy (`Phase 4.2J`):
 * - `'focus-immediate'`: Focus Vinyl MUST hide Sidebar immediately upon entry (0ms delay),
 *   revealing strictly on left-edge hover or `Alt+M` as an overlay drawer.
 * - `'standard-idle'`: Standard Now Playing shows Sidebar briefly for ~3s orientation,
 *   then hides smoothly as an overlay with ZERO layout shift on Queue/Vinyl/Lyrics.
 * - `'none'`: All other app pages (Home, Library, Playlists, Settings, Profile) keep fixed normal Sidebar.
 */
export function resolveSidebarAutoHideMode(
  route: string,
  nowPlayingMode: string,
): SidebarAutoHideMode {
  if (route !== 'now-playing') {
    return 'none';
  }
  return nowPlayingMode === 'focus' ? 'focus-immediate' : 'standard-idle';
}

export interface SidebarTransitionResolution {
  revealed: boolean;
  scheduleHideMs: number | null;
}

/**
 * Resolves unified Sidebar visibility on route/mode transitions (`Phase 6.1.1 IMP-05`):
 * - Leaving Now Playing / Focus Player restores docked Sidebar (`revealed: true`).
 * - Entering Now Playing (Standard, Lyrics, or Focus Vinyl) hides Sidebar IMMEDIATELY (`0ms` delay,
 *   zero 3s flash), revealing strictly on left-edge hover or `Alt+M` as a zero-shift overlay drawer.
 * - Switching between Focus Vinyl (`focus-immediate`) and Standard Now Playing / Lyrics
 *   (`standard-idle`) keeps Sidebar uniformly hidden.
 */
export function resolveSidebarRevealedOnTransition(
  prevMode: SidebarAutoHideMode,
  nextMode: SidebarAutoHideMode,
  prevRevealed = false,
): SidebarTransitionResolution {
  if (nextMode === 'none') {
    return { revealed: true, scheduleHideMs: null };
  }
  if (prevMode !== nextMode) {
    return { revealed: false, scheduleHideMs: null };
  }
  return {
    revealed: prevRevealed,
    scheduleHideMs: null,
  };
}

export function resolveNextNowPlayingModePatch(
  route: string,
  currentMode: 'standard' | 'focus',
  nextMode: 'standard' | 'focus',
): { nowPlayingMode: 'standard' | 'focus'; nowPlayingSidebarRevealed: boolean } | null {
  if (nextMode === currentMode) {
    return null;
  }
  const stayingInNowPlaying = route === 'now-playing';
  return {
    nowPlayingMode: nextMode,
    nowPlayingSidebarRevealed: stayingInNowPlaying ? false : nextMode === 'standard',
  };
}

export interface UiAnimationPolicy {
  qualityPreset: UiQualityPreset;
  effectiveMotion: EffectiveMotionLevel;
  reducedMotionEffective: boolean;
  /** Shared element transition between Now Playing and Focus Vinyl (ms) */
  modeTransitionMs: number;
  /** Ambient/dual-tone background crossfade on track or artwork changes (ms) */
  backgroundCrossfadeMs: number;
  /** Focus Vinyl auto-hide sidebar reveal/hide duration (ms) */
  sidebarTransitionMs: number;
  /** Synchronized lyrics emphasis / scroll transition (ms) */
  lyricsTransitionMs: number;
  /** Whether continuous vinyl disc spin is permitted */
  vinylSpinAllowed: boolean;
  /** Whether subtle artwork blur background processing is permitted */
  artworkBlurEnabled: boolean;
  /** Whether multi-layer color diffusion backdrop effects are active */
  diffuseBackdropEnabled: boolean;
  /** User preference for dynamic palette extraction */
  dynamicAlbumColors: boolean;
}

/**
 * Single Unified Animation & Rendering Policy (Phase 4J).
 * Reads exclusively from existing PersonalizationPreferences (`uiQualityPreset`,
 * `reducedMotion`, `vinylAnimation`, `backgroundEffects`, `dynamicAlbumColors`)
 * and OS `prefers-reduced-motion` without introducing duplicate per-screen settings.
 */
export function resolveUiAnimationPolicy(
  preferences: Pick<
    PersonalizationPreferences,
    'uiQualityPreset' | 'reducedMotion' | 'vinylAnimation' | 'backgroundEffects' | 'dynamicAlbumColors'
  >,
  options?: {
    osReducedMotion?: boolean;
    isWindowHidden?: boolean;
  },
): UiAnimationPolicy {
  const qualityPreset: UiQualityPreset = preferences.uiQualityPreset ?? 'balanced';
  const reducedMotionEffective = Boolean(preferences.reducedMotion || options?.osReducedMotion);
  const isWindowHidden = Boolean(options?.isWindowHidden);

  const effectiveMotion: EffectiveMotionLevel = reducedMotionEffective
    ? 'none'
    : qualityPreset === 'power-saver'
      ? 'reduced'
      : 'full';

  const modeTransitionMs =
    effectiveMotion === 'none' ? 0 : effectiveMotion === 'reduced' ? 240 : 900;
  const backgroundCrossfadeMs =
    effectiveMotion === 'none' ? 0 : effectiveMotion === 'reduced' ? 240 : 820;
  const sidebarTransitionMs =
    effectiveMotion === 'none' ? 0 : effectiveMotion === 'reduced' ? 140 : 220;
  const lyricsTransitionMs =
    effectiveMotion === 'none' ? 0 : effectiveMotion === 'reduced' ? 180 : 400;

  return {
    qualityPreset,
    effectiveMotion,
    reducedMotionEffective,
    modeTransitionMs,
    backgroundCrossfadeMs,
    sidebarTransitionMs,
    lyricsTransitionMs,
    vinylSpinAllowed:
      Boolean(preferences.vinylAnimation) && !reducedMotionEffective && !isWindowHidden,
    artworkBlurEnabled: qualityPreset !== 'power-saver',
    diffuseBackdropEnabled: Boolean(preferences.backgroundEffects) && qualityPreset !== 'power-saver',
    dynamicAlbumColors: Boolean(preferences.dynamicAlbumColors),
  };
}

// ============================================================================
// Singleton Window Visibility & Foreground Resume Coordinator (Phase 4.3A/C/I)
// ============================================================================

let sharedResumeState: ForegroundResumeState = {
  isHidden: typeof document !== 'undefined' ? Boolean(document.hidden) : false,
  hiddenCycleCount: 0,
  resumeGeneration: 0,
  shouldSnapNextPaint: false,
};

const resumeListeners = new Set<() => void>();
let visibilityAttached = false;
let snapRafId1 = 0;
let snapRafId2 = 0;

function cancelSnapFrames(): void {
  if (typeof cancelAnimationFrame === 'function') {
    if (snapRafId1) cancelAnimationFrame(snapRafId1);
    if (snapRafId2) cancelAnimationFrame(snapRafId2);
  }
  snapRafId1 = 0;
  snapRafId2 = 0;
}

function syncRootLifecycleDatasets(state: ForegroundResumeState): void {
  if (typeof document === 'undefined' || !document.documentElement) {
    return;
  }
  document.documentElement.dataset.appHidden = state.isHidden ? 'true' : 'false';
  document.documentElement.dataset.resumeSync = state.shouldSnapNextPaint ? 'true' : 'false';
}

function dispatchLifecycleEvent(
  event: 'hide' | 'show' | 'window-focus' | 'window-blur' | 'snap-complete',
  genToken?: number,
): void {
  const { nextState, didLeaveHidden, didEnterHidden } = stepForegroundResumeLifecycle(
    sharedResumeState,
    event,
    genToken,
  );
  if (nextState === sharedResumeState) {
    return;
  }
  sharedResumeState = nextState;
  syncRootLifecycleDatasets(nextState);

  if (didEnterHidden) {
    cancelSnapFrames();
  }

  for (const listener of resumeListeners) {
    listener();
  }

  if (didLeaveHidden) {
    cancelSnapFrames();
    const token = nextState.resumeGeneration;
    if (typeof requestAnimationFrame === 'function') {
      snapRafId1 = requestAnimationFrame(() => {
        snapRafId2 = requestAnimationFrame(() => {
          dispatchLifecycleEvent('snap-complete', token);
        });
      });
    } else {
      dispatchLifecycleEvent('snap-complete', token);
    }
  }
}

function ensureSingletonVisibilityListeners(): void {
  if (visibilityAttached || typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }
  visibilityAttached = true;
  sharedResumeState = {
    isHidden: Boolean(document.hidden),
    hiddenCycleCount: 0,
    resumeGeneration: 0,
    shouldSnapNextPaint: false,
  };
  syncRootLifecycleDatasets(sharedResumeState);

  const onVisibilityChange = () => {
    dispatchLifecycleEvent(document.hidden ? 'hide' : 'show');
  };
  const onFocus = () => {
    if (!document.hidden && sharedResumeState.isHidden) {
      dispatchLifecycleEvent('show');
    }
  };
  const onPageShow = () => {
    if (!document.hidden && sharedResumeState.isHidden) {
      dispatchLifecycleEvent('show');
    }
  };
  const onBlur = () => {
    dispatchLifecycleEvent('window-blur');
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', onFocus);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('blur', onBlur);
}

export function getForegroundResumeSnapshot(): ForegroundResumeState {
  ensureSingletonVisibilityListeners();
  return sharedResumeState;
}

export function subscribeForegroundResume(listener: () => void): () => void {
  ensureSingletonVisibilityListeners();
  resumeListeners.add(listener);
  return () => {
    resumeListeners.delete(listener);
  };
}

export function useForegroundResumeState(): ForegroundResumeState {
  return useSyncExternalStore(
    subscribeForegroundResume,
    getForegroundResumeSnapshot,
    () => sharedResumeState,
  );
}

/**
 * React hook wrapping resolveUiAnimationPolicy with reactive OS reduced-motion
 * and single shared window visibility tracking (zero listener stacking on Alt+Tab).
 */
export function useUiAnimationPolicy(
  preferences: Pick<
    PersonalizationPreferences,
    'uiQualityPreset' | 'reducedMotion' | 'vinylAnimation' | 'backgroundEffects' | 'dynamicAlbumColors'
  >,
): UiAnimationPolicy {
  const [osReducedMotion, setOsReducedMotion] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  const foregroundResume = useForegroundResumeState();

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setOsReducedMotion(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  return resolveUiAnimationPolicy(preferences, {
    osReducedMotion,
    isWindowHidden: foregroundResume.isHidden,
  });
}
