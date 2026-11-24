import { buildTrackMediaUrl } from '../../../shared/contracts/media-protocol';
import type {
  AudioDspRuntimeSnapshot,
  AudioLabSettings,
} from '../../../shared/types/audio-dsp';
import type { VerifyTrackResult } from '../../../shared/types/library';
import type {
  AudioEngineController,
  PlaybackState,
  PlaybackStatus,
} from '../../../shared/types/player';
import type {
  FadeDurationSec,
  ListeningSessionInput,
  PlaybackTransitionSettings,
} from '../../../shared/types/stage5';
import type {
  ComputedReplayGain,
  ReplayGainSettings,
  TrackReplayGainMetadata,
} from '../../../shared/types/stage6';
import type { TrackRecord } from '../../../shared/types/track';
import { classifyTrackAudioCodec } from '../../../shared/utils/audio-codec';
import {
  DEFAULT_REPLAYGAIN_SETTINGS,
  computeReplayGainMultiplier,
  normalizeReplayGainSettings,
} from '../../../shared/utils/replaygain';
import {
  AudioDspGraph,
  createBrowserAudioContextFactory,
  type AudioContextFactory,
} from './audio-dsp';

export interface MediaErrorLike {
  readonly code: number;
  readonly message?: string;
}

/**
 * Minimal subset of HTMLAudioElement used by AudioEngine.
 * Allows deterministic unit testing in Node.js while using the real HTMLAudioElement in Electron.
 */
export interface AudioElementLike {
  src: string;
  crossOrigin?: string | null;
  currentTime: number;
  readonly duration: number;
  volume: number;
  muted: boolean;
  preload: string;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly error: MediaErrorLike | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface AudioEngineDependencies {
  createAudioElement?: () => AudioElementLike;
  /** Optional Web Audio Context factory (defaults to browser AudioContext; null in Node.js tests unless explicitly injected) */
  createAudioContext?: AudioContextFactory | null;
  verifyTrack?: (trackId: string) => Promise<VerifyTrackResult>;
  onTrackMissing?: (trackId: string) => void;
  onSessionCheckpoint?: (session: ListeningSessionInput) => void;
  /** Optional step interval override in ms for deterministic unit tests (default: 24ms) */
  fadeStepMs?: number;
  /** Optional clock override in ms for deterministic unit tests */
  nowMs?: () => number;
}

const DEFAULT_VOLUME = 0.85;
const VALID_FADE_DURATIONS = new Set<FadeDurationSec>([0.5, 1, 2, 3]);

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function extractTrackReplayGainMeta(track: TrackRecord | null): TrackReplayGainMetadata | null {
  if (!track) {
    return null;
  }
  const trackGainDb =
    typeof track.replaygain_track_gain_db === 'number' && Number.isFinite(track.replaygain_track_gain_db)
      ? track.replaygain_track_gain_db
      : null;
  const albumGainDb =
    typeof track.replaygain_album_gain_db === 'number' && Number.isFinite(track.replaygain_album_gain_db)
      ? track.replaygain_album_gain_db
      : null;
  const trackPeak =
    typeof track.replaygain_track_peak === 'number' && Number.isFinite(track.replaygain_track_peak)
      ? track.replaygain_track_peak
      : null;
  const albumPeak =
    typeof track.replaygain_album_peak === 'number' && Number.isFinite(track.replaygain_album_peak)
      ? track.replaygain_album_peak
      : null;
  if (
    trackGainDb === null &&
    albumGainDb === null &&
    trackPeak === null &&
    albumPeak === null
  ) {
    return null;
  }
  return { trackGainDb, albumGainDb, trackPeak, albumPeak };
}

function describeMediaError(error: MediaErrorLike | null, track: TrackRecord | null): string {
  const classified = track ? classifyTrackAudioCodec(track) : null;
  const formatHint = classified
    ? classified.isM4aContainer
      ? `${classified.displayCodec} (${classified.qualityLabel})`
      : classified.displayCodec
    : track?.container ?? track?.codec ?? '';

  if (!error) {
    return 'Không thể phát file âm thanh này.';
  }

  switch (error.code) {
    case 1:
      return 'Quá trình tải âm thanh đã bị hủy.';
    case 2:
      return 'Không thể đọc luồng dữ liệu âm thanh cục bộ. Kiểm tra xem file gốc còn tồn tại không.';
    case 3:
      return `Lỗi giải mã dữ liệu âm thanh${formatHint ? ` (${formatHint})` : ''}. File có thể bị hỏng.`;
    case 4:
      if (classified?.family === 'alac') {
        return 'Không thể giải mã luồng ALAC (Apple Lossless) từ file M4A này. Hãy kiểm tra file gốc hoặc thử mở lại ứng dụng.';
      }
      if (classified?.family === 'aac') {
        return 'Bộ giải mã hệ thống hiện tại không phát được luồng AAC trong file M4A này hoặc file bị hỏng.';
      }
      return `Định dạng hoặc codec${formatHint ? ` (${formatHint})` : ''} không được trình phát hỗ trợ, hoặc file gốc không còn tồn tại.`;
    default:
      return error.message || 'Đã xảy ra lỗi không xác định khi phát nhạc.';
  }
}

interface ActiveListeningSession {
  sessionId: string;
  track: TrackRecord;
  startedAtMs: number;
  lastEndedAtMs: number;
  accumulatedMs: number;
  activeSegmentStartMs: number | null;
  intervals: Array<{ startMs: number; endMs: number }>;
  lastFlushedMs: number;
}

/**
 * Singleton Audio Engine wrapping a single HTMLAudioElement + Web Audio DSP Graph
 * for the entire application lifecycle.
 *
 * Gain ownership invariant (NO double attenuation):
 * - Direct Playback Path (when Web Audio DSP is not active):
 *   `audio.volume = clamp(userVolume * fadeMultiplier * directReplayGain, 0, 1)`, `audio.muted = muted`.
 * - DSP Playback Path (once MediaElementAudioSourceNode is attached):
 *   `audio.volume = 1.0`, `audio.muted = false`;
 *   `replayGainNode`, `preampNode`, active EQ chain, `fadeGainNode`, `userVolumeNode`, and `muteGainNode`
 *   each own exactly ONE independent stage.
 */
export class AudioEngine implements AudioEngineController {
  private readonly audio: AudioElementLike;
  private readonly dsp: AudioDspGraph;
  private readonly verifyTrackFn?: (trackId: string) => Promise<VerifyTrackResult>;
  private readonly onTrackMissingFn?: (trackId: string) => void;
  private readonly onSessionCheckpointFn?: (session: ListeningSessionInput) => void;
  private readonly fadeStepMs: number;
  private readonly nowMs: () => number;
  private readonly listeners = new Set<(state: PlaybackState) => void>();
  private readonly dspListeners = new Set<(snapshot: AudioDspRuntimeSnapshot) => void>();

