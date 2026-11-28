import { execFile } from 'node:child_process';
import os from 'node:os';
import * as electronModule from 'electron';
import type {
  ConnectResourceMetrics,
  HostLifecycleState,
  HostPowerPolicy,
  ScopedHostResourceBreakdown,
} from '../../../shared/types/connect';

const TAILSCALE_PROCESS_SAMPLE_TTL_MS = 15_000;

interface TailscaleProcessCache {
  sampledAtMs: number;
  running: boolean;
  processCount: number;
  workingSetSumBytes: number;
  privateBytesSum: number;
}

/**
 * Lightweight, consumer-driven Host resource sampler preparing the backend measurement
 * contract for Phase 7.4 Host Resource Gauges (`UI-BACKLOG-03`).
 *
 * Guarantees:
 * - Zero recurring timers (`0%` ongoing background CPU when no UI consumer requests a sample).
 * - Clearly separates Main Process, DoReMi Process Tree (`app.getAppMetrics()`), Server byte/session
 *   counters (LAN vs Remote payload throughput), Tailscale processes, and System memory/CPU.
 * - Never presents JS heap as total RAM and never fabricates Host-only CPU attribution.
 */
export class HostResourceSampler {
  private lastCpuUsage: NodeJS.CpuUsage | null = null;
  private lastCpuAtMs: number | null = null;
  private lastOneCorePct: number | null = null;
  private lastNormalizedPct: number | null = null;
  private tailscaleCache: TailscaleProcessCache | null = null;
  private inflightTailscale: Promise<TailscaleProcessCache> | null = null;

  async sampleBreakdown(params: {
    hostState: HostLifecycleState;
    powerPolicy: HostPowerPolicy;
    powerBlockerActive: boolean;
    metrics: ConnectResourceMetrics;
    totalLanBytesSent: number;
    totalRemoteBytesSent: number;
    includeTailscaleProcesses?: boolean;
  }): Promise<ScopedHostResourceBreakdown> {
    const now = Date.now();
    const logicalCpuCount = Math.max(1, os.cpus().length || 1);

    if (this.lastCpuUsage && this.lastCpuAtMs !== null) {
      const elapsedMs = now - this.lastCpuAtMs;
      if (elapsedMs >= 200) {
        const delta = process.cpuUsage(this.lastCpuUsage);
        const oneCore = ((delta.user + delta.system) / (elapsedMs * 1000)) * 100;
        const norm = oneCore / logicalCpuCount;
        this.lastOneCorePct = Math.round(Math.max(0, oneCore) * 100) / 100;
        this.lastNormalizedPct = Math.round(Math.min(100, Math.max(0, norm)) * 100) / 100;
        this.lastCpuUsage = process.cpuUsage();
        this.lastCpuAtMs = now;
      }
    } else {
      this.lastCpuUsage = process.cpuUsage();
      this.lastCpuAtMs = now;
    }

    const mem = process.memoryUsage();
    const appTree = this.readElectronProcessTree(logicalCpuCount, mem.rss);

    let tsSection: ScopedHostResourceBreakdown['tailscaleProcesses'] = {
      sampled: false,
      running: false,
      processCount: 0,
      workingSetSumBytes: 0,
      privateBytesSum: 0,
      note: 'Chưa lấy mẫu tiến trình Tailscale độc lập (chỉ đo theo yêu cầu để tránh tạo tiến trình phụ).',
    };

    if (params.includeTailscaleProcesses) {
      const ts = await this.sampleTailscaleProcessesBounded(now);
      tsSection = {
        sampled: true,
        running: ts.running,
        processCount: ts.processCount,
        workingSetSumBytes: ts.workingSetSumBytes,
        privateBytesSum: ts.privateBytesSum,
        note:
          'Đo riêng các tiến trình Tailscale của hệ điều hành (tailscaled / tailscale-ipn); không gộp chung vào RAM của DoReMi.',
      };
    }

    return {
      sampledAt: new Date(now).toISOString(),
      hostState: params.hostState,
      powerPolicy: params.powerPolicy,
      powerBlockerActive: params.powerBlockerActive,
      mainProcess: {
        cpuOneCorePercent: this.lastOneCorePct,
        cpuNormalizedPercent: this.lastNormalizedPct,
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
        arrayBuffersBytes: mem.arrayBuffers,
      },
      appProcessTree: appTree,
      serverCounters: {
        activePlaybackClients: params.metrics.hostMetrics.activePlaybackClients ?? 0,
        connectedDevices: params.metrics.hostMetrics.connectedDeviceCount,
        authorizedDevices: params.metrics.hostMetrics.authorizedDeviceCount,
        activeStreams: params.metrics.hostMetrics.activePlaybackSessions,
        activeHttpRequests: params.metrics.hostMetrics.activeHttpRequests,
        lanThroughputBytesPerSec: params.metrics.hostMetrics.lanThroughputBytesPerSec ?? 0,
        remoteThroughputBytesPerSec: params.metrics.hostMetrics.remoteThroughputBytesPerSec ?? 0,
        totalThroughputBytesPerSec: params.metrics.hostMetrics.currentThroughputBytesPerSec,
        totalLanBytesSent: params.totalLanBytesSent,
        totalRemoteBytesSent: params.totalRemoteBytesSent,
        metadataCacheEntries: params.metrics.hostMetrics.metadataCacheEntries,
        artworkCacheEntries: params.metrics.hostMetrics.artworkCacheEntries,
        lyricsCacheEntries: params.metrics.hostMetrics.lyricsCacheEntries ?? 0,
      },
      tailscaleProcesses: tsSection,
      systemResources: {
        logicalCpuCount,
        totalMemoryBytes: os.totalmem(),
        freeMemoryBytes: os.freemem(),
      },
    };
  }

