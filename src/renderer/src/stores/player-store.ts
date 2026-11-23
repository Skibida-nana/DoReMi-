import { useSyncExternalStore } from 'react';
import type { PlaybackState } from '../../../shared/types/player';
import type {
  ListeningSessionInput,
  PlaybackTransitionSettings,
} from '../../../shared/types/stage5';
import type { TrackRecord } from '../../../shared/types/track';
import { getAudioEngine } from '../player/audio-engine';

let externalSessionListener: ((session: ListeningSessionInput) => void) | null = null;

export function setLocalSessionCheckpointListener(
  listener: ((session: ListeningSessionInput) => void) | null,
): void {
  externalSessionListener = listener;
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
});

export function syncEngineQueue(tracks: TrackRecord[]): void {
  engine.setQueue(tracks);
}

export const playerActions = {
  play: (trackId: string) => engine.play(trackId),
  pause: () => engine.pause(),
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
  setTransitionConfig: (partial: Partial<PlaybackTransitionSettings>) =>
    engine.setTransitionConfig(partial),
  getTransitionConfig: () => engine.getTransitionConfig(),
};

export function usePlaybackState(): PlaybackState {
  return useSyncExternalStore(
    (onStoreChange) => engine.subscribe(() => onStoreChange()),
    () => engine.getPlaybackState(),
  );
}
