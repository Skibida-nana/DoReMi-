import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, powerMonitor, session } from 'electron';
import { ArtworkRepository } from './database/artwork-repository';
import { openLibraryDatabase, type DatabaseConnection } from './database/connection';
import { ExclusionRepository } from './database/exclusion-repository';
import { LibraryRootRepository } from './database/library-root-repository';
import { LyricsRepository } from './database/lyrics-repository';
import { MetadataOverrideRepository } from './database/metadata-override-repository';
import { PlaylistRepository } from './database/playlist-repository';
import { TrackRepository } from './database/track-repository';
import { broadcastTrackStatusChanged, registerIpcHandlers } from './ipc/register-ipc';
import { disposeSharedAlacStreamManager } from './services/alac-decoder';
import { ArtworkService } from './services/artwork-service';
import {
  registerAudioProtocolHandler,
  registerPrivilegedAudioScheme,
} from './services/audio-protocol';
import { DiagnosticsService } from './services/diagnostics-service';
import { LibraryService } from './services/library-service';
import { LyricsService } from './services/lyrics-service';
import { PlaylistService } from './services/playlist-service';
import { ProfileService } from './services/profile-service';
import { StatisticsService } from './services/statistics-service';
import { ConnectClientService } from './services/connect/connect-client';
import { ConnectRepository } from './services/connect/connect-repository';
import { ConnectHostService } from './services/connect/host-service';
import { ConnectSecretStorage } from './services/connect/secret-storage';
import {
  createCrashRecoveryLimiter,
  formatUnexpectedErrorDetail,
  isIgnorableAbortError,
  writeBoundedCrashDumpSync,
} from './utils/runtime-resilience';
import { resolveSafeUserDataPath } from './utils/user-data-path';
import { createMainWindow } from './windows/main-window';

// Preserve legacy userData path (library.db + localStorage) BEFORE single-instance lock & app.whenReady()
// so renaming the packaged display/productName to "DoReMi" never creates an empty data directory.
const isSmokeTest = process.env.DOREMI_SMOKE_TEST === '1';
const smokeUserDataOverride =
  isSmokeTest && process.env.DOREMI_SMOKE_USER_DATA
    ? path.resolve(process.env.DOREMI_SMOKE_USER_DATA)
    : null;

if (smokeUserDataOverride) {
  app.setPath('userData', smokeUserDataOverride);
} else {
  const safeUserData = resolveSafeUserDataPath({
    isPackaged: app.isPackaged,
    appDataPath: app.getPath('appData'),
    currentUserDataPath: app.getPath('userData'),
  });
  if (safeUserData.shouldOverride) {
    app.setPath('userData', safeUserData.targetUserDataPath);
  }
}

// Must be called synchronously before app.whenReady()
registerPrivilegedAudioScheme();

let dbConnection: DatabaseConnection | null = null;
let diagnosticsService: DiagnosticsService | null = null;
let activeLibraryService: LibraryService | null = null;
let activeConnectHostService: ConnectHostService | null = null;
let activeConnectClientService: ConnectClientService | null = null;
let mainWindow: BrowserWindow | null = null;
const rendererRecoveryLimiter = createCrashRecoveryLimiter(15_000);