  private queue: TrackRecord[] = [];
  private currentTrackId: string | null = null;
  private status: PlaybackStatus = 'idle';
  private currentTimeSeconds = 0;
  private durationSeconds = 0;
  private volume = DEFAULT_VOLUME;
  private muted = false;
  private errorMessage: string | null = null;
  private playRequestSeq = 0;
  private cachedSnapshot: PlaybackState;
  private cachedDspSnapshot: AudioDspRuntimeSnapshot;

  // Stage 5: Fade In/Out transition state (never mutates `this.volume`)
  private transitionConfig: PlaybackTransitionSettings = {
    enabled: false,
    durationSec: 1,
  };
  private fadeToken = 0;
  private activeFadeTimer: ReturnType<typeof setInterval> | null = null;
  private activeFadeTimeout: ReturnType<typeof setTimeout> | null = null;
  private activeFadeResolve: ((completed: boolean) => void) | null = null;
  private currentFadeMultiplier = 1;

  // Phase 7: ReplayGain integration
  private replayGainSettings: ReplayGainSettings = { ...DEFAULT_REPLAYGAIN_SETTINGS };
  private activeReplayGain: ComputedReplayGain = computeReplayGainMultiplier(
    DEFAULT_REPLAYGAIN_SETTINGS,
    null,
  );

  // Stage 5: Real active listening session tracker
  private activeSession: ActiveListeningSession | null = null;

