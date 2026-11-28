import * as electronModule from 'electron';
import type {
  HostLifecycleState,
  HostPowerPolicy,
  HostPowerSnapshot,
  PowerSourceState,
} from '../../../shared/types/connect';

export interface PowerPlatformAdapter {
  startBlocker(type: 'prevent-app-suspension'): number;
  stopBlocker(id: number): void;
  isBlockerStarted(id: number): boolean;
  isOnBatteryPower(): boolean | null;
  subscribePowerEvents(handlers: {
    onSuspend: () => void;
    onResume: () => void;
    onAc: () => void;
    onBattery: () => void;
  }): () => void;
}

export function createElectronPowerPlatformAdapter(): PowerPlatformAdapter {
  const mod = electronModule as unknown as {
    powerSaveBlocker?: {
      start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
      stop(id: number): void;
      isStarted(id: number): boolean;
    };
    powerMonitor?: {
      isOnBatteryPower?: () => boolean;
      on?: (event: string, listener: () => void) => void;
      removeListener?: (event: string, listener: () => void) => void;
    };
  };

  // Fallback tracking ONLY when running inside headless ELECTRON_RUN_AS_NODE=1 test scripts
  // where Electron's Browser-process powerSaveBlocker module is not initialized.
  let fallbackNextId = 10_000;
  const fallbackActiveIds = new Set<number>();

  return {
    startBlocker(type: 'prevent-app-suspension'): number {
      if (mod.powerSaveBlocker && typeof mod.powerSaveBlocker.start === 'function') {
        return mod.powerSaveBlocker.start(type);
      }
      fallbackNextId += 1;
      fallbackActiveIds.add(fallbackNextId);
      return fallbackNextId;
    },
    stopBlocker(id: number): void {
      if (mod.powerSaveBlocker && typeof mod.powerSaveBlocker.stop === 'function') {
        if (mod.powerSaveBlocker.isStarted(id)) {
          mod.powerSaveBlocker.stop(id);
        }
        return;
      }
      fallbackActiveIds.delete(id);
    },
    isBlockerStarted(id: number): boolean {
      if (mod.powerSaveBlocker && typeof mod.powerSaveBlocker.isStarted === 'function') {
        return mod.powerSaveBlocker.isStarted(id);
      }
      return fallbackActiveIds.has(id);
    },
    isOnBatteryPower(): boolean | null {
      try {
        if (mod.powerMonitor && typeof mod.powerMonitor.isOnBatteryPower === 'function') {
          return Boolean(mod.powerMonitor.isOnBatteryPower());
        }
      } catch {
        // Not ready or unsupported on platform
      }
      return null;
    },
    subscribePowerEvents(handlers): () => void {
      const pm = mod.powerMonitor;
      if (!pm || typeof pm.on !== 'function' || typeof pm.removeListener !== 'function') {
        return () => {};
      }
      const onSuspend = () => handlers.onSuspend();
      const onResume = () => handlers.onResume();
      const onAc = () => handlers.onAc();
      const onBattery = () => handlers.onBattery();

      try {
        pm.on('suspend', onSuspend);
        pm.on('resume', onResume);
        pm.on('on-ac', onAc);
        pm.on('on-battery', onBattery);
      } catch {
        return () => {};
      }

      return () => {
        try {
          pm.removeListener?.('suspend', onSuspend);
          pm.removeListener?.('resume', onResume);
          pm.removeListener?.('on-ac', onAc);
          pm.removeListener?.('on-battery', onBattery);
        } catch {
          // Ignore teardown errors
        }
      };
    },
  };
}

export const DEFAULT_STREAMING_INACTIVITY_GRACE_MS = 45_000;
export const DEFAULT_SESSION_LEASE_TTL_MS = 60_000;

interface AuthenticatedPlaybackLease {
  deviceId: string;
  sessionToken: string;
  updatedAtMs: number;
  expiresAtMs: number;
}

export interface HostPowerManagerOptions {
  initialPolicy?: HostPowerPolicy;
  inactivityGraceMs?: number;
  sessionLeaseTtlMs?: number;
  adapter?: PowerPlatformAdapter;
  nowMs?: () => number;
  getActiveStreamDeviceIds?: (nowMs: number) => string[];
  isDeviceAuthorized?: (deviceId: string) => boolean;
  onStateChanged?: () => void;
  onSystemSuspend?: () => void;
  onSystemResume?: () => void;
}

