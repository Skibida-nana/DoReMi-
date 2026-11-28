import {
  isRemoteTrackId,
  mapRemoteTrackDtoToTrackRecord,
  parseRemoteTrackId,
} from '../../../shared/contracts/connect-api';
import { buildRemoteArtworkMediaUrl } from '../../../shared/contracts/media-protocol';
import type {
  ClientDiagnosticsSnapshot,
  ConnectClientSnapshot,
  ConnectionSelectionMode,
  DiscoveredHostRecord,
  EnrollmentInvitationSummary,
  HandoverEventSummary,
  HostPowerPolicy,
  HostProbeResult,
  HostSnapshot,
  RemoteAlbumDto,
  RemoteArtistDto,
  RemoteTrackDto,
  ScopedHostResourceBreakdown,
  SmartConnectionState,
} from '../../../shared/types/connect';
import type { LosslessDesktopApi } from '../../../shared/types/ipc';
import type { PlaybackContextDescriptor, PlaybackQueueEntry, PlaybackState } from '../../../shared/types/player';
import type { TrackRecord } from '../../../shared/types/track';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import type { PrototypeTrack } from '../data/prototype-catalog';
import type { PlaybackQueueController } from '../player/playback-queue';
import { formatTrackAudioSpecs } from '../utils/formatters';

export type ServerPageTab = 'overview' | 'shared' | 'devices' | 'connect' | 'resources' | 'diagnostics';
export type RemoteLibraryViewTab = 'tracks' | 'albums' | 'artists';

export interface ConnectStoreState {
  hostSnapshot: HostSnapshot | null;
  clientSnapshot: ConnectClientSnapshot | null;
  clientDiagnostics: ClientDiagnosticsSnapshot | null;
  lastInvitation: EnrollmentInvitationSummary | null;
  probeResult: HostProbeResult | null;
  isProbing: boolean;
  isLoadingHost: boolean;
  isLoadingClient: boolean;
  isLoadingRemoteLibrary: boolean;
  serverPageTab: ServerPageTab;
  remoteViewTab: RemoteLibraryViewTab;
  remoteTracks: RemoteTrackDto[];
  remoteTracksTotal: number;
  remoteTracksHasMore: boolean;
  remoteAlbums: RemoteAlbumDto[];
  remoteArtists: RemoteArtistDto[];
  remoteSearchInput: string;
  remoteSearchQuery: string;
  selectedRemoteAlbumKey: string | null;
  selectedRemoteArtist: string | null;
  remoteLibraryError: string | null;
  remoteLibraryLoadedHostId: string | null;
  actionError: string | null;
}

interface UnfilteredRemoteLibraryCache {
  hostId: string;
  summaryUpdatedAt: string | null;
  tracks: RemoteTrackDto[];
  total: number;
  hasMore: boolean;
  albums: RemoteAlbumDto[];
  artists: RemoteArtistDto[];
}

export interface ConnectStoreDependencies {
  getApi?: () => LosslessDesktopApi | undefined;
  queueController: Pick<
    PlaybackQueueController,
    'getState' | 'playTrackInCurrentOrNewContext' | 'removeTracksFromQueue'
  >;
  playbackActions: {
    playQueueEntry(entry: PlaybackQueueEntry): Promise<void>;
    getPlaybackState?: () => PlaybackState | null | undefined;
    pauseSilently(): void;
    setRemoteHandoverPendingPredicate?: (fn: ((trackId: string) => boolean) | undefined) => void;
    recoverCurrentTrackTransport?: (options: {
      expectedTrackId: string;
      targetTimeSeconds?: number;
      shouldPlay?: boolean;
      handoverSeq: number;
    }) => Promise<{ recovered: boolean; positionBeforeSec: number; positionAfterSec: number }>;
  };
}

const TRANSIENT_RECOVERY_SMART_STATES = new Set<SmartConnectionState>([
  'CHECKING_NETWORK',
  'DISCOVERING_LAN',
  'VERIFYING_LAN',
  'CONNECTING_LAN',
  'VERIFYING_REMOTE',
  'CONNECTING_REMOTE',
  'HANDOVER_PENDING',
  'HANDOVER_IN_PROGRESS',
  'RECONNECTING',
  'DEGRADED',
]);

export class ConnectStore {
  private state: ConnectStoreState = {
    hostSnapshot: null,
    clientSnapshot: null,
    clientDiagnostics: null,
    lastInvitation: null,
    probeResult: null,
    isProbing: false,
    isLoadingHost: false,
    isLoadingClient: false,
    isLoadingRemoteLibrary: false,
    serverPageTab: 'overview',
    remoteViewTab: 'tracks',
    remoteTracks: [],
    remoteTracksTotal: 0,
    remoteTracksHasMore: false,
    remoteAlbums: [],
    remoteArtists: [],
    remoteSearchInput: '',
    remoteSearchQuery: '',
    selectedRemoteAlbumKey: null,
    selectedRemoteArtist: null,
    remoteLibraryError: null,
    remoteLibraryLoadedHostId: null,
    actionError: null,
  };

  private readonly getApi: () => LosslessDesktopApi | undefined;
  private readonly queueController: ConnectStoreDependencies['queueController'];
  private readonly playbackActions: ConnectStoreDependencies['playbackActions'];

  private readonly listeners = new Set<() => void>();
  private initialized = false;
  private cleanups: Array<() => void> = [];
  private remoteTrackCache = new Map<string, TrackRecord>();
  private remoteSourceRevisionMap = new Map<string, string | null>();
  private defaultLibraryCache: UnfilteredRemoteLibraryCache | null = null;
  private libraryRequestSeq = 0;
  private lastHandledHandoverSeq = 0;
  private outageAutoPausedTrackId: string | null = null;
  private activeHandoverTrackId: string | null = null;
  private handoverGraceUntilMs = 0;

  constructor(deps: ConnectStoreDependencies) {
    this.getApi =
      deps.getApi ?? (() => (typeof window !== 'undefined' ? window.losslessApi : undefined));
    this.queueController = deps.queueController;
    this.playbackActions = deps.playbackActions;
    this.playbackActions.setRemoteHandoverPendingPredicate?.((trackId) =>
      this.isHandoverPendingForTrack(trackId),
    );
  }

