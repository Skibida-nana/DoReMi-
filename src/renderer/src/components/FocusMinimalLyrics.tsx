import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { RotateCcw } from 'lucide-react';
import type { TimedLyricGroup } from '../../../shared/utils/lyrics-parser';
import {
  computeAdaptiveMultilineLyricLayout,
  computeRadialCurvedLyricSlotPosition,
  type FocusRadialLayout,
} from '../utils/focus-radial-layout';
import { resolveBrowseModeAcrossTrackOrResume } from '../utils/presentation-lifecycle';

export interface FocusMinimalLyricsProps {
  /** Strictly timed LRC groups; never fabricated from plain text */
  lyricGroups: readonly TimedLyricGroup[];
  activeGroupIndex: number;
  trackKey: string;
  isFocusActive: boolean;
  isWindowHidden?: boolean;
  suppressResumeTransitions?: boolean;
  persistedBrowseState?: { trackId: string; viewedIndex: number } | null;
  onBrowseStateChange?: (next: { trackId: string; viewedIndex: number } | null) => void;
  focusRadial: FocusRadialLayout;
  accentColor: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  buttonBg: string;
  buttonFg: string;
  buttonBorder: string;
  transitionMs: number;
  onSeekToLine: (timeSec: number) => void;
}

export type FocusLyricTransitionDirection = 'forward' | 'backward' | 'jump' | 'idle';

export type FocusLyricSlotRole =
  | 'exiting-top'
  | 'exiting-bottom'
  | 'prev4'
  | 'prev3'
  | 'prev2'
  | 'prev1'
  | 'current'
  | 'next1'
  | 'next2'
  | 'next3'
  | 'next4'
  | 'prev'
  | 'next';

export interface FocusLyricSlotItem {
  groupIndex: number;
  slotDelta: number;
  role: FocusLyricSlotRole;
  group: TimedLyricGroup;
  key: string;
}

export function resolveFocusLyricTransitionDirection(
  prevIndex: number | null,
  nextIndex: number,
  animateAllowed: boolean,
): FocusLyricTransitionDirection {
  if (!animateAllowed || prevIndex === null || prevIndex === nextIndex) {
    return 'idle';
  }
  const delta = nextIndex - prevIndex;
  if (Math.abs(delta) > 3) {
    return 'jump';
  }
  return delta > 0 ? 'forward' : 'backward';
}

export function clampLyricGroupIndex(index: number, totalGroups: number): number {
  if (totalGroups <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(totalGroups - 1, Math.round(index)));
}

function resolveRoleForDelta(delta: number): FocusLyricSlotRole {
  switch (delta) {
    case -4:
      return 'prev4';
    case -3:
      return 'prev3';
    case -2:
      return 'prev2';
    case -1:
      return 'prev1';
    case 0:
      return 'current';
    case 1:
      return 'next1';
    case 2:
      return 'next2';
    case 3:
      return 'next3';
    case 4:
      return 'next4';
    default:
      return delta < 0 ? 'exiting-top' : 'exiting-bottom';
  }
}

/**
 * Generalized odd-size radial lyric window builder (`5 | 7 | 9` groups centered at `centerIndex`),
 * plus transient exiting items just beyond outer bounds for continuous X+Y directional slide.
 * Never fabricates placeholder lines at song start/end (`§47`).
 */