  constructor(deps: AudioEngineDependencies = {}) {
    const createEl =
      deps.createAudioElement ??
      (() => {
        const el = new Audio();
        el.preload = 'metadata';
        el.crossOrigin = 'anonymous';
        return el as unknown as AudioElementLike;
      });

    this.audio = createEl();
    this.audio.preload = 'metadata';
    // Required for lossless-media:// custom protocol CORS -> MediaElementAudioSourceNode
    if ('crossOrigin' in this.audio || typeof HTMLAudioElement !== 'undefined') {
      try {
        this.audio.crossOrigin = 'anonymous';
      } catch {
        // Ignore on custom mock objects without setter
      }
    }
    this.audio.volume = this.volume;
    this.audio.muted = this.muted;

    const contextFactory =
      deps.createAudioContext !== undefined
        ? deps.createAudioContext
        : createBrowserAudioContextFactory();
    this.dsp = new AudioDspGraph(this.audio, contextFactory);
    this.dsp.setUserVolume(this.volume, true);
    this.dsp.setMuted(this.muted, true);
    this.dsp.setFadeGainImmediate(1);

    this.verifyTrackFn = deps.verifyTrack;
    this.onTrackMissingFn = deps.onTrackMissing;
    this.onSessionCheckpointFn = deps.onSessionCheckpoint;
    this.fadeStepMs = Math.max(8, deps.fadeStepMs ?? 24);
    this.nowMs = deps.nowMs ?? (() => Date.now());

    this.bindAudioEvents();
    this.cachedSnapshot = this.buildSnapshot();
    this.cachedDspSnapshot = this.dsp.getRuntimeSnapshot();
  }

  // ---------------------------------------------------------------------------
  // Phase 7: Audio Lab DSP & ReplayGain Controls
  // ---------------------------------------------------------------------------

  async ensureDspReady(): Promise<boolean> {
    if (!this.dsp.canInitialize()) {
      return false;
    }
    const ok = await this.dsp.ensureInitialized();
    if (ok) {
      // Pin HTMLAudioElement to unity unmuted so DSP GainNodes are the SOLE gain owners
      this.audio.volume = 1;
      this.audio.muted = false;
      this.dsp.setUserVolume(this.volume, true);
      this.dsp.setMuted(this.muted, true);
      this.dsp.setFadeGainImmediate(this.currentFadeMultiplier);
      this.dsp.setReplayGain(this.replayGainSettings, this.activeReplayGain, true);
    } else if (!this.dsp.isSourceBound()) {
      // Safe fallback to Direct Playback Path
      this.applyDirectAudioGain();
    }
    this.emitDspState();
    return ok;
  }

  setAudioLabSettings(settings: AudioLabSettings): void {
    this.dsp.setSettings(settings);
    // Lazily initialize DSP if user enables EQ while a track is already active/playing
    if (
      settings.enabled &&
      this.dsp.canInitialize() &&
      !this.dsp.isActive() &&
      (this.status === 'playing' || this.status === 'paused' || this.status === 'loading')
    ) {
      void this.ensureDspReady();
      return;
    }
    this.emitDspState();
  }

  getAudioLabSettings(): AudioLabSettings {
    return this.dsp.getSettings();
  }

  setReplayGainSettings(partial: Partial<ReplayGainSettings>): void {
    this.replayGainSettings = normalizeReplayGainSettings({
      ...this.replayGainSettings,
      ...partial,
    });
    this.recomputeTrackReplayGain(this.getCurrentTrack(), false);
    this.emitDspState();
  }

  getReplayGainSettings(): ReplayGainSettings {
    return { ...this.replayGainSettings };
  }

  getDspRuntimeSnapshot(): AudioDspRuntimeSnapshot {
    return this.cachedDspSnapshot;
  }

  subscribeDsp(listener: (snapshot: AudioDspRuntimeSnapshot) => void): () => void {
    this.dspListeners.add(listener);
    return () => {
      this.dspListeners.delete(listener);
    };
  }

  readSpectrumData(target: Uint8Array): boolean {
    return this.dsp.readSpectrumData(target);
  }

  getAnalyserBinCount(): number {
    return this.dsp.getAnalyserBinCount();
  }

  getDspDebugNodes() {
    return this.dsp.getDebugNodes();
  }

