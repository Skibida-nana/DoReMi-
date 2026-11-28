import type { TrackAvailabilityState } from './track';

export type HostLifecycleState =
  | 'STOPPED'
  | 'STARTING'
  | 'STANDBY'
  | 'ACTIVE'
  | 'STOPPING'
  | 'ERROR';

export type HostPowerPolicy =
  | 'follow-system'
  | 'keep-awake-streaming'
  | 'keep-awake-host-on';

export type PowerSourceState = 'ac' | 'battery' | 'unknown';

export interface HostPowerSnapshot {
  policy: HostPowerPolicy;
  blockerActive: boolean;
  blockerMode: 'prevent-app-suspension' | null;
  blockerReason: string | null;
  activeStreamDeviceCount: number;
  inactivityGraceActive: boolean;
  inactivityGraceExpiresAt: string | null;
  powerSource: PowerSourceState;
  systemSuspended: boolean;
  lastSuspendAt: string | null;
  lastResumeAt: string | null;
  batteryWarning: string | null;
  policyWarning: string | null;
}

export type ConnectTransportMode = 'lan-direct' | 'remote-https';

export type ConnectionSelectionMode = 'automatic' | 'lan-only' | 'remote-only';

export type SmartConnectionState =
  | 'DISCONNECTED'
  | 'CHECKING_NETWORK'
  | 'DISCOVERING_LAN'
  | 'VERIFYING_LAN'
  | 'CONNECTING_LAN'
  | 'CONNECTED_LAN'
  | 'VERIFYING_REMOTE'
  | 'CONNECTING_REMOTE'
  | 'CONNECTED_REMOTE'
  | 'HANDOVER_PENDING'
  | 'HANDOVER_IN_PROGRESS'
  | 'RECONNECTING'
  | 'DEGRADED'
  | 'HOST_UNAVAILABLE'
  | 'NETWORK_UNAVAILABLE'
  | 'AUTHORIZATION_REQUIRED'
  | 'ACCESS_REVOKED'
  | 'SECURITY_BLOCKED'
  | 'ERROR';

export type ConnectionFailureCategory =
  | 'none'
  | 'recoverable_network'
  | 'authorization'
  | 'security'
  | 'content';

export type CandidateTransportAvailability =
  | 'eligible'
  | 'connected'
  | 'verifying'
  | 'unavailable'
  | 'disallowed_by_mode'
  | 'missing_credentials'
  | 'permission_not_granted'
  | 'descriptor_expired'
  | 'security_blocked';

export interface CandidateTransportStateSummary {
  transport: ConnectTransportMode;
  availability: CandidateTransportAvailability;
  lastVerifiedAt: string | null;
  lastLatencyMs: number | null;
  consecutiveFailures: number;
  detail: string | null;
}

export interface HandoverEventSummary {
  handoverId: string;
  handoverSeq: number;
  hostId: string;
  fromTransport: ConnectTransportMode | null;
  toTransport: ConnectTransportMode;
  strategy: 'make-before-break' | 'break-before-make';
  reason: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  streamsCancelled: number;
  sourceConsistent: boolean;
  positionBeforeSec?: number | null;
  positionAfterSec?: number | null;
  positionErrorSec?: number | null;
  outcome: 'completed' | 'aborted' | 'failed';
}

export interface SmartConnectionDiagnostics {
  selectedMode: ConnectionSelectionMode;
  smartState: SmartConnectionState;
  activeTransport: ConnectTransportMode | null;
  alternativeTransportAvailable: ConnectTransportMode | null;
  intendedHostId: string | null;
  attemptId: string | null;
  connectionGeneration: number;
  selectionReason: string | null;
  lastNetworkEvent: string | null;
  lastNetworkEventAt: string | null;
  identityVerificationOutcome: 'not_checked' | 'verified' | 'failed';
  authorizationOutcome: 'not_checked' | 'authorized' | 'unauthorized' | 'revoked';
  failureCategory: ConnectionFailureCategory;
  retryCount: number;
  backoffNextDelayMs: number | null;
  cooldownUntil: string | null;
  healthCheckCount: number;
  streamsCancelledCount: number;
  candidateTransports: {
    lanDirect: CandidateTransportStateSummary;
    remoteHttps: CandidateTransportStateSummary;
  };
  recentHandovers: HandoverEventSummary[];
}

export type RemoteProviderId = 'tailscale-funnel';

