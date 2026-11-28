import type {
  CandidateTransportAvailability,
  CandidateTransportStateSummary,
  ConnectErrorCode,
  ConnectionFailureCategory,
  ConnectionSelectionMode,
  ConnectTransportMode,
  DiscoveredHostRecord,
  HandoverEventSummary,
  RemoteEndpointDescriptorV1,
  RemoteLibrarySummaryDto,
  SmartConnectionDiagnostics,
  SmartConnectionState,
} from '../../../shared/types/connect';
import type { StoredRememberedHost } from './connect-repository';
import {
  NetworkChangeMonitor,
  type NetworkChangeEvent,
  type NetworkObservationSnapshot,
} from './network-monitor';

const MAX_RECENT_HANDOVERS = 24;

export interface PreparedTransportSession {
  host: StoredRememberedHost;
  transport: ConnectTransportMode;
  token: string;
  summary: RemoteLibrarySummaryDto;
  remoteDescriptor: RemoteEndpointDescriptorV1 | null;
  verifiedAddress: string;
  verifiedPort: number;
  latencyMs: number;
}

export type TransportPrepareResult =
  | {
      ok: true;
      session: PreparedTransportSession;
    }
  | {
      ok: false;
      errorCode: ConnectErrorCode;
      category: ConnectionFailureCategory;
      message: string;
      latencyMs: number;
    };

export interface SmartConnectionDriver {
  findRememberedHost(hostId: string): StoredRememberedHost | null;
  setRememberedHostMode(hostId: string, mode: ConnectionSelectionMode): boolean;
  hasLanCredential(host: StoredRememberedHost): boolean;
  hasRemoteCredential(host: StoredRememberedHost): boolean;
  inspectRemoteDescriptorEligibility(host: StoredRememberedHost): {
    eligible: boolean;
    availability: CandidateTransportAvailability;
    errorCode?: ConnectErrorCode;
    category?: ConnectionFailureCategory;
    message?: string;
  };
  discoverLanCandidates(hostId: string, signal: AbortSignal): Promise<DiscoveredHostRecord[]>;
  prepareLanTransport(
    host: StoredRememberedHost,
    signal: AbortSignal,
    overrideEndpoint?: { address: string; port: number },
  ): Promise<TransportPrepareResult>;
  prepareRemoteTransport(
    host: StoredRememberedHost,
    signal: AbortSignal,
  ): Promise<TransportPrepareResult>;
  probeActiveTransportHealth(
    session: PreparedTransportSession,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; errorCode?: ConnectErrorCode; category?: ConnectionFailureCategory; message?: string }>;
  commitPreparedSession(
    session: PreparedTransportSession,
    meta: {
      isHandover: boolean;
      fromTransport: ConnectTransportMode | null;
      strategy: 'make-before-break' | 'break-before-make';
      reason: string;
      handoverEvent?: HandoverEventSummary | null;
    },
  ): { streamsCancelled: number };
  clearActiveSession(reason: {
    smartState: SmartConnectionState;
    errorCode: ConnectErrorCode | null;
    category: ConnectionFailureCategory;
    message: string | null;
    revokeLocalRuntimeOnly?: boolean;
  }): { streamsCancelled: number };
  onStateUpdated(): void;
}

export interface SmartConnectionPolicyConfig {
  networkDebounceMs: number;
  lanRecoveryConfirmMs: number;
  switchCooldownMs: number;
  failureThreshold: number;
  retryBackoffMs: readonly number[];
  maxAutoReconnectAttempts: number;
  enableJitter: boolean;
}

export const DEFAULT_SMART_CONNECTION_POLICY: SmartConnectionPolicyConfig = {
  networkDebounceMs: 800,
  lanRecoveryConfirmMs: 2_500,
  switchCooldownMs: 15_000,
  failureThreshold: 2,
  retryBackoffMs: [500, 1_000, 2_000, 4_000, 8_000],
  maxAutoReconnectAttempts: 6,
  enableJitter: true,
};

export function classifyConnectFailure(
  errorCode: ConnectErrorCode,
  detailMessage?: string,
): ConnectionFailureCategory {
  switch (errorCode) {
    case 'HOST_IDENTITY_MISMATCH':
    case 'UNSUPPORTED_API_VERSION':
      return 'security';
    case 'ACCESS_REVOKED':
    case 'AUTH_FAILED':
    case 'REMOTE_ACCESS_NOT_GRANTED':
    case 'REMOTE_ENDPOINT_NOT_CONFIGURED':
    case 'REMOTE_ENDPOINT_EXPIRED':
    case 'ENROLLMENT_EXPIRED':
    case 'ENROLLMENT_REJECTED':
      return 'authorization';
    case 'UNSUPPORTED_FORMAT':
    case 'CONTENT_CHANGED':
      return 'content';
    case 'HOST_UNAVAILABLE':
    case 'NETWORK_INTERRUPTED':
    case 'RATE_LIMITED':
    case 'INSUFFICIENT_BANDWIDTH':
      return 'recoverable_network';
    case 'CONNECTION_FAILED': {
      const lower = (detailMessage ?? '').toLowerCase();
      if (
        lower.includes('certificate') ||
        lower.includes('tls') ||
        lower.includes('redirect') ||
        lower.includes('altname') ||
        lower.includes('self-signed') ||
        lower.includes('origin') ||
        lower.includes('descriptor')
      ) {
        return 'security';
      }
      return 'recoverable_network';
    }
    default:
      return 'recoverable_network';
  }
}

/**
 * Platform-independent Smart Connection Manager (Phase 6.4).
 * Coordinates security-aware transport selection (`Automatic`, `LAN Only`, `Remote Only`),
 * bounded mDNS LAN rediscovery, hysteresis/cooldown, exponential backoff, and make-before-break
 * or break-before-make transport handover without duplicating TLS, auth, or decoder internals.
 */
export class SmartConnectionManager {
  private readonly driver: SmartConnectionDriver;
  private readonly monitor: NetworkChangeMonitor;
  private readonly policy: SmartConnectionPolicyConfig;
  private readonly nowMs: () => number;
  private readonly unsubscribeMonitor: () => void;

  private smartState: SmartConnectionState = 'DISCONNECTED';
  private selectedMode: ConnectionSelectionMode = 'lan-only';
  private intendedHostId: string | null = null;
  private activeSession: PreparedTransportSession | null = null;
  private connectionGeneration = 0;
  private attemptCounter = 0;
  private handoverSeq = 0;
  private currentAttemptId: string | null = null;
  private activeAbort: AbortController | null = null;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lanConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private retryCount = 0;
  private backoffNextDelayMs: number | null = null;
  private lastSwitchAtMs: number | null = null;
  private lastTransportEvidenceAtMs = 0;
  private systemSuspended = false;
  private consecutiveActiveFailures = 0;
  private healthCheckCount = 0;
  private streamsCancelledCount = 0;
  private lastSelectionReason: string | null = null;
  private lastNetworkEvent: string | null = null;
  private lastNetworkEventAt: string | null = null;
  private identityOutcome: 'not_checked' | 'verified' | 'failed' = 'not_checked';
  private authOutcome: 'not_checked' | 'authorized' | 'unauthorized' | 'revoked' = 'not_checked';
  private failureCategory: ConnectionFailureCategory = 'none';
  private lastErrorCode: ConnectErrorCode | null = null;
  private lastErrorMessage: string | null = null;
  private lastHandoverSignal: HandoverEventSummary | null = null;
  private readonly recentHandovers: HandoverEventSummary[] = [];

