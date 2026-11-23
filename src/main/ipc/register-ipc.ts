import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/contracts/channels';
import { SUPPORTED_AUDIO_EXTENSIONS } from '../../shared/contracts/media-protocol';
import type {
  CustomArtworkActionResult,
  CustomLyricsImportResult,
  ProfileMediaActionResult,
} from '../../shared/types/ipc';
import type {
  AppRuntimeInfo,
  ImportSummary,
  ScanProgressEvent,
  TrackStatusChangedEvent,
} from '../../shared/types/library';
import type {
  ListeningSessionInput,
  LyricsEncodingOption,
  PersonalizationPreferences,
  StatisticsQuery,
} from '../../shared/types/stage5';
import type { TrackMetadataOverrideInput } from '../../shared/types/track';
import type { ArtworkService } from '../services/artwork-service';
import type { LibraryService } from '../services/library-service';
import type { LyricsService } from '../services/lyrics-service';
import type { ProfileService } from '../services/profile-service';
import type { StatisticsService } from '../services/statistics-service';
import { APP_DISPLAY_NAME } from '../utils/user-data-path';
import { assertValidTrackId } from './validators';

export interface RegisterIpcOptions {
  libraryService: LibraryService;
  artworkService: ArtworkService;
  lyricsService: LyricsService;
  profileService: ProfileService;
  statisticsService: StatisticsService;
  databasePath: string;
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
    profileService,
    statisticsService,
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
    return {
      appName: APP_DISPLAY_NAME,
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      platform: process.platform,
      databasePath,
    };
  });

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
      return libraryService.updateTrackMetadataOverride(trackId, {
        titleOverride:
          typeof inputObj.titleOverride === 'string' ? inputObj.titleOverride : null,
        artistOverride:
          typeof inputObj.artistOverride === 'string' ? inputObj.artistOverride : null,
        albumOverride:
          typeof inputObj.albumOverride === 'string' ? inputObj.albumOverride : null,
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
}