export type RemoteAccessState =
  | 'DISABLED'
  | 'CHECKING_PROVIDER'
  | 'PROVIDER_NOT_INSTALLED'
  | 'LOGIN_REQUIRED'
  | 'CONFIGURATION_REQUIRED'
  | 'SECURITY_BLOCKED'
  | 'STARTING_GATEWAY'
  | 'STARTING_TUNNEL'
  | 'VERIFYING_ENDPOINT'
  | 'READY'
  | 'DEGRADED'
  | 'STOPPING'
  | 'ERROR';

export type TailscaleDetectionStatus =
  | 'not_installed'
  | 'service_unavailable'
  | 'unsupported_version'
  | 'stopped'
  | 'login_required'
  | 'magicdns_or_https_missing'
  | 'funnel_permission_denied'
  | 'route_conflict'
  | 'ready';

export interface RemoteProviderStatusSnapshot {
  providerId: RemoteProviderId;
  detectionStatus: TailscaleDetectionStatus;
  executableDetected: boolean;
  cliVersion: string | null;
  backendState: string | null;
  dnsName: string | null;
  magicDnsEnabled: boolean;
  httpsCertEnabled: boolean;
  funnelAllowed: boolean;
  availablePublicPorts: Array<443 | 8443 | 10000>;
  conflictingRoutes: string[];
  downloadUrl: string;
  message: string;
}

export interface RemoteOwnedRouteRecord {
  providerId: RemoteProviderId;
  publicOrigin: string;
  publicPort: 443 | 8443 | 10000;
  mountPath: string;
  localTarget: string;
  createdAt: string;
}

export interface RemoteEndpointDescriptorV1 {
  schema: 'doremi-remote-endpoint';
  version: 1;
  hostId: string;
  hostDisplayName: string;
  providerId: RemoteProviderId;
  publicOrigin: string;
  mountPath: string;
  apiBasePath: string;
  endpointGeneration: number;
  issuedAt: string;
  expiresAt: string;
  identityAlgorithm: 'ecdsa-p256-spki-sha256';
  hostFingerprintSha256: string;
  hostPublicKeySpkiBase64: string;
  signatureBase64: string;
}

export interface RemoteHostIdentityProofV1 {
  schema: 'doremi-remote-host-proof';
  version: 1;
  hostId: string;
  publicOrigin: string;
  apiBasePath: string;
  endpointGeneration: number;
  clientNonce: string;
  issuedAt: string;
  expiresAt: string;
  hostPublicKeySpkiBase64: string;
  signatureBase64: string;
}

export interface RemoteProvisioningBundleDto {
  hostId: string;
  deviceId: string;
  remoteAccessEnabled: boolean;
  descriptor: RemoteEndpointDescriptorV1 | null;
  remoteCredential: string | null;
  issuedAt: string;
}

export interface HostRemoteAccessSnapshot {
  state: RemoteAccessState;
  userAcknowledgedExposure: boolean;
  preferredPublicPort: 443 | 8443 | 10000;
  mountPath: string;
  endpointGeneration: number;
  gatewayListeningPort: number | null;
  publicEndpointUrl: string | null;
  activeDescriptor: RemoteEndpointDescriptorV1 | null;
  providerStatus: RemoteProviderStatusSnapshot;
  staleRouteWarning: string | null;
  securityGatePassed: boolean;
  securityGateIssues: string[];
  lastError: string | null;
  externalUatVerified: boolean;
}

export type ConnectErrorCode =
  | 'HOST_UNAVAILABLE'
  | 'CONNECTION_FAILED'
  | 'AUTH_FAILED'
  | 'ACCESS_REVOKED'
  | 'REMOTE_ACCESS_NOT_GRANTED'
  | 'REMOTE_ENDPOINT_NOT_CONFIGURED'
  | 'REMOTE_ENDPOINT_EXPIRED'
  | 'CONTENT_CHANGED'
  | 'NETWORK_INTERRUPTED'
  | 'UNSUPPORTED_FORMAT'
  | 'INSUFFICIENT_BANDWIDTH'
  | 'UNSUPPORTED_API_VERSION'
  | 'HOST_IDENTITY_MISMATCH'
  | 'ENROLLMENT_EXPIRED'
  | 'ENROLLMENT_REJECTED'
  | 'RATE_LIMITED';

export interface ConnectResourceLimits {
  maxActiveClients: number;
  maxRequestsPerDevice: number;
  maxGlobalRequests: number;
}

