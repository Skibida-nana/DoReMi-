import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type net from 'node:net';
import tls from 'node:tls';
import {
  CONNECT_API_PREFIX,
  CONNECT_API_VERSION,
  CONNECT_MIN_SUPPORTED_API_VERSION,
  clampConnectPageLimit,
  clampConnectPageOffset,
} from '../../../shared/contracts/connect-api';
import {
  normalizeFullFingerprint,
  parseAndValidatePairingPayload,
} from '../../../shared/contracts/connect-pairing';
import {
  CONNECT_REMOTE_TOKEN_PREFIX,
  validateRemoteEndpointDescriptorShape,
  validateRemoteHttpsOrigin,
} from '../../../shared/contracts/connect-remote';
import {
  parseRemoteArtworkMediaUrl,
  parseRemoteTrackMediaUrl,
} from '../../../shared/contracts/media-protocol';
import type {
  CandidateTransportAvailability,
  ClientConnectionStatus,
  ClientDiagnosticsSnapshot,
  ClientEnrollmentSessionState,
  ClientStreamTraceEntry,
  ConnectClientSnapshot,
  ConnectErrorCode,
  ConnectionSelectionMode,
  ConnectTransportMode,
  DiscoveredHostRecord,
  HandoverEventSummary,
  HostCapabilitiesDto,
  HostProbeResult,
  RememberedHostRecord,
  RemoteAlbumDto,
  RemoteArtistDto,
  RemoteEndpointDescriptorV1,
  RemoteHostIdentityProofV1,
  RemoteLibraryPage,
  RemoteLibrarySummaryDto,
  RemoteProvisioningBundleDto,
  RemoteTrackDto,
  SecurityAuditCategory,
  SecurityAuditEvent,
  SmartConnectionState,
} from '../../../shared/types/connect';
import type { ResolvedTrackLyrics } from '../../../shared/types/track';
import {
  buildMediaCorsHeaders,
  isAllowedMediaCorsOrigin,
  parseByteRangeHeader,
} from '../audio-stream-handler';
import {
  invalidateFlacPlansByPrefix,
  resolveFlacStreamPlanFromSource,
  type FlacStreamPlan,
} from '../flac-stream-sanitizer';
import type { ConnectRepository, StoredRememberedHost } from './connect-repository';
import { LanDiscoveryService } from './lan-discovery-service';
import { isEligibleLanSocketAddress } from './network-interfaces';
import { NetworkChangeMonitor } from './network-monitor';
import { RemoteAlacStreamManager } from './remote-alac-decoder';
import {
  verifyRemoteEndpointDescriptor,
  verifyRemoteHostIdentityProof,
} from './remote-trust';
import type { ConnectSecretStorage } from './secret-storage';
import {
  classifyConnectFailure,
  SmartConnectionManager,
  type PreparedTransportSession,
  type SmartConnectionPolicyConfig,
  type TransportPrepareResult,
} from './smart-connection-manager';
import { formatSha256Fingerprint } from './x509-cert';

const CLIENT_REQUEST_TIMEOUT_MS = 10_000;
const REMOTE_HTTPS_REQUEST_TIMEOUT_MS = 15_000;

export interface PublicHttpsTlsOptions {
  /**
   * Optional isolated Root CA bundle used ONLY in controlled local HTTPS test profiles.
   * `rejectUnauthorized: true` and `tls.checkServerIdentity` remain strictly enforced in all modes.
   */
  ca?: string | Buffer | Array<string | Buffer>;
  lookup?: net.LookupFunction;
  connectOverridePort?: number;
}
const ENROLL_POLL_INTERVAL_MS = 1_000;
const ENROLL_MAX_WAIT_MS = 120_000;
const MAX_RECOVERY_ATTEMPTS = 3;
const MAX_CLIENT_STREAM_TRACES = 64;
const MAX_CONCURRENT_ARTWORK_REQUESTS = 4;
const MAX_TRACK_META_CACHE = 1000;
const MAX_CLIENT_LYRICS_CACHE = 32;
const AGENT_MAX_SOCKETS = 6;
const AGENT_MAX_FREE_SOCKETS = 2;
const AGENT_KEEP_ALIVE_MSECS = 15_000;
const STREAM_TRANSIENT_RETRY_DELAYS_MS = [80, 180] as const;

interface CachedClientLyricsEntry {
  sourceRevision: string | null;
  lyrics: ResolvedTrackLyrics;
}

interface UpstreamOpenResult {
  upstream: http.IncomingMessage;
  status: number;
  errorBodyText: string | null;
  errorApiCode: string | null;
}

function isAudioOrMediaContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const lower = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (lower.startsWith('audio/')) return true;
  if (lower === 'application/ogg' || lower === 'application/octet-stream') return true;
  return false;
}

function parseTotalSizeFromContentRange(headerVal: string | undefined): number | null {
  if (!headerVal) return null;
  const slashIdx = headerVal.lastIndexOf('/');
  if (slashIdx < 0) return null;
  const totalPart = headerVal.slice(slashIdx + 1).trim();
  if (!totalPart || totalPart === '*') return null;
  const parsed = Number(totalPart);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export class ConnectClientRequestError extends Error {
  readonly code: ConnectErrorCode;
  readonly httpStatus?: number;

  constructor(code: ConnectErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = 'ConnectClientRequestError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function getPeerCertSpkiSha256(socket: tls.TLSSocket): {
  fingerprintSha256: string;
  shortFingerprint: string;
} | null {
  const peer = socket.getPeerCertificate(true);
  if (!peer || !peer.raw) {
    return null;
  }
  const cert = new crypto.X509Certificate(peer.raw);
  const spkiDer = cert.publicKey.export({ type: 'spki', format: 'der' });
  const digestHex = crypto.createHash('sha256').update(spkiDer).digest('hex');
  return formatSha256Fingerprint(digestHex);
}

function mapNetworkErrorCode(err: unknown): ConnectErrorCode {
  const code = (err as { code?: string } | null)?.code ?? '';
  if (err instanceof ConnectClientRequestError) {
    return err.code;
  }
  if (
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID'
  ) {
    return 'CONNECTION_FAILED';
  }
  if (
    code === 'ECONNREFUSED' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN'
  ) {
    return 'HOST_UNAVAILABLE';
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EPIPE') {
    return 'NETWORK_INTERRUPTED';
  }
  return 'CONNECTION_FAILED';
}

function isRetryableErrorCode(code: ConnectErrorCode): boolean {
  return code === 'NETWORK_INTERRUPTED' || code === 'HOST_UNAVAILABLE' || code === 'CONNECTION_FAILED';
}

function isValidLanOrLoopbackTarget(address: string, port: number): boolean {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return false;
  }
  const trimmed = address.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || /\s/.test(trimmed)) {
    return false;
  }
  if (trimmed === 'localhost') {
    return true;
  }
  return isEligibleLanSocketAddress(trimmed);
}

function toPublicRememberedHost(row: StoredRememberedHost): RememberedHostRecord {
  const { credentialRef: _ref, remoteCredentialRef: _remRef, ...rest } = row;
  return rest;
}

export class ConnectClientService {
  private readonly connectRepo: ConnectRepository;
  private readonly secrets: ConnectSecretStorage;
  private readonly discovery: LanDiscoveryService;
  private readonly publicHttpsOptions?: PublicHttpsTlsOptions;

  private status: ClientConnectionStatus = 'disconnected';
  private activeHost: StoredRememberedHost | null = null;
  private activeTransport: ConnectTransportMode | null = null;
  private activeRemoteDescriptor: RemoteEndpointDescriptorV1 | null = null;
  private activeToken: string | null = null;
  private activeSummary: RemoteLibrarySummaryDto | null = null;
  private discoveredHosts: DiscoveredHostRecord[] = [];
  private isDiscovering = false;
  private lastError: string | null = null;
  private lastErrorCode: ConnectErrorCode | null = null;
  private reconnectAttempt = 0;
  private enrollmentState: ClientEnrollmentSessionState = { status: 'idle' };
  private activeEnrollmentAbort: AbortController | null = null;
  private stateListeners = new Set<(snapshot: ConnectClientSnapshot) => void>();

  private readonly remoteAlac = new RemoteAlacStreamManager();
  private readonly remoteTrackMetaCache = new Map<string, RemoteTrackDto>();
  private readonly inflightTrackMeta = new Map<string, Promise<RemoteTrackDto | null>>();
  private readonly remoteLyricsCache = new Map<string, CachedClientLyricsEntry>();
  private readonly inflightLyrics = new Map<string, Promise<ResolvedTrackLyrics>>();
  private readonly scopedAgents = new Map<string, https.Agent>();
  private readonly activeStreamAborts = new Set<AbortController>();
  private readonly recentTraces: ClientStreamTraceEntry[] = [];
  private readonly securityEvents: SecurityAuditEvent[] = [];
  private lastTrackFailure: ClientStreamTraceEntry | null = null;
  private artworkInflight = 0;
  private readonly artworkWaiters: Array<() => void> = [];
  private correlationSeq = 0;
  private rotatingCredential = false;
  readonly smartManager: SmartConnectionManager;
  readonly networkMonitor: NetworkChangeMonitor;

  constructor(options: {
    connectRepo: ConnectRepository;
    secrets: ConnectSecretStorage;
    discovery?: LanDiscoveryService;
    publicHttpsOptions?: PublicHttpsTlsOptions;
    networkMonitor?: NetworkChangeMonitor;
    smartPolicy?: Partial<SmartConnectionPolicyConfig>;
    nowMs?: () => number;
  }) {
    this.connectRepo = options.connectRepo;
    this.secrets = options.secrets;
    this.discovery = options.discovery ?? new LanDiscoveryService();
    this.publicHttpsOptions = options.publicHttpsOptions;
    this.networkMonitor =
      options.networkMonitor ??
      new NetworkChangeMonitor({
        nowMs: options.nowMs,
      });
    this.smartManager = new SmartConnectionManager({
      driver: {
        findRememberedHost: (hostId) => this.connectRepo.findRememberedHost(hostId),
        setRememberedHostMode: (hostId, mode) =>
          this.connectRepo.setRememberedHostConnectionMode(hostId, mode),
        hasLanCredential: (host) => Boolean(this.secrets.getSecret(host.credentialRef)),
        hasRemoteCredential: (host) =>
          Boolean(host.remoteCredentialRef && this.secrets.getSecret(host.remoteCredentialRef)),
        inspectRemoteDescriptorEligibility: (host) =>
          this.inspectRemoteDescriptorEligibilityInternal(host),
        discoverLanCandidates: async (_hostId, signal) => {
          if (signal.aborted) return [];
          const found = await this.discovery.scanLanHosts(1200);
          this.discoveredHosts = found;
          return found;
        },
        prepareLanTransport: (host, signal, overrideEp) =>
          this.prepareLanTransportInternal(host, signal, overrideEp),
        prepareRemoteTransport: (host, signal) =>
          this.prepareRemoteTransportInternal(host, signal),
        probeActiveTransportHealth: (session, signal) =>
          this.probeSessionHealthInternal(session, signal),
        commitPreparedSession: (session, meta) =>
          this.commitPreparedSessionInternal(session, meta),
        clearActiveSession: (reason) => this.clearActiveSessionInternal(reason),
        onStateUpdated: () => this.emitSnapshot(),
      },
      networkMonitor: this.networkMonitor,
      policy: options.smartPolicy,
      nowMs: options.nowMs,
    });
  }

  private nextCorrelationId(): string {
    this.correlationSeq += 1;
    return `cl-${Date.now().toString(36)}-${this.correlationSeq.toString(36)}`;
  }

  private recordStreamTrace(entry: ClientStreamTraceEntry): void {
    const enriched: ClientStreamTraceEntry = {
      ...entry,
      transport: entry.transport ?? this.activeTransport ?? 'lan-direct',
    };
    this.recentTraces.unshift(enriched);
    if (this.recentTraces.length > MAX_CLIENT_STREAM_TRACES) {
      this.recentTraces.length = MAX_CLIENT_STREAM_TRACES;
    }
    if (
      enriched.errorCode !== null &&
      enriched.errorCode !== 'CANCELLED' &&
      enriched.errorCode !== 'ABORTED' &&
      enriched.kind !== 'artwork'
    ) {
      this.lastTrackFailure = enriched;
    }
  }

  private cacheRemoteTrackDto(hostId: string, dto: RemoteTrackDto): void {
    const key = `${hostId.toLowerCase()}::${dto.trackId.toLowerCase()}`;
    if (this.remoteTrackMetaCache.has(key)) {
      this.remoteTrackMetaCache.delete(key);
    }
    this.remoteTrackMetaCache.set(key, dto);
    while (this.remoteTrackMetaCache.size > MAX_TRACK_META_CACHE) {
      const oldest = this.remoteTrackMetaCache.keys().next().value;
      if (oldest === undefined) break;
      this.remoteTrackMetaCache.delete(oldest);
    }
  }

  private abortActiveUpstreamStreams(): number {
    const count = this.activeStreamAborts.size;
    if (count === 0) {
      return 0;
    }
    for (const ctrl of Array.from(this.activeStreamAborts)) {
      this.activeStreamAborts.delete(ctrl);
      try {
        ctrl.abort();
      } catch {
        // Ignore abort errors
      }
    }
    return count;
  }

  private getScopedLanAgent(
    hostId: string,
    address: string,
    port: number,
    normalizedPinnedFp: string,
  ): https.Agent {
    const key = `lan::${hostId.toLowerCase()}::${address.trim().toLowerCase()}:${port}::${normalizedPinnedFp}`;
    let agent = this.scopedAgents.get(key);
    if (!agent) {
      agent = new https.Agent({
        keepAlive: true,
        keepAliveMsecs: AGENT_KEEP_ALIVE_MSECS,
        maxSockets: AGENT_MAX_SOCKETS,
        maxFreeSockets: AGENT_MAX_FREE_SOCKETS,
      });
      this.scopedAgents.set(key, agent);
    }
    return agent;
  }

  private getScopedRemoteAgent(descriptor: RemoteEndpointDescriptorV1, canonicalOrigin: string): https.Agent {
    const key = `remote::${descriptor.hostId.toLowerCase()}::${canonicalOrigin.toLowerCase()}::gen${descriptor.endpointGeneration}`;
    let agent = this.scopedAgents.get(key);
    if (!agent) {
      agent = new https.Agent({
        keepAlive: true,
        keepAliveMsecs: AGENT_KEEP_ALIVE_MSECS,
        maxSockets: AGENT_MAX_SOCKETS,
        maxFreeSockets: AGENT_MAX_FREE_SOCKETS,
        ...(this.publicHttpsOptions?.ca ? { ca: this.publicHttpsOptions.ca } : {}),
      });
      this.scopedAgents.set(key, agent);
    }
    return agent;
  }

  destroyScopedAgents(filter?: { hostId?: string; transport?: ConnectTransportMode }): void {
    const hostToken = filter?.hostId ? `::${filter.hostId.toLowerCase()}::` : null;
    const transportPrefix = filter?.transport
      ? filter.transport === 'remote-https'
        ? 'remote::'
        : 'lan::'
      : null;

    for (const [key, agent] of [...this.scopedAgents.entries()]) {
      if (hostToken && !key.includes(hostToken)) {
        continue;
      }
      if (transportPrefix && !key.startsWith(transportPrefix)) {
        continue;
      }
      this.scopedAgents.delete(key);
      try {
        agent.destroy();
      } catch {
        // Ignore agent teardown errors
      }
    }
  }