  private lanCandidate: CandidateTransportStateSummary = {
    transport: 'lan-direct',
    availability: 'eligible',
    lastVerifiedAt: null,
    lastLatencyMs: null,
    consecutiveFailures: 0,
    detail: null,
  };

  private remoteCandidate: CandidateTransportStateSummary = {
    transport: 'remote-https',
    availability: 'unavailable',
    lastVerifiedAt: null,
    lastLatencyMs: null,
    consecutiveFailures: 0,
    detail: null,
  };

  // Remembers if a transport hit a non-retryable auth/security block during this host session
  private lanBlockedForSession: {
    code: ConnectErrorCode;
    category: ConnectionFailureCategory;
    message: string;
  } | null = null;
  private remoteBlockedForSession: {
    code: ConnectErrorCode;
    category: ConnectionFailureCategory;
    message: string;
  } | null = null;

  constructor(options: {
    driver: SmartConnectionDriver;
    networkMonitor?: NetworkChangeMonitor;
    policy?: Partial<SmartConnectionPolicyConfig>;
    nowMs?: () => number;
  }) {
    this.driver = options.driver;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.policy = {
      ...DEFAULT_SMART_CONNECTION_POLICY,
      ...(options.policy ?? {}),
    };
    this.monitor =
      options.networkMonitor ??
      new NetworkChangeMonitor({
        nowMs: this.nowMs,
      });
    this.unsubscribeMonitor = this.monitor.subscribe((ev) => {
      this.handleNetworkChangeEvent(ev);
    });
  }

  getSmartState(): SmartConnectionState {
    return this.smartState;
  }

  getSelectedMode(): ConnectionSelectionMode {
    return this.selectedMode;
  }

  getIntendedHostId(): string | null {
    return this.intendedHostId;
  }

  getConnectionGeneration(): number {
    return this.connectionGeneration;
  }

  getRetryCount(): number {
    return this.retryCount;
  }

  getActiveTimerCount(): number {
    return (
      (this.debounceTimer ? 1 : 0) +
      (this.lanConfirmTimer ? 1 : 0) +
      (this.retryTimer ? 1 : 0)
    );
  }

  getFailureCategory(): ConnectionFailureCategory {
    return this.failureCategory;
  }

  getLastErrorCode(): ConnectErrorCode | null {
    return this.lastErrorCode;
  }

  getLastErrorMessage(): string | null {
    return this.lastErrorMessage;
  }

  getLastHandoverSignal(): HandoverEventSummary | null {
    return this.lastHandoverSignal ? { ...this.lastHandoverSignal } : null;
  }

  getAlternativeTransportAvailable(): ConnectTransportMode | null {
    if (!this.intendedHostId || this.selectedMode !== 'automatic') {
      return null;
    }
    const active = this.activeSession?.transport ?? null;
    if (active === 'lan-direct') {
      return this.remoteCandidate.availability === 'eligible' ||
        this.remoteCandidate.availability === 'connected'
        ? 'remote-https'
        : null;
    }
    if (active === 'remote-https') {
      return this.lanCandidate.availability === 'eligible' ||
        this.lanCandidate.availability === 'connected'
        ? 'lan-direct'
        : null;
    }
    return null;
  }

  recordHandoverPlaybackOutcome(params: {
    handoverSeq: number;
    positionBeforeSec: number | null;
    positionAfterSec: number | null;
  }): void {
    const match = this.recentHandovers.find((item) => item.handoverSeq === params.handoverSeq);
    if (!match) return;
    match.positionBeforeSec = params.positionBeforeSec;
    match.positionAfterSec = params.positionAfterSec;
    if (
      typeof params.positionBeforeSec === 'number' &&
      typeof params.positionAfterSec === 'number' &&
      Number.isFinite(params.positionBeforeSec) &&
      Number.isFinite(params.positionAfterSec)
    ) {
      match.positionErrorSec = Number(
        Math.abs(params.positionAfterSec - params.positionBeforeSec).toFixed(3),
      );
    }
    if (this.lastHandoverSignal?.handoverSeq === params.handoverSeq) {
      this.lastHandoverSignal = { ...match };
    }
  }

  getDiagnosticsSnapshot(): SmartConnectionDiagnostics {
    const cooldownUntilMs =
      this.lastSwitchAtMs !== null ? this.lastSwitchAtMs + this.policy.switchCooldownMs : null;
    const now = this.nowMs();
    return {
      selectedMode: this.selectedMode,
      smartState: this.smartState,
      activeTransport: this.activeSession?.transport ?? null,
      alternativeTransportAvailable: this.getAlternativeTransportAvailable(),
      intendedHostId: this.intendedHostId,
      attemptId: this.currentAttemptId,
      connectionGeneration: this.connectionGeneration,
      selectionReason: this.lastSelectionReason,
      lastNetworkEvent: this.lastNetworkEvent,
      lastNetworkEventAt: this.lastNetworkEventAt,
      identityVerificationOutcome: this.identityOutcome,
      authorizationOutcome: this.authOutcome,
      failureCategory: this.failureCategory,
      retryCount: this.retryCount,
      backoffNextDelayMs: this.backoffNextDelayMs,
      cooldownUntil:
        cooldownUntilMs !== null && cooldownUntilMs > now
          ? new Date(cooldownUntilMs).toISOString()
          : null,
      healthCheckCount: this.healthCheckCount,
      streamsCancelledCount: this.streamsCancelledCount,
      candidateTransports: {
        lanDirect: { ...this.lanCandidate },
        remoteHttps: { ...this.remoteCandidate },
      },
      recentHandovers: this.recentHandovers.map((h) => ({ ...h })),
    };
  }

  notifyExternalNetworkHint(hint: 'online' | 'offline' | 'recheck'): void {
    if (!this.intendedHostId) {
      return;
    }
    this.monitor.notifyHint(hint);
  }

  /**
   * Records real application request/stream success as zero-overhead connection health evidence.
   */
  recordTransportSuccess(transport: ConnectTransportMode): void {
    if (!this.activeSession || this.activeSession.transport !== transport) {
      return;
    }
    this.consecutiveActiveFailures = 0;
    const now = this.nowMs();
    this.lastTransportEvidenceAtMs = now;
    const iso = new Date(now).toISOString();
    if (transport === 'lan-direct') {
      this.lanCandidate.consecutiveFailures = 0;
      this.lanCandidate.lastVerifiedAt = iso;
      this.lanCandidate.availability = 'connected';
    } else {
      this.remoteCandidate.consecutiveFailures = 0;
      this.remoteCandidate.lastVerifiedAt = iso;
      this.remoteCandidate.availability = 'connected';
    }
    if (this.smartState === 'DEGRADED') {
      this.smartState = transport === 'lan-direct' ? 'CONNECTED_LAN' : 'CONNECTED_REMOTE';
      this.driver.onStateUpdated();
    }
  }

