import type {
  CodecDiscoveryPolicy,
  EffectiveResourceLimits,
  PlaybackPriorityState,
  ResourceMode,
  ResourceModePolicy,
} from '../../../shared/types/codec-engine';
import {
  DEFAULT_RESOURCE_MODE,
  RESOURCE_MODE_POLICIES,
} from '../../../shared/utils/codec-registry';
import type { CodecManager } from './codec-manager';

export type ResourcePolicyListener = (limits: EffectiveResourceLimits) => void;

/**
 * Pure, event-driven Resource & Playback Priority Policy Manager.
 * - Default mode: Power Saving (`concurrency = 1`, U-series laptop / 8GB RAM friendly).
 * - Accepts controllable PlaybackPriorityState without coupling directly to AudioEngine.
 * - Never reduces audio quality, never requires Administrator privileges, and runs zero background timers.
 */
export class ResourcePolicyManager {
  private mode: ResourceMode;
  private playbackState: PlaybackPriorityState;
  private readonly listeners = new Set<ResourcePolicyListener>();

  constructor(
    initialMode: ResourceMode = DEFAULT_RESOURCE_MODE,
    initialPlayback: Partial<PlaybackPriorityState> = {},
  ) {
    this.mode = isValidResourceMode(initialMode) ? initialMode : DEFAULT_RESOURCE_MODE;
    this.playbackState = {
      isPlaying: Boolean(initialPlayback.isPlaying),
      isBuffering: Boolean(initialPlayback.isBuffering),
      activeTrackFormat: initialPlayback.activeTrackFormat ?? null,
      updatedAt: initialPlayback.updatedAt ?? new Date().toISOString(),
    };
  }

  getMode(): ResourceMode {
    return this.mode;
  }

  getPolicy(mode: ResourceMode = this.mode): ResourceModePolicy {
    return { ...RESOURCE_MODE_POLICIES[mode] };
  }

  getPlaybackState(): PlaybackPriorityState {
    return { ...this.playbackState };
  }

  setMode(mode: ResourceMode): EffectiveResourceLimits {
    const nextMode = isValidResourceMode(mode) ? mode : DEFAULT_RESOURCE_MODE;
    if (this.mode !== nextMode) {
      this.mode = nextMode;
      this.notifyListeners();
    }
    return this.getEffectiveLimits();
  }

  setPlaybackState(partial: Partial<PlaybackPriorityState>): EffectiveResourceLimits {
    const nextPlaying =
      partial.isPlaying !== undefined ? Boolean(partial.isPlaying) : this.playbackState.isPlaying;
    const nextBuffering =
      partial.isBuffering !== undefined
        ? Boolean(partial.isBuffering)
        : Boolean(this.playbackState.isBuffering);
    const nextFormat =
      partial.activeTrackFormat !== undefined
        ? partial.activeTrackFormat
        : this.playbackState.activeTrackFormat ?? null;

    const changed =
      nextPlaying !== this.playbackState.isPlaying ||
      nextBuffering !== Boolean(this.playbackState.isBuffering) ||
      nextFormat !== (this.playbackState.activeTrackFormat ?? null);

    this.playbackState = {
      isPlaying: nextPlaying,
      isBuffering: nextBuffering,
      activeTrackFormat: nextFormat,
      updatedAt: new Date().toISOString(),
    };

    if (changed) {
      this.notifyListeners();
    }
    return this.getEffectiveLimits();
  }

  /**
   * Computes current bounded limits combining the selected Resource Mode and active Playback Priority state.
   */
  getEffectiveLimits(): EffectiveResourceLimits {
    const policy = RESOURCE_MODE_POLICIES[this.mode];
    const playbackActive = Boolean(this.playbackState.isPlaying || this.playbackState.isBuffering);

    const conversionConcurrency = playbackActive
      ? Math.min(policy.maxConversionConcurrency, policy.playbackConversionConcurrencyCap)
      : policy.maxConversionConcurrency;

    const encoderThreads = playbackActive
      ? Math.min(policy.maxEncoderThreads, policy.playbackEncoderThreadsCap)
      : policy.maxEncoderThreads;

    const probeConcurrency = playbackActive ? 1 : policy.maxProbeConcurrency;
    const analyzerConcurrency = playbackActive ? 1 : policy.maxAnalyzerConcurrency;

    return {
      mode: this.mode,
      playbackPriorityActive: playbackActive,
      conversionConcurrency: Math.max(1, conversionConcurrency),
      encoderThreads: Math.max(1, encoderThreads),
      probeConcurrency: Math.max(1, probeConcurrency),
      analyzerConcurrency: Math.max(1, analyzerConcurrency),
      progressThrottleMs: policy.progressThrottleMs,
      deferNewConversionJobs: playbackActive && policy.deferNewJobsDuringPlayback,
      deferCodecScanning: playbackActive && policy.deferProbeWhenPlaybackActive,
      deferHeavyAnalysis: playbackActive && policy.deferHeavyAnalysisWhenPlaybackActive,
    };
  }

  /**
   * Projects the current effective limits into a `CodecDiscoveryPolicy` patch for `CodecManager`.
   */
  toCodecDiscoveryPolicy(): Partial<CodecDiscoveryPolicy> {
    const limits = this.getEffectiveLimits();
    return {
      maxProbeConcurrency: limits.probeConcurrency,
      deferProbeWhenPlaybackActive: limits.deferCodecScanning,
    };
  }

  /**
   * Synchronizes `CodecManager.setDiscoveryPolicy(...)` immediately and whenever resource mode or playback state changes.
   * Returns an unsubscribe function so callers can cleanly detach.
   */
  attachCodecManager(codecManager: CodecManager): () => void {
    const sync = () => {
      codecManager.setDiscoveryPolicy(this.toCodecDiscoveryPolicy());
    };
    sync();
    return this.subscribe(() => {
      sync();
    });
  }

  subscribe(listener: ResourcePolicyListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    const limits = this.getEffectiveLimits();
    for (const listener of this.listeners) {
      listener(limits);
    }
  }
}

export function isValidResourceMode(value: unknown): value is ResourceMode {
  return value === 'power-saving' || value === 'balanced' || value === 'performance';
}
