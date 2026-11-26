import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  computeAnchoredPopoverPosition,
  OVERLAY_Z_INDEX,
} from '../src/renderer/src/components/OverlayLayer';
import { computeQueueWindowSlice } from '../src/renderer/src/utils/queue-virtualization';
import { PlaybackQueueController } from '../src/renderer/src/player/playback-queue';
import type { PlaybackContextDescriptor } from '../src/shared/types/player';
import {
  computeAdaptiveMultilineLyricLayout,
  computeFocusRadialLayout,
  computeUnifiedVinylPlacement,
  estimateLyricGroupHeightPx,
} from '../src/renderer/src/utils/focus-radial-layout';

test('Phase 4.4E: True Shuffle includes ALL unplayed tracks even when started mid-context & produces fresh random orders', () => {
  const controller = new PlaybackQueueController();
  const context: PlaybackContextDescriptor = {
    contextId: 'album-10',
    label: '10-Track Album',
    kind: 'album',
    trackIds: Array.from({ length: 10 }, (_, i) => `track-${i}`),
  };

  // Start sequentially on Track #6 (index 6 out of 10): tracks 0..5 were NEVER played
  controller.startContext({
    context,
    startIndex: 6,
    shuffle: false,
  });
  controller.markCurrentPlaybackStarted();
  assert.equal(controller.getState().currentEntry?.trackId, 'track-6');
  assert.deepEqual(
    controller.getState().upcoming.map((e) => e.trackId),
    ['track-7', 'track-8', 'track-9'],
  );
  // Preceding unplayed tracks remain visible in sourceContextBefore without polluting history
  assert.deepEqual(
    controller.getState().sourceContextBefore?.map((e) => e.trackId),
    ['track-0', 'track-1', 'track-2', 'track-3', 'track-4', 'track-5'],
  );
  assert.equal(controller.getState().history.length, 0);

  // Turn Shuffle ON: MUST include all 9 unplayed tracks (0..5 and 7..9), ZERO duplicates, ZERO restart!
  controller.setShuffle(true);
  const shuffled1 = controller.getState();
  assert.equal(shuffled1.currentEntry?.trackId, 'track-6');
  assert.equal(shuffled1.upcoming.length, 9);
  assert.equal(new Set(shuffled1.upcoming.map((e) => e.trackId)).size, 9);
  assert.equal(
    shuffled1.upcoming.some((e) => e.trackId === 'track-6'),
    false,
  );
  assert.equal(shuffled1.sourceContextBefore?.length ?? 0, 0);

  // Toggle Shuffle OFF -> Shuffle ON again: MUST generate a distinct fresh permutation (real randomness)
  const order1 = shuffled1.upcoming.map((e) => e.trackId).join(',');
  controller.setShuffle(false);
  controller.setShuffle(true);
  const order2 = controller
    .getState()
    .upcoming.map((e) => e.trackId)
    .join(',');
  assert.notEqual(order1, order2, 'Re-enabling Shuffle must generate a fresh random order');

  // Re-selecting a track via startContext generates another independent random sequence
  controller.startContext({
    context,
    startTrackId: 'track-2',
    shuffle: true,
  });
  const sNew = controller.getState();
  assert.equal(sNew.currentEntry?.trackId, 'track-2');
  assert.equal(sNew.upcoming.length, 9);
  assert.equal(
    sNew.upcoming.some((e) => e.trackId === 'track-2'),
    false,
  );
});