  /**
   * Notifies SmartConnectionManager when an active request or audio stream encounters an error.
   * Content errors (404 missing track / codec) NEVER trigger transport switching.
   */
  async reportTransportFailure(params: {
    hostId: string;
    transport: ConnectTransportMode;
    errorCode: ConnectErrorCode;
    message: string;
    immediate?: boolean;
  }): Promise<void> {
    if (!this.intendedHostId || this.intendedHostId !== params.hostId.toLowerCase()) {
      return;
    }
    const category = classifyConnectFailure(params.errorCode, params.message);
    if (category === 'content') {
      // Content failure (e.g. missing track): never switch transports or enter reconnect loops
      return;
    }

    if (category === 'security') {
      this.blockSessionWithTerminalFailure(
        params.transport,
        'SECURITY_BLOCKED',
        params.errorCode,
        'security',
        params.message,
      );
      return;
    }

    if (category === 'authorization') {
      if (params.errorCode === 'ACCESS_REVOKED') {
        this.blockSessionWithTerminalFailure(
          params.transport,
          'ACCESS_REVOKED',
          'ACCESS_REVOKED',
          'authorization',
          params.message,
        );
        return;
      }
      if (params.transport === 'remote-https') {
        this.remoteBlockedForSession = {
          code: params.errorCode,
          category: 'authorization',
          message: params.message,
        };
        this.remoteCandidate.availability = 'permission_not_granted';
        this.remoteCandidate.detail = params.message;
        // Remote-only revocation: if Automatic mode has valid LAN Direct, recover via LAN!
        if (this.selectedMode === 'automatic' && !this.lanBlockedForSession) {
          await this.initiateEmergencyRecovery('Remote permission removed; evaluating LAN Direct');
          return;
        }
      } else {
        this.lanBlockedForSession = {
          code: params.errorCode,
          category: 'authorization',
          message: params.message,
        };
        this.lanCandidate.availability = 'missing_credentials';
        this.lanCandidate.detail = params.message;
      }
      this.blockSessionWithTerminalFailure(
        params.transport,
        'AUTHORIZATION_REQUIRED',
        params.errorCode,
        'authorization',
        params.message,
      );
      return;
    }

    // Recoverable network failure
    this.consecutiveActiveFailures += 1;
    if (params.transport === 'lan-direct') {
      this.lanCandidate.consecutiveFailures += 1;
    } else {
      this.remoteCandidate.consecutiveFailures += 1;
    }

    if (!params.immediate && this.consecutiveActiveFailures < this.policy.failureThreshold) {
      if (
        this.smartState === 'CONNECTED_LAN' ||
        this.smartState === 'CONNECTED_REMOTE'
      ) {
        this.smartState = 'DEGRADED';
        this.driver.onStateUpdated();
      }
      return;
    }

    await this.initiateEmergencyRecovery(
      `Active ${params.transport} failed (${params.errorCode})`,
    );
  }

  /**
   * Changes the persisted connection mode for a remembered Host and immediately enforces it
   * if that Host is currently selected/connected.
   */
  async setConnectionMode(
    hostId: string,
    mode: ConnectionSelectionMode,
  ): Promise<void> {
    const cleanHostId = hostId.toLowerCase();
    const validMode: ConnectionSelectionMode =
      mode === 'automatic' || mode === 'remote-only' ? mode : 'lan-only';
    this.driver.setRememberedHostMode(cleanHostId, validMode);

    if (this.intendedHostId !== cleanHostId) {
      this.driver.onStateUpdated();
      return;
    }

    this.selectedMode = validMode;
    this.lanBlockedForSession = null;
    this.remoteBlockedForSession = null;
    this.refreshCandidateEligibilitySnapshot(cleanHostId);

    // If currently connected on a transport already compliant with the new mode:
    if (this.activeSession) {
      if (validMode === 'lan-only' && this.activeSession.transport === 'lan-direct') {
        this.cancelTimersOnly();
        this.smartState = 'CONNECTED_LAN';
        this.lastSelectionReason = 'User selected LAN Only while already on verified LAN Direct.';
        this.driver.onStateUpdated();
        return;
      }
      if (validMode === 'remote-only' && this.activeSession.transport === 'remote-https') {
        this.cancelTimersOnly();
        this.smartState = 'CONNECTED_REMOTE';
        this.lastSelectionReason = 'User selected Remote Only while already on verified Remote HTTPS.';
        this.driver.onStateUpdated();
        return;
      }
      if (validMode === 'automatic') {
        if (this.activeSession.transport === 'lan-direct') {
          this.monitor.start();
          this.smartState = 'CONNECTED_LAN';
          this.lastSelectionReason = 'Switched to Automatic; keeping verified LAN Direct.';
          this.driver.onStateUpdated();
          return;
        }
        // Currently on Remote HTTPS and user switched to Automatic -> check if LAN is available for Make-Before-Break!
        this.monitor.start();
        await this.tryProactiveReturnToLan('User switched mode to Automatic while on Remote HTTPS', true);
        return;
      }
    }

    // Mode requires switching transport or connecting afresh!
    await this.connect(cleanHostId, {
      modeOverride: validMode,
      reason: `User changed connection mode to ${validMode}`,
      preserveActiveForHandover: Boolean(this.activeSession),
    });
  }

  /**
   * Establishes or transitions a connection to `hostId` according to `modeOverride` or persisted `connectionMode`.
   */
  async connect(
    hostId: string,
    options?: {
      overrideAddress?: string;
      overridePort?: number;
      modeOverride?: ConnectionSelectionMode;
      oneShotExplicitTransport?: ConnectTransportMode;
      reason?: string;
      preserveActiveForHandover?: boolean;
    },
  ): Promise<void> {
    const cleanHostId = hostId.toLowerCase();
    const gen = this.beginNewOperation(cleanHostId, options?.preserveActiveForHandover ?? false);
    const signal = this.activeAbort!.signal;

    const remembered = this.driver.findRememberedHost(cleanHostId);
    if (!remembered) {
      this.finishTerminal(
        gen,
        'HOST_UNAVAILABLE',
        'HOST_UNAVAILABLE',
        'recoverable_network',
        'Không tìm thấy thông tin Host đã lưu.',
      );
      return;
    }

    const effectiveMode: ConnectionSelectionMode = options?.oneShotExplicitTransport
      ? options.oneShotExplicitTransport === 'remote-https'
        ? 'remote-only'
        : 'lan-only'
      : options?.modeOverride ?? remembered.connectionMode ?? 'lan-only';

    this.selectedMode = effectiveMode;
    this.lanBlockedForSession = null;
    this.remoteBlockedForSession = null;
    this.retryCount = 0;
    this.backoffNextDelayMs = null;
    this.failureCategory = 'none';
    this.lastErrorCode = null;
    this.lastErrorMessage = null;
    this.lastSelectionReason = options?.reason ?? `Connect requested (${effectiveMode})`;
    this.monitor.start();

    await this.executeSelectionAttempt(gen, signal, {
      hostId: cleanHostId,
      mode: effectiveMode,
      overrideEndpoint:
        options?.overrideAddress !== undefined || options?.overridePort !== undefined
          ? {
              address: (options.overrideAddress ?? remembered.lastAddress).trim(),
              port: options.overridePort ?? remembered.port,
            }
          : undefined,
      isHandoverAttempt: Boolean(options?.preserveActiveForHandover && this.activeSession),
      reason: this.lastSelectionReason,
    });
  }

