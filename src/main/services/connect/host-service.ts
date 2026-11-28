import fsPromises from 'node:fs/promises';
import type http from 'node:http';
import {
  CONNECT_API_PREFIX,
  CONNECT_API_VERSION,
  CONNECT_MAX_JSON_BODY_BYTES,
  CONNECT_MIN_SUPPORTED_API_VERSION,
} from '../../../shared/contracts/connect-api';
import {
  CONNECT_REMOTE_DEFAULT_MOUNT_PATH,
  isAllowedFunnelPublicPort,
  isValidRemoteChallengeNonce,
  normalizeRemoteMountPath,
  TAILSCALE_WINDOWS_DOWNLOAD_URL,
} from '../../../shared/contracts/connect-remote';
import { isValidTrackUuid } from '../../../shared/contracts/media-protocol';
import { sortAlbumTracksCanonical } from '../../../shared/utils/album-sort';
import type {
  ConnectDiagnosticsSnapshot,
  ConnectTransportMode,
  EnrollmentInvitationSummary,
  HostCapabilitiesDto,
  HostConfig,
  HostLifecycleState,
  HostPowerPolicy,
  HostRemoteAccessSnapshot,
  HostSnapshot,
  RemoteAccessState,
  RemoteAlbumDto,
  RemoteArtistDto,
  RemoteEndpointDescriptorV1,
  RemoteLibrarySummaryDto,
  RemoteOwnedRouteRecord,
  RemoteProviderStatusSnapshot,
  RemoteProvisioningBundleDto,
  RemoteTrackDto,
  ScopedHostResourceBreakdown,
  SharedSourceRecord,
} from '../../../shared/types/connect';
import type { ResolvedTrackLyrics } from '../../../shared/types/track';
import type { TrackRepository } from '../../database/track-repository';
import type { ArtworkService } from '../artwork-service';
import type { LyricsService } from '../lyrics-service';
import { ConnectAudioStreamingService } from './audio-streaming-service';
import {
  ConnectRepository,
  paginateItems,
  type StoredDeviceAuthRow,
  toPublicAuthorizedDevice,
} from './connect-repository';
import { DeviceAuthorizationService } from './device-auth-service';
import { SharedFilesystemGuard, type GuardedFsOps } from './filesystem-guard';
import { HostIdentityService, type LoadedHostIdentity } from './host-identity-service';
import { HostPowerManager, type PowerPlatformAdapter } from './host-power-manager';
import { LanDirectProvider, type TransportProvider } from './lan-direct-provider';
import { LanDiscoveryService } from './lan-discovery-service';
import { listEligibleLanInterfaces, normalizeIpAddress } from './network-interfaces';
import { RemoteGatewayService, type RemoteGatewayRequestContext } from './remote-gateway-service';
import {
  signRemoteEndpointDescriptor,
  signRemoteHostIdentityProof,
} from './remote-trust';
import { ResourceBudgetManager } from './resource-budget';
import { HostResourceSampler } from './resource-sampler';
import type { ConnectSecretStorage } from './secret-storage';
import {
  TailscaleFunnelProvider,
  type RemoteTransportProvider,
} from './tailscale-funnel-provider';

const MAX_RECENT_HOST_ERRORS = 20;
const MAX_CACHED_ARTWORK_ITEMS = 48;
const MAX_CACHED_ARTWORK_BYTES = 16 * 1024 * 1024;
const MAX_CACHED_LYRICS_ITEMS = 32;
const MAX_CACHED_LYRICS_BYTES = 1024 * 1024;
const LIBRARY_STATE_TOKEN_RECHECK_MS = 2_500;
const NETWORK_AVAILABILITY_CACHE_MS = 5_000;
const REMOTE_STREAM_IDLE_SWEEP_INTERVAL_MS = 60_000;
const REMOTE_STREAM_MAX_ABANDONED_IDLE_MS = 15 * 60_000;

interface CachedArtworkEntry {
  bytes: Buffer;
  mime: string;
}

interface CachedLyricsEntry {
  payload: ResolvedTrackLyrics;
  byteSize: number;
  sidecarPath: string | null;
  sidecarMtimeMs: number | null;
}