test('Phase 4.4F: Turning Shuffle OFF restores exact original source order with current track at its real index and zero fake history', () => {
  const controller = new PlaybackQueueController({
    initialControls: { repeatMode: 'twice', autoNextEnabled: true, shuffleEnabled: false },
  });
  const context: PlaybackContextDescriptor = {
    contextId: 'pl-restore',
    label: 'Restore Source Order',
    kind: 'playlist',
    trackIds: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  };

  controller.startContext({ context, startIndex: 0, shuffle: true });
  controller.markCurrentPlaybackStarted(); // A (idx 0) played

  // Advance manually twice in shuffle, add Play Next priority & Manual tail, consume 1 finite repeat replay
  controller.advanceManualNext();
  controller.markCurrentPlaybackStarted();
  controller.resolveNaturalTrackEnd(); // triggers 'replay' -> decrements remainingReplays from 2 -> 1!
  assert.equal(controller.getState().repeatRuntime.remainingReplays, 1);

  // Jump specifically to 'E' (index 4) via context picker to simulate mid-list current track during shuffle
  controller.playContextIndexNow(4);
  controller.markCurrentPlaybackStarted();
  controller.resolveNaturalTrackEnd(); // remainingReplays 2 -> 1
  const replaysBeforeUnshuffle = controller.getState().repeatRuntime.remainingReplays;
  const historyLenBefore = controller.getState().history.length;

  const pn = controller.playNext('PRIORITY_X');
  const tail = controller.addToQueue('MANUAL_Z');

  // Turn Shuffle OFF -> 'E' (idx 4) sits cleanly between [A, B, C, D] before & [F, G, H] after!
  controller.setShuffle(false);
  const restored = controller.getState();

  assert.equal(restored.controls.shuffleEnabled, false);
  assert.equal(restored.currentEntry?.trackId, 'E');
  // Repeat counter & history length NOT mutated or reset
  assert.equal(restored.repeatRuntime.remainingReplays, replaysBeforeUnshuffle);
  assert.equal(restored.history.length, historyLenBefore);

  // Preceding source tracks before 'E' (A, B, C, D) preserve exact source order without falsely flagging unplayed B/C/D!
  const beforeIds = restored.sourceContextBefore?.map((e) => e.trackId);
  assert.deepEqual(beforeIds, ['A', 'B', 'C', 'D']);
  const cEntry = restored.sourceContextBefore?.find((e) => e.trackId === 'C');
  assert.equal(cEntry?.historyStatus, undefined, 'Unplayed preceding track C must NOT be marked as played');

  // Upcoming plays E's sequential followers [PRIORITY_X, F, G, H, MANUAL_Z] — NEVER jumping backward to A/B/C!
  assert.deepEqual(
    restored.upcoming.map((e) => e.trackId),
    ['PRIORITY_X', 'F', 'G', 'H', 'MANUAL_Z'],
  );
  assert.equal(restored.upcoming[0].queueEntryId, pn.queueEntryId);
  assert.equal(restored.upcoming[restored.upcoming.length - 1].queueEntryId, tail.queueEntryId);

  // Clicking a preceding source track ('B' at index 1) puts [A] before & [PRIORITY_X, C..H, MANUAL_Z] after cleanly
  controller.playContextIndexNow(1);
  const jumped = controller.getState();
  assert.equal(jumped.currentEntry?.trackId, 'B');
  assert.deepEqual(
    jumped.sourceContextBefore?.map((e) => e.trackId),
    ['A'],
  );
  assert.deepEqual(
    jumped.upcoming.map((e) => e.trackId),
    ['PRIORITY_X', 'C', 'D', 'E', 'F', 'G', 'H', 'MANUAL_Z'],
  );
});

test('Phase 4.4G: Queue window slicing skips small lists and cleanly virtualizes 500-2000 track queues', () => {
  const small = computeQueueWindowSlice({
    totalItems: 35,
    itemHeightPx: 54,
    scrollOffsetPx: 0,
    viewportHeightPx: 520,
  });
  assert.equal(small.virtualized, false);
  assert.equal(small.startIndex, 0);
  assert.equal(small.endIndex, 35);
  assert.equal(small.topSpacerPx, 0);
  assert.equal(small.bottomSpacerPx, 0);

  const large = computeQueueWindowSlice({
    totalItems: 1000,
    itemHeightPx: 54,
    scrollOffsetPx: 54 * 400,
    viewportHeightPx: 540,
    overscanCount: 12,
  });
  assert.equal(large.virtualized, true);
  assert.equal(large.startIndex, 388);
  assert.equal(large.endIndex, 422);
  assert.equal(large.topSpacerPx + (large.endIndex - large.startIndex) * 54 + large.bottomSpacerPx, 1000 * 54);
});