  async manualRetry(): Promise<void> {
    if (!this.intendedHostId) {
      return;
    }
    this.lanBlockedForSession = null;
    this.remoteBlockedForSession = null;
    this.retryCount = 0;
    this.backoffNextDelayMs = null;
    await this.connect(this.intendedHostId, {
      modeOverride: this.selectedMode,
      reason: 'Manual user retry',
      preserveActiveForHandover: Boolean(this.activeSession),
    });
  }

  disconnect(reason = 'User disconnected'): void {
    this.connectionGeneration += 1;
    this.cancelInFlightAndTimers();
    this.monitor.stop();
    this.intendedHostId = null;
    this.activeSession = null;
    this.retryCount = 0;
    this.backoffNextDelayMs = null;
    this.consecutiveActiveFailures = 0;
    this.failureCategory = 'none';
    this.lastErrorCode = null;
    this.lastErrorMessage = null;
    this.lastSelectionReason = reason;
    this.smartState = 'DISCONNECTED';
  }

  shutdown(): void {
    this.systemSuspended = false;
    this.disconnect('Application shutdown');
    this.unsubscribeMonitor();
    this.monitor.dispose();
  }

  /**
   * Pauses active retry/discovery timers when Windows enters Suspend so the client
   * does not burn reconnect attempts against a suspended network stack.
   */
  handleSystemSuspend(): void {
    this.systemSuspended = true;
    this.cancelInFlightAndTimers();
    this.monitor.stop();
  }

  /**
   * Re-evaluates network & active session safely after Windows resumes from Sleep,
   * without resurrecting disconnected Hosts or overriding security blocks.
   */
  handleSystemResume(): void {
    this.systemSuspended = false;
    if (!this.intendedHostId) {
      return;
    }
    if (this.smartState === 'SECURITY_BLOCKED' || this.smartState === 'ACCESS_REVOKED') {
      return;
    }
    this.lastTransportEvidenceAtMs = 0;
    this.monitor.start();
    this.monitor.notifyHint('recheck');
  }

  notifyEnrolledSession(session: PreparedTransportSession): void {
    this.connectionGeneration += 1;
    this.cancelInFlightAndTimers();
    this.intendedHostId = session.host.hostId.toLowerCase();
    this.selectedMode = session.host.connectionMode ?? 'automatic';
    this.activeSession = session;
    this.lanBlockedForSession = null;
    this.remoteBlockedForSession = null;
    this.retryCount = 0;
    this.backoffNextDelayMs = null;
    this.consecutiveActiveFailures = 0;
    this.identityOutcome = 'verified';
    this.authOutcome = 'authorized';
    this.failureCategory = 'none';
    this.lastSelectionReason = 'Initial LAN pairing completed';
    this.smartState = 'CONNECTED_LAN';
    this.refreshCandidateEligibilitySnapshot(this.intendedHostId);
    this.lanCandidate.availability = 'connected';
    this.lanCandidate.lastVerifiedAt = new Date(this.nowMs()).toISOString();
    this.monitor.start();
  }

  private beginNewOperation(hostId: string, preserveActiveSession: boolean): number {
    this.connectionGeneration += 1;
    this.attemptCounter += 1;
    this.currentAttemptId = `scm-${this.connectionGeneration}-${this.attemptCounter}`;
    this.cancelInFlightAndTimers();

    if (this.intendedHostId && this.intendedHostId !== hostId) {
      // Switching to a DIFFERENT remembered Host: clear old active session immediately
      const cleared = this.driver.clearActiveSession({
        smartState: 'CHECKING_NETWORK',
        errorCode: null,
        category: 'none',
        message: null,
      });
      this.streamsCancelledCount += cleared.streamsCancelled;
      this.activeSession = null;
      this.lastSwitchAtMs = null;
    } else if (!preserveActiveSession && this.activeSession) {
      this.activeSession = null;
    }

    this.intendedHostId = hostId;
    this.activeAbort = new AbortController();
    return this.connectionGeneration;
  }

  private cancelTimersOnly(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.lanConfirmTimer) {
      clearTimeout(this.lanConfirmTimer);
      this.lanConfirmTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.backoffNextDelayMs = null;
  }

  private cancelInFlightAndTimers(): void {
    this.cancelTimersOnly();
    if (this.activeAbort) {
      this.activeAbort.abort();
      this.activeAbort = null;
    }
  }

  private isCurrentGen(gen: number, signal?: AbortSignal): boolean {
    return gen === this.connectionGeneration && !signal?.aborted && this.intendedHostId !== null;
  }

  private refreshCandidateEligibilitySnapshot(hostId: string): StoredRememberedHost | null {
    const host = this.driver.findRememberedHost(hostId);
    if (!host) {
      this.lanCandidate.availability = 'unavailable';
      this.remoteCandidate.availability = 'unavailable';
      return null;
    }

    // 1. LAN Direct eligibility
    if (this.selectedMode === 'remote-only') {
      this.lanCandidate.availability = 'disallowed_by_mode';
      this.lanCandidate.detail = 'Chế độ Chỉ Remote đang bật.';
    } else if (this.lanBlockedForSession) {
      this.lanCandidate.availability =
        this.lanBlockedForSession.category === 'security'
          ? 'security_blocked'
          : 'missing_credentials';
      this.lanCandidate.detail = this.lanBlockedForSession.message;
    } else if (!this.driver.hasLanCredential(host)) {
      this.lanCandidate.availability = 'missing_credentials';
      this.lanCandidate.detail = 'Thiếu LAN token.';
    } else if (this.activeSession?.transport === 'lan-direct') {
      this.lanCandidate.availability = 'connected';
      this.lanCandidate.detail = `${host.lastAddress}:${host.port}`;
    } else {
      this.lanCandidate.availability = 'eligible';
      this.lanCandidate.detail = `${host.lastAddress}:${host.port}`;
    }

    // 2. Remote HTTPS eligibility
    if (this.selectedMode === 'lan-only') {
      this.remoteCandidate.availability = 'disallowed_by_mode';
      this.remoteCandidate.detail = 'Chế độ Chỉ LAN đang bật.';
    } else if (this.remoteBlockedForSession) {
      this.remoteCandidate.availability =
        this.remoteBlockedForSession.category === 'security'
          ? 'security_blocked'
          : 'permission_not_granted';
      this.remoteCandidate.detail = this.remoteBlockedForSession.message;
    } else {
      const descCheck = this.driver.inspectRemoteDescriptorEligibility(host);
      if (!descCheck.eligible) {
        this.remoteCandidate.availability = descCheck.availability;
        this.remoteCandidate.detail = descCheck.message ?? null;
      } else if (!this.driver.hasRemoteCredential(host)) {
        this.remoteCandidate.availability = 'permission_not_granted';
        this.remoteCandidate.detail = 'Chưa được cấp hoặc chưa đồng bộ Remote token.';
      } else if (this.activeSession?.transport === 'remote-https') {
        this.remoteCandidate.availability = 'connected';
        this.remoteCandidate.detail = host.remoteEndpoint?.publicOrigin ?? null;
      } else {
        this.remoteCandidate.availability = 'eligible';
        this.remoteCandidate.detail = host.remoteEndpoint?.publicOrigin ?? null;
      }
    }

    return host;
  }

