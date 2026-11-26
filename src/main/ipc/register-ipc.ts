import fs from 'node:fs';
import os from 'node:os';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { IPC_CHANNELS } from '../../shared/contracts/channels';
import { SUPPORTED_AUDIO_EXTENSIONS } from '../../shared/contracts/media-protocol';
import {
  DOREMI_ALAC_DECODER_VERSION,
  resolveReleaseChannel,
} from '../../shared/utils/app-metadata';
import type {
  CustomArtworkActionResult,
  CustomLyricsImportResult,
  ProfileMediaActionResult,
} from '../../shared/types/ipc';
import type {
  AppRuntimeInfo,
  ImportSummary,
  OptionalCodecStatusReport,
  RelinkSingleFileResult,
  RemoveWatchedFolderMode,
  ScanProgressEvent,
  TrackStatusChangedEvent,
} from '../../shared/types/library';
import type {
  AddTracksToPlaylistOptions,
  CreatePlaylistInput,
  LegacyCollectionsMigrationInput,
  UpdatePlaylistInput,
} from '../../shared/types/playlist';
import type {
  ListeningSessionInput,
  LyricsEncodingOption,
  PersonalizationPreferences,
  StatisticsQuery,
} from '../../shared/types/stage5';
import type {
  DiagnosticRecordInput,
  RelinkApplySelection,
  RelinkScanResult,
} from '../../shared/types/stage6';
import type { TrackMetadataOverrideInput } from '../../shared/types/track';
import type { TrackRepository } from '../database/track-repository';
import type { ArtworkService } from '../services/artwork-service';
import type { DiagnosticsService } from '../services/diagnostics-service';
import type { LibraryService } from '../services/library-service';
import type { LyricsService } from '../services/lyrics-service';
import type { PlaylistService } from '../services/playlist-service';
import type { ProfileService } from '../services/profile-service';
import type { StatisticsService } from '../services/statistics-service';
import { APP_DISPLAY_NAME } from '../utils/user-data-path';
import { assertValidTrackId, assertValidUuid, assertValidUuidList } from './validators';

export interface RegisterIpcOptions {
  libraryService: LibraryService;
  artworkService: ArtworkService;
  lyricsService: LyricsService;
  playlistService?: PlaylistService;
  profileService: ProfileService;
  statisticsService: StatisticsService;
  diagnosticsService?: DiagnosticsService;
  trackRepo?: TrackRepository;
  databasePath: string;
  sqliteVersion?: string;
  userDataDir?: string;
}

const VALID_LYRICS_ENCODINGS = new Set<LyricsEncodingOption>([
  'auto',
  'utf-8',
  'utf-16le',
  'utf-16be',
  'shift_jis',
  'gb18030',
  'euc-kr',
  'big5',
]);

export function broadcastTrackStatusChanged(event: TrackStatusChangedEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.LIBRARY_TRACK_STATUS_CHANGED, event);
    }
  }
}