function registerGlobalMainSafetyHandlers(): void {
  process.on('uncaughtException', (error) => {
    const detail = formatUnexpectedErrorDetail(error);
    console.error('[DoReMi Main uncaughtException]', detail.message);
    try {
      const userDataDir = app.getPath('userData');
      writeBoundedCrashDumpSync(userDataDir, {
        kind: 'uncaughtException',
        timestamp: new Date().toISOString(),
        detail,
      });
    } catch {
      // Ignore crash log failure
    }
    diagnosticsService?.record({
      level: 'error',
      scope: 'main-process',
      code: 'UNCAUGHT_EXCEPTION',
      message: detail.message,
      detail: detail.stack,
    });
  });

  process.on('unhandledRejection', (reason) => {
    if (isIgnorableAbortError(reason)) {
      return;
    }
    const detail = formatUnexpectedErrorDetail(reason);
    console.error('[DoReMi Main unhandledRejection]', detail.message);
    try {
      const userDataDir = app.getPath('userData');
      writeBoundedCrashDumpSync(userDataDir, {
        kind: 'unhandledRejection',
        timestamp: new Date().toISOString(),
        detail,
      });
    } catch {
      // Ignore crash log failure
    }
    diagnosticsService?.record({
      level: 'warn',
      scope: 'main-process',
      code: 'UNHANDLED_REJECTION',
      message: detail.message,
      detail: detail.stack,
    });
  });

  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') {
      return;
    }
    try {
      const userDataDir = app.getPath('userData');
      writeBoundedCrashDumpSync(userDataDir, {
        kind: 'child-process-gone',
        timestamp: new Date().toISOString(),
        detail: {
          name: 'ChildProcessGone',
          message: `${details.type} terminated (${details.reason}, exitCode=${details.exitCode})`,
        },
        extra: { type: details.type, reason: details.reason, exitCode: details.exitCode },
      });
    } catch {
      // Ignore crash log failure
    }
    diagnosticsService?.record({
      level: 'error',
      scope: 'main-process',
      code: 'CHILD_PROCESS_GONE',
      message: `Tiến trình phụ (${details.type}) dừng bất thường: ${details.reason}`,
      detail: `exitCode=${details.exitCode}`,
    });
  });
}