  private async executeSelectionAttempt(
    gen: number,
    signal: AbortSignal,
    params: {
      hostId: string;
      mode: ConnectionSelectionMode;
      overrideEndpoint?: { address: string; port: number };
      isHandoverAttempt: boolean;
      reason: string;
    },
  ): Promise<void> {
    if (!this.isCurrentGen(gen, signal)) return;

    const handoverStartedMs = this.nowMs();
    const prevTransport = this.activeSession?.transport ?? null;
    const hadActiveSession = Boolean(this.activeSession);

    this.setSmartState(
      gen,
      params.isHandoverAttempt && hadActiveSession ? 'HANDOVER_PENDING' : 'CHECKING_NETWORK',
    );

    const netObs: NetworkObservationSnapshot = this.monitor.getCurrentSnapshot();
    const host = this.refreshCandidateEligibilitySnapshot(params.hostId);
    if (!host) {
      this.finishTerminal(
        gen,
        'HOST_UNAVAILABLE',
        'HOST_UNAVAILABLE',
        'recoverable_network',
        'Không tìm thấy thông tin Host đã lưu.',
      );
      return;
    }

    // -------------------------------------------------------------------------
    // STEP 1: Evaluate LAN Direct (if mode is 'automatic' or 'lan-only')
    // -------------------------------------------------------------------------
    let lanFailure: {
      code: ConnectErrorCode;
      category: ConnectionFailureCategory;
      message: string;
    } | null = null;

    if (params.mode === 'automatic' || params.mode === 'lan-only') {
      if (!this.driver.hasLanCredential(host)) {
        lanFailure = {
          code: 'AUTH_FAILED',
          category: 'authorization',
          message: 'Không tìm thấy thông tin xác thực LAN đã mã hóa cho Host này.',
        };
        this.lanCandidate.availability = 'missing_credentials';
      } else if (this.lanBlockedForSession) {
        lanFailure = this.lanBlockedForSession;
      } else {
        this.lanCandidate.availability = 'verifying';
        this.setSmartState(
          gen,
          hadActiveSession && params.isHandoverAttempt ? 'HANDOVER_IN_PROGRESS' : 'VERIFYING_LAN',
        );

        let lanRes = await this.driver.prepareLanTransport(host, signal, params.overrideEndpoint);
        if (!this.isCurrentGen(gen, signal)) return;

        // Secure mDNS LAN Host Rediscovery when old IP is unreachable (Section 11)
        if (
          !lanRes.ok &&
          lanRes.category === 'recoverable_network' &&
          !params.overrideEndpoint
        ) {
          this.setSmartState(gen, 'DISCOVERING_LAN');
          const candidates = await this.driver.discoverLanCandidates(host.hostId, signal);
          if (!this.isCurrentGen(gen, signal)) return;

          for (const cand of candidates) {
            if (cand.hostId.toLowerCase() !== host.hostId.toLowerCase()) {
              continue;
            }
            if (cand.address === host.lastAddress && cand.port === host.port) {
              continue;
            }
            this.setSmartState(gen, 'VERIFYING_LAN');
            const rediscoveredRes = await this.driver.prepareLanTransport(host, signal, {
              address: cand.address,
              port: cand.port,
            });
            if (!this.isCurrentGen(gen, signal)) return;
            if (rediscoveredRes.ok) {
              lanRes = rediscoveredRes;
              break;
            }
            if (rediscoveredRes.errorCode === 'ACCESS_REVOKED') {
              // Authentic SPKI-verified Host confirmed device revocation
              lanRes = rediscoveredRes;
              break;
            }
            // Note: An unauthenticated UDP mDNS spoof with mismatched TLS SPKI is rejected
            // without sending credentials and MUST NOT poison remaining mDNS candidates or Remote fallback.
          }
        }

        if (lanRes.ok) {
          this.commitSuccess(gen, lanRes.session, {
            prevTransport,
            hadActiveSession,
            handoverStartedMs,
            strategy: hadActiveSession && prevTransport === 'remote-https'
              ? 'make-before-break'
              : 'break-before-make',
            reason:
              params.mode === 'automatic'
                ? `Selected verified LAN Direct (${lanRes.session.verifiedAddress}:${lanRes.session.verifiedPort})`
                : `Connected via LAN Only (${lanRes.session.verifiedAddress}:${lanRes.session.verifiedPort})`,
          });
          return;
        }

        this.lanCandidate.consecutiveFailures += 1;
        this.lanCandidate.availability =
          lanRes.category === 'security' ? 'security_blocked' : 'unavailable';
        this.lanCandidate.detail = lanRes.message;
        lanFailure = {
          code: lanRes.errorCode,
          category: lanRes.category,
          message: lanRes.message,
        };

        // Security failure or full device revocation MUST NEVER fall back to Remote HTTPS!
        if (lanRes.category === 'security') {
          this.lanBlockedForSession = lanFailure;
          this.identityOutcome = 'failed';
          this.finishTerminal(
            gen,
            'SECURITY_BLOCKED',
            lanRes.errorCode,
            'security',
            lanRes.message,
          );
          return;
        }
        if (lanRes.errorCode === 'ACCESS_REVOKED') {
          this.authOutcome = 'revoked';
          this.finishTerminal(
            gen,
            'ACCESS_REVOKED',
            'ACCESS_REVOKED',
            'authorization',
            lanRes.message,
          );
          return;
        }

        if (params.mode === 'lan-only') {
          // LAN Only: strictly never attempt Remote HTTPS
          if (lanRes.category === 'authorization') {
            this.authOutcome = 'unauthorized';
            this.finishTerminal(
              gen,
              'AUTHORIZATION_REQUIRED',
              lanRes.errorCode,
              'authorization',
              lanRes.message,
            );
            return;
          }
          await this.handleRecoverableExhausted(gen, signal, {
            netObs,
            errorCode: lanRes.errorCode,
            message: lanRes.message,
          });
          return;
        }
      }
    }

    // -------------------------------------------------------------------------
    // STEP 2: Evaluate Remote HTTPS (if mode is 'automatic' or 'remote-only')
    // -------------------------------------------------------------------------
    const refreshedHost = this.driver.findRememberedHost(params.hostId) ?? host;
    const descEligibility = this.driver.inspectRemoteDescriptorEligibility(refreshedHost);

    if (!descEligibility.eligible) {
      const errCode = descEligibility.errorCode ?? 'REMOTE_ENDPOINT_NOT_CONFIGURED';
      const cat = descEligibility.category ?? 'authorization';
      const msg =
        descEligibility.message ??
        'Chưa đồng bộ cấu hình Remote HTTPS cho Host này.';

      this.remoteCandidate.availability = descEligibility.availability;
      this.remoteCandidate.detail = msg;

      if (cat === 'security') {
        this.identityOutcome = 'failed';
        this.finishTerminal(gen, 'SECURITY_BLOCKED', errCode, 'security', msg);
        return;
      }

      if (params.mode === 'remote-only') {
        this.authOutcome = 'unauthorized';
        this.finishTerminal(gen, 'AUTHORIZATION_REQUIRED', errCode, 'authorization', msg);
        return;
      }

      // Automatic mode: LAN failed with recoverable network error, and Remote is not configured/expired.
      if (errCode === 'REMOTE_ENDPOINT_EXPIRED') {
        this.finishTerminal(
          gen,
          'AUTHORIZATION_REQUIRED',
          'REMOTE_ENDPOINT_EXPIRED',
          'authorization',
          msg,
        );
        return;
      }
      await this.handleRecoverableExhausted(gen, signal, {
        netObs,
        errorCode: lanFailure?.code ?? errCode,
        message: lanFailure
          ? `${lanFailure.message} (Remote HTTPS chưa được cấu hình cho thiết bị này.)`
          : msg,
      });
      return;
    }

    if (!this.driver.hasRemoteCredential(refreshedHost)) {
      const msg =
        'Thiết bị này chưa được cấp quyền Truy cập từ xa (Remote HTTPS) hoặc chưa đồng bộ Remote token.';
      this.remoteCandidate.availability = 'permission_not_granted';
      this.remoteCandidate.detail = msg;
      if (params.mode === 'remote-only') {
        this.authOutcome = 'unauthorized';
        this.finishTerminal(
          gen,
          'AUTHORIZATION_REQUIRED',
          'REMOTE_ACCESS_NOT_GRANTED',
          'authorization',
          msg,
        );
        return;
      }
      await this.handleRecoverableExhausted(gen, signal, {
        netObs,
        errorCode: lanFailure?.code ?? 'REMOTE_ACCESS_NOT_GRANTED',
        message: lanFailure ? `${lanFailure.message} (${msg})` : msg,
      });
      return;
    }

    if (this.remoteBlockedForSession) {
      const blk = this.remoteBlockedForSession;
      if (params.mode === 'remote-only' || blk.category === 'security') {
        this.finishTerminal(
          gen,
          blk.category === 'security' ? 'SECURITY_BLOCKED' : 'AUTHORIZATION_REQUIRED',
          blk.code,
          blk.category,
          blk.message,
        );
        return;
      }
      await this.handleRecoverableExhausted(gen, signal, {
        netObs,
        errorCode: lanFailure?.code ?? blk.code,
        message: lanFailure?.message ?? blk.message,
      });
      return;
    }

    this.remoteCandidate.availability = 'verifying';
    this.setSmartState(
      gen,
      hadActiveSession && params.isHandoverAttempt ? 'HANDOVER_IN_PROGRESS' : 'VERIFYING_REMOTE',
    );

    const remRes = await this.driver.prepareRemoteTransport(refreshedHost, signal);
    if (!this.isCurrentGen(gen, signal)) return;

    if (remRes.ok) {
      this.commitSuccess(gen, remRes.session, {
        prevTransport,
        hadActiveSession,
        handoverStartedMs,
        strategy: 'break-before-make',
        reason:
          params.mode === 'automatic'
            ? 'LAN Direct unavailable; connected via verified Remote HTTPS'
            : 'Connected via Remote Only (Remote HTTPS)',
      });
      return;
    }

    this.remoteCandidate.consecutiveFailures += 1;
    this.remoteCandidate.availability =
      remRes.category === 'security'
        ? 'security_blocked'
        : remRes.category === 'authorization'
          ? 'permission_not_granted'
          : 'unavailable';
    this.remoteCandidate.detail = remRes.message;

    if (remRes.category === 'security') {
      this.remoteBlockedForSession = {
        code: remRes.errorCode,
        category: 'security',
        message: remRes.message,
      };
      this.identityOutcome = 'failed';
      this.finishTerminal(
        gen,
        'SECURITY_BLOCKED',
        remRes.errorCode,
        'security',
        remRes.message,
      );
      return;
    }

    if (remRes.errorCode === 'ACCESS_REVOKED') {
      this.authOutcome = 'revoked';
      this.finishTerminal(
        gen,
        'ACCESS_REVOKED',
        'ACCESS_REVOKED',
        'authorization',
        remRes.message,
      );
      return;
    }

    if (remRes.category === 'authorization') {
      this.remoteBlockedForSession = {
        code: remRes.errorCode,
        category: 'authorization',
        message: remRes.message,
      };
      this.authOutcome = 'unauthorized';
      if (params.mode === 'remote-only') {
        this.finishTerminal(
          gen,
          'AUTHORIZATION_REQUIRED',
          remRes.errorCode,
          'authorization',
          remRes.message,
        );
        return;
      }
    }

    await this.handleRecoverableExhausted(gen, signal, {
      netObs,
      errorCode: remRes.errorCode,
      message: remRes.message,
    });
  }