interface CachedLibraryView {
  generatedAtMs: number;
  lastTokenCheckedAtMs: number;
  stateToken: string;
  summary: RemoteLibrarySummaryDto;
  tracks: RemoteTrackDto[];
  albums: RemoteAlbumDto[];
  artists: RemoteArtistDto[];
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readBoundedJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > CONNECT_MAX_JSON_BODY_BYTES) {
      throw new Error('PAYLOAD_TOO_LARGE');
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) {
    return {};
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('INVALID_JSON');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Integrated DoReMi Personal Hybrid Server Host Service.
 * - Enforces explicit lifecycle state machine (`STOPPED`, `STARTING`, `STANDBY`, `ACTIVE`, `STOPPING`, `ERROR`).
 * - Host is OFF by default and opens zero sockets/timers/discovery when STOPPED.
 * - Serializes lifecycle transitions so repeated ON/OFF toggles are race-safe and idempotent.
 */
export class ConnectHostService {
  private readonly appVersion: string;
  private readonly connectRepo: ConnectRepository;
  private readonly trackRepo: TrackRepository;
  private readonly artworkService: ArtworkService;
  private readonly lyricsService: LyricsService;
  private readonly identityService: HostIdentityService;
  private readonly authService: DeviceAuthorizationService;
  private readonly fsGuard: SharedFilesystemGuard;
  private readonly budget: ResourceBudgetManager;
  private readonly streamingService: ConnectAudioStreamingService;
  private readonly transport: TransportProvider;
  private readonly discovery: LanDiscoveryService;
  private readonly enableMdns: boolean;
  private readonly secrets: ConnectSecretStorage;
  private readonly remoteGateway: RemoteGatewayService;
  private readonly remoteProvider: RemoteTransportProvider;
  readonly powerManager: HostPowerManager;
  private readonly resourceSampler = new HostResourceSampler();

  private state: HostLifecycleState = 'STOPPED';
  private lastError: string | null = null;
  private activeIdentity: LoadedHostIdentity | null = null;
  private transitionQueue: Promise<void> = Promise.resolve();
  private recentErrors: Array<{ timestamp: string; code: string; message: string }> = [];

  // Phase 6.3 Remote Access state machine (independent of LAN Direct lifecycle)
  private remoteState: RemoteAccessState = 'DISABLED';
  private remoteLastError: string | null = null;
  private activeOwnedRoute: RemoteOwnedRouteRecord | null = null;
  private activeRemoteDescriptor: RemoteEndpointDescriptorV1 | null = null;
  private staleRouteWarning: string | null = null;
  private securityGatePassed = false;
  private securityGateIssues: string[] = [];
  private lastProviderStatus: RemoteProviderStatusSnapshot = {
    providerId: 'tailscale-funnel',
    detectionStatus: 'not_installed',
    executableDetected: false,
    cliVersion: null,
    backendState: null,
    dnsName: null,
    magicDnsEnabled: false,
    httpsCertEnabled: false,
    funnelAllowed: false,
    availablePublicPorts: [],
    conflictingRoutes: [],
    downloadUrl: TAILSCALE_WINDOWS_DOWNLOAD_URL,
    message: 'Chưa kiểm tra trạng thái Tailscale.',
  };
  private remoteSweepTimer: ReturnType<typeof setInterval> | null = null;
  private reconciledStaleStartup = false;

  private libraryViewCache: CachedLibraryView | null = null;
  private artworkCache = new Map<string, CachedArtworkEntry>();
  private artworkCacheTotalBytes = 0;
  private inflightArtwork = new Map<string, Promise<CachedArtworkEntry | null>>();
  private lyricsCache = new Map<string, CachedLyricsEntry>();
  private lyricsCacheTotalBytes = 0;
  private cachedConfig: HostConfig | null = null;
  private cachedSharedSources: Array<SharedSourceRecord & { normalizedPath: string }> | null = null;
  private cachedDevicesRaw: { rows: StoredDeviceAuthRow[]; atMs: number } | null = null;
  private cachedNetworkAvailable: { value: boolean; atMs: number } | null = null;
  private rotatingDevices = new Set<string>();
  private stateListeners = new Set<(snapshot: HostSnapshot) => void>();

  constructor(options: {
    appVersion: string;
    userDataDir: string;
    connectRepo: ConnectRepository;
    trackRepo: TrackRepository;
    artworkService: ArtworkService;
    lyricsService: LyricsService;
    secrets: ConnectSecretStorage;
    transport?: TransportProvider;
    discovery?: LanDiscoveryService;
    remoteGateway?: RemoteGatewayService;
    remoteProvider?: RemoteTransportProvider;
    powerAdapter?: PowerPlatformAdapter;
    powerInactivityGraceMs?: number;
    powerNowMs?: () => number;
    fsOps?: GuardedFsOps;
    enableMdns?: boolean;
  }) {
    this.appVersion = options.appVersion;
    this.connectRepo = options.connectRepo;
    this.trackRepo = options.trackRepo;
    this.artworkService = options.artworkService;
    this.lyricsService = options.lyricsService;
    this.secrets = options.secrets;
    this.enableMdns = options.enableMdns !== false;

    const initialCfg = this.connectRepo.getHostConfig();
    this.cachedConfig = initialCfg;
    this.identityService = new HostIdentityService({
      userDataDir: options.userDataDir,
      secrets: options.secrets,
    });
    this.budget = new ResourceBudgetManager(initialCfg.resourceLimits, () => {
      this.syncStandbyOrActiveState();
      this.syncStreamSweepTimer();
      this.powerManager?.notifyStreamActivityChanged();
    });
    this.authService = new DeviceAuthorizationService({
      connectRepo: this.connectRepo,
      onDeviceRevoked: (deviceId) => {
        this.cachedDevicesRaw = null;
        this.budget.abortStreamsForDevice(deviceId, 'Device revoked');
        this.powerManager?.notifyDeviceTerminated(deviceId, { immediateReleaseIfLast: true });
        this.emitSnapshot();
      },
      onDeviceRemoteRevoked: (deviceId) => {
        this.cachedDevicesRaw = null;
        this.budget.abortRemoteStreamsForDevice(deviceId, 'Remote access permission revoked');
        this.powerManager?.notifyStreamActivityChanged();
        this.emitSnapshot();
      },
    });
    this.powerManager = new HostPowerManager({
      initialPolicy: initialCfg.powerPolicy ?? 'follow-system',
      inactivityGraceMs: options.powerInactivityGraceMs,
      adapter: options.powerAdapter,
      nowMs: options.powerNowMs,
      getActiveStreamDeviceIds: (nowMs) => this.budget.getActivePlaybackDeviceIds(45_000, nowMs),
      isDeviceAuthorized: (deviceId) => {
        const dev = this.connectRepo.findDeviceById(deviceId);
        return Boolean(dev && dev.authState === 'authorized');
      },
      onStateChanged: () => this.emitSnapshot(),
      onSystemSuspend: () => {
        void this.reconcileOnSystemSuspendInternal();
      },
      onSystemResume: () => {
        void this.reconcileOnSystemResumeInternal();
      },
    });
    this.fsGuard = new SharedFilesystemGuard({
      connectRepo: this.connectRepo,
      trackRepo: this.trackRepo,
      fsOps: options.fsOps,
    });
    this.streamingService = new ConnectAudioStreamingService({
      fsGuard: this.fsGuard,
      budget: this.budget,
    });
    this.transport = options.transport ?? new LanDirectProvider();
    this.discovery = options.discovery ?? new LanDiscoveryService();
    this.remoteGateway = options.remoteGateway ?? new RemoteGatewayService();
    this.remoteProvider = options.remoteProvider ?? new TailscaleFunnelProvider();
  }

  subscribe(listener: (snapshot: HostSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  getState(): HostLifecycleState {
    return this.state;
  }

  private getConfigFast(): HostConfig {
    if (!this.cachedConfig) {
      this.cachedConfig = this.connectRepo.getHostConfig();
    }
    return this.cachedConfig;
  }

  private getSharedSourcesFast(): Array<SharedSourceRecord & { normalizedPath: string }> {
    if (!this.cachedSharedSources) {
      this.cachedSharedSources = this.connectRepo.listSharedSourceRoots();
    }
    return this.cachedSharedSources;
  }

  private getAuthorizedDevicesFast(): StoredDeviceAuthRow[] {
    const now = Date.now();
    const ttl = this.state === 'STOPPED' ? 30_000 : 2_000;
    if (this.cachedDevicesRaw && now - this.cachedDevicesRaw.atMs < ttl) {
      return this.cachedDevicesRaw.rows;
    }
    const rows = this.connectRepo.listAuthorizedDevices();
    this.cachedDevicesRaw = { rows, atMs: now };
    return rows;
  }

  private isNetworkAvailableCached(): boolean {
    const now = Date.now();
    const ttl = this.state === 'STOPPED' ? 30_000 : NETWORK_AVAILABILITY_CACHE_MS;
    if (this.cachedNetworkAvailable && now - this.cachedNetworkAvailable.atMs < ttl) {
      return this.cachedNetworkAvailable.value;
    }
    const available = listEligibleLanInterfaces().length > 0;
    this.cachedNetworkAvailable = { value: available, atMs: now };
    return available;
  }

  getSnapshot(): HostSnapshot {
    const config = this.getConfigFast();
    const sharedSources = this.getSharedSourcesFast();
    const sharedTrackCount = sharedSources
      .filter((s) => s.enabled && s.available)
      .reduce((acc, s) => acc + s.trackCount, 0);

    const devicesRaw = this.getAuthorizedDevicesFast();
    const authorizedDevices = devicesRaw.map((d) =>
      toPublicAuthorizedDevice(d, {
        isConnected: this.state !== 'STOPPED' && this.budget.isDeviceConnected(d.deviceId),
        activeSessionCount:
          this.state !== 'STOPPED' ? this.budget.getDeviceActiveSessionCount(d.deviceId) : 0,
      }),
    );

    const identity = this.activeIdentity
      ? {
          hostId: this.activeIdentity.hostId,
          fingerprintSha256: this.activeIdentity.fingerprintSha256,
          shortFingerprint: this.activeIdentity.shortFingerprint,
          createdAt: this.activeIdentity.createdAt,
          storageBackend: this.activeIdentity.storageBackend,
        }
      : this.identityService.getPublicInfo();

    const listenAddresses = this.transport.isRunning() ? this.transport.getListenAddresses() : [];
    const listeningPort = this.transport.isRunning() ? this.transport.getListeningPort() : null;

    const activeInvitation =
      this.state !== 'STOPPED' && identity && listeningPort !== null
        ? this.authService.getActiveInvitationSummary({
            hostId: identity.hostId,
            hostDisplayName: config.displayName,
            shortFingerprint: identity.shortFingerprint,
            fullFingerprint: identity.fingerprintSha256,
            listenAddresses,
            port: listeningPort,
          })
        : null;

    const metrics = this.budget.sampleMetrics({
      state: this.state,
      sharedTrackCount,
      authorizedDeviceCount: authorizedDevices.filter((d) => d.authState === 'authorized').length,
    });

    const discState = this.discovery.getState();
    const publicEndpointUrl = this.activeOwnedRoute
      ? `${this.activeOwnedRoute.publicOrigin}${this.activeOwnedRoute.mountPath}`
      : this.activeRemoteDescriptor
        ? `${this.activeRemoteDescriptor.publicOrigin}${this.activeRemoteDescriptor.mountPath}`
        : null;

    const remoteAccess: HostRemoteAccessSnapshot = {
      state: this.remoteState,
      userAcknowledgedExposure: Boolean(config.remoteUserAcknowledged),
      preferredPublicPort: config.remotePublicPort ?? 443,
      mountPath: config.remoteMountPath ?? CONNECT_REMOTE_DEFAULT_MOUNT_PATH,
      endpointGeneration: config.remoteEndpointGeneration ?? 1,
      gatewayListeningPort: this.remoteGateway.getListeningPort(),
      publicEndpointUrl,
      activeDescriptor: this.activeRemoteDescriptor,
      providerStatus: { ...this.lastProviderStatus },
      staleRouteWarning: this.staleRouteWarning,
      securityGatePassed: this.securityGatePassed,
      securityGateIssues: [...this.securityGateIssues],
      lastError: this.remoteLastError,
      externalUatVerified: false,
    };

    const diagnostics: ConnectDiagnosticsSnapshot = {
      hostState: this.state,
      lastError: this.lastError,
      discoveryActive: discState.state === 'advertising',
      discoveryState: discState.state,
      networkAvailable: this.isNetworkAvailableCached(),
      listenAddresses,
      listeningPort,
      remoteState: this.remoteState,
      remoteProvider: 'tailscale-funnel',
      remotePublicUrl: publicEndpointUrl,
      apiVersion: CONNECT_API_VERSION,
      recentErrors: [...this.recentErrors],
      recentStreamTraces: this.streamingService.getRecentTraces(),
      recentSecurityEvents: this.authService.getRecentSecurityEvents(),
      lastInvitationState: this.authService.getLastInvitationState(),
      firewallNote:
        'Nếu thiết bị khác trong mạng Wi-Fi không tìm thấy máy Host, hãy kiểm tra cấu hình mạng Windows đang ở Private Profile và cho phép cổng lắng nghe trong Windows Defender Firewall (phạm vi Private).',
    };

    return {
      config,
      state: this.state,
      lastError: this.lastError,
      identity,
      listenAddresses,
      listeningPort,
      sharedSources: sharedSources.map(({ normalizedPath: _n, ...rest }) => rest),
      sharedTrackCount,
      authorizedDevices,
      activeSessions: this.state !== 'STOPPED' ? this.budget.getActiveStreamInfos() : [],
      activeInvitation,
      pendingEnrollments:
        this.state !== 'STOPPED' ? this.authService.listPendingRequests() : [],
      remoteAccess,
      power: this.powerManager.getSnapshot(),
      metrics,
      diagnostics,
    };
  }

  async start(): Promise<HostSnapshot> {
    await this.enqueueTransition(async () => {
      if (this.state === 'STANDBY' || this.state === 'ACTIVE') {
        return;
      }

      this.state = 'STARTING';
      this.lastError = null;
      this.cachedNetworkAvailable = null;
      this.powerManager.setHostState('STARTING');
      this.emitSnapshot();

      try {
        const config = this.connectRepo.getHostConfig();
        this.cachedConfig = config;
        this.budget.setLimits(config.resourceLimits);
        this.powerManager.setPolicy(config.powerPolicy ?? 'follow-system');

        const identity = await this.identityService.ensureIdentity(config.displayName);
        this.activeIdentity = identity;

        const started = await this.transport.start({
          bindAddress: config.bindAddress,
          port: config.port,
          certificatePem: identity.certificatePem,
          privateKeyPem: identity.privateKeyPem,
          requestHandler: (req, res) => this.handleHttpRequest(req, res),
        });

        if (this.enableMdns) {
          const primaryAddr = started.listenAddresses[0] ?? '127.0.0.1';
          await this.discovery.startAdvertising({
            hostId: identity.hostId,
            displayName: config.displayName,
            address: primaryAddr,
            port: started.port,
            apiVersion: CONNECT_API_VERSION,
            mode: 'lan-direct',
            fingerprintPrefix: identity.shortFingerprint,
          });
        }

        this.cachedConfig = this.connectRepo.updateHostConfig({ enabled: true });
        this.budget.markHostStarted();
        this.state = this.budget.hasActiveStreams() ? 'ACTIVE' : 'STANDBY';
        this.powerManager.setHostState(this.state);
        this.remoteState = 'DISABLED';
        this.remoteLastError = null;
        // Reconcile any lingering owned Funnel route from a prior abnormal exit; Remote Access stays DISABLED on boot
        await this.reconcileStaleRemoteRouteIfNeeded();
        this.emitSnapshot();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.recordError('HOST_START_FAILED', msg);
        await this.cleanupAfterFailure();
        this.state = 'ERROR';
        this.lastError = msg;
        this.powerManager.setHostState('ERROR');
        this.emitSnapshot();
      }
    });
    return this.getSnapshot();
  }

  async stop(): Promise<HostSnapshot> {
    await this.enqueueTransition(async () => {
      if (this.state === 'STOPPED') {
        this.cachedConfig = this.connectRepo.updateHostConfig({ enabled: false });
        this.powerManager.setHostState('STOPPED');
        return;
      }

      this.state = 'STOPPING';
      this.powerManager.setHostState('STOPPING');
      this.emitSnapshot();

      try {
        await this.shutdownRemoteAccessInternal();
        this.stopRemoteStreamSweepTimer();
        this.budget.markHostStopped();
        this.authService.clearVolatileState();
        await this.discovery.stopAdvertising();
        await this.transport.stop();
        this.activeIdentity = null;
        this.identityService.releasePrivateKeyFromMemory();
        this.clearCaches();
        this.cachedConfig = this.connectRepo.updateHostConfig({ enabled: false });
        this.state = 'STOPPED';
        this.lastError = null;
        this.powerManager.setHostState('STOPPED');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.recordError('HOST_STOP_FAILED', msg);
        this.state = 'ERROR';
        this.lastError = msg;
        this.powerManager.setHostState('ERROR');
      }
      this.emitSnapshot();
    });
    return this.getSnapshot();
  }

  async dispose(): Promise<void> {
    await this.stop().catch(() => {});
    this.powerManager.dispose();
  }

  setPowerPolicy(policy: HostPowerPolicy): HostSnapshot {
    const saved = this.connectRepo.setHostPowerPolicy(policy);
    this.cachedConfig = this.connectRepo.getHostConfig();
    const changed = this.powerManager.setPolicy(saved);
    if (changed) {
      this.authService.recordSecurityEvent({
        category: 'power_policy_changed',
        outcome: 'success',
        detail: `Đã cập nhật chế độ nguồn điện Host sang "${saved}".`,
      });
    }
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async getResourceBreakdown(options?: {
    includeTailscaleProcesses?: boolean;
  }): Promise<ScopedHostResourceBreakdown> {
    const snap = this.getSnapshot();
    const totals = this.budget.getTransportTotals();
    return this.resourceSampler.sampleBreakdown({
      hostState: this.state,
      powerPolicy: this.powerManager.getPolicy(),
      powerBlockerActive: this.powerManager.isBlockerActive(),
      metrics: snap.metrics,
      totalLanBytesSent: totals.totalLanBytesSent,
      totalRemoteBytesSent: totals.totalRemoteBytesSent,
      includeTailscaleProcesses: options?.includeTailscaleProcesses,
    });
  }

  async handleSystemSuspend(): Promise<void> {
    this.powerManager.handlePlatformSuspend();
  }

  async handleSystemResume(): Promise<void> {
    this.powerManager.handlePlatformResume();
    await this.transitionQueue;
  }

  private async reconcileOnSystemSuspendInternal(): Promise<void> {
    this.authService.flushPendingDeviceActivity();
    this.stopRemoteStreamSweepTimer();
    this.authService.recordSecurityEvent({
      category: 'power_suspend',
      outcome: 'success',
      detail: 'Windows chuyển sang trạng thái Suspend; tạm dừng các tác vụ nền của Host an toàn.',
    });
  }

  private async reconcileOnSystemResumeInternal(): Promise<void> {
    await this.enqueueTransition(async () => {
      this.cachedNetworkAvailable = null;
      this.authService.recordSecurityEvent({
        category: 'power_resume',
        outcome: 'success',
        detail: 'Windows thức dậy sau Suspend; đang kiểm tra lại cổng lắng nghe và tuyến kết nối.',
      });

      if (this.state !== 'STANDBY' && this.state !== 'ACTIVE') {
        this.powerManager.reconcile();
        this.emitSnapshot();
        return;
      }

      // 1. Reconcile LAN listener & mDNS advertisement
      const cfg = this.getConfigFast();
      if (!this.transport.isRunning() && this.activeIdentity) {
        try {
          await this.transport.start({
            bindAddress: cfg.bindAddress,
            port: cfg.port,
            certificatePem: this.activeIdentity.certificatePem,
            privateKeyPem: this.activeIdentity.privateKeyPem,
            requestHandler: (req, res) => this.handleHttpRequest(req, res),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.recordError('HOST_RESUME_LISTENER_FAILED', msg);
        }
      }

      if (this.enableMdns && this.activeIdentity && this.transport.isRunning()) {
        const addrs = this.transport.getListenAddresses();
        const port = this.transport.getListeningPort() ?? cfg.port;
        this.discovery.refreshAdvertisement({
          hostId: this.activeIdentity.hostId,
          displayName: cfg.displayName,
          address: addrs[0] ?? '127.0.0.1',
          port,
          apiVersion: CONNECT_API_VERSION,
          mode: 'lan-direct',
          fingerprintPrefix: this.activeIdentity.shortFingerprint,
        });
      }

      // 2. Fail-closed verification of active session Remote Access (NEVER auto-enables new Funnel routes!)
      if (this.remoteState === 'READY') {
        const owned = this.activeOwnedRoute;
        const gwRunning = this.remoteGateway.isRunning();
        if (!owned || !gwRunning) {
          await this.remoteGateway.stop().catch(() => {});
          this.activeOwnedRoute = null;
          this.activeRemoteDescriptor = null;
          this.remoteState = 'ERROR';
          this.remoteLastError =
            'Cổng Remote Gateway không còn hoạt động sau khi máy thức dậy. Đã đóng kết nối từ xa an toàn; hãy bật lại nếu cần.';
        } else {
          const [providerCheck, routeCheck] = await Promise.all([
            this.remoteProvider.detectStatus({
              preferredPort: owned.publicPort,
              mountPath: owned.mountPath,
              ownedLocalTarget: owned.localTarget,
              forceRefresh: true,
            }),
            this.remoteProvider.verifyOwnedRouteActive(owned),
          ]);
          this.lastProviderStatus = providerCheck;
          if (providerCheck.detectionStatus !== 'ready' || !routeCheck.active) {
            this.budget.abortAllRemoteStreams('Remote route invalid after system resume');
            await this.remoteGateway.stop().catch(() => {});
            this.activeOwnedRoute = null;
            this.activeRemoteDescriptor = null;
            this.remoteState = 'ERROR';
            this.remoteLastError =
              routeCheck.detail ||
              providerCheck.message ||
              'Tuyến Tailscale Funnel không còn hợp lệ sau khi máy thức dậy (Fail-closed).';
            this.authService.recordSecurityEvent({
              category: 'remote_route_blocked',
              outcome: 'blocked',
              detail: this.remoteLastError,
            });
          }
        }
      }

      this.syncStreamSweepTimer();
      this.powerManager.reconcile();
      this.emitSnapshot();
    });
  }

  async updateConfig(patch: {
    displayName?: string;
    port?: number;
    bindAddress?: string;
    autoStart?: boolean;
    maxActiveClients?: number;
    powerPolicy?: HostPowerPolicy;
  }): Promise<HostSnapshot> {
    const prev = this.getConfigFast();
    const updated = this.connectRepo.updateHostConfig(patch);
    this.cachedConfig = updated;
    this.budget.setLimits(updated.resourceLimits);
    if (patch.powerPolicy !== undefined) {
      this.powerManager.setPolicy(updated.powerPolicy ?? 'follow-system');
    }
    this.libraryViewCache = null;

    const needsRestart =
      (this.state === 'STANDBY' || this.state === 'ACTIVE') &&
      (updated.port !== prev.port || updated.bindAddress !== prev.bindAddress);

    if (needsRestart) {
      await this.stop();
      await this.start();
      return this.getSnapshot();
    }

    if ((this.state === 'STANDBY' || this.state === 'ACTIVE') && this.activeIdentity && this.enableMdns) {
      const addrs = this.transport.getListenAddresses();
      const port = this.transport.getListeningPort() ?? updated.port;
      this.discovery.refreshAdvertisement({
        hostId: this.activeIdentity.hostId,
        displayName: updated.displayName,
        address: addrs[0] ?? '127.0.0.1',
        port,
        apiVersion: CONNECT_API_VERSION,
        mode: 'lan-direct',
        fingerprintPrefix: this.activeIdentity.shortFingerprint,
      });
    }

    this.emitSnapshot();
    return this.getSnapshot();
  }

  addSharedSource(rootId: string): HostSnapshot {
    this.connectRepo.addSharedSource(rootId);
    this.cachedSharedSources = null;
    this.libraryViewCache = null;
    this.emitSnapshot();
    return this.getSnapshot();
  }

  removeSharedSource(rootId: string): HostSnapshot {
    this.connectRepo.removeSharedSource(rootId);
    this.cachedSharedSources = null;
    this.budget.abortStreamsForRoot(rootId, 'Shared source removed');
    this.libraryViewCache = null;
    this.clearArtworkCache();
    this.clearLyricsCache();
    this.emitSnapshot();
    return this.getSnapshot();
  }

  invalidateLibraryCache(): void {
    this.cachedSharedSources = null;
    this.libraryViewCache = null;
    this.clearArtworkCache();
    this.clearLyricsCache();
  }

  createInvitation(options?: {
    autoApproveSingleUse?: boolean;
    ttlMs?: number;
  }): EnrollmentInvitationSummary {
    if (this.state !== 'STANDBY' && this.state !== 'ACTIVE') {
      throw new Error('Cần bật Host Server trước khi tạo mã ghép nối thiết bị.');
    }
    if (!this.activeIdentity || !this.transport.isRunning()) {
      throw new Error('Host identity or network listener is not ready.');
    }
    const config = this.connectRepo.getHostConfig();
    const summary = this.authService.createInvitation({
      hostId: this.activeIdentity.hostId,
      hostDisplayName: config.displayName,
      shortFingerprint: this.activeIdentity.shortFingerprint,
      fullFingerprint: this.activeIdentity.fingerprintSha256,
      listenAddresses: this.transport.getListenAddresses(),
      port: this.transport.getListeningPort() ?? config.port,
      autoApproveSingleUse: options?.autoApproveSingleUse,
      ttlMs: options?.ttlMs,
    });
    this.emitSnapshot();
    return summary;
  }

  revokeInvitation(): HostSnapshot {
    this.authService.revokeActiveInvitation();
    this.emitSnapshot();
    return this.getSnapshot();
  }

  approveEnrollment(requestId: string): HostSnapshot {
    this.authService.approveEnrollmentRequest(requestId);
    this.cachedDevicesRaw = null;
    this.emitSnapshot();
    return this.getSnapshot();
  }

  rejectEnrollment(requestId: string): HostSnapshot {
    this.authService.rejectEnrollmentRequest(requestId);
    this.emitSnapshot();
    return this.getSnapshot();
  }

  renameDevice(deviceId: string, displayName: string): HostSnapshot {
    this.connectRepo.renameDevice(deviceId, displayName);
    this.cachedDevicesRaw = null;
    this.authService.invalidateDeviceCache(deviceId);
    this.emitSnapshot();
    return this.getSnapshot();
  }

  disconnectDevice(deviceId: string): HostSnapshot {
    this.budget.markDeviceDisconnected(deviceId);
    this.powerManager.notifyDeviceTerminated(deviceId);
    this.emitSnapshot();
    return this.getSnapshot();
  }

  revokeDevice(deviceId: string): HostSnapshot {
    this.authService.revokeDevice(deviceId);
    this.cachedDevicesRaw = null;
    this.emitSnapshot();
    return this.getSnapshot();
  }

  removeDevice(deviceId: string): HostSnapshot {
    this.authService.removeDevice(deviceId);
    this.cachedDevicesRaw = null;
    this.emitSnapshot();
    return this.getSnapshot();
  }

  setDeviceRemoteAccess(deviceId: string, enabled: boolean): HostSnapshot {
    this.authService.setDeviceRemoteAccess(deviceId, enabled);
    this.cachedDevicesRaw = null;
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async checkRemoteProvider(): Promise<HostSnapshot> {
    const cfg = this.connectRepo.getHostConfig();
    const gate = this.evaluatePreExposureSecurityGate(Boolean(cfg.remoteUserAcknowledged));
    this.securityGatePassed = gate.passed;
    this.securityGateIssues = gate.issues;
    const status = await this.remoteProvider.detectStatus({
      preferredPort: cfg.remotePublicPort ?? 443,
      mountPath: cfg.remoteMountPath ?? CONNECT_REMOTE_DEFAULT_MOUNT_PATH,
      ownedLocalTarget: this.activeOwnedRoute?.localTarget ?? null,
    });
    this.lastProviderStatus = status;
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async enableRemoteAccess(options?: {
    confirmPublicExposure?: boolean;
    preferredPublicPort?: 443 | 8443 | 10000;
  }): Promise<HostSnapshot> {
    await this.enqueueTransition(async () => {
      if (this.state !== 'STANDBY' && this.state !== 'ACTIVE') {
        this.remoteState = 'ERROR';
        this.remoteLastError = 'Cần bật Host Server trước khi kích hoạt truy cập từ xa (Remote HTTPS).';
        this.emitSnapshot();
        return;
      }

      if (options?.confirmPublicExposure || isAllowedFunnelPublicPort(options?.preferredPublicPort)) {
        this.cachedConfig = this.connectRepo.updateHostConfig({
          ...(options?.confirmPublicExposure ? { remoteUserAcknowledged: true } : {}),
          ...(isAllowedFunnelPublicPort(options?.preferredPublicPort)
            ? { remotePublicPort: options!.preferredPublicPort }
            : {}),
        });
      }

      const cfg = this.getConfigFast();
      const gate = this.evaluatePreExposureSecurityGate(Boolean(cfg.remoteUserAcknowledged));
      this.securityGatePassed = gate.passed;
      this.securityGateIssues = gate.issues;
      if (!gate.passed) {
        this.remoteState = 'SECURITY_BLOCKED';
        this.remoteLastError = gate.issues[0] ?? 'Chưa đạt điều kiện kiểm tra bảo mật trước khi mở kết nối công khai.';
        this.authService.recordSecurityEvent({
          category: 'remote_route_blocked',
          outcome: 'blocked',
          detail: this.remoteLastError,
        });
        this.emitSnapshot();
        return;
      }

      this.remoteState = 'CHECKING_PROVIDER';
      this.remoteLastError = null;
      this.emitSnapshot();

      const preferredPort = cfg.remotePublicPort ?? 443;
      const mountPath =
        normalizeRemoteMountPath(cfg.remoteMountPath) ?? CONNECT_REMOTE_DEFAULT_MOUNT_PATH;
      const providerCheck = await this.remoteProvider.detectStatus({
        preferredPort,
        mountPath,
        ownedLocalTarget: this.activeOwnedRoute?.localTarget ?? null,
      });
      this.lastProviderStatus = providerCheck;

      if (providerCheck.detectionStatus !== 'ready') {
        switch (providerCheck.detectionStatus) {
          case 'not_installed':
            this.remoteState = 'PROVIDER_NOT_INSTALLED';
            break;
          case 'login_required':
            this.remoteState = 'LOGIN_REQUIRED';
            break;
          case 'service_unavailable':
            this.remoteState = 'ERROR';
            break;
          default:
            this.remoteState = 'CONFIGURATION_REQUIRED';
            break;
        }
        this.remoteLastError = providerCheck.message;
        this.emitSnapshot();
        return;
      }

      try {
        this.remoteState = 'STARTING_GATEWAY';
        this.emitSnapshot();

        const gw = await this.remoteGateway.start({
          port: 0,
          mountPath,
          onAllowlistedRequest: (ctx) => this.handleRemoteGatewayRequest(ctx),
        });
        this.startRemoteStreamSweepTimer();

        this.remoteState = 'STARTING_TUNNEL';
        this.emitSnapshot();

        const activated = await this.remoteProvider.activateRoute({
          localGatewayPort: gw.port,
          preferredPublicPort: preferredPort,
          mountPath: gw.mountPath,
        });

        if (!activated.ok) {
          this.lastProviderStatus = activated.providerStatus;
          await this.remoteGateway.stop();
          this.stopRemoteStreamSweepTimer();
          this.remoteState =
            activated.code === 'ROUTE_CONFLICT' ? 'CONFIGURATION_REQUIRED' : 'ERROR';
          this.remoteLastError = activated.message;
          this.emitSnapshot();
          return;
        }

        this.remoteState = 'VERIFYING_ENDPOINT';
        this.emitSnapshot();

        const prevOrigin = this.activeRemoteDescriptor?.publicOrigin ?? null;
        let endpointGen = cfg.remoteEndpointGeneration ?? 1;
        if (prevOrigin && prevOrigin !== activated.ownedRoute.publicOrigin) {
          endpointGen = this.connectRepo.bumpRemoteEndpointGeneration();
          this.cachedConfig = null;
        }

        const id = this.activeIdentity!;
        const descriptor = signRemoteEndpointDescriptor({
          hostId: id.hostId,
          hostDisplayName: cfg.displayName,
          providerId: 'tailscale-funnel',
          publicOrigin: activated.ownedRoute.publicOrigin,
          mountPath: activated.ownedRoute.mountPath,
          endpointGeneration: endpointGen,
          certificatePem: id.certificatePem,
          privateKeyPem: id.privateKeyPem,
          hostFingerprintSha256: id.fingerprintSha256,
        });

        this.activeOwnedRoute = activated.ownedRoute;
        this.activeRemoteDescriptor = descriptor;
        this.staleRouteWarning = null;
        this.connectRepo.setOwnedRemoteRoute(activated.ownedRoute);
        this.remoteState = 'READY';
        this.remoteLastError = null;
        this.authService.recordSecurityEvent({
          category: 'remote_access_enabled',
          outcome: 'success',
          detail: `Đã bật Remote HTTPS qua Tailscale Funnel (${activated.publicEndpointUrl}).`,
        });
        this.emitSnapshot();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.remoteGateway.stop().catch(() => {});
        this.stopRemoteStreamSweepTimer();
        this.remoteState = 'ERROR';
        this.remoteLastError = msg;
        this.recordError('REMOTE_ENABLE_FAILED', msg);
        this.emitSnapshot();
      }
    });
    return this.getSnapshot();
  }

  async disableRemoteAccess(): Promise<HostSnapshot> {
    await this.enqueueTransition(async () => {
      await this.shutdownRemoteAccessInternal();
      this.emitSnapshot();
    });
    return this.getSnapshot();
  }

  private evaluatePreExposureSecurityGate(userConfirmed: boolean): {
    passed: boolean;
    issues: string[];
  } {
    const issues: string[] = [];
    if (this.state !== 'STANDBY' && this.state !== 'ACTIVE') {
      issues.push('Host Server chưa được bật.');
    }
    if (!this.activeIdentity) {
      issues.push('Chưa khởi tạo khóa định danh mật mã ECDSA P-256 của Host.');
    }
    if (this.secrets.getStorageBackend() === 'unavailable') {
      issues.push('Hệ thống mã hóa bảo mật OS safeStorage không khả dụng.');
    }
    if (!userConfirmed) {
      issues.push(
        'Cần người dùng xác nhận rõ ràng trước khi mở cổng HTTPS công cộng qua Tailscale Funnel.',
      );
    }
    return {
      passed: issues.length === 0,
      issues,
    };
  }

  private syncStreamSweepTimer(): void {
    if (
      (this.state === 'STANDBY' || this.state === 'ACTIVE') &&
      this.budget.hasActiveStreams()
    ) {
      if (!this.remoteSweepTimer) {
        this.remoteSweepTimer = setInterval(() => {
          this.budget.sweepAbandonedStreams(REMOTE_STREAM_MAX_ABANDONED_IDLE_MS);
          if (!this.budget.hasActiveStreams()) {
            this.stopRemoteStreamSweepTimer();
          }
        }, REMOTE_STREAM_IDLE_SWEEP_INTERVAL_MS);
        this.remoteSweepTimer.unref?.();
      }
    } else {
      this.stopRemoteStreamSweepTimer();
    }
  }

  private startRemoteStreamSweepTimer(): void {
    this.syncStreamSweepTimer();
  }

  private stopRemoteStreamSweepTimer(): void {
    if (this.remoteSweepTimer) {
      clearInterval(this.remoteSweepTimer);
      this.remoteSweepTimer = null;
    }
  }

  private async reconcileStaleRemoteRouteIfNeeded(): Promise<void> {
    if (this.reconciledStaleStartup) {
      return;
    }
    this.reconciledStaleStartup = true;
    const persisted = this.connectRepo.getOwnedRemoteRoute();
    if (!persisted) {
      return;
    }
    const res = await this.remoteProvider.reconcileStaleOwnedRoute(persisted).catch(() => ({
      ok: false,
      staleRouteWarning: 'Không thể kiểm tra tuyến Funnel cũ từ phiên trước.',
    }));
    if (res.ok) {
      this.connectRepo.setOwnedRemoteRoute(null);
      this.staleRouteWarning = null;
    } else {
      this.staleRouteWarning = res.staleRouteWarning;
    }
  }

  private async shutdownRemoteAccessInternal(): Promise<void> {
    const wasActive =
      this.remoteState !== 'DISABLED' ||
      this.remoteGateway.isRunning() ||
      this.activeOwnedRoute !== null;
    if (!wasActive) {
      return;
    }
    this.remoteState = 'STOPPING';
    this.stopRemoteStreamSweepTimer();
    // 1. Terminate active Remote streams ONLY (preserving LAN Direct playback!) and close Gateway immediately
    this.budget.abortAllRemoteStreams('Remote Access disabled');
    await this.remoteGateway.stop().catch(() => {});

    const owned = this.activeOwnedRoute ?? this.connectRepo.getOwnedRemoteRoute();
    this.activeOwnedRoute = null;
    this.activeRemoteDescriptor = null;

    if (owned) {
      const deact = await this.remoteProvider.deactivateOwnedRoute(owned).catch(() => ({
        ok: false,
        staleRouteWarning:
          'Gateway cục bộ đã đóng an toàn, nhưng gỡ cấu hình Tailscale Funnel gặp lỗi.',
      }));
      if (deact.ok) {
        this.connectRepo.setOwnedRemoteRoute(null);
        this.staleRouteWarning = null;
      } else {
        this.staleRouteWarning = deact.staleRouteWarning;
      }
    }

    this.remoteState = 'DISABLED';
    this.remoteLastError = null;
    this.authService.recordSecurityEvent({
      category: 'remote_access_disabled',
      outcome: 'success',
      detail: 'Đã tắt Remote HTTPS và đóng cổng Loopback Remote Gateway (LAN Direct giữ nguyên).',
    });
  }

  async rotateIdentity(): Promise<HostSnapshot> {
    const wasRunning = this.state === 'STANDBY' || this.state === 'ACTIVE';
    if (wasRunning) {
      await this.stop();
    }
    const cfg = this.connectRepo.getHostConfig();
    this.activeIdentity = await this.identityService.rotateIdentity(cfg.displayName);
    this.authService.recordSecurityEvent({
      category: 'identity_rotated',
      outcome: 'success',
      detail: `Đã tái tạo chứng chỉ danh tính TLS của Host (${this.activeIdentity.shortFingerprint}).`,
    });
    if (wasRunning) {
      await this.start();
    } else {
      this.emitSnapshot();
    }
    return this.getSnapshot();
  }

  private async enqueueTransition(work: () => Promise<void>): Promise<void> {
    const next = this.transitionQueue.then(work, work);
    this.transitionQueue = next.catch(() => {});
    await next;
  }

  private async cleanupAfterFailure(): Promise<void> {
    await this.shutdownRemoteAccessInternal().catch(() => {});
    this.budget.markHostStopped();
    this.authService.clearVolatileState();
    await this.discovery.stopAdvertising().catch(() => {});
    await this.transport.stop().catch(() => {});
    this.clearCaches();
  }

  private syncStandbyOrActiveState(): void {
    if (this.state !== 'STANDBY' && this.state !== 'ACTIVE') {
      return;
    }
    const nextState: HostLifecycleState = this.budget.hasActiveStreams() ? 'ACTIVE' : 'STANDBY';
    if (nextState !== this.state) {
      this.state = nextState;
      this.powerManager.setHostState(nextState);
      this.emitSnapshot();
    }
  }

  private emitSnapshot(): void {
    if (this.stateListeners.size === 0) {
      return;
    }
    const snap = this.getSnapshot();
    for (const listener of this.stateListeners) {
      listener(snap);
    }
  }

  private recordError(code: string, message: string): void {
    this.recentErrors.push({
      timestamp: new Date().toISOString(),
      code,
      message,
    });
    if (this.recentErrors.length > MAX_RECENT_HOST_ERRORS) {
      this.recentErrors.splice(0, this.recentErrors.length - MAX_RECENT_HOST_ERRORS);
    }
  }

  private clearArtworkCache(): void {
    this.artworkCache.clear();
    this.inflightArtwork.clear();
    this.artworkCacheTotalBytes = 0;
    this.budget.updateCacheSizes(
      this.libraryViewCache ? 1 : 0,
      0,
      this.lyricsCache.size,
    );
  }

  private clearLyricsCache(): void {
    this.lyricsCache.clear();
    this.lyricsCacheTotalBytes = 0;
    this.budget.updateCacheSizes(
      this.libraryViewCache ? 1 : 0,
      this.artworkCache.size,
      0,
    );
  }

  private clearCaches(): void {
    this.libraryViewCache = null;
    this.cachedSharedSources = null;
    this.cachedDevicesRaw = null;
    this.cachedNetworkAvailable = null;
    this.clearArtworkCache();
    this.clearLyricsCache();
  }

  private getOrBuildLibraryView(): CachedLibraryView {
    const now = Date.now();
    if (this.libraryViewCache) {
      if (now - this.libraryViewCache.lastTokenCheckedAtMs < LIBRARY_STATE_TOKEN_RECHECK_MS) {
        return this.libraryViewCache;
      }
      const currentToken = this.connectRepo.getLibraryStateToken();
      if (currentToken === this.libraryViewCache.stateToken) {
        this.libraryViewCache.lastTokenCheckedAtMs = now;
        return this.libraryViewCache;
      }
    }

    const cfg = this.getConfigFast();
    const stateToken = this.connectRepo.getLibraryStateToken();
    const hostId = this.activeIdentity?.hostId ?? '00000000-0000-4000-8000-000000000000';
    const allTracks = this.trackRepo.findAll();
    const artworkMap = this.artworkService.getAllRowsMap();
    const lyricsRows = this.trackRepo
      .getDatabase()
      .prepare(
        "SELECT track_id FROM track_lyrics WHERE COALESCE(custom_content, embedded_content, '') <> ''",
      )
      .all() as Array<{ track_id: string }>;
    const lyricsIds = new Set(lyricsRows.map((r) => r.track_id));

    const built = this.connectRepo.buildRemoteLibraryView(
      hostId,
      cfg.displayName,
      allTracks,
      artworkMap,
      lyricsIds,
    );
    this.libraryViewCache = {
      generatedAtMs: now,
      lastTokenCheckedAtMs: now,
      stateToken,
      ...built,
    };
    this.budget.updateCacheSizes(1, this.artworkCache.size, this.lyricsCache.size);
    return this.libraryViewCache;
  }

  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (this.state === 'STOPPING' || this.state === 'STOPPED') {
      sendJson(res, 503, { code: 'HOST_STOPPING', message: 'Host is shutting down.' });
      return;
    }

    const rawUrl = req.url || '/';
    let url: URL;
    try {
      url = new URL(rawUrl, 'https://doremi.local');
    } catch {
      sendJson(res, 400, { code: 'INVALID_URL', message: 'Malformed request URL.' });
      return;
    }

    const pathname = url.pathname;
    if (!pathname.startsWith(CONNECT_API_PREFIX)) {
      sendJson(res, 404, { code: 'NOT_FOUND', message: 'Unknown endpoint.' });
      return;
    }

    const subPath = pathname.slice(CONNECT_API_PREFIX.length) || '/';
    const remoteIp = normalizeIpAddress(req.socket.remoteAddress) || 'unknown';
    const isStreamSubPath = (req.method === 'GET' || req.method === 'HEAD') && subPath.startsWith('/stream/');
    if (isStreamSubPath) {
      req.setTimeout(0);
    } else {
      req.setTimeout(15_000, () => {
        if (!res.headersSent && !res.writableEnded) {
          sendJson(res, 408, { code: 'REQUEST_TIMEOUT', message: 'Request timed out.' });
        }
        req.destroy();
      });
    }

    // 1. Public minimal Host capability & identity discovery endpoint (zero track/path/secret leaks)
    if (req.method === 'GET' && subPath === '/capabilities') {
      const capSlot = this.budget.tryEnterHttpRequest(`pub:${remoteIp}`, 'default');
      if (!capSlot.ok) {
        sendJson(res, 429, { code: 'RATE_LIMITED', message: capSlot.reason });
        return;
      }
      try {
        const cfg = this.connectRepo.getHostConfig();
        const id = this.activeIdentity;
        if (!id) {
          sendJson(res, 503, { code: 'IDENTITY_NOT_READY', message: 'Host identity unavailable.' });
          return;
        }
        const dto: HostCapabilitiesDto = {
          apiVersion: CONNECT_API_VERSION,
          minSupportedApiVersion: CONNECT_MIN_SUPPORTED_API_VERSION,
          appName: 'DoReMi',
          appVersion: this.appVersion,
          hostId: id.hostId,
          hostDisplayName: cfg.displayName,
          hostFingerprintSha256: id.fingerprintSha256,
          shortFingerprint: id.shortFingerprint,
          supportedTransports: ['lan-direct'],
          authRequired: true,
          enrollmentOpen: this.authService.hasOpenEnrollment(),
          directStreamOnly: true,
        };
        sendJson(res, 200, dto);
      } finally {
        capSlot.release();
      }
      return;
    }

    // 2. Enrollment submission & single-delivery credential polling
    if (req.method === 'POST' && subPath === '/enrollment/requests') {
      const slot = this.budget.tryEnterHttpRequest();
      if (!slot.ok) {
        sendJson(res, 429, { code: 'RATE_LIMITED', message: slot.reason });
        return;
      }
      try {
        const body = await readBoundedJsonBody(req);
        const result = this.authService.submitEnrollmentRequest({
          inviteCode: typeof body.inviteCode === 'string' ? body.inviteCode : '',
          deviceName: body.deviceName,
          platform: body.platform,
          clientNonce: body.clientNonce,
          remoteAddress: remoteIp,
        });
        if (result.ok && result.status === 'approved') {
          this.cachedDevicesRaw = null;
        }
        this.emitSnapshot();
        if (!result.ok) {
          sendJson(res, result.httpStatus, { code: result.code, message: result.message });
          return;
        }
        sendJson(res, result.status === 'approved' ? 200 : 202, {
          status: result.status,
          requestId: result.requestId,
          pollToken: result.pollToken,
          ...(result.deviceId ? { deviceId: result.deviceId, deviceToken: result.deviceToken } : {}),
        });
      } catch (err) {
        const code = err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
        sendJson(res, code, { code: 'INVALID_BODY', message: 'Invalid enrollment request body.' });
      } finally {
        slot.release();
      }
      return;
    }

    if (req.method === 'GET' && subPath.startsWith('/enrollment/requests/')) {
      const pollSlot = this.budget.tryEnterHttpRequest(`pub:${remoteIp}`, 'default');
      if (!pollSlot.ok) {
        sendJson(res, 429, { code: 'RATE_LIMITED', message: pollSlot.reason });
        return;
      }
      try {
        const requestId = subPath.slice('/enrollment/requests/'.length);
        if (!isValidTrackUuid(requestId)) {
          sendJson(res, 400, { code: 'INVALID_REQUEST_ID', message: 'Invalid enrollment request ID.' });
          return;
        }
        const pollToken = url.searchParams.get('pollToken') ?? '';
        const result = this.authService.pollEnrollmentRequest(requestId, pollToken, remoteIp);
        if (!result.ok) {
          sendJson(res, result.httpStatus, { code: result.code, message: result.message });
          return;
        }
        if (result.status === 'approved') {
          this.cachedDevicesRaw = null;
          this.emitSnapshot();
        }
        sendJson(res, 200, result);
      } finally {
        pollSlot.release();
      }
      return;
    }

    // 3. All remaining endpoints REQUIRE authenticated, non-revoked device Bearer token
    const auth = this.authService.verifyBearerToken(req.headers.authorization, remoteIp);
    if (!auth.ok) {
      sendJson(res, auth.httpStatus, { code: auth.code, message: auth.message });
      return;
    }

    const device = auth.device;
    const isArtworkRequest =
      req.method === 'GET' &&
      subPath.startsWith('/library/tracks/') &&
      subPath.endsWith('/artwork');
    const reqSlot = this.budget.tryEnterHttpRequest(
      device.deviceId,
      isArtworkRequest ? 'artwork' : 'default',
    );
    if (!reqSlot.ok) {
      sendJson(res, 429, { code: 'CONCURRENCY_LIMIT', message: reqSlot.reason });
      return;
    }
    this.budget.markDeviceSeen(device.deviceId);

    try {
      if (req.method === 'POST' && subPath === '/auth/disconnect') {
        this.budget.markDeviceDisconnected(device.deviceId);
        this.powerManager.notifyDeviceTerminated(device.deviceId);
        this.emitSnapshot();
        sendJson(res, 200, { disconnected: true });
        return;
      }

      if (req.method === 'POST' && subPath === '/auth/rotate-token') {
        if (this.rotatingDevices.has(device.deviceId)) {
          sendJson(res, 409, {
            code: 'ROTATION_IN_PROGRESS',
            message: 'Credential rotation is already in progress for this device.',
          });
          return;
        }
        this.rotatingDevices.add(device.deviceId);
        try {
          const rotated = this.authService.rotateDeviceToken(device.deviceId);
          if (!rotated) {
            sendJson(res, 403, {
              code: 'ACCESS_REVOKED',
              message: 'Cannot rotate credential for revoked or unknown device.',
            });
            return;
          }
          this.emitSnapshot();
          sendJson(res, 200, rotated);
        } finally {
          this.rotatingDevices.delete(device.deviceId);
        }
        return;
      }

      // LAN-only provisioning of verified Remote Endpoint Descriptor + scoped Remote token
      if (req.method === 'POST' && subPath === '/remote/provision') {
        const latestDev = this.connectRepo.findDeviceById(device.deviceId);
        if (!latestDev || latestDev.authState !== 'authorized') {
          sendJson(res, 403, { code: 'ACCESS_REVOKED', message: 'Device is revoked.' });
          return;
        }
        const remoteEnabled = Boolean(latestDev.remoteAccessEnabled);
        let remoteCred: string | null = null;
        if (remoteEnabled) {
          const issued = this.authService.issueOrRotateRemoteToken(device.deviceId, {
            allowInterruptedRecoveryGrace: true,
          });
          remoteCred = issued?.remoteToken ?? null;
        }
        const bundle: RemoteProvisioningBundleDto = {
          hostId: this.activeIdentity?.hostId ?? '',
          deviceId: device.deviceId,
          remoteAccessEnabled: remoteEnabled,
          descriptor: this.activeRemoteDescriptor,
          remoteCredential: remoteCred,
          issuedAt: new Date().toISOString(),
        };
        sendJson(res, 200, bundle);
        return;
      }

      await this.serveSharedProtectedContent(req, res, url, subPath, device, 'lan-direct');
    } finally {
      reqSlot.release();
    }
  }

  private async handleRemoteGatewayRequest(ctx: RemoteGatewayRequestContext): Promise<void> {
    const { req, res, subPath, url } = ctx;
    if (
      (this.state !== 'STANDBY' && this.state !== 'ACTIVE') ||
      this.remoteState !== 'READY' ||
      !this.activeIdentity ||
      !this.activeRemoteDescriptor
    ) {
      sendJson(res, 503, {
        code: 'REMOTE_ACCESS_UNAVAILABLE',
        message: 'Remote Access is disabled or unavailable on this Host.',
      });
      return;
    }

    const id = this.activeIdentity;
    const desc = this.activeRemoteDescriptor;

    // 1. Minimal unauthenticated capability negotiation (zero library/device/user host leaks)
    if (req.method === 'GET' && subPath === '/capabilities') {
      const capSlot = this.budget.tryEnterHttpRequest('__remote_public__', 'default');
      if (!capSlot.ok) {
        sendJson(res, 429, { code: 'RATE_LIMITED', message: capSlot.reason });
        return;
      }
      try {
        const dto: HostCapabilitiesDto = {
          apiVersion: CONNECT_API_VERSION,
          minSupportedApiVersion: CONNECT_MIN_SUPPORTED_API_VERSION,
          appName: 'DoReMi',
          appVersion: this.appVersion,
          hostId: id.hostId,
          hostDisplayName: 'DoReMi Host',
          hostFingerprintSha256: id.fingerprintSha256,
          shortFingerprint: id.shortFingerprint,
          supportedTransports: ['remote-https'],
          authRequired: true,
          enrollmentOpen: false,
          directStreamOnly: true,
        };
        sendJson(res, 200, dto);
      } finally {
        capSlot.release();
      }
      return;
    }

    // 2. Cryptographic Host Identity Proof challenge-response (domain-separated, bounded)
    if (req.method === 'POST' && subPath === '/remote/verify-host') {
      const chalSlot = this.budget.tryEnterHttpRequest('__remote_challenge__', 'default');
      if (!chalSlot.ok) {
        sendJson(res, 429, { code: 'RATE_LIMITED', message: chalSlot.reason });
        return;
      }
      try {
        const body = await readBoundedJsonBody(req);
        const clientNonce = body.clientNonce;
        const expectedHostId =
          typeof body.expectedHostId === 'string' ? body.expectedHostId.trim().toLowerCase() : '';
        if (!isValidRemoteChallengeNonce(clientNonce)) {
          sendJson(res, 400, { code: 'INVALID_NONCE', message: 'Invalid challenge nonce.' });
          return;
        }
        if (expectedHostId && expectedHostId !== id.hostId.toLowerCase()) {
          sendJson(res, 403, {
            code: 'HOST_IDENTITY_MISMATCH',
            message: 'Requested Host ID does not match this Host.',
          });
          return;
        }
        const proof = signRemoteHostIdentityProof({
          hostId: id.hostId,
          publicOrigin: desc.publicOrigin,
          apiBasePath: desc.apiBasePath,
          endpointGeneration: desc.endpointGeneration,
          clientNonce,
          certificatePem: id.certificatePem,
          privateKeyPem: id.privateKeyPem,
        });
        sendJson(res, 200, proof);
      } catch (err) {
        const status = err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
        sendJson(res, status, { code: 'INVALID_CHALLENGE', message: 'Malformed challenge body.' });
      } finally {
        chalSlot.release();
      }
      return;
    }

    // 3. Strictly require scoped Remote Bearer credential + explicit remoteAccessEnabled
    const auth = this.authService.verifyRemoteBearerToken(
      req.headers.authorization,
      'remote-gateway',
    );
    if (!auth.ok) {
      sendJson(res, auth.httpStatus, { code: auth.code, message: auth.message });
      return;
    }

    const device = auth.device;
    const isArtworkRequest =
      req.method === 'GET' &&
      subPath.startsWith('/library/tracks/') &&
      subPath.endsWith('/artwork');
    const reqSlot = this.budget.tryEnterHttpRequest(
      device.deviceId,
      isArtworkRequest ? 'artwork' : 'default',
    );
    if (!reqSlot.ok) {
      sendJson(res, 429, { code: 'CONCURRENCY_LIMIT', message: reqSlot.reason });
      return;
    }
    this.budget.markDeviceSeen(device.deviceId);

    try {
      if (req.method === 'POST' && subPath === '/auth/rotate-remote-token') {
        if (this.rotatingDevices.has(`rem:${device.deviceId}`)) {
          sendJson(res, 409, {
            code: 'ROTATION_IN_PROGRESS',
            message: 'Remote credential rotation is already in progress.',
          });
          return;
        }
        this.rotatingDevices.add(`rem:${device.deviceId}`);
        try {
          const rotated = this.authService.issueOrRotateRemoteToken(device.deviceId);
          if (!rotated) {
            sendJson(res, 403, {
              code: 'REMOTE_ACCESS_NOT_GRANTED',
              message: 'Remote Access is not permitted for this device.',
            });
            return;
          }
          this.emitSnapshot();
          sendJson(res, 200, rotated);
        } finally {
          this.rotatingDevices.delete(`rem:${device.deviceId}`);
        }
        return;
      }

      await this.serveSharedProtectedContent(req, res, url, subPath, device, 'remote-https');
    } finally {
      reqSlot.release();
    }
  }

  private async serveSharedProtectedContent(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    subPath: string,
    device: StoredDeviceAuthRow,
    transport: ConnectTransportMode,
  ): Promise<void> {
    if (req.method === 'POST' && subPath === '/auth/disconnect') {
      if (transport === 'remote-https') {
        this.budget.abortRemoteStreamsForDevice(device.deviceId, 'Remote client disconnected');
        this.powerManager.notifyStreamActivityChanged();
      } else {
        this.budget.markDeviceDisconnected(device.deviceId);
        this.powerManager.notifyDeviceTerminated(device.deviceId);
      }
      this.emitSnapshot();
      sendJson(res, 200, { disconnected: true });
      return;
    }

    if (req.method === 'POST' && subPath === '/playback/session') {
      try {
        const body = await readBoundedJsonBody(req);
        const sessionToken =
          typeof body.sessionToken === 'string' ? body.sessionToken.trim().slice(0, 64) : '';
        const rawState = body.state;
        if (
          !sessionToken ||
          (rawState !== 'playing' && rawState !== 'paused' && rawState !== 'stopped')
        ) {
          sendJson(res, 400, { code: 'INVALID_SESSION_SIGNAL', message: 'Invalid playback session payload.' });
          return;
        }
        const accepted = this.powerManager.recordAuthenticatedPlaybackSignal({
          deviceId: device.deviceId,
          sessionToken,
          state: rawState,
        });
        sendJson(res, accepted ? 200 : 409, { accepted });
      } catch {
        sendJson(res, 400, { code: 'INVALID_BODY', message: 'Malformed playback session body.' });
      }
      return;
    }

    if (req.method === 'GET' && subPath === '/library/summary') {
      const view = this.getOrBuildLibraryView();
      sendJson(res, 200, view.summary);
      return;
    }

    if (req.method === 'GET' && subPath === '/library/tracks') {
      const view = this.getOrBuildLibraryView();
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const albumKey = (url.searchParams.get('albumKey') ?? '').trim();
      const artist = (url.searchParams.get('artist') ?? '').trim().toLowerCase();

      let filtered = view.tracks;
      if (q) {
        filtered = filtered.filter(
          (t) =>
            t.title.toLowerCase().includes(q) ||
            t.artist.toLowerCase().includes(q) ||
            (t.album ?? '').toLowerCase().includes(q),
        );
      }
      if (albumKey) {
        const album = view.albums.find((a) => a.albumKey === albumKey);
        if (album) {
          filtered = sortAlbumTracksCanonical(
            filtered.filter(
              (t) =>
                (t.album || 'Không rõ Album') === album.title &&
                (t.albumArtist || t.artist || 'Unknown Artist') === album.artist,
            ),
          );
        } else {
          filtered = [];
        }
      }
      if (artist) {
        filtered = filtered.filter((t) => t.artist.toLowerCase() === artist);
      }

      sendJson(
        res,
        200,
        paginateItems(filtered, url.searchParams.get('offset'), url.searchParams.get('limit')),
      );
      return;
    }

    if (req.method === 'GET' && subPath === '/library/albums') {
      const view = this.getOrBuildLibraryView();
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const filtered = q
        ? view.albums.filter(
            (a) => a.title.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q),
          )
        : view.albums;
      sendJson(
        res,
        200,
        paginateItems(filtered, url.searchParams.get('offset'), url.searchParams.get('limit')),
      );
      return;
    }

    if (req.method === 'GET' && subPath === '/library/artists') {
      const view = this.getOrBuildLibraryView();
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const filtered = q
        ? view.artists.filter((a) => a.name.toLowerCase().includes(q))
        : view.artists;
      sendJson(
        res,
        200,
        paginateItems(filtered, url.searchParams.get('offset'), url.searchParams.get('limit')),
      );
      return;
    }

    if (req.method === 'GET' && subPath.startsWith('/library/tracks/')) {
      const rest = subPath.slice('/library/tracks/'.length);
      const parts = rest.split('/');
      const trackId = parts[0] ?? '';

      if (!isValidTrackUuid(trackId)) {
        sendJson(res, 400, { code: 'INVALID_TRACK_ID', message: 'Invalid track UUID.' });
        return;
      }

      const view = this.getOrBuildLibraryView();
      const dto = view.tracks.find((t) => t.trackId === trackId.toLowerCase());
      if (!dto) {
        sendJson(res, 404, { code: 'TRACK_NOT_FOUND', message: 'Track is not in shared library.' });
        return;
      }

      if (parts.length === 1) {
        sendJson(res, 200, dto);
        return;
      }

      if (parts.length === 2 && parts[1] === 'artwork') {
        const size = url.searchParams.get('size') === 'thumb' ? 'thumb' : 'full';
        await this.handleArtworkRequest(res, dto.trackId, size);
        return;
      }

      if (parts.length === 2 && parts[1] === 'lyrics') {
        const cachedLyr = this.lyricsCache.get(dto.trackId);
        if (cachedLyr) {
          let sidecarValid = true;
          if (cachedLyr.sidecarPath) {
            const check = await this.fsGuard.resolveAuthorizedSideFile(
              dto.trackId,
              cachedLyr.sidecarPath,
            );
            if (!check.ok) {
              this.lyricsCache.delete(dto.trackId);
              sendJson(res, 403, { code: check.code, message: check.message });
              return;
            }
            await check.handle.close().catch(() => {});
            if (Math.round(check.mtimeMs) !== cachedLyr.sidecarMtimeMs) {
              sidecarValid = false;
              this.lyricsCache.delete(dto.trackId);
            }
          }
          if (sidecarValid) {
            this.lyricsCache.delete(dto.trackId);
            this.lyricsCache.set(dto.trackId, cachedLyr);
            sendJson(res, 200, cachedLyr.payload);
            return;
          }
        }

        const lyrics = await this.lyricsService.resolveTrackLyrics(dto.trackId);
        let sidecarMtimeMs: number | null = null;
        // Revalidate sidecar lyrics path against SharedFilesystemGuard before serving
        if (lyrics.source === 'sidecar' && lyrics.sidecarPath) {
          const check = await this.fsGuard.resolveAuthorizedSideFile(
            dto.trackId,
            lyrics.sidecarPath,
          );
          if (!check.ok) {
            sendJson(res, 403, { code: check.code, message: check.message });
            return;
          }
          sidecarMtimeMs = Math.round(check.mtimeMs);
          await check.handle.close().catch(() => {});
        }
        // Strip Host filesystem path (`sidecarPath`) before returning to remote client
        const cleanPayload: ResolvedTrackLyrics = { ...lyrics, sidecarPath: null };
        this.insertBoundedLyricsCache(dto.trackId, {
          payload: cleanPayload,
          byteSize: Buffer.byteLength(cleanPayload.rawContent || '', 'utf8') + 256,
          sidecarPath: lyrics.source === 'sidecar' ? lyrics.sidecarPath : null,
          sidecarMtimeMs,
        });
        sendJson(res, 200, cleanPayload);
        return;
      }
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && subPath.startsWith('/stream/')) {
      const trackId = subPath.slice('/stream/'.length);
      await this.streamingService.handleStreamRequest({
        req,
        res,
        trackId,
        deviceId: device.deviceId,
        deviceName: device.displayName,
        transport,
      });
      return;
    }

    sendJson(res, 404, { code: 'NOT_FOUND', message: 'Endpoint not found.' });
  }

  private async handleArtworkRequest(
    res: http.ServerResponse,
    trackId: string,
    size: 'full' | 'thumb',
  ): Promise<void> {
    const cacheKey = `${trackId}:${size}`;
    const cached = this.artworkCache.get(cacheKey);
    if (cached) {
      this.artworkCache.delete(cacheKey);
      this.artworkCache.set(cacheKey, cached);
      res.writeHead(200, {
        'Content-Type': cached.mime,
        'Content-Length': String(cached.bytes.length),
        'Cache-Control': 'private, max-age=300',
      });
      res.end(cached.bytes);
      return;
    }

    const row = this.artworkService.getAllRowsMap().get(trackId);
    if (row?.folder_source_path && !row.custom_file && !row.embedded_cache_file) {
      const check = await this.fsGuard.resolveAuthorizedSideFile(trackId, row.folder_source_path);
      if (!check.ok) {
        sendJson(res, check.status, { code: check.code, message: check.message });
        return;
      }
      await check.handle.close().catch(() => {});
    }

    let loadPromise = this.inflightArtwork.get(cacheKey);
    if (!loadPromise) {
      loadPromise = (async (): Promise<CachedArtworkEntry | null> => {
        const internalResp = await this.artworkService.resolveArtworkHttpResponse(
          new Request(`lossless-media://artwork/${trackId}?size=${size}`),
        );
        if (!internalResp.ok) {
          return null;
        }
        const buf = Buffer.from(await internalResp.arrayBuffer());
        const mime = internalResp.headers.get('content-type') || 'image/jpeg';
        const entry = { bytes: buf, mime };
        this.insertBoundedArtworkCache(cacheKey, entry);
        return entry;
      })().finally(() => {
        this.inflightArtwork.delete(cacheKey);
      });
      this.inflightArtwork.set(cacheKey, loadPromise);
    }

    const loaded = await loadPromise;
    if (!loaded) {
      sendJson(res, 404, { code: 'ARTWORK_NOT_FOUND', message: 'No artwork available.' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': loaded.mime,
      'Content-Length': String(loaded.bytes.length),
      'Cache-Control': 'private, max-age=300',
    });
    res.end(loaded.bytes);
  }

  private insertBoundedArtworkCache(key: string, entry: CachedArtworkEntry): void {
    if (entry.bytes.length > 4 * 1024 * 1024) {
      return;
    }
    while (
      (this.artworkCache.size >= MAX_CACHED_ARTWORK_ITEMS ||
        this.artworkCacheTotalBytes + entry.bytes.length > MAX_CACHED_ARTWORK_BYTES) &&
      this.artworkCache.size > 0
    ) {
      const oldestKey = this.artworkCache.keys().next().value;
      if (!oldestKey) break;
      const old = this.artworkCache.get(oldestKey);
      this.artworkCache.delete(oldestKey);
      if (old) {
        this.artworkCacheTotalBytes = Math.max(0, this.artworkCacheTotalBytes - old.bytes.length);
      }
    }
    this.artworkCache.set(key, entry);
    this.artworkCacheTotalBytes += entry.bytes.length;
    this.budget.updateCacheSizes(
      this.libraryViewCache ? 1 : 0,
      this.artworkCache.size,
      this.lyricsCache.size,
    );
  }

  private insertBoundedLyricsCache(trackId: string, entry: CachedLyricsEntry): void {
    if (entry.byteSize > 256 * 1024) {
      return;
    }
    const prev = this.lyricsCache.get(trackId);
    if (prev) {
      this.lyricsCacheTotalBytes = Math.max(0, this.lyricsCacheTotalBytes - prev.byteSize);
      this.lyricsCache.delete(trackId);
    }
    while (
      (this.lyricsCache.size >= MAX_CACHED_LYRICS_ITEMS ||
        this.lyricsCacheTotalBytes + entry.byteSize > MAX_CACHED_LYRICS_BYTES) &&
      this.lyricsCache.size > 0
    ) {
      const oldestKey = this.lyricsCache.keys().next().value;
      if (!oldestKey) break;
      const old = this.lyricsCache.get(oldestKey);
      this.lyricsCache.delete(oldestKey);
      if (old) {
        this.lyricsCacheTotalBytes = Math.max(0, this.lyricsCacheTotalBytes - old.byteSize);
      }
    }
    this.lyricsCache.set(trackId, entry);
    this.lyricsCacheTotalBytes += entry.byteSize;
    this.budget.updateCacheSizes(
      this.libraryViewCache ? 1 : 0,
      this.artworkCache.size,
      this.lyricsCache.size,
    );
  }

  /** Helper for validating local path readability safely in tests/diagnostics. */
  async checkSharedSourceHealth(rootPath: string): Promise<boolean> {
    try {
      const stat = await fsPromises.stat(rootPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }
}
