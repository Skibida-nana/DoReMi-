import type { TrackRecord } from './track';

export type PlaybackStatus =
  | 'idle'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error';

export type RepeatMode = 'off' | 'once' | 'twice' | 'one' | 'all';

export interface RepeatRuntimeState {
  queueEntryId: string | null;
  /** Number of automatic replays remaining for `queueEntryId`, or null when infinite ('one') */
  remainingReplays: number | null;
}

export interface PlaybackControlState {
  shuffleEnabled: boolean;
  repeatMode: RepeatMode;
  autoNextEnabled: boolean;
}

export type QueueEntryOrigin = 'context' | 'play-next' | 'manual';

export type QueueHistoryStatus = 'completed' | 'skipped' | 'error';

export interface PlaybackQueueEntry {
  queueEntryId: string;
  trackId: string;
  sourceContextId?: string;
  origin: QueueEntryOrigin;
  contextOrderIndex?: number;
  insertionOrder: number;
  historyStatus?: QueueHistoryStatus;
}

export type PlaybackContextKind =
  | 'library'
  | 'album'
  | 'playlist'
  | 'artist'
  | 'folder'
  | 'search'
  | 'single'
  | 'custom';

export interface PlaybackContextDescriptor {
  contextId: string;
  label: string;
  kind: PlaybackContextKind;
  trackIds: string[];
}

export interface PlaybackQueueState {
  currentEntry: PlaybackQueueEntry | null;
  history: PlaybackQueueEntry[];
  upcoming: PlaybackQueueEntry[];
  /**
   * When Shuffle is OFF and current track belongs to active source context,
   * represents preceding unplayed/context tracks before `currentEntry` in exact source order
   * (without falsely inserting unplayed tracks into playback `history`).
   */
  sourceContextBefore?: PlaybackQueueEntry[];
  controls: PlaybackControlState;
  context: PlaybackContextDescriptor | null;
  repeatRuntime: RepeatRuntimeState;
}

export type PlaybackErrorCode =
  | 'ERR_FILE_MISSING'
  | 'ERR_FILE_ACCESS_DENIED'
  | 'ERR_STREAM_READ_FAILED'
  | 'ERR_CONTAINER_CORRUPT_HEADER'
  | 'ERR_AUDIO_DECODE'
  | 'ERR_MEDIA_FORMAT_UNSUPPORTED'
  | 'ERR_ALAC_DECODE'
  | 'ERR_AUDIO_OUTPUT_INIT'
  | 'ERR_PLAYBACK_ABORTED'
  | 'ERR_REMOTE_AUTH_FAILED'
  | 'ERR_REMOTE_ACCESS_REVOKED'
  | 'ERR_REMOTE_TRACK_NOT_FOUND'
  | 'ERR_REMOTE_RESOURCE_LIMIT'
  | 'ERR_REMOTE_STREAM_INTERRUPTED'
  | 'ERR_REMOTE_NETWORK_TIMEOUT'
  | 'ERR_REMOTE_RESPONSE_INVALID'
  | 'ERR_UNKNOWN_PLAYBACK';

export type PlaybackErrorStage =
  | 'queue-lookup'
  | 'file-verify'
  | 'protocol-url'
  | 'dsp-init'
  | 'stream-load'
  | 'play-start'
  | 'audio-decode'
  | 'runtime-media';

export interface PlaybackErrorDetails {
  code: PlaybackErrorCode;
  stage: PlaybackErrorStage;
  summary: string;
  suggestion: string;
  technicalDetail: string;
  mediaErrorCode: number | null;
  attemptId: string;
  timestamp: string;
  trackId: string | null;
  trackTitle: string | null;
  codec: string | null;
  container: string | null;
  isMissingFile: boolean;
}

export interface PlaybackState {
  status: PlaybackStatus;
  currentTrackId: string | null;
  currentQueueEntryId: string | null;
  currentTrack: TrackRecord | null;
  currentTimeSeconds: number;
  durationSeconds: number;
  volume: number;
  muted: boolean;
  errorMessage: string | null;
  playbackError?: PlaybackErrorDetails | null;
  canPrevious: boolean;
  canNext: boolean;
  playbackGeneration: number;
  shuffleEnabled: boolean;
  repeatMode: RepeatMode;
  autoNextEnabled: boolean;
  remainingReplays: number | null;
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