  private readElectronProcessTree(
    logicalCpuCount: number,
    fallbackRssBytes: number,
  ): ScopedHostResourceBreakdown['appProcessTree'] {
    try {
      const appObj = (electronModule as unknown as {
        app?: {
          getAppMetrics?: () => Array<{
            cpu?: { percentCPUUsage?: number };
            memory?: { workingSetSize?: number; privateBytes?: number };
          }>;
        };
      }).app;
      if (appObj && typeof appObj.getAppMetrics === 'function') {
        const metrics = appObj.getAppMetrics();
        let wsKb = 0;
        let privKb = 0;
        let hasPriv = false;
        let cpuPctSum = 0;
        for (const item of metrics) {
          wsKb += item.memory?.workingSetSize ?? 0;
          if (typeof item.memory?.privateBytes === 'number') {
            privKb += item.memory.privateBytes;
            hasPriv = true;
          }
          cpuPctSum += item.cpu?.percentCPUUsage ?? 0;
        }
        return {
          available: true,
          processCount: metrics.length,
          workingSetSumBytes: wsKb * 1024,
          privateBytesSum: hasPriv ? privKb * 1024 : null,
          cpuNormalizedPercentSum:
            Math.round(Math.min(100, Math.max(0, cpuPctSum / logicalCpuCount)) * 100) / 100,
          note: 'Tổng Working Set của cây tiến trình DoReMi (Main + Renderer + GPU + Utility; có thể chứa trang bộ nhớ dùng chung của Chromium).',
        };
      }
    } catch {
      // Headless Node fallback
    }
    return {
      available: false,
      processCount: 1,
      workingSetSumBytes: fallbackRssBytes,
      privateBytesSum: null,
      cpuNormalizedPercentSum: this.lastNormalizedPct,
      note: 'Chỉ số tiến trình Node/Electron hiện tại (chế độ không có Browser process tree).',
    };
  }

  private async sampleTailscaleProcessesBounded(now: number): Promise<TailscaleProcessCache> {
    if (this.tailscaleCache && now - this.tailscaleCache.sampledAtMs < TAILSCALE_PROCESS_SAMPLE_TTL_MS) {
      return this.tailscaleCache;
    }
    if (this.inflightTailscale) {
      return this.inflightTailscale;
    }
    if (process.platform !== 'win32') {
      const empty: TailscaleProcessCache = {
        sampledAtMs: now,
        running: false,
        processCount: 0,
        workingSetSumBytes: 0,
        privateBytesSum: 0,
      };
      this.tailscaleCache = empty;
      return empty;
    }

    const work = new Promise<TailscaleProcessCache>((resolve) => {
      const psCmd =
        "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'tailscale*' } | Select-Object WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress";
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psCmd],
        { timeout: 4_000, windowsHide: true, maxBuffer: 256 * 1024 },
        (err, stdout) => {
          const trimmed = (stdout ?? '').trim();
          if (err || !trimmed) {
            const empty: TailscaleProcessCache = {
              sampledAtMs: Date.now(),
              running: false,
              processCount: 0,
              workingSetSumBytes: 0,
              privateBytesSum: 0,
            };
            this.tailscaleCache = empty;
            resolve(empty);
            return;
          }
          try {
            const parsed = JSON.parse(trimmed) as unknown;
            const list = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
              WorkingSet64?: number;
              PrivateMemorySize64?: number;
            }>;
            let ws = 0;
            let priv = 0;
            for (const row of list) {
              ws += Number(row.WorkingSet64 ?? 0);
              priv += Number(row.PrivateMemorySize64 ?? 0);
            }
            const snap: TailscaleProcessCache = {
              sampledAtMs: Date.now(),
              running: list.length > 0,
              processCount: list.length,
              workingSetSumBytes: ws,
              privateBytesSum: priv,
            };
            this.tailscaleCache = snap;
            resolve(snap);
          } catch {
            const empty: TailscaleProcessCache = {
              sampledAtMs: Date.now(),
              running: false,
              processCount: 0,
              workingSetSumBytes: 0,
              privateBytesSum: 0,
            };
            this.tailscaleCache = empty;
            resolve(empty);
          }
        },
      );
    }).finally(() => {
      this.inflightTailscale = null;
    });

    this.inflightTailscale = work;
    return work;
  }
}