/**
 * Dedicated lightweight Windows/Electron Host Power Manager (Phase 6.5).
 *
 * Design guarantees:
 * - Uses ONLY `prevent-app-suspension` so Windows display/monitor sleep still turns off normally.
 * - Never modifies Windows Power Plans, never simulates mouse/keyboard input, never requires Administrator.
 * - Single authoritative owned `blockerId` with idempotent acquire/release and zero duplicate handles.
 * - Three explicit user-selectable policies (`follow-system`, `keep-awake-streaming`, `keep-awake-host-on`).
 * - Bounded inactivity grace window prevents rapid blocker toggling across track switches or short pauses,
 *   while ensuring abandoned/revoked/ended sessions release sleep inhibition deterministically.
 */
export class HostPowerManager {
  private readonly adapter: PowerPlatformAdapter;
  private readonly inactivityGraceMs: number;
  private readonly sessionLeaseTtlMs: number;
  private readonly nowMs: () => number;
  private readonly getActiveStreamDeviceIds: (nowMs: number) => string[];
  private readonly isDeviceAuthorized: (deviceId: string) => boolean;
  private readonly onStateChanged?: () => void;
  private readonly onSystemSuspendCallback?: () => void;
  private readonly onSystemResumeCallback?: () => void;
  private readonly unsubscribePlatformEvents: () => void;

  private policy: HostPowerPolicy;
  private hostState: HostLifecycleState = 'STOPPED';
  private blockerId: number | null = null;
  private blockerReason: string | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private graceExpiresAtMs: number | null = null;
  private lastKnownActiveDevices = new Set<string>();
  private playbackLeases = new Map<string, AuthenticatedPlaybackLease>();

  private powerSource: PowerSourceState = 'unknown';
  private systemSuspended = false;
  private disposed = false;
  private lastSuspendAt: string | null = null;
  private lastResumeAt: string | null = null;

  constructor(options?: HostPowerManagerOptions) {
    this.adapter = options?.adapter ?? createElectronPowerPlatformAdapter();
    this.policy = this.normalizePolicy(options?.initialPolicy);
    this.inactivityGraceMs = Math.max(250, options?.inactivityGraceMs ?? DEFAULT_STREAMING_INACTIVITY_GRACE_MS);
    this.sessionLeaseTtlMs = Math.max(1_000, options?.sessionLeaseTtlMs ?? DEFAULT_SESSION_LEASE_TTL_MS);
    this.nowMs = options?.nowMs ?? (() => Date.now());
    this.getActiveStreamDeviceIds = options?.getActiveStreamDeviceIds ?? (() => []);
    this.isDeviceAuthorized = options?.isDeviceAuthorized ?? (() => true);
    this.onStateChanged = options?.onStateChanged;
    this.onSystemSuspendCallback = options?.onSystemSuspend;
    this.onSystemResumeCallback = options?.onSystemResume;

    this.refreshBatteryState();
    this.unsubscribePlatformEvents = this.adapter.subscribePowerEvents({
      onSuspend: () => this.handlePlatformSuspend(),
      onResume: () => this.handlePlatformResume(),
      onAc: () => {
        if (this.powerSource !== 'ac') {
          this.powerSource = 'ac';
          this.onStateChanged?.();
        }
      },
      onBattery: () => {
        if (this.powerSource !== 'battery') {
          this.powerSource = 'battery';
          this.onStateChanged?.();
        }
      },
    });
  }

  private normalizePolicy(raw: unknown): HostPowerPolicy {
    if (raw === 'keep-awake-streaming' || raw === 'keep-awake-host-on') {
      return raw;
    }
    return 'follow-system';
  }

  private refreshBatteryState(): void {
    const onBattery = this.adapter.isOnBatteryPower();
    if (onBattery === true) {
      this.powerSource = 'battery';
    } else if (onBattery === false) {
      this.powerSource = 'ac';
    } else {
      this.powerSource = 'unknown';
    }
  }

  getPolicy(): HostPowerPolicy {
    return this.policy;
  }

  isBlockerActive(): boolean {
    if (this.blockerId === null) {
      return false;
    }
    return this.adapter.isBlockerStarted(this.blockerId);
  }

  getOwnedBlockerId(): number | null {
    return this.blockerId;
  }

  setPolicy(nextPolicy: HostPowerPolicy): boolean {
    const normalized = this.normalizePolicy(nextPolicy);
    const changed = normalized !== this.policy;
    this.policy = normalized;
    if (normalized === 'follow-system') {
      this.clearGraceTimer();
      this.releaseBlocker();
    } else {
      this.reconcile();
    }
    if (changed) {
      this.onStateChanged?.();
    }
    return changed;
  }

