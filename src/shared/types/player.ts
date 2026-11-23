import type { TrackRecord } from './track';

export type PlaybackStatus =
  | 'idle'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error';

export interface PlaybackState {
  status: PlaybackStatus;
  currentTrackId: string | null;
  currentTrack: TrackRecord | null;
  currentTimeSeconds: number;
  durationSeconds: number;
  volume: number;
  muted: boolean;
  errorMessage: string | null;
  canPrevious: boolean;
  canNext: boolean;
}

export interface AudioEngineController {
  play(trackId: string): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  seek(seconds: number): void;
  next(): Promise<void>;
  previous(): Promise<void>;
  setVolume(value: number): void;
  toggleMute(): void;
  getPlaybackState(): PlaybackState;
  setQueue(tracks: TrackRecord[]): void;
  subscribe(listener: (state: PlaybackState) => void): () => void;
}