test('Phase 4.4C: Multiline radial lyrics dynamically allocate non-overlapping height, follow arc curvature, and adapt 9->7->5 gracefully', () => {
  const focus = computeUnifiedVinylPlacement({
    viewportWidth: 1366,
    viewportHeight: 768,
    isFocusMode: true,
  });
  const radial = computeFocusRadialLayout({
    viewportWidth: 1366,
    viewportHeight: 768,
    placement: focus,
    hasLyrics: true,
    hasMultilineLyrics: true,
  });

  // Bilingual & long wrapped consecutive lyrics
  const multilineGroups = Array.from({ length: 14 }, (_, i) => ({
    lines: [
      `This is an expressive multiline lyric verse number ${i} that wraps naturally onto two lines on desktop`,
      `Đây là dòng dịch song ngữ thứ ${i} nằm gọn phía dưới câu chính mà không hề bị đè chữ`,
    ],
  }));

  const hSingle = estimateLyricGroupHeightPx(['Short line'], 26, 460, true);
  const hMulti = estimateLyricGroupHeightPx(multilineGroups[0].lines, 26, 460, true);
  assert.ok(hMulti > hSingle + 24);

  const ml = computeAdaptiveMultilineLyricLayout({
    lyricGroups: multilineGroups,
    centerIndex: 6,
    preferredVisibleCount: radial.groupCLyrics.visibleSlotCount,
    groupTopPx: radial.groupCLyrics.topPx,
    maxWindowHeightPx: radial.groupCLyrics.maxWindowHeightPx,
    maxWidthPx: radial.groupCLyrics.maxWidthPx,
    baseLeftPx: radial.groupCLyrics.baseLeftPx,
    guideCenterX: radial.groupCLyrics.guideCenterX,
    guideCenterY: radial.groupCLyrics.guideCenterY,
    guideRadius: radial.groupCLyrics.guideRadius,
    focusArcRadiusPx: focus.focusArcRadiusPx,
    minGapPx: radial.minGapPx,
    centerFontPx: radial.groupCLyrics.centerFontPx,
    adjFontPx: radial.groupCLyrics.adjFontPx,
    outerFontPx: radial.groupCLyrics.outerFontPx,
    adj3FontPx: radial.groupCLyrics.adj3FontPx,
    farFontPx: radial.groupCLyrics.farFontPx,
  });

  // Automatically adapts down from 9 when consecutive tall bilingual lines would otherwise overflow or push active line too low
  assert.ok(ml.visibleSlotCount <= 7 && ml.visibleSlotCount >= 3);
  const ordered = Array.from(ml.positionsByDelta.values()).sort((a, b) => a.slotDelta - b.slotDelta);
  // STRICT ZERO-OVERLAP INVARIANT across consecutive multiline groups
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const upper = ordered[i];
    const lower = ordered[i + 1];
    assert.ok(
      lower.yPx >= upper.yPx + upper.heightPx + 8,
      `Multiline overlap detected between delta ${upper.slotDelta} (y=${upper.yPx}, h=${upper.heightPx}) and ${lower.slotDelta} (y=${lower.yPx})`,
    );
  }
  // Curved radial contour preserved on expanded multiline stack
  assert.notEqual(ordered[0].dxPx, ordered[ordered.length - 1].dxPx);
  // Visual opacity falloff: center strictly brighter than neighbors
  const centerPos = ml.positionsByDelta.get(0)!;
  assert.equal(centerPos.opacity, 1.0);
  assert.ok(ml.positionsByDelta.get(1)!.opacity < 0.72 && ml.positionsByDelta.get(1)!.opacity >= 0.6);
});

test('Phase 4.4H: Global Overlay Layer math flips/clamps cleanly & Statistics/Popovers/Modals use OverlayLayer portal architecture', () => {
  // Ordered semantic z-index layers
  assert.ok(OVERLAY_Z_INDEX.popover < OVERLAY_Z_INDEX.tooltip);
  assert.ok(OVERLAY_Z_INDEX.tooltip < OVERLAY_Z_INDEX.modal);
  assert.ok(OVERLAY_Z_INDEX.modal < OVERLAY_Z_INDEX.toast);

  // Flips from bottom to top when anchor sits near bottom edge of screen
  const bottomFlipped = computeAnchoredPopoverPosition({
    anchor: { top: 690, left: 900, right: 1020, bottom: 726, width: 120, height: 36 },
    panelWidth: 288,
    panelHeight: 240,
    viewportWidth: 1366,
    viewportHeight: 768,
    placement: 'bottom',
    align: 'end',
  });
  assert.equal(bottomFlipped.actualPlacement, 'top');
  assert.ok(bottomFlipped.top >= 12 && bottomFlipped.top < 690);
  assert.ok(bottomFlipped.left >= 12 && bottomFlipped.left + 288 <= 1354);

  // Contracts across Stats, Popovers, Queue, NowPlaying, App & Modals
  const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
  assert.match(read('src/renderer/src/app/App.tsx'), /OverlayHostProvider/);
  assert.match(read('src/renderer/src/pages/StatisticsPage.tsx'), /AnchoredPopover/);
  assert.match(read('src/renderer/src/components/PlaybackOptionsPopover.tsx'), /AnchoredPopover/);
  assert.match(read('src/renderer/src/components/QuickEqPopover.tsx'), /AnchoredPopover/);
  assert.match(read('src/renderer/src/components/PlaybackTransitionControl.tsx'), /AnchoredPopover/);
  assert.match(read('src/renderer/src/components/PlaybackQueuePanel.tsx'), /AnchoredPopover/);
  assert.match(read('src/renderer/src/components/TrackMetadataModal.tsx'), /OverlayPortal layer="modal"/);
  assert.match(read('src/renderer/src/components/PlaylistPickerModal.tsx'), /OverlayPortal layer="modal"/);
  assert.match(read('src/renderer/src/components/LibrarySourcesAndMissingModal.tsx'), /OverlayPortal layer="modal"/);
  assert.match(read('src/renderer/src/pages/HomePage.tsx'), /OverlayPortal layer="modal"/);
  assert.match(read('src/renderer/src/pages/LibraryPage.tsx'), /OverlayPortal layer="modal"/);
  assert.match(read('src/renderer/src/pages/NowPlayingPage.tsx'), /OverlayPortal layer="modal"/);
});