  private commitSuccess(
    gen: number,
    session: PreparedTransportSession,
    meta: {
      prevTransport: ConnectTransportMode | null;
      hadActiveSession: boolean;
      handoverStartedMs: number;
      strategy: 'make-before-break' | 'break-before-make';
      reason: string;
    },
  ): void {
    if (gen !== this.connectionGeneration) return;

    const now = this.nowMs();
    const nowIso = new Date(now).toISOString();
    const isTransportSwitch =
      meta.hadActiveSession &&
      meta.prevTransport !== null &&
      meta.prevTransport !== session.transport;
    const isSameTransportRecovery =
      meta.hadActiveSession && meta.prevTransport === session.transport;

    let handoverEvent: HandoverEventSummary | null = null;
    if (isTransportSwitch || isSameTransportRecovery) {
      this.handoverSeq += 1;
      handoverEvent = {
        handoverId: `ho-${gen}-${this.handoverSeq}`,
        handoverSeq: this.handoverSeq,
        hostId: session.host.hostId,
        fromTransport: meta.prevTransport,
        toTransport: session.transport,
        strategy: meta.strategy,
        reason: meta.reason,
        startedAt: new Date(meta.handoverStartedMs).toISOString(),
        completedAt: nowIso,
        durationMs: Math.max(0, now - meta.handoverStartedMs),
        streamsCancelled: 0,
        sourceConsistent: true,
        outcome: 'completed',
      };
    }

    const commitRes = this.driver.commitPreparedSession(session, {
      isHandover: Boolean(handoverEvent),
      fromTransport: meta.prevTransport,
      strategy: meta.strategy,
      reason: meta.reason,
      handoverEvent,
    });
    this.streamsCancelledCount += commitRes.streamsCancelled;

    if (handoverEvent) {
      handoverEvent.streamsCancelled = commitRes.streamsCancelled;
      this.lastHandoverSignal = handoverEvent;
      this.recentHandovers.unshift(handoverEvent);
      if (this.recentHandovers.length > MAX_RECENT_HANDOVERS) {
        this.recentHandovers.length = MAX_RECENT_HANDOVERS;
      }
      if (isTransportSwitch) {
        this.lastSwitchAtMs = now;
      }
    }

    this.activeSession = session;
    this.retryCount = 0;
    this.backoffNextDelayMs = null;
    this.consecutiveActiveFailures = 0;
    this.identityOutcome = 'verified';
    this.authOutcome = 'authorized';
    this.failureCategory = 'none';
    this.lastErrorCode = null;
    this.lastErrorMessage = null;
    this.lastSelectionReason = meta.reason;
    this.smartState =
      session.transport === 'lan-direct' ? 'CONNECTED_LAN' : 'CONNECTED_REMOTE';

    this.refreshCandidateEligibilitySnapshot(session.host.hostId);
    if (session.transport === 'lan-direct') {
      this.lanCandidate.availability = 'connected';
      this.lanCandidate.lastVerifiedAt = nowIso;
      this.lanCandidate.lastLatencyMs = session.latencyMs;
      this.lanCandidate.consecutiveFailures = 0;
    } else {
      this.remoteCandidate.availability = 'connected';
      this.remoteCandidate.lastVerifiedAt = nowIso;
      this.remoteCandidate.lastLatencyMs = session.latencyMs;
      this.remoteCandidate.consecutiveFailures = 0;
    }

    this.driver.onStateUpdated();
  }

