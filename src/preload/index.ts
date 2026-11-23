import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../shared/contracts/channels';
import type { LosslessDesktopApi } from '../shared/types/ipc';
import type {
  ScanProgressEvent,
  TrackStatusChangedEvent,
} from '../shared/types/library';

import type {
  ListeningSessionInput,
  LyricsEncodingOption,
  PersonalizationPreferences,
  StatisticsQuery,
} from '../shared/types/stage5';
import type { TrackMetadataOverrideInput } from '../shared/types/track';

/**
 * Exposes a strictly typed, minimal API surface to the sandboxed Renderer.
 * Never exposes raw ipcRenderer, Node fs, or arbitrary filesystem commands.
 */
const losslessApi: LosslessDesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_INFO),

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
};

contextBridge.exposeInMainWorld('losslessApi', losslessApi);
