export type ReplayGainMode = 'off' | 'track' | 'album';

export interface ReplayGainSettings {
  mode: ReplayGainMode;
  preventClipping: boolean;
}

export interface TrackReplayGainMetadata {
  trackGainDb: number | null;
  albumGainDb: number | null;
  trackPeak: number | null;
  albumPeak: number | null;
}

export interface ComputedReplayGain {
  applied: boolean;
  source: 'none' | 'track' | 'album';
  gainDb: number;
  peak: number | null;
  linearGain: number;
  clippedPrevented: boolean;
}

export type SleepTimerPreset = 'off' | '15m' | '30m' | '45m' | '60m' | '90m' | 'end-of-track';

export interface SleepTimerState {
  active: boolean;
  preset: SleepTimerPreset;
  /** Epoch ms when countdown will expire, or null for off / end-of-track */
  endsAtMs: number | null;
  /** Remaining whole seconds for countdown modes, or null for off / end-of-track */
  remainingSeconds: number | null;
  /** Track ID armed for end-of-track mode (for visibility/debugging) */
  armedTrackId: string | null;
}

export interface FolderWatcherStatus {
  enabled: boolean;
  isWatching: boolean;
  activeRootCount: number;
  inaccessibleRootCount: number;
  lastEventAt: string | null;
  lastScanAt: string | null;
  lastSummaryMessage: string | null;
  pendingFileCount: number;
}

export interface LibraryAutoUpdateEvent {
  reason: 'watcher-added' | 'watcher-updated' | 'watcher-missing' | 'watcher-recovered' | 'relink' | 'restore';
  addedCount: number;
  updatedCount: number;
  missingMarkedCount: number;
  recoveredCount: number;
  message: string;
}

export interface ExternalFilesOpenEvent {
  filePaths: string[];
  importedTrackIds: string[];
  primaryTrackId: string | null;
  errors: Array<{ path: string; reason: string }>;
}

export interface PersistedPlaylistBackupItem {
  id: string;
  name: string;
  description: string;
  coverUrl: string | null;
  coverHash?: string | null;
  trackIds: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface PersistedUserCollections {
  playlists: PersistedPlaylistBackupItem[];
  favoriteTrackIds: string[];
  queueTrackIds: string[];
  currentTrackId: string | null;
  updatedAt: string;
}

export interface BackupAssetEntry {
  /** Normalized forward-slash relative path inside userData (e.g. "profile/media/avatar-xxx.gif") */
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface BackupManifest {
  format: 'doremi-backup';
  formatVersion: 1;
  schemaVersion: number;
  appVersion: string;
  exportedAt: string;
  includesOriginalAudioFiles: false;
  databaseSha256: string;
  databaseSizeBytes: number;
  counts: {
    tracks: number;
    roots: number;
    playlists: number;
    favorites: number;
    listeningSessions: number;
    artworkOverrides: number;
    lyricsOverrides: number;
    metadataOverrides: number;
    editorialFonts: number;
    assets: number;
  };
  assets: BackupAssetEntry[];
}

export interface BackupCreateResult {
  canceled: boolean;
  success: boolean;
  filePath?: string;
  fileSizeBytes?: number;
  manifest?: BackupManifest;
  error?: string;
}

export interface BackupValidationResult {
  valid: boolean;
  manifest?: BackupManifest;
  error?: string;
}

export interface BackupRestoreResult {
  canceled: boolean;
  success: boolean;
  safetyBackupPath?: string | null;
  manifest?: BackupManifest;
  missingTrackCount: number;
  missingTrackSamples: Array<{ id: string; title: string; originalPath: string }>;
  restoredCollections?: PersistedUserCollections | null;
  rolledBack?: boolean;
  error?: string;
}

export interface RelinkFileCandidate {
  filePath: string;
  normalizedPath: string;
  relativePath: string;
  fileName: string;
  durationMs: number | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  score: number;
  reasons: string[];
}

export interface RelinkTrackProposal {
  trackId: string;
  title: string;
  artist: string;
  album: string | null;
  previousPath: string;
  durationMs: number | null;
  matchStatus: 'matched' | 'ambiguous' | 'unmatched' | 'conflict';
  /** Automatically suggested file path only when matchStatus === 'matched' (high-confidence unique match) */
  suggestedPath: string | null;
  conflictTrackId?: string;
  conflictTrackTitle?: string;
  conflictReason?: string;
  candidates: RelinkFileCandidate[];
}

export interface RelinkScanResult {
  canceled: boolean;
  folderPath?: string;
  totalMissingTracks: number;
  matchedCount: number;
  ambiguousCount: number;
  unmatchedCount: number;
  conflictCount?: number;
  proposals: RelinkTrackProposal[];
  error?: string;
}

export interface RelinkApplySelection {
  trackId: string;
  newFilePath: string;
}

export interface RelinkApplyResult {
  relinkedCount: number;
  failedCount: number;
  errors: Array<{ trackId: string; path: string; reason: string }>;
}

export interface DiagnosticLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  sessionId?: string;
  code?: string;
  stage?: string;
  attemptId?: string;
  detail?: string;
}

export interface DiagnosticRecordInput {
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  code?: string;
  stage?: string;
  attemptId?: string;
  detail?: string;
}
