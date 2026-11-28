import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../shared/contracts/channels';
import type { LosslessDesktopApi } from '../shared/types/ipc';
import type {
  RemoveWatchedFolderMode,
  ScanProgressEvent,
  TrackStatusChangedEvent,
} from '../shared/types/library';
import type {
  AddTracksToPlaylistOptions,
  CreatePlaylistInput,
  LegacyCollectionsMigrationInput,
  UpdatePlaylistInput,
} from '../shared/types/playlist';
import type {
  ListeningSessionInput,
  LyricsEncodingOption,
  PersonalizationPreferences,
  StatisticsQuery,
} from '../shared/types/stage5';
import type { DiagnosticRecordInput, RelinkApplySelection } from '../shared/types/stage6';
import type { TrackMetadataOverrideInput } from '../shared/types/track';
import type { ConnectClientSnapshot, HostSnapshot } from '../shared/types/connect';

/**
 * Exposes a strictly typed, minimal API surface to the sandboxed Renderer.
 * Never exposes raw ipcRenderer, Node fs, or arbitrary filesystem commands.
 */
const losslessApi: LosslessDesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_INFO),

  probeOptionalCodecs: (forceRefresh = false) =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_PROBE_CODECS, forceRefresh),

  getLibrarySnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.LIBRARY_GET_SNAPSHOT),

  importFiles: () => ipcRenderer.invoke(IPC_CHANNELS.LIBRARY_IMPORT_FILES),

  importFolder: () => ipcRenderer.invoke(IPC_CHANNELS.LIBRARY_IMPORT_FOLDER),

  rescanLibrary: () => ipcRenderer.invoke(IPC_CHANNELS.LIBRARY_RESCAN),

  verifyTrack: (trackId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIBRARY_VERIFY_TRACK, trackId),

  onScanProgress: (callback: (event: ScanProgressEvent) => void) => {
    const listener = (_ipcEvent: IpcRendererEvent, payload: ScanProgressEvent) => {
      callback(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.LIBRARY_SCAN_PROGRESS, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.LIBRARY_SCAN_PROGRESS, listener);
    };
  },

  onTrackStatusChanged: (callback: (event: TrackStatusChangedEvent) => void) => {
    const listener = (
      _ipcEvent: IpcRendererEvent,
      payload: TrackStatusChangedEvent,
    ) => {
      callback(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.LIBRARY_TRACK_STATUS_CHANGED, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.LIBRARY_TRACK_STATUS_CHANGED, listener);
    };
  },

  // Stage 3: Custom Artwork
  importCustomArtwork: (trackId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ARTWORK_IMPORT_CUSTOM, trackId),

  removeCustomArtwork: (trackId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ARTWORK_REMOVE_CUSTOM, trackId),

  // Stage 3 + Stage 5: Multilingual Lyrics
  getTrackLyrics: (trackId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LYRICS_GET, trackId),

  importTrackLyricsFile: (trackId: string, encoding?: LyricsEncodingOption) =>
    ipcRenderer.invoke(IPC_CHANNELS.LYRICS_IMPORT_FILE, trackId, encoding),

  saveCustomLyrics: (trackId: string, format: 'lrc' | 'txt', content: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LYRICS_SAVE_CUSTOM, trackId, format, content),

  removeCustomLyrics: (trackId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LYRICS_REMOVE_CUSTOM, trackId),

  // Stage 3: Metadata Overrides (SQLite only)
  updateTrackMetadataOverride: (trackId: string, input: TrackMetadataOverrideInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.METADATA_UPDATE_OVERRIDE, trackId, input),

  restoreTrackMetadataOriginal: (trackId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.METADATA_RESTORE_ORIGINAL, trackId),

  // Stage 5: Local Profile & Personalization Hub
  getProfile: () => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_GET),

  updateProfileDisplayName: (displayName: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILE_UPDATE_NAME, displayName),

  importProfileAvatar: () => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_IMPORT_AVATAR),

  removeProfileAvatar: () => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_REMOVE_AVATAR),

  getPreferences: () => ipcRenderer.invoke(IPC_CHANNELS.PREFERENCES_GET),

  updatePreferences: (partial: Partial<PersonalizationPreferences>) =>
    ipcRenderer.invoke(IPC_CHANNELS.PREFERENCES_UPDATE, partial),

  importCustomBackground: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PREFERENCES_IMPORT_BACKGROUND),

  removeCustomBackground: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PREFERENCES_REMOVE_BACKGROUND),

  importEditorialFont: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PREFERENCES_IMPORT_EDITORIAL_FONT),

  deleteEditorialFont: (fontId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PREFERENCES_DELETE_EDITORIAL_FONT, fontId),

  // Stage 5: Real SQLite Listening Statistics
  recordListeningSession: (input: ListeningSessionInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.STATISTICS_RECORD_SESSION, input),

  getListeningStatistics: (query: StatisticsQuery) =>
    ipcRenderer.invoke(IPC_CHANNELS.STATISTICS_GET_DASHBOARD, query),

  getDiagnosticLogs: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_DIAGNOSTICS),

  recordDiagnosticLog: (entry: DiagnosticRecordInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_RECORD_DIAGNOSTIC, entry),

  // Phase 3 / Phase 8: Track Removal, Exclusions, Sources, Relink, Playlists & Favorites
  removeLibraryRoot: (rootId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIBRARY_REMOVE_ROOT, rootId),

  scanRelinkFolder: () => ipcRenderer.invoke(IPC_CHANNELS.RELINK_SCAN_FOLDER),

  applyRelink: (selections: readonly RelinkApplySelection[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.RELINK_APPLY, selections),

  removeTracksFromLibrary: (trackIds: readonly string[], options?: { addExclusion?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIBRARY_REMOVE_TRACKS, trackIds, options),

  showTrackInFolder: (trackId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIBRARY_SHOW_IN_FOLDER, trackId),

  listWatchedFolders: () => ipcRenderer.invoke(IPC_CHANNELS.LIBRARY_LIST_FOLDERS),

  rescanWatchedFolder: (rootId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIBRARY_RESCAN_FOLDER, rootId),

  removeWatchedFolder: (rootId: string, mode: RemoveWatchedFolderMode) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIBRARY_REMOVE_FOLDER, rootId, mode),

  clearAllImportedMusic: () => ipcRenderer.invoke(IPC_CHANNELS.LIBRARY_CLEAR_ALL),

  listExcludedTracks: () => ipcRenderer.invoke(IPC_CHANNELS.LIBRARY_LIST_EXCLUSIONS),

  reimportExcludedTracks: (exclusionIds?: readonly string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIBRARY_REIMPORT_EXCLUSIONS, exclusionIds),

  clearExclusions: (exclusionIds?: readonly string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIBRARY_CLEAR_EXCLUSIONS, exclusionIds),

  cancelRescan: () => ipcRenderer.invoke(IPC_CHANNELS.LIBRARY_CANCEL_RESCAN),

  updateLibraryRootSettings: (
    rootId: string,
    patch: { recursive?: boolean; enabled?: boolean; auto_watch?: boolean },
  ) => ipcRenderer.invoke(IPC_CHANNELS.LIBRARY_UPDATE_ROOT_SETTINGS, rootId, patch),

  relinkSingleTrackDialog: (trackId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.RELINK_SINGLE_TRACK_DIALOG, trackId),

  getPlaylistSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST_GET_SNAPSHOT),

  createPlaylist: (input: CreatePlaylistInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST_CREATE, input),

  updatePlaylist: (playlistId: string, input: UpdatePlaylistInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST_UPDATE, playlistId, input),

  deletePlaylist: (playlistId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST_DELETE, playlistId),

  addTracksToPlaylist: (
    playlistId: string,
    trackIds: readonly string[],
    options?: AddTracksToPlaylistOptions,
  ) => ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST_ADD_TRACKS, playlistId, trackIds, options),

  removeEntriesFromPlaylist: (playlistId: string, entryIds: readonly string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST_REMOVE_ENTRIES, playlistId, entryIds),

  reorderPlaylistEntries: (playlistId: string, orderedEntryIds: readonly string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST_REORDER_ENTRIES, playlistId, orderedEntryIds),

  importPlaylistArtwork: (playlistId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST_IMPORT_ARTWORK, playlistId),

  removePlaylistArtwork: (playlistId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST_REMOVE_ARTWORK, playlistId),

  migrateLegacyCollectionsToSqlite: (legacy: LegacyCollectionsMigrationInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLAYLIST_MIGRATE_LEGACY, legacy),

  toggleFavoriteTrack: (trackId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FAVORITE_TOGGLE, trackId),

  setFavoriteTracks: (trackIds: readonly string[], favorite: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.FAVORITE_SET_MANY, trackIds, favorite),

  // Phase 6.1: DoReMi Connect
  connectGetHostSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_GET_SNAPSHOT),
  connectStartHost: () => ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_START),
  connectStopHost: () => ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_STOP),
  connectUpdateHostConfig: (patch) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_UPDATE_CONFIG, patch),
  connectAddSharedSource: (rootId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_ADD_SHARED_SOURCE, rootId),
  connectRemoveSharedSource: (rootId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_REMOVE_SHARED_SOURCE, rootId),
  connectCreateInvitation: (options) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_CREATE_INVITATION, options),
  connectRevokeInvitation: () => ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_REVOKE_INVITATION),
  connectApproveEnrollment: (requestId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_APPROVE_ENROLLMENT, requestId),
  connectRejectEnrollment: (requestId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_REJECT_ENROLLMENT, requestId),
  connectRenameDevice: (deviceId: string, displayName: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_RENAME_DEVICE, deviceId, displayName),
  connectDisconnectDevice: (deviceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_DISCONNECT_DEVICE, deviceId),
  connectRevokeDevice: (deviceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_REVOKE_DEVICE, deviceId),
  connectRemoveDevice: (deviceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_REMOVE_DEVICE, deviceId),
  connectSetDeviceRemoteAccess: (deviceId: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_SET_DEVICE_REMOTE_ACCESS, deviceId, enabled),
  connectCheckRemoteProvider: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_CHECK_REMOTE_PROVIDER),
  connectEnableRemoteAccess: (options) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_ENABLE_REMOTE_ACCESS, options),
  connectDisableRemoteAccess: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_DISABLE_REMOTE_ACCESS),
  connectRotateHostIdentity: () => ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_ROTATE_IDENTITY),
  connectSetHostPowerPolicy: (
    policy: 'follow-system' | 'keep-awake-streaming' | 'keep-awake-host-on',
  ) => ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_SET_POWER_POLICY, policy),
  connectGetHostResourceBreakdown: (options?: { includeTailscaleProcesses?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_HOST_GET_RESOURCE_BREAKDOWN, options),
  onConnectHostStateChanged: (callback: (snapshot: HostSnapshot) => void) => {
    const listener = (_ipcEvent: IpcRendererEvent, payload: HostSnapshot) => {
      callback(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.CONNECT_HOST_STATE_CHANGED, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CONNECT_HOST_STATE_CHANGED, listener);
    };
  },

  connectGetClientSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_GET_SNAPSHOT),
  connectDiscoverHosts: (timeoutMs?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_DISCOVER, timeoutMs),
  connectProbeHost: (address: string, port: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_PROBE_HOST, address, port),
  connectEnrollWithHost: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_ENROLL, input),
  connectEnrollFromPairingPayload: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_ENROLL_PAYLOAD, input),
  connectToRememberedHost: (
    hostId: string,
    overrideAddress?: string,
    overridePort?: number,
    explicitMode?: 'lan-direct' | 'remote-https',
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.CONNECT_CLIENT_CONNECT,
      hostId,
      overrideAddress,
      overridePort,
      explicitMode,
    ),
  connectSyncRemoteAccess: (hostId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_SYNC_REMOTE_ACCESS, hostId),
  connectSetPreferredTransport: (hostId: string, mode: 'lan-direct' | 'remote-https') =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_SET_PREFERRED_TRANSPORT, hostId, mode),
  connectSetConnectionMode: (
    hostId: string,
    mode: 'automatic' | 'lan-only' | 'remote-only',
  ) => ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_SET_CONNECTION_MODE, hostId, mode),
  connectManualReconnect: () => ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_MANUAL_RECONNECT),
  connectNotifyNetworkHint: (hint: 'online' | 'offline' | 'recheck') =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_NOTIFY_NETWORK_HINT, hint),
  connectVerifyTrackSource: (params) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_VERIFY_TRACK_SOURCE, params),
  connectRecordHandoverOutcome: (params) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_RECORD_HANDOVER_OUTCOME, params),
  connectRotateHostToken: () => ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_ROTATE_TOKEN),
  connectDisconnectClient: () => ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_DISCONNECT),
  connectRemoveRememberedHost: (hostId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_REMOVE_REMEMBERED, hostId),
  connectListRemoteTracks: (options) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_LIST_TRACKS, options),
  connectListRemoteAlbums: (options) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_LIST_ALBUMS, options),
  connectListRemoteArtists: (options) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_LIST_ARTISTS, options),
  connectGetRemoteLyrics: (hostId: string, trackId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_GET_LYRICS, hostId, trackId),
  connectGetClientDiagnostics: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECT_CLIENT_GET_DIAGNOSTICS),
  onConnectClientStateChanged: (callback: (snapshot: ConnectClientSnapshot) => void) => {
    const listener = (_ipcEvent: IpcRendererEvent, payload: ConnectClientSnapshot) => {
      callback(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.CONNECT_CLIENT_STATE_CHANGED, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CONNECT_CLIENT_STATE_CHANGED, listener);
    };
  },
};

contextBridge.exposeInMainWorld('losslessApi', losslessApi);
