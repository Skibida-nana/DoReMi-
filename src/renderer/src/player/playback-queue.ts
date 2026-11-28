import type {
  PlaybackContextDescriptor,
  PlaybackControlState,
  PlaybackQueueEntry,
  PlaybackQueueState,
  QueueHistoryStatus,
  RepeatMode,
  RepeatRuntimeState,
} from '../../../shared/types/player';
import {
  DEFAULT_PLAYBACK_CONTROLS,
  getInitialRemainingReplays,
  nextRepeatMode,
  normalizePlaybackControls,
} from '../../../shared/utils/playback-controls';
import {
  smartShuffleItems,
  type SmartShuffleTrackMeta,
} from '../../../shared/utils/smart-shuffle';

const MAX_QUEUE_HISTORY_ENTRIES = 500;
const MAX_AUTO_SKIP_ERRORS_CAP = 25;

/**
 * Unbiased O(n) Fisher-Yates shuffle returning a new array without mutating input.
 */
export function shuffleFisherYates<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const raw = rng();
    const bounded = Number.isFinite(raw) ? Math.min(0.999999999, Math.max(0, raw)) : 0;
    const j = Math.floor(bounded * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

export type TrackMetadataLookup = (trackId: string) => SmartShuffleTrackMeta | null;

export interface PlaybackQueueControllerOptions {
  initialControls?: Partial<PlaybackControlState>;
  isTrackPlayable?: (trackId: string) => boolean;
  getTrackMeta?: TrackMetadataLookup;
  rng?: () => number;
}

export interface StartContextOptions {
  context: PlaybackContextDescriptor;
  startTrackId?: string;
  startIndex?: number;
  shuffle?: boolean;
  preserveHistory?: boolean;
}

export type NaturalEndResolution =
  | { action: 'replay'; entry: PlaybackQueueEntry }
  | { action: 'play-entry'; entry: PlaybackQueueEntry }
  | { action: 'stop' };

export type TrackAdvanceResult =
  | { entry: PlaybackQueueEntry; status: 'ok' }
  | { entry: null; status: 'empty' | 'exhausted' };

/**
 * Single Source of Truth for DoReMi Playback Queue, History, Shuffle, Repeat & Auto Next.
 * Pure TypeScript controller — completely independent of React, Electron IPC, or HTMLAudioElement.
 */
export class PlaybackQueueController {
  private readonly listeners = new Set<(state: PlaybackQueueState) => void>();
  private isTrackPlayableFn: (trackId: string) => boolean;
  private getTrackMetaFn?: TrackMetadataLookup;
  private readonly rng: () => number;

  private entrySeq = 0;
  private insertionSeq = 0;

  private currentEntry: PlaybackQueueEntry | null = null;
  private history: PlaybackQueueEntry[] = [];
  private upcoming: PlaybackQueueEntry[] = [];
  private controls: PlaybackControlState;
  private context: PlaybackContextDescriptor | null = null;
  private removedContextIndices = new Set<number>();
  private playedIndicesInRound = new Set<number>();
  private currentEntryStarted = false;
  private currentEntryFailed = false;
  private currentDeletedDuringPlayback = false;
  private remainingReplays: number | null = 0;
  private autoErrorSkipsInChain = 0;
  private cachedSnapshot: PlaybackQueueState;

  constructor(options: PlaybackQueueControllerOptions = {}) {
    this.controls = normalizePlaybackControls(options.initialControls, DEFAULT_PLAYBACK_CONTROLS);
    this.isTrackPlayableFn = options.isTrackPlayable ?? (() => true);
    this.getTrackMetaFn = options.getTrackMeta;
    this.rng = options.rng ?? Math.random;
    this.remainingReplays = getInitialRemainingReplays(this.controls.repeatMode);
    this.cachedSnapshot = this.buildSnapshot();
  }

  private resetRepeatRuntimeForCurrent(): void {
    this.currentDeletedDuringPlayback = false;
    this.remainingReplays = this.currentEntry
      ? getInitialRemainingReplays(this.controls.repeatMode)
      : 0;
  }

  setTrackPlayableChecker(fn: (trackId: string) => boolean): void {
    this.isTrackPlayableFn = fn;
  }

  setTrackMetadataResolver(fn: TrackMetadataLookup | undefined): void {
    this.getTrackMetaFn = fn;
  }

  private resolveTrackMetaForShuffle(trackId: string): SmartShuffleTrackMeta {
    return this.getTrackMetaFn?.(trackId) ?? { trackId };
  }

  private getRecentTrackIdsForShuffle(limit = 15): string[] {
    if (this.history.length === 0) {
      return [];
    }
    return this.history.slice(-limit).map((e) => e.trackId);
  }

  getState(): PlaybackQueueState {
    return this.cachedSnapshot;
  }

  getControls(): PlaybackControlState {
    return { ...this.controls };
  }

  subscribe(listener: (state: PlaybackQueueState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private createEntry(
    trackId: string,
    origin: PlaybackQueueEntry['origin'],
    sourceContextId?: string,
    contextOrderIndex?: number,
  ): PlaybackQueueEntry {
    this.entrySeq += 1;
    this.insertionSeq += 1;
    return {
      queueEntryId: `qe-${this.entrySeq}`,
      trackId,
      sourceContextId,
      origin,
      contextOrderIndex,
      insertionOrder: this.insertionSeq,
    };
  }

  private pushToHistory(entry: PlaybackQueueEntry, status: QueueHistoryStatus): void {
    const record: PlaybackQueueEntry = {
      ...entry,
      historyStatus: status,
    };
    this.history.push(record);
    if (this.history.length > MAX_QUEUE_HISTORY_ENTRIES) {
      this.history = this.history.slice(this.history.length - MAX_QUEUE_HISTORY_ENTRIES);
    }
  }

  private archiveCurrentToHistory(status: QueueHistoryStatus): void {
    if (!this.currentEntry) {
      return;
    }
    if (
      this.context &&
      this.currentEntry.sourceContextId === this.context.contextId &&
      typeof this.currentEntry.contextOrderIndex === 'number'
    ) {
      this.playedIndicesInRound.add(this.currentEntry.contextOrderIndex);
    }
    // Never mark an entry that never attempted playback as completed/heard
    if (!this.currentEntryStarted && !this.currentEntryFailed && status !== 'error') {
      return;
    }
    this.pushToHistory(this.currentEntry, this.currentEntryFailed ? 'error' : status);
  }

  markCurrentPlaybackStarted(): void {
    this.currentEntryStarted = true;
    this.currentEntryFailed = false;
    this.autoErrorSkipsInChain = 0;
    if (
      this.context &&
      this.currentEntry &&
      this.currentEntry.sourceContextId === this.context.contextId &&
      typeof this.currentEntry.contextOrderIndex === 'number'
    ) {
      this.playedIndicesInRound.add(this.currentEntry.contextOrderIndex);
    }
  }

  markCurrentPlaybackFailed(): void {
    this.currentEntryFailed = true;
  }

  resetErrorSkipChain(): void {
    this.autoErrorSkipsInChain = 0;
  }

  // ---------------------------------------------------------------------------
  // Context Playback Initialization & Replacement
  // ---------------------------------------------------------------------------

  /**
   * Replaces active context & upcoming queue when user starts playing a Playlist, Album, Library, etc.
   * Preserves existing playback history cleanly if requested.
   */
  startContext(options: StartContextOptions): PlaybackQueueEntry | null {
    const trackIds = [...options.context.trackIds];
    const nextContext: PlaybackContextDescriptor = {
      ...options.context,
      trackIds,
    };

    if (typeof options.shuffle === 'boolean') {
      this.controls = {
        ...this.controls,
        shuffleEnabled: options.shuffle,
      };
    }

    if (options.preserveHistory !== false && this.currentEntry) {
      this.archiveCurrentToHistory('skipped');
    } else if (options.preserveHistory === false) {
      this.history = [];
    }

    this.context = nextContext;
    this.removedContextIndices.clear();
    this.playedIndicesInRound.clear();
    this.currentEntryStarted = false;
    this.currentEntryFailed = false;
    this.autoErrorSkipsInChain = 0;

    if (trackIds.length === 0) {
      this.currentEntry = null;
      this.upcoming = [];
      this.resetRepeatRuntimeForCurrent();
      this.emit();
      return null;
    }

    let startIdx = -1;
    if (
      typeof options.startIndex === 'number' &&
      options.startIndex >= 0 &&
      options.startIndex < trackIds.length
    ) {
      startIdx = options.startIndex;
    } else if (options.startTrackId) {
      startIdx = trackIds.indexOf(options.startTrackId);
    }

    const entries = trackIds.map((trackId, index) =>
      this.createEntry(trackId, 'context', nextContext.contextId, index),
    );

    if (this.controls.shuffleEnabled) {
      const recentIds = this.getRecentTrackIdsForShuffle();
      if (startIdx >= 0) {
        const chosen = entries[startIdx];
        const remaining = entries.filter((_, i) => i !== startIdx);
        this.currentEntry = chosen;
        this.upcoming = smartShuffleItems({
          items: remaining,
          getTrackMeta: (entry) => this.resolveTrackMetaForShuffle(entry.trackId),
          anchorTrack: this.resolveTrackMetaForShuffle(chosen.trackId),
          recentTrackIds: recentIds,
          rng: this.rng,
        });
      } else {
        const shuffled = smartShuffleItems({
          items: entries,
          getTrackMeta: (entry) => this.resolveTrackMetaForShuffle(entry.trackId),
          anchorTrack: this.currentEntry
            ? this.resolveTrackMetaForShuffle(this.currentEntry.trackId)
            : null,
          recentTrackIds: recentIds,
          rng: this.rng,
        });
        // Prefer starting on a playable entry if one exists
        const firstPlayableIdx = shuffled.findIndex((e) => this.isTrackPlayableFn(e.trackId));
        if (firstPlayableIdx > 0) {
          const [picked] = shuffled.splice(firstPlayableIdx, 1);
          this.currentEntry = picked;
          this.upcoming = shuffled;
        } else {
          this.currentEntry = shuffled[0] ?? null;
          this.upcoming = shuffled.slice(1);
        }
      }
    } else {
      if (startIdx < 0) {
        startIdx = entries.findIndex((e) => this.isTrackPlayableFn(e.trackId));
        if (startIdx < 0) {
          startIdx = 0;
        }
      }
      this.currentEntry = entries[startIdx] ?? null;
      this.upcoming = entries.slice(startIdx + 1);
    }

    if (this.currentEntry && typeof this.currentEntry.contextOrderIndex === 'number') {
      this.playedIndicesInRound.add(this.currentEntry.contextOrderIndex);
    }

    this.resetRepeatRuntimeForCurrent();
    this.emit();
    return this.currentEntry;
  }

  /**
   * Transitions seamlessly from an exhausted natural-end queue into a new Library continuation
   * context without overwriting previous saved playlists or discarding playback history.
   */
  startAutoContinueContext(
    context: PlaybackContextDescriptor,
    startTrackId?: string,
  ): PlaybackQueueEntry | null {
    const trackIds = context.trackIds.filter((id) => this.isTrackPlayableFn(id));
    if (trackIds.length === 0) {
      return null;
    }

    if (this.currentEntry) {
      this.archiveCurrentToHistory(this.currentEntryFailed ? 'error' : 'completed');
    }

    const nextContext: PlaybackContextDescriptor = {
      ...context,
      trackIds,
    };
    this.context = nextContext;
    this.removedContextIndices.clear();
    this.playedIndicesInRound.clear();
    this.currentEntryStarted = false;
    this.currentEntryFailed = false;
    this.autoErrorSkipsInChain = 0;

    let startIdx = startTrackId ? trackIds.indexOf(startTrackId) : 0;
    if (startIdx < 0) {
      startIdx = 0;
    }

    const entries = trackIds.map((trackId, index) =>
      this.createEntry(trackId, 'context', nextContext.contextId, index),
    );
    const picked = entries[startIdx]!;
    this.currentEntry = picked;
    if (typeof picked.contextOrderIndex === 'number') {
      this.playedIndicesInRound.add(picked.contextOrderIndex);
    }

    const rest = entries.filter((_, idx) => idx !== startIdx);
    this.upcoming = this.controls.shuffleEnabled
      ? smartShuffleItems({
          items: rest,
          getTrackMeta: (entry) => this.resolveTrackMetaForShuffle(entry.trackId),
          anchorTrack: this.resolveTrackMetaForShuffle(picked.trackId),
          recentTrackIds: this.getRecentTrackIdsForShuffle(),
          rng: this.rng,
        })
      : entries.slice(startIdx + 1);

    this.resetRepeatRuntimeForCurrent();
    this.emit();
    return this.currentEntry;
  }

  /**
   * Syncs a plain track list context without starting playback (used by standalone AudioEngine.setQueue / tests).
   */
  initializeIdleContext(context: PlaybackContextDescriptor): void {
    this.context = {
      ...context,
      trackIds: [...context.trackIds],
    };
    this.removedContextIndices.clear();
    this.playedIndicesInRound.clear();
    this.history = [];
    this.currentEntry = null;
    this.resetRepeatRuntimeForCurrent();
    this.upcoming = context.trackIds.map((id, idx) =>
      this.createEntry(id, 'context', context.contextId, idx),
    );
    this.emit();
  }

  /**
   * Ensures a track exists as currentEntry within the current context, or starts a single/context play.
   */
  playTrackInCurrentOrNewContext(
    trackId: string,
    fallbackContext?: PlaybackContextDescriptor,
  ): PlaybackQueueEntry {
    // If track exists in upcoming and no new context forced, jump to it without losing history
    if (!fallbackContext && this.currentEntry) {
      if (this.currentEntry.trackId === trackId) {
        this.currentEntryStarted = false;
        this.currentEntryFailed = false;
        this.resetRepeatRuntimeForCurrent();
        this.emit();
        return this.currentEntry;
      }
      const upcomingMatch = this.upcoming.find((e) => e.trackId === trackId);
      if (upcomingMatch) {
        return this.playUpcomingEntryNow(upcomingMatch.queueEntryId) ?? upcomingMatch;
      }
    }

    const contextToUse: PlaybackContextDescriptor = fallbackContext ??
      this.context ?? {
        contextId: `single-${trackId}`,
        label: 'Phát trực tiếp',
        kind: 'single',
        trackIds: [trackId],
      };

    if (!contextToUse.trackIds.includes(trackId)) {
      const augmented: PlaybackContextDescriptor = {
        ...contextToUse,
        trackIds: [trackId, ...contextToUse.trackIds],
      };
      return this.startContext({
        context: augmented,
        startTrackId: trackId,
        preserveHistory: true,
      })!;
    }

    return this.startContext({
      context: contextToUse,
      startTrackId: trackId,
      preserveHistory: true,
    })!;
  }

  // ---------------------------------------------------------------------------
  // Shuffle, Repeat & Auto Next Controls (Phase 2B)
  // ---------------------------------------------------------------------------

  setShuffle(enabled: boolean): PlaybackControlState {
    if (this.controls.shuffleEnabled === enabled) {
      return this.getControls();
    }

    this.controls = {
      ...this.controls,
      shuffleEnabled: enabled,
    };

    // Preserve Play Next priority entries at front and Add to Queue manual entries at tail;
    // reconstruct/permute context entries accurately across ALL tracks of the active context (`Phase 4.4E-F`).
    const playNextHead: PlaybackQueueEntry[] = [];
    const contextEntries: PlaybackQueueEntry[] = [];
    const manualTail: PlaybackQueueEntry[] = [];

    for (const entry of this.upcoming) {
      if (entry.origin === 'play-next') {
        playNextHead.push(entry);
      } else if (entry.origin === 'manual') {
        manualTail.push(entry);
      } else {
        contextEntries.push(entry);
      }
    }

    const activeCtx = this.context;
    const currentCtxIdx =
      activeCtx &&
      this.currentEntry &&
      this.currentEntry.sourceContextId === activeCtx.contextId &&
      typeof this.currentEntry.contextOrderIndex === 'number'
        ? this.currentEntry.contextOrderIndex
        : null;

    const existingByOrderIdx = new Map<number, PlaybackQueueEntry>();
    for (const entry of contextEntries) {
      if (
        activeCtx &&
        entry.sourceContextId === activeCtx.contextId &&
        typeof entry.contextOrderIndex === 'number'
      ) {
        existingByOrderIdx.set(entry.contextOrderIndex, entry);
      }
    }

    if (enabled) {
      let pool: PlaybackQueueEntry[];
      if (activeCtx && activeCtx.trackIds.length > 0) {
        const eligibleIndices: number[] = [];
        const allSurvivingExceptCurrent: number[] = [];

        for (let i = 0; i < activeCtx.trackIds.length; i += 1) {
          if (this.removedContextIndices.has(i)) continue;
          if (currentCtxIdx !== null && i === currentCtxIdx) continue;
          allSurvivingExceptCurrent.push(i);
          if (!this.playedIndicesInRound.has(i) || existingByOrderIdx.has(i)) {
            eligibleIndices.push(i);
          }
        }

        // If user already listened through the whole round then explicitly turns Shuffle back ON,
        // recycle full context round (excluding current track) instead of leaving shuffle queue empty.
        let targetIndices = eligibleIndices;
        if (targetIndices.length === 0 && allSurvivingExceptCurrent.length > 0) {
          this.playedIndicesInRound.clear();
          if (currentCtxIdx !== null) {
            this.playedIndicesInRound.add(currentCtxIdx);
          }
          targetIndices = allSurvivingExceptCurrent;
        }

        pool = targetIndices.map(
          (idx) =>
            existingByOrderIdx.get(idx) ??
            this.createEntry(activeCtx.trackIds[idx], 'context', activeCtx.contextId, idx),
        );
      } else {
        pool = contextEntries;
      }

      const prevOrderKey = contextEntries.map((e) => e.trackId).join('\u0001');
      const anchorMeta = this.currentEntry
        ? this.resolveTrackMetaForShuffle(this.currentEntry.trackId)
        : null;
      const recentIds = this.getRecentTrackIdsForShuffle();
      let shuffledContext = smartShuffleItems({
        items: pool,
        getTrackMeta: (entry) => this.resolveTrackMetaForShuffle(entry.trackId),
        anchorTrack: anchorMeta,
        recentTrackIds: recentIds,
        rng: this.rng,
      });
      if (pool.length >= 2) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (shuffledContext.map((e) => e.trackId).join('\u0001') !== prevOrderKey) {
            break;
          }
          shuffledContext = smartShuffleItems({
            items: pool,
            getTrackMeta: (entry) => this.resolveTrackMetaForShuffle(entry.trackId),
            anchorTrack: anchorMeta,
            recentTrackIds: recentIds,
            rng: this.rng,
          });
        }
      }
      this.upcoming = [...playNextHead, ...shuffledContext, ...manualTail];
    } else {
      if (activeCtx && currentCtxIdx !== null) {
        // Restore exact sequential source order AFTER currentEntry's real position;
        // tracks BEFORE currentCtxIdx appear cleanly in `sourceContextBefore` (never pushed into fake history!).
        const afterCurrent: PlaybackQueueEntry[] = [];
        for (let i = currentCtxIdx + 1; i < activeCtx.trackIds.length; i += 1) {
          if (this.removedContextIndices.has(i)) continue;
          afterCurrent.push(
            existingByOrderIdx.get(i) ??
              this.createEntry(activeCtx.trackIds[i], 'context', activeCtx.contextId, i),
          );
        }
        this.upcoming = [...playNextHead, ...afterCurrent, ...manualTail];
      } else {
        const restoredContext = [...contextEntries].sort((a, b) => {
          const idxA = a.contextOrderIndex ?? Number.MAX_SAFE_INTEGER;
          const idxB = b.contextOrderIndex ?? Number.MAX_SAFE_INTEGER;
          if (idxA !== idxB) {
            return idxA - idxB;
          }
          return a.insertionOrder - b.insertionOrder;
        });
        this.upcoming = [...playNextHead, ...restoredContext, ...manualTail];
      }
    }

    this.emit();
    return this.getControls();
  }

  toggleShuffle(): PlaybackControlState {
    return this.setShuffle(!this.controls.shuffleEnabled);
  }

  setRepeatMode(mode: RepeatMode): PlaybackControlState {
    if (this.controls.repeatMode === mode) {
      return this.getControls();
    }
    this.controls = {
      ...this.controls,
      repeatMode: mode,
    };
    if (this.currentEntry && !this.currentDeletedDuringPlayback) {
      this.remainingReplays = getInitialRemainingReplays(mode);
    } else if (!this.currentEntry || this.currentDeletedDuringPlayback) {
      this.remainingReplays = 0;
    }
    this.emit();
    return this.getControls();
  }

  cycleRepeatMode(): PlaybackControlState {
    return this.setRepeatMode(nextRepeatMode(this.controls.repeatMode));
  }

  setAutoNext(enabled: boolean): PlaybackControlState {
    if (this.controls.autoNextEnabled === enabled) {
      return this.getControls();
    }
    this.controls = {
      ...this.controls,
      autoNextEnabled: enabled,
    };
    this.emit();
    return this.getControls();
  }

  toggleAutoNext(): PlaybackControlState {
    return this.setAutoNext(!this.controls.autoNextEnabled);
  }

  setControls(partial: Partial<PlaybackControlState>): PlaybackControlState {
    const next = normalizePlaybackControls(partial, this.controls);
    if (next.shuffleEnabled !== this.controls.shuffleEnabled) {
      this.setShuffle(next.shuffleEnabled);
    }
    const repeatChanged = next.repeatMode !== this.controls.repeatMode;
    this.controls = next;
    if (repeatChanged) {
      this.remainingReplays =
        this.currentEntry && !this.currentDeletedDuringPlayback
          ? getInitialRemainingReplays(next.repeatMode)
          : 0;
    }
    this.emit();
    return this.getControls();
  }

  /**
   * Synchronizes library track deletion across Upcoming, Context, and active playback:
   * - Immediately drops deleted tracks from Upcoming and active Context loop
   * - If active currentEntry was deleted, lets it finish its current play cleanly,
   *   prevents repeating it again, and advances/stops afterward without erroring.
   */
  removeTracksFromQueue(trackIds: readonly string[]): void {
    if (trackIds.length === 0) {
      return;
    }
    const targetSet = new Set(trackIds);
    let changed = false;

    const filteredUpcoming = this.upcoming.filter((entry) => !targetSet.has(entry.trackId));
    if (filteredUpcoming.length !== this.upcoming.length) {
      this.upcoming = filteredUpcoming;
      changed = true;
    }

    if (this.context) {
      const nextTrackIds: string[] = [];
      const nextRemovedIndices = new Set<number>();
      let oldIdxToNewIdx = new Map<number, number>();
      this.context.trackIds.forEach((id, oldIdx) => {
        if (targetSet.has(id)) {
          changed = true;
          return;
        }
        const newIdx = nextTrackIds.length;
        nextTrackIds.push(id);
        oldIdxToNewIdx.set(oldIdx, newIdx);
        if (this.removedContextIndices.has(oldIdx)) {
          nextRemovedIndices.add(newIdx);
        }
      });

      if (nextTrackIds.length !== this.context.trackIds.length) {
        this.context = {
          ...this.context,
          trackIds: nextTrackIds,
        };
        this.removedContextIndices = nextRemovedIndices;
        const nextPlayed = new Set<number>();
        for (const oldIdx of this.playedIndicesInRound) {
          const mapped = oldIdxToNewIdx.get(oldIdx);
          if (mapped !== undefined) {
            nextPlayed.add(mapped);
          }
        }
        this.playedIndicesInRound = nextPlayed;
        this.upcoming = this.upcoming.map((entry) => {
          if (
            entry.sourceContextId === this.context?.contextId &&
            typeof entry.contextOrderIndex === 'number'
          ) {
            const mapped = oldIdxToNewIdx.get(entry.contextOrderIndex);
            return mapped !== undefined ? { ...entry, contextOrderIndex: mapped } : entry;
          }
          return entry;
        });
      }
    }

    if (this.currentEntry && targetSet.has(this.currentEntry.trackId)) {
      this.currentDeletedDuringPlayback = true;
      this.remainingReplays = 0;
      changed = true;
    }

    if (changed) {
      this.emit();
    }
  }

  // ---------------------------------------------------------------------------
  // Queue Manipulation (Phase 2C)
  // ---------------------------------------------------------------------------

  /**
   * "Phát tiếp theo" (Play Next): places a new queue entry at the very start of Upcoming.
   * Never interrupts current track or strips Repeat One.
   */
  playNext(trackId: string): PlaybackQueueEntry {
    const entry = this.createEntry(trackId, 'play-next', this.context?.contextId);
    this.upcoming = [entry, ...this.upcoming];
    this.emit();
    return entry;
  }

  /**
   * "Thêm vào hàng đợi" (Add to Queue): appends a new queue entry to the end of Upcoming.
   */
  addToQueue(trackId: string): PlaybackQueueEntry {
    const entry = this.createEntry(trackId, 'manual', this.context?.contextId);
    this.upcoming = [...this.upcoming, entry];
    this.emit();
    return entry;
  }

  /**
   * Promotes an existing upcoming entry (from Queue context menu) to the top of Upcoming.
   */
  promoteUpcomingEntryToPlayNext(queueEntryId: string): boolean {
    const idx = this.upcoming.findIndex((e) => e.queueEntryId === queueEntryId);
    if (idx < 0) {
      return false;
    }
    const copy = [...this.upcoming];
    const [picked] = copy.splice(idx, 1);
    const updated: PlaybackQueueEntry = {
      ...picked,
      origin: 'play-next',
    };
    copy.unshift(updated);
    this.upcoming = copy;
    this.emit();
    return true;
  }

  /**
   * Plays an upcoming entry immediately: moves current active entry to history ('skipped')
   * and pops the target entry without marking skipped-over unplayed entries as heard.
   */
  playUpcomingEntryNow(queueEntryId: string): PlaybackQueueEntry | null {
    const idx = this.upcoming.findIndex((e) => e.queueEntryId === queueEntryId);
    if (idx < 0) {
      return null;
    }
    this.archiveCurrentToHistory('skipped');
    const copy = [...this.upcoming];
    const [picked] = copy.splice(idx, 1);
    this.upcoming = copy;
    this.currentEntry = picked;
    this.currentEntryStarted = false;
    this.currentEntryFailed = false;
    this.autoErrorSkipsInChain = 0;
    this.resetRepeatRuntimeForCurrent();
    this.emit();
    return picked;
  }

  /**
   * Jumps directly to a source context index (e.g. a preceding source track shown before current in sequential mode)
   * without corrupting history or Play Next/Manual entries.
   */
  playContextIndexNow(contextOrderIndex: number): PlaybackQueueEntry | null {
    if (
      !this.context ||
      contextOrderIndex < 0 ||
      contextOrderIndex >= this.context.trackIds.length ||
      this.removedContextIndices.has(contextOrderIndex)
    ) {
      return null;
    }

    if (
      this.currentEntry &&
      this.currentEntry.sourceContextId === this.context.contextId &&
      this.currentEntry.contextOrderIndex === contextOrderIndex
    ) {
      return this.currentEntry;
    }

    this.archiveCurrentToHistory('skipped');
    const trackId = this.context.trackIds[contextOrderIndex];

    const playNextHead: PlaybackQueueEntry[] = [];
    const manualTail: PlaybackQueueEntry[] = [];
    const otherContextEntries: PlaybackQueueEntry[] = [];
    let reused: PlaybackQueueEntry | null = null;

    for (const entry of this.upcoming) {
      if (entry.origin === 'play-next') {
        playNextHead.push(entry);
      } else if (entry.origin === 'manual') {
        manualTail.push(entry);
      } else if (
        entry.sourceContextId === this.context.contextId &&
        entry.contextOrderIndex === contextOrderIndex &&
        !reused
      ) {
        reused = entry;
      } else {
        otherContextEntries.push(entry);
      }
    }

    const picked =
      reused ?? this.createEntry(trackId, 'context', this.context.contextId, contextOrderIndex);

    this.currentEntry = picked;
    this.playedIndicesInRound.add(contextOrderIndex);
    this.currentEntryStarted = false;
    this.currentEntryFailed = false;
    this.autoErrorSkipsInChain = 0;

    if (!this.controls.shuffleEnabled) {
      const existingByIdx = new Map<number, PlaybackQueueEntry>();
      for (const e of otherContextEntries) {
        if (e.sourceContextId === this.context.contextId && typeof e.contextOrderIndex === 'number') {
          existingByIdx.set(e.contextOrderIndex, e);
        }
      }
      const afterCurrent: PlaybackQueueEntry[] = [];
      for (let i = contextOrderIndex + 1; i < this.context.trackIds.length; i += 1) {
        if (this.removedContextIndices.has(i)) continue;
        afterCurrent.push(
          existingByIdx.get(i) ??
            this.createEntry(this.context.trackIds[i], 'context', this.context.contextId, i),
        );
      }
      this.upcoming = [...playNextHead, ...afterCurrent, ...manualTail];
    } else {
      this.upcoming = [...playNextHead, ...otherContextEntries, ...manualTail];
    }

    this.resetRepeatRuntimeForCurrent();
    this.emit();
    return picked;
  }

  /**
   * Jumps back to a previously played history entry while preserving forward timeline
   * (intervening history entries + currentEntry are placed at front of Upcoming).
   */
  jumpToHistoryEntry(queueEntryId: string): PlaybackQueueEntry | null {
    const idx = this.history.findIndex((e) => e.queueEntryId === queueEntryId);
    if (idx < 0) {
      return null;
    }
    const targetRaw = this.history[idx];
    const target: PlaybackQueueEntry = {
      ...targetRaw,
      historyStatus: undefined,
    };

    const laterHistory = this.history.slice(idx + 1).map((e) => ({
      ...e,
      historyStatus: undefined,
    }));
    const restoredForward: PlaybackQueueEntry[] = [...laterHistory];
    if (this.currentEntry) {
      restoredForward.push({
        ...this.currentEntry,
        historyStatus: undefined,
      });
    }

    this.history = this.history.slice(0, idx);
    this.currentEntry = target;
    this.upcoming = [...restoredForward, ...this.upcoming];
    this.currentEntryStarted = targetRaw.historyStatus !== 'error';
    this.currentEntryFailed = false;
    this.autoErrorSkipsInChain = 0;
    this.resetRepeatRuntimeForCurrent();
    this.emit();
    return target;
  }

  moveUpcomingEntry(queueEntryId: string, direction: -1 | 1): boolean {
    const fromIdx = this.upcoming.findIndex((e) => e.queueEntryId === queueEntryId);
    if (fromIdx < 0) {
      return false;
    }
    return this.reorderUpcoming(fromIdx, fromIdx + direction);
  }

  reorderUpcoming(fromIndex: number, toIndex: number): boolean {
    if (
      fromIndex < 0 ||
      fromIndex >= this.upcoming.length ||
      toIndex < 0 ||
      toIndex >= this.upcoming.length ||
      fromIndex === toIndex
    ) {
      return false;
    }
    const copy = [...this.upcoming];
    const [moved] = copy.splice(fromIndex, 1);
    copy.splice(toIndex, 0, moved);
    this.upcoming = copy;
    this.emit();
    return true;
  }

  removeUpcomingEntry(queueEntryId: string): boolean {
    const idx = this.upcoming.findIndex((e) => e.queueEntryId === queueEntryId);
    if (idx < 0) {
      return false;
    }
    const [removed] = this.upcoming.splice(idx, 1);
    if (
      removed.origin === 'context' &&
      typeof removed.contextOrderIndex === 'number' &&
      removed.sourceContextId === this.context?.contextId
    ) {
      this.removedContextIndices.add(removed.contextOrderIndex);
    }
    this.emit();
    return true;
  }

  /**
   * Clears all upcoming tracks while keeping currentEntry playing and history intact.
   * Ensures Repeat ALL does NOT resurrect cleared upcoming tracks.
   */
  clearUpcoming(): void {
    this.upcoming = [];
    this.removedContextIndices.clear();
    this.playedIndicesInRound.clear();
    if (this.currentEntry) {
      this.context = {
        contextId: this.context?.contextId ?? `cleared-${this.currentEntry.trackId}`,
        label: this.context?.label ?? 'Hàng đợi hiện tại',
        kind: this.context?.kind ?? 'custom',
        trackIds: [this.currentEntry.trackId],
      };
      this.currentEntry = {
        ...this.currentEntry,
        sourceContextId: this.context.contextId,
        origin: 'context',
        contextOrderIndex: 0,
      };
    } else {
      this.context = null;
    }
    this.emit();
  }

  // ---------------------------------------------------------------------------
  // Navigation & End-of-Track Resolution (Phase 2B & 2C)
  // ---------------------------------------------------------------------------

  private buildRepeatCycleEntries(): PlaybackQueueEntry[] {
    if (!this.context || this.context.trackIds.length === 0) {
      return [];
    }

    const cyclePairs: Array<{ trackId: string; contextOrderIndex: number }> = [];
    for (let i = 0; i < this.context.trackIds.length; i += 1) {
      if (this.removedContextIndices.has(i)) {
        continue;
      }
      cyclePairs.push({
        trackId: this.context.trackIds[i],
        contextOrderIndex: i,
      });
    }

    if (cyclePairs.length === 0) {
      return [];
    }

    let ordered = cyclePairs;
    if (this.controls.shuffleEnabled && ordered.length > 1) {
      ordered = smartShuffleItems({
        items: ordered,
        getTrackMeta: (item) => this.resolveTrackMetaForShuffle(item.trackId),
        anchorTrack: this.currentEntry
          ? this.resolveTrackMetaForShuffle(this.currentEntry.trackId)
          : null,
        recentTrackIds: this.getRecentTrackIdsForShuffle(),
        rng: this.rng,
      });
      // Avoid repeating the exact just-ended track first when multiple choices exist
      if (
        this.currentEntry &&
        ordered[0].trackId === this.currentEntry.trackId &&
        ordered.length > 1
      ) {
        const swapIdx = ordered.findIndex((item) => item.trackId !== this.currentEntry!.trackId);
        if (swapIdx > 0) {
          const tmp = ordered[0];
          ordered[0] = ordered[swapIdx];
          ordered[swapIdx] = tmp;
        }
      }
    }

    return ordered.map((item) =>
      this.createEntry(item.trackId, 'context', this.context!.contextId, item.contextOrderIndex),
    );
  }

  /**
   * Computes whether Next can advance right now.
   */
  canGoNext(): boolean {
    if (this.upcoming.some((e) => this.isTrackPlayableFn(e.trackId))) {
      return true;
    }
    if (this.controls.repeatMode === 'all' && this.context) {
      return this.context.trackIds.some(
        (id, idx) => !this.removedContextIndices.has(idx) && this.isTrackPlayableFn(id),
      );
    }
    return false;
  }

  canGoPrevious(currentTimeSeconds = 0): boolean {
    if (this.currentEntry && currentTimeSeconds > 3) {
      return true;
    }
    return this.history.length > 0;
  }

  /**
   * Manual Next button (works even when Auto Next is OFF or Repeat is ONE).
   */
  advanceManualNext(): TrackAdvanceResult {
    this.autoErrorSkipsInChain = 0;
    return this.popNextPlayableEntry(
      this.currentEntryFailed ? 'error' : 'skipped',
      this.controls.repeatMode === 'all',
    );
  }

  /**
   * Manual Previous button (strictly follows real playback history timeline).
   */
  advanceManualPrevious(): PlaybackQueueEntry | null {
    this.autoErrorSkipsInChain = 0;
    if (this.history.length === 0) {
      return null;
    }
    const prevRaw = this.history[this.history.length - 1];
    this.history = this.history.slice(0, -1);

    const prevEntry: PlaybackQueueEntry = {
      ...prevRaw,
      historyStatus: undefined,
    };

    if (this.currentEntry) {
      const pushBack: PlaybackQueueEntry = {
        ...this.currentEntry,
        historyStatus: undefined,
      };
      this.upcoming = [pushBack, ...this.upcoming];
    }

    this.currentEntry = prevEntry;
    this.currentEntryStarted = prevRaw.historyStatus !== 'error';
    this.currentEntryFailed = false;
    this.resetRepeatRuntimeForCurrent();
    this.emit();
    return prevEntry;
  }

  /**
   * Resolves natural end-of-track event strictly using the unified 10-cell Auto Next x Repeat matrix:
   * - repeatMode === 'one' (infinite single): always replays unless track failed or was deleted while playing.
   * - repeatMode === 'once' | 'twice': replays current track until remainingReplays reaches 0
   *   (even when Auto Next is OFF), then after the final replay uses Auto Next rule (advance or stop).
   * - repeatMode === 'off' | 'all': never replays current track directly; when Auto Next is OFF, stops cleanly;
   *   when Auto Next is ON, advances to upcoming (or loops full context/queue when repeatMode === 'all').
   */
  resolveNaturalTrackEnd(): NaturalEndResolution {
    if (!this.currentEntry) {
      return { action: 'stop' };
    }

    const canReplayCurrent = !this.currentEntryFailed && !this.currentDeletedDuringPlayback;

    if (canReplayCurrent && this.controls.repeatMode === 'one') {
      this.currentEntryStarted = false;
      return { action: 'replay', entry: this.currentEntry };
    }

    if (
      canReplayCurrent &&
      (this.controls.repeatMode === 'once' || this.controls.repeatMode === 'twice') &&
      typeof this.remainingReplays === 'number' &&
      this.remainingReplays > 0
    ) {
      this.remainingReplays -= 1;
      this.currentEntryStarted = false;
      this.emit();
      return { action: 'replay', entry: this.currentEntry };
    }

    // After finite replays finish (or on 'off' / 'all'), respect Auto Next toggle
    if (!this.controls.autoNextEnabled) {
      return { action: 'stop' };
    }

    const advanced = this.popNextPlayableEntry(
      this.currentEntryFailed ? 'error' : 'completed',
      this.controls.repeatMode === 'all',
    );
    if (advanced.status === 'ok') {
      return { action: 'play-entry', entry: advanced.entry };
    }
    return { action: 'stop' };
  }

  /**
   * Called when an auto-advanced track fails to verify/decode/play.
   * Respects cycle skip cap and stops on Repeat One / Auto Next Off.
   */
  advanceAfterAutoPlayFailure(): TrackAdvanceResult {
    this.currentEntryFailed = true;
    if (this.controls.repeatMode === 'one' || !this.controls.autoNextEnabled) {
      return { entry: null, status: 'exhausted' };
    }

    const totalScopeCount = Math.max(
      1,
      this.upcoming.length + (this.context ? this.context.trackIds.length : 0),
    );
    const maxSkips = Math.min(MAX_AUTO_SKIP_ERRORS_CAP, totalScopeCount);
    this.autoErrorSkipsInChain += 1;

    if (this.autoErrorSkipsInChain >= maxSkips) {
      return { entry: null, status: 'exhausted' };
    }

    return this.popNextPlayableEntry('error', this.controls.repeatMode === 'all');
  }

  private popNextPlayableEntry(
    outgoingHistoryStatus: QueueHistoryStatus,
    allowRepeatAllCycle: boolean,
  ): TrackAdvanceResult {
    // Try existing upcoming entries first (skipping known missing tracks without marking them heard)
    let nextIdx = this.upcoming.findIndex((e) => this.isTrackPlayableFn(e.trackId));
    if (nextIdx >= 0) {
      this.archiveCurrentToHistory(outgoingHistoryStatus);
      const copy = [...this.upcoming];
      const [picked] = copy.splice(nextIdx, 1);
      // Drop leading unplayable missing entries before picked so they don't clog Up Next
      this.upcoming = copy.slice(nextIdx);
      this.currentEntry = picked;
      this.currentEntryStarted = false;
      this.currentEntryFailed = false;
      this.resetRepeatRuntimeForCurrent();
      this.emit();
      return { entry: picked, status: 'ok' };
    }

    if (allowRepeatAllCycle) {
      const cycleEntries = this.buildRepeatCycleEntries();
      nextIdx = cycleEntries.findIndex((e) => this.isTrackPlayableFn(e.trackId));
      if (nextIdx >= 0) {
        this.archiveCurrentToHistory(outgoingHistoryStatus);
        this.playedIndicesInRound.clear();
        const picked = cycleEntries[nextIdx];
        if (typeof picked.contextOrderIndex === 'number') {
          this.playedIndicesInRound.add(picked.contextOrderIndex);
        }
        this.upcoming = cycleEntries.slice(nextIdx + 1);
        this.currentEntry = picked;
        this.currentEntryStarted = false;
        this.currentEntryFailed = false;
        this.resetRepeatRuntimeForCurrent();
        this.emit();
        return { entry: picked, status: 'ok' };
      }
    }

    return { entry: null, status: 'empty' };
  }

  private buildSnapshot(): PlaybackQueueState {
    const repeatRuntime: RepeatRuntimeState = {
      queueEntryId: this.currentEntry?.queueEntryId ?? null,
      remainingReplays: this.currentEntry ? this.remainingReplays : 0,
    };

    const sourceContextBefore: PlaybackQueueEntry[] = [];
    if (
      !this.controls.shuffleEnabled &&
      this.context &&
      this.currentEntry &&
      this.currentEntry.sourceContextId === this.context.contextId &&
      typeof this.currentEntry.contextOrderIndex === 'number' &&
      this.currentEntry.contextOrderIndex > 0
    ) {
      const playedStatusByIdx = new Map<number, QueueHistoryStatus>();
      for (const h of this.history) {
        if (
          h.sourceContextId === this.context.contextId &&
          typeof h.contextOrderIndex === 'number' &&
          h.historyStatus
        ) {
          playedStatusByIdx.set(h.contextOrderIndex, h.historyStatus);
        }
      }
      for (let i = 0; i < this.currentEntry.contextOrderIndex; i += 1) {
        if (this.removedContextIndices.has(i)) continue;
        sourceContextBefore.push({
          queueEntryId: `ctx-before-${this.context.contextId}-${i}`,
          trackId: this.context.trackIds[i],
          sourceContextId: this.context.contextId,
          origin: 'context',
          contextOrderIndex: i,
          insertionOrder: i,
          historyStatus: playedStatusByIdx.get(i),
        });
      }
    }

    return {
      currentEntry: this.currentEntry ? { ...this.currentEntry } : null,
      history: this.history.map((e) => ({ ...e })),
      upcoming: this.upcoming.map((e) => ({ ...e })),
      sourceContextBefore,
      controls: { ...this.controls },
      context: this.context
        ? {
            ...this.context,
            trackIds: [...this.context.trackIds],
          }
        : null,
      repeatRuntime,
    };
  }

  private emit(): void {
    this.cachedSnapshot = this.buildSnapshot();
    for (const listener of this.listeners) {
      listener(this.cachedSnapshot);
    }
  }
}