export interface HostConfig {
  enabled: boolean;
  autoStart: boolean;
  displayName: string;
  port: number;
  bindAddress: string; // 'auto-private' | '127.0.0.1' | specific private IPv4
  resourceLimits: ConnectResourceLimits;
  powerPolicy?: HostPowerPolicy;
  remoteProvider?: RemoteProviderId;
  remotePublicPort?: 443 | 8443 | 10000;
  remoteMountPath?: string;
  remoteEndpointGeneration?: number;
  remoteUserAcknowledged?: boolean;
  updatedAt: string;
}

export interface HostIdentityPublicInfo {
  hostId: string;
  fingerprintSha256: string;
  shortFingerprint: string;
  createdAt: string;
  storageBackend: 'electron-safe-storage' | 'file-fallback' | 'unavailable';
}

export interface HostCapabilitiesDto {
  apiVersion: string;
  minSupportedApiVersion: string;
  appName: string;
  appVersion: string;
  hostId: string;
  hostDisplayName: string;
  hostFingerprintSha256: string;
  shortFingerprint: string;
  supportedTransports: ConnectTransportMode[];
  authRequired: boolean;
  enrollmentOpen: boolean;
  directStreamOnly: boolean;
}

export interface SharedSourceRecord {
  id: string;
  rootId: string;
  folderName: string;
  originalPath: string;
  enabled: boolean;
  available: boolean;
  trackCount: number;
  addedAt: string;
}

export type InvitationLifecycleState =
  | 'CREATED'
  | 'ACTIVE'
  | 'PENDING_APPROVAL'
  | 'CONSUMED'
  | 'EXPIRED'
  | 'CANCELED'
  | 'REJECTED';

export interface EnrollmentInvitationSummary {
  invitationId: string;
  inviteCode: string;
  shortFingerprint: string;
  fullFingerprint: string;
  hostId: string;
  hostDisplayName: string;
  listenAddresses: string[];
  port: number;
  createdAt: string;
  expiresAt: string;
  autoApproveSingleUse: boolean;
  used: boolean;
  lifecycleState: InvitationLifecycleState;
  pairingPayload: string;
  qrDataUrl?: string | null;
}

export type SecurityAuditCategory =
  | 'invitation_created'
  | 'invitation_canceled'
  | 'enrollment_submitted'
  | 'enrollment_approved'
  | 'enrollment_rejected'
  | 'enrollment_expired'
  | 'enrollment_replay_blocked'
  | 'auth_failed'
  | 'auth_rate_limited'
  | 'device_revoked'
  | 'device_disconnected'
  | 'device_removed'
  | 'credential_rotated'
  | 'identity_rotated'
  | 'identity_mismatch'
  | 'remote_access_enabled'
  | 'remote_access_disabled'
  | 'remote_permission_changed'
  | 'remote_route_blocked'
  | 'power_policy_changed'
  | 'power_suspend'
  | 'power_resume';

export interface SecurityAuditEvent {
  timestamp: string;
  category: SecurityAuditCategory;
  correlationId: string | null;
  deviceId: string | null;
  statusCode: number | null;
  outcome: 'success' | 'blocked' | 'error';
  detail: string;
}

export interface PendingEnrollmentRequest {
  requestId: string;
  invitationId: string;
  deviceName: string;
  platform: string;
  remoteAddress: string;
  requestedAt: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
}

export type DeviceAuthState = 'authorized' | 'revoked';

export interface AuthorizedDeviceRecord {
  deviceId: string;
  displayName: string;
  platform: string;
  authState: DeviceAuthState;
  enrolledAt: string;
  lastActivityAt: string | null;
  lastIp: string | null;
  revokedAt: string | null;
  remoteAccessEnabled: boolean;
  remoteGrantedAt: string | null;
  isConnected: boolean;
  activeSessionCount: number;
}

export interface ActiveStreamSessionInfo {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  trackId: string;
  startedAt: string;
  bytesRead: number;
  bytesSent: number;
  isPartial: boolean;
  transport?: ConnectTransportMode;
}

