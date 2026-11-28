import crypto from 'node:crypto';
import os from 'node:os';
import type {
  ActiveStreamSessionInfo,
  ConnectResourceLimits,
  ConnectResourceMetrics,
  ConnectTransportMode,
  HostLifecycleState,
} from '../../../shared/types/connect';

interface InternalActiveStream {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  trackId: string;
  rootId: string;
  transport: ConnectTransportMode;
  startedAtMs: number;
  lastChunkAtMs: number;
  bytesRead: number;
  bytesSent: number;
  isPartial: boolean;
  abortController: AbortController;
}

const MAX_CONCURRENT_STREAMS_PER_DEVICE = 4;

interface ThroughputSample {
  timestampMs: number;
  bytesSent: number;
  transport: ConnectTransportMode;
}

const CONNECTED_DEVICE_IDLE_MS = 45_000;
const THROUGHPUT_WINDOW_MS = 5_000;
const ACTIVE_PLAYBACK_EVIDENCE_IDLE_MS = 45_000;

/**
 * Enforces personal-use Host resource limits (`maxActiveClients`, per-device & global concurrency),
 * tracks active streams for clean cancellation on stop/revocation/unshare, and collects truthful metrics.
 */
export class ResourceBudgetManager {
  private limits: ConnectResourceLimits;
  private activeHttpRequests = 0;
  private perDeviceHttpRequests = new Map<string, number>();
  private activeArtworkRequests = 0;
  private perDeviceArtworkRequests = new Map<string, number>();
  private activeStreams = new Map<string, InternalActiveStream>();
  private connectedDeviceLastSeen = new Map<string, number>();
  private totalBytesRead = 0;
  private totalBytesSent = 0;
  private totalLanBytesSent = 0;
  private totalRemoteBytesSent = 0;
  private throughputSamples: ThroughputSample[] = [];
  private metadataCacheEntries = 0;
  private artworkCacheEntries = 0;
  private lyricsCacheEntries = 0;

  private lastCpuUsage: NodeJS.CpuUsage | null = null;
  private lastCpuSampleMs: number | null = null;
  private lastCpuPercent: number | null = null;
  private hostStartedAtMs: number | null = null;
  private onActivityStateChanged?: () => void;

  constructor(limits: ConnectResourceLimits, onActivityStateChanged?: () => void) {
    this.limits = { ...limits };
    this.onActivityStateChanged = onActivityStateChanged;
  }

  setLimits(limits: ConnectResourceLimits): void {
    this.limits = { ...limits };
  }

  getLimits(): ConnectResourceLimits {
    return { ...this.limits };
  }

  markHostStarted(): void {
    this.hostStartedAtMs = Date.now();
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuSampleMs = Date.now();
    this.lastCpuPercent = null;
  }

  markHostStopped(): void {
    this.abortAllStreams('Host stopped');
    this.activeHttpRequests = 0;
    this.perDeviceHttpRequests.clear();
    this.activeArtworkRequests = 0;
    this.perDeviceArtworkRequests.clear();
    this.connectedDeviceLastSeen.clear();
    this.throughputSamples = [];
    this.metadataCacheEntries = 0;
    this.artworkCacheEntries = 0;
    this.lyricsCacheEntries = 0;
    this.hostStartedAtMs = null;
    this.lastCpuUsage = null;
    this.lastCpuSampleMs = null;
    this.lastCpuPercent = null;
  }

  markDeviceSeen(deviceId: string): void {
    this.connectedDeviceLastSeen.set(deviceId, Date.now());
  }

  markDeviceDisconnected(deviceId: string): void {
    this.connectedDeviceLastSeen.delete(deviceId);
    this.abortStreamsForDevice(deviceId, 'Device disconnected');
  }