  private async handleRecoverableExhausted(
    gen: number,
    signal: AbortSignal,
    params: {
      netObs: NetworkObservationSnapshot;
      errorCode: ConnectErrorCode;
      message: string;
    },
  ): Promise<void> {
    if (!this.isCurrentGen(gen, signal)) return;

    this.failureCategory = 'recoverable_network';
    this.lastErrorCode = params.errorCode;
    this.lastErrorMessage = params.message;

    // Clear active session transport credentials from hot path while keeping intendedHostId for auto-recovery
    if (this.activeSession) {
      const cleared = this.driver.clearActiveSession({
        smartState: 'RECONNECTING',
        errorCode: params.errorCode,
        category: 'recoverable_network',
        message: params.message,
      });
      this.streamsCancelledCount += cleared.streamsCancelled;
      this.activeSession = null;
    }

    if (!params.netObs.hasAnyExternalIpv4) {
      // Device has zero active network interfaces -> rest in NETWORK_UNAVAILABLE until OS network changes!
      this.backoffNextDelayMs = null;
      this.smartState = 'NETWORK_UNAVAILABLE';
      this.driver.clearActiveSession({
        smartState: 'NETWORK_UNAVAILABLE',
        errorCode: 'NETWORK_INTERRUPTED',
        category: 'recoverable_network',
        message: 'Thiết bị hiện không có kết nối mạng. Sẽ tự động kết nối lại khi có mạng.',
      });
      this.driver.onStateUpdated();
      return;
    }

    if (this.retryCount >= this.policy.maxAutoReconnectAttempts) {
      // Bounded retries reached: rest in HOST_UNAVAILABLE without infinite high-frequency polling!
      this.backoffNextDelayMs = null;
      this.smartState = 'HOST_UNAVAILABLE';
      this.driver.clearActiveSession({
        smartState: 'HOST_UNAVAILABLE',
        errorCode: 'HOST_UNAVAILABLE',
        category: 'recoverable_network',
        message: params.message,
      });
      this.driver.onStateUpdated();
      return;
    }

    this.retryCount += 1;
    const sched = this.policy.retryBackoffMs;
    const baseDelay = sched[Math.min(sched.length - 1, this.retryCount - 1)] ?? 8_000;
    const jitterFactor = this.policy.enableJitter ? 0.88 + Math.random() * 0.24 : 1;
    const delayMs = Math.max(50, Math.round(baseDelay * jitterFactor));
    this.backoffNextDelayMs = delayMs;
    this.smartState = 'RECONNECTING';

    this.driver.clearActiveSession({
      smartState: 'RECONNECTING',
      errorCode: params.errorCode,
      category: 'recoverable_network',
      message: `Đang thử kết nối lại (${this.retryCount}/${this.policy.maxAutoReconnectAttempts})...`,
    });
    this.driver.onStateUpdated();

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.isCurrentGen(gen, signal) || !this.intendedHostId) {
        return;
      }
      void this.executeSelectionAttempt(gen, signal, {
        hostId: this.intendedHostId,
        mode: this.selectedMode,
        isHandoverAttempt: true,
        reason: `Automatic reconnect attempt #${this.retryCount}`,
      });
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private finishTerminal(
    gen: number,
    state: SmartConnectionState,
    errorCode: ConnectErrorCode,
    category: ConnectionFailureCategory,
    message: string,
  ): void {
    if (gen !== this.connectionGeneration) return;
    this.cancelTimersOnly();
    this.activeSession = null;
    this.backoffNextDelayMs = null;
    this.failureCategory = category;
    this.lastErrorCode = errorCode;
    this.lastErrorMessage = message;
    this.smartState = state;

    if (category === 'security' || errorCode === 'ACCESS_REVOKED') {
      // Stop background network polling on security block or full revocation
      this.monitor.stop();
    }

    const cleared = this.driver.clearActiveSession({
      smartState: state,
      errorCode,
      category,
      message,
    });
    this.streamsCancelledCount += cleared.streamsCancelled;
    this.driver.onStateUpdated();
  }

  private blockSessionWithTerminalFailure(
    _transport: ConnectTransportMode,
    state: SmartConnectionState,
    errorCode: ConnectErrorCode,
    category: ConnectionFailureCategory,
    message: string,
  ): void {
    this.connectionGeneration += 1;
    const gen = this.connectionGeneration;
    this.cancelInFlightAndTimers();
    this.finishTerminal(gen, state, errorCode, category, message);
  }

  private async initiateEmergencyRecovery(reason: string): Promise<void> {
    if (!this.intendedHostId) return;
    const hostId = this.intendedHostId;
    // Emergency recovery bypasses non-essential switch cooldown!
    const gen = this.beginNewOperation(hostId, true);
    const signal = this.activeAbort!.signal;
    this.retryCount = 0;
    this.lastSelectionReason = reason;
    await this.executeSelectionAttempt(gen, signal, {
      hostId,
      mode: this.selectedMode,
      isHandoverAttempt: true,
      reason,
    });
  }