export interface ConnectResourceMetrics {
  sampledAt: string;
  hostMetrics: {
    state: HostLifecycleState;
    uptimeMs: number;
    sharedTrackCount: number;
    authorizedDeviceCount: number;
    connectedDeviceCount: number;
    activePlaybackClients?: number;
    activePlaybackSessions: number;
    activeHttpRequests: number;
    totalBytesReadByStreamer: number;
    totalBytesTransmitted: number;
    currentThroughputBytesPerSec: number;
    lanThroughputBytesPerSec?: number;
    remoteThroughputBytesPerSec?: number;
    metadataCacheEntries: number;
    artworkCacheEntries: number;
    lyricsCacheEntries?: number;
  };
  appProcessMetrics: {
    processCpuPercent: number | null;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    arrayBuffersBytes?: number;
  };
  systemMetrics: {
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    logicalCpuCount: number;
    loadAverageAvailable: boolean;
  };
}

export interface ScopedHostResourceBreakdown {
  sampledAt: string;
  hostState: HostLifecycleState;
  powerPolicy: HostPowerPolicy;
  powerBlockerActive: boolean;
  mainProcess: {
    cpuOneCorePercent: number | null;
    cpuNormalizedPercent: number | null;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
  };
  appProcessTree: {
    available: boolean;
    processCount: number;
    workingSetSumBytes: number;
    privateBytesSum: number | null;
    cpuNormalizedPercentSum: number | null;
    note: string;
  };
  serverCounters: {
    activePlaybackClients: number;
    connectedDevices: number;
    authorizedDevices: number;
    activeStreams: number;
    activeHttpRequests: number;
    lanThroughputBytesPerSec: number;
    remoteThroughputBytesPerSec: number;
    totalThroughputBytesPerSec: number;
    totalLanBytesSent: number;
    totalRemoteBytesSent: number;
    metadataCacheEntries: number;
    artworkCacheEntries: number;
    lyricsCacheEntries: number;
  };
  tailscaleProcesses: {
    sampled: boolean;
    running: boolean;
    processCount: number;
    workingSetSumBytes: number;
    privateBytesSum: number;
    note: string;
  };
  systemResources: {
    logicalCpuCount: number;
    totalMemoryBytes: number;
    freeMemoryBytes: number;
  };
}

export interface HostStreamTraceEntry {
  timestamp: string;
  correlationId: string | null;
  deviceId: string;
  trackId: string;
  method: string;
  rangeHeader: string | null;
  statusCode: number;
  errorCode: string | null;
  bytesSent: number;
  durationMs: number;
}

export interface ClientStreamTraceEntry {
  timestamp: string;
  correlationId: string;
  hostId: string;
  trackId: string;
  kind: 'stream' | 'alac-probe' | 'alac-decode' | 'flac-sanitize' | 'artwork';
  transport?: ConnectTransportMode;
  method: string;
  rangeHeader: string | null;
  statusCode: number | null;
  contentType: string | null;
  errorCode: string | null;
  detail: string | null;
  bytesDelivered: number;
  durationMs: number;
  firstByteMs?: number | null;
}

export interface ClientDiagnosticsSnapshot {
  sampledAt: string;
  activeHostId: string | null;
  activeHostName: string | null;
  activeHostAddress: string | null;
  activeHostPort: number | null;
  activeTransport?: ConnectTransportMode | null;
  activeEndpointDisplay?: string | null;
  status: ClientConnectionStatus;
  lastError: string | null;
  lastErrorCode: ConnectErrorCode | null;
  lastTrackFailure: ClientStreamTraceEntry | null;
  recentTraces: ClientStreamTraceEntry[];
  recentSecurityEvents?: SecurityAuditEvent[];
  smartConnection?: SmartConnectionDiagnostics;
}

export interface ConnectDiagnosticsSnapshot {
  hostState: HostLifecycleState;
  lastError: string | null;
  discoveryActive: boolean;
  discoveryState: 'stopped' | 'advertising' | 'unavailable';
  networkAvailable: boolean;
  listenAddresses: string[];
  listeningPort: number | null;
  remoteState?: RemoteAccessState;
  remoteProvider?: RemoteProviderId;
  remotePublicUrl?: string | null;
  apiVersion: string;
  recentErrors: Array<{
    timestamp: string;
    code: string;
    message: string;
  }>;
  recentStreamTraces: HostStreamTraceEntry[];
  recentSecurityEvents?: SecurityAuditEvent[];
  lastInvitationState?: InvitationLifecycleState | null;
  firewallNote: string;
}