export function buildFocusWindowSlotItems(input: {
  lyricGroups: readonly TimedLyricGroup[];
  centerIndex: number;
  visibleSlotCount: 3 | 5 | 7 | 9;
  trackKey?: string;
  prevCenterIndex?: number | null;
  direction?: FocusLyricTransitionDirection;
}): FocusLyricSlotItem[] {
  const {
    lyricGroups,
    centerIndex,
    visibleSlotCount,
    trackKey = 'track',
    prevCenterIndex = null,
    direction = 'idle',
  } = input;
  if (lyricGroups.length === 0) {
    return [];
  }
  const half = Math.floor(visibleSlotCount / 2); // 2, 3, or 4
  const safeCenter = clampLyricGroupIndex(centerIndex, lyricGroups.length);
  const items: FocusLyricSlotItem[] = [];
  const seen = new Set<number>();

  const makeKey = (idx: number, grp: TimedLyricGroup) =>
    `${trackKey}-fg-${idx}-${Math.round(grp.timeSec * 1000)}`;

  // Transient exiting slots when sliding 1..3 steps forward or backward
  if (
    prevCenterIndex !== null &&
    (direction === 'forward' || direction === 'backward')
  ) {
    const startOld = Math.max(0, prevCenterIndex - half);
    const endOld = Math.min(lyricGroups.length - 1, prevCenterIndex + half);
    for (let idx = startOld; idx <= endOld; idx += 1) {
      if (idx < safeCenter - half || idx > safeCenter + half) {
        const exitDelta = idx - safeCenter; // <= -(half+1) or >= +(half+1)
        const role = exitDelta < 0 ? 'exiting-top' : 'exiting-bottom';
        items.push({
          groupIndex: idx,
          slotDelta: exitDelta,
          role,
          group: lyricGroups[idx],
          key: makeKey(idx, lyricGroups[idx]),
        });
        seen.add(idx);
      }
    }
  }

  for (let d = -half; d <= half; d += 1) {
    const idx = safeCenter + d;
    if (idx < 0 || idx >= lyricGroups.length || seen.has(idx)) {
      continue;
    }
    items.push({
      groupIndex: idx,
      slotDelta: d,
      role: resolveRoleForDelta(d),
      group: lyricGroups[idx],
      key: makeKey(idx, lyricGroups[idx]),
    });
    seen.add(idx);
  }

  return items;
}

/**
 * Pure 5-line radial lyric window builder (`-2..+2`), preserved for backward-compatible callers/tests.
 */
export function buildFocusFiveLineSlotItems(input: {
  lyricGroups: readonly TimedLyricGroup[];
  centerIndex: number;
  trackKey?: string;
  prevCenterIndex?: number | null;
  direction?: FocusLyricTransitionDirection;
}): FocusLyricSlotItem[] {
  return buildFocusWindowSlotItems({
    ...input,
    visibleSlotCount: 5,
  });
}

/**
 * Compatibility export helper preserving legacy callers/tests cleanly alongside generalized window API.
 */
export function buildFocusLyricSlotItems(input: {
  lyricGroups: readonly TimedLyricGroup[];
  activeIndex: number;
  exitingGroupIndex: number | null;
  direction: FocusLyricTransitionDirection;
}): FocusLyricSlotItem[] {
  const { lyricGroups, activeIndex, exitingGroupIndex, direction } = input;
  if (lyricGroups.length === 0) return [];
  const safeIdx = clampLyricGroupIndex(activeIndex, lyricGroups.length);
  const items: FocusLyricSlotItem[] = [];
  if (
    exitingGroupIndex !== null &&
    exitingGroupIndex >= 0 &&
    exitingGroupIndex < lyricGroups.length &&
    Math.abs(exitingGroupIndex - safeIdx) > 1 &&
    (direction === 'forward' || direction === 'backward')
  ) {
    items.push({
      groupIndex: exitingGroupIndex,
      slotDelta: direction === 'forward' ? -2 : 2,
      role: direction === 'forward' ? 'exiting-top' : 'exiting-bottom',
      group: lyricGroups[exitingGroupIndex],
      key: `focus-lyric-grp-${exitingGroupIndex}-${Math.round(lyricGroups[exitingGroupIndex].timeSec * 1000)}`,
    });
  }
  if (safeIdx > 0) {
    items.push({
      groupIndex: safeIdx - 1,
      slotDelta: -1,
      role: 'prev',
      group: lyricGroups[safeIdx - 1],
      key: `focus-lyric-grp-${safeIdx - 1}-${Math.round(lyricGroups[safeIdx - 1].timeSec * 1000)}`,
    });
  }
  items.push({
    groupIndex: safeIdx,
    slotDelta: 0,
    role: 'current',
    group: lyricGroups[safeIdx],
    key: `focus-lyric-grp-${safeIdx}-${Math.round(lyricGroups[safeIdx].timeSec * 1000)}`,
  });
  if (safeIdx + 1 < lyricGroups.length) {
    items.push({
      groupIndex: safeIdx + 1,
      slotDelta: 1,
      role: 'next',
      group: lyricGroups[safeIdx + 1],
      key: `focus-lyric-grp-${safeIdx + 1}-${Math.round(lyricGroups[safeIdx + 1].timeSec * 1000)}`,
    });
  }
  return items;
}