  getSnapshot = (): ConnectStoreState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(partial: Partial<ConnectStoreState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) {
      listener();
    }
  }

  setServerPageTab(tab: ServerPageTab): void {
    if (this.state.serverPageTab !== tab) {
      this.setState({ serverPageTab: tab });
    }
  }

  setRemoteViewTab(viewTab: RemoteLibraryViewTab): void {
    if (this.state.remoteViewTab !== viewTab) {
      this.setState({ remoteViewTab: viewTab });
    }
  }

  /**
   * Synchronizes the visible search input field in store state across page unmounts (e.g. Now Playing -> Back).
   * If user clears an active search input to empty string, immediately restores the unfiltered library.
   */
  setRemoteSearchInput(value: string): void {
    const hadActiveQuery = this.state.remoteSearchQuery.length > 0;
    this.setState({ remoteSearchInput: value });
    if (hadActiveQuery && value.trim() === '') {
      void this.loadRemoteLibrary({ query: '' });
    }
  }

  async searchRemoteLibrary(rawQuery: string): Promise<void> {
    const trimmed = rawQuery.trim();
    this.setState({ remoteSearchInput: rawQuery });
    await this.loadRemoteLibrary({ query: trimmed });
  }

  async clearRemoteSearch(): Promise<void> {
    this.setState({ remoteSearchInput: '' });
    await this.loadRemoteLibrary({ query: '' });
  }

  async clearRemoteFilters(): Promise<void> {
    this.setState({ remoteSearchInput: '' });
    await this.loadRemoteLibrary({ query: '', albumKey: null, artist: null });
  }

  private resetRemoteLibraryState(clearHostCaches: boolean): void {
    this.libraryRequestSeq += 1;
    if (clearHostCaches) {
      this.defaultLibraryCache = null;
      this.remoteTrackCache.clear();
      this.remoteSourceRevisionMap.clear();
    }
    this.setState({
      isLoadingRemoteLibrary: false,
      remoteViewTab: 'tracks',
      remoteTracks: [],
      remoteTracksTotal: 0,
      remoteTracksHasMore: false,
      remoteAlbums: [],
      remoteArtists: [],
      remoteSearchInput: '',
      remoteSearchQuery: '',
      selectedRemoteAlbumKey: null,
      selectedRemoteArtist: null,
      remoteLibraryError: null,
      remoteLibraryLoadedHostId: null,
    });
  }

  private getLogicalHostId(snap: ConnectClientSnapshot | null | undefined): string | null {
    if (!snap) return null;
    return snap.activeHost?.hostId ?? snap.intendedHostId ?? null;
  }

  isExecutingPlaybackHandover(): boolean {
    return this.activeHandoverTrackId !== null;
  }

  isHandoverPendingForTrack(compositeId: string): boolean {
    const parsed = parseRemoteTrackId(compositeId);
    if (!parsed) return false;
    const snap = this.state.clientSnapshot;
    const logicalHostId = this.getLogicalHostId(snap);
    if (!snap || !logicalHostId || logicalHostId.toLowerCase() !== parsed.hostId.toLowerCase()) {
      return false;
    }
    if (
      this.activeHandoverTrackId === compositeId ||
      Date.now() < this.handoverGraceUntilMs
    ) {
      return true;
    }
    if (snap.status === 'reconnecting') {
      return true;
    }
    if (snap.smartState && TRANSIENT_RECOVERY_SMART_STATES.has(snap.smartState)) {
      return true;
    }
    return false;
  }

  private async executePlaybackHandover(handover: HandoverEventSummary): Promise<void> {
    if (!this.playbackActions.recoverCurrentTrackTransport) {
      return;
    }
    const initialPb = this.playbackActions.getPlaybackState?.();
    if (!initialPb?.currentTrackId || initialPb.status === 'idle' || initialPb.status === 'ended') {
      this.outageAutoPausedTrackId = null;
      this.activeHandoverTrackId = null;
      return;
    }
    const parsed = parseRemoteTrackId(initialPb.currentTrackId);
    if (!parsed || parsed.hostId.toLowerCase() !== handover.hostId.toLowerCase()) {
      this.activeHandoverTrackId = null;
      return;
    }

    const expectedCompositeId = initialPb.currentTrackId;
    this.activeHandoverTrackId = expectedCompositeId;
    this.handoverGraceUntilMs = Date.now() + 2_000;

    try {
      const initialShouldPlay =
        initialPb.status === 'playing' ||
        initialPb.status === 'loading' ||
        initialPb.status === 'error' ||
        this.outageAutoPausedTrackId === expectedCompositeId;
      const initialPositionSec = initialPb.currentTimeSeconds;

      const cachedTrack = this.remoteTrackCache.get(expectedCompositeId) ?? null;
      const expectedSourceRevision = this.remoteSourceRevisionMap.get(expectedCompositeId) ?? null;

      let sourceConsistent = true;
      const api = this.getApi();
      if (api?.connectVerifyTrackSource) {
        try {
          const verified = await api.connectVerifyTrackSource({
            hostId: parsed.hostId,
            trackId: parsed.trackId,
            expectedFileSize: cachedTrack?.file_size_bytes ?? null,
            expectedSourceRevision,
          });
          if (verified.missingOrUnshared) {
            this.outageAutoPausedTrackId = null;
            const curPb = this.playbackActions.getPlaybackState?.();
            if (curPb?.currentTrackId === expectedCompositeId) {
              this.playbackActions.pauseSilently();
            }
            this.setState({
              actionError: 'Bài hát hiện tại đã bị gỡ hoặc ngừng chia sẻ trên máy Host.',
            });
            return;
          }
          if (verified.updatedTrack) {
            this.cacheRemoteTrackDtos(parsed.hostId, [verified.updatedTrack]);
          }
          if (verified.ok && !verified.sourceConsistent) {
            sourceConsistent = false;
          }
        } catch {
          // Proceed with transport reload if lightweight metadata check fails transiently
        }
      }

      const latestPb = this.playbackActions.getPlaybackState?.();
      if (
        !latestPb ||
        latestPb.currentTrackId !== expectedCompositeId ||
        latestPb.status === 'idle' ||
        latestPb.status === 'ended'
      ) {
        this.outageAutoPausedTrackId = null;
        return;
      }

      const userPausedManually =
        latestPb.status === 'paused' && this.outageAutoPausedTrackId !== expectedCompositeId;
      const finalShouldPlay = userPausedManually ? false : initialShouldPlay;
      const targetTimeSeconds = sourceConsistent
        ? latestPb.status === 'playing'
          ? latestPb.currentTimeSeconds
          : initialPositionSec
        : 0;

      this.outageAutoPausedTrackId = null;

      const outcome = await this.playbackActions.recoverCurrentTrackTransport({
        expectedTrackId: expectedCompositeId,
        targetTimeSeconds,
        shouldPlay: finalShouldPlay,
        handoverSeq: handover.handoverSeq,
      });

      if (api?.connectRecordHandoverOutcome) {
        void api
          .connectRecordHandoverOutcome({
            handoverSeq: handover.handoverSeq,
            positionBeforeSec: targetTimeSeconds,
            positionAfterSec: outcome.recovered ? outcome.positionAfterSec : null,
          })
          .catch(() => {});
      }
      void this.refreshClientDiagnostics();
    } finally {
      this.activeHandoverTrackId = null;
      this.handoverGraceUntilMs = 0;
    }
  }

  private applyClientSnapshot(nextSnap: ConnectClientSnapshot): void {
    const prevSnap = this.state.clientSnapshot;
    const prevLogicalHostId =
      this.getLogicalHostId(prevSnap) ?? this.state.remoteLibraryLoadedHostId;
    const nextLogicalHostId = this.getLogicalHostId(nextSnap);

    this.setState({ clientSnapshot: nextSnap });

    // 1. Switched to a different Host -> clear previous Host's remote playback & library cache
    if (prevLogicalHostId && nextLogicalHostId && prevLogicalHostId !== nextLogicalHostId) {
      this.outageAutoPausedTrackId = null;
      this.clearRemotePlaybackState();
      this.resetRemoteLibraryState(true);
      return;
    }

    // 2. Explicit user disconnect (no intended Host)
    if (nextSnap.status === 'disconnected' && !nextLogicalHostId) {
      if (prevLogicalHostId || this.state.remoteTracks.length > 0 || this.remoteTrackCache.size > 0) {
        this.outageAutoPausedTrackId = null;
        this.clearRemotePlaybackState();
        this.resetRemoteLibraryState(true);
      }
      return;
    }

    // 3. Terminal security or full revocation failure -> wipe playback & library cache immediately
    if (
      nextSnap.smartState === 'ACCESS_REVOKED' ||
      nextSnap.smartState === 'SECURITY_BLOCKED' ||
      nextSnap.lastErrorCode === 'ACCESS_REVOKED' ||
      nextSnap.lastErrorCode === 'HOST_IDENTITY_MISMATCH' ||
      (nextSnap.status === 'error' &&
        nextSnap.activeHost === null &&
        nextSnap.lastErrorCode === 'AUTH_FAILED')
    ) {
      this.outageAutoPausedTrackId = null;
      this.clearRemotePlaybackState();
      this.resetRemoteLibraryState(true);
      return;
    }

    // 4. Mode-specific authorization block (e.g. Remote Only without Remote permission/descriptor)
    if (nextSnap.smartState === 'AUTHORIZATION_REQUIRED' && nextSnap.activeHost === null) {
      this.outageAutoPausedTrackId = null;
      const pb = this.playbackActions.getPlaybackState?.();
      if (pb?.currentTrackId && isRemoteTrackId(pb.currentTrackId)) {
        this.playbackActions.pauseSilently();
      }
      return;
    }

    // 5. Bounded retry exhaustion (HOST_UNAVAILABLE / NETWORK_UNAVAILABLE):
    //    Keep library, search/filters, and Queue intact, and transition stuck 'loading' cleanly to 'paused'
    if (
      nextSnap.smartState === 'HOST_UNAVAILABLE' ||
      nextSnap.smartState === 'NETWORK_UNAVAILABLE'
    ) {
      const pb = this.playbackActions.getPlaybackState?.();
      if (pb?.currentTrackId && pb.status === 'loading') {
        const parsed = parseRemoteTrackId(pb.currentTrackId);
        if (
          parsed &&
          nextLogicalHostId &&
          parsed.hostId.toLowerCase() === nextLogicalHostId.toLowerCase()
        ) {
          this.outageAutoPausedTrackId = pb.currentTrackId;
          this.playbackActions.pauseSilently();
        }
      }
      return;
    }

    // 6. Connected state: invalidate unfiltered cache if Host library summary updatedAt changed
    const nextActiveHostId = nextSnap.activeHost?.hostId ?? null;
    if (
      this.defaultLibraryCache &&
      nextActiveHostId === this.defaultLibraryCache.hostId &&
      nextSnap.summary?.updatedAt &&
      this.defaultLibraryCache.summaryUpdatedAt &&
      nextSnap.summary.updatedAt !== this.defaultLibraryCache.summaryUpdatedAt
    ) {
      this.defaultLibraryCache = null;
    }

    if (
      nextSnap.smartState === 'HANDOVER_PENDING' ||
      nextSnap.smartState === 'HANDOVER_IN_PROGRESS' ||
      nextSnap.smartState === 'RECONNECTING'
    ) {
      this.handoverGraceUntilMs = Date.now() + 1_000;
    }

    // 7. Execute playback-aware handover recovery if SmartConnectionManager completed a handover
    if (
      nextSnap.status === 'connected' &&
      nextSnap.handoverSignal &&
      nextSnap.handoverSignal.handoverSeq > this.lastHandledHandoverSeq
    ) {
      this.lastHandledHandoverSeq = nextSnap.handoverSignal.handoverSeq;
      const curTrackId = this.playbackActions.getPlaybackState?.()?.currentTrackId ?? null;
      if (curTrackId && isRemoteTrackId(curTrackId)) {
        this.activeHandoverTrackId = curTrackId;
        this.handoverGraceUntilMs = Date.now() + 2_000;
      }
      void this.executePlaybackHandover(nextSnap.handoverSignal);
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    const api = this.getApi();
    if (!api?.connectGetHostSnapshot || !api?.connectGetClientSnapshot) {
      return;
    }

    if (api.onConnectHostStateChanged) {
      this.cleanups.push(
        api.onConnectHostStateChanged((hostSnapshot) => {
          this.setState({
            hostSnapshot,
            lastInvitation: hostSnapshot.activeInvitation ?? this.state.lastInvitation,
          });
        }),
      );
    }

    if (api.onConnectClientStateChanged) {
      this.cleanups.push(
        api.onConnectClientStateChanged((clientSnapshot) => {
          this.applyClientSnapshot(clientSnapshot);
        }),
      );
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onOnline = (): void => {
        if (this.getLogicalHostId(this.state.clientSnapshot)) {
          void this.getApi()?.connectNotifyNetworkHint?.('online').catch(() => {});
        }
      };
      const onOffline = (): void => {
        if (this.getLogicalHostId(this.state.clientSnapshot)) {
          void this.getApi()?.connectNotifyNetworkHint?.('offline').catch(() => {});
        }
      };
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      this.cleanups.push(() => {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      });
    }

    await this.refreshSnapshots();
  }

  async refreshSnapshots(): Promise<void> {
    const api = this.getApi();
    if (!api?.connectGetHostSnapshot || !api?.connectGetClientSnapshot) {
      return;
    }
    this.setState({ isLoadingHost: true, isLoadingClient: true, actionError: null });
    try {
      const [hostSnapshot, clientSnapshot, clientDiagnostics] = await Promise.all([
        api.connectGetHostSnapshot(),
        api.connectGetClientSnapshot(),
        api.connectGetClientDiagnostics ? api.connectGetClientDiagnostics() : Promise.resolve(null),
      ]);
      this.setState({
        hostSnapshot,
        clientDiagnostics,
        lastInvitation: hostSnapshot.activeInvitation,
        isLoadingHost: false,
        isLoadingClient: false,
      });
      this.applyClientSnapshot(clientSnapshot);
    } catch (err) {
      this.setState({
        isLoadingHost: false,
        isLoadingClient: false,
        actionError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Host Actions
  // ---------------------------------------------------------------------------

  async startHost(): Promise<void> {
    const api = this.getApi();
    if (!api?.connectStartHost) return;
    this.setState({ isLoadingHost: true, actionError: null });
    try {
      const hostSnapshot = await api.connectStartHost();
      this.setState({ hostSnapshot, isLoadingHost: false });
    } catch (err) {
      this.setState({
        isLoadingHost: false,
        actionError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async stopHost(): Promise<void> {
    const api = this.getApi();
    if (!api?.connectStopHost) return;
    this.setState({ isLoadingHost: true, actionError: null });
    try {
      const hostSnapshot = await api.connectStopHost();
      this.setState({ hostSnapshot, isLoadingHost: false });
    } catch (err) {
      this.setState({
        isLoadingHost: false,
        actionError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async updateHostConfig(patch: {
    autoStart?: boolean;
    displayName?: string;
    port?: number;
    maxActiveClients?: number;
    powerPolicy?: HostPowerPolicy;
  }): Promise<void> {
    const api = this.getApi();
    if (!api?.connectUpdateHostConfig) return;
    try {
      const hostSnapshot = await api.connectUpdateHostConfig(patch);
      this.setState({ hostSnapshot, actionError: null });
    } catch (err) {
      this.setState({ actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  async setHostPowerPolicy(policy: HostPowerPolicy): Promise<void> {
    const api = this.getApi();
    try {
      if (api?.connectSetHostPowerPolicy) {
        const hostSnapshot = await api.connectSetHostPowerPolicy(policy);
        this.setState({ hostSnapshot, actionError: null });
        return;
      }
      await this.updateHostConfig({ powerPolicy: policy });
    } catch (err) {
      this.setState({ actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  async getHostResourceBreakdown(options?: {
    includeTailscaleProcesses?: boolean;
  }): Promise<ScopedHostResourceBreakdown | null> {
    const api = this.getApi();
    if (!api?.connectGetHostResourceBreakdown) {
      return null;
    }
    return api.connectGetHostResourceBreakdown(options);
  }

  async addSharedSource(rootId: string): Promise<void> {
    const api = this.getApi();
    if (!api?.connectAddSharedSource) return;
    const hostSnapshot = await api.connectAddSharedSource(rootId);
    this.setState({ hostSnapshot });
  }

  async removeSharedSource(rootId: string): Promise<void> {
    const api = this.getApi();
    if (!api?.connectRemoveSharedSource) return;
    const hostSnapshot = await api.connectRemoveSharedSource(rootId);
    this.setState({ hostSnapshot });
  }

  async createInvitation(autoApproveSingleUse = false): Promise<EnrollmentInvitationSummary | null> {
    const api = this.getApi();
    if (!api?.connectCreateInvitation) return null;
    try {
      const inv = await api.connectCreateInvitation({ autoApproveSingleUse });
      await this.refreshSnapshots();
      this.setState({ lastInvitation: inv, actionError: null });
      return inv;
    } catch (err) {
      this.setState({ actionError: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  async revokeInvitation(): Promise<void> {
    const api = this.getApi();
    if (!api?.connectRevokeInvitation) return;
    const hostSnapshot = await api.connectRevokeInvitation();
    this.setState({ hostSnapshot, lastInvitation: null });
  }

  async approveEnrollment(requestId: string): Promise<void> {
    const api = this.getApi();
    if (!api?.connectApproveEnrollment) return;
    const hostSnapshot = await api.connectApproveEnrollment(requestId);
    this.setState({ hostSnapshot });
  }

  async rejectEnrollment(requestId: string): Promise<void> {
    const api = this.getApi();
    if (!api?.connectRejectEnrollment) return;
    const hostSnapshot = await api.connectRejectEnrollment(requestId);
    this.setState({ hostSnapshot });
  }

  async renameDevice(deviceId: string, displayName: string): Promise<void> {
    const api = this.getApi();
    if (!api?.connectRenameDevice) return;
    const hostSnapshot = await api.connectRenameDevice(deviceId, displayName);
    this.setState({ hostSnapshot });
  }

  async disconnectDevice(deviceId: string): Promise<void> {
    const api = this.getApi();
    if (!api?.connectDisconnectDevice) return;
    const hostSnapshot = await api.connectDisconnectDevice(deviceId);
    this.setState({ hostSnapshot });
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const api = this.getApi();
    if (!api?.connectRevokeDevice) return;
    const hostSnapshot = await api.connectRevokeDevice(deviceId);
    this.setState({ hostSnapshot });
  }

  async removeDevice(deviceId: string): Promise<void> {
    const api = this.getApi();
    if (!api?.connectRemoveDevice) return;
    const hostSnapshot = await api.connectRemoveDevice(deviceId);
    this.setState({ hostSnapshot });
  }

  async setDeviceRemoteAccess(deviceId: string, enabled: boolean): Promise<void> {
    const api = this.getApi();
    if (!api?.connectSetDeviceRemoteAccess) return;
    try {
      const hostSnapshot = await api.connectSetDeviceRemoteAccess(deviceId, enabled);
      this.setState({ hostSnapshot, actionError: null });
    } catch (err) {
      this.setState({ actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  async checkRemoteProvider(): Promise<void> {
    const api = this.getApi();
    if (!api?.connectCheckRemoteProvider) return;
    this.setState({ isLoadingHost: true, actionError: null });
    try {
      const hostSnapshot = await api.connectCheckRemoteProvider();
      this.setState({ hostSnapshot, isLoadingHost: false });
    } catch (err) {
      this.setState({
        isLoadingHost: false,
        actionError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async enableRemoteAccess(options?: {
    confirmPublicExposure?: boolean;
    preferredPublicPort?: 443 | 8443 | 10000;
  }): Promise<void> {
    const api = this.getApi();
    if (!api?.connectEnableRemoteAccess) return;
    this.setState({ isLoadingHost: true, actionError: null });
    try {
      const hostSnapshot = await api.connectEnableRemoteAccess(options);
      this.setState({ hostSnapshot, isLoadingHost: false });
    } catch (err) {
      this.setState({
        isLoadingHost: false,
        actionError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async disableRemoteAccess(): Promise<void> {
    const api = this.getApi();
    if (!api?.connectDisableRemoteAccess) return;
    this.setState({ isLoadingHost: true, actionError: null });
    try {
      const hostSnapshot = await api.connectDisableRemoteAccess();
      this.setState({ hostSnapshot, isLoadingHost: false });
    } catch (err) {
      this.setState({
        isLoadingHost: false,
        actionError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async rotateHostIdentity(): Promise<void> {
    const api = this.getApi();
    if (!api?.connectRotateHostIdentity) return;
    this.setState({ isLoadingHost: true, actionError: null });
    try {
      const hostSnapshot = await api.connectRotateHostIdentity();
      this.setState({ hostSnapshot, isLoadingHost: false });
    } catch (err) {
      this.setState({
        isLoadingHost: false,
        actionError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Client Actions & Remote Library Browsing
  // ---------------------------------------------------------------------------

  async discoverHosts(): Promise<DiscoveredHostRecord[]> {
    const api = this.getApi();
    if (!api?.connectDiscoverHosts) return [];
    const found = await api.connectDiscoverHosts(1500);
    if (api.connectGetClientSnapshot) {
      const clientSnapshot = await api.connectGetClientSnapshot();
      this.applyClientSnapshot(clientSnapshot);
    }
    return found;
  }

  async probeHost(address: string, port: number): Promise<HostProbeResult | null> {
    const api = this.getApi();
    if (!api?.connectProbeHost) return null;
    this.setState({ isProbing: true, probeResult: null, actionError: null });
    try {
      const probeResult = await api.connectProbeHost(address, port);
      this.setState({ isProbing: false, probeResult });
      return probeResult;
    } catch (err) {
      this.setState({
        isProbing: false,
        actionError: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  clearProbeResult(): void {
    this.setState({ probeResult: null });
  }

  async enrollWithHost(input: {
    address: string;
    port: number;
    expectedFingerprintSha256: string;
    inviteCode: string;
    deviceName: string;
  }): Promise<ConnectClientSnapshot | null> {
    const api = this.getApi();
    if (!api?.connectEnrollWithHost) return null;
    this.setState({ isLoadingClient: true, actionError: null });
    try {
      const clientSnapshot = await api.connectEnrollWithHost(input);
      this.setState({ isLoadingClient: false });
      this.applyClientSnapshot(clientSnapshot);
      if (clientSnapshot.status === 'connected') {
        await this.loadRemoteLibrary({ query: '', albumKey: null, artist: null, forceRefresh: true });
      }
      return clientSnapshot;
    } catch (err) {
      this.setState({
        isLoadingClient: false,
        actionError: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async enrollFromPairingPayload(input: {
    rawPayload: string;
    deviceName: string;
  }): Promise<ConnectClientSnapshot | null> {
    const api = this.getApi();
    if (!api?.connectEnrollFromPairingPayload) return null;
    this.setState({ isLoadingClient: true, actionError: null });
    try {
      const clientSnapshot = await api.connectEnrollFromPairingPayload(input);
      this.setState({ isLoadingClient: false });
      this.applyClientSnapshot(clientSnapshot);
      if (clientSnapshot.status === 'connected') {
        await this.loadRemoteLibrary({ query: '', albumKey: null, artist: null, forceRefresh: true });
      }
      return clientSnapshot;
    } catch (err) {
      this.setState({
        isLoadingClient: false,
        actionError: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async rotateActiveHostToken(): Promise<ConnectClientSnapshot | null> {
    const api = this.getApi();
    if (!api?.connectRotateHostToken) return null;
    this.setState({ isLoadingClient: true, actionError: null });
    try {
      const clientSnapshot = await api.connectRotateHostToken();
      this.setState({ isLoadingClient: false });
      this.applyClientSnapshot(clientSnapshot);
      await this.refreshClientDiagnostics();
      return clientSnapshot;
    } catch (err) {
      this.setState({
        isLoadingClient: false,
        actionError: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async connectToRememberedHost(
    hostId: string,
    overrideAddress?: string,
    overridePort?: number,
    explicitMode?: 'lan-direct' | 'remote-https',
  ): Promise<void> {
    const api = this.getApi();
    if (!api?.connectToRememberedHost) return;
    if (this.state.clientSnapshot?.activeHost?.hostId !== hostId) {
      this.resetRemoteLibraryState(true);
    }
    this.setState({ isLoadingClient: true, actionError: null });
    try {
      const clientSnapshot = await api.connectToRememberedHost(
        hostId,
        overrideAddress,
        overridePort,
        explicitMode,
      );
      this.setState({ isLoadingClient: false });
      this.applyClientSnapshot(clientSnapshot);
      if (clientSnapshot.status === 'connected') {
        await this.loadRemoteLibrary({ query: '', albumKey: null, artist: null, forceRefresh: true });
      }
    } catch (err) {
      this.setState({
        isLoadingClient: false,
        actionError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async syncRemoteAccessOverLan(hostId: string): Promise<void> {
    const api = this.getApi();
    if (!api?.connectSyncRemoteAccess) return;
    this.setState({ isLoadingClient: true, actionError: null });
    try {
      const clientSnapshot = await api.connectSyncRemoteAccess(hostId);
      this.setState({ isLoadingClient: false });
      this.applyClientSnapshot(clientSnapshot);
    } catch (err) {
      this.setState({
        isLoadingClient: false,
        actionError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async setConnectionMode(hostId: string, mode: ConnectionSelectionMode): Promise<void> {
    const api = this.getApi();
    if (api?.connectSetConnectionMode) {
      this.setState({ isLoadingClient: true, actionError: null });
      try {
        const clientSnapshot = await api.connectSetConnectionMode(hostId, mode);
        this.setState({ isLoadingClient: false });
        this.applyClientSnapshot(clientSnapshot);
        if (
          clientSnapshot.status === 'connected' &&
          clientSnapshot.activeHost?.hostId === hostId &&
          this.state.remoteLibraryLoadedHostId !== hostId
        ) {
          await this.loadRemoteLibrary({ query: '', albumKey: null, artist: null });
        }
      } catch (err) {
        this.setState({
          isLoadingClient: false,
          actionError: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (mode !== 'automatic') {
      await this.setPreferredTransport(
        hostId,
        mode === 'remote-only' ? 'remote-https' : 'lan-direct',
      );
    }
  }

  async manualReconnect(): Promise<void> {
    const api = this.getApi();
    if (!api?.connectManualReconnect) {
      const fallbackHostId = this.getLogicalHostId(this.state.clientSnapshot);
      if (fallbackHostId) {
        await this.connectToRememberedHost(fallbackHostId);
      }
      return;
    }
    this.setState({ isLoadingClient: true, actionError: null });
    try {
      const clientSnapshot = await api.connectManualReconnect();
      this.setState({ isLoadingClient: false });
      this.applyClientSnapshot(clientSnapshot);
      if (
        clientSnapshot.status === 'connected' &&
        clientSnapshot.activeHost &&
        this.state.remoteLibraryLoadedHostId !== clientSnapshot.activeHost.hostId
      ) {
        await this.loadRemoteLibrary({ query: '', albumKey: null, artist: null });
      }
    } catch (err) {
      this.setState({
        isLoadingClient: false,
        actionError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async setPreferredTransport(
    hostId: string,
    mode: 'lan-direct' | 'remote-https',
  ): Promise<void> {
    const api = this.getApi();
    if (!api?.connectSetPreferredTransport) return;
    const clientSnapshot = await api.connectSetPreferredTransport(hostId, mode);
    this.applyClientSnapshot(clientSnapshot);
  }

  async disconnectClient(): Promise<void> {
    const api = this.getApi();
    this.outageAutoPausedTrackId = null;
    this.clearRemotePlaybackState();
    this.resetRemoteLibraryState(true);
    if (!api?.connectDisconnectClient) return;
    const clientSnapshot = await api.connectDisconnectClient();
    this.applyClientSnapshot(clientSnapshot);
  }

  async removeRememberedHost(hostId: string): Promise<void> {
    const api = this.getApi();
    if (!api?.connectRemoveRememberedHost) return;
    const wasActive = this.getLogicalHostId(this.state.clientSnapshot) === hostId;
    if (wasActive) {
      this.outageAutoPausedTrackId = null;
      this.clearRemotePlaybackState();
      this.resetRemoteLibraryState(true);
    }
    const clientSnapshot = await api.connectRemoveRememberedHost(hostId);
    this.applyClientSnapshot(clientSnapshot);
  }

  private cacheRemoteTrackDtos(hostId: string, items: readonly RemoteTrackDto[]): void {
    for (const dto of items) {
      const fullUrl = dto.hasArtwork
        ? buildRemoteArtworkMediaUrl(hostId, dto.trackId, 'full', dto.artworkHash)
        : null;
      const thumbUrl = dto.hasArtwork
        ? buildRemoteArtworkMediaUrl(hostId, dto.trackId, 'thumb', dto.artworkHash)
        : null;
      const record = mapRemoteTrackDtoToTrackRecord(hostId, dto, {
        fullUrl,
        thumbUrl,
      });
      this.remoteTrackCache.set(record.id, record);
      this.remoteSourceRevisionMap.set(record.id, dto.sourceRevision ?? null);
    }
  }

  async loadRemoteLibrary(options?: {
    query?: string;
    albumKey?: string | null;
    artist?: string | null;
    append?: boolean;
    forceRefresh?: boolean;
  }): Promise<void> {
    const api = this.getApi();
    const activeHost = this.state.clientSnapshot?.activeHost;
    if (
      !api?.connectListRemoteTracks ||
      !api?.connectListRemoteAlbums ||
      !api?.connectListRemoteArtists ||
      !activeHost
    ) {
      return;
    }

    const query =
      options?.query !== undefined ? options.query.trim() : this.state.remoteSearchQuery;
    const albumKey =
      options?.albumKey !== undefined ? options.albumKey : this.state.selectedRemoteAlbumKey;
    const artist =
      options?.artist !== undefined ? options.artist : this.state.selectedRemoteArtist;

    const filterChanged =
      query !== this.state.remoteSearchQuery ||
      albumKey !== this.state.selectedRemoteAlbumKey ||
      artist !== this.state.selectedRemoteArtist ||
      this.state.remoteLibraryLoadedHostId !== activeHost.hostId;

    // Pagination ALWAYS resets when query/filter/Host changes
    const shouldAppend = Boolean(options?.append) && !filterChanged;
    const offset = shouldAppend ? this.state.remoteTracks.length : 0;
    const isUnfiltered = query === '' && !albumKey && !artist;

    // Fast path: restore cached unfiltered baseline for this Host with ZERO extra network requests
    if (
      isUnfiltered &&
      !shouldAppend &&
      !options?.forceRefresh &&
      this.defaultLibraryCache &&
      this.defaultLibraryCache.hostId === activeHost.hostId
    ) {
      this.libraryRequestSeq += 1;
      this.cacheRemoteTrackDtos(activeHost.hostId, this.defaultLibraryCache.tracks);
      this.setState({
        isLoadingRemoteLibrary: false,
        remoteLibraryError: null,
        actionError: null,
        remoteSearchInput: '',
        remoteSearchQuery: '',
        selectedRemoteAlbumKey: null,
        selectedRemoteArtist: null,
        remoteTracks: this.defaultLibraryCache.tracks,
        remoteTracksTotal: this.defaultLibraryCache.total,
        remoteTracksHasMore: this.defaultLibraryCache.hasMore,
        remoteAlbums: this.defaultLibraryCache.albums,
        remoteArtists: this.defaultLibraryCache.artists,
        remoteLibraryLoadedHostId: activeHost.hostId,
      });
      return;
    }

    const requestSeq = ++this.libraryRequestSeq;
    const requestHostId = activeHost.hostId;
    const shouldFetchCollections =
      !shouldAppend &&
      (query !== this.state.remoteSearchQuery ||
        options?.forceRefresh === true ||
        this.state.remoteLibraryLoadedHostId !== requestHostId ||
        (this.state.remoteAlbums.length === 0 && this.state.remoteArtists.length === 0));

    this.setState({
      isLoadingRemoteLibrary: true,
      remoteSearchInput: query,
      remoteSearchQuery: query,
      selectedRemoteAlbumKey: albumKey,
      selectedRemoteArtist: artist,
      remoteLibraryError: null,
      actionError: null,
      ...(!shouldAppend ? { remoteTracksHasMore: false } : {}),
    });

    try {
      const [tracksPage, albumsPage, artistsPage] = await Promise.all([
        api.connectListRemoteTracks({
          offset,
          limit: 100,
          query: query || undefined,
          albumKey: albumKey || undefined,
          artist: artist || undefined,
        }),
        shouldFetchCollections
          ? api.connectListRemoteAlbums({ offset: 0, limit: 100, query: query || undefined })
          : Promise.resolve(null),
        shouldFetchCollections
          ? api.connectListRemoteArtists({ offset: 0, limit: 100, query: query || undefined })
          : Promise.resolve(null),
      ]);

      // Guard against out-of-order responses or Host switch/disconnect while awaiting
      if (
        requestSeq !== this.libraryRequestSeq ||
        this.state.clientSnapshot?.activeHost?.hostId !== requestHostId
      ) {
        return;
      }

      const nextTracks = shouldAppend
        ? [...this.state.remoteTracks, ...tracksPage.items]
        : tracksPage.items;

      this.cacheRemoteTrackDtos(requestHostId, tracksPage.items);

      const nextAlbums = albumsPage ? albumsPage.items : this.state.remoteAlbums;
      const nextArtists = artistsPage ? artistsPage.items : this.state.remoteArtists;

      if (isUnfiltered && !shouldAppend) {
        this.defaultLibraryCache = {
          hostId: requestHostId,
          summaryUpdatedAt: this.state.clientSnapshot?.summary?.updatedAt ?? null,
          tracks: nextTracks,
          total: tracksPage.total,
          hasMore: tracksPage.hasMore,
          albums: nextAlbums,
          artists: nextArtists,
        };
      } else if (isUnfiltered && shouldAppend && this.defaultLibraryCache?.hostId === requestHostId) {
        this.defaultLibraryCache = {
          ...this.defaultLibraryCache,
          tracks: nextTracks,
          total: tracksPage.total,
          hasMore: tracksPage.hasMore,
        };
      }

      this.setState({
        isLoadingRemoteLibrary: false,
        remoteLibraryError: null,
        remoteLibraryLoadedHostId: requestHostId,
        remoteTracks: nextTracks,
        remoteTracksTotal: tracksPage.total,
        remoteTracksHasMore: tracksPage.hasMore,
        ...(albumsPage ? { remoteAlbums: albumsPage.items } : {}),
        ...(artistsPage ? { remoteArtists: artistsPage.items } : {}),
      });
    } catch (err) {
      if (
        requestSeq !== this.libraryRequestSeq ||
        this.state.clientSnapshot?.activeHost?.hostId !== requestHostId
      ) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.setState({
        isLoadingRemoteLibrary: false,
        remoteLibraryError: message,
        actionError: message,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Remote Playback Source Adapter Helpers
  // ---------------------------------------------------------------------------

  getRemoteTrackRecord(compositeId: string): TrackRecord | null {
    return this.remoteTrackCache.get(compositeId) ?? null;
  }

  isRemoteTrackPlayable(compositeId: string): boolean {
    const snap = this.state.clientSnapshot;
    if (!snap) {
      return false;
    }
    const parsed = parseRemoteTrackId(compositeId);
    if (!parsed) {
      return false;
    }
    const logicalHostId = this.getLogicalHostId(snap);
    const isSameConnectedHost =
      snap.status === 'connected' && snap.activeHost?.hostId === parsed.hostId;
    const isSameTransientHost =
      Boolean(logicalHostId && logicalHostId === parsed.hostId) &&
      this.isHandoverPendingForTrack(compositeId);
    if (!isSameConnectedHost && !isSameTransientHost) {
      return false;
    }
    const track = this.remoteTrackCache.get(compositeId);
    return Boolean(track && track.status === 'available');
  }

  getCoverForTrack(compositeId: string, size: 'full' | 'thumb' = 'full'): string {
    const rec = this.remoteTrackCache.get(compositeId);
    if (!rec) {
      return DEFAULT_DOREMI_ARTWORK_URL;
    }
    const url =
      size === 'thumb'
        ? rec.artwork_thumb_url ?? rec.artwork_url
        : rec.artwork_url ?? rec.artwork_thumb_url;
    return url || DEFAULT_DOREMI_ARTWORK_URL;
  }

  getPrototypeTrack(compositeId: string): PrototypeTrack | null {
    const t = this.remoteTrackCache.get(compositeId);
    if (!t) return null;
    const durationSec = t.duration_ms ? Math.round(t.duration_ms / 1000) : 0;
    return {
      id: t.id,
      albumId: `remote-album-${t.album ?? 'unknown'}`,
      title: t.title,
      artist: t.artist || 'Unknown Artist',
      albumTitle: t.album ?? 'Không rõ Album',
      albumArtist: t.album_artist ?? null,
      trackNumber: t.track_number ?? 1,
      trackTotal: t.track_total ?? null,
      discNumber: t.disc_number ?? null,
      discTotal: t.disc_total ?? null,
      year: t.year ?? null,
      genre: t.genre ?? null,
      channels: t.channels ?? null,
      durationSec,
      formatBadge: formatTrackAudioSpecs(t),
      container: (t.container ?? t.codec ?? 'AUDIO').toUpperCase(),
      bitDepth: t.bit_depth,
      sampleRateHz: t.sample_rate_hz,
      bitrateKbps: t.bitrate_bps ? Math.round(t.bitrate_bps / 1000) : 0,
      fileSizeBytes: t.file_size_bytes ?? 0,
      coverUrl: t.artwork_thumb_url ?? t.artwork_url ?? DEFAULT_DOREMI_ARTWORK_URL,
      status: t.status === 'available' ? 'available' : 'missing',
      availabilityState: t.availability_state,
      source: 'local',
      addedOrder: 0,
      playCount: 0,
      filePathDisplay: 'LAN Remote Stream',
    };
  }

  async playRemoteTrack(trackDto: RemoteTrackDto): Promise<void> {
    const host = this.state.clientSnapshot?.activeHost;
    if (!host) return;
    this.cacheRemoteTrackDtos(host.hostId, [trackDto]);
    const recordId = `${'remote::'}${host.hostId}::${trackDto.trackId}`;

    const contextIds = this.state.remoteTracks
      .map((t) => {
        const rec = this.remoteTrackCache.get(`remote::${host.hostId}::${t.trackId}`);
        return rec?.id;
      })
      .filter((id): id is string => Boolean(id));

    const context: PlaybackContextDescriptor = {
      contextId: `remote-host-${host.hostId}`,
      label: `Remote · ${host.displayName}`,
      kind: 'library',
      trackIds: contextIds.includes(recordId) ? contextIds : [recordId],
    };

    const entry = this.queueController.playTrackInCurrentOrNewContext(recordId, context);
    await this.playbackActions.playQueueEntry(entry);
  }

  private clearRemotePlaybackState(): void {
    const qState = this.queueController.getState();
    const remoteIds = new Set<string>();
    if (qState.currentEntry && isRemoteTrackId(qState.currentEntry.trackId)) {
      remoteIds.add(qState.currentEntry.trackId);
    }
    for (const item of qState.upcoming) {
      if (isRemoteTrackId(item.trackId)) {
        remoteIds.add(item.trackId);
      }
    }
    for (const item of qState.history) {
      if (isRemoteTrackId(item.trackId)) {
        remoteIds.add(item.trackId);
      }
    }
    const currentPlayback = this.playbackActions.getPlaybackState?.();
    if (currentPlayback?.currentTrackId && isRemoteTrackId(currentPlayback.currentTrackId)) {
      this.playbackActions.pauseSilently();
    }
    if (remoteIds.size > 0) {
      this.queueController.removeTracksFromQueue(Array.from(remoteIds));
    }
  }

  async refreshClientDiagnostics(): Promise<ClientDiagnosticsSnapshot | null> {
    const api = this.getApi();
    if (!api?.connectGetClientDiagnostics) {
      return null;
    }
    try {
      const clientDiagnostics = await api.connectGetClientDiagnostics();
      this.setState({ clientDiagnostics });
      return clientDiagnostics;
    } catch {
      return null;
    }
  }

  async resolveRemoteFailureHintForTrack(compositeTrackId: string): Promise<{
    errorCode: string | null;
    statusCode: number | null;
    detail: string | null;
  } | null> {
    const parsed = parseRemoteTrackId(compositeTrackId);
    if (!parsed) return null;
    const diag = await this.refreshClientDiagnostics();
    if (!diag) return null;
    const matchingTrace =
      diag.recentTraces.find(
        (t) =>
          t.hostId === parsed.hostId &&
          t.trackId === parsed.trackId &&
          t.errorCode !== null,
      ) ??
      (diag.lastTrackFailure &&
      diag.lastTrackFailure.hostId === parsed.hostId &&
      diag.lastTrackFailure.trackId === parsed.trackId
        ? diag.lastTrackFailure
        : null);

    if (matchingTrace) {
      return {
        errorCode: matchingTrace.errorCode,
        statusCode: matchingTrace.statusCode,
        detail: matchingTrace.detail,
      };
    }

    if (diag.lastErrorCode === 'ACCESS_REVOKED') {
      return { errorCode: 'ERR_REMOTE_ACCESS_REVOKED', statusCode: 403, detail: diag.lastError };
    }
    if (diag.lastErrorCode === 'AUTH_FAILED') {
      return { errorCode: 'ERR_REMOTE_AUTH_FAILED', statusCode: 401, detail: diag.lastError };
    }
    if (diag.lastErrorCode === 'HOST_UNAVAILABLE' || diag.status === 'error') {
      return {
        errorCode: 'ERR_REMOTE_STREAM_INTERRUPTED',
        statusCode: null,
        detail: diag.lastError,
      };
    }
    return null;
  }

  dispose(): void {
    this.playbackActions.setRemoteHandoverPendingPredicate?.(undefined);
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups = [];
  }
}