  setHostState(nextState: HostLifecycleState): void {
    const prev = this.hostState;
    this.hostState = nextState;
    if (nextState !== 'STANDBY' && nextState !== 'ACTIVE') {
      this.clearGraceTimer();
      this.playbackLeases.clear();
      this.lastKnownActiveDevices.clear();
      this.releaseBlocker();
    } else {
      this.reconcile();
    }
    if (prev !== nextState) {
      this.onStateChanged?.();
    }
  }

  /**
   * Records authenticated playback session lease evidence (`playing` vs `paused` / `stopped`).
   * Rejects unauthenticated, revoked, or malformed device signals so unauthorized requests
   * can never keep the Host awake.
   */
  recordAuthenticatedPlaybackSignal(params: {
    deviceId: string;
    sessionToken: string;
    state: 'playing' | 'paused' | 'stopped';
  }): boolean {
    if (
      this.disposed ||
      (this.hostState !== 'STANDBY' && this.hostState !== 'ACTIVE') ||
      !params.deviceId ||
      !params.sessionToken ||
      !this.isDeviceAuthorized(params.deviceId)
    ) {
      return false;
    }

    const now = this.nowMs();
    if (params.state === 'playing') {
      if (this.playbackLeases.size >= 16 && !this.playbackLeases.has(params.deviceId)) {
        const oldestKey = this.playbackLeases.keys().next().value;
        if (oldestKey !== undefined) {
          this.playbackLeases.delete(oldestKey);
        }
      }
      this.playbackLeases.set(params.deviceId, {
        deviceId: params.deviceId,
        sessionToken: params.sessionToken.slice(0, 64),
        updatedAtMs: now,
        expiresAtMs: now + this.sessionLeaseTtlMs,
      });
      this.reconcile();
      return true;
    }

    const existing = this.playbackLeases.get(params.deviceId);
    if (existing && existing.sessionToken !== params.sessionToken.slice(0, 64)) {
      // Obsolete session token cannot override a newer active session
      return false;
    }
    this.playbackLeases.delete(params.deviceId);
    this.reconcile();
    return true;
  }

  /**
   * Immediately purges a revoked or explicitly disconnected device from active power leases.
   * If no other authorized device is streaming, releases streaming inhibition immediately on revocation.
   */
  notifyDeviceTerminated(deviceId: string, options?: { immediateReleaseIfLast?: boolean }): void {
    this.playbackLeases.delete(deviceId);
    this.lastKnownActiveDevices.delete(deviceId);
    const activeIds = this.collectValidActiveDeviceIds(this.nowMs());
    if (activeIds.length === 0 && options?.immediateReleaseIfLast) {
      this.clearGraceTimer();
      if (this.policy === 'keep-awake-streaming') {
        this.releaseBlocker();
      }
    } else {
      this.reconcile();
    }
  }

  notifyStreamActivityChanged(): void {
    this.reconcile();
  }

  private collectValidActiveDeviceIds(now: number): string[] {
    const valid = new Set<string>();
    for (const devId of this.getActiveStreamDeviceIds(now)) {
      if (this.isDeviceAuthorized(devId)) {
        valid.add(devId);
      }
    }
    for (const [devId, lease] of this.playbackLeases.entries()) {
      if (lease.expiresAtMs <= now || !this.isDeviceAuthorized(devId)) {
        this.playbackLeases.delete(devId);
      } else {
        valid.add(devId);
      }
    }
    return Array.from(valid);
  }

