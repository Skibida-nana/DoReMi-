import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOTAL_VINYL_SWAP_MS,
  VINYL_SWAP_TIMINGS,
  VinylSwapController,
  parseLyricsInput,
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

describe('VinylSwapController physical swap state machine', () => {
  it('runs the full 8-step swap sequence (~1.08s) with a guaranteed 140ms empty-platter state', () => {
    assert.ok(TOTAL_VINYL_SWAP_MS >= 1000 && TOTAL_VINYL_SWAP_MS <= 1200);
    assert.ok(VINYL_SWAP_TIMINGS.emptyPlatterMs >= 100 && VINYL_SWAP_TIMINGS.emptyPlatterMs <= 150);

    const clock = new FakeClockScheduler();
    const controller = new VinylSwapController('track-A', clock);
    const seenPhases: Array<{ phase: PhysicalVinylPhase; displayed: string }> = [];

    controller.subscribe((snap) => {
      seenPhases.push({ phase: snap.phase, displayed: snap.displayedTrackId });
    });

    controller.transitionTo('track-B', true);
    clock.advanceBy(1200);

    assert.deepEqual(
      seenPhases.map((s) => s.phase),
      [
        'tonearm-lift',
        'disc-lift',
        'disc-exit',
        'empty-platter',
        'disc-enter',
        'disc-settle',
        'tonearm-drop',
        'idle',
      ],
    );

    // Old artwork stays on disc until empty-platter finishes; new artwork enters on disc-enter
    assert.equal(seenPhases[0].displayed, 'track-A');
    assert.equal(seenPhases[1].displayed, 'track-A');
    assert.equal(seenPhases[2].displayed, 'track-A');
    assert.equal(seenPhases[3].displayed, 'track-A'); // empty-platter (disc hidden)
    assert.equal(seenPhases[4].displayed, 'track-B'); // disc-enter brings track-B
    assert.equal(controller.getSnapshot().displayedTrackId, 'track-B');
    assert.equal(controller.getSnapshot().phase, 'idle');
  });

  it('cancels stale timers safely on rapid Next/Next/Next and always lands on latest track artwork', () => {
    const clock = new FakeClockScheduler();
    const controller = new VinylSwapController('track-1', clock);

    controller.transitionTo('track-2', true);
    clock.advanceBy(220); // mid disc-lift
    controller.transitionTo('track-3', true);
    clock.advanceBy(420); // mid disc-exit / empty-platter
    controller.transitionTo('track-4', true);
    clock.advanceBy(1500);

    assert.equal(controller.getSnapshot().displayedTrackId, 'track-4');
    assert.equal(controller.getSnapshot().targetTrackId, 'track-4');
    assert.equal(controller.getSnapshot().phase, 'idle');
    assert.equal(controller.getSnapshot().isSwapping, false);
  });

  it('swaps immediately when animation is disabled (Reduced Motion)', () => {
    const clock = new FakeClockScheduler();
    const controller = new VinylSwapController('track-A', clock);
    controller.transitionTo('track-B', false);

    assert.equal(controller.getSnapshot().displayedTrackId, 'track-B');
    assert.equal(controller.getSnapshot().phase, 'idle');
    assert.equal(controller.getSnapshot().isSwapping, false);
  });
});

describe('parseLyricsInput', () => {
  it('parses timestamped LRC lines accurately', () => {
    const result = parseLyricsInput('[00:05.50] Dòng một\n[01:12.00] Dòng hai', 200);
    assert.deepEqual(result, [
      { timeSec: 5.5, text: 'Dòng một' },
      { timeSec: 72, text: 'Dòng hai' },
    ]);
  });

  it('distributes plain lyrics cleanly when no timestamps are given', () => {
    const result = parseLyricsInput('Câu một\nCâu hai\nCâu ba', 90);
    assert.equal(result.length, 3);
    assert.equal(result[0].timeSec, 0);
    assert.equal(result[1].timeSec, 30);
    assert.equal(result[2].timeSec, 60);
  });
});
