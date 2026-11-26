import type {
  AppRuntimeInfo,
  ClearLibraryResult,
  ImportSummary,
  LibraryExclusionRecord,
  LibraryRootRecord,
  LibrarySnapshot,
  OptionalCodecStatusReport,
  ReimportExcludedResult,
  RelinkSingleFileResult,
  RemoveTracksResult,
  RemoveWatchedFolderMode,
  RemoveWatchedFolderResult,
  ScanProgressEvent,
  TrackStatusChangedEvent,
  TrashTrackFilesResult,
  VerifyTrackResult,
  WatchedFolderSummary,
} from './library';
import type {
  AddTracksToPlaylistOptions,
  AddTracksToPlaylistResult,
  CreatePlaylistInput,
  LegacyCollectionsMigrationInput,
  PlaylistArtworkActionResult,
  PlaylistRecord,
  PlaylistSnapshot,
  UpdatePlaylistInput,
} from './playlist';
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
  probeOptionalCodecs?(forceRefresh?: boolean): Promise<OptionalCodecStatusReport>;
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
  recordDiagnosticLog?(
    entry: import('./stage6').DiagnosticRecordInput,
  ): Promise<{ recorded: boolean }>;

  // Phase 8: Library Track Removal, Exclusions, Watched Folders & Optional Recycle Bin (Not yet wired in preload/IPC)
  removeTracksFromLibrary?(
    trackIds: readonly string[],
    options?: { addExclusion?: boolean },
  ): Promise<RemoveTracksResult>;
  trashOriginalTrackFiles?(trackIds: readonly string[]): Promise<TrashTrackFilesResult>;
  showTrackInFolder?(trackId: string): Promise<{ shown: boolean; error?: string }>;
  listWatchedFolders?(): Promise<WatchedFolderSummary[]>;
  rescanWatchedFolder?(rootId: string): Promise<ImportSummary>;
  removeWatchedFolder?(
    rootId: string,
    mode: RemoveWatchedFolderMode,
  ): Promise<RemoveWatchedFolderResult>;
  clearAllImportedMusic?(): Promise<ClearLibraryResult>;
  listExcludedTracks?(): Promise<LibraryExclusionRecord[]>;
  reimportExcludedTracks?(exclusionIds?: readonly string[]): Promise<ReimportExcludedResult>;
  clearExclusions?(exclusionIds?: readonly string[]): Promise<{ clearedCount: number }>;

  // Phase 3: Cancel Rescan, Root Settings, Single File Relink, SQLite Playlists & Favorites
  cancelRescan?(): Promise<{ canceled: boolean }>;
  updateLibraryRootSettings?(
    rootId: string,
    patch: { recursive?: boolean; enabled?: boolean; auto_watch?: boolean },
  ): Promise<LibraryRootRecord | null>;
  relinkSingleTrackDialog?(trackId: string): Promise<RelinkSingleFileResult>;
  getPlaylistSnapshot?(): Promise<PlaylistSnapshot>;
  createPlaylist?(input: CreatePlaylistInput): Promise<PlaylistRecord>;
  updatePlaylist?(playlistId: string, input: UpdatePlaylistInput): Promise<PlaylistRecord>;
  deletePlaylist?(playlistId: string): Promise<{ deleted: boolean }>;
  addTracksToPlaylist?(
    playlistId: string,
    trackIds: readonly string[],
    options?: AddTracksToPlaylistOptions,
  ): Promise<AddTracksToPlaylistResult>;
  removeEntriesFromPlaylist?(
    playlistId: string,
    entryIds: readonly string[],
  ): Promise<PlaylistRecord>;
  reorderPlaylistEntries?(
    playlistId: string,
    orderedEntryIds: readonly string[],
  ): Promise<PlaylistRecord>;
  importPlaylistArtwork?(playlistId: string): Promise<PlaylistArtworkActionResult>;
  removePlaylistArtwork?(playlistId: string): Promise<PlaylistArtworkActionResult>;
  migrateLegacyCollectionsToSqlite?(
    legacy: LegacyCollectionsMigrationInput,
  ): Promise<PlaylistSnapshot>;
  toggleFavoriteTrack?(trackId: string): Promise<{ isFavorite: boolean; favoriteTrackIds: string[] }>;
  setFavoriteTracks?(
    trackIds: readonly string[],
    favorite: boolean,
  ): Promise<{ favoriteTrackIds: string[] }>;

  // Native Audio Codec Engine, Default Encoder Pack, Converter, Analyzer & Update Manager (Isolated in Phase 01; wired in Phase 04/05)
  getCodecInventory?(): Promise<import('./codec-engine').CodecInventorySnapshot>;
  rescanCodecs?(): Promise<import('./codec-engine').CodecInventorySnapshot>;
  importEncoderPackFolder?(): Promise<import('./codec-engine').CodecImportPackResult>;
  importCustomCodecBinary?(
    codecId: import('./codec-engine').CodecId,
  ): Promise<import('./codec-engine').CodecImportBinaryResult>;
  removeCustomCodecBinary?(
    codecId: import('./codec-engine').CodecId,
  ): Promise<import('./codec-engine').CodecInventorySnapshot>;
  openCodecsDirectory?(): Promise<{ opened: boolean; path: string }>;
  checkCodecUpdates?(manifestUrl?: string): Promise<import('./codec-engine').CodecUpdateCheckResult>;
  rollbackCodecPack?(): Promise<{ rolledBack: boolean; message: string; inventory: import('./codec-engine').CodecInventorySnapshot }>;
  analyzeTrackAudio?(trackId: string): Promise<import('./codec-engine').AudioAnalysisReport>;
  analyzeAudioFileDialog?(): Promise<{ canceled: boolean; report: import('./codec-engine').AudioAnalysisReport | null; error?: string }>;
  selectConvertOutputDirectory?(): Promise<{ canceled: boolean; directoryPath: string | null }>;
  selectConvertInputFiles?(): Promise<{ canceled: boolean; items: import('./codec-engine').ConversionJobInputItem[] }>;
  getConversionQueue?(): Promise<import('./codec-engine').ConversionQueueSnapshot>;
  enqueueAudioConversion?(
    items: readonly import('./codec-engine').ConversionJobInputItem[],
    options: Partial<import('./codec-engine').AudioConvertOptions>,
  ): Promise<import('./codec-engine').ConversionQueueSnapshot>;
  cancelConversionJob?(jobId: string): Promise<import('./codec-engine').ConversionQueueSnapshot>;
  cancelAllConversionJobs?(): Promise<import('./codec-engine').ConversionQueueSnapshot>;
  retryFailedConversionJobs?(): Promise<import('./codec-engine').ConversionQueueSnapshot>;
  clearFinishedConversionJobs?(): Promise<import('./codec-engine').ConversionQueueSnapshot>;
  onConversionQueueUpdated?(
    callback: (snapshot: import('./codec-engine').ConversionQueueSnapshot) => void,
  ): () => void;
  onConversionJobProgress?(
    callback: (event: import('./codec-engine').ConversionProgressEvent) => void,
  ): () => void;
  getStreamingTranscodingPlans?(
    trackId?: string,
  ): Promise<import('./codec-engine').StreamingTranscodePlan[]>;
}