  dispose(): void {
    this.finalizeSession(true);
    this.cancelActiveFade(true);
    this.audio.pause();
    this.dsp.dispose();
    this.listeners.clear();
    this.dspListeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Transition Config & Queue
  // ---------------------------------------------------------------------------

  setTransitionConfig(partial: Partial<PlaybackTransitionSettings>): void {
    const nextEnabled =
      typeof partial.enabled === 'boolean' ? partial.enabled : this.transitionConfig.enabled;
    const nextDuration =
      partial.durationSec && VALID_FADE_DURATIONS.has(partial.durationSec)
        ? partial.durationSec
        : this.transitionConfig.durationSec;

    this.transitionConfig = {
      enabled: nextEnabled,
      durationSec: nextDuration,
    };

    if (!nextEnabled) {
      this.cancelActiveFade(true);
    }
  }

  getTransitionConfig(): PlaybackTransitionSettings {
    return { ...this.transitionConfig };
  }

  setQueue(tracks: TrackRecord[]): void {
    this.queue = [...tracks];
    // Refresh current track metadata if it was updated (e.g. marked missing or ReplayGain rescanned)
    if (this.currentTrackId) {
      const updated = this.queue.find((item) => item.id === this.currentTrackId) ?? null;
      if (updated && updated.status === 'missing' && this.status === 'playing') {
        this.finalizeSession(true);
        this.cancelActiveFade(true);
        this.audio.pause();
        this.status = 'error';
        this.errorMessage = 'File âm thanh gốc không còn tồn tại trên ổ đĩa.';
      } else if (updated) {
        this.recomputeTrackReplayGain(updated, false);
        this.emitDspState();
      }
    }
    this.emitState();
  }

  async play(trackId: string): Promise<void> {
    const track = this.queue.find((item) => item.id === trackId) ?? null;
    if (!track) {
      this.cancelActiveFade(true);
      this.status = 'error';
      this.errorMessage = 'Không tìm thấy bài hát trong danh sách thư viện.';
      this.emitState();
      return;
    }

    if (track.status === 'missing') {
      this.finalizeSession(true);
      this.cancelActiveFade(true);
      this.currentTrackId = track.id;
      this.status = 'error';
      this.errorMessage = `File gốc không còn tồn tại: ${track.original_path}`;
      this.emitState();
      return;
    }

    const requestToken = ++this.playRequestSeq;
    const wasActivelyPlayingOtherTrack =
      this.currentTrackId !== null &&
      this.currentTrackId !== track.id &&
      this.status === 'playing' &&
      !this.audio.paused;

    // Close previous listening session before switching track
    if (this.activeSession && this.activeSession.track.id !== track.id) {
      this.finalizeSession(true);
    }

    // Cancel any previous fade so rapid Next/Prev never stacks timers
    this.cancelActiveFade(false);

    // Optional smooth Fade Out on the outgoing track before swapping audio.src
    const shouldFade =
      this.transitionConfig.enabled && !this.muted && this.volume > 0.005;
    if (shouldFade && wasActivelyPlayingOtherTrack) {
      const fadeOutMs = Math.max(60, Math.round(this.transitionConfig.durationSec * 450));
      const completed = await this.rampFadeMultiplier(this.currentFadeMultiplier, 0, fadeOutMs);
      if (!completed || requestToken !== this.playRequestSeq) {
        // A newer play/pause/seek interrupted us — never leave gain stuck at 0
        if (requestToken === this.playRequestSeq) {
          this.setFadeMultiplier(1);
        }
        return;
      }
    }

    this.currentTrackId = track.id;
    this.status = 'loading';
    this.errorMessage = null;
    this.currentTimeSeconds = 0;
    this.durationSeconds = track.duration_ms ? track.duration_ms / 1000 : 0;
    this.recomputeTrackReplayGain(track, true);
    this.emitState();
    this.emitDspState();

    // Verify source file on disk via Electron Main before streaming
    if (this.verifyTrackFn) {
      try {
        const check = await this.verifyTrackFn(track.id);
        if (requestToken !== this.playRequestSeq) {
          return;
        }
        if (!check.exists) {
          this.setFadeMultiplier(1);
          this.status = 'error';
          this.errorMessage =
            check.reason ?? `File gốc không còn tồn tại: ${track.original_path}`;
          this.onTrackMissingFn?.(track.id);
          this.emitState();
          return;
        }
      } catch (error) {
        if (requestToken !== this.playRequestSeq) {
          return;
        }
        this.setFadeMultiplier(1);
        this.status = 'error';
        this.errorMessage = `Lỗi kiểm tra file trước khi phát: ${error instanceof Error ? error.message : String(error)}`;
        this.emitState();
        return;
      }
    }

    let mediaUrl: string;
    try {
      mediaUrl = buildTrackMediaUrl(track.id);
    } catch (error) {
      this.setFadeMultiplier(1);
      this.status = 'error';
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.emitState();
      return;
    }

    // Lazily initialize Web Audio DSP on user-initiated playback when Web Audio is available
    if (this.dsp.canInitialize()) {
      await this.ensureDspReady();
      if (requestToken !== this.playRequestSeq) {
        return;
      }
    }

    // Prepare incoming fade multiplier: 0 for smooth Fade In, or 1.0 full gain
    const shouldFadeIn =
      this.transitionConfig.enabled && !this.muted && this.volume > 0.005;
    this.setFadeMultiplier(shouldFadeIn ? 0 : 1);
    this.audio.src = mediaUrl;
    this.audio.load();

    try {
      await this.audio.play();
      if (requestToken !== this.playRequestSeq) {
        return;
      }
      if (this.dsp.isActive()) {
        await this.dsp.resumeIfSuspended();
        this.emitDspState();
      }
      if (this.status === 'loading') {
        this.status = 'playing';
        this.startOrResumeSession(track);
        this.emitState();
      }

      if (shouldFadeIn) {
        const fadeInMs = Math.max(80, Math.round(this.transitionConfig.durationSec * 550));
        void this.rampFadeMultiplier(0, 1, fadeInMs).then((done) => {
          if (done && requestToken === this.playRequestSeq) {
            this.setFadeMultiplier(1);
          }
        });
      } else {
        this.setFadeMultiplier(1);
      }
    } catch (error) {
      this.cancelActiveFade(true);
      if (requestToken !== this.playRequestSeq) {
        return;
      }
      // AbortError happens naturally when user rapidly switches tracks
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      this.status = 'error';
      this.errorMessage = this.audio.error
        ? describeMediaError(this.audio.error, track)
        : `Không thể bắt đầu phát nhạc: ${error instanceof Error ? error.message : String(error)}`;
      this.emitState();
    }
  }

  pause(): void {
    if (!this.currentTrackId) {
      return;
    }
    this.playRequestSeq += 1;
    this.cancelActiveFade(true);
    this.pauseSessionSegment(true);
    this.audio.pause();
    if (this.status === 'playing' || this.status === 'loading') {
      this.status = 'paused';
      this.emitState();
    }
  }

  async resume(): Promise<void> {
    if (!this.currentTrackId) {
      const firstPlayable = this.queue.find((t) => t.status === 'available');
      if (firstPlayable) {
        await this.play(firstPlayable.id);
      }
      return;
    }

    if (this.status === 'error') {
      await this.play(this.currentTrackId);
      return;
    }

    if (this.status === 'ended') {
      this.finalizeSession(true);
      this.audio.currentTime = 0;
      this.currentTimeSeconds = 0;
    }

    this.cancelActiveFade(true);
    const requestToken = ++this.playRequestSeq;

    if (this.dsp.canInitialize()) {
      await this.ensureDspReady();
      if (requestToken !== this.playRequestSeq) {
        return;
      }
    }

    try {
      await this.audio.play();
      if (requestToken !== this.playRequestSeq) {
        return;
      }
      if (this.dsp.isActive()) {
        await this.dsp.resumeIfSuspended();
        this.emitDspState();
      }
      this.status = 'playing';
      this.errorMessage = null;
      const current = this.getCurrentTrack();
      if (current) {
        this.startOrResumeSession(current);
      }
      this.emitState();
    } catch (error) {
      this.setFadeMultiplier(1);
      if (requestToken !== this.playRequestSeq) {
        return;
      }
      this.status = 'error';
      this.errorMessage = `Không thể tiếp tục phát: ${error instanceof Error ? error.message : String(error)}`;
      this.emitState();
    }
  }

  /**
   * Seeks directly to a valid timestamp in seconds without reloading audio.src.
   * Does NOT add seek-skipped time to listening statistics.
   */
  seek(seconds: number): void {
    if (!this.currentTrackId || !this.audio.src) {
      return;
    }

    const effectiveDuration =
      Number.isFinite(this.audio.duration) && this.audio.duration > 0
        ? this.audio.duration
        : this.durationSeconds;

    if (effectiveDuration <= 0) {
      return;
    }

    // If user seeks while fading, immediately restore full fade gain (1.0)
    this.cancelActiveFade(true);

    // Split active listening interval cleanly at current wall-clock time
    if (this.status === 'playing' && this.activeSession) {
      this.pauseSessionSegment(false);
      const now = this.nowMs();
      this.activeSession.activeSegmentStartMs = now;
    }

    const target = clamp(seconds, 0, effectiveDuration);
    this.audio.currentTime = target;
    this.currentTimeSeconds = target;

    if (this.status === 'ended' && target < effectiveDuration) {
      this.status = 'paused';
    }

    this.emitState();
  }

  async next(): Promise<void> {
    const target = this.findAdjacentPlayableTrack(1);
    if (target) {
      await this.play(target.id);
    }
  }

  async previous(): Promise<void> {
    // Standard desktop player behavior: restart current track if past 3 seconds
    if (this.currentTrackId && this.currentTimeSeconds > 3) {
      this.seek(0);
      return;
    }

    const target = this.findAdjacentPlayableTrack(-1);
    if (target) {
      await this.play(target.id);
    }
  }

  setVolume(value: number): void {
    const clamped = clamp(value, 0, 1);
    this.cancelActiveFade(true);
    this.volume = clamped;

    if (clamped > 0 && this.muted) {
      this.muted = false;
    }

    if (this.dsp.isActive() || this.dsp.isSourceBound()) {
      this.audio.volume = 1;
      this.audio.muted = false;
      this.dsp.setUserVolume(this.volume, false);
      this.dsp.setMuted(this.muted, false);
    } else {
      this.audio.muted = this.muted;
      this.applyDirectAudioGain();
    }

    this.emitState();
  }

  toggleMute(): void {
    this.muted = !this.muted;

    if (this.dsp.isActive() || this.dsp.isSourceBound()) {
      this.audio.volume = 1;
      this.audio.muted = false;
      this.dsp.setMuted(this.muted, false);
    } else {
      this.audio.muted = this.muted;
      if (!this.muted && !this.activeFadeTimer) {
        this.applyDirectAudioGain();
      }
    }

    this.emitState();
  }

  getPlaybackState(): PlaybackState {
    return this.cachedSnapshot;
  }

  subscribe(listener: (state: PlaybackState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---------------------------------------------------------------------------
  // Gain & Fade Engine Helpers (Unified DSP AudioParam + Direct Path)
  // ---------------------------------------------------------------------------

  private recomputeTrackReplayGain(track: TrackRecord | null, immediate: boolean): void {
    const meta = extractTrackReplayGainMeta(track);
    this.activeReplayGain = computeReplayGainMultiplier(this.replayGainSettings, meta);
    this.dsp.setReplayGain(this.replayGainSettings, this.activeReplayGain, immediate);
    if (!this.dsp.isActive()) {
      this.applyDirectAudioGain();
    }
  }

  private applyDirectAudioGain(): void {
    // In Direct Path (no DSP), audio.volume is clamped to 0..1; ReplayGain attenuation applies safely.
    const directRg = this.activeReplayGain.applied
      ? clamp(this.activeReplayGain.linearGain, 0.063, 1)
      : 1;
    this.audio.volume = clamp(this.volume * this.currentFadeMultiplier * directRg, 0, 1);
  }

  private setFadeMultiplier(multiplier: number): void {
    this.currentFadeMultiplier = clamp(multiplier, 0, 1);
    if (this.dsp.isActive()) {
      this.dsp.setFadeGainImmediate(this.currentFadeMultiplier);
    } else {
      this.applyDirectAudioGain();
    }
  }

  private cancelActiveFade(restoreFullGain: boolean): void {
    this.fadeToken += 1;
    if (this.activeFadeTimer !== null) {
      clearInterval(this.activeFadeTimer);
      this.activeFadeTimer = null;
    }
    if (this.activeFadeTimeout !== null) {
      clearTimeout(this.activeFadeTimeout);
      this.activeFadeTimeout = null;
    }
    const pendingResolve = this.activeFadeResolve;
    this.activeFadeResolve = null;
    if (pendingResolve) {
      pendingResolve(false);
    }
    if (restoreFullGain) {
      this.setFadeMultiplier(1);
    }
  }

  private rampFadeMultiplier(
    fromMultiplier: number,
    toMultiplier: number,
    durationMs: number,
  ): Promise<boolean> {
    this.cancelActiveFade(false);
    const token = this.fadeToken;
    const startMul = clamp(fromMultiplier, 0, 1);
    const targetMul = clamp(toMultiplier, 0, 1);

    if (durationMs <= this.fadeStepMs || Math.abs(targetMul - startMul) < 0.002) {
      this.setFadeMultiplier(targetMul);
      return Promise.resolve(true);
    }

    // DSP Path: use native sample-accurate Web Audio AudioParam ramp on fadeGainNode
    if (this.dsp.isActive()) {
      this.currentFadeMultiplier = startMul;
      this.dsp.scheduleFadeRamp(startMul, targetMul, durationMs / 1000);
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (completed: boolean) => {
          if (settled) {
            return;
          }
          settled = true;
          if (this.activeFadeTimeout !== null) {
            clearTimeout(this.activeFadeTimeout);
            this.activeFadeTimeout = null;
          }
          if (this.activeFadeResolve === settle) {
            this.activeFadeResolve = null;
          }
          resolve(completed);
        };

        this.activeFadeResolve = settle;
        this.activeFadeTimeout = setTimeout(() => {
          this.activeFadeTimeout = null;
          if (token !== this.fadeToken) {
            settle(false);
            return;
          }
          this.currentFadeMultiplier = targetMul;
          this.dsp.setFadeGainImmediate(targetMul);
          settle(true);
        }, durationMs);
      });
    }

    // Direct Path fallback: smooth stepped ease-in-out on audio.volume
    const startTime = this.nowMs();
    this.setFadeMultiplier(startMul);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (completed: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.activeFadeTimer !== null) {
          clearInterval(this.activeFadeTimer);
          this.activeFadeTimer = null;
        }
        if (this.activeFadeResolve === settle) {
          this.activeFadeResolve = null;
        }
        resolve(completed);
      };

      this.activeFadeResolve = settle;
      this.activeFadeTimer = setInterval(() => {
        if (token !== this.fadeToken) {
          settle(false);
          return;
        }
        const elapsed = Math.max(0, this.nowMs() - startTime);
        const progress = Math.min(1, elapsed / durationMs);
        const eased =
          progress < 0.5
            ? 2 * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 2) / 2;

        const nextMul = clamp(startMul + (targetMul - startMul) * eased, 0, 1);
        this.setFadeMultiplier(nextMul);

        if (progress >= 1) {
          this.setFadeMultiplier(targetMul);
          settle(true);
        }
      }, this.fadeStepMs);
    });
  }

  private emitDspState(): void {
    this.cachedDspSnapshot = this.dsp.getRuntimeSnapshot();
    for (const listener of this.dspListeners) {
      listener(this.cachedDspSnapshot);
    }
  }

  // ---------------------------------------------------------------------------
  // Active Listening Session Tracking (Real SQLite Stats)
  // ---------------------------------------------------------------------------

  private startOrResumeSession(track: TrackRecord): void {
    const now = this.nowMs();
    if (!this.activeSession || this.activeSession.track.id !== track.id) {
      if (this.activeSession) {
        this.finalizeSession(true);
      }
      this.activeSession = {
        sessionId: `ls-local-${now}-${Math.random().toString(36).slice(2, 8)}`,
        track,
        startedAtMs: now,
        lastEndedAtMs: now,
        accumulatedMs: 0,
        activeSegmentStartMs: now,
        intervals: [],
        lastFlushedMs: 0,
      };
      return;
    }

    if (this.activeSession.activeSegmentStartMs === null) {
      this.activeSession.activeSegmentStartMs = now;
    }
  }

  private pauseSessionSegment(flushCheckpoint: boolean): void {
    if (!this.activeSession) {
      return;
    }
    const now = this.nowMs();
    if (this.activeSession.activeSegmentStartMs !== null) {
      const delta = Math.max(0, now - this.activeSession.activeSegmentStartMs);
      if (delta > 0) {
        this.activeSession.accumulatedMs += delta;
        this.activeSession.intervals.push({
          startMs: this.activeSession.activeSegmentStartMs,
          endMs: now,
        });
      }
      this.activeSession.activeSegmentStartMs = null;
      this.activeSession.lastEndedAtMs = now;
    }

    if (flushCheckpoint) {
      this.emitSessionCheckpoint();
    }
  }

  private finalizeSession(flushCheckpoint: boolean): void {
    if (!this.activeSession) {
      return;
    }
    this.pauseSessionSegment(flushCheckpoint);
    this.activeSession = null;
  }

  private emitSessionCheckpoint(force = false): void {
    if (!this.activeSession || !this.onSessionCheckpointFn) {
      return;
    }
    const now = this.nowMs();
    let totalMs = this.activeSession.accumulatedMs;
    const intervals = [...this.activeSession.intervals];
    if (this.activeSession.activeSegmentStartMs !== null) {
      const delta = Math.max(0, now - this.activeSession.activeSegmentStartMs);
      if (delta > 0) {
        totalMs += delta;
        intervals.push({
          startMs: this.activeSession.activeSegmentStartMs,
          endMs: now,
        });
      }
    }

    if (totalMs < 1000) {
      return;
    }
    if (!force && totalMs - this.activeSession.lastFlushedMs < 5000) {
      return;
    }

    this.activeSession.lastFlushedMs = totalMs;
    const durationMs =
      this.activeSession.track.duration_ms ??
      (this.durationSeconds > 0 ? Math.round(this.durationSeconds * 1000) : null);

    this.onSessionCheckpointFn({
      sessionId: this.activeSession.sessionId,
      trackId: this.activeSession.track.id,
      trackTitle: this.activeSession.track.title,
      artist: this.activeSession.track.artist,
      album: this.activeSession.track.album,
      durationMs,
      startedAtMs: this.activeSession.startedAtMs,
      endedAtMs: Math.max(this.activeSession.startedAtMs, now),
      listenedMs: Math.round(totalMs),
      activeIntervals: intervals,
    });
  }

  private bindAudioEvents(): void {
    this.audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(this.audio.duration) && this.audio.duration >= 0) {
        this.durationSeconds = this.audio.duration;
      }
      this.emitState();
    });

    this.audio.addEventListener('timeupdate', () => {
      if (Number.isFinite(this.audio.currentTime)) {
        this.currentTimeSeconds = this.audio.currentTime;
        if (this.status === 'playing' && this.activeSession) {
          this.emitSessionCheckpoint(false);
        }
        this.emitState();
      }
    });

    this.audio.addEventListener('playing', () => {
      this.status = 'playing';
      this.errorMessage = null;
      const track = this.getCurrentTrack();
      if (track) {
        this.startOrResumeSession(track);
      }
      this.emitState();
    });

    this.audio.addEventListener('pause', () => {
      this.pauseSessionSegment(true);
      if (this.status === 'playing' || this.status === 'loading') {
        this.status = 'paused';
        this.emitState();
      }
    });

    this.audio.addEventListener('waiting', () => {
      // Buffering MUST NOT count as active listening time
      this.pauseSessionSegment(false);
      if (this.currentTrackId && this.status !== 'paused' && this.status !== 'error') {
        this.status = 'loading';
        this.emitState();
      }
    });

    this.audio.addEventListener('ended', () => {
      this.finalizeSession(true);
      this.cancelActiveFade(true);
      this.status = 'ended';
      if (this.durationSeconds > 0) {
        this.currentTimeSeconds = this.durationSeconds;
      }
      this.emitState();
    });

    this.audio.addEventListener('error', () => {
      this.finalizeSession(true);
      this.cancelActiveFade(true);
      const track = this.getCurrentTrack();
      this.status = 'error';
      this.errorMessage = describeMediaError(this.audio.error, track);
      this.emitState();
    });
  }

  private getCurrentTrack(): TrackRecord | null {
    if (!this.currentTrackId) {
      return null;
    }
    return this.queue.find((item) => item.id === this.currentTrackId) ?? null;
  }

  private findAdjacentPlayableTrack(direction: 1 | -1): TrackRecord | null {
    if (this.queue.length === 0) {
      return null;
    }

    const currentIndex = this.currentTrackId
      ? this.queue.findIndex((item) => item.id === this.currentTrackId)
      : -1;

    if (currentIndex === -1) {
      return this.queue.find((item) => item.status === 'available') ?? null;
    }

    for (
      let idx = currentIndex + direction;
      idx >= 0 && idx < this.queue.length;
      idx += direction
    ) {
      if (this.queue[idx].status === 'available') {
        return this.queue[idx];
      }
    }

    return null;
  }

  private buildSnapshot(): PlaybackState {
    const currentTrack = this.getCurrentTrack();
    const canPrevious =
      this.currentTimeSeconds > 3 || this.findAdjacentPlayableTrack(-1) !== null;
    const canNext = this.findAdjacentPlayableTrack(1) !== null;

    return {
      status: this.status,
      currentTrackId: this.currentTrackId,
      currentTrack,
      currentTimeSeconds: this.currentTimeSeconds,
      durationSeconds: this.durationSeconds,
      volume: this.volume,
      muted: this.muted,
      errorMessage: this.errorMessage,
      canPrevious,
      canNext,
    };
  }

  private emitState(): void {
    this.cachedSnapshot = this.buildSnapshot();
    for (const listener of this.listeners) {
      listener(this.cachedSnapshot);
    }
  }
}

let singletonEngine: AudioEngine | null = null;

/**
 * Returns the single application-wide AudioEngine instance.
 */
export function getAudioEngine(deps?: AudioEngineDependencies): AudioEngine {
  if (!singletonEngine) {
    singletonEngine = new AudioEngine(deps);
  }
  return singletonEngine;
}
