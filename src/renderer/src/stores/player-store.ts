import { useSyncExternalStore } from 'react';
import type {
  AudioDspRuntimeSnapshot,
  AudioLabSettings,
} from '../../../shared/types/audio-dsp';
import type {
  PlaybackContextDescriptor,
  PlaybackControlState,
  PlaybackQueueEntry,
  PlaybackQueueState,
  PlaybackState,
  RepeatMode,
} from '../../../shared/types/player';
import type {
  ListeningSessionInput,
  PlaybackTransitionSettings,
} from '../../../shared/types/stage5';
import type { ReplayGainSettings } from '../../../shared/types/stage6';
import type { TrackRecord } from '../../../shared/types/track';
import {
  findActiveLyricGroupIndex,
  type TimedLyricGroup,
} from '../../../shared/utils/lyrics-parser';
import { getAudioEngine } from '../player/audio-engine';

let externalSessionListener: ((session: ListeningSessionInput) => void) | null = null;
let externalEntryActivatedListener:
  | ((entry: PlaybackQueueEntry) => Promise<void> | void)
  | null = null;

export function setLocalSessionCheckpointListener(
  listener: ((session: ListeningSessionInput) => void) | null,
): void {
  externalSessionListener = listener;
}

export function setExternalQueueEntryListener(
  listener: ((entry: PlaybackQueueEntry) => Promise<void> | void) | null,
): void {
  externalEntryActivatedListener = listener;
}

const engine = getAudioEngine({
  verifyTrack: async (trackId) => {
    if (!window.losslessApi) {
      return {
        trackId,
        exists: false,
        status: 'missing',
        reason: 'Chức năng phát file cục bộ yêu cầu chạy trong ứng dụng desktop Electron.',
      };
    }
    return window.losslessApi.verifyTrack(trackId);
  },
  onSessionCheckpoint: (session) => {
    if (window.losslessApi) {
      void window.losslessApi.recordListeningSession(session).catch(() => {});
    }
    externalSessionListener?.(session);
  },
  onDiagnostic: (entry) => {
    void window.losslessApi?.recordDiagnosticLog?.(entry).catch(() => {});
  },
  onExternalEntryActivated: (entry) => externalEntryActivatedListener?.(entry),
});

export const playbackQueueController = engine.queueController;

export function syncEngineQueue(tracks: TrackRecord[]): void {
  engine.syncTrackCatalog(tracks);
}

export const playerActions = {
  play: (trackId: string) => engine.play(trackId),
  playQueueEntry: (entry: PlaybackQueueEntry) =>
    engine.playQueueEntry(entry, { fromAutoAdvance: false }),
  playFromContext: (
    context: PlaybackContextDescriptor,
    startTrackId?: string,
    shuffle?: boolean,
  ) => engine.playFromContext(context, startTrackId, shuffle),
  pause: () => engine.pause(),
  pauseSilently: () => engine.pauseSilently(),
  resume: () => engine.resume(),
  togglePlayPause: async () => {
    const state = engine.getPlaybackState();
    if (state.status === 'playing' || state.status === 'loading') {
      engine.pause();
    } else {
      await engine.resume();
    }
  },
  seek: (seconds: number) => engine.seek(seconds),
  next: () => engine.next(),
  previous: () => engine.previous(),
  setVolume: (value: number) => engine.setVolume(value),
  toggleMute: () => engine.toggleMute(),
  setShuffle: (enabled: boolean) => engine.setShuffle(enabled),
  toggleShuffle: () => engine.toggleShuffle(),
  setRepeatMode: (mode: RepeatMode) => engine.setRepeatMode(mode),
  cycleRepeatMode: () => engine.cycleRepeatMode(),
  setAutoNext: (enabled: boolean) => engine.setAutoNext(enabled),
  toggleAutoNext: () => engine.toggleAutoNext(),
  setPlaybackControls: (partial: Partial<PlaybackControlState>) =>
    engine.queueController.setControls(partial),
  setTransitionConfig: (partial: Partial<PlaybackTransitionSettings>) =>
    engine.setTransitionConfig(partial),
  getTransitionConfig: () => engine.getTransitionConfig(),
  setAudioLabSettings: (settings: AudioLabSettings) => engine.setAudioLabSettings(settings),
  getAudioLabSettings: () => engine.getAudioLabSettings(),
  setReplayGainSettings: (partial: Partial<ReplayGainSettings>) =>
    engine.setReplayGainSettings(partial),
  getReplayGainSettings: () => engine.getReplayGainSettings(),
  ensureDspReady: () => engine.ensureDspReady(),
  readSpectrumData: (target: Uint8Array) => engine.readSpectrumData(target),
  getAnalyserBinCount: () => engine.getAnalyserBinCount(),
};

export function usePlaybackState(): PlaybackState {
  return useSyncExternalStore(
    (onStoreChange) => engine.subscribe(() => onStoreChange()),
    () => engine.getPlaybackState(),
  );
}

/**
 * Primitive playback status hook — skips re-renders on currentTimeSeconds ticks.
 */
export function usePlaybackStatus(): PlaybackState['status'] {
  return useSyncExternalStore(
    (onStoreChange) => engine.subscribeCore(() => onStoreChange()),
    () => engine.getCorePlaybackState().status,
  );
}

/**
 * Primitive active track ID hook — skips re-renders on timeupdate, volume, and pause ticks.
 */
export function usePlaybackTrackId(): PlaybackState['currentTrackId'] {
  return useSyncExternalStore(
    (onStoreChange) => engine.subscribeCore(() => onStoreChange()),
    () => engine.getCorePlaybackState().currentTrackId,
  );
}

/**
 * Core playback snapshot hook — retains stable reference across pure timeupdate ticks
 * unless track/status/volume/duration/error/controls or 3s canPrevious threshold changes.
 */
export function usePlaybackCoreState(): PlaybackState {
  return useSyncExternalStore(
    (onStoreChange) => engine.subscribeCore(() => onStoreChange()),
    () => engine.getCorePlaybackState(),
  );
}

/**
 * High-frequency playback position selector (seconds) for leaf progress/time components only.
 */
export function usePlaybackTimeSeconds(): number {
  return useSyncExternalStore(
    (onStoreChange) => engine.subscribe(() => onStoreChange()),
    () => engine.getPlaybackState().currentTimeSeconds,
  );
}

/**
 * Active synced-lyric group index selector: re-renders host ONLY when the active
 * lyric line actually advances (or returns -1 immediately when timed lyrics are inactive).
 */
export function useActiveLyricGroupIndex(
  lyricGroups: readonly TimedLyricGroup[],
  enabled: boolean,
): number {
  return useSyncExternalStore(
    (onStoreChange) => (enabled ? engine.subscribe(() => onStoreChange()) : () => {}),
    () => {
      if (!enabled || lyricGroups.length === 0) {
        return -1;
      }
      const state = engine.getPlaybackState();
      if (!state.currentTrackId) {
        return -1;
      }
      return findActiveLyricGroupIndex(lyricGroups, state.currentTimeSeconds);
    },
  );
}

/**
 * Subscribes ONLY to Queue / History / Playback Controls changes (NEVER fires on timeupdate progress ticks!).
 */
export function usePlaybackQueueState(): PlaybackQueueState {
  return useSyncExternalStore(
    (onStoreChange) => engine.queueController.subscribe(() => onStoreChange()),
    () => engine.queueController.getState(),
  );
}

export function useAudioDspState(): AudioDspRuntimeSnapshot {
  return useSyncExternalStore(
    (onStoreChange) => engine.subscribeDsp(() => onStoreChange()),
    () => engine.getDspRuntimeSnapshot(),
  );
}