  reconcile(): void {
    if (this.disposed) {
      this.clearGraceTimer();
      this.releaseBlocker();
      return;
    }

    const hostRunning = this.hostState === 'STANDBY' || this.hostState === 'ACTIVE';
    if (!hostRunning || this.systemSuspended) {
      this.clearGraceTimer();
      this.releaseBlocker();
      return;
    }

    if (this.policy === 'follow-system') {
      this.clearGraceTimer();
      this.releaseBlocker();
      return;
    }

    if (this.policy === 'keep-awake-host-on') {
      this.clearGraceTimer();
      this.acquireBlocker('Giữ máy Host thức khi đang bật Server (Màn hình vẫn tự tắt bình thường)');
      return;
    }

    // Policy: 'keep-awake-streaming'
    const now = this.nowMs();
    const activeDeviceIds = this.collectValidActiveDeviceIds(now);
    if (activeDeviceIds.length > 0) {
      for (const id of activeDeviceIds) {
        this.lastKnownActiveDevices.add(id);
      }
      this.clearGraceTimer();
      this.acquireBlocker(
        `Giữ máy Host thức cho ${activeDeviceIds.length} phiên phát nhạc hợp lệ (Màn hình vẫn tự tắt)`,
      );
      return;
    }

    // Zero currently streaming devices: if blocker is active, hold bounded grace across track transitions / short pauses
    if (this.isBlockerActive()) {
      if (!this.graceTimer) {
        this.graceExpiresAtMs = now + this.inactivityGraceMs;
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null;
          this.graceExpiresAtMs = null;
          this.lastKnownActiveDevices.clear();
          const recheck = this.collectValidActiveDeviceIds(this.nowMs());
          if (
            this.policy === 'keep-awake-streaming' &&
            (this.hostState === 'STANDBY' || this.hostState === 'ACTIVE') &&
            !this.systemSuspended &&
            recheck.length === 0
          ) {
            this.releaseBlocker();
            this.onStateChanged?.();
          }
        }, this.inactivityGraceMs);
        this.graceTimer.unref?.();
      }
      return;
    }

    this.clearGraceTimer();
    this.releaseBlocker();
  }

  private acquireBlocker(reason: string): void {
    const wasActive = this.isBlockerActive();
    if (wasActive && this.blockerId !== null) {
      this.blockerReason = reason;
      return;
    }
    const id = this.adapter.startBlocker('prevent-app-suspension');
    this.blockerId = id;
    this.blockerReason = reason;
    if (!wasActive) {
      this.onStateChanged?.();
    }
  }

  private releaseBlocker(): void {
    const prevId = this.blockerId;
    this.blockerId = null;
    this.blockerReason = null;
    if (prevId !== null) {
      try {
        this.adapter.stopBlocker(prevId);
      } catch {
        // Idempotent release safety
      }
      this.onStateChanged?.();
    }
  }

  private clearGraceTimer(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.graceExpiresAtMs = null;
  }

  handlePlatformSuspend(): void {
    if (this.disposed) return;
    this.systemSuspended = true;
    this.lastSuspendAt = new Date(this.nowMs()).toISOString();
    this.clearGraceTimer();
    this.releaseBlocker();
    this.onSystemSuspendCallback?.();
    this.onStateChanged?.();
  }

  handlePlatformResume(): void {
    if (this.disposed) return;
    this.systemSuspended = false;
    this.lastResumeAt = new Date(this.nowMs()).toISOString();
    this.refreshBatteryState();
    this.reconcile();
    this.onSystemResumeCallback?.();
    this.onStateChanged?.();
  }

  getSnapshot(): HostPowerSnapshot {
    const now = this.nowMs();
    const activeDevices =
      this.hostState === 'STANDBY' || this.hostState === 'ACTIVE'
        ? this.collectValidActiveDeviceIds(now)
        : [];
    const active = this.isBlockerActive();

    let policyWarning: string | null = null;
    if (this.policy === 'follow-system') {
      policyWarning =
        'Máy tính sẽ tự động Sleep theo cài đặt của Windows. Khi máy Host ngủ, kết nối LAN và Remote HTTPS sẽ tạm ngừng.';
    } else if (this.policy === 'keep-awake-host-on') {
      policyWarning =
        'Chế độ này ngăn Windows tự động Sleep trong suốt thời gian bật Host Server và có thể làm tăng mức tiêu thụ điện năng (màn hình vẫn tự tắt bình thường).';
    } else {
      policyWarning =
        'Chỉ chặn Windows tự động Sleep khi có thiết bị hợp lệ đang phát nhạc; tự động trả lại chế độ ngủ sau khi ngừng phát.';
    }

    const batteryWarning =
      this.powerSource === 'battery' &&
      (this.policy === 'keep-awake-streaming' || this.policy === 'keep-awake-host-on')
        ? active
          ? 'Laptop đang dùng Pin và DoReMi đang giữ máy thức theo chính sách bạn chọn — mức hao pin sẽ tăng nhanh hơn bình thường.'
          : 'Laptop đang dùng Pin. Chính sách giữ máy thức hiện chọn có thể làm hao pin nhanh hơn khi Host phục vụ nhạc.'
        : null;

    return {
      policy: this.policy,
      blockerActive: active,
      blockerMode: active ? 'prevent-app-suspension' : null,
      blockerReason: active ? this.blockerReason : null,
      activeStreamDeviceCount: activeDevices.length,
      inactivityGraceActive: this.graceTimer !== null,
      inactivityGraceExpiresAt:
        this.graceExpiresAtMs !== null ? new Date(this.graceExpiresAtMs).toISOString() : null,
      powerSource: this.powerSource,
      systemSuspended: this.systemSuspended,
      lastSuspendAt: this.lastSuspendAt,
      lastResumeAt: this.lastResumeAt,
      batteryWarning,
      policyWarning,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribePlatformEvents();
    this.clearGraceTimer();
    this.playbackLeases.clear();
    this.lastKnownActiveDevices.clear();
    this.releaseBlocker();
  }
}