registerGlobalMainSafetyHandlers();

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
  diagnosticsService = new DiagnosticsService({ userDataDir });
  diagnosticsService.record({
    level: 'info',
    scope: 'app',
    message: `Khởi tạo DoReMi v${app.getVersion()} (Electron ${process.versions.electron}, ${process.platform} ${process.arch})`,
  });
  if (!dbConnection.integrity.ok) {
    diagnosticsService.record({
      level: 'error',
      scope: 'database',
      code: 'SQLITE_INTEGRITY_WARNING',
      message: 'Phát hiện cảnh báo toàn vẹn SQLite khi khởi động.',
      detail:
        dbConnection.integrity.error ??
        `integrity=${dbConnection.integrity.integrityMessages.join('; ')}; fkViolations=${dbConnection.integrity.foreignKeyViolations}`,
    });
  }

  const trackRepo = new TrackRepository(dbConnection.db);
  const rootRepo = new LibraryRootRepository(dbConnection.db);
  const artworkRepo = new ArtworkRepository(dbConnection.db);
  const lyricsRepo = new LyricsRepository(dbConnection.db);
  const metadataOverrideRepo = new MetadataOverrideRepository(dbConnection.db);
  const exclusionRepo = new ExclusionRepository(dbConnection.db);
  const playlistRepo = new PlaylistRepository(dbConnection.db);

  const artworkService = new ArtworkService({
    trackRepo,
    artworkRepo,
    userDataDir,
  });

  const lyricsService = new LyricsService({
    trackRepo,
    lyricsRepo,
  });

  const playlistService = new PlaylistService({
    playlistRepo,
    userDataDir,
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
    exclusionRepo,
  });
  activeLibraryService = libraryService;

  const connectRepo = new ConnectRepository(dbConnection.db);
  const connectSecrets = new ConnectSecretStorage({ userDataDir });
  const connectHostService = new ConnectHostService({
    appVersion: app.getVersion(),
    userDataDir,
    connectRepo,
    trackRepo,
    artworkService,
    lyricsService,
    secrets: connectSecrets,
  });
  const connectClientService = new ConnectClientService({
    connectRepo,
    secrets: connectSecrets,
  });
  activeConnectHostService = connectHostService;
  activeConnectClientService = connectClientService;

  powerMonitor.on('suspend', () => {
    activeConnectClientService?.handleSystemSuspend();
  });
  powerMonitor.on('resume', () => {
    activeConnectClientService?.handleSystemResume();
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
    playlistService,
    profileService,
    connectClientService,
    onDiagnostic: (entry) => {
      diagnosticsService?.record(entry);
    },
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
    playlistService,
    profileService,
    statisticsService,
    diagnosticsService,
    connectHostService,
    connectClientService,
    trackRepo,
    databasePath,
    sqliteVersion: dbConnection.sqliteVersion,
    userDataDir,
  });

  mainWindow = createMainWindow();
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') {
      return;
    }
    try {
      writeBoundedCrashDumpSync(userDataDir, {
        kind: 'render-process-gone',
        timestamp: new Date().toISOString(),
        detail: {
          name: 'RenderProcessGone',
          message: `Renderer terminated (${details.reason}, exitCode=${details.exitCode})`,
        },
        extra: { reason: details.reason, exitCode: details.exitCode },
      });
    } catch {
      // Ignore crash log failure
    }
    diagnosticsService?.record({
      level: 'error',
      scope: 'renderer-process',
      code: 'RENDER_PROCESS_GONE',
      message: `Tiến trình giao diện dừng bất thường (${details.reason}).`,
      detail: `exitCode=${details.exitCode}`,
    });

    if (isSmokeTest || !mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (rendererRecoveryLimiter.canAutoRecover()) {
      mainWindow.webContents.reload();
      return;
    }
    void dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'DoReMi - Khôi phục giao diện',
      message: 'Giao diện ứng dụng vừa gặp sự cố bất ngờ nhiều lần liên tiếp.',
      detail: `Nguyên nhân: ${details.reason} (exit=${details.exitCode}). Dữ liệu thư viện SQLite vẫn được bảo toàn an toàn.`,
      buttons: ['Thử tải lại', 'Đóng'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload();
      }
    });
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (!isSmokeTest) {
    // Non-blocking background recovery for legacy M4A/ALAC tracks imported prior to Phase 4.5.1.
    // Touches ONLY stale `metadata_version < 2` tracks via header-only probe; skips immediately if none exist.
    setTimeout(() => {
      if (!dbConnection) return;
      void libraryService.revalidateLegacyMetadata().catch(() => {});
    }, 1500).unref();
  }

  if (isSmokeTest && mainWindow) {
    const smokeOutPath = process.env.DOREMI_SMOKE_OUT;
    const writeSmokeResult = (payload: Record<string, unknown>) => {
      if (!smokeOutPath) return;
      try {
        fs.mkdirSync(path.dirname(smokeOutPath), { recursive: true });
        fs.writeFileSync(smokeOutPath, JSON.stringify(payload, null, 2), 'utf8');
      } catch {
        // Ignore report write failures during teardown
      }
    };

    const failSmoke = (reason: string) => {
      writeSmokeResult({ ok: false, reason });
      console.error(`[DOREMI_SMOKE_FAIL] ${reason}`);
      void diagnosticsService?.flush().finally(() => {
        disposeSharedAlacStreamManager();
        dbConnection?.close();
        dbConnection = null;
        app.exit(1);
      });
    };

    const smokeTimer = setTimeout(() => {
      failSmoke('Timed out waiting for DoReMi renderer startup smoke verification.');
    }, 20_000);

    mainWindow.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
      clearTimeout(smokeTimer);
      failSmoke(`did-fail-load (${errorCode}): ${errorDescription}`);
    });

    mainWindow.webContents.once('did-finish-load', () => {
      void (async () => {
        try {
          // Allow React root mount microtasks to settle
          await new Promise((r) => setTimeout(r, 300));
          if (!mainWindow || mainWindow.isDestroyed()) {
            throw new Error('MainWindow destroyed before smoke probe.');
          }
          const probe = (await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const hasApi = Boolean(window.losslessApi && typeof window.losslessApi.getAppInfo === 'function');
              const root = document.getElementById('root');
              const rootChildCount = root ? root.childElementCount : 0;
              const appInfo = hasApi ? await window.losslessApi.getAppInfo() : null;
              const diagLogs = hasApi && window.losslessApi.getDiagnosticLogs ? await window.losslessApi.getDiagnosticLogs() : [];
              return { hasApi, rootChildCount, appInfo, diagCount: Array.isArray(diagLogs) ? diagLogs.length : -1 };
            })()
          `)) as {
            hasApi: boolean;
            rootChildCount: number;
            appInfo: { appName?: string; electronVersion?: string; databasePath?: string } | null;
            diagCount: number;
          };

          if (!probe.hasApi || probe.rootChildCount <= 0 || !probe.appInfo?.databasePath) {
            throw new Error(`Invalid smoke probe state: ${JSON.stringify(probe)}`);
          }

          let extendedReport: Record<string, unknown> | null = null;
          if (process.env.DOREMI_SMOKE_EXTENDED === '1') {
            const sampleAudioFile = process.env.DOREMI_SMOKE_AUDIO_FILE || '';
            const phaseMode = process.env.DOREMI_SMOKE_PHASE || 'boot1';
            if (phaseMode === 'boot1' && sampleAudioFile && activeLibraryService) {
              await activeLibraryService.importFolder(path.dirname(sampleAudioFile));
            }
            extendedReport = (await mainWindow.webContents.executeJavaScript(`
              (async () => {
                const api = window.losslessApi;
                const mode = ${JSON.stringify(phaseMode)};

                if (mode === 'boot2_verify_persistence') {
                  const libSnap = await api.getLibrarySnapshot();
                  const hostSnap = await api.connectGetHostSnapshot();
                  const clientSnap = await api.connectGetClientSnapshot();
                  return {
                    mode,
                    persistedTrackCount: libSnap.tracks.length,
                    persistedPowerPolicy: hostSnap.power.policy,
                    persistedAuthorizedDevices: hostSnap.authorizedDevices.length,
                    persistedRememberedHosts: clientSnap.rememberedHosts.length,
                  };
                }

                const verifyAudioCanPlay = (src) =>
                  new Promise((resolve, reject) => {
                    const el = new Audio();
                    el.preload = 'auto';
                    el.muted = true;
                    const t = setTimeout(() => {
                      el.removeAttribute('src');
                      el.load();
                      reject(new Error('Audio canplay timeout for ' + src));
                    }, 8000);
                    el.addEventListener(
                      'canplay',
                      () => {
                        clearTimeout(t);
                        const info = { duration: el.duration, readyState: el.readyState };
                        el.pause();
                        el.removeAttribute('src');
                        el.load();
                        resolve(info);
                      },
                      { once: true },
                    );
                    el.addEventListener(
                      'error',
                      () => {
                        clearTimeout(t);
                        const code = el.error ? el.error.code : -1;
                        el.removeAttribute('src');
                        el.load();
                        reject(new Error('Audio element error code=' + code + ' for ' + src));
                      },
                      { once: true },
                    );
                    el.src = src;
                    el.load();
                  });

                // 1. Local import + local lossless-media:// real Chromium <audio> playback verification
                const libSnap = await api.getLibrarySnapshot();
                const tracks = libSnap.tracks;
                if (!tracks.length) {
                  throw new Error('Expected imported local track in packaged smoke verification.');
                }
                const localTrack = tracks[0];
                const localAudio = await verifyAudioCanPlay(
                  'lossless-media://track/' + encodeURIComponent(localTrack.id),
                );

                // 2. Power policies + Host start/stop + real Electron powerSaveBlocker verification
                const initHost = await api.connectGetHostSnapshot();
                await api.connectUpdateHostConfig({ bindAddress: '127.0.0.1', port: 0 });
                await api.connectStartHost();
                const polHostOn = await api.connectSetHostPowerPolicy('keep-awake-host-on');
                const polFollow = await api.connectSetHostPowerPolicy('follow-system');
                await api.connectSetHostPowerPolicy('keep-awake-streaming');

                // 3. Shared source + LAN Direct pairing + Remote Track real Chromium <audio> streaming + Streaming Keep-Awake
                const roots = libSnap.roots;
                if (roots.length > 0) {
                  await api.connectAddSharedSource(roots[0].id);
                }
                const hostAfterSource = await api.connectGetHostSnapshot();
                const port = hostAfterSource.listeningPort;
                const hostId = hostAfterSource.identity.hostId;
                const probed = await api.connectProbeHost('127.0.0.1', port);
                const inv = await api.connectCreateInvitation({ autoApproveSingleUse: true });
                await api.connectEnrollWithHost({
                  address: '127.0.0.1',
                  port,
                  expectedFingerprintSha256: probed.observedFingerprintSha256,
                  inviteCode: inv.inviteCode,
                  deviceName: 'Packaged RC9 Verifier',
                });
                const remoteLib = await api.connectListRemoteTracks({ offset: 0, limit: 10 });
                if (!remoteLib.items.length) {
                  throw new Error('Expected shared remote track from packaged Host.');
                }
                const rTrack = remoteLib.items[0];
                const remoteUrl =
                  'lossless-media://remote-track/' +
                  String(hostId).toLowerCase() +
                  '/' +
                  String(rTrack.trackId).toLowerCase();
                const remoteAudio = await verifyAudioCanPlay(remoteUrl);
                const hostDuringGrace = await api.connectGetHostSnapshot();
                const breakdown = await api.connectGetHostResourceBreakdown({ includeTailscaleProcesses: false });

                // 4. Connection recovery + clean disconnect + Host stop releases blocker & streams
                await api.connectToRememberedHost(hostId);
                const clientReconnected = await api.connectGetClientSnapshot();
                await api.connectDisconnectClient();
                const clientDisconnected = await api.connectGetClientSnapshot();
                const stoppedHost = await api.connectStopHost();

                return {
                  mode,
                  localCanPlay: localAudio.readyState >= 3 && localAudio.duration > 2,
                  localDurationSec: Number(localAudio.duration.toFixed(2)),
                  defaultPowerPolicy: initHost.power.policy,
                  blockerDuringHostOnPolicy: polHostOn.power.blockerActive,
                  blockerDuringFollowPolicy: polFollow.power.blockerActive,
                  blockerDuringStreamGrace: hostDuringGrace.power.blockerActive || hostDuringGrace.power.gracePeriodActive,
                  remoteCanPlay: remoteAudio.readyState >= 3 && remoteAudio.duration > 2,
                  remoteDurationSec: Number(remoteAudio.duration.toFixed(2)),
                  durationsMatch: Math.abs(localAudio.duration - remoteAudio.duration) < 0.05,
                  resourceBreakdownSampled: breakdown.mainProcess.rssBytes > 0,
                  reconnectedState: clientReconnected.smartState || clientReconnected.status,
                  disconnectedState: clientDisconnected.status,
                  stoppedState: stoppedHost.state,
                  stoppedBlockerActive: stoppedHost.power.blockerActive,
                  stoppedActiveStreams: stoppedHost.activeSessions.length,
                };
              })()
            `)) as Record<string, unknown>;
          }

          clearTimeout(smokeTimer);
          writeSmokeResult({ ok: true, isPackaged: app.isPackaged, ...probe, extendedReport });
          console.log('DOREMI_SMOKE_OK');
          await activeConnectClientService?.shutdown().catch(() => {});
          await activeConnectHostService?.dispose().catch(() => {});
          await diagnosticsService?.flush();
          disposeSharedAlacStreamManager();
          dbConnection?.close();
          dbConnection = null;
          app.exit(0);
        } catch (err) {
          clearTimeout(smokeTimer);
          failSmoke(err instanceof Error ? err.message : String(err));
        }
      })();
    });
  }
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
  activeLibraryService?.cancelActiveScan();
  activeLibraryService = null;
  void activeConnectHostService?.dispose().catch(() => {});
  void activeConnectClientService?.shutdown().catch(() => {});
  activeConnectHostService = null;
  activeConnectClientService = null;
  void diagnosticsService?.flush();
  disposeSharedAlacStreamManager();
  dbConnection?.close();
  dbConnection = null;
});