  private handleNetworkChangeEvent(ev: NetworkChangeEvent): void {
    if (!this.intendedHostId || this.systemSuspended) {
      return;
    }
    // Never auto-retry if blocked by Security or Full Device Revocation!
    if (
      this.smartState === 'SECURITY_BLOCKED' ||
      this.smartState === 'ACCESS_REVOKED' ||
      (this.smartState === 'AUTHORIZATION_REQUIRED' && this.selectedMode !== 'automatic')
    ) {
      return;
    }

    this.lastNetworkEvent = ev.kind;
    this.lastNetworkEventAt = new Date(ev.timestampMs).toISOString();

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.evaluateDebouncedNetworkChange(ev);
    }, this.policy.networkDebounceMs);
    this.debounceTimer.unref?.();
  }

  private async evaluateDebouncedNetworkChange(ev: NetworkChangeEvent): Promise<void> {
    if (!this.intendedHostId) return;
    const hostId = this.intendedHostId;

    if (ev.kind === 'network_disconnected' || (!ev.current.hasAnyExternalIpv4 && ev.kind === 'offline_hint')) {
      const gen = this.beginNewOperation(hostId, false);
      this.smartState = 'NETWORK_UNAVAILABLE';
      this.failureCategory = 'recoverable_network';
      this.lastErrorCode = 'NETWORK_INTERRUPTED';
      this.lastErrorMessage = 'Mất kết nối mạng trên thiết bị. Đang chờ mạng khôi phục...';
      if (gen === this.connectionGeneration) {
        const cleared = this.driver.clearActiveSession({
          smartState: 'NETWORK_UNAVAILABLE',
          errorCode: 'NETWORK_INTERRUPTED',
          category: 'recoverable_network',
          message: this.lastErrorMessage,
        });
        this.streamsCancelledCount += cleared.streamsCancelled;
        this.driver.onStateUpdated();
      }
      return;
    }

    // Case 1: Currently disconnected / reconnecting / unavailable -> immediately re-attempt from retry #0!
    if (!this.activeSession) {
      this.retryCount = 0;
      const gen = this.beginNewOperation(hostId, false);
      const signal = this.activeAbort!.signal;
      this.lastSelectionReason = `Network change (${ev.kind}) triggered automatic recovery`;
      await this.executeSelectionAttempt(gen, signal, {
        hostId,
        mode: this.selectedMode,
        isHandoverAttempt: true,
        reason: this.lastSelectionReason,
      });
      return;
    }

    // Case 2: Currently connected via LAN Direct and network / LAN IP changed -> lightweight health probe!
    if (this.activeSession.transport === 'lan-direct') {
      if (
        ev.kind === 'online_hint' &&
        ev.current.hasPrivateLanIpv4 &&
        this.nowMs() - this.lastTransportEvidenceAtMs < 2_000
      ) {
        // Fresh stream/request evidence (< 2s) already proved LAN Direct is healthy; skip duplicate probe
        return;
      }
      this.healthCheckCount += 1;
      const probeAbort = new AbortController();
      const health = await this.driver.probeActiveTransportHealth(
        this.activeSession,
        probeAbort.signal,
      );
      if (!this.intendedHostId || this.intendedHostId !== hostId) return;
      if (health.ok) {
        this.recordTransportSuccess('lan-direct');
        return;
      }
      // Active LAN broke on network transition (e.g. left home Wi-Fi -> mobile hotspot)!
      // Immediately recover (bypassing cooldown because active transport failed!).
      await this.initiateEmergencyRecovery(
        `LAN Direct unreachable after ${ev.kind}; recovering`,
      );
      return;
    }

    // Case 3: Currently connected via Remote HTTPS -> first verify Remote is still alive;
    // if Automatic mode & private LAN interface is present, schedule non-disruptive Make-Before-Break return to LAN!
    if (this.activeSession.transport === 'remote-https') {
      if (this.selectedMode === 'automatic' && ev.current.hasPrivateLanIpv4 && !this.lanBlockedForSession) {
        this.scheduleLanRecoveryConfirmation(`LAN interface detected (${ev.kind}) while on Remote HTTPS`);
      } else {
        this.healthCheckCount += 1;
        const probeAbort = new AbortController();
        const health = await this.driver.probeActiveTransportHealth(
          this.activeSession,
          probeAbort.signal,
        );
        if (!this.intendedHostId || this.intendedHostId !== hostId) return;
        if (!health.ok) {
          await this.initiateEmergencyRecovery(
            `Remote HTTPS interrupted after ${ev.kind}; recovering`,
          );
        }
      }
    }
  }

  private scheduleLanRecoveryConfirmation(reason: string): void {
    if (this.lanConfirmTimer) {
      clearTimeout(this.lanConfirmTimer);
      this.lanConfirmTimer = null;
    }

    const now = this.nowMs();
    const cooldownRemaining =
      this.lastSwitchAtMs !== null
        ? Math.max(0, this.lastSwitchAtMs + this.policy.switchCooldownMs - now)
        : 0;
    const waitMs = Math.max(this.policy.lanRecoveryConfirmMs, cooldownRemaining);

    this.lanConfirmTimer = setTimeout(() => {
      this.lanConfirmTimer = null;
      void this.tryProactiveReturnToLan(reason, false);
    }, waitMs);
    this.lanConfirmTimer.unref?.();
  }

  /**
   * Make-Before-Break proactive transition from healthy Remote HTTPS back to verified LAN Direct.
   * If LAN is NOT reachable or fails verification (except security mismatch), keeps Remote HTTPS uninterrupted!
   */
  private async tryProactiveReturnToLan(reason: string, bypassCooldown: boolean): Promise<void> {
    if (
      !this.intendedHostId ||
      this.selectedMode !== 'automatic' ||
      !this.activeSession ||
      this.activeSession.transport !== 'remote-https' ||
      this.lanBlockedForSession
    ) {
      return;
    }

    if (!bypassCooldown && this.lastSwitchAtMs !== null) {
      const elapsed = this.nowMs() - this.lastSwitchAtMs;
      if (elapsed < this.policy.switchCooldownMs) {
        this.scheduleLanRecoveryConfirmation(reason);
        return;
      }
    }

    const hostId = this.intendedHostId;
    const host = this.driver.findRememberedHost(hostId);
    if (!host || !this.driver.hasLanCredential(host)) {
      return;
    }

    const gen = this.connectionGeneration;
    const probeAbort = new AbortController();
    const startedMs = this.nowMs();

    // Verify LAN silently in background BEFORE disturbing the active Remote HTTPS stream!
    let lanRes = await this.driver.prepareLanTransport(host, probeAbort.signal);
    if (gen !== this.connectionGeneration || this.intendedHostId !== hostId) {
      return;
    }

    if (!lanRes.ok && lanRes.category === 'recoverable_network') {
      const candidates = await this.driver.discoverLanCandidates(host.hostId, probeAbort.signal);
      if (gen !== this.connectionGeneration || this.intendedHostId !== hostId) {
        return;
      }
      for (const cand of candidates) {
        if (cand.hostId.toLowerCase() !== host.hostId.toLowerCase()) continue;
        const rediscovered = await this.driver.prepareLanTransport(host, probeAbort.signal, {
          address: cand.address,
          port: cand.port,
        });
        if (gen !== this.connectionGeneration || this.intendedHostId !== hostId) return;
        if (rediscovered.ok || rediscovered.errorCode === 'ACCESS_REVOKED') {
          lanRes = rediscovered;
          break;
        }
      }
    }

    if (lanRes.ok) {
      // Make-before-break: LAN is 100% verified & ready -> atomically switch!
      this.commitSuccess(gen, lanRes.session, {
        prevTransport: 'remote-https',
        hadActiveSession: true,
        handoverStartedMs: startedMs,
        strategy: 'make-before-break',
        reason: `${reason} -> verified LAN Direct ready`,
      });
      return;
    }

    if (lanRes.errorCode === 'ACCESS_REVOKED') {
      this.authOutcome = 'revoked';
      this.finishTerminal(gen, 'ACCESS_REVOKED', 'ACCESS_REVOKED', 'authorization', lanRes.message);
      return;
    }

    // Foreign private LAN (even if another host on e.g. 192.168.1.x has a different TLS cert):
    // never send credentials to it, and keep the already-verified Remote HTTPS session uninterrupted!
    this.lanCandidate.availability = 'unavailable';
    this.lanCandidate.detail = 'Mạng LAN hiện tại không có Host này; giữ kết nối Remote HTTPS.';
    this.driver.onStateUpdated();
  }

  private setSmartState(gen: number, next: SmartConnectionState): void {
    if (gen !== this.connectionGeneration) return;
    if (this.smartState !== next) {
      this.smartState = next;
      this.driver.onStateUpdated();
    }
  }
}