  tryEnterHttpRequest(
    deviceId?: string,
    lane: 'default' | 'artwork' = 'default',
  ): { ok: true; release: () => void } | { ok: false; reason: string } {
    const isArtwork = lane === 'artwork';
    const maxGlobal = isArtwork
      ? Math.max(48, this.limits.maxGlobalRequests)
      : this.limits.maxGlobalRequests;
    const maxPerDevice = isArtwork
      ? Math.max(16, this.limits.maxRequestsPerDevice)
      : this.limits.maxRequestsPerDevice;

    const activeGlobal = isArtwork ? this.activeArtworkRequests : this.activeHttpRequests;
    if (activeGlobal >= maxGlobal) {
      return { ok: false, reason: 'Host global concurrent request limit reached.' };
    }

    const perDeviceMap = isArtwork ? this.perDeviceArtworkRequests : this.perDeviceHttpRequests;
    if (deviceId) {
      const current = perDeviceMap.get(deviceId) ?? 0;
      if (current >= maxPerDevice) {
        return { ok: false, reason: 'Per-device concurrent request limit reached.' };
      }
      perDeviceMap.set(deviceId, current + 1);
    }

    if (isArtwork) {
      this.activeArtworkRequests += 1;
    } else {
      this.activeHttpRequests += 1;
    }

    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        if (isArtwork) {
          this.activeArtworkRequests = Math.max(0, this.activeArtworkRequests - 1);
        } else {
          this.activeHttpRequests = Math.max(0, this.activeHttpRequests - 1);
        }
        if (deviceId) {
          const cur = perDeviceMap.get(deviceId) ?? 0;
          if (cur <= 1) {
            perDeviceMap.delete(deviceId);
          } else {
            perDeviceMap.set(deviceId, cur - 1);
          }
        }
      },
    };
  }

  /**
   * Checks active-playback-client budget. A single client may issue multiple Range requests
   * legitimately without counting as multiple distinct clients.
   */
  canStartPlaybackStream(deviceId: string): { ok: true } | { ok: false; reason: string } {
    const activeClientIds = new Set<string>();
    for (const stream of this.activeStreams.values()) {
      activeClientIds.add(stream.deviceId);
    }
    if (!activeClientIds.has(deviceId) && activeClientIds.size >= this.limits.maxActiveClients) {
      return {
        ok: false,
        reason: `Maximum simultaneous playback clients (${this.limits.maxActiveClients}) reached.`,
      };
    }
    return { ok: true };
  }

  registerStreamSession(params: {
    deviceId: string;
    deviceName: string;
    trackId: string;
    rootId: string;
    isPartial: boolean;
    transport?: ConnectTransportMode;
  }): {
    sessionId: string;
    signal: AbortSignal;
    recordBytesRead: (n: number) => void;
    recordBytesSent: (n: number) => void;
    finish: () => void;
  } {
    // Evict oldest open stream for the same device if it exceeds MAX_CONCURRENT_STREAMS_PER_DEVICE
    // (protects public/LAN Host from abandoned seek sockets without breaking normal multi-range ALAC/FLAC)
    const deviceStreams: InternalActiveStream[] = [];
    for (const s of this.activeStreams.values()) {
      if (s.deviceId === params.deviceId) {
        deviceStreams.push(s);
      }
    }
    while (deviceStreams.length >= MAX_CONCURRENT_STREAMS_PER_DEVICE) {
      const oldest = deviceStreams.shift();
      if (oldest) {
        oldest.abortController.abort(new Error('Evicted oldest stream session for device'));
        this.activeStreams.delete(oldest.sessionId);
      }
    }

    const nowMs = Date.now();
    const sessionId = crypto.randomUUID();
    const abortController = new AbortController();
    const entry: InternalActiveStream = {
      sessionId,
      deviceId: params.deviceId,
      deviceName: params.deviceName,
      trackId: params.trackId,
      rootId: params.rootId,
      transport: params.transport ?? 'lan-direct',
      startedAtMs: nowMs,
      lastChunkAtMs: nowMs,
      bytesRead: 0,
      bytesSent: 0,
      isPartial: params.isPartial,
      abortController,
    };

    const wasEmpty = this.activeStreams.size === 0;
    this.activeStreams.set(sessionId, entry);
    this.markDeviceSeen(params.deviceId);
    if (wasEmpty) {
      this.onActivityStateChanged?.();
    }

    let finished = false;
    return {
      sessionId,
      signal: abortController.signal,
      recordBytesRead: (n: number) => {
        if (n > 0) {
          entry.bytesRead += n;
          entry.lastChunkAtMs = Date.now();
          this.totalBytesRead += n;
        }
      },
      recordBytesSent: (n: number) => {
        if (n > 0) {
          const now = Date.now();
          entry.bytesSent += n;
          entry.lastChunkAtMs = now;
          this.totalBytesSent += n;
          if (entry.transport === 'remote-https') {
            this.totalRemoteBytesSent += n;
          } else {
            this.totalLanBytesSent += n;
          }
          this.throughputSamples.push({ timestampMs: now, bytesSent: n, transport: entry.transport });
          this.pruneThroughputSamples(now);
        }
      },
      finish: () => {
        if (finished) return;
        finished = true;
        this.activeStreams.delete(sessionId);
        if (this.activeStreams.size === 0) {
          this.onActivityStateChanged?.();
        }
      },
    };
  }

  abortRemoteStreamsForDevice(deviceId: string, reason = 'Remote access permission revoked'): number {
    let count = 0;
    for (const [id, stream] of this.activeStreams.entries()) {
      if (stream.deviceId === deviceId && stream.transport === 'remote-https') {
        stream.abortController.abort(new Error(reason));
        this.activeStreams.delete(id);
        count += 1;
      }
    }
    if (count > 0 && this.activeStreams.size === 0) {
      this.onActivityStateChanged?.();
    }
    return count;
  }

  abortAllRemoteStreams(reason = 'Remote Access disabled'): number {
    let count = 0;
    for (const [id, stream] of this.activeStreams.entries()) {
      if (stream.transport === 'remote-https') {
        stream.abortController.abort(new Error(reason));
        this.activeStreams.delete(id);
        count += 1;
      }
    }
    if (count > 0 && this.activeStreams.size === 0) {
      this.onActivityStateChanged?.();
    }
    return count;
  }

  sweepAbandonedRemoteStreams(maxIdleMs: number): number {
    return this.sweepAbandonedStreams(maxIdleMs, 'remote-https');
  }

  sweepAbandonedStreams(maxIdleMs: number, transportFilter?: ConnectTransportMode): number {
    const now = Date.now();
    let count = 0;
    for (const [id, stream] of this.activeStreams.entries()) {
      if (transportFilter && stream.transport !== transportFilter) {
        continue;
      }
      if (now - stream.lastChunkAtMs > maxIdleMs) {
        stream.abortController.abort(new Error('Abandoned stream idle limit exceeded'));
        this.activeStreams.delete(id);
        count += 1;
      }
    }
    if (count > 0 && this.activeStreams.size === 0) {
      this.onActivityStateChanged?.();
    }
    return count;
  }

  /**
   * Returns distinct authorized deviceIds with non-abandoned active playback stream sessions.
   */
  getActivePlaybackDeviceIds(maxEvidenceIdleMs = ACTIVE_PLAYBACK_EVIDENCE_IDLE_MS, now = Date.now()): string[] {
    const ids = new Set<string>();
    for (const stream of this.activeStreams.values()) {
      if (now - stream.lastChunkAtMs <= maxEvidenceIdleMs) {
        ids.add(stream.deviceId);
      }
    }
    return Array.from(ids);
  }

  getTransportTotals(): { totalLanBytesSent: number; totalRemoteBytesSent: number } {
    return {
      totalLanBytesSent: this.totalLanBytesSent,
      totalRemoteBytesSent: this.totalRemoteBytesSent,
    };
  }

  abortStreamsForDevice(deviceId: string, reason = 'Device access revoked'): number {
    let count = 0;
    for (const [id, stream] of this.activeStreams.entries()) {
      if (stream.deviceId === deviceId) {
        stream.abortController.abort(new Error(reason));
        this.activeStreams.delete(id);
        count += 1;
      }
    }
    this.connectedDeviceLastSeen.delete(deviceId);
    if (count > 0 && this.activeStreams.size === 0) {
      this.onActivityStateChanged?.();
    }
    return count;
  }

  abortStreamsForRoot(rootId: string, reason = 'Shared source removed'): number {
    let count = 0;
    for (const [id, stream] of this.activeStreams.entries()) {
      if (stream.rootId === rootId) {
        stream.abortController.abort(new Error(reason));
        this.activeStreams.delete(id);
        count += 1;
      }
    }
    if (count > 0 && this.activeStreams.size === 0) {
      this.onActivityStateChanged?.();
    }
    return count;
  }

  abortAllStreams(reason = 'Host stopping'): number {
    let count = 0;
    for (const stream of this.activeStreams.values()) {
      stream.abortController.abort(new Error(reason));
      count += 1;
    }
    this.activeStreams.clear();
    return count;
  }

  hasActiveStreams(): boolean {
    return this.activeStreams.size > 0;
  }

  getActiveStreamInfos(): ActiveStreamSessionInfo[] {
    return Array.from(this.activeStreams.values()).map((s) => ({
      sessionId: s.sessionId,
      deviceId: s.deviceId,
      deviceName: s.deviceName,
      trackId: s.trackId,
      startedAt: new Date(s.startedAtMs).toISOString(),
      bytesRead: s.bytesRead,
      bytesSent: s.bytesSent,
      isPartial: s.isPartial,
      transport: s.transport,
    }));
  }

  isDeviceConnected(deviceId: string): boolean {
    for (const stream of this.activeStreams.values()) {
      if (stream.deviceId === deviceId) {
        return true;
      }
    }
    const seenAt = this.connectedDeviceLastSeen.get(deviceId);
    if (!seenAt) {
      return false;
    }
    if (Date.now() - seenAt > CONNECTED_DEVICE_IDLE_MS) {
      this.connectedDeviceLastSeen.delete(deviceId);
      return false;
    }
    return true;
  }

  getDeviceActiveSessionCount(deviceId: string): number {
    let count = 0;
    for (const stream of this.activeStreams.values()) {
      if (stream.deviceId === deviceId) {
        count += 1;
      }
    }
    return count;
  }

  updateCacheSizes(metadataEntries: number, artworkEntries: number, lyricsEntries = 0): void {
    this.metadataCacheEntries = metadataEntries;
    this.artworkCacheEntries = artworkEntries;
    this.lyricsCacheEntries = lyricsEntries;
  }

  sampleMetrics(params: {
    state: HostLifecycleState;
    sharedTrackCount: number;
    authorizedDeviceCount: number;
  }): ConnectResourceMetrics {
    const now = Date.now();
    this.pruneThroughputSamples(now);

    const logicalCpuCount = Math.max(1, os.cpus().length || 1);
    if (params.state !== 'STOPPED') {
      if (this.lastCpuUsage && this.lastCpuSampleMs !== null) {
        const elapsedMs = now - this.lastCpuSampleMs;
        if (elapsedMs >= 250) {
          const delta = process.cpuUsage(this.lastCpuUsage);
          const totalCpuMicros = delta.user + delta.system;
          const capacityMicros = elapsedMs * 1000 * logicalCpuCount;
          this.lastCpuPercent = Math.min(
            100,
            Math.max(0, Math.round((totalCpuMicros / capacityMicros) * 1000) / 10),
          );
          this.lastCpuUsage = process.cpuUsage();
          this.lastCpuSampleMs = now;
        }
      } else {
        this.lastCpuUsage = process.cpuUsage();
        this.lastCpuSampleMs = now;
      }
    }

    const mem = process.memoryUsage();
    let recentLanBytes = 0;
    let recentRemoteBytes = 0;
    for (const s of this.throughputSamples) {
      if (s.transport === 'remote-https') {
        recentRemoteBytes += s.bytesSent;
      } else {
        recentLanBytes += s.bytesSent;
      }
    }
    const recentBytes = recentLanBytes + recentRemoteBytes;
    const windowSec = THROUGHPUT_WINDOW_MS / 1000;

    let connectedDeviceCount = 0;
    for (const [deviceId, ts] of this.connectedDeviceLastSeen.entries()) {
      if (now - ts <= CONNECTED_DEVICE_IDLE_MS || this.getDeviceActiveSessionCount(deviceId) > 0) {
        connectedDeviceCount += 1;
      } else {
        this.connectedDeviceLastSeen.delete(deviceId);
      }
    }
    const activeClientIds = this.getActivePlaybackDeviceIds(ACTIVE_PLAYBACK_EVIDENCE_IDLE_MS, now);

    return {
      sampledAt: new Date(now).toISOString(),
      hostMetrics: {
        state: params.state,
        uptimeMs:
          params.state !== 'STOPPED' && this.hostStartedAtMs !== null
            ? Math.max(0, now - this.hostStartedAtMs)
            : 0,
        sharedTrackCount: params.sharedTrackCount,
        authorizedDeviceCount: params.authorizedDeviceCount,
        connectedDeviceCount,
        activePlaybackClients: activeClientIds.length,
        activePlaybackSessions: this.activeStreams.size,
        activeHttpRequests: this.activeHttpRequests,
        totalBytesReadByStreamer: this.totalBytesRead,
        totalBytesTransmitted: this.totalBytesSent,
        currentThroughputBytesPerSec:
          params.state !== 'STOPPED' ? Math.round(recentBytes / windowSec) : 0,
        lanThroughputBytesPerSec:
          params.state !== 'STOPPED' ? Math.round(recentLanBytes / windowSec) : 0,
        remoteThroughputBytesPerSec:
          params.state !== 'STOPPED' ? Math.round(recentRemoteBytes / windowSec) : 0,
        metadataCacheEntries: this.metadataCacheEntries,
        artworkCacheEntries: this.artworkCacheEntries,
        lyricsCacheEntries: this.lyricsCacheEntries,
      },
      appProcessMetrics: {
        processCpuPercent: params.state !== 'STOPPED' ? this.lastCpuPercent : null,
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
        arrayBuffersBytes: mem.arrayBuffers,
      },
      systemMetrics: {
        totalMemoryBytes: os.totalmem(),
        freeMemoryBytes: os.freemem(),
        logicalCpuCount,
        loadAverageAvailable: process.platform !== 'win32',
      },
    };
  }

  private pruneThroughputSamples(now: number): void {
    const cutoff = now - THROUGHPUT_WINDOW_MS;
    while (this.throughputSamples.length > 0 && this.throughputSamples[0].timestampMs < cutoff) {
      this.throughputSamples.shift();
    }
  }
}