  getPooledSocketCounts(): { agentCount: number; activeSockets: number; freeSockets: number } {
    let activeSockets = 0;
    let freeSockets = 0;
    for (const agent of this.scopedAgents.values()) {
      for (const list of Object.values(agent.sockets)) {
        activeSockets += list?.length ?? 0;
      }
      for (const list of Object.values(agent.freeSockets)) {
        freeSockets += list?.length ?? 0;
      }
    }
    return {
      agentCount: this.scopedAgents.size,
      activeSockets,
      freeSockets,
    };
  }

  private resetStreamingSessionCaches(options?: {
    preserveValidHostCache?: boolean;
    gracefulDrainMs?: number;
  }): number {
    let cancelled = 0;
    if (options?.gracefulDrainMs && options.gracefulDrainMs > 0) {
      const draining = Array.from(this.activeStreamAborts);
      cancelled = draining.length;
      this.activeStreamAborts.clear();
      if (draining.length > 0) {
        const timer = setTimeout(() => {
          for (const ctrl of draining) {
            try {
              ctrl.abort();
            } catch {
              // ignore
            }
          }
        }, options.gracefulDrainMs);
        timer.unref?.();
      }
    } else {
      cancelled = this.abortActiveUpstreamStreams();
    }
    if (!options?.preserveValidHostCache) {
      this.remoteAlac.clear();
      this.remoteTrackMetaCache.clear();
      this.inflightTrackMeta.clear();
      this.remoteLyricsCache.clear();
      this.inflightLyrics.clear();
      invalidateFlacPlansByPrefix('remote::');
    }
    this.lastTrackFailure = null;
    return cancelled;
  }