export function registerIpcHandlers(options: RegisterIpcOptions): void {
  const {
    libraryService,
    artworkService,
    lyricsService,
    playlistService,
    profileService,
    statisticsService,
    diagnosticsService,
    trackRepo,
    databasePath,
  } = options;
  let activeLibraryOperation = false;

  const broadcastProgress = (event: ScanProgressEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.LIBRARY_SCAN_PROGRESS, event);
      }
    }
  };

  const runExclusiveLibraryOp = async (
    work: () => Promise<ImportSummary>,
  ): Promise<ImportSummary> => {
    if (activeLibraryOperation) {
      return {
        canceled: false,
        scannedCount: 0,
        addedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        missingMarkedCount: 0,
        recoveredCount: 0,
        errors: [
          {
            path: '',
            reason: 'Đang có một tiến trình import hoặc quét thư viện khác chạy. Vui lòng đợi hoàn tất.',
          },
        ],
      };
    }

    activeLibraryOperation = true;
    try {
      return await work();
    } finally {
      activeLibraryOperation = false;
    }
  };

  ipcMain.handle(IPC_CHANNELS.APP_GET_INFO, (): AppRuntimeInfo => {
    const appVersion = app.getVersion();
    return {
      appName: APP_DISPLAY_NAME,
      appVersion,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
      v8Version: process.versions.v8,
      arch: process.arch,
      osRelease: os.release(),
      sqliteVersion: options.sqliteVersion ?? '3.x',
      releaseChannel: resolveReleaseChannel(appVersion),
      alacDecoderVersion: DOREMI_ALAC_DECODER_VERSION,
      operatingMode: 'Offline Standalone (Zero Network)',
      platform: process.platform,
      databasePath,
    };
  });

  let cachedOptionalCodecProbe: OptionalCodecStatusReport | null = null;
  ipcMain.handle(
    IPC_CHANNELS.APP_PROBE_CODECS,
    async (_event, forceRefresh = false): Promise<OptionalCodecStatusReport> => {
      if (cachedOptionalCodecProbe && !forceRefresh) {
        return cachedOptionalCodecProbe;
      }

      const checkedAt = new Date().toISOString();
      try {
        // Strictly lazy-loaded ONLY when explicitly requested from About -> Technical Info.
        const { CodecManager } = await import('../services/codec/codec-manager');
        const manager = new CodecManager({
          userDataDir: options.userDataDir ?? app.getPath('userData'),
        });
        const snapshot = await manager.getInventory(Boolean(forceRefresh));
        const ffmpegEntry = snapshot.codecs.find((item) => item.id === 'ffmpeg');
        const readyCount = snapshot.summary.ready;
        const missingCount = snapshot.codecs.filter(
          (item) => item.status === 'missing',
        ).length;
        const ffmpegDetected = Boolean(
          snapshot.summary.ffmpegReady ||
            (ffmpegEntry &&
              ffmpegEntry.sourceTier !== 'missing' &&
              ffmpegEntry.status !== 'missing'),
        );

        cachedOptionalCodecProbe = {
          checkedAt,
          isolated: true,
          bundledPackDetected: snapshot.codecs.some((item) => item.sourceTier === 'bundled'),
          ffmpegDetected,
          ffmpegVersion: ffmpegEntry?.version ?? null,
          readyCount,
          missingCount,
          summary: ffmpegDetected
            ? `Phát hiện FFmpeg (${ffmpegEntry?.version ?? 'đã cài'}) ở lớp codec tách biệt; phát nhạc mặc định vẫn chạy bằng Chromium Media Pipeline + ALAC WASM.`
            : 'Không đóng gói FFmpeg ngoài; ứng dụng phát nhạc hoàn toàn bằng Chromium Media Pipeline + @mgz-dev/alac (WASM) nội bộ.',
        };
      } catch {
        cachedOptionalCodecProbe = {
          checkedAt,
          isolated: true,
          bundledPackDetected: false,
          ffmpegDetected: false,
          ffmpegVersion: null,
          readyCount: 0,
          missingCount: 0,
          summary:
            'Codec Engine đang ở trạng thái tách biệt (Isolated). Phát nhạc sử dụng Chromium Media Pipeline + @mgz-dev/alac (WASM) nội bộ.',
        };
      }
      return cachedOptionalCodecProbe;
    },
  );

  ipcMain.handle(IPC_CHANNELS.LIBRARY_GET_SNAPSHOT, () => {
    return libraryService.getSnapshot();
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY_IMPORT_FILES, async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const extensionsWithoutDot = SUPPORTED_AUDIO_EXTENSIONS.map((ext) => ext.slice(1));
    const dialogOptions: Electron.OpenDialogOptions = {
      title: 'Chọn file nhạc để import vào DoReMi',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Audio Files (FLAC, MP3, WAV, M4A, AAC, OGG, OPUS)',
          extensions: extensionsWithoutDot,
        },
        {
          name: 'Mandatory Lossless/Core (FLAC, MP3, WAV)',
          extensions: ['flac', 'mp3', 'wav'],
        },
      ],
    };

    const selection = parentWindow
      ? await dialog.showOpenDialog(parentWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (selection.canceled || selection.filePaths.length === 0) {
      return {
        canceled: true,
        scannedCount: 0,
        addedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        missingMarkedCount: 0,
        recoveredCount: 0,
        errors: [],
      } satisfies ImportSummary;
    }

    return runExclusiveLibraryOp(() =>
      libraryService.importFiles(selection.filePaths, broadcastProgress),
    );
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY_IMPORT_FOLDER, async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: Electron.OpenDialogOptions = {
      title: 'Chọn thư mục nhạc để quét vào DoReMi',
      properties: ['openDirectory'],
    };

    const selection = parentWindow
      ? await dialog.showOpenDialog(parentWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (selection.canceled || selection.filePaths.length === 0) {
      return {
        canceled: true,
        scannedCount: 0,
        addedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        missingMarkedCount: 0,
        recoveredCount: 0,
        errors: [],
      } satisfies ImportSummary;
    }

    return runExclusiveLibraryOp(() =>
      libraryService.importFolder(selection.filePaths[0], broadcastProgress),
    );
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY_RESCAN, async () => {
    return runExclusiveLibraryOp(() => libraryService.rescanLibrary(broadcastProgress));
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY_VERIFY_TRACK, async (_event, rawTrackId: unknown) => {
    const trackId = assertValidTrackId(rawTrackId);
    const result = await libraryService.verifyTrackAvailability(trackId);
    if (!result.exists) {
      broadcastTrackStatusChanged({
        trackId: result.trackId,
        status: result.status,
        reason: result.reason,
      });
    }
    return result;
  });

  // ---------------------------------------------------------------------------
  // Stage 3: Custom Artwork Management (M3.2)
  // ---------------------------------------------------------------------------
  ipcMain.handle(
    IPC_CHANNELS.ARTWORK_IMPORT_CUSTOM,
    async (event, rawTrackId: unknown): Promise<CustomArtworkActionResult> => {
      const trackId = assertValidTrackId(rawTrackId);
      const parentWindow = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions: Electron.OpenDialogOptions = {
        title: 'Chọn ảnh bìa mới cho bài hát',
        properties: ['openFile'],
        filters: [
          {
            name: 'Ảnh bìa (JPG, PNG, WEBP)',
            extensions: ['jpg', 'jpeg', 'png', 'webp'],
          },
        ],
      };

      const selection = parentWindow
        ? await dialog.showOpenDialog(parentWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

      if (selection.canceled || selection.filePaths.length === 0) {
        return { canceled: true, track: null };
      }

      try {
        const updatedTrack = await artworkService.importCustomArtworkFromPath(
          trackId,
          selection.filePaths[0],
        );
        return { canceled: false, track: updatedTrack };
      } catch (error) {
        return {
          canceled: false,
          track: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.ARTWORK_REMOVE_CUSTOM,
    async (_event, rawTrackId: unknown): Promise<CustomArtworkActionResult> => {
      const trackId = assertValidTrackId(rawTrackId);
      try {
        const updatedTrack = await artworkService.removeCustomArtwork(trackId);
        return { canceled: false, track: updatedTrack };
      } catch (error) {
        return {
          canceled: false,
          track: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Stage 3 + Stage 5: Lyrics Detection & Multilingual Management (M3.3 / M5.7)
  // ---------------------------------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.LYRICS_GET, async (_event, rawTrackId: unknown) => {
    const trackId = assertValidTrackId(rawTrackId);
    return lyricsService.resolveTrackLyrics(trackId);
  });

  ipcMain.handle(
    IPC_CHANNELS.LYRICS_IMPORT_FILE,
    async (
      event,
      rawTrackId: unknown,
      rawEncoding?: unknown,
    ): Promise<CustomLyricsImportResult> => {
      const trackId = assertValidTrackId(rawTrackId);
      const encoding: LyricsEncodingOption =
        typeof rawEncoding === 'string' &&
        VALID_LYRICS_ENCODINGS.has(rawEncoding as LyricsEncodingOption)
          ? (rawEncoding as LyricsEncodingOption)
          : 'auto';

      const parentWindow = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions: Electron.OpenDialogOptions = {
        title: 'Nhập file lời bài hát (.lrc hoặc .txt)',
        properties: ['openFile'],
        filters: [
          {
            name: 'Lời bài hát (LRC, TXT)',
            extensions: ['lrc', 'txt'],
          },
        ],
      };

      const selection = parentWindow
        ? await dialog.showOpenDialog(parentWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

      if (selection.canceled || selection.filePaths.length === 0) {
        return { canceled: true, lyrics: null };
      }

      try {
        const { detectedEncoding, ...lyrics } = await lyricsService.importCustomLyricsFromFile(
          trackId,
          selection.filePaths[0],
          encoding,
        );
        return { canceled: false, lyrics, detectedEncoding };
      } catch (error) {
        return {
          canceled: false,
          lyrics: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.LYRICS_SAVE_CUSTOM,
    async (_event, rawTrackId: unknown, rawFormat: unknown, rawContent: unknown) => {
      const trackId = assertValidTrackId(rawTrackId);
      const format: 'lrc' | 'txt' = rawFormat === 'lrc' ? 'lrc' : 'txt';
      const content = typeof rawContent === 'string' ? rawContent : '';
      return lyricsService.saveCustomLyrics(trackId, format, content);
    },
  );

  ipcMain.handle(IPC_CHANNELS.LYRICS_REMOVE_CUSTOM, async (_event, rawTrackId: unknown) => {
    const trackId = assertValidTrackId(rawTrackId);
    return lyricsService.removeCustomLyrics(trackId);
  });

  // ---------------------------------------------------------------------------
  // Stage 3: In-App Metadata Overrides (M3.4 — SQLite only)
  // ---------------------------------------------------------------------------
  ipcMain.handle(
    IPC_CHANNELS.METADATA_UPDATE_OVERRIDE,
    async (_event, rawTrackId: unknown, rawInput: unknown) => {
      const trackId = assertValidTrackId(rawTrackId);
      const inputObj =
        rawInput && typeof rawInput === 'object'
          ? (rawInput as Partial<TrackMetadataOverrideInput>)
          : {};
      const numOrNull = (val: unknown): number | null | undefined => {
        if (val === undefined) return undefined;
        if (val === null) return null;
        return typeof val === 'number' && Number.isFinite(val) ? val : null;
      };
      const strOrNull = (val: unknown): string | null | undefined => {
        if (val === undefined) return undefined;
        return typeof val === 'string' ? val : null;
      };

      return libraryService.updateTrackMetadataOverride(trackId, {
        titleOverride: typeof inputObj.titleOverride === 'string' ? inputObj.titleOverride : null,
        artistOverride: typeof inputObj.artistOverride === 'string' ? inputObj.artistOverride : null,
        albumOverride: typeof inputObj.albumOverride === 'string' ? inputObj.albumOverride : null,
        genreOverride: strOrNull(inputObj.genreOverride),
        yearOverride: numOrNull(inputObj.yearOverride),
        albumArtistOverride: strOrNull(inputObj.albumArtistOverride),
        trackNumberOverride: numOrNull(inputObj.trackNumberOverride),
        trackTotalOverride: numOrNull(inputObj.trackTotalOverride),
        discNumberOverride: numOrNull(inputObj.discNumberOverride),
        discTotalOverride: numOrNull(inputObj.discTotalOverride),
        composerOverride: strOrNull(inputObj.composerOverride),
        lyricistOverride: strOrNull(inputObj.lyricistOverride),
        commentOverride: strOrNull(inputObj.commentOverride),
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.METADATA_RESTORE_ORIGINAL,
    async (_event, rawTrackId: unknown) => {
      const trackId = assertValidTrackId(rawTrackId);
      return libraryService.restoreTrackMetadataOriginal(trackId);
    },
  );

  // ---------------------------------------------------------------------------
  // Stage 5: Local User Profile & Personalization Hub (M5.2)
  // ---------------------------------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.PROFILE_GET, () => {
    return profileService.getProfile();
  });

  ipcMain.handle(IPC_CHANNELS.PROFILE_UPDATE_NAME, (_event, rawName: unknown) => {
    const name = typeof rawName === 'string' ? rawName : '';
    return profileService.updateDisplayName(name);
  });

  ipcMain.handle(
    IPC_CHANNELS.PROFILE_IMPORT_AVATAR,
    async (event): Promise<ProfileMediaActionResult> => {
      const parentWindow = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions: Electron.OpenDialogOptions = {
        title: 'Chọn ảnh đại diện (hỗ trợ JPG, PNG, WEBP, GIF động)',
        properties: ['openFile'],
        filters: [
          {
            name: 'Ảnh đại diện (JPG, PNG, WEBP, GIF)',
            extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
          },
        ],
      };

      const selection = parentWindow
        ? await dialog.showOpenDialog(parentWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

      if (selection.canceled || selection.filePaths.length === 0) {
        return { canceled: true };
      }

      try {
        const profile = await profileService.importAvatarFromFile(selection.filePaths[0]);
        return { canceled: false, profile };
      } catch (error) {
        return {
          canceled: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.PROFILE_REMOVE_AVATAR, async () => {
    return profileService.removeAvatar();
  });

  ipcMain.handle(IPC_CHANNELS.PREFERENCES_GET, () => {
    return profileService.getPreferences();
  });

  ipcMain.handle(IPC_CHANNELS.PREFERENCES_UPDATE, (_event, rawPartial: unknown) => {
    const partial =
      rawPartial && typeof rawPartial === 'object'
        ? (rawPartial as Partial<PersonalizationPreferences>)
        : {};
    return profileService.updatePreferences(partial);
  });

  ipcMain.handle(
    IPC_CHANNELS.PREFERENCES_IMPORT_BACKGROUND,
    async (event): Promise<ProfileMediaActionResult> => {
      const parentWindow = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions: Electron.OpenDialogOptions = {
        title: 'Chọn ảnh nền tùy chỉnh cho Home',
        properties: ['openFile'],
        filters: [
          {
            name: 'Ảnh nền (JPG, PNG, WEBP)',
            extensions: ['jpg', 'jpeg', 'png', 'webp'],
          },
        ],
      };

      const selection = parentWindow
        ? await dialog.showOpenDialog(parentWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

      if (selection.canceled || selection.filePaths.length === 0) {
        return { canceled: true };
      }

      try {
        const preferences = await profileService.importCustomBackgroundFromFile(
          selection.filePaths[0],
        );
        return { canceled: false, preferences };
      } catch (error) {
        return {
          canceled: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.PREFERENCES_REMOVE_BACKGROUND, async () => {
    return profileService.removeCustomBackground();
  });

  ipcMain.handle(
    IPC_CHANNELS.PREFERENCES_IMPORT_EDITORIAL_FONT,
    async (event): Promise<ProfileMediaActionResult> => {
      const parentWindow = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions: Electron.OpenDialogOptions = {
        title: 'Chọn file font chữ nền trang chủ (.ttf, .otf, .woff, .woff2)',
        properties: ['openFile'],
        filters: [
          {
            name: 'Font chữ (TTF, OTF, WOFF, WOFF2)',
            extensions: ['ttf', 'otf', 'woff', 'woff2'],
          },
        ],
      };

      const selection = parentWindow
        ? await dialog.showOpenDialog(parentWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

      if (selection.canceled || selection.filePaths.length === 0) {
        return { canceled: true };
      }

      try {
        const { preferences, font } = await profileService.importEditorialFontFromFile(
          selection.filePaths[0],
        );
        return { canceled: false, preferences, font };
      } catch (error) {
        return {
          canceled: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PREFERENCES_DELETE_EDITORIAL_FONT,
    async (_event, rawFontId: unknown) => {
      const fontId = typeof rawFontId === 'string' ? rawFontId.trim() : '';
      if (!fontId) {
        return profileService.getPreferences();
      }
      return profileService.deleteEditorialFont(fontId);
    },
  );

  // ---------------------------------------------------------------------------
  // Stage 5: Real SQLite Listening Statistics (M5.6)
  // ---------------------------------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.STATISTICS_RECORD_SESSION, (_event, rawInput: unknown) => {
    if (!rawInput || typeof rawInput !== 'object') {
      throw new Error('Dữ liệu phiên nghe không hợp lệ.');
    }
    return statisticsService.recordListeningSession(rawInput as ListeningSessionInput);
  });

  ipcMain.handle(IPC_CHANNELS.STATISTICS_GET_DASHBOARD, (_event, rawQuery: unknown) => {
    const query: StatisticsQuery =
      rawQuery && typeof rawQuery === 'object'
        ? (rawQuery as StatisticsQuery)
        : { range: 'week', periodOffset: 0 };
    return statisticsService.getDashboard(query);
  });

  // ---------------------------------------------------------------------------
  // Phase 1C: Structured Offline Diagnostics
  // ---------------------------------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.APP_GET_DIAGNOSTICS, () => {
    return diagnosticsService ? diagnosticsService.getRecentEntries(100) : [];
  });

  ipcMain.handle(IPC_CHANNELS.APP_RECORD_DIAGNOSTIC, (_event, rawInput: unknown) => {
    if (!diagnosticsService || !rawInput || typeof rawInput !== 'object') {
      return { recorded: false };
    }
    const candidate = rawInput as Partial<DiagnosticRecordInput>;
    if (typeof candidate.message !== 'string' || typeof candidate.scope !== 'string') {
      return { recorded: false };
    }
    diagnosticsService.record({
      level:
        candidate.level === 'error' || candidate.level === 'warn' || candidate.level === 'info'
          ? candidate.level
          : 'info',
      scope: candidate.scope,
      message: candidate.message,
      code: typeof candidate.code === 'string' ? candidate.code : undefined,
      stage: typeof candidate.stage === 'string' ? candidate.stage : undefined,
      attemptId: typeof candidate.attemptId === 'string' ? candidate.attemptId : undefined,
      detail: typeof candidate.detail === 'string' ? candidate.detail : undefined,
    });
    return { recorded: true };
  });

  // ---------------------------------------------------------------------------
  // Phase 3 / Phase 8: Library Track Removal, Exclusions, Sources, Relink & Explorer
  // ---------------------------------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.LIBRARY_CANCEL_RESCAN, () => {
    return { canceled: libraryService.cancelActiveScan() };
  });

  ipcMain.handle(
    IPC_CHANNELS.LIBRARY_REMOVE_TRACKS,
    (_event, rawTrackIds: unknown, rawOptions?: unknown) => {
      const trackIds = assertValidUuidList(rawTrackIds, 'trackIds');
      const addExclusion =
        rawOptions && typeof rawOptions === 'object'
          ? (rawOptions as { addExclusion?: boolean }).addExclusion !== false
          : true;
      return libraryService.removeTracks(trackIds, { addExclusion });
    },
  );

  ipcMain.handle(IPC_CHANNELS.LIBRARY_SHOW_IN_FOLDER, (_event, rawTrackId: unknown) => {
    const trackId = assertValidTrackId(rawTrackId);
    const track = trackRepo?.findById(trackId) ?? libraryService.getSnapshot().tracks.find((t) => t.id === trackId);
    if (!track) {
      return { shown: false, error: 'Không tìm thấy bài hát trong cơ sở dữ liệu.' };
    }
    try {
      if (fs.existsSync(track.original_path)) {
        shell.showItemInFolder(track.original_path);
        return { shown: true };
      }
      return { shown: false, error: 'File gốc hiện không còn tồn tại tại vị trí đã lưu.' };
    } catch (error) {
      return {
        shown: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY_LIST_FOLDERS, () => {
    return libraryService.listWatchedFolders();
  });

  ipcMain.handle(
    IPC_CHANNELS.LIBRARY_UPDATE_ROOT_SETTINGS,
    (_event, rawRootId: unknown, rawPatch: unknown) => {
      const rootId = assertValidUuid(rawRootId, 'rootId');
      const patchObj = rawPatch && typeof rawPatch === 'object' ? (rawPatch as Record<string, unknown>) : {};
      return libraryService.updateLibraryRootSettings(rootId, {
        recursive: typeof patchObj.recursive === 'boolean' ? patchObj.recursive : undefined,
        enabled: typeof patchObj.enabled === 'boolean' ? patchObj.enabled : undefined,
        auto_watch: typeof patchObj.auto_watch === 'boolean' ? patchObj.auto_watch : undefined,
      });
    },
  );

  ipcMain.handle(IPC_CHANNELS.LIBRARY_RESCAN_FOLDER, (_event, rawRootId: unknown) => {
    const rootId = assertValidUuid(rawRootId, 'rootId');
    return runExclusiveLibraryOp(() =>
      libraryService.rescanLibrary(broadcastProgress, { targetRootId: rootId }),
    );
  });

  ipcMain.handle(
    IPC_CHANNELS.LIBRARY_REMOVE_FOLDER,
    (_event, rawRootId: unknown, rawMode?: unknown) => {
      const rootId = assertValidUuid(rawRootId, 'rootId');
      const mode: RemoveWatchedFolderMode =
        rawMode === 'remove-tracks' ? 'remove-tracks' : 'stop-watching';
      return libraryService.removeWatchedFolder(rootId, mode);
    },
  );

  ipcMain.handle(IPC_CHANNELS.LIBRARY_REMOVE_ROOT, (_event, rawRootId: unknown) => {
    const rootId = assertValidUuid(rawRootId, 'rootId');
    return { removed: libraryService.removeLibraryRoot(rootId) };
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY_CLEAR_ALL, () => {
    return libraryService.clearAllImportedMusic();
  });

  ipcMain.handle(IPC_CHANNELS.LIBRARY_LIST_EXCLUSIONS, () => {
    return libraryService.listExcludedTracks();
  });

  ipcMain.handle(
    IPC_CHANNELS.LIBRARY_REIMPORT_EXCLUSIONS,
    async (_event, rawExclusionIds?: unknown) => {
      const ids =
        Array.isArray(rawExclusionIds) && rawExclusionIds.length > 0
          ? assertValidUuidList(rawExclusionIds, 'exclusionIds')
          : undefined;
      return libraryService.reimportExcludedTracks(ids, broadcastProgress);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.LIBRARY_CLEAR_EXCLUSIONS,
    (_event, rawExclusionIds?: unknown) => {
      const ids =
        Array.isArray(rawExclusionIds) && rawExclusionIds.length > 0
          ? assertValidUuidList(rawExclusionIds, 'exclusionIds')
          : undefined;
      return { clearedCount: libraryService.clearExclusions(ids) };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.RELINK_SINGLE_TRACK_DIALOG,
    async (event, rawTrackId: unknown): Promise<RelinkSingleFileResult> => {
      const trackId = assertValidTrackId(rawTrackId);
      const parentWindow = BrowserWindow.fromWebContents(event.sender);
      const extWithoutDot = SUPPORTED_AUDIO_EXTENSIONS.map((e) => e.slice(1));
      const dialogOpts: Electron.OpenDialogOptions = {
        title: 'Chọn file nhạc thay thế để liên kết lại',
        properties: ['openFile'],
        filters: [
          { name: 'Audio Files', extensions: extWithoutDot },
        ],
      };
      const selection = parentWindow
        ? await dialog.showOpenDialog(parentWindow, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts);

      if (selection.canceled || selection.filePaths.length === 0) {
        return { canceled: true, success: false, track: null };
      }

      return libraryService.relinkSingleTrack(trackId, selection.filePaths[0]);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.RELINK_SCAN_FOLDER,
    async (event): Promise<RelinkScanResult> => {
      const parentWindow = BrowserWindow.fromWebContents(event.sender);
      const dialogOpts: Electron.OpenDialogOptions = {
        title: 'Chọn thư mục mới để quét và liên kết lại các bài thiếu file',
        properties: ['openDirectory'],
      };
      const selection = parentWindow
        ? await dialog.showOpenDialog(parentWindow, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts);

      if (selection.canceled || selection.filePaths.length === 0) {
        return {
          canceled: true,
          totalMissingTracks: 0,
          matchedCount: 0,
          ambiguousCount: 0,
          unmatchedCount: 0,
          conflictCount: 0,
          proposals: [],
        };
      }

      return libraryService.scanRelinkFolder(selection.filePaths[0]);
    },
  );

  ipcMain.handle(IPC_CHANNELS.RELINK_APPLY, async (_event, rawSelections: unknown) => {
    if (!Array.isArray(rawSelections)) {
      throw new Error('Danh sách relink không hợp lệ.');
    }
    const cleanSelections: RelinkApplySelection[] = rawSelections
      .filter((item): item is RelinkApplySelection =>
        Boolean(
          item &&
            typeof item === 'object' &&
            typeof (item as RelinkApplySelection).trackId === 'string' &&
            typeof (item as RelinkApplySelection).newFilePath === 'string',
        ),
      )
      .map((item) => ({
        trackId: assertValidTrackId(item.trackId),
        newFilePath: item.newFilePath,
      }));
    return libraryService.applyRelink(cleanSelections);
  });

  // ---------------------------------------------------------------------------
  // Phase 3C & 3F: SQLite Playlists & Favorites
  // ---------------------------------------------------------------------------
  if (playlistService) {
    ipcMain.handle(IPC_CHANNELS.PLAYLIST_GET_SNAPSHOT, () => {
      return playlistService.getSnapshot();
    });

    ipcMain.handle(IPC_CHANNELS.PLAYLIST_CREATE, (_event, rawInput: unknown) => {
      const obj = rawInput && typeof rawInput === 'object' ? (rawInput as CreatePlaylistInput) : { name: '' };
      return playlistService.createPlaylist(obj);
    });

    ipcMain.handle(IPC_CHANNELS.PLAYLIST_UPDATE, (_event, rawPlaylistId: unknown, rawInput: unknown) => {
      const playlistId = assertValidUuid(rawPlaylistId, 'playlistId');
      const obj = rawInput && typeof rawInput === 'object' ? (rawInput as UpdatePlaylistInput) : {};
      return playlistService.updatePlaylist(playlistId, obj);
    });

    ipcMain.handle(IPC_CHANNELS.PLAYLIST_DELETE, (_event, rawPlaylistId: unknown) => {
      const playlistId = assertValidUuid(rawPlaylistId, 'playlistId');
      return playlistService.deletePlaylist(playlistId);
    });

    ipcMain.handle(
      IPC_CHANNELS.PLAYLIST_ADD_TRACKS,
      (_event, rawPlaylistId: unknown, rawTrackIds: unknown, rawOptions?: unknown) => {
        const playlistId = assertValidUuid(rawPlaylistId, 'playlistId');
        const trackIds = assertValidUuidList(rawTrackIds, 'trackIds');
        const opts =
          rawOptions && typeof rawOptions === 'object'
            ? (rawOptions as AddTracksToPlaylistOptions)
            : undefined;
        return playlistService.addTracksToPlaylist(playlistId, trackIds, opts);
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.PLAYLIST_REMOVE_ENTRIES,
      (_event, rawPlaylistId: unknown, rawEntryIds: unknown) => {
        const playlistId = assertValidUuid(rawPlaylistId, 'playlistId');
        const entryIds = assertValidUuidList(rawEntryIds, 'entryIds');
        return playlistService.removeEntriesFromPlaylist(playlistId, entryIds);
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.PLAYLIST_REORDER_ENTRIES,
      (_event, rawPlaylistId: unknown, rawOrderedIds: unknown) => {
        const playlistId = assertValidUuid(rawPlaylistId, 'playlistId');
        const orderedIds = assertValidUuidList(rawOrderedIds, 'orderedEntryIds');
        return playlistService.reorderPlaylistEntries(playlistId, orderedIds);
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.PLAYLIST_IMPORT_ARTWORK,
      async (event, rawPlaylistId: unknown) => {
        const playlistId = assertValidUuid(rawPlaylistId, 'playlistId');
        const parentWindow = BrowserWindow.fromWebContents(event.sender);
        return playlistService.importArtworkFromDialog(playlistId, parentWindow);
      },
    );

    ipcMain.handle(IPC_CHANNELS.PLAYLIST_REMOVE_ARTWORK, async (_event, rawPlaylistId: unknown) => {
      const playlistId = assertValidUuid(rawPlaylistId, 'playlistId');
      try {
        const playlist = await playlistService.removeCustomArtwork(playlistId);
        return { canceled: false, playlist };
      } catch (error) {
        return {
          canceled: false,
          playlist: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    ipcMain.handle(IPC_CHANNELS.PLAYLIST_MIGRATE_LEGACY, (_event, rawLegacy: unknown) => {
      const obj =
        rawLegacy && typeof rawLegacy === 'object'
          ? (rawLegacy as LegacyCollectionsMigrationInput)
          : { playlists: [], favoriteIds: [] };
      return playlistService.migrateLegacyCollections(obj);
    });

    ipcMain.handle(IPC_CHANNELS.FAVORITE_TOGGLE, (_event, rawTrackId: unknown) => {
      const trackId = assertValidTrackId(rawTrackId);
      return playlistService.toggleFavorite(trackId);
    });

    ipcMain.handle(
      IPC_CHANNELS.FAVORITE_SET_MANY,
      (_event, rawTrackIds: unknown, rawFavorite: unknown) => {
        const trackIds = assertValidUuidList(rawTrackIds, 'trackIds');
        return playlistService.setFavorites(trackIds, Boolean(rawFavorite));
      },
    );
  }
}
