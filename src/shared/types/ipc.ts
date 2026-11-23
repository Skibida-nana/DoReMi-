import type {
  AppRuntimeInfo,
  ImportSummary,
  LibrarySnapshot,
  ScanProgressEvent,
  TrackStatusChangedEvent,
  VerifyTrackResult,
} from './library';
import type {
  CustomEditorialFontRecord,
  ListeningSessionInput,
  LocalUserProfile,
  LyricsEncodingOption,
  PersonalizationPreferences,
  StatisticsDashboardData,
  StatisticsQuery,
} from './stage5';
import type {
  ResolvedTrackLyrics,
  TrackMetadataOverrideInput,
  TrackRecord,
} from './track';

export interface CustomArtworkActionResult {
  canceled: boolean;
  track: TrackRecord | null;
  error?: string;
}

export interface CustomLyricsImportResult {
  canceled: boolean;
  lyrics: ResolvedTrackLyrics | null;
  detectedEncoding?: string;
  error?: string;
}

export interface ProfileMediaActionResult {
  canceled: boolean;
  profile?: LocalUserProfile;
  preferences?: PersonalizationPreferences;
  font?: CustomEditorialFontRecord;
  error?: string;
}

export interface LosslessDesktopApi {
  getAppInfo(): Promise<AppRuntimeInfo>;
  getLibrarySnapshot(): Promise<LibrarySnapshot>;
  importFiles(): Promise<ImportSummary>;
  importFolder(): Promise<ImportSummary>;
  rescanLibrary(): Promise<ImportSummary>;
  verifyTrack(trackId: string): Promise<VerifyTrackResult>;
  onScanProgress(callback: (event: ScanProgressEvent) => void): () => void;
  onTrackStatusChanged(callback: (event: TrackStatusChangedEvent) => void): () => void;

  // Stage 3: Artwork
  importCustomArtwork(trackId: string): Promise<CustomArtworkActionResult>;
  removeCustomArtwork(trackId: string): Promise<CustomArtworkActionResult>;

  // Stage 3 + Stage 5: Lyrics (Multilingual & Encoding-Safe)
  getTrackLyrics(trackId: string): Promise<ResolvedTrackLyrics>;
  importTrackLyricsFile(
    trackId: string,
    encoding?: LyricsEncodingOption,
  ): Promise<CustomLyricsImportResult>;
  saveCustomLyrics(
    trackId: string,
    format: 'lrc' | 'txt',
    content: string,
  ): Promise<ResolvedTrackLyrics>;
  removeCustomLyrics(trackId: string): Promise<ResolvedTrackLyrics>;

  // Stage 3: In-app Metadata Overrides (SQLite only)
  updateTrackMetadataOverride(
    trackId: string,
    input: TrackMetadataOverrideInput,
  ): Promise<TrackRecord>;
  restoreTrackMetadataOriginal(trackId: string): Promise<TrackRecord>;

  // Stage 5: Local Profile, Avatar (JPG/PNG/WEBP/GIF) & Personalization Hub
  getProfile(): Promise<LocalUserProfile>;
  updateProfileDisplayName(displayName: string): Promise<LocalUserProfile>;
  importProfileAvatar(): Promise<ProfileMediaActionResult>;
  removeProfileAvatar(): Promise<LocalUserProfile>;

  getPreferences(): Promise<PersonalizationPreferences>;
  updatePreferences(
    partial: Partial<PersonalizationPreferences>,
  ): Promise<PersonalizationPreferences>;
  importCustomBackground(): Promise<ProfileMediaActionResult>;
  removeCustomBackground(): Promise<PersonalizationPreferences>;
  importEditorialFont(): Promise<ProfileMediaActionResult>;
  deleteEditorialFont(fontId: string): Promise<PersonalizationPreferences>;

  // Stage 5: Real SQLite Listening Statistics
  recordListeningSession(input: ListeningSessionInput): Promise<{ qualifiedPlay: boolean }>;
  getListeningStatistics(query: StatisticsQuery): Promise<StatisticsDashboardData>;

  // Stage 6: Watched Folders, Collections Sync, Backup/Restore, Relink, Explorer & Diagnostics
  removeLibraryRoot?(rootId: string): Promise<{ removed: boolean }>;
  getFolderWatcherStatus?(): Promise<import('./stage6').FolderWatcherStatus>;
  onLibraryAutoUpdated?(
    callback: (event: import('./stage6').LibraryAutoUpdateEvent) => void,
  ): () => void;

  getPersistedCollections?(): Promise<import('./stage6').PersistedUserCollections | null>;
  savePersistedCollections?(
    collections: import('./stage6').PersistedUserCollections,
  ): Promise<{ saved: boolean }>;

  createBackup?(): Promise<import('./stage6').BackupCreateResult>;
  restoreBackup?(): Promise<import('./stage6').BackupRestoreResult>;
  scanRelinkFolder?(): Promise<import('./stage6').RelinkScanResult>;
  applyRelink?(
    selections: readonly import('./stage6').RelinkApplySelection[],
  ): Promise<import('./stage6').RelinkApplyResult>;

  consumePendingExternalFiles?(): Promise<import('./stage6').ExternalFilesOpenEvent | null>;
  onOpenExternalFiles?(
    callback: (event: import('./stage6').ExternalFilesOpenEvent) => void,
  ): () => void;
  getDiagnosticLogs?(): Promise<import('./stage6').DiagnosticLogEntry[]>;
}