  private recordSecurityEvent(
    category: SecurityAuditCategory,
    outcome: 'success' | 'blocked' | 'error',
    detail: string,
    statusCode: number | null = null,
  ): void {
    this.securityEvents.unshift({
      timestamp: new Date().toISOString(),
      category,
      correlationId: null,
      deviceId: this.activeHost?.deviceId ?? null,
      statusCode,
      outcome,
      detail: detail.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 240),
    });
    if (this.securityEvents.length > 64) {
      this.securityEvents.length = 64;
    }
  }

  private getActiveEndpointDisplay(): string | null {
    if (!this.activeHost || this.status !== 'connected') {
      return null;
    }
    if (this.activeTransport === 'remote-https' && this.activeRemoteDescriptor) {
      return `${this.activeRemoteDescriptor.publicOrigin}${this.activeRemoteDescriptor.mountPath}`;
    }
    return `${this.activeHost.lastAddress}:${this.activeHost.port}`;
  }

  getClientDiagnosticsSnapshot(): ClientDiagnosticsSnapshot {
    return {
      sampledAt: new Date().toISOString(),
      activeHostId: this.activeHost?.hostId ?? null,
      activeHostName: this.activeHost?.displayName ?? null,
      activeHostAddress: this.activeHost?.lastAddress ?? null,
      activeHostPort: this.activeHost?.port ?? null,
      activeTransport: this.activeTransport,
      activeEndpointDisplay: this.getActiveEndpointDisplay(),
      status: this.status,
      lastError: this.lastError,
      lastErrorCode: this.lastErrorCode,
      lastTrackFailure: this.lastTrackFailure ? { ...this.lastTrackFailure } : null,
      recentTraces: this.recentTraces.map((item) => ({ ...item })),
      recentSecurityEvents: this.securityEvents.map((ev) => ({ ...ev })),
      smartConnection: this.smartManager.getDiagnosticsSnapshot(),
    };
  }

  subscribe(listener: (snapshot: ConnectClientSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  getSnapshot(): ConnectClientSnapshot {
    const remembered = this.connectRepo.listRememberedHosts().map(toPublicRememberedHost);
    return {
      status: this.status,
      smartState: this.smartManager.getSmartState(),
      selectedMode: this.smartManager.getSelectedMode(),
      activeHost: this.activeHost ? toPublicRememberedHost(this.activeHost) : null,
      intendedHostId: this.smartManager.getIntendedHostId(),
      activeTransport: this.activeTransport,
      alternativeTransportAvailable: this.smartManager.getAlternativeTransportAvailable(),
      activeEndpointDisplay: this.getActiveEndpointDisplay(),
      summary: this.activeSummary,
      discoveredHosts: [...this.discoveredHosts],
      rememberedHosts: remembered,
      isDiscovering: this.isDiscovering,
      lastError: this.lastError,
      lastErrorCode: this.lastErrorCode,
      failureCategory: this.smartManager.getFailureCategory(),
      reconnectAttempt: this.reconnectAttempt,
      connectionGeneration: this.smartManager.getConnectionGeneration(),
      handoverSignal: this.smartManager.getLastHandoverSignal(),
      enrollment: { ...this.enrollmentState },
    };
  }

  async discoverHosts(timeoutMs = 1500): Promise<DiscoveredHostRecord[]> {
    this.isDiscovering = true;
    this.emitSnapshot();
    try {
      const found = await this.discovery.scanLanHosts(timeoutMs);
      this.discoveredHosts = found;
      return found;
    } finally {
      this.isDiscovering = false;
      this.emitSnapshot();
    }
  }

  /**
   * Probes a Host address:port over TLS to inspect its SPKI certificate fingerprint and `/api/v1/capabilities`.
   * Checks whether any remembered Host ID experienced an unexpected identity key change.
   */
  async probeHost(address: string, port: number): Promise<HostProbeResult> {
    const cleanAddr = address.trim();
    if (!isValidLanOrLoopbackTarget(cleanAddr, port)) {
      return {
        reachable: false,
        address: cleanAddr,
        port,
        capabilities: null,
        observedFingerprintSha256: null,
        observedShortFingerprint: null,
        pinnedFingerprintMismatch: false,
        expectedFingerprintSha256: null,
        errorCode: 'CONNECTION_FAILED',
        errorMessage: 'Địa chỉ Host phải là IP mạng LAN nội bộ (hoặc localhost) với cổng hợp lệ (1024-65535).',
      };
    }

    try {
      const inspected = await this.inspectTlsPeerFingerprint(cleanAddr, port);
      const capResp = await this.pinnedJsonRequest<HostCapabilitiesDto>({
        address: cleanAddr,
        port,
        pinnedFingerprint: inspected.fingerprintSha256,
        method: 'GET',
        apiPath: '/capabilities',
      });

      const apiMajor = Number.parseInt(capResp.apiVersion, 10);
      const minMajor = Number.parseInt(capResp.minSupportedApiVersion, 10);
      const clientMajor = Number.parseInt(CONNECT_API_VERSION, 10);
      const clientMin = Number.parseInt(CONNECT_MIN_SUPPORTED_API_VERSION, 10);
      if (
        !Number.isFinite(apiMajor) ||
        apiMajor < clientMin ||
        (Number.isFinite(minMajor) && minMajor > clientMajor)
      ) {
        return {
          reachable: true,
          address: cleanAddr,
          port,
          capabilities: capResp,
          observedFingerprintSha256: inspected.fingerprintSha256,
          observedShortFingerprint: inspected.shortFingerprint,
          pinnedFingerprintMismatch: false,
          expectedFingerprintSha256: null,
          errorCode: 'UNSUPPORTED_API_VERSION',
          errorMessage: `Phiên bản API của Host (v${capResp.apiVersion}) không tương thích với Client (v${CONNECT_API_VERSION}).`,
        };
      }

      const remembered = this.connectRepo.findRememberedHost(capResp.hostId);
      const mismatch = Boolean(
        remembered && remembered.pinnedFingerprint !== inspected.fingerprintSha256,
      );

      return {
        reachable: true,
        address: cleanAddr,
        port,
        capabilities: capResp,
        observedFingerprintSha256: inspected.fingerprintSha256,
        observedShortFingerprint: inspected.shortFingerprint,
        pinnedFingerprintMismatch: mismatch,
        expectedFingerprintSha256: remembered?.pinnedFingerprint ?? null,
        ...(mismatch
          ? {
              errorCode: 'HOST_IDENTITY_MISMATCH',
              errorMessage:
                'Chứng chỉ định danh của Host đã thay đổi so với lần ghép nối trước. Vui lòng xác minh lại vân tay trước khi kết nối.',
            }
          : {}),
      };
    } catch (err) {
      const code = mapNetworkErrorCode(err);
      return {
        reachable: false,
        address: cleanAddr,
        port,
        capabilities: null,
        observedFingerprintSha256: null,
        observedShortFingerprint: null,
        pinnedFingerprintMismatch: false,
        expectedFingerprintSha256: null,
        errorCode: code,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Parses and validates a versioned offline pairing payload (`doremi-pair` v1), verifies
   * the candidate LAN endpoint TLS certificate & Host ID, and completes enrollment.
   */
  async enrollFromPairingPayload(input: {
    rawPayload: string;
    deviceName: string;
    pollIntervalMs?: number;
    maxWaitMs?: number;
  }): Promise<ConnectClientSnapshot> {
    const parsed = parseAndValidatePairingPayload(input.rawPayload);
    if (!parsed.ok) {
      const code: ConnectErrorCode =
        parsed.code === 'INVITATION_EXPIRED' ? 'ENROLLMENT_EXPIRED' : 'CONNECTION_FAILED';
      this.enrollmentState = {
        status: 'error',
        errorCode: code,
        message: parsed.message,
      };
      this.recordSecurityEvent('auth_failed', 'blocked', parsed.message);
      this.emitSnapshot();
      return this.getSnapshot();
    }

    const payload = parsed.payload;
    let selectedAddress: string | null = null;
    let observedFormattedFp: string | null = null;
    let lastProbeErr: ConnectErrorCode = 'HOST_UNAVAILABLE';
    let lastProbeMsg = 'Không thể kết nối tới địa chỉ Host trong mã ghép nối.';

    for (const endpoint of payload.endpoints) {
      const candidateAddr = endpoint.address;
      const candidatePort = endpoint.port;
      if (!isValidLanOrLoopbackTarget(candidateAddr, candidatePort)) {
        continue;
      }
      try {
        const inspected = await this.inspectTlsPeerFingerprint(candidateAddr, candidatePort);
        if (normalizeFullFingerprint(inspected.fingerprintSha256) !== payload.identityFingerprint) {
          this.recordSecurityEvent(
            'identity_mismatch',
            'blocked',
            `Từ chối ghép nối QR do chứng chỉ TLS của Host tại ${candidateAddr}:${candidatePort} không khớp vân tay trong mã ghép nối.`,
          );
          this.enrollmentState = {
            status: 'error',
            errorCode: 'HOST_IDENTITY_MISMATCH',
            message:
              'Vân tay chứng chỉ TLS của Host không khớp với mã QR/Pairing Payload. Đã chặn kết nối để phòng chống giả mạo.',
          };
          this.emitSnapshot();
          return this.getSnapshot();
        }

        const caps = await this.pinnedJsonRequest<HostCapabilitiesDto>({
          address: candidateAddr,
          port: candidatePort,
          pinnedFingerprint: inspected.fingerprintSha256,
          method: 'GET',
          apiPath: '/capabilities',
        });

        if (caps.hostId.toLowerCase() !== payload.hostId) {
          this.recordSecurityEvent(
            'identity_mismatch',
            'blocked',
            `Từ chối ghép nối QR do Host ID không khớp (${caps.hostId}).`,
          );
          this.enrollmentState = {
            status: 'error',
            errorCode: 'HOST_IDENTITY_MISMATCH',
            message: 'Host ID không khớp với mã ghép nối. Đã hủy yêu cầu.',
          };
          this.emitSnapshot();
          return this.getSnapshot();
        }

        selectedAddress = candidateAddr;
        observedFormattedFp = inspected.fingerprintSha256;
        return this.enrollWithHost({
          address: selectedAddress,
          port: candidatePort,
          expectedFingerprintSha256: observedFormattedFp,
          inviteCode: payload.invitation,
          deviceName: input.deviceName,
          pollIntervalMs: input.pollIntervalMs,
          maxWaitMs: input.maxWaitMs,
        });
      } catch (err) {
        lastProbeErr = mapNetworkErrorCode(err);
        lastProbeMsg = err instanceof Error ? err.message : String(err);
      }
    }

    this.enrollmentState = {
      status: 'error',
      errorCode: lastProbeErr,
      message: lastProbeMsg,
    };
    this.emitSnapshot();
    return this.getSnapshot();
  }

  /**
   * Executes secure device enrollment against a verified Host fingerprint,
   * waits for Host approval (or instant approval if Host enabled single-use auto-approve),
   * persists encrypted credentials in `safeStorage`, and connects automatically on success.
   */
  async enrollWithHost(input: {
    address: string;
    port: number;
    expectedFingerprintSha256: string;
    inviteCode: string;
    deviceName: string;
    pollIntervalMs?: number;
    maxWaitMs?: number;
  }): Promise<ConnectClientSnapshot> {
    const cleanAddr = input.address.trim();
    if (!isValidLanOrLoopbackTarget(cleanAddr, input.port)) {
      this.enrollmentState = {
        status: 'error',
        errorCode: 'CONNECTION_FAILED',
        message: 'Địa chỉ Host không nằm trong mạng LAN hợp lệ.',
      };
      this.emitSnapshot();
      return this.getSnapshot();
    }

    this.activeEnrollmentAbort?.abort();
    const abort = new AbortController();
    this.activeEnrollmentAbort = abort;

    this.enrollmentState = {
      status: 'submitting',
      message: 'Đang xác minh danh tính Host và gửi yêu cầu ghép nối...',
    };
    this.emitSnapshot();

    try {
      const caps = await this.pinnedJsonRequest<HostCapabilitiesDto>({
        address: cleanAddr,
        port: input.port,
        pinnedFingerprint: input.expectedFingerprintSha256,
        method: 'GET',
        apiPath: '/capabilities',
        signal: abort.signal,
      });

      const clientNonce = crypto.randomBytes(16).toString('hex');
      const enrollResp = await this.pinnedJsonRequest<{
        status: 'pending' | 'approved';
        requestId: string;
        pollToken: string;
        deviceId?: string;
        deviceToken?: string;
      }>({
        address: cleanAddr,
        port: input.port,
        pinnedFingerprint: input.expectedFingerprintSha256,
        method: 'POST',
        apiPath: '/enrollment/requests',
        body: {
          inviteCode: input.inviteCode,
          deviceName: input.deviceName,
          platform: process.platform,
          clientNonce,
        },
        signal: abort.signal,
      });

      let deviceId = enrollResp.deviceId;
      let deviceToken = enrollResp.deviceToken;

      if (enrollResp.status === 'pending') {
        this.enrollmentState = {
          status: 'pending_approval',
          requestId: enrollResp.requestId,
          hostId: caps.hostId,
          hostDisplayName: caps.hostDisplayName,
          message: `Đang chờ máy Host "${caps.hostDisplayName}" xác nhận chấp thuận thiết bị...`,
        };
        this.emitSnapshot();

        const pollInterval = Math.max(150, input.pollIntervalMs ?? ENROLL_POLL_INTERVAL_MS);
        const deadline = Date.now() + Math.max(2000, input.maxWaitMs ?? ENROLL_MAX_WAIT_MS);

        while (Date.now() < deadline && !abort.signal.aborted) {
          await new Promise((r) => setTimeout(r, pollInterval));
          if (abort.signal.aborted) {
            break;
          }
          const polled = await this.pinnedJsonRequest<{
            status: 'pending' | 'approved' | 'rejected' | 'expired';
            deviceId?: string;
            deviceToken?: string;
          }>({
            address: cleanAddr,
            port: input.port,
            pinnedFingerprint: input.expectedFingerprintSha256,
            method: 'GET',
            apiPath: `/enrollment/requests/${enrollResp.requestId}?pollToken=${encodeURIComponent(enrollResp.pollToken)}`,
            signal: abort.signal,
          });

          if (polled.status === 'approved' && polled.deviceId && polled.deviceToken) {
            deviceId = polled.deviceId;
            deviceToken = polled.deviceToken;
            break;
          }
          if (polled.status === 'rejected') {
            throw new ConnectClientRequestError(
              'ENROLLMENT_REJECTED',
              'Yêu cầu ghép nối đã bị từ chối trên máy Host.',
            );
          }
          if (polled.status === 'expired') {
            throw new ConnectClientRequestError(
              'ENROLLMENT_EXPIRED',
              'Yêu cầu ghép nối đã hết hạn.',
            );
          }
        }
      }

      if (!deviceId || !deviceToken) {
        throw new ConnectClientRequestError(
          'ENROLLMENT_EXPIRED',
          'Hết thời gian chờ chấp thuận từ máy Host.',
        );
      }

      const credentialRef = `client.host.${caps.hostId}.token`;
      await this.secrets.setSecret(credentialRef, deviceToken);

      this.connectRepo.upsertRememberedHost({
        hostId: caps.hostId,
        displayName: caps.hostDisplayName,
        lastAddress: cleanAddr,
        port: input.port,
        pinnedFingerprint: input.expectedFingerprintSha256,
        shortFingerprint: caps.shortFingerprint,
        deviceId,
        apiVersion: caps.apiVersion,
        credentialRef,
      });

      this.enrollmentState = {
        status: 'approved',
        hostId: caps.hostId,
        hostDisplayName: caps.hostDisplayName,
        message: 'Ghép nối thành công!',
      };
      this.recordSecurityEvent(
        'enrollment_approved',
        'success',
        `Đã ghép nối thành công và ghim chứng chỉ TLS cho Host "${caps.hostDisplayName}".`,
      );

      return this.connectToRememberedHost(caps.hostId, cleanAddr, input.port);
    } catch (err) {
      const code = mapNetworkErrorCode(err);
      this.enrollmentState = {
        status: code === 'ENROLLMENT_REJECTED' ? 'rejected' : 'error',
        errorCode: code,
        message: err instanceof Error ? err.message : String(err),
      };
      this.emitSnapshot();
      return this.getSnapshot();
    }
  }

  async setConnectionMode(
    hostId: string,
    mode: ConnectionSelectionMode,
  ): Promise<ConnectClientSnapshot> {
    await this.smartManager.setConnectionMode(hostId, mode);
    if (this.activeHost?.hostId === hostId.toLowerCase()) {
      this.activeHost = this.connectRepo.findRememberedHost(hostId) ?? this.activeHost;
    }
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async setPreferredTransport(
    hostId: string,
    mode: ConnectTransportMode,
  ): Promise<ConnectClientSnapshot> {
    return this.setConnectionMode(
      hostId,
      mode === 'remote-https' ? 'remote-only' : 'lan-only',
    );
  }

  async manualReconnect(): Promise<ConnectClientSnapshot> {
    await this.smartManager.manualRetry();
    return this.getSnapshot();
  }

  notifyNetworkHint(hint: 'online' | 'offline' | 'recheck'): void {
    this.smartManager.notifyExternalNetworkHint(hint);
  }

  recordHandoverPlaybackOutcome(params: {
    handoverSeq: number;
    positionBeforeSec: number | null;
    positionAfterSec: number | null;
  }): void {
    this.smartManager.recordHandoverPlaybackOutcome(params);
  }

  async verifyTrackSourceConsistency(params: {
    hostId: string;
    trackId: string;
    expectedFileSize?: number | null;
    expectedSourceRevision?: string | null;
  }): Promise<{
    ok: boolean;
    sourceConsistent: boolean;
    missingOrUnshared: boolean;
    updatedTrack: RemoteTrackDto | null;
  }> {
    const cleanHostId = params.hostId.toLowerCase();
    const cleanTrackId = params.trackId.toLowerCase();
    if (!this.activeHost || !this.activeToken || this.activeHost.hostId !== cleanHostId) {
      return {
        ok: false,
        sourceConsistent: false,
        missingOrUnshared: false,
        updatedTrack: null,
      };
    }

    try {
      const host = this.activeHost;
      const token = this.activeToken;
      const dto =
        this.activeTransport === 'remote-https' && this.activeRemoteDescriptor
          ? await this.publicHttpsJsonRequest<RemoteTrackDto>({
              descriptor: this.activeRemoteDescriptor,
              method: 'GET',
              apiPath: `/library/tracks/${cleanTrackId}`,
              bearerToken: token,
            })
          : await this.pinnedJsonRequest<RemoteTrackDto>({
              hostId: host.hostId,
              address: host.lastAddress,
              port: host.port,
              pinnedFingerprint: host.pinnedFingerprint,
              method: 'GET',
              apiPath: `/library/tracks/${cleanTrackId}`,
              bearerToken: token,
            });

      const prevCached = this.remoteTrackMetaCache.get(`${cleanHostId}::${cleanTrackId}`) ?? null;
      const expectedSize = params.expectedFileSize ?? prevCached?.fileSizeBytes ?? null;
      const expectedRev = params.expectedSourceRevision ?? prevCached?.sourceRevision ?? null;

      let liveRev: string | null = dto.sourceRevision ?? null;
      try {
        const openedHead = await this.openPinnedUpstreamWithRetry({
          host,
          token,
          apiSubPath: `/stream/${cleanTrackId}`,
          method: 'HEAD',
          correlationId: this.nextCorrelationId(),
        });
        const hdrRev = openedHead.upstream.headers['x-doremi-source-revision'];
        if (typeof hdrRev === 'string' && hdrRev.length > 0) {
          liveRev = hdrRev;
        }
        openedHead.upstream.resume();
        if (openedHead.status === 404 || openedHead.status === 403) {
          this.remoteAlac.invalidateTrack(cleanHostId, cleanTrackId);
          return {
            ok: false,
            sourceConsistent: false,
            missingOrUnshared: true,
            updatedTrack: null,
          };
        }
      } catch {
        // Fallback to DTO metadata revision if HEAD failed transiently
      }

      const enrichedDto: RemoteTrackDto = liveRev ? { ...dto, sourceRevision: liveRev } : dto;
      this.cacheRemoteTrackDto(cleanHostId, enrichedDto);

      const sizeChanged =
        expectedSize !== null &&
        enrichedDto.fileSizeBytes !== null &&
        expectedSize !== enrichedDto.fileSizeBytes;
      let revChanged = false;
      if (expectedRev && liveRev && expectedRev !== liveRev) {
        const [expSizeStr, expMtimeStr] = expectedRev.split(':');
        const [liveSizeStr, liveMtimeStr] = liveRev.split(':');
        const expSize = Number(expSizeStr);
        const liveSize = Number(liveSizeStr);
        const expMtime = Number(expMtimeStr);
        const liveMtime = Number(liveMtimeStr);
        if (
          Number.isFinite(expSize) &&
          Number.isFinite(liveSize) &&
          Number.isFinite(expMtime) &&
          Number.isFinite(liveMtime)
        ) {
          // Tolerate <= 2ms NTFS fractional stat rounding when byte size is identical
          revChanged = expSize !== liveSize || Math.abs(expMtime - liveMtime) > 2;
        } else {
          revChanged = true;
        }
      }

      if (sizeChanged || revChanged) {
        this.remoteAlac.invalidateTrack(cleanHostId, cleanTrackId);
        this.remoteLyricsCache.delete(`${cleanHostId}::${cleanTrackId}`);
        invalidateFlacPlansByPrefix(`remote::${cleanHostId}::${cleanTrackId}::`);
        return {
          ok: true,
          sourceConsistent: false,
          missingOrUnshared: false,
          updatedTrack: enrichedDto,
        };
      }

      return {
        ok: true,
        sourceConsistent: true,
        missingOrUnshared: false,
        updatedTrack: enrichedDto,
      };
    } catch (err) {
      if (err instanceof ConnectClientRequestError && (err.httpStatus === 404 || err.httpStatus === 403)) {
        this.remoteAlac.invalidateTrack(cleanHostId, cleanTrackId);
        return {
          ok: false,
          sourceConsistent: false,
          missingOrUnshared: true,
          updatedTrack: null,
        };
      }
      return {
        ok: false,
        sourceConsistent: false,
        missingOrUnshared: false,
        updatedTrack: null,
      };
    }
  }

  /**
   * Synchronizes verified signed Remote Endpoint Descriptor and scoped Remote Bearer credential
   * over the trusted SPKI-pinned LAN connection (`POST /api/v1/remote/provision`).
   */
  async syncRemoteAccessOverLan(
    hostId: string,
    options?: { silent?: boolean },
  ): Promise<ConnectClientSnapshot> {
    const remembered = this.connectRepo.findRememberedHost(hostId);
    if (!remembered) {
      if (!options?.silent) {
        this.lastErrorCode = 'HOST_UNAVAILABLE';
        this.lastError = 'Không tìm thấy Host đã lưu để đồng bộ Remote HTTPS.';
        this.emitSnapshot();
      }
      return this.getSnapshot();
    }

    const lanToken = this.secrets.getSecret(remembered.credentialRef);
    if (!lanToken) {
      if (!options?.silent) {
        this.lastErrorCode = 'AUTH_FAILED';
        this.lastError = 'Thiếu LAN token để đồng bộ thông tin Remote từ Host.';
        this.emitSnapshot();
      }
      return this.getSnapshot();
    }

    try {
      const bundle = await this.pinnedJsonRequest<RemoteProvisioningBundleDto>({
        address: remembered.lastAddress,
        port: remembered.port,
        pinnedFingerprint: remembered.pinnedFingerprint,
        method: 'POST',
        apiPath: '/remote/provision',
        bearerToken: lanToken,
        body: {},
      });

      if (bundle.hostId.toLowerCase() !== remembered.hostId.toLowerCase()) {
        throw new ConnectClientRequestError(
          'HOST_IDENTITY_MISMATCH',
          'Host ID phản hồi khi đồng bộ Remote không khớp.',
        );
      }

      let verifiedDescriptor: RemoteEndpointDescriptorV1 | null = remembered.remoteEndpoint ?? null;
      if (bundle.descriptor) {
        const minGen = remembered.remoteEndpoint?.endpointGeneration ?? 1;
        const verified = verifyRemoteEndpointDescriptor(
          bundle.descriptor,
          remembered.hostId,
          remembered.pinnedFingerprint,
          { minGeneration: minGen },
        );
        if (!verified.ok) {
          this.recordSecurityEvent('identity_mismatch', 'blocked', verified.message);
          throw new ConnectClientRequestError('HOST_IDENTITY_MISMATCH', verified.message);
        }
        verifiedDescriptor = verified.descriptor;
      }

      const remoteCredRef = `client.host.${remembered.hostId}.remoteToken`;
      if (bundle.remoteAccessEnabled && bundle.remoteCredential) {
        if (!bundle.remoteCredential.startsWith(`${CONNECT_REMOTE_TOKEN_PREFIX}${remembered.deviceId}.`)) {
          throw new ConnectClientRequestError(
            'AUTH_FAILED',
            'Host trả về Remote credential sai định dạng.',
          );
        }
        await this.secrets.setSecret(remoteCredRef, bundle.remoteCredential);
        this.connectRepo.saveRememberedHostRemoteAssociation({
          hostId: remembered.hostId,
          descriptor: verifiedDescriptor,
          remoteCredentialRef: remoteCredRef,
        });
        if (this.activeHost?.hostId === remembered.hostId && this.activeTransport === 'remote-https') {
          this.activeToken = bundle.remoteCredential;
          this.activeRemoteDescriptor = verifiedDescriptor;
        }
      } else {
        await this.secrets.deleteSecret(remoteCredRef);
        this.connectRepo.saveRememberedHostRemoteAssociation({
          hostId: remembered.hostId,
          descriptor: verifiedDescriptor,
          remoteCredentialRef: null,
        });
      }

      if (this.activeHost?.hostId === remembered.hostId) {
        this.activeHost = this.connectRepo.findRememberedHost(remembered.hostId) ?? remembered;
      }
      this.emitSnapshot();
      return this.getSnapshot();
    } catch (err) {
      if (!options?.silent) {
        const code = mapNetworkErrorCode(err);
        this.lastErrorCode = code;
        this.lastError = err instanceof Error ? err.message : String(err);
        this.emitSnapshot();
      }
      try {
        return this.getSnapshot();
      } catch {
        return {
          status: 'disconnected',
          smartState: 'DISCONNECTED',
          selectedMode: 'automatic',
          activeHost: null,
          intendedHostId: null,
          activeTransport: null,
          alternativeTransportAvailable: null,
          activeEndpointDisplay: null,
          summary: null,
          discoveredHosts: [],
          rememberedHosts: [],
          isDiscovering: false,
          lastError: null,
          lastErrorCode: null,
          failureCategory: 'none',
          reconnectAttempt: 0,
          connectionGeneration: this.smartManager.getConnectionGeneration(),
          handoverSignal: null,
          enrollment: { status: 'idle' },
        };
      }
    }
  }

  async connectToRememberedHost(
    hostId: string,
    overrideAddress?: string,
    overridePort?: number,
    explicitMode?: ConnectTransportMode,
  ): Promise<ConnectClientSnapshot> {
    await this.smartManager.connect(hostId, {
      overrideAddress,
      overridePort,
      oneShotExplicitTransport: explicitMode,
      preserveActiveForHandover: Boolean(
        this.activeHost && this.activeHost.hostId === hostId.toLowerCase(),
      ),
    });
    return this.getSnapshot();
  }

  private inspectRemoteDescriptorEligibilityInternal(host: StoredRememberedHost): {
    eligible: boolean;
    availability: CandidateTransportAvailability;
    errorCode?: ConnectErrorCode;
    category?: 'authorization' | 'security';
    message?: string;
  } {
    if (!host.remoteEndpoint) {
      const hasRemToken = Boolean(
        host.remoteCredentialRef && this.secrets.getSecret(host.remoteCredentialRef),
      );
      if (!hasRemToken) {
        return {
          eligible: false,
          availability: 'permission_not_granted',
          errorCode: 'REMOTE_ACCESS_NOT_GRANTED',
          category: 'authorization',
          message:
            'Thiết bị này chưa được cấp quyền Truy cập từ xa (Remote HTTPS) hoặc chưa đồng bộ Remote token.',
        };
      }
      return {
        eligible: false,
        availability: 'unavailable',
        errorCode: 'REMOTE_ENDPOINT_NOT_CONFIGURED',
        category: 'authorization',
        message:
          'Chưa có thông tin Remote HTTPS Endpoint được xác minh cho Host này. Hãy kết nối mạng LAN tại nhà và bấm "Đồng bộ Remote" trước khi đi xa.',
      };
    }

    const shapeCheck = validateRemoteEndpointDescriptorShape(host.remoteEndpoint, {
      allowExpired: false,
    });
    if (!shapeCheck.ok) {
      if (shapeCheck.code === 'DESCRIPTOR_EXPIRED') {
        return {
          eligible: false,
          availability: 'descriptor_expired',
          errorCode: 'REMOTE_ENDPOINT_EXPIRED',
          category: 'authorization',
          message: shapeCheck.message,
        };
      }
      this.recordSecurityEvent('identity_mismatch', 'blocked', shapeCheck.message);
      return {
        eligible: false,
        availability: 'security_blocked',
        errorCode: 'HOST_IDENTITY_MISMATCH',
        category: 'security',
        message: shapeCheck.message,
      };
    }

    const verifiedDesc = verifyRemoteEndpointDescriptor(
      host.remoteEndpoint,
      host.hostId,
      host.pinnedFingerprint,
    );
    if (!verifiedDesc.ok) {
      if (verifiedDesc.code === 'DESCRIPTOR_EXPIRED') {
        return {
          eligible: false,
          availability: 'descriptor_expired',
          errorCode: 'REMOTE_ENDPOINT_EXPIRED',
          category: 'authorization',
          message: verifiedDesc.message,
        };
      }
      this.recordSecurityEvent('identity_mismatch', 'blocked', verifiedDesc.message);
      return {
        eligible: false,
        availability: 'security_blocked',
        errorCode: 'HOST_IDENTITY_MISMATCH',
        category: 'security',
        message: verifiedDesc.message,
      };
    }

    return {
      eligible: true,
      availability: 'eligible',
    };
  }

  private async prepareLanTransportInternal(
    remembered: StoredRememberedHost,
    signal: AbortSignal,
    overrideEndpoint?: { address: string; port: number },
  ): Promise<TransportPrepareResult> {
    const startedMs = Date.now();
    const address = (overrideEndpoint?.address ?? remembered.lastAddress).trim();
    const port = overrideEndpoint?.port ?? remembered.port;
    if (!isValidLanOrLoopbackTarget(address, port)) {
      return {
        ok: false,
        errorCode: 'CONNECTION_FAILED',
        category: 'security',
        message: 'Địa chỉ hoặc cổng kết nối LAN của Host không nằm trong dải mạng nội bộ hợp lệ.',
        latencyMs: Date.now() - startedMs,
      };
    }

    const token = this.secrets.getSecret(remembered.credentialRef);
    if (!token) {
      this.recordSecurityEvent(
        'auth_failed',
        'blocked',
        `Thiếu hoặc không giải mã được credential cho Host "${remembered.displayName}".`,
      );
      return {
        ok: false,
        errorCode: 'AUTH_FAILED',
        category: 'authorization',
        message: 'Không tìm thấy thông tin xác thực đã mã hóa cho Host này. Hãy ghép nối lại.',
        latencyMs: Date.now() - startedMs,
      };
    }

    try {
      const caps = await this.pinnedJsonRequest<HostCapabilitiesDto>({
        hostId: remembered.hostId,
        address,
        port,
        pinnedFingerprint: remembered.pinnedFingerprint,
        method: 'GET',
        apiPath: '/capabilities',
        signal,
      });

      if (caps.hostId.toLowerCase() !== remembered.hostId.toLowerCase()) {
        this.destroyScopedAgents({ hostId: remembered.hostId, transport: 'lan-direct' });
        this.recordSecurityEvent(
          'identity_mismatch',
          'blocked',
          `Host ID tại ${address}:${port} không khớp với Host đã lưu.`,
        );
        return {
          ok: false,
          errorCode: 'HOST_IDENTITY_MISMATCH',
          category: 'security',
          message: 'Host ID tại địa chỉ này không khớp với Host đã lưu.',
          latencyMs: Date.now() - startedMs,
        };
      }

      const summary = await this.pinnedJsonRequest<RemoteLibrarySummaryDto>({
        hostId: remembered.hostId,
        address,
        port,
        pinnedFingerprint: remembered.pinnedFingerprint,
        method: 'GET',
        apiPath: '/library/summary',
        bearerToken: token,
        signal,
      });

      this.connectRepo.touchRememberedHostEndpoint(remembered.hostId, address, port);
      const updatedHost = this.connectRepo.findRememberedHost(remembered.hostId) ?? remembered;

      return {
        ok: true,
        session: {
          host: updatedHost,
          transport: 'lan-direct',
          token,
          summary,
          remoteDescriptor: null,
          verifiedAddress: address,
          verifiedPort: port,
          latencyMs: Date.now() - startedMs,
        },
      };
    } catch (err) {
      this.destroyScopedAgents({ hostId: remembered.hostId, transport: 'lan-direct' });
      const code = mapNetworkErrorCode(err);
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        errorCode: code,
        category: classifyConnectFailure(code, msg),
        message: msg,
        latencyMs: Date.now() - startedMs,
      };
    }
  }

  private async prepareRemoteTransportInternal(
    remembered: StoredRememberedHost,
    signal: AbortSignal,
  ): Promise<TransportPrepareResult> {
    const startedMs = Date.now();
    if (!remembered.remoteEndpoint) {
      return {
        ok: false,
        errorCode: 'REMOTE_ENDPOINT_NOT_CONFIGURED',
        category: 'authorization',
        message:
          'Chưa có thông tin Remote HTTPS Endpoint được xác minh cho Host này. Hãy kết nối mạng LAN tại nhà và bấm "Đồng bộ Remote" trước khi đi xa.',
        latencyMs: Date.now() - startedMs,
      };
    }

    const verifiedDesc = verifyRemoteEndpointDescriptor(
      remembered.remoteEndpoint,
      remembered.hostId,
      remembered.pinnedFingerprint,
    );
    if (!verifiedDesc.ok) {
      const isExpired = verifiedDesc.code === 'DESCRIPTOR_EXPIRED';
      if (!isExpired) {
        this.recordSecurityEvent('identity_mismatch', 'blocked', verifiedDesc.message);
      }
      return {
        ok: false,
        errorCode: isExpired ? 'REMOTE_ENDPOINT_EXPIRED' : 'HOST_IDENTITY_MISMATCH',
        category: isExpired ? 'authorization' : 'security',
        message: verifiedDesc.message,
        latencyMs: Date.now() - startedMs,
      };
    }

    const remoteToken = remembered.remoteCredentialRef
      ? this.secrets.getSecret(remembered.remoteCredentialRef)
      : null;
    if (
      !remoteToken ||
      !remoteToken.startsWith(`${CONNECT_REMOTE_TOKEN_PREFIX}${remembered.deviceId}.`)
    ) {
      return {
        ok: false,
        errorCode: 'REMOTE_ACCESS_NOT_GRANTED',
        category: 'authorization',
        message:
          'Thiết bị này chưa được cấp quyền Truy cập từ xa (Remote HTTPS) hoặc chưa đồng bộ Remote token từ Host.',
        latencyMs: Date.now() - startedMs,
      };
    }

    try {
      const descriptor = verifiedDesc.descriptor;
      const originInfo = validateRemoteHttpsOrigin(descriptor.publicOrigin, descriptor.providerId);
      if (!originInfo.ok) {
        return {
          ok: false,
          errorCode: 'HOST_IDENTITY_MISMATCH',
          category: 'security',
          message: originInfo.message,
          latencyMs: Date.now() - startedMs,
        };
      }

      // Step 1: Verify Host Identity Proof BEFORE transmitting any Remote Bearer credential!
      const clientNonce = crypto.randomBytes(24).toString('base64url');
      const rawProof = await this.publicHttpsJsonRequest<RemoteHostIdentityProofV1>({
        descriptor,
        method: 'POST',
        apiPath: '/remote/verify-host',
        body: {
          protocolVersion: 1,
          clientNonce,
          expectedHostId: remembered.hostId,
          expectedOrigin: descriptor.publicOrigin,
          expectedGeneration: descriptor.endpointGeneration,
        },
        signal,
      });

      const proofCheck = verifyRemoteHostIdentityProof(rawProof, {
        hostId: remembered.hostId,
        publicOrigin: descriptor.publicOrigin,
        apiBasePath: descriptor.apiBasePath,
        minGeneration: descriptor.endpointGeneration,
        clientNonce,
        pinnedFingerprintSha256: remembered.pinnedFingerprint,
      });

      if (!proofCheck.ok) {
        this.destroyScopedAgents({ hostId: remembered.hostId, transport: 'remote-https' });
        this.recordSecurityEvent('identity_mismatch', 'blocked', proofCheck.message);
        return {
          ok: false,
          errorCode: 'HOST_IDENTITY_MISMATCH',
          category: 'security',
          message: proofCheck.message,
          latencyMs: Date.now() - startedMs,
        };
      }

      // Step 2: Public TLS + Endpoint Descriptor + Signed Challenge-Response ALL verified;
      // now safe to transmit the scoped Remote Bearer token.
      const summary = await this.publicHttpsJsonRequest<RemoteLibrarySummaryDto>({
        descriptor,
        method: 'GET',
        apiPath: '/library/summary',
        bearerToken: remoteToken,
        signal,
      });

      this.connectRepo.touchRememberedHostRemoteConnected(remembered.hostId);
      const updatedHost = this.connectRepo.findRememberedHost(remembered.hostId) ?? remembered;

      return {
        ok: true,
        session: {
          host: updatedHost,
          transport: 'remote-https',
          token: remoteToken,
          summary,
          remoteDescriptor: descriptor,
          verifiedAddress: originInfo.hostname,
          verifiedPort: originInfo.port,
          latencyMs: Date.now() - startedMs,
        },
      };
    } catch (err) {
      this.destroyScopedAgents({ hostId: remembered.hostId, transport: 'remote-https' });
      const rawSysCode = (err as { code?: string } | null)?.code ?? '';
      const isTlsSecurityFailure =
        rawSysCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        rawSysCode === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
        rawSysCode === 'SELF_SIGNED_CERT_IN_CHAIN' ||
        rawSysCode === 'CERT_HAS_EXPIRED' ||
        rawSysCode === 'ERR_TLS_CERT_ALTNAME_INVALID';
      const code = mapNetworkErrorCode(err);
      const msg = err instanceof Error ? err.message : String(err);
      if (isTlsSecurityFailure) {
        this.recordSecurityEvent('identity_mismatch', 'blocked', `Public TLS verification failed: ${msg}`);
      }
      return {
        ok: false,
        errorCode: code,
        category: isTlsSecurityFailure ? 'security' : classifyConnectFailure(code, msg),
        message: msg,
        latencyMs: Date.now() - startedMs,
      };
    }
  }

  private async probeSessionHealthInternal(
    session: PreparedTransportSession,
    signal: AbortSignal,
  ): Promise<{
    ok: boolean;
    errorCode?: ConnectErrorCode;
    category?: 'recoverable_network' | 'authorization' | 'security' | 'content';
    message?: string;
  }> {
    try {
      if (session.transport === 'remote-https' && session.remoteDescriptor) {
        await this.publicHttpsJsonRequest<RemoteLibrarySummaryDto>({
          descriptor: session.remoteDescriptor,
          method: 'GET',
          apiPath: '/library/summary',
          bearerToken: session.token,
          signal,
        });
      } else {
        await this.pinnedJsonRequest<RemoteLibrarySummaryDto>({
          hostId: session.host.hostId,
          address: session.verifiedAddress,
          port: session.verifiedPort,
          pinnedFingerprint: session.host.pinnedFingerprint,
          method: 'GET',
          apiPath: '/library/summary',
          bearerToken: session.token,
          signal,
        });
      }
      return { ok: true };
    } catch (err) {
      this.destroyScopedAgents({ hostId: session.host.hostId, transport: session.transport });
      const code = mapNetworkErrorCode(err);
      const msg = err instanceof Error ? err.message : String(err);
      const cat = classifyConnectFailure(code, msg);
      return {
        ok: false,
        errorCode: code,
        category: cat === 'none' ? 'recoverable_network' : cat,
        message: msg,
      };
    }
  }

  private commitPreparedSessionInternal(
    session: PreparedTransportSession,
    meta: {
      isHandover: boolean;
      fromTransport: ConnectTransportMode | null;
      strategy: 'make-before-break' | 'break-before-make';
      reason: string;
      handoverEvent?: HandoverEventSummary | null;
    },
  ): { streamsCancelled: number } {
    const prevHostId = this.activeHost?.hostId ?? null;
    if (prevHostId && prevHostId !== session.host.hostId) {
      this.destroyScopedAgents({ hostId: prevHostId });
    }
    if (meta.isHandover && meta.fromTransport && meta.fromTransport !== session.transport) {
      if (meta.strategy === 'make-before-break') {
        const oldHostId = session.host.hostId;
        const oldTransport = meta.fromTransport;
        const drainTimer = setTimeout(() => {
          if (this.activeTransport !== oldTransport) {
            this.destroyScopedAgents({ hostId: oldHostId, transport: oldTransport });
          }
        }, 650);
        drainTimer.unref?.();
      } else {
        this.destroyScopedAgents({ hostId: session.host.hostId, transport: meta.fromTransport });
      }
    }
    const cancelled = this.resetStreamingSessionCaches({
      preserveValidHostCache: meta.isHandover,
      gracefulDrainMs: meta.isHandover && meta.strategy === 'make-before-break' ? 600 : 0,
    });
    this.activeHost = session.host;
    this.activeTransport = session.transport;
    this.activeRemoteDescriptor = session.remoteDescriptor;
    this.activeToken = session.token;
    this.activeSummary = session.summary;
    this.status = 'connected';
    this.lastError = null;
    this.lastErrorCode = null;
    this.reconnectAttempt = 0;

    if (session.transport === 'lan-direct' && session.host.remoteEndpoint) {
      const expMs = Date.parse(session.host.remoteEndpoint.expiresAt);
      const needsRefresh = !Number.isFinite(expMs) || expMs - Date.now() < 7 * 86_400_000;
      if (needsRefresh) {
        // Best-effort background refresh of expiring/expired signed Remote Endpoint Descriptor while on trusted LAN
        void this.syncRemoteAccessOverLan(session.host.hostId, { silent: true })
          .then(() => {
            if (this.activeHost?.hostId === session.host.hostId) {
              try {
                this.activeHost =
                  this.connectRepo.findRememberedHost(session.host.hostId) ?? this.activeHost;
                this.emitSnapshot();
              } catch {
                // Ignore if client database closed during disconnect/shutdown
              }
            }
          })
          .catch(() => {});
      }
    }

    return { streamsCancelled: cancelled };
  }

  private clearActiveSessionInternal(reason: {
    smartState: SmartConnectionState;
    errorCode: ConnectErrorCode | null;
    category: 'none' | 'recoverable_network' | 'authorization' | 'security' | 'content';
    message: string | null;
  }): { streamsCancelled: number } {
    const isTransientReconnect =
      reason.smartState === 'RECONNECTING' ||
      reason.smartState === 'HANDOVER_PENDING' ||
      reason.smartState === 'HANDOVER_IN_PROGRESS' ||
      reason.smartState === 'CHECKING_NETWORK';

    const cancelled = this.resetStreamingSessionCaches({
      preserveValidHostCache: isTransientReconnect,
    });
    this.destroyScopedAgents();

    this.activeToken = null;
    this.activeTransport = null;
    this.activeRemoteDescriptor = null;

    if (reason.smartState === 'DISCONNECTED') {
      this.status = 'disconnected';
      this.activeHost = null;
      this.activeSummary = null;
      this.lastError = null;
      this.lastErrorCode = null;
      this.reconnectAttempt = 0;
    } else if (isTransientReconnect) {
      this.status = reason.smartState === 'CHECKING_NETWORK' ? 'connecting' : 'reconnecting';
      this.lastErrorCode = reason.errorCode;
      this.lastError = reason.message;
      this.reconnectAttempt = this.smartManager.getRetryCount();
    } else {
      this.status = 'error';
      this.lastErrorCode = reason.errorCode;
      this.lastError = reason.message;
      this.reconnectAttempt = this.smartManager.getRetryCount();
      if (reason.category === 'security' || reason.category === 'authorization') {
        this.activeHost = null;
        this.activeSummary = null;
      }
    }

    return { streamsCancelled: cancelled };
  }

  async disconnect(): Promise<ConnectClientSnapshot> {
    this.activeEnrollmentAbort?.abort();
    const host = this.activeHost;
    const token = this.activeToken;
    const prevTransport = this.activeTransport;
    const prevRemoteDesc = this.activeRemoteDescriptor;

    this.smartManager.disconnect('User disconnected');
    this.status = 'disconnected';
    this.resetStreamingSessionCaches();
    this.activeHost = null;
    this.activeTransport = null;
    this.activeRemoteDescriptor = null;
    this.activeToken = null;
    this.activeSummary = null;
    this.lastError = null;
    this.lastErrorCode = null;
    this.reconnectAttempt = 0;
    this.emitSnapshot();

    if (host && token) {
      if (prevTransport === 'remote-https' && prevRemoteDesc) {
        await this.publicHttpsJsonRequest({
          descriptor: prevRemoteDesc,
          method: 'POST',
          apiPath: '/auth/disconnect',
          bearerToken: token,
          body: {},
          poolSockets: false,
        }).catch(() => {});
      } else {
        await this.pinnedJsonRequest({
          address: host.lastAddress,
          port: host.port,
          pinnedFingerprint: host.pinnedFingerprint,
          method: 'POST',
          apiPath: '/auth/disconnect',
          bearerToken: token,
          body: {},
        }).catch(() => {});
      }
    }
    this.destroyScopedAgents();

    return this.getSnapshot();
  }

  async shutdown(): Promise<void> {
    this.smartManager.shutdown();
    await this.disconnect().catch(() => {});
    this.destroyScopedAgents();
  }

  handleSystemSuspend(): void {
    this.abortActiveUpstreamStreams();
    this.destroyScopedAgents();
    this.smartManager.handleSystemSuspend();
  }

  handleSystemResume(): void {
    this.smartManager.handleSystemResume();
  }

  async removeRememberedHost(hostId: string): Promise<ConnectClientSnapshot> {
    if (this.activeHost?.hostId === hostId) {
      await this.disconnect();
    }
    const removed = this.connectRepo.removeRememberedHost(hostId);
    if (removed) {
      await this.secrets.deleteSecret(removed.credentialRef);
      if (removed.remoteCredentialRef) {
        await this.secrets.deleteSecret(removed.remoteCredentialRef);
      }
    }
    this.emitSnapshot();
    return this.getSnapshot();
  }

  /**
   * Rotates the Bearer credential with the currently connected Host (LAN `POST /auth/rotate-token`
   * or Remote HTTPS `POST /auth/rotate-remote-token`) and atomically updates encrypted storage.
   */
  async rotateActiveHostCredential(): Promise<ConnectClientSnapshot> {
    if (!this.activeHost || !this.activeToken || this.status !== 'connected') {
      throw new ConnectClientRequestError(
        'CONNECTION_FAILED',
        'Cần đang kết nối với máy Host để xoay vòng (rotate) token xác thực.',
      );
    }
    if (this.rotatingCredential) {
      throw new ConnectClientRequestError(
        'CONNECTION_FAILED',
        'Đang thực hiện xoay vòng token cho Host hiện tại.',
      );
    }

    this.rotatingCredential = true;
    try {
      const host = this.activeHost;
      if (this.activeTransport === 'remote-https' && this.activeRemoteDescriptor) {
        const rotated = await this.publicHttpsJsonRequest<{
          deviceId: string;
          remoteToken: string;
          issuedAt: string;
        }>({
          descriptor: this.activeRemoteDescriptor,
          method: 'POST',
          apiPath: '/auth/rotate-remote-token',
          bearerToken: this.activeToken,
          body: {},
        });
        if (
          typeof rotated.remoteToken !== 'string' ||
          !rotated.remoteToken.startsWith(`${CONNECT_REMOTE_TOKEN_PREFIX}${host.deviceId}.`)
        ) {
          throw new ConnectClientRequestError(
            'AUTH_FAILED',
            'Host trả về Remote token mới không hợp lệ.',
          );
        }
        const remRef = host.remoteCredentialRef ?? `client.host.${host.hostId}.remoteToken`;
        await this.secrets.setSecret(remRef, rotated.remoteToken);
        this.activeToken = rotated.remoteToken;
        this.destroyScopedAgents({ hostId: host.hostId, transport: 'remote-https' });
      } else {
        const rotated = await this.pinnedJsonRequest<{
          deviceId: string;
          deviceToken: string;
          rotatedAt: string;
        }>({
          hostId: host.hostId,
          address: host.lastAddress,
          port: host.port,
          pinnedFingerprint: host.pinnedFingerprint,
          method: 'POST',
          apiPath: '/auth/rotate-token',
          bearerToken: this.activeToken,
          body: {},
        });

        if (
          typeof rotated.deviceToken !== 'string' ||
          !rotated.deviceToken.startsWith(`${host.deviceId}.`)
        ) {
          throw new ConnectClientRequestError(
            'AUTH_FAILED',
            'Host trả về token mới không hợp lệ trong quá trình xoay vòng credential.',
          );
        }

        await this.secrets.setSecret(host.credentialRef, rotated.deviceToken);
        this.activeToken = rotated.deviceToken;
        this.destroyScopedAgents({ hostId: host.hostId, transport: 'lan-direct' });
      }

      this.recordSecurityEvent(
        'credential_rotated',
        'success',
        `Đã xoay vòng token xác thực an toàn với Host "${host.displayName}".`,
        200,
      );
      this.emitSnapshot();
      return this.getSnapshot();
    } catch (err) {
      if (this.activeHost) {
        this.destroyScopedAgents({ hostId: this.activeHost.hostId });
      }
      const code = mapNetworkErrorCode(err);
      this.lastErrorCode = code;
      this.lastError = err instanceof Error ? err.message : String(err);
      if (
        code === 'ACCESS_REVOKED' ||
        code === 'AUTH_FAILED' ||
        code === 'REMOTE_ACCESS_NOT_GRANTED'
      ) {
        this.status = 'error';
        this.activeToken = null;
        this.activeTransport = null;
        this.activeRemoteDescriptor = null;
        this.activeHost = null;
      }
      this.recordSecurityEvent('auth_failed', 'error', this.lastError);
      this.emitSnapshot();
      throw err;
    } finally {
      this.rotatingCredential = false;
    }
  }

  async listRemoteTracks(options?: {
    offset?: number;
    limit?: number;
    query?: string;
    albumKey?: string;
    artist?: string;
  }): Promise<RemoteLibraryPage<RemoteTrackDto>> {
    const params = new URLSearchParams({
      offset: String(clampConnectPageOffset(options?.offset)),
      limit: String(clampConnectPageLimit(options?.limit)),
    });
    if (options?.query) params.set('q', options.query.slice(0, 120));
    if (options?.albumKey) params.set('albumKey', options.albumKey.slice(0, 48));
    if (options?.artist) params.set('artist', options.artist.slice(0, 120));
    const page = await this.requestActiveHostWithRecovery<RemoteLibraryPage<RemoteTrackDto>>(
      `/library/tracks?${params.toString()}`,
    );
    if (this.activeHost) {
      for (const dto of page.items) {
        this.cacheRemoteTrackDto(this.activeHost.hostId, dto);
      }
    }
    return page;
  }

  async listRemoteAlbums(options?: {
    offset?: number;
    limit?: number;
    query?: string;
  }): Promise<RemoteLibraryPage<RemoteAlbumDto>> {
    const params = new URLSearchParams({
      offset: String(clampConnectPageOffset(options?.offset)),
      limit: String(clampConnectPageLimit(options?.limit)),
    });
    if (options?.query) params.set('q', options.query.slice(0, 120));
    return this.requestActiveHostWithRecovery<RemoteLibraryPage<RemoteAlbumDto>>(
      `/library/albums?${params.toString()}`,
    );
  }

  async listRemoteArtists(options?: {
    offset?: number;
    limit?: number;
    query?: string;
  }): Promise<RemoteLibraryPage<RemoteArtistDto>> {
    const params = new URLSearchParams({
      offset: String(clampConnectPageOffset(options?.offset)),
      limit: String(clampConnectPageLimit(options?.limit)),
    });
    if (options?.query) params.set('q', options.query.slice(0, 120));
    return this.requestActiveHostWithRecovery<RemoteLibraryPage<RemoteArtistDto>>(
      `/library/artists?${params.toString()}`,
    );
  }

  async getRemoteLyrics(hostId: string, trackId: string): Promise<ResolvedTrackLyrics> {
    const cleanHostId = hostId.toLowerCase();
    const cleanTrackId = trackId.toLowerCase();
    if (!this.activeHost || this.activeHost.hostId !== cleanHostId) {
      return {
        trackId,
        source: 'none',
        format: 'none',
        rawContent: '',
        timedLines: [],
        plainLines: [],
        hasCustomLyrics: false,
        sidecarPath: null,
      };
    }

    const cacheKey = `${cleanHostId}::${cleanTrackId}`;
    const currentRev = this.remoteTrackMetaCache.get(cacheKey)?.sourceRevision ?? null;
    const cached = this.remoteLyricsCache.get(cacheKey);
    if (cached && cached.sourceRevision === currentRev) {
      this.remoteLyricsCache.delete(cacheKey);
      this.remoteLyricsCache.set(cacheKey, cached);
      return cached.lyrics;
    }

    const pending = this.inflightLyrics.get(cacheKey);
    if (pending) {
      return pending;
    }

    const work = this.requestActiveHostWithRecovery<ResolvedTrackLyrics>(
      `/library/tracks/${cleanTrackId}/lyrics`,
    )
      .then((lyrics) => {
        if (this.activeHost?.hostId === cleanHostId) {
          if (this.remoteLyricsCache.has(cacheKey)) {
            this.remoteLyricsCache.delete(cacheKey);
          }
          while (this.remoteLyricsCache.size >= MAX_CLIENT_LYRICS_CACHE) {
            const oldest = this.remoteLyricsCache.keys().next().value;
            if (oldest === undefined) break;
            this.remoteLyricsCache.delete(oldest);
          }
          const latestRev = this.remoteTrackMetaCache.get(cacheKey)?.sourceRevision ?? currentRev;
          this.remoteLyricsCache.set(cacheKey, {
            sourceRevision: latestRev,
            lyrics,
          });
        }
        return lyrics;
      })
      .finally(() => {
        this.inflightLyrics.delete(cacheKey);
      });

    this.inflightLyrics.set(cacheKey, work);
    return work;
  }

  private async acquireArtworkSlot(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new ConnectClientRequestError('CONNECTION_FAILED', 'Artwork request aborted');
    }
    if (this.artworkInflight >= MAX_CONCURRENT_ARTWORK_REQUESTS) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          const idx = this.artworkWaiters.indexOf(grant);
          if (idx >= 0) this.artworkWaiters.splice(idx, 1);
          reject(new ConnectClientRequestError('CONNECTION_FAILED', 'Artwork request aborted'));
        };
        const grant = () => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.artworkWaiters.push(grant);
      });
    }
    this.artworkInflight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.artworkInflight = Math.max(0, this.artworkInflight - 1);
      const next = this.artworkWaiters.shift();
      if (next) {
        next();
      }
    };
  }

  private async getRemoteTrackMeta(
    host: StoredRememberedHost,
    token: string,
    trackId: string,
    signal?: AbortSignal,
  ): Promise<RemoteTrackDto | null> {
    const cleanTrackId = trackId.toLowerCase();
    const cacheKey = `${host.hostId}::${cleanTrackId}`;
    const cached = this.remoteTrackMetaCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const existing = this.inflightTrackMeta.get(cacheKey);
    if (existing) {
      return existing;
    }
    const work = (async (): Promise<RemoteTrackDto | null> => {
      try {
        const dto =
          this.activeTransport === 'remote-https' && this.activeRemoteDescriptor
            ? await this.publicHttpsJsonRequest<RemoteTrackDto>({
                descriptor: this.activeRemoteDescriptor,
                method: 'GET',
                apiPath: `/library/tracks/${cleanTrackId}`,
                bearerToken: token,
                signal,
              })
            : await this.pinnedJsonRequest<RemoteTrackDto>({
                hostId: host.hostId,
                address: host.lastAddress,
                port: host.port,
                pinnedFingerprint: host.pinnedFingerprint,
                method: 'GET',
                apiPath: `/library/tracks/${cleanTrackId}`,
                bearerToken: token,
                signal,
              });
        this.cacheRemoteTrackDto(host.hostId, dto);
        return dto;
      } catch {
        return null;
      } finally {
        this.inflightTrackMeta.delete(cacheKey);
      }
    })();
    this.inflightTrackMeta.set(cacheKey, work);
    return work;
  }

  private async openPinnedUpstreamWithRetry(params: {
    host: StoredRememberedHost;
    token: string;
    apiSubPath: string;
    method: string;
    rangeHeader?: string | null;
    correlationId: string;
    signal?: AbortSignal;
    disarmTimeoutAfterHeaders?: boolean;
  }): Promise<UpstreamOpenResult> {
    const reqHeaders: Record<string, string> = {
      Authorization: `Bearer ${params.token}`,
      'X-DoReMi-Correlation': params.correlationId,
    };
    if (params.rangeHeader) {
      reqHeaders.Range = params.rangeHeader;
    }

    const useRemoteHttps =
      this.activeTransport === 'remote-https' && this.activeRemoteDescriptor !== null;
    const remoteDesc = this.activeRemoteDescriptor;

    // Register abort handle so transport handover / disconnect / revocation deterministically cancels active upstream sockets
    const streamAbort = new AbortController();
    this.activeStreamAborts.add(streamAbort);
    const onCallerAbort = () => streamAbort.abort();
    params.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const cleanupAbortTracking = () => {
      this.activeStreamAborts.delete(streamAbort);
      params.signal?.removeEventListener('abort', onCallerAbort);
    };

    const maxRetries = STREAM_TRANSIENT_RETRY_DELAYS_MS.length;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let upstream: http.IncomingMessage;
      try {
        upstream =
          useRemoteHttps && remoteDesc
            ? await this.openVerifiedPublicHttpsRequest({
                descriptor: remoteDesc,
                method: params.method,
                apiPath: params.apiSubPath,
                headers: reqHeaders,
                signal: streamAbort.signal,
                disarmTimeoutAfterHeaders: params.disarmTimeoutAfterHeaders,
              })
            : await this.openPinnedHttpsRequest({
                hostId: params.host.hostId,
                address: params.host.lastAddress,
                port: params.host.port,
                pinnedFingerprint: params.host.pinnedFingerprint,
                method: params.method,
                apiPath: params.apiSubPath,
                headers: reqHeaders,
                signal: streamAbort.signal,
                disarmTimeoutAfterHeaders: params.disarmTimeoutAfterHeaders,
              });
      } catch (err) {
        cleanupAbortTracking();
        throw err;
      }

      upstream.once('close', cleanupAbortTracking);
      upstream.once('end', cleanupAbortTracking);
      upstream.once('error', cleanupAbortTracking);

      const status = upstream.statusCode ?? 502;
      if (status < 400) {
        this.smartManager.recordTransportSuccess(useRemoteHttps ? 'remote-https' : 'lan-direct');
        return { upstream, status, errorBodyText: null, errorApiCode: null };
      }

      const bodyText = await readStreamTextLimited(upstream, 16 * 1024);
      let apiCode: string | null = null;
      try {
        const parsed = bodyText ? (JSON.parse(bodyText) as { code?: unknown }) : null;
        if (parsed && typeof parsed.code === 'string') {
          apiCode = parsed.code;
        }
      } catch {
        // non-JSON error body
      }
      upstream.destroy();

      if (status === 401 || status === 403) {
        if (apiCode === 'ACCESS_REVOKED' || bodyText.includes('ACCESS_REVOKED')) {
          this.handleTerminalConnectionError(
            'ACCESS_REVOKED',
            'Quyền truy cập của thiết bị đã bị thu hồi trên Host.',
          );
        } else if (apiCode === 'REMOTE_ACCESS_NOT_GRANTED') {
          this.handleTerminalConnectionError(
            'REMOTE_ACCESS_NOT_GRANTED',
            'Quyền truy cập từ xa (Remote HTTPS) của thiết bị đã bị tắt trên Host.',
          );
        } else if (status === 401) {
          this.handleTerminalConnectionError(
            'AUTH_FAILED',
            'Xác thực thiết bị thất bại trên Host.',
          );
        }
        return { upstream, status, errorBodyText: bodyText, errorApiCode: apiCode };
      }

      const isTransientConcurrency =
        (status === 429 && apiCode !== 'CLIENT_LIMIT_REACHED') || status === 503;

      if (isTransientConcurrency && attempt < maxRetries && !params.signal?.aborted) {
        await delayAbortable(STREAM_TRANSIENT_RETRY_DELAYS_MS[attempt], params.signal);
        continue;
      }

      return { upstream, status, errorBodyText: bodyText, errorApiCode: apiCode };
    }

    throw new ConnectClientRequestError('CONNECTION_FAILED', 'Remote Host request retry exhausted.');
  }

  private async fetchRemoteByteRange(params: {
    host: StoredRememberedHost;
    token: string;
    trackId: string;
    start: number;
    end: number;
    kind: ClientStreamTraceEntry['kind'];
    signal?: AbortSignal;
  }): Promise<{ status: number; totalSize: number | null; buffer: Buffer }> {
    const startedAtMs = Date.now();
    const correlationId = this.nextCorrelationId();
    const rangeHeader = `bytes=${params.start}-${params.end}`;
    const opened = await this.openPinnedUpstreamWithRetry({
      host: params.host,
      token: params.token,
      apiSubPath: `/stream/${params.trackId}`,
      method: 'GET',
      rangeHeader,
      correlationId,
      signal: params.signal,
      disarmTimeoutAfterHeaders: false,
    });

    if (opened.status >= 400) {
      const mappedErr = classifyRemoteHttpFailure(opened.status, opened.errorApiCode);
      this.recordStreamTrace({
        timestamp: new Date(startedAtMs).toISOString(),
        correlationId,
        hostId: params.host.hostId,
        trackId: params.trackId,
        kind: params.kind,
        method: 'GET',
        rangeHeader,
        statusCode: opened.status,
        contentType: null,
        errorCode: mappedErr,
        detail: opened.errorBodyText ?? `HTTP ${opened.status}`,
        bytesDelivered: 0,
        durationMs: Date.now() - startedAtMs,
      });
      throw new RemoteHttpStatusError(opened.status, mappedErr, opened.errorBodyText ?? `HTTP ${opened.status}`);
    }

    const contentType =
      typeof opened.upstream.headers['content-type'] === 'string'
        ? opened.upstream.headers['content-type']
        : undefined;
    if (!isAudioOrMediaContentType(contentType)) {
      opened.upstream.destroy();
      this.recordStreamTrace({
        timestamp: new Date(startedAtMs).toISOString(),
        correlationId,
        hostId: params.host.hostId,
        trackId: params.trackId,
        kind: params.kind,
        method: 'GET',
        rangeHeader,
        statusCode: opened.status,
        contentType: contentType ?? null,
        errorCode: 'ERR_REMOTE_RESPONSE_INVALID',
        detail: `Unexpected non-audio Content-Type: ${contentType ?? 'missing'}`,
        bytesDelivered: 0,
        durationMs: Date.now() - startedAtMs,
      });
      throw new RemoteHttpStatusError(
        502,
        'ERR_REMOTE_RESPONSE_INVALID',
        `Unexpected remote Content-Type: ${contentType ?? 'missing'}`,
      );
    }

    const totalFromRange = parseTotalSizeFromContentRange(
      typeof opened.upstream.headers['content-range'] === 'string'
        ? opened.upstream.headers['content-range']
        : undefined,
    );
    const totalFromLength =
      opened.status === 200 && typeof opened.upstream.headers['content-length'] === 'string'
        ? Number(opened.upstream.headers['content-length'])
        : null;
    const buffer = await readUpstreamBinary(opened.upstream, params.signal);

    this.recordStreamTrace({
      timestamp: new Date(startedAtMs).toISOString(),
      correlationId,
      hostId: params.host.hostId,
      trackId: params.trackId,
      kind: params.kind,
      method: 'GET',
      rangeHeader,
      statusCode: opened.status,
      contentType: contentType ?? null,
      errorCode: null,
      detail: null,
      bytesDelivered: buffer.length,
      durationMs: Date.now() - startedAtMs,
    });

    return {
      status: opened.status,
      totalSize:
        totalFromRange ??
        (totalFromLength !== null && Number.isSafeInteger(totalFromLength) ? totalFromLength : null),
      buffer,
    };
  }

  /**
   * Restricted internal media source adapter for `lossless-media://remote-track/<hostId>/<trackId>`.
   * Never proxies arbitrary URLs; requires an actively connected, TLS-pinned Host matching `hostId`.
   */
  async resolveRemoteTrackMediaResponse(request: Request): Promise<Response> {
    const originHeader = request.headers.get('origin');
    if (!isAllowedMediaCorsOrigin(originHeader)) {
      return new Response('Forbidden: Disallowed CORS origin.', { status: 403 });
    }
    const corsHeaders = buildMediaCorsHeaders(originHeader);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
    }

    const parsed = parseRemoteTrackMediaUrl(request.url);
    if (!parsed) {
      return new Response('Forbidden: Invalid remote track URL.', {
        status: 403,
        headers: corsHeaders,
      });
    }

    const host = this.activeHost;
    const token = this.activeToken;
    if (!host || !token || host.hostId !== parsed.hostId) {
      return new Response('Forbidden: Target remote Host is not connected.', {
        status: 403,
        headers: corsHeaders,
      });
    }

    const meta = await this.getRemoteTrackMeta(host, token, parsed.trackId, request.signal);
    const containerLower = meta?.container?.toLowerCase() ?? '';
    const codecLower = meta?.codec?.toLowerCase() ?? '';

    // 1. Range-backed Remote ALAC WASM decoding (streams seekable audio/wav without full-file download)
    const mayBeAlacOrMp4 =
      codecLower === 'alac' || containerLower === 'm4a' || containerLower === 'mp4';
    if (mayBeAlacOrMp4) {
      const correlationId = this.nextCorrelationId();
      const startedAtMs = Date.now();
      try {
        const rangeFetcher = (start: number, end: number, signal?: AbortSignal) =>
          this.fetchRemoteByteRange({
            host,
            token,
            trackId: parsed.trackId,
            start,
            end,
            kind: 'alac-probe',
            signal,
          });
        const alacCacheKey = `${host.hostId}::${parsed.trackId}::${meta?.sourceRevision ?? meta?.fileSizeBytes ?? 0}`;
        const entry = await this.remoteAlac.resolveEntry(
          alacCacheKey,
          rangeFetcher,
          request.signal,
        );
        if (entry.codec === 'alac') {
          return await this.remoteAlac.createWavMediaResponse({
            entry,
            method: request.method,
            rangeHeader: request.headers.get('range'),
            corsHeaders,
            fetcher: (start, end, sig) =>
              this.fetchRemoteByteRange({
                host,
                token,
                trackId: parsed.trackId,
                start,
                end,
                kind: 'alac-decode',
                signal: sig,
              }),
            signal: request.signal,
            onCompleted: (bytesDelivered, errorCode) => {
              const isBenignCancel = errorCode === 'CANCELLED' || errorCode === 'ABORTED';
              const recordedError = isBenignCancel ? null : errorCode;
              this.recordStreamTrace({
                timestamp: new Date(startedAtMs).toISOString(),
                correlationId,
                hostId: host.hostId,
                trackId: parsed.trackId,
                kind: 'alac-decode',
                method: request.method,
                rangeHeader: request.headers.get('range'),
                statusCode: recordedError ? 500 : request.headers.get('range') ? 206 : 200,
                contentType: 'audio/wav',
                errorCode: recordedError,
                detail: recordedError ? 'Remote ALAC WAV stream terminated early' : null,
                bytesDelivered,
                durationMs: Date.now() - startedAtMs,
              });
            },
          });
        }
      } catch (err) {
        if (err instanceof RemoteHttpStatusError) {
          return new Response(JSON.stringify({ code: err.errorCode, message: err.message }), {
            status: err.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        const netCode = mapNetworkErrorCode(err);
        this.recordStreamTrace({
          timestamp: new Date(startedAtMs).toISOString(),
          correlationId,
          hostId: host.hostId,
          trackId: parsed.trackId,
          kind: 'alac-probe',
          method: request.method,
          rangeHeader: request.headers.get('range'),
          statusCode: null,
          contentType: null,
          errorCode: netCode,
          detail: err instanceof Error ? err.message : String(err),
          bytesDelivered: 0,
          durationMs: Date.now() - startedAtMs,
        });
        return new Response(
          JSON.stringify({ code: netCode, message: err instanceof Error ? err.message : 'Remote ALAC probe failed' }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    }

    // 2. Remote FLAC compatibility: strip prepended ID3v2 / malformed PICTURE blocks virtually when needed
    const isFlac = codecLower === 'flac' || containerLower === 'flac';
    if (isFlac && meta?.fileSizeBytes && meta.fileSizeBytes >= 42) {
      const flacResult = await this.tryServeNormalizedRemoteFlac({
        host,
        token,
        trackId: parsed.trackId,
        fileSizeBytes: meta.fileSizeBytes,
        sourceRevision: meta.sourceRevision ?? null,
        request,
        corsHeaders,
      });
      if (flacResult) {
        return flacResult;
      }
    }

    // 3. Direct authenticated TLS-pinned Range proxy (WAV, clean FLAC, AAC, MP3, OGG, OPUS)
    return this.proxyPinnedHostStream({
      host,
      token,
      apiSubPath: `/stream/${parsed.trackId}`,
      trackId: parsed.trackId,
      kind: 'stream',
      request,
      corsHeaders,
    });
  }

  private async tryServeNormalizedRemoteFlac(params: {
    host: StoredRememberedHost;
    token: string;
    trackId: string;
    fileSizeBytes: number;
    sourceRevision?: string | null;
    request: Request;
    corsHeaders: Record<string, string>;
  }): Promise<Response | null> {
    const { host, token, trackId, fileSizeBytes, sourceRevision, request, corsHeaders } = params;
    const cacheKey = `remote::${host.hostId}::${trackId}::${sourceRevision ?? fileSizeBytes}`;
    try {
      const plan: FlacStreamPlan = await resolveFlacStreamPlanFromSource(cacheKey, {
        fileSize: fileSizeBytes,
        readAt: async (offset, length) => {
          const end = Math.min(fileSizeBytes - 1, offset + length - 1);
          if (end < offset) return Buffer.alloc(0);
          const fetched = await this.fetchRemoteByteRange({
            host,
            token,
            trackId,
            start: offset,
            end,
            kind: 'flac-sanitize',
            signal: request.signal,
          });
          return fetched.buffer;
        },
      });

      if (!plan.normalized) {
        return null; // Healthy FLAC -> stream directly untouched
      }

      const rangeResult = parseByteRangeHeader(request.headers.get('range'), plan.virtualFileSize);
      if (!rangeResult.ok) {
        return new Response(null, {
          status: 416,
          headers: {
            ...corsHeaders,
            'Content-Range': `bytes */${plan.virtualFileSize}`,
            'Accept-Ranges': 'bytes',
          },
        });
      }

      const { start, end, isPartial } = rangeResult;
      const contentLength = end - start + 1;
      const outHeaders: Record<string, string> = {
        ...corsHeaders,
        'Content-Type': 'audio/flac',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(contentLength),
        'Cache-Control': 'no-store',
        'X-DoReMi-Transfer-Mode': 'remote-flac-normalized',
      };
      if (isPartial) {
        outHeaders['Content-Range'] = `bytes ${start}-${end}/${plan.virtualFileSize}`;
      }

      if (request.method === 'HEAD') {
        return new Response(null, { status: isPartial ? 206 : 200, headers: outHeaders });
      }

      const headerLen = plan.headerBuffer.length;
      if (end < headerLen) {
        const slice = Uint8Array.from(plan.headerBuffer.subarray(start, end + 1));
        return new Response(slice, { status: isPartial ? 206 : 200, headers: outHeaders });
      }

      const headerSlice =
        start < headerLen ? Uint8Array.from(plan.headerBuffer.subarray(start, headerLen)) : null;
      const diskStart = start >= headerLen ? plan.diskAudioOffset + (start - headerLen) : plan.diskAudioOffset;
      const diskEnd = plan.diskAudioOffset + (end - headerLen);
      const correlationId = this.nextCorrelationId();
      const startedAtMs = Date.now();

      const opened = await this.openPinnedUpstreamWithRetry({
        host,
        token,
        apiSubPath: `/stream/${trackId}`,
        method: 'GET',
        rangeHeader: `bytes=${diskStart}-${diskEnd}`,
        correlationId,
        signal: request.signal,
        disarmTimeoutAfterHeaders: true,
      });

      if (opened.status >= 400) {
        const mapped = classifyRemoteHttpFailure(opened.status, opened.errorApiCode);
        return new Response(
          JSON.stringify({ code: mapped, message: opened.errorBodyText ?? `HTTP ${opened.status}` }),
          { status: opened.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const body = createUpstreamWebStream({
        upstream: opened.upstream,
        prefixChunk: headerSlice,
        signal: request.signal,
        onComplete: (bytesDelivered, streamErr) => {
          this.recordStreamTrace({
            timestamp: new Date(startedAtMs).toISOString(),
            correlationId,
            hostId: host.hostId,
            trackId,
            kind: 'flac-sanitize',
            method: request.method,
            rangeHeader: request.headers.get('range'),
            statusCode: isPartial ? 206 : 200,
            contentType: 'audio/flac',
            errorCode: streamErr,
            detail: streamErr,
            bytesDelivered,
            durationMs: Date.now() - startedAtMs,
          });
        },
      });

      return new Response(body, { status: isPartial ? 206 : 200, headers: outHeaders });
    } catch {
      return null;
    }
  }

  /**
   * Restricted internal media adapter for `lossless-media://remote-artwork/<hostId>/<trackId>`.
   * Uses a bounded concurrency queue (`<= 4` in-flight) so scrolling large libraries never starves audio streams.
   */
  async resolveRemoteArtworkMediaResponse(request: Request): Promise<Response> {
    const originHeader = request.headers.get('origin');
    if (!isAllowedMediaCorsOrigin(originHeader)) {
      return new Response('Forbidden: Disallowed CORS origin.', { status: 403 });
    }
    const corsHeaders = buildMediaCorsHeaders(originHeader);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
    }

    const parsed = parseRemoteArtworkMediaUrl(request.url);
    if (!parsed) {
      return new Response('Forbidden: Invalid remote artwork URL.', {
        status: 403,
        headers: corsHeaders,
      });
    }

    if (!this.activeHost || !this.activeToken || this.activeHost.hostId !== parsed.hostId) {
      return new Response('Forbidden: Target remote Host is not connected.', {
        status: 403,
        headers: corsHeaders,
      });
    }

    let release: (() => void) | null = null;
    try {
      release = await this.acquireArtworkSlot(request.signal);
      if (!this.activeHost || !this.activeToken || this.activeHost.hostId !== parsed.hostId) {
        return new Response('Forbidden: Target remote Host is not connected.', {
          status: 403,
          headers: corsHeaders,
        });
      }
      return await this.proxyPinnedHostStream({
        host: this.activeHost,
        token: this.activeToken,
        apiSubPath: `/library/tracks/${parsed.trackId}/artwork?size=${parsed.size}`,
        trackId: parsed.trackId,
        kind: 'artwork',
        request,
        corsHeaders,
      });
    } catch {
      return new Response('Artwork request aborted.', { status: 499, headers: corsHeaders });
    } finally {
      release?.();
    }
  }

  private async proxyPinnedHostStream(params: {
    host: StoredRememberedHost;
    token: string;
    apiSubPath: string;
    trackId: string;
    kind: ClientStreamTraceEntry['kind'];
    request: Request;
    corsHeaders: Record<string, string>;
  }): Promise<Response> {
    const { host, token, apiSubPath, trackId, kind, request, corsHeaders } = params;
    const range = request.headers.get('range');
    const startedAtMs = Date.now();
    const correlationId = this.nextCorrelationId();

    try {
      const opened = await this.openPinnedUpstreamWithRetry({
        host,
        token,
        apiSubPath,
        method: request.method,
        rangeHeader: range,
        correlationId,
        signal: request.signal,
        disarmTimeoutAfterHeaders: kind === 'stream',
      });

      const { upstream, status, errorBodyText, errorApiCode } = opened;
      const upstreamContentType =
        typeof upstream.headers['content-type'] === 'string'
          ? upstream.headers['content-type']
          : undefined;

      if (status >= 400) {
        const mappedError = classifyRemoteHttpFailure(status, errorApiCode);
        this.recordStreamTrace({
          timestamp: new Date(startedAtMs).toISOString(),
          correlationId,
          hostId: host.hostId,
          trackId,
          kind,
          method: request.method,
          rangeHeader: range,
          statusCode: status,
          contentType: upstreamContentType ?? null,
          errorCode: mappedError,
          detail: errorBodyText ?? `HTTP ${status}`,
          bytesDelivered: 0,
          durationMs: Date.now() - startedAtMs,
        });
        return new Response(
          errorBodyText || JSON.stringify({ code: errorApiCode || mappedError, message: `HTTP ${status}` }),
          {
            status,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        );
      }

      if (kind === 'stream' && !isAudioOrMediaContentType(upstreamContentType)) {
        upstream.destroy();
        this.recordStreamTrace({
          timestamp: new Date(startedAtMs).toISOString(),
          correlationId,
          hostId: host.hostId,
          trackId,
          kind,
          method: request.method,
          rangeHeader: range,
          statusCode: status,
          contentType: upstreamContentType ?? null,
          errorCode: 'ERR_REMOTE_RESPONSE_INVALID',
          detail: `Blocked non-audio Content-Type on stream: ${upstreamContentType ?? 'missing'}`,
          bytesDelivered: 0,
          durationMs: Date.now() - startedAtMs,
        });
        return new Response(
          JSON.stringify({
            code: 'ERR_REMOTE_RESPONSE_INVALID',
            message: `Invalid upstream Content-Type for audio stream: ${upstreamContentType ?? 'missing'}`,
          }),
          {
            status: 502,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        );
      }

      const outHeaders = new Headers(corsHeaders);
      for (const hName of [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'cache-control',
        'etag',
        'x-doremi-source-revision',
        'x-doremi-transfer-mode',
      ]) {
        const val = upstream.headers[hName];
        if (typeof val === 'string') {
          outHeaders.set(hName, val);
        }
      }
      outHeaders.set('X-DoReMi-Correlation', correlationId);

      if (request.method === 'HEAD') {
        upstream.resume();
        this.recordStreamTrace({
          timestamp: new Date(startedAtMs).toISOString(),
          correlationId,
          hostId: host.hostId,
          trackId,
          kind,
          method: 'HEAD',
          rangeHeader: range,
          statusCode: status,
          contentType: upstreamContentType ?? null,
          errorCode: null,
          detail: null,
          bytesDelivered: 0,
          durationMs: Date.now() - startedAtMs,
        });
        return new Response(null, { status, headers: outHeaders });
      }

      const webBody = createUpstreamWebStream({
        upstream,
        signal: request.signal,
        onComplete: (bytesDelivered, streamErrCode) => {
          this.recordStreamTrace({
            timestamp: new Date(startedAtMs).toISOString(),
            correlationId,
            hostId: host.hostId,
            trackId,
            kind,
            method: request.method,
            rangeHeader: range,
            statusCode: status,
            contentType: upstreamContentType ?? null,
            errorCode: streamErrCode,
            detail: streamErrCode ? 'Upstream stream interrupted before completion' : null,
            bytesDelivered,
            durationMs: Date.now() - startedAtMs,
          });
        },
      });

      return new Response(webBody, { status, headers: outHeaders });
    } catch (err) {
      const code = mapNetworkErrorCode(err);
      if (code === 'HOST_IDENTITY_MISMATCH') {
        this.destroyScopedAgents({ hostId: host.hostId });
      }
      const isTimeout =
        (err instanceof Error && err.message.toLowerCase().includes('timed out')) ||
        (err as { code?: string } | null)?.code === 'ETIMEDOUT';
      const traceErrCode =
        code === 'HOST_IDENTITY_MISMATCH'
          ? 'HOST_IDENTITY_MISMATCH'
          : isTimeout
            ? 'ERR_REMOTE_NETWORK_TIMEOUT'
            : 'ERR_REMOTE_STREAM_INTERRUPTED';

      this.recordStreamTrace({
        timestamp: new Date(startedAtMs).toISOString(),
        correlationId,
        hostId: host.hostId,
        trackId,
        kind,
        method: request.method,
        rangeHeader: range,
        statusCode: null,
        contentType: null,
        errorCode: traceErrCode,
        detail: err instanceof Error ? err.message : String(err),
        bytesDelivered: 0,
        durationMs: Date.now() - startedAtMs,
      });

      if (code === 'HOST_IDENTITY_MISMATCH') {
        this.handleTerminalConnectionError(
          'HOST_IDENTITY_MISMATCH',
          'Chứng chỉ Host không khớp với vân tay đã ghim.',
        );
        return new Response('Forbidden: Host identity mismatch.', {
          status: 403,
          headers: corsHeaders,
        });
      }
      return new Response(
        JSON.stringify({
          code: traceErrCode,
          message: err instanceof Error ? err.message : 'Remote Host stream failed.',
        }),
        {
          status: isTimeout ? 504 : 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
        },
      );
    }
  }

  private async requestActiveHostWithRecovery<T>(apiPath: string): Promise<T> {
    if (!this.activeHost || !this.activeToken) {
      throw new ConnectClientRequestError(
        'HOST_UNAVAILABLE',
        'Chưa kết nối tới máy Host nào.',
      );
    }

    const host = this.activeHost;
    const token = this.activeToken;
    const useRemoteHttps =
      this.activeTransport === 'remote-https' && this.activeRemoteDescriptor !== null;
    const remoteDesc = this.activeRemoteDescriptor;

    const usedTransport: ConnectTransportMode = useRemoteHttps ? 'remote-https' : 'lan-direct';
    let attempt = 0;
    while (true) {
      try {
        const result =
          useRemoteHttps && remoteDesc
            ? await this.publicHttpsJsonRequest<T>({
                descriptor: remoteDesc,
                method: 'GET',
                apiPath,
                bearerToken: token,
              })
            : await this.pinnedJsonRequest<T>({
                hostId: host.hostId,
                address: host.lastAddress,
                port: host.port,
                pinnedFingerprint: host.pinnedFingerprint,
                method: 'GET',
                apiPath,
                bearerToken: token,
              });
        this.smartManager.recordTransportSuccess(usedTransport);
        if (this.status !== 'connected') {
          this.status = 'connected';
          this.reconnectAttempt = 0;
          this.lastError = null;
          this.lastErrorCode = null;
          this.emitSnapshot();
        }
        return result;
      } catch (err) {
        const code = mapNetworkErrorCode(err);
        if (!isRetryableErrorCode(code) || attempt >= MAX_RECOVERY_ATTEMPTS) {
          const errMsg = err instanceof Error ? err.message : String(err);
          void this.smartManager.reportTransportFailure({
            hostId: host.hostId,
            transport: usedTransport,
            errorCode: code,
            message: errMsg,
            immediate: true,
          });
          throw err;
        }
        attempt += 1;
        this.status = 'reconnecting';
        this.reconnectAttempt = attempt;
        this.lastErrorCode = code;
        this.lastError = `Mất kết nối tạm thời, đang thử khôi phục (${attempt}/${MAX_RECOVERY_ATTEMPTS})...`;
        this.emitSnapshot();
        const backoffMs = 400 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, backoffMs));
        if (!this.activeHost || this.activeHost.hostId !== host.hostId) {
          throw new ConnectClientRequestError('CONNECTION_FAILED', 'Đã ngắt kết nối.');
        }
      }
    }
  }

  private handleTerminalConnectionError(code: ConnectErrorCode, message: string): void {
    const hostId = this.activeHost?.hostId ?? this.smartManager.getIntendedHostId();
    const transport: ConnectTransportMode = this.activeTransport ?? 'lan-direct';
    if (hostId) {
      void this.smartManager.reportTransportFailure({
        hostId,
        transport,
        errorCode: code,
        message,
        immediate: true,
      });
      return;
    }
    this.status = 'error';
    this.lastErrorCode = code;
    this.lastError = message;
    this.emitSnapshot();
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

  private inspectTlsPeerFingerprint(
    address: string,
    port: number,
  ): Promise<{ fingerprintSha256: string; shortFingerprint: string }> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: address,
        port,
        rejectUnauthorized: false, // Strictly used ONLY to read leaf certificate SPKI during explicit probe before pinning
        timeout: CLIENT_REQUEST_TIMEOUT_MS,
      });

      const cleanup = () => {
        socket.removeAllListeners();
        socket.destroy();
      };

      socket.once('secureConnect', () => {
        const fp = getPeerCertSpkiSha256(socket);
        cleanup();
        if (!fp) {
          reject(new ConnectClientRequestError('CONNECTION_FAILED', 'Host did not present a TLS certificate.'));
          return;
        }
        resolve(fp);
      });

      socket.once('timeout', () => {
        cleanup();
        reject(new ConnectClientRequestError('HOST_UNAVAILABLE', 'TLS probe timed out.'));
      });

      socket.once('error', (err) => {
        cleanup();
        reject(err);
      });
    });
  }

  private openPinnedHttpsRequest(params: {
    hostId?: string;
    address: string;
    port: number;
    pinnedFingerprint: string;
    method: string;
    apiPath: string;
    headers?: Record<string, string>;
    bodyBuffer?: Buffer;
    signal?: AbortSignal;
    disarmTimeoutAfterHeaders?: boolean;
  }): Promise<http.IncomingMessage> {
    const normalizedPinned = normalizeFullFingerprint(params.pinnedFingerprint);
    if (!normalizedPinned) {
      return Promise.reject(
        new ConnectClientRequestError(
          'HOST_IDENTITY_MISMATCH',
          'Pinned Host TLS certificate fingerprint is invalid.',
        ),
      );
    }
    const expectedPinnedNorm: string = normalizedPinned;
    const scopedAgent = params.hostId
      ? this.getScopedLanAgent(params.hostId, params.address, params.port, expectedPinnedNorm)
      : false;

    return new Promise((resolve, reject) => {
      let settled = false;
      const doneReject = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const req = https.request(
        {
          host: params.address,
          port: params.port,
          path: `${CONNECT_API_PREFIX}${params.apiPath}`,
          method: params.method,
          headers: params.headers,
          rejectUnauthorized: false, // Verification is strictly enforced via pinned SPKI SHA-256 on fresh & reused sockets before any bytes are sent
          agent: scopedAgent,
          timeout: CLIENT_REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode >= 300 && statusCode < 400) {
            res.resume();
            req.destroy();
            doneReject(
              new ConnectClientRequestError(
                'CONNECTION_FAILED',
                'Unexpected HTTP redirect rejected by DoReMi TLS pinning security policy.',
              ),
            );
            return;
          }
          if (params.disarmTimeoutAfterHeaders) {
            // Once headers arrive cleanly, long-running/paused audio streams must not be aborted
            // by an idle socket timeout when Chromium holds backpressure during user pause.
            req.removeAllListeners('timeout');
            req.setTimeout(0);
          }
          if (settled) return;
          settled = true;
          resolve(res);
        },
      );

      let payloadFlushed = false;
      const verifyAndSend = (tlsSock: tls.TLSSocket) => {
        if (payloadFlushed || req.destroyed) return;
        const observed = getPeerCertSpkiSha256(tlsSock);
        const observedNorm = observed
          ? normalizeFullFingerprint(observed.fingerprintSha256)
          : null;
        if (!observedNorm || observedNorm !== expectedPinnedNorm) {
          const err = new ConnectClientRequestError(
            'HOST_IDENTITY_MISMATCH',
            'Host TLS certificate fingerprint does not match the pinned Host identity.',
          );
          this.recordSecurityEvent(
            'identity_mismatch',
            'blocked',
            `Phát hiện chứng chỉ TLS không khớp vân tay đã ghim tại ${params.address}:${params.port}. Đã ngắt trước khi gửi dữ liệu.`,
          );
          req.destroy(err);
          doneReject(err);
          return;
        }
        payloadFlushed = true;
        if (params.bodyBuffer) {
          req.write(params.bodyBuffer);
        }
        req.end();
      };

      req.on('socket', (socket) => {
        const tlsSock = socket as tls.TLSSocket;
        if (!tlsSock.connecting && tlsSock.getPeerCertificate?.(true)?.raw) {
          // Reused keep-alive TLS socket: re-verify SPKI pin on microtask before flushing request
          queueMicrotask(() => verifyAndSend(tlsSock));
        } else {
          tlsSock.once('secureConnect', () => verifyAndSend(tlsSock));
        }
      });

      if (params.signal) {
        if (params.signal.aborted) {
          req.destroy(new Error('Aborted'));
          doneReject(new Error('Request aborted'));
          return;
        }
        const onAbort = () => {
          req.destroy(new Error('Aborted'));
        };
        params.signal.addEventListener('abort', onAbort, { once: true });
        req.once('close', () => {
          params.signal?.removeEventListener('abort', onAbort);
        });
      }

      req.once('timeout', () => {
        const err = new ConnectClientRequestError('NETWORK_INTERRUPTED', 'Request timed out.');
        req.destroy(err);
        doneReject(err);
      });

      req.once('error', (err) => {
        doneReject(err);
      });
    });
  }

  private async pinnedJsonRequest<T>(params: {
    hostId?: string;
    address: string;
    port: number;
    pinnedFingerprint: string;
    method: 'GET' | 'POST';
    apiPath: string;
    bearerToken?: string;
    body?: unknown;
    signal?: AbortSignal;
  }): Promise<T> {
    const bodyBuffer =
      params.body !== undefined ? Buffer.from(JSON.stringify(params.body), 'utf8') : undefined;
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (params.bearerToken) {
      headers.Authorization = `Bearer ${params.bearerToken}`;
    }
    if (bodyBuffer) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = String(bodyBuffer.length);
    }

    const res = await this.openPinnedHttpsRequest({
      hostId: params.hostId,
      address: params.address,
      port: params.port,
      pinnedFingerprint: params.pinnedFingerprint,
      method: params.method,
      apiPath: params.apiPath,
      headers,
      bodyBuffer,
      signal: params.signal,
    });

    const text = await readStreamText(res);
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = null;
    }

    const status = res.statusCode ?? 500;
    if (status >= 400) {
      const apiCode = typeof parsed?.code === 'string' ? parsed.code : '';
      const apiMsg =
        typeof parsed?.message === 'string' ? parsed.message : `HTTP ${status}`;
      let mappedCode: ConnectErrorCode = 'CONNECTION_FAILED';
      if (apiCode === 'ACCESS_REVOKED') mappedCode = 'ACCESS_REVOKED';
      else if (apiCode === 'REMOTE_ACCESS_NOT_GRANTED') mappedCode = 'REMOTE_ACCESS_NOT_GRANTED';
      else if (apiCode === 'HOST_IDENTITY_MISMATCH') mappedCode = 'HOST_IDENTITY_MISMATCH';
      else if (status === 401 || apiCode === 'AUTH_FAILED') mappedCode = 'AUTH_FAILED';
      else if (status === 429 || apiCode === 'RATE_LIMITED') mappedCode = 'RATE_LIMITED';
      else if (status === 502 || status === 503 || status === 504 || apiCode === 'REMOTE_ACCESS_UNAVAILABLE') {
        mappedCode = 'HOST_UNAVAILABLE';
      } else if (apiCode === 'ENROLLMENT_EXPIRED') mappedCode = 'ENROLLMENT_EXPIRED';
      else if (apiCode === 'ENROLLMENT_REJECTED') mappedCode = 'ENROLLMENT_REJECTED';
      throw new ConnectClientRequestError(mappedCode, apiMsg, status);
    }

    return (parsed ?? {}) as T;
  }

  /**
   * Executes a standard Public CA-validated HTTPS request (`rejectUnauthorized: true`,
   * strict hostname & `.ts.net` origin validation, zero redirect following) to a verified Remote Endpoint.
   */
  private openVerifiedPublicHttpsRequest(params: {
    descriptor: RemoteEndpointDescriptorV1;
    method: string;
    apiPath: string;
    headers?: Record<string, string>;
    bodyBuffer?: Buffer;
    signal?: AbortSignal;
    disarmTimeoutAfterHeaders?: boolean;
    poolSockets?: boolean;
  }): Promise<http.IncomingMessage> {
    const originCheck = validateRemoteHttpsOrigin(
      params.descriptor.publicOrigin,
      params.descriptor.providerId,
    );
    if (!originCheck.ok) {
      return Promise.reject(
        new ConnectClientRequestError('CONNECTION_FAILED', originCheck.message),
      );
    }
    if (!params.apiPath.startsWith('/') || params.apiPath.includes('..') || params.apiPath.includes('\\')) {
      return Promise.reject(
        new ConnectClientRequestError('CONNECTION_FAILED', 'Invalid Remote API path.'),
      );
    }

    const connectPort = this.publicHttpsOptions?.connectOverridePort ?? originCheck.port;
    const hostHeader =
      originCheck.port === 443
        ? originCheck.hostname
        : `${originCheck.hostname}:${originCheck.port}`;
    const scopedAgent =
      params.poolSockets === false
        ? false
        : this.getScopedRemoteAgent(params.descriptor, originCheck.canonicalOrigin);

    return new Promise((resolve, reject) => {
      let settled = false;
      const doneReject = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const req = https.request(
        {
          host: originCheck.hostname,
          port: connectPort,
          servername: originCheck.hostname,
          path: `${params.descriptor.apiBasePath}${params.apiPath}`,
          method: params.method,
          headers: {
            Host: hostHeader,
            ...(params.headers ?? {}),
          },
          // Public HTTPS MUST NEVER disable standard certificate or hostname verification!
          rejectUnauthorized: true,
          ...(this.publicHttpsOptions?.ca ? { ca: this.publicHttpsOptions.ca } : {}),
          ...(this.publicHttpsOptions?.lookup ? { lookup: this.publicHttpsOptions.lookup } : {}),
          agent: scopedAgent,
          timeout: REMOTE_HTTPS_REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const statusCode = res.statusCode ?? 0;
          // Strictly forbid HTTP 3xx redirects so credentials can never be forwarded to another origin
          if (statusCode >= 300 && statusCode < 400) {
            res.resume();
            req.destroy();
            doneReject(
              new ConnectClientRequestError(
                'CONNECTION_FAILED',
                'Unexpected HTTP redirect rejected on Remote HTTPS endpoint.',
              ),
            );
            return;
          }
          if (params.disarmTimeoutAfterHeaders) {
            req.removeAllListeners('timeout');
            req.setTimeout(0);
          }
          if (settled) return;
          settled = true;
          resolve(res);
        },
      );

      if (params.signal) {
        if (params.signal.aborted) {
          req.destroy(new Error('Aborted'));
          doneReject(new Error('Request aborted'));
          return;
        }
        const onAbort = () => {
          req.destroy(new Error('Aborted'));
        };
        params.signal.addEventListener('abort', onAbort, { once: true });
        req.once('close', () => {
          params.signal?.removeEventListener('abort', onAbort);
        });
      }

      req.once('timeout', () => {
        const err = new ConnectClientRequestError(
          'NETWORK_INTERRUPTED',
          'Remote HTTPS request timed out.',
        );
        req.destroy(err);
        doneReject(err);
      });

      req.once('error', (err) => {
        doneReject(err);
      });

      if (params.bodyBuffer) {
        req.write(params.bodyBuffer);
      }
      req.end();
    });
  }

  private async publicHttpsJsonRequest<T>(params: {
    descriptor: RemoteEndpointDescriptorV1;
    method: 'GET' | 'POST';
    apiPath: string;
    bearerToken?: string;
    body?: unknown;
    signal?: AbortSignal;
    poolSockets?: boolean;
  }): Promise<T> {
    const bodyBuffer =
      params.body !== undefined ? Buffer.from(JSON.stringify(params.body), 'utf8') : undefined;
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (params.bearerToken) {
      headers.Authorization = `Bearer ${params.bearerToken}`;
    }
    if (bodyBuffer) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = String(bodyBuffer.length);
    }

    const res = await this.openVerifiedPublicHttpsRequest({
      descriptor: params.descriptor,
      method: params.method,
      apiPath: params.apiPath,
      headers,
      bodyBuffer,
      signal: params.signal,
      poolSockets: params.poolSockets,
    });

    const text = await readStreamText(res);
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = null;
    }

    const status = res.statusCode ?? 500;
    if (status >= 400) {
      const apiCode = typeof parsed?.code === 'string' ? parsed.code : '';
      const apiMsg =
        typeof parsed?.message === 'string' ? parsed.message : `HTTP ${status}`;
      let mappedCode: ConnectErrorCode = 'CONNECTION_FAILED';
      if (apiCode === 'ACCESS_REVOKED') mappedCode = 'ACCESS_REVOKED';
      else if (apiCode === 'REMOTE_ACCESS_NOT_GRANTED') mappedCode = 'REMOTE_ACCESS_NOT_GRANTED';
      else if (apiCode === 'HOST_IDENTITY_MISMATCH') mappedCode = 'HOST_IDENTITY_MISMATCH';
      else if (status === 401 || apiCode === 'AUTH_FAILED') mappedCode = 'AUTH_FAILED';
      else if (status === 429 || apiCode === 'RATE_LIMITED') mappedCode = 'RATE_LIMITED';
      else if (status === 502 || status === 503 || status === 504 || apiCode === 'REMOTE_ACCESS_UNAVAILABLE') {
        mappedCode = 'HOST_UNAVAILABLE';
      }
      throw new ConnectClientRequestError(mappedCode, apiMsg, status);
    }

    return (parsed ?? {}) as T;
  }
}

