import path from 'node:path';
import { app, BrowserWindow, session } from 'electron';
import { ArtworkRepository } from './database/artwork-repository';
import { openLibraryDatabase, type DatabaseConnection } from './database/connection';
import { LibraryRootRepository } from './database/library-root-repository';
import { LyricsRepository } from './database/lyrics-repository';
import { MetadataOverrideRepository } from './database/metadata-override-repository';
import { TrackRepository } from './database/track-repository';
import { broadcastTrackStatusChanged, registerIpcHandlers } from './ipc/register-ipc';
import { ArtworkService } from './services/artwork-service';
import {
  registerAudioProtocolHandler,
  registerPrivilegedAudioScheme,
} from './services/audio-protocol';
import { LibraryService } from './services/library-service';
import { LyricsService } from './services/lyrics-service';
import { ProfileService } from './services/profile-service';
import { StatisticsService } from './services/statistics-service';
import { resolveSafeUserDataPath } from './utils/user-data-path';
import { createMainWindow } from './windows/main-window';

// Preserve legacy userData path (library.db + localStorage) BEFORE single-instance lock & app.whenReady()
// so renaming the packaged display/productName to "DoReMi" never creates an empty data directory.
const safeUserData = resolveSafeUserDataPath({
  isPackaged: app.isPackaged,
  appDataPath: app.getPath('appData'),
  currentUserDataPath: app.getPath('userData'),
});
if (safeUserData.shouldOverride) {
  app.setPath('userData', safeUserData.targetUserDataPath);
}

// Must be called synchronously before app.whenReady()
registerPrivilegedAudioScheme();

let dbConnection: DatabaseConnection | null = null;
let mainWindow: BrowserWindow | null = null;

// Prevent multiple instances writing concurrently to library.db
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });
}

function initializeApplication(): void {
  // Store library.db exclusively inside Electron's userData directory (never inside ASAR or EXE dir)
  const userDataDir = app.getPath('userData');
  const databasePath = path.join(userDataDir, 'library.db');
  dbConnection = openLibraryDatabase(databasePath);

  const trackRepo = new TrackRepository(dbConnection.db);
  const rootRepo = new LibraryRootRepository(dbConnection.db);
  const artworkRepo = new ArtworkRepository(dbConnection.db);
  const lyricsRepo = new LyricsRepository(dbConnection.db);
  const metadataOverrideRepo = new MetadataOverrideRepository(dbConnection.db);

  const artworkService = new ArtworkService({
    trackRepo,
    artworkRepo,
    userDataDir,
  });

  const lyricsService = new LyricsService({
    trackRepo,
    lyricsRepo,
  });

  const profileService = new ProfileService({
    db: dbConnection.db,
    userDataDir,
  });

  const statisticsService = new StatisticsService({
    db: dbConnection.db,
    trackRepo,
    artworkService,
  });

  const libraryService = new LibraryService({
    trackRepo,
    rootRepo,
    databasePath,
    artworkService,
    lyricsRepo,
    metadataOverrideRepo,
  });

  // Enforce strict offline CSP header on all loaded renderer documents
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType === 'mainFrame') {
      const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
      const csp = isDev
        ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; media-src 'self' lossless-media:; img-src 'self' data: blob: lossless-media:; font-src 'self'; connect-src 'self' ws://localhost:* http://localhost:*; object-src 'none'; base-uri 'none';"
        : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' lossless-media:; img-src 'self' data: blob: lossless-media:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none';";

      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp],
        },
      });
      return;
    }

    callback({ responseHeaders: details.responseHeaders });
  });

  registerAudioProtocolHandler({
    trackRepo,
    artworkService,
    profileService,
    onTrackMissing: (trackId) => {
      broadcastTrackStatusChanged({
        trackId,
        status: 'missing',
        reason: 'File âm thanh gốc không còn tồn tại trên ổ đĩa.',
      });
    },
  });

  registerIpcHandlers({
    libraryService,
    artworkService,
    lyricsService,
    profileService,
    statisticsService,
    databasePath,
  });

  mainWindow = createMainWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) {
    return;
  }

  initializeApplication();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  dbConnection?.close();
  dbConnection = null;
});
