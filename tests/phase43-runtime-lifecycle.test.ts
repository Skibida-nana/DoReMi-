import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  applyExplicitModeSelection,
  completeModeTransitionIfCurrent,
  createAuthoritativePresentationState,
  readSessionPresentation,
  rebaseRotationAngleAfterPause,
  resolveBrowseModeAcrossTrackOrResume,
  resolveModeAfterBackgroundInterruption,
  SESSION_PRESENTATION_STORAGE_KEY,
  stepForegroundResumeLifecycle,
  writeSessionPresentation,
} from '../src/renderer/src/utils/presentation-lifecycle';
import {
  VinylSwapController,
  type PhysicalVinylPhase,
  type SwapScheduler,
} from '../src/renderer/src/utils/vinyl-swap-controller';

class FakeClockScheduler implements SwapScheduler {
  now = 0;
  private nextId = 1;
  private tasks = new Map<number, { runAt: number; fn: () => void }>();

  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { runAt: this.now + ms, fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  advanceBy(ms: number): void {
    const target = this.now + ms;
    while (true) {
      let earliestId: number | null = null;
      let earliestTime = Infinity;
      for (const [id, task] of this.tasks.entries()) {
        if (task.runAt <= target && task.runAt < earliestTime) {
          earliestTime = task.runAt;
          earliestId = id;
        }
      }
      if (earliestId === null) {
        break;
      }
      const task = this.tasks.get(earliestId);
      this.tasks.delete(earliestId);
      this.now = earliestTime;
      task?.fn();
    }
    this.now = target;
  }
}

test('Phase 4.3A–B: Authoritative Presentation Mode locks user Focus Vinyl selection across background interruptions', () => {
  let state = createAuthoritativePresentationState('standard');
  assert.equal(state.targetMode, 'standard');

  // User explicitly chooses Focus Vinyl (900ms transition starts)
  state = applyExplicitModeSelection(state, 'focus', 900);
  const focusGen = state.modeGeneration;
  assert.equal(state.targetMode, 'focus');
  assert.equal(state.isTransitioning, true);

  // If background hide/minimize interrupts the in-flight transition, it MUST settle to 'focus' — never revert to 'standard'
  state = resolveModeAfterBackgroundInterruption(state);
  assert.equal(state.targetMode, 'focus');
  assert.equal(state.committedMode, 'focus');
  assert.equal(state.isTransitioning, false);

  // Stale transition-end callback from the interrupted generation is ignored safely
  const afterStaleCallback = completeModeTransitionIfCurrent(state, focusGen);
  assert.equal(afterStaleCallback.committedMode, 'focus');
  assert.equal(afterStaleCallback.modeGeneration, state.modeGeneration);
});

test('Phase 4.3A: Foreground resume lifecycle deduplicates events and avoids resetting on simple window blur/focus', () => {
  let life = {
    isHidden: false,
    hiddenCycleCount: 0,
    resumeGeneration: 0,
    shouldSnapNextPaint: false,
  };

  // Plain Alt+Tab where app remains visible on another monitor or un-minimized focus change
  const rBlur = stepForegroundResumeLifecycle(life, 'window-blur');
  life = rBlur.nextState;
  assert.equal(rBlur.didEnterHidden, false);
  assert.equal(rBlur.didLeaveHidden, false);
  assert.equal(life.shouldSnapNextPaint, false);

  const rPlainFocus = stepForegroundResumeLifecycle(life, 'window-focus');
  life = rPlainFocus.nextState;
  assert.equal(rPlainFocus.didLeaveHidden, false);
  assert.equal(life.shouldSnapNextPaint, false);

  // Minimize / occlude -> hide once (duplicate hide is no-op)
  const rHide1 = stepForegroundResumeLifecycle(life, 'hide');
  life = rHide1.nextState;
  assert.equal(rHide1.didEnterHidden, true);
  assert.equal(life.isHidden, true);
  assert.equal(life.hiddenCycleCount, 1);

  const rHideDup = stepForegroundResumeLifecycle(life, 'hide');
  assert.equal(rHideDup.didEnterHidden, false);
  assert.equal(rHideDup.nextState.hiddenCycleCount, 1);

  // Return to foreground triggers single-frame snap ONCE; stale token cannot clear newer generation
  const staleToken = life.resumeGeneration;
  const rShow = stepForegroundResumeLifecycle(life, 'show');
  life = rShow.nextState;
  assert.equal(rShow.didLeaveHidden, true);
  assert.equal(life.shouldSnapNextPaint, true);

  const rSecondFocusBurst = stepForegroundResumeLifecycle(life, 'window-focus');
  assert.equal(rSecondFocusBurst.didLeaveHidden, false);

  const rStaleSnapDone = stepForegroundResumeLifecycle(life, 'snap-complete', staleToken);
  assert.equal(rStaleSnapDone.nextState.shouldSnapNextPaint, true);

  const rValidSnapDone = stepForegroundResumeLifecycle(life, 'snap-complete', life.resumeGeneration);
  assert.equal(rValidSnapDone.nextState.shouldSnapNextPaint, false);
});

test('Phase 4.3A–C: VinylSwapController.settleImmediately cancels background queued timers with zero stale replay', () => {
  const clock = new FakeClockScheduler();
  const controller = new VinylSwapController('track-A', clock);
  const phasesAfterSettle: Array<{ phase: PhysicalVinylPhase; displayed: string }> = [];

  controller.transitionTo('track-B', true);
  clock.advanceBy(180); // mid disc-lift / disc-exit
  assert.notEqual(controller.getSnapshot().phase, 'idle');

  controller.settleImmediately();
  assert.equal(controller.getSnapshot().phase, 'idle');
  assert.equal(controller.getSnapshot().displayedTrackId, 'track-B');
  assert.equal(controller.getSnapshot().targetTrackId, 'track-B');

  controller.subscribe((snap) => {
    phasesAfterSettle.push({ phase: snap.phase, displayed: snap.displayedTrackId });
  });
  clock.advanceBy(2500);
  // subscribe only fires on changes; ZERO delayed timers fire afterward
  assert.equal(phasesAfterSettle.length, 0);

  // Optional override track settles directly
  controller.transitionTo('track-C', true);
  controller.settleImmediately('track-D');
  assert.equal(controller.getSnapshot().phase, 'idle');
  assert.equal(controller.getSnapshot().displayedTrackId, 'track-D');
});

test('Phase 4.3B & 4.3G: Browse Mode persists on same track across blur/hide/long pauses and resets only on track change', () => {
  const initialBrowse = { trackId: 'song-1', isBrowseMode: true, viewedIndex: 14 };

  // Same track after blur/hide/resume and 20s active playback -> MUST preserve Browse Mode
  const resumed = resolveBrowseModeAcrossTrackOrResume({
    currentState: initialBrowse,
    nextTrackId: 'song-1',
    totalLyricGroups: 28,
    isFocusActive: true,
  });
  assert.deepEqual(resumed, { trackId: 'song-1', isBrowseMode: true, viewedIndex: 14 });

  // Track changes -> resets cleanly to Follow Mode
  const changed = resolveBrowseModeAcrossTrackOrResume({
    currentState: resumed,
    nextTrackId: 'song-2',
    totalLyricGroups: 24,
    isFocusActive: true,
  });
  assert.deepEqual(changed, { trackId: 'song-2', isBrowseMode: false, viewedIndex: 0 });
});

test('Phase 4.3C & Session Snapshot: Rotation delta clamp & sessionStorage round-trip stay valid', () => {
  assert.equal(rebaseRotationAngleAfterPause(350, 12, 180), 2);
  assert.equal(rebaseRotationAngleAfterPause(45, 12, -10), 45);
  assert.equal(rebaseRotationAngleAfterPause(90, 12, Number.NaN), 90);

  const mem = new Map<string, string>();
  const mockStorage: Pick<Storage, 'getItem' | 'setItem'> = {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => {
      mem.set(k, v);
    },
  };

  writeSessionPresentation(
    {
      route: 'now-playing',
      previousRoute: 'home',
      nowPlayingMode: 'focus',
      nowPlayingRightTab: 'lyrics',
      focusLyricsBrowse: { trackId: 'track-9', viewedIndex: 6 },
    },
    mockStorage,
  );
  assert.ok(mem.has(SESSION_PRESENTATION_STORAGE_KEY));

  const restored = readSessionPresentation(mockStorage);
  assert.equal(restored?.route, 'now-playing');
  assert.equal(restored?.previousRoute, 'home');
  assert.equal(restored?.nowPlayingMode, 'focus');
  assert.equal(restored?.nowPlayingRightTab, 'lyrics');
  assert.deepEqual(restored?.focusLyricsBrowse, { trackId: 'track-9', viewedIndex: 6 });
});

test('Phase 4.3A–H Runtime & Resource Policy Contracts in Source Files', () => {
  const mainWin = fs.readFileSync(
    path.resolve(process.cwd(), 'src/main/windows/main-window.ts'),
    'utf8',
  );
  const nowPlaying = fs.readFileSync(
    path.resolve(process.cwd(), 'src/renderer/src/pages/NowPlayingPage.tsx'),
    'utf8',
  );
  const focusLyrics = fs.readFileSync(
    path.resolve(process.cwd(), 'src/renderer/src/components/FocusMinimalLyrics.tsx'),
    'utf8',
  );
  const indexCss = fs.readFileSync(
    path.resolve(process.cwd(), 'src/renderer/src/styles/index.css'),
    'utf8',
  );
  const uiStore = fs.readFileSync(
    path.resolve(process.cwd(), 'src/renderer/src/stores/ui-store.ts'),
    'utf8',
  );

  // 4.3A: MUST NOT disable Chromium background throttling (`backgroundThrottling: false`)
  assert.equal(/backgroundThrottling\s*:\s*false/.test(mainWin), false);
  // Security baseline intact
  assert.match(mainWin, /nodeIntegration:\s*false/);
  assert.match(mainWin, /contextIsolation:\s*true/);
  assert.match(mainWin, /sandbox:\s*true/);

  // 4.3B: Header Focus toggle uses distinct React keys + Escape ignores open menus/dialogs/overlay sidebar
  assert.match(nowPlaying, /key="hdr-exit-focus"/);
  assert.match(nowPlaying, /key="hdr-enter-focus"/);
  assert.match(nowPlaying, /nowPlayingSidebarRevealed/);
  assert.match(nowPlaying, /role="dialog"/);

  // 4.3C: Resume transition suppression CSS & TSX hooks wired
  assert.match(indexCss, /\[data-resume-sync='true'\]\s+\.lp-resume-snap-target/);
  assert.match(nowPlaying, /shouldSnapResume/);
  assert.match(nowPlaying, /settleImmediately/);

  // 4.3G: Browse Mode has zero auto-return idle timeout and reports parent sync cleanly
  assert.match(focusLyrics, /onBrowseStateChange/);
  assert.equal(/BROWSE_AUTO_RETURN|browseTimeout/i.test(focusLyrics), false);

  // 4.4B: Simplified full-cover blurred artwork backdrop replaces multi-layer edge continuation
  assert.match(nowPlaying, /focus-artwork-ambient-wash/);
  assert.match(nowPlaying, /object-cover/);
  assert.equal(/focus-edge-continuation-backdrop/.test(nowPlaying), false);

  // 4.3B: Session presentation persistence integrated in ui-store without replacing SQLite preferences
  assert.match(uiStore, /readSessionPresentation/);
  assert.match(uiStore, /writeSessionPresentation/);
  assert.match(uiStore, /setFocusLyricsBrowseState/);
});