/**
 * Computes wheel delta step increment from raw deltaY across standard mice & smooth trackpads.
 */
export function accumulateLyricsWheelStep(
  prevDeltaPx: number,
  eventDeltaY: number,
  thresholdPx = 36,
): { stepCount: number; remainderPx: number } {
  if (!Number.isFinite(eventDeltaY) || eventDeltaY === 0) {
    return { stepCount: 0, remainderPx: prevDeltaPx };
  }
  const combined = prevDeltaPx + eventDeltaY;
  if (Math.abs(combined) < thresholdPx) {
    return { stepCount: 0, remainderPx: combined };
  }
  const rawSteps = Math.trunc(combined / thresholdPx);
  const clampedSteps = Math.max(-3, Math.min(3, rawSteps));
  const remainderPx = combined - rawSteps * thresholdPx;
  return { stepCount: clampedSteps, remainderPx };
}

function getSlotTestId(role: FocusLyricSlotRole): string | undefined {
  switch (role) {
    case 'prev4':
      return 'focus-lyric-prev4';
    case 'prev3':
      return 'focus-lyric-prev3';
    case 'prev2':
      return 'focus-lyric-prev2';
    case 'prev1':
      return 'focus-lyric-prev';
    case 'current':
      return 'focus-lyric-current';
    case 'next1':
      return 'focus-lyric-next';
    case 'next2':
      return 'focus-lyric-next2';
    case 'next3':
      return 'focus-lyric-next3';
    case 'next4':
      return 'focus-lyric-next4';
    default:
      return undefined;
  }
}

/**
 * Interactive 5/7/9-Line Radial Lyrics for Focus Vinyl (`Phase 4.2E–F` -> `Phase 4.3F–G`):
 * - Responsive odd slot count: `7` default desktop, `9` spacious desktop, `5` compact fallback.
 * - Center active lyric (`26–32px`) anchored prominently close below playback controls; outer lines
 *   step down gracefully (`20–24 / 18–20 / 16–18 / 14–16px`, decreasing opacity) with hover clarity.
 * - Per-slot curved horizontal offset (`dxPx`, `yPx`) along actual Focus vinyl arc contour.
 * - Preserves Browse Mode across window blur, minimize/restore, & 10s+ pauses (ZERO auto-timeout),
 *   syncing immediately without animation backlog upon returning from background.
 */