class RemoteHttpStatusError extends Error {
  readonly status: number;
  readonly errorCode: string;

  constructor(status: number, errorCode: string, message: string) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

function classifyRemoteHttpFailure(status: number, apiCode: string | null): string {
  if (apiCode === 'ACCESS_REVOKED') return 'ERR_REMOTE_ACCESS_REVOKED';
  if (status === 401 || status === 403 || apiCode === 'AUTH_FAILED') return 'ERR_REMOTE_AUTH_FAILED';
  if (status === 404 || apiCode === 'TRACK_NOT_FOUND' || apiCode === 'FILE_MISSING') {
    return 'ERR_REMOTE_TRACK_NOT_FOUND';
  }
  if (status === 429 || apiCode === 'CLIENT_LIMIT_REACHED' || apiCode === 'CONCURRENCY_LIMIT') {
    return 'ERR_REMOTE_RESOURCE_LIMIT';
  }
  if (status >= 500) return 'ERR_REMOTE_RESPONSE_INVALID';
  return 'ERR_REMOTE_STREAM_INTERRUPTED';
}

function delayAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readStreamTextLimited(
  stream: http.IncomingMessage,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const take = Math.min(buf.length, maxBytes - total);
      if (take > 0) {
        chunks.push(buf.subarray(0, take));
        total += take;
      }
      if (total >= maxBytes) {
        stream.destroy();
        break;
      }
    }
  } catch {
    // Ignore truncated error stream read
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readUpstreamBinary(
  stream: http.IncomingMessage,
  signal?: AbortSignal,
): Promise<Buffer> {
  const onAbort = () => stream.destroy();
  signal?.addEventListener('abort', onAbort, { once: true });
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > 20 * 1024 * 1024) {
        stream.destroy();
        throw new Error('Remote range fetch exceeded 20 MB safety bound');
      }
      chunks.push(buf);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return Buffer.concat(chunks);
}

