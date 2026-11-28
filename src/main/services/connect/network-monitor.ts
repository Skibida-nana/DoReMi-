import os from 'node:os';
import { isPrivateLanIpv4, listEligibleLanInterfaces } from './network-interfaces';

export type NetworkChangeKind =
  | 'network_connected'
  | 'network_disconnected'
  | 'lan_ip_changed'
  | 'interface_changed'
  | 'online_hint'
  | 'offline_hint';

export interface NetworkObservationSnapshot {
  hasAnyExternalIpv4: boolean;
  hasPrivateLanIpv4: boolean;
  lanAddresses: string[];
  signature: string;
}

export interface NetworkChangeEvent {
  kind: NetworkChangeKind;
  timestampMs: number;
  previous: NetworkObservationSnapshot | null;
  current: NetworkObservationSnapshot;
}

export interface NetworkMonitorOptions {
  pollIntervalMs?: number;
  inspectInterfaces?: () => NetworkObservationSnapshot;
  nowMs?: () => number;
}

export function captureLocalNetworkObservation(): NetworkObservationSnapshot {
  const ifaces = os.networkInterfaces();
  const nonInternalParts: string[] = [];
  const lanAddresses: string[] = [];

  for (const [name, list] of Object.entries(ifaces)) {
    if (!list) continue;
    for (const entry of list) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      nonInternalParts.push(`${name}=${entry.address}/${entry.netmask}`);
      if (isPrivateLanIpv4(entry.address)) {
        lanAddresses.push(entry.address);
      }
    }
  }

  // Ensure deterministic ordering without exposing MAC addresses, Wi-Fi SSIDs, or GPS
  const eligibleLan = listEligibleLanInterfaces().map((item) => item.address);
  const effectiveLan = eligibleLan.length > 0 ? eligibleLan : lanAddresses;
  nonInternalParts.sort();

  return {
    hasAnyExternalIpv4: nonInternalParts.length > 0,
    hasPrivateLanIpv4: effectiveLan.length > 0,
    lanAddresses: effectiveLan,
    signature: nonInternalParts.join('|'),
  };
}

/**
 * Lightweight, privacy-preserving local network change detector.
 * - Zero external HTTP pings, zero DNS queries, zero Tailscale CLI calls, zero Wi-Fi SSID/GPS collection.
 * - Runs ZERO timers when disarmed (e.g. Local Playback / disconnected).
 * - Combines event-driven online/offline hints with low-frequency in-memory interface signature checks.
 */
export class NetworkChangeMonitor {
  private readonly pollIntervalMs: number;
  private readonly inspectFn: () => NetworkObservationSnapshot;
  private readonly nowMs: () => number;
  private readonly listeners = new Set<(event: NetworkChangeEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshot: NetworkObservationSnapshot | null = null;
  private active = false;

  constructor(options?: NetworkMonitorOptions) {
    this.pollIntervalMs = Math.max(500, options?.pollIntervalMs ?? 4_000);
    this.inspectFn = options?.inspectInterfaces ?? captureLocalNetworkObservation;
    this.nowMs = options?.nowMs ?? (() => Date.now());
  }

  isRunning(): boolean {
    return this.active;
  }

  getCurrentSnapshot(): NetworkObservationSnapshot {
    const snap = this.inspectFn();
    if (!this.lastSnapshot) {
      this.lastSnapshot = snap;
    }
    return snap;
  }

  subscribe(listener: (event: NetworkChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    this.lastSnapshot = this.inspectFn();
    this.timer = setInterval(() => {
      this.checkNow();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  /**
   * Called when Renderer/OS emits online/offline hint or after an active request fails.
   */
  notifyHint(hint: 'online' | 'offline' | 'recheck'): void {
    const prev = this.lastSnapshot;
    const current = this.inspectFn();
    this.lastSnapshot = current;

    if (prev && prev.signature !== current.signature) {
      this.emitChange(this.classifyDiff(prev, current), prev, current);
      return;
    }

    if (hint === 'offline') {
      this.emitChange('offline_hint', prev, current);
    } else if (hint === 'online') {
      this.emitChange('online_hint', prev, current);
    }
  }

  checkNow(): NetworkChangeEvent | null {
    const prev = this.lastSnapshot;
    const current = this.inspectFn();
    this.lastSnapshot = current;
    if (!prev || prev.signature === current.signature) {
      return null;
    }
    const kind = this.classifyDiff(prev, current);
    return this.emitChange(kind, prev, current);
  }

  /**
   * Controlled test helper to inject deterministic network transition events without OS adapter mutation.
   */
  emitSimulatedEvent(kind: NetworkChangeKind, overrideSnapshot?: Partial<NetworkObservationSnapshot>): NetworkChangeEvent {
    const prev = this.lastSnapshot;
    const base = this.inspectFn();
    const current: NetworkObservationSnapshot = {
      ...base,
      ...overrideSnapshot,
    };
    this.lastSnapshot = current;
    return this.emitChange(kind, prev, current);
  }

  private classifyDiff(
    prev: NetworkObservationSnapshot,
    current: NetworkObservationSnapshot,
  ): NetworkChangeKind {
    if (!prev.hasAnyExternalIpv4 && current.hasAnyExternalIpv4) {
      return 'network_connected';
    }
    if (prev.hasAnyExternalIpv4 && !current.hasAnyExternalIpv4) {
      return 'network_disconnected';
    }
    if (prev.lanAddresses.join(',') !== current.lanAddresses.join(',')) {
      return 'lan_ip_changed';
    }
    return 'interface_changed';
  }

  private emitChange(
    kind: NetworkChangeKind,
    prev: NetworkObservationSnapshot | null,
    current: NetworkObservationSnapshot,
  ): NetworkChangeEvent {
    const ev: NetworkChangeEvent = {
      kind,
      timestampMs: this.nowMs(),
      previous: prev,
      current,
    };
    for (const listener of this.listeners) {
      listener(ev);
    }
    return ev;
  }
}