export const FocusMinimalLyrics = memo(function FocusMinimalLyrics({
  lyricGroups,
  activeGroupIndex,
  trackKey,
  isFocusActive,
  isWindowHidden = false,
  suppressResumeTransitions = false,
  persistedBrowseState = null,
  onBrowseStateChange,
  focusRadial,
  accentColor,
  textPrimary,
  textSecondary,
  textMuted,
  buttonBg,
  buttonFg,
  buttonBorder,
  transitionMs,
  onSeekToLine,
}: FocusMinimalLyricsProps) {
  const safeActiveIndex = clampLyricGroupIndex(activeGroupIndex, lyricGroups.length);

  const [isBrowseMode, setIsBrowseMode] = useState<boolean>(() =>
    Boolean(
      persistedBrowseState &&
        persistedBrowseState.trackId === trackKey &&
        lyricGroups.length > 0,
    ),
  );
  const [browseIndex, setBrowseIndex] = useState<number>(() =>
    persistedBrowseState && persistedBrowseState.trackId === trackKey
      ? clampLyricGroupIndex(persistedBrowseState.viewedIndex, lyricGroups.length)
      : safeActiveIndex,
  );
  const lastTrackKeyRef = useRef<string>(trackKey);
  const wheelAccumulatorRef = useRef(0);
  const wheelLastTickMsRef = useRef(0);

  const viewedIndex = isBrowseMode
    ? clampLyricGroupIndex(browseIndex, lyricGroups.length)
    : safeActiveIndex;

  // Reset Browse Mode STRICTLY when active track changes or Focus becomes inactive / lyrics empty.
  // Preserves Browse Mode + viewedIndex cleanly across blur, visibilitychange, background recovery,
  // metadata re-renders, and indefinite pause durations (10s+ UAT preserved).
  useEffect(() => {
    const resolved = resolveBrowseModeAcrossTrackOrResume({
      currentState: {
        trackId: lastTrackKeyRef.current,
        isBrowseMode,
        viewedIndex: browseIndex,
      },
      nextTrackId: trackKey,
      totalLyricGroups: lyricGroups.length,
      isFocusActive,
    });

    if (lastTrackKeyRef.current !== trackKey) {
      lastTrackKeyRef.current = trackKey;
      wheelAccumulatorRef.current = 0;
    }

    if (resolved.isBrowseMode !== isBrowseMode) {
      setIsBrowseMode(resolved.isBrowseMode);
    }
    if (resolved.viewedIndex !== browseIndex) {
      setBrowseIndex(resolved.viewedIndex);
    }
    if (!resolved.isBrowseMode && persistedBrowseState) {
      onBrowseStateChange?.(null);
    }
  }, [
    trackKey,
    lyricGroups.length,
    isFocusActive,
    isBrowseMode,
    browseIndex,
    persistedBrowseState,
    onBrowseStateChange,
  ]);

  const animateAllowed =
    transitionMs > 0 && !isWindowHidden && !suppressResumeTransitions && isFocusActive;
  const prevCenterRef = useRef<number | null>(viewedIndex);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enterRafRef = useRef<number | null>(null);
  const mountedSlotKeysRef = useRef<Set<string>>(new Set());
  const slotButtonRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const [measureRevision, setMeasureRevision] = useState(0);
  const [releasedEnterKeys, setReleasedEnterKeys] = useState<Set<string>>(() => new Set());
  const [animState, setAnimState] = useState<{
    prevCenter: number | null;
    direction: FocusLyricTransitionDirection;
    effectiveMs: number;
  }>({
    prevCenter: null,
    direction: 'idle',
    effectiveMs: 0,
  });

  // Reset per-track measurement cache cleanly on track switch without retaining unbounded keys
  useEffect(() => {
    measuredHeightsRef.current.clear();
    mountedSlotKeysRef.current.clear();
  }, [trackKey]);

  // Immediately cancel any in-flight lyric transition or rAF & snap cleanly when hidden / resuming
  useEffect(() => {
    if (isWindowHidden || suppressResumeTransitions) {
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }
      if (enterRafRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(enterRafRef.current);
        enterRafRef.current = null;
      }
      prevCenterRef.current = viewedIndex;
      setAnimState({ prevCenter: null, direction: 'idle', effectiveMs: 0 });
    }
  }, [isWindowHidden, suppressResumeTransitions, viewedIndex]);

  useEffect(() => {
    const prev = prevCenterRef.current;
    prevCenterRef.current = viewedIndex;
    if (transitionTimerRef.current) {
      clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }

    const dir = resolveFocusLyricTransitionDirection(prev, viewedIndex, animateAllowed);
    if (dir === 'idle' || !animateAllowed) {
      setAnimState({ prevCenter: null, direction: 'idle', effectiveMs: 0 });
      return;
    }

    let targetMs = isBrowseMode
      ? Math.min(250, Math.max(180, Math.round(transitionMs * 0.62)))
      : Math.max(320, Math.min(420, transitionMs));
    if (!isBrowseMode && prev !== null && lyricGroups[viewedIndex] && lyricGroups[prev]) {
      const timeGapMs = Math.abs(lyricGroups[viewedIndex].timeSec - lyricGroups[prev].timeSec) * 1000;
      if (timeGapMs > 120 && timeGapMs < targetMs) {
        targetMs = Math.max(160, Math.round(timeGapMs * 0.85));
      }
    }

    setAnimState({
      prevCenter: prev,
      direction: dir,
      effectiveMs: targetMs,
    });

    transitionTimerRef.current = setTimeout(() => {
      transitionTimerRef.current = null;
      setAnimState({ prevCenter: null, direction: 'idle', effectiveMs: targetMs });
    }, targetMs + 40);

    return () => {
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }
    };
  }, [viewedIndex, animateAllowed, transitionMs, isBrowseMode, lyricGroups]);

  useEffect(() => {
    prevCenterRef.current = viewedIndex;
  }, [trackKey]);

  const stepBrowseBy = useCallback(
    (steps: number) => {
      if (lyricGroups.length === 0 || steps === 0) return;
      const base = isBrowseMode ? browseIndex : safeActiveIndex;
      const nextIdx = clampLyricGroupIndex(base + steps, lyricGroups.length);
      setIsBrowseMode(true);
      setBrowseIndex(nextIdx);
      onBrowseStateChange?.({ trackId: trackKey, viewedIndex: nextIdx });
    },
    [lyricGroups.length, isBrowseMode, browseIndex, safeActiveIndex, trackKey, onBrowseStateChange],
  );

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (lyricGroups.length <= 1) return;
      event.stopPropagation();
      const now = Date.now();
      if (now - wheelLastTickMsRef.current > 240) {
        wheelAccumulatorRef.current = 0;
      }
      wheelLastTickMsRef.current = now;

      const { stepCount, remainderPx } = accumulateLyricsWheelStep(
        wheelAccumulatorRef.current,
        event.deltaY,
        36,
      );
      wheelAccumulatorRef.current = remainderPx;
      if (stepCount !== 0) {
        stepBrowseBy(stepCount);
      }
    },
    [lyricGroups.length, stepBrowseBy],
  );

  const handleContainerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (lyricGroups.length === 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        stepBrowseBy(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        stepBrowseBy(-1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        setIsBrowseMode(true);
        setBrowseIndex(0);
        onBrowseStateChange?.({ trackId: trackKey, viewedIndex: 0 });
      } else if (event.key === 'End') {
        event.preventDefault();
        const endIdx = lyricGroups.length - 1;
        setIsBrowseMode(true);
        setBrowseIndex(endIdx);
        onBrowseStateChange?.({ trackId: trackKey, viewedIndex: endIdx });
      }
    },
    [lyricGroups.length, stepBrowseBy, trackKey, onBrowseStateChange],
  );

  const handleLineClick = useCallback(
    (timeSec: number) => {
      setIsBrowseMode(false);
      onBrowseStateChange?.(null);
      onSeekToLine(timeSec);
    },
    [onSeekToLine, onBrowseStateChange],
  );

  const handleReturnToCurrentWithoutSeek = useCallback(() => {
    setIsBrowseMode(false);
    setBrowseIndex(safeActiveIndex);
    onBrowseStateChange?.(null);
    wheelAccumulatorRef.current = 0;
  }, [safeActiveIndex, onBrowseStateChange]);

  const { groupCLyrics, vinylRightEdgePx, minGapPx } = focusRadial;
  const focusArcRadiusPx = Math.max(120, groupCLyrics.guideRadius - minGapPx);
  const availableVerticalPx = Math.max(
    140,
    (groupCLyrics.maxWindowHeightPx || groupCLyrics.windowHeightPx) - (isBrowseMode ? 44 : 0),
  );

  const getCachedMeasuredHeight = useCallback(
    (groupIndex: number, fontSizePx: number, widthPx: number): number | undefined => {
      const bucketW = Math.round(widthPx / 16) * 16;
      return measuredHeightsRef.current.get(`${groupIndex}:${Math.round(fontSizePx)}:${bucketW}`);
    },
    [],
  );

  const multilineLayout = useMemo(
    () =>
      computeAdaptiveMultilineLyricLayout({
        lyricGroups,
        centerIndex: viewedIndex,
        preferredVisibleCount: groupCLyrics.visibleSlotCount,
        groupTopPx: groupCLyrics.topPx,
        maxWindowHeightPx: availableVerticalPx,
        maxWidthPx: groupCLyrics.maxWidthPx,
        baseLeftPx: groupCLyrics.baseLeftPx,
        guideCenterX: groupCLyrics.guideCenterX,
        guideCenterY: groupCLyrics.guideCenterY,
        guideRadius: groupCLyrics.guideRadius,
        focusArcRadiusPx,
        minGapPx,
        centerFontPx: groupCLyrics.centerFontPx,
        adjFontPx: groupCLyrics.adjFontPx,
        outerFontPx: groupCLyrics.outerFontPx,
        adj3FontPx: groupCLyrics.adj3FontPx ?? Math.max(15, groupCLyrics.outerFontPx - 2),
        farFontPx: groupCLyrics.farFontPx ?? Math.max(13, groupCLyrics.outerFontPx - 4),
        getMeasuredHeight: getCachedMeasuredHeight,
      }),
    [
      lyricGroups,
      viewedIndex,
      groupCLyrics,
      availableVerticalPx,
      focusArcRadiusPx,
      minGapPx,
      getCachedMeasuredHeight,
      measureRevision,
    ],
  );

  const effectiveSlotCount = multilineLayout.visibleSlotCount;

  const slots = useMemo(
    () =>
      buildFocusWindowSlotItems({
        lyricGroups,
        centerIndex: viewedIndex,
        visibleSlotCount: effectiveSlotCount,
        trackKey,
        prevCenterIndex: animState.prevCenter,
        direction: animState.direction,
      }),
    [
      lyricGroups,
      viewedIndex,
      effectiveSlotCount,
      trackKey,
      animState.prevCenter,
      animState.direction,
    ],
  );

  // Measure real wrapped button heights BEFORE browser paint (zero overlap + zero visual jump)
  // and release GPU entrance offsets cleanly on next animation frame.
  useLayoutEffect(() => {
    if (!isFocusActive || lyricGroups.length === 0) {
      return;
    }
    let dirty = false;
    const activeKeysNow = new Set<string>();
    const newlyMountedKeys: string[] = [];

    for (const slot of slots) {
      activeKeysNow.add(slot.key);
      if (!mountedSlotKeysRef.current.has(slot.key)) {
        newlyMountedKeys.push(slot.key);
      }
      if (slot.role === 'exiting-top' || slot.role === 'exiting-bottom') {
        continue;
      }
      const el = slotButtonRefs.current.get(slot.key);
      if (!el) continue;
      const pos = multilineLayout.positionsByDelta.get(slot.slotDelta);
      if (!pos) continue;
      const rectH = Math.ceil(el.getBoundingClientRect().height);
      if (rectH <= 8) continue;
      const bucketW = Math.round(pos.widthPx / 16) * 16;
      const cacheKey = `${slot.groupIndex}:${Math.round(pos.fontSizePx)}:${bucketW}`;
      const existing = measuredHeightsRef.current.get(cacheKey);
      if (existing === undefined || Math.abs(existing - rectH) >= 2) {
        measuredHeightsRef.current.set(cacheKey, rectH);
        dirty = true;
      }
    }

    for (const oldKey of Array.from(mountedSlotKeysRef.current)) {
      if (!activeKeysNow.has(oldKey)) {
        mountedSlotKeysRef.current.delete(oldKey);
      }
    }
    for (const k of activeKeysNow) {
      mountedSlotKeysRef.current.add(k);
    }

    if (dirty) {
      setMeasureRevision((r) => r + 1);
    }

    if (newlyMountedKeys.length > 0 && animateAllowed && animState.direction !== 'idle') {
      if (enterRafRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(enterRafRef.current);
      }
      if (typeof requestAnimationFrame === 'function') {
        enterRafRef.current = requestAnimationFrame(() => {
          enterRafRef.current = null;
          setReleasedEnterKeys((prev) => {
            const next = new Set(prev);
            for (const k of newlyMountedKeys) {
              next.add(k);
            }
            // Keep set tiny
            if (next.size > 48) {
              return new Set(newlyMountedKeys);
            }
            return next;
          });
        });
      }
    }
  }, [slots, multilineLayout, isFocusActive, lyricGroups.length, animateAllowed, animState.direction]);

  if (lyricGroups.length === 0) {
    return null;
  }

  const stageHeightPx = multilineLayout.stageHeightPx;
  const activeTransitionDuration =
    suppressResumeTransitions || isWindowHidden
      ? 0
      : animState.effectiveMs || (animateAllowed ? transitionMs : 0);
  const transitionCss =
    animateAllowed && activeTransitionDuration > 0
      ? `transform ${activeTransitionDuration}ms cubic-bezier(0.22, 1, 0.36, 1), opacity ${Math.round(activeTransitionDuration * 0.88)}ms cubic-bezier(0.22, 1, 0.36, 1)`
      : 'none';

  const visibleDeltas = Array.from(multilineLayout.positionsByDelta.keys());
  const topSlotPos =
    visibleDeltas.length > 0
      ? multilineLayout.positionsByDelta.get(Math.min(...visibleDeltas))
      : undefined;
  const botSlotPos =
    visibleDeltas.length > 0
      ? multilineLayout.positionsByDelta.get(Math.max(...visibleDeltas))
      : undefined;

  return (
    <div
      data-testid="focus-minimal-lyrics"
      data-lyrics-mode={isBrowseMode ? 'browse' : 'follow'}
      data-visible-slot-count={effectiveSlotCount}
      data-active-index={safeActiveIndex}
      data-viewed-index={viewedIndex}
      data-transition-direction={animState.direction}
      tabIndex={0}
      onWheel={handleWheel}
      onKeyDown={handleContainerKeyDown}
      aria-label={`Lời bài hát ${effectiveSlotCount} dòng đồng bộ (lăn chuột để xem trước/sau, nhấn vào câu hát để tua)`}
      className="relative select-none rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4"
      style={{ outlineColor: accentColor }}
    >
      <div
        className="relative w-full overflow-visible"
        style={{ height: `${stageHeightPx}px` }}
      >
        {slots.map((slot) => {
          const isExiting = slot.role === 'exiting-top' || slot.role === 'exiting-bottom';
          const isCenterSlot = slot.slotDelta === 0;
          const isRealPlayingLine = slot.groupIndex === safeActiveIndex;
          const absDist = Math.abs(slot.slotDelta);

          const layoutPos = multilineLayout.positionsByDelta.get(slot.slotDelta);
          let dxPx = layoutPos?.dxPx ?? 0;
          let yPx = layoutPos?.yPx ?? 0;
          let slotOpacity = layoutPos?.opacity ?? (isCenterSlot ? 1 : absDist === 1 ? 0.66 : 0.3);
          let slotFontSize = layoutPos?.fontSizePx ?? groupCLyrics.centerFontPx;
          let slotWidthPx = layoutPos?.widthPx ?? groupCLyrics.maxWidthPx;

          if (isExiting || !layoutPos) {
            const fallbackExit = computeRadialCurvedLyricSlotPosition({
              slotDelta: slot.slotDelta,
              groupTopPx: groupCLyrics.topPx,
              slotStepY: multilineLayout.avgSlotStepY,
              baseLeftPx: groupCLyrics.baseLeftPx,
              guideCenterX: groupCLyrics.guideCenterX,
              guideCenterY: groupCLyrics.guideCenterY,
              guideRadius: groupCLyrics.guideRadius,
              vinylRightEdgePx,
              minGapPx,
              visibleSlotCount:
                effectiveSlotCount >= 9 ? 9 : effectiveSlotCount >= 7 ? 7 : 5,
              focusArcRadiusPx,
            });
            dxPx = fallbackExit.dxPx;
            yPx =
              slot.slotDelta < 0 && topSlotPos
                ? Math.max(-42, topSlotPos.yPx - Math.round(multilineLayout.avgSlotStepY * 0.85))
                : slot.slotDelta > 0 && botSlotPos
                  ? botSlotPos.yPx + botSlotPos.heightPx + 10
                  : fallbackExit.yPx;
            slotOpacity = 0;
            slotFontSize =
              groupCLyrics.farFontPx ?? Math.max(13, groupCLyrics.outerFontPx - 4);
            slotWidthPx = Math.max(240, groupCLyrics.maxWidthPx - Math.max(0, dxPx));
          }

          // Smooth newly entering outer slot arrival (avoids sudden pop-in while sliding)
          const isPendingEnterStart =
            !isExiting &&
            animateAllowed &&
            (animState.direction === 'forward' || animState.direction === 'backward') &&
            !mountedSlotKeysRef.current.has(slot.key) &&
            !releasedEnterKeys.has(slot.key);

          const renderYPx = isPendingEnterStart
            ? yPx + (animState.direction === 'forward' ? 24 : -24)
            : yPx;
          const renderOpacity = isExiting || isPendingEnterStart ? 0 : slotOpacity;
          const effectiveTransitionCss = isPendingEnterStart ? 'none' : transitionCss;

          const slotWeight = isCenterSlot ? 650 : absDist === 1 ? 500 : 400;
          const slotColor = isCenterSlot
            ? textPrimary
            : absDist <= 1
              ? textSecondary
              : textMuted;

          const testId = getSlotTestId(slot.role);

          return (
            <button
              key={slot.key}
              ref={(el) => {
                if (el) slotButtonRefs.current.set(slot.key, el);
                else slotButtonRefs.current.delete(slot.key);
              }}
              type="button"
              data-testid={testId}
              data-lyric-index={slot.groupIndex}
              data-slot-delta={slot.slotDelta}
              data-slot-dx={dxPx}
              data-slot-y={yPx}
              data-playing-line={isRealPlayingLine ? 'true' : 'false'}
              aria-current={isRealPlayingLine ? 'true' : undefined}
              aria-hidden={isExiting}
              tabIndex={isExiting ? -1 : 0}
              disabled={isExiting}
              onClick={() => handleLineClick(slot.group.timeSec)}
              title={
                isBrowseMode && isRealPlayingLine
                  ? 'Câu đang phát · Nhấn để tua lại câu này'
                  : 'Nhấn để tua tới đoạn lời này'
              }
              className={`lp-lyrics-text group absolute top-0 left-0 flex w-full origin-left items-baseline gap-2.5 text-left focus-visible:outline-none focus-visible:underline ${
                isExiting
                  ? 'pointer-events-none'
                  : 'pointer-events-auto cursor-pointer hover:!opacity-100 focus-visible:!opacity-100'
              }`}
              style={{
                maxWidth: `${slotWidthPx}px`,
                transform: `translate3d(${dxPx}px, ${renderYPx}px, 0)`,
                opacity: renderOpacity,
                color: isRealPlayingLine && isBrowseMode && !isCenterSlot ? accentColor : slotColor,
                transition: effectiveTransitionCss,
                willChange: animateAllowed ? 'transform, opacity' : 'auto',
              }}
            >
              {isBrowseMode && isRealPlayingLine && (
                <span
                  aria-hidden="true"
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: accentColor }}
                />
              )}

              <span className="min-w-0 flex-1">
                {slot.group.lines.map((lineText, subIdx) => (
                  <span
                    key={`${slot.key}-${subIdx}`}
                    className={
                      subIdx === 0
                        ? `block whitespace-normal leading-[1.28] tracking-[-0.01em] ${isCenterSlot ? 'line-clamp-3' : 'line-clamp-2'}`
                        : 'mt-0.5 block whitespace-normal line-clamp-2 leading-[1.24] opacity-84'
                    }
                    style={{
                      fontSize:
                        subIdx === 0
                          ? `${slotFontSize}px`
                          : `${Math.max(12, slotFontSize - 5)}px`,
                      fontWeight: subIdx === 0 ? slotWeight : 400,
                    }}
                  >
                    {lineText}
                  </span>
                ))}
              </span>
            </button>
          );
        })}
      </div>

      {/* Compact Floating "Return to Current Lyric" Pill — strictly outside lyric slots (§58) */}
      {isBrowseMode && (
        <div className="pointer-events-none relative mt-2 flex items-center">
          <button
            type="button"
            data-testid="focus-return-to-active-lyric"
            onClick={handleReturnToCurrentWithoutSeek}
            style={{
              backgroundColor: buttonBg,
              color: buttonFg,
              borderColor: buttonBorder,
            }}
            className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[12px] font-medium backdrop-blur-md transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <RotateCcw className="h-3.5 w-3.5" style={{ color: accentColor }} />
            <span>Quay lại lời đang phát</span>
          </button>
        </div>
      )}
    </div>
  );
});