function createUpstreamWebStream(params: {
  upstream: http.IncomingMessage;
  prefixChunk?: Uint8Array | null;
  signal?: AbortSignal;
  onComplete: (bytesDelivered: number, errorCode: string | null) => void;
}): ReadableStream<Uint8Array> {
  const { upstream, prefixChunk, signal, onComplete } = params;
  let bytesDelivered = 0;
  let completed = false;
  let closedByUpstream = false;
  let prefixPending = prefixChunk ?? null;

  const finish = (errCode: string | null) => {
    if (completed) return;
    completed = true;
    onComplete(bytesDelivered, errCode);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefixPending && prefixPending.byteLength > 0) {
        bytesDelivered += prefixPending.byteLength;
        controller.enqueue(prefixPending);
        prefixPending = null;
      }

      const cleanupListeners = () => {
        signal?.removeEventListener('abort', onSignalAbort);
        upstream.removeListener('data', onData);
        upstream.removeListener('end', onEnd);
        upstream.removeListener('error', onError);
        upstream.removeListener('close', onClose);
      };

      const onSignalAbort = () => {
        cleanupListeners();
        upstream.destroy();
        // Browser abort on Range seek or track switch is benign consumer cancellation, not a transport error
        finish(null);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const onData = (chunk: Buffer) => {
        if (completed) return;
        const out =
          chunk.buffer.byteLength > chunk.byteLength * 2
            ? Uint8Array.from(chunk)
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        bytesDelivered += out.byteLength;
        try {
          controller.enqueue(out);
          if ((controller.desiredSize ?? 0) <= 0) {
            upstream.pause();
          }
        } catch {
          cleanupListeners();
          upstream.destroy();
          finish('ERR_REMOTE_STREAM_INTERRUPTED');
        }
      };

      const onEnd = () => {
        closedByUpstream = true;
        cleanupListeners();
        finish(null);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const onError = (err: Error) => {
        closedByUpstream = true;
        cleanupListeners();
        finish('ERR_REMOTE_STREAM_INTERRUPTED');
        try {
          controller.error(err);
        } catch {
          // already closed
        }
      };

      const onClose = () => {
        if (closedByUpstream || completed) return;
        cleanupListeners();
        finish('ERR_REMOTE_STREAM_INTERRUPTED');
        try {
          controller.error(new Error('Upstream socket closed unexpectedly'));
        } catch {
          // already closed
        }
      };

      if (signal?.aborted) {
        onSignalAbort();
        return;
      }
      signal?.addEventListener('abort', onSignalAbort, { once: true });
      upstream.on('data', onData);
      upstream.once('end', onEnd);
      upstream.once('error', onError);
      upstream.once('close', onClose);
    },
    pull() {
      if (!completed) {
        upstream.resume();
      }
    },
    cancel() {
      finish(null);
      upstream.destroy();
    },
  });
}

async function readStreamText(stream: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 2 * 1024 * 1024) {
      stream.destroy();
      throw new Error('Response payload exceeded safety limit.');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}