export interface HostSnapshot {
  config: HostConfig;
  state: HostLifecycleState;
  lastError: string | null;
  identity: HostIdentityPublicInfo | null;
  listenAddresses: string[];
  listeningPort: number | null;
  sharedSources: SharedSourceRecord[];
  sharedTrackCount: number;
  authorizedDevices: AuthorizedDeviceRecord[];
  activeSessions: ActiveStreamSessionInfo[];
  activeInvitation: EnrollmentInvitationSummary | null;
  pendingEnrollments: PendingEnrollmentRequest[];
  remoteAccess?: HostRemoteAccessSnapshot;
  power?: HostPowerSnapshot;
  metrics: ConnectResourceMetrics;
  diagnostics: ConnectDiagnosticsSnapshot;
}

export interface DiscoveredHostRecord {
  hostId: string;
  displayName: string;
  address: string;
  port: number;
  apiVersion: string;
  mode: ConnectTransportMode;
  fingerprintPrefix: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface RememberedHostRecord {
  hostId: string;
  displayName: string;
  lastAddress: string;
  port: number;
  pinnedFingerprint: string;
  shortFingerprint: string;
  deviceId: string;
  apiVersion: string;
  connectionMode?: ConnectionSelectionMode;
  preferredTransport?: ConnectTransportMode;
  remoteEndpoint?: RemoteEndpointDescriptorV1 | null;
  hasRemoteCredential?: boolean;
  lastRemoteConnectedAt?: string | null;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HostProbeResult {
  reachable: boolean;
  address: string;
  port: number;
  capabilities: HostCapabilitiesDto | null;
  observedFingerprintSha256: string | null;
  observedShortFingerprint: string | null;
  pinnedFingerprintMismatch: boolean;
  expectedFingerprintSha256: string | null;
  errorCode?: ConnectErrorCode;
  errorMessage?: string;
}

export interface RemoteTrackDto {
  trackId: string;
  title: string;
  artist: string;
  album: string | null;
  albumArtist: string | null;
  genre: string | null;
  year: number | null;
  trackNumber: number | null;
  trackTotal: number | null;
  discNumber: number | null;
  discTotal: number | null;
  durationMs: number | null;
  codec: string | null;
  container: string | null;
  sampleRateHz: number | null;
  bitDepth: number | null;
  bitrateBps: number | null;
  channels: number | null;
  fileSizeBytes: number | null;
  sourceRevision?: string | null;
  availabilityState: TrackAvailabilityState;
  hasArtwork: boolean;
  artworkHash: string | null;
  hasLyrics: boolean;
}

export interface RemoteAlbumDto {
  albumKey: string;
  title: string;
  artist: string;
  year: number | null;
  trackCount: number;
  totalDurationMs: number;
  coverTrackId: string | null;
  coverHash: string | null;
}

export interface RemoteArtistDto {
  name: string;
  trackCount: number;
  albumCount: number;
}

export interface RemoteLibrarySummaryDto {
  hostId: string;
  hostDisplayName: string;
  totalSharedTracks: number;
  totalAlbums: number;
  totalArtists: number;
  sharedSourceCount: number;
  updatedAt: string;
}

export interface RemoteLibraryPage<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export type ClientConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'reconnecting'
  | 'connected'
  | 'error';

export interface ClientEnrollmentSessionState {
  status: 'idle' | 'submitting' | 'pending_approval' | 'approved' | 'rejected' | 'error';
  requestId?: string;
  hostId?: string;
  hostDisplayName?: string;
  message?: string;
  errorCode?: ConnectErrorCode;
}

export interface ConnectClientSnapshot {
  status: ClientConnectionStatus;
  smartState?: SmartConnectionState;
  selectedMode?: ConnectionSelectionMode;
  activeHost: RememberedHostRecord | null;
  intendedHostId?: string | null;
  activeTransport?: ConnectTransportMode | null;
  alternativeTransportAvailable?: ConnectTransportMode | null;
  activeEndpointDisplay?: string | null;
  summary: RemoteLibrarySummaryDto | null;
  discoveredHosts: DiscoveredHostRecord[];
  rememberedHosts: RememberedHostRecord[];
  isDiscovering: boolean;
  lastError: string | null;
  lastErrorCode: ConnectErrorCode | null;
  failureCategory?: ConnectionFailureCategory;
  reconnectAttempt: number;
  connectionGeneration?: number;
  handoverSignal?: HandoverEventSummary | null;
  enrollment: ClientEnrollmentSessionState;
}
