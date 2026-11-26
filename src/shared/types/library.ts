import type { TrackAvailabilityState, TrackRecord, TrackStatus } from './track';

export type LibraryRootStatus = 'available' | 'missing';

export interface LibraryRootRecord {
  id: string;
  original_path: string;
  normalized_path: string;
  added_at: string;
  last_scanned_at: string | null;
  status: LibraryRootStatus;
  availability_state?: TrackAvailabilityState;
  availability_reason?: string | null;
  recursive?: boolean;
  enabled?: boolean;
  last_successful_scan_at?: string | null;
  auto_watch?: boolean;
}

export interface ImportErrorItem {
  path: string;
  reason: string;
}

export interface ImportSummary {
  canceled: boolean;
  scannedCount: number;
  addedCount: number;
  updatedCount: number;
  skippedCount: number;
  missingMarkedCount: number;
  recoveredCount: number;
  errors: ImportErrorItem[];
  rootCount?: number;
  excludedSkippedCount?: number;
  duplicateSkippedCount?: number;
  sourceUnavailableCount?: number;
  accessErrorCount?: number;
  relinkCandidateCount?: number;
  newMissingIds?: string[];
  relinkSuggestedTrackIds?: string[];
}

export type ScanPhase = 'discovering' | 'importing' | 'verifying' | 'completed' | 'canceled';

export interface RelinkSingleFileResult {
  canceled: boolean;
  success: boolean;
  track: TrackRecord | null;
  conflictTrackId?: string;
  conflictTrackTitle?: string;
  error?: string;
}

export interface ScanProgressEvent {
  phase: ScanPhase;
  current: number;
  total: number;
  currentPath: string | null;
  message: string;
}

export interface LibrarySnapshot {
  tracks: TrackRecord[];
  roots: LibraryRootRecord[];
  databasePath: string;
}

export interface VerifyTrackResult {
  trackId: string;
  exists: boolean;
  status: TrackStatus;
  reason?: string;
}

export interface TrackStatusChangedEvent {
  trackId: string;
  status: TrackStatus;
  reason?: string;
}

export type AppReleaseChannel = 'Stable' | 'Release Candidate' | 'Beta' | 'Development';

export interface AppRuntimeInfo {
  appName: string;
  appVersion: string;
  electronVersion: string;
  chromeVersion?: string;
  nodeVersion?: string;
  v8Version?: string;
  arch?: string;
  osRelease?: string;
  sqliteVersion?: string;
  releaseChannel?: AppReleaseChannel;
  alacDecoderVersion?: string;
  operatingMode?: string;
  platform: string;
  databasePath: string;
}

export interface OptionalCodecStatusReport {
  checkedAt: string;
  isolated: boolean;
  bundledPackDetected: boolean;
  ffmpegDetected: boolean;
  ffmpegVersion: string | null;
  readyCount: number;
  missingCount: number;
  summary: string;
}

export interface LibraryExclusionRecord {
  id: string;
  normalized_path: string;
  original_path: string;
  root_id: string | null;
  file_size_bytes: number | null;
  modified_at_ms: number | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  reason: string;
  excluded_at: string;
}

export interface WatchedFolderSummary extends LibraryRootRecord {
  exists: boolean;
  trackCount: number;
  missingCount?: number;
}

export interface RemoveTracksResult {
  removedTrackIds: string[];
  excludedCount: number;
  notFoundIds: string[];
}

export type RemoveWatchedFolderMode = 'stop-watching' | 'remove-tracks';

export interface RemoveWatchedFolderResult {
  removed: boolean;
  rootId: string;
  mode: RemoveWatchedFolderMode;
  removedTrackIds: string[];
  remainingRootCount: number;
}

export interface ClearLibraryResult {
  removedTrackCount: number;
  removedRootCount: number;
  clearedExclusionCount: number;
}

export interface TrashTrackFileFailure {
  trackId: string;
  title: string;
  path: string;
  error: string;
}

export interface TrashTrackFilesResult {
  trashedTrackIds: string[];
  failed: TrashTrackFileFailure[];
}

export interface ReimportExcludedResult {
  reimportedCount: number;
  clearedExclusionCount: number;
  summary: ImportSummary;
}
