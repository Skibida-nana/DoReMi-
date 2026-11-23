import { buildTrackMediaUrl } from '../../../shared/contracts/media-protocol';
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
import type { TrackRecord } from '../../../shared/types/track';

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

function describeMediaError(error: MediaErrorLike | null, track: TrackRecord | null): string {
  const formatHint = track?.container ?? track?.codec ?? '';
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
 * Singleton Audio Engine wrapping a single HTMLAudioElement instance for the entire app lifecycle.
 * Completely decoupled from React components so Now Playing and Mini Player views
 * subscribe to the exact same engine state without recreating audio elements.
 *
 * Stage 5 additions:
 * - Real, cancelable Fade In/Out transitions (`setTransitionConfig`) that NEVER mutate
 *   the user's saved `volume` setting and NEVER leave audio stuck at 0%.
 * - Active listening session tracker that measures true active playback intervals
 *   (excluding pause, buffering, and seek skips) and emits idempotent checkpoints.
 */
export class AudioEngine implements AudioEngineController {
  private readonly audio: AudioElementLike;
  private readonly verifyTrackFn?: (trackId: string) => Promise<VerifyTrackResult>;
  private readonly onTrackMissingFn?: (trackId: string) => void;
  private readonly onSessionCheckpointFn?: (session: ListeningSessionInput) => void;
  private readonly fadeStepMs: number;
  private readonly nowMs: () => number;
  private readonly listeners = new Set<(state: PlaybackState) => void>();

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

  // Stage 5: Fade In/Out transition state (never mutates `this.volume`)
  private transitionConfig: PlaybackTransitionSettings = {
    enabled: false,
    durationSec: 1,
  };
  private fadeToken = 0;
  private activeFadeTimer: ReturnType<typeof setInterval> | null = null;

  // Stage 5: Real active listening session tracker
  private activeSession: ActiveListeningSession | null = null;

  constructor(deps: AudioEngineDependencies = {}) {
    const createEl =
      deps.createAudioElement ??
      (() => {
        const el = new Audio();
        el.preload = 'metadata';
        return el as unknown as AudioElementLike;
      });

    this.audio = createEl();
    this.audio.preload = 'metadata';
    this.audio.volume = this.volume;
    this.audio.muted = this.muted;
    this.verifyTrackFn = deps.verifyTrack;
    this.onTrackMissingFn = deps.onTrackMissing;
    this.onSessionCheckpointFn = deps.onSessionCheckpoint;
    this.fadeStepMs = Math.max(8, deps.fadeStepMs ?? 24);
    this.nowMs = deps.nowMs ?? (() => Date.now());

    this.bindAudioEvents();
    this.cachedSnapshot = this.buildSnapshot();
  }

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
    // Refresh current track metadata if it was updated (e.g. marked missing or rescan recovered)
    if (this.currentTrackId) {
      const updated = this.queue.find((item) => item.id === this.currentTrackId);
      if (updated && updated.status === 'missing' && this.status === 'playing') {
        this.finalizeSession(true);
        this.cancelActiveFade(true);
        this.audio.pause();
        this.status = 'error';
        this.errorMessage = 'File âm thanh gốc không còn tồn tại trên ổ đĩa.';
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
      const completed = await this.rampAudioVolume(this.audio.volume, 0, fadeOutMs);
      if (!completed || requestToken !== this.playRequestSeq) {
        // A newer play/pause/seek interrupted us — never leave audio stuck at 0
        if (requestToken === this.playRequestSeq) {
          this.audio.volume = this.volume;
        }
        return;
      }
    }

    this.currentTrackId = track.id;
    this.status = 'loading';
    this.errorMessage = null;
    this.currentTimeSeconds = 0;
    this.durationSeconds = track.duration_ms ? track.duration_ms / 1000 : 0;
    this.emitState();

    // Verify source file on disk via Electron Main before streaming
    if (this.verifyTrackFn) {
      try {
        const check = await this.verifyTrackFn(track.id);
        if (requestToken !== this.playRequestSeq) {
          return;
        }
        if (!check.exists) {
          this.audio.volume = this.volume;
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
        this.audio.volume = this.volume;
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
      this.audio.volume = this.volume;
      this.status = 'error';
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.emitState();
      return;
    }

    // Prepare incoming audio volume: 0 for smooth Fade In, or full saved volume
    const shouldFadeIn =
      this.transitionConfig.enabled && !this.muted && this.volume > 0.005;
    this.audio.volume = shouldFadeIn ? 0 : this.volume;
    this.audio.src = mediaUrl;
    this.audio.load();

    try {
      await this.audio.play();
      if (requestToken !== this.playRequestSeq) {
        return;
      }
      if (this.status === 'loading') {
        this.status = 'playing';
        this.startOrResumeSession(track);
        this.emitState();
      }

      if (shouldFadeIn) {
        const fadeInMs = Math.max(80, Math.round(this.transitionConfig.durationSec * 550));
        void this.rampAudioVolume(0, this.volume, fadeInMs).then((done) => {
          if (done && requestToken === this.playRequestSeq) {
            this.audio.volume = this.volume;
          }
        });
      } else {
        this.audio.volume = this.volume;
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
    try {
      await this.audio.play();
      if (requestToken !== this.playRequestSeq) {
        return;
      }
      this.status = 'playing';
      this.errorMessage = null;
      const current = this.getCurrentTrack();
      if (current) {
        this.startOrResumeSession(current);
      }
      this.emitState();
    } catch (error) {
      this.audio.volume = this.volume;
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

    // If user seeks while fading, immediately restore full volume
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
    this.cancelActiveFade(false);
    this.volume = clamped;
    this.audio.volume = clamped;

    if (clamped > 0 && this.muted) {
      this.muted = false;
      this.audio.muted = false;
    }

    this.emitState();
  }

  toggleMute(): void {
    this.muted = !this.muted;
    this.audio.muted = this.muted;
    if (!this.muted && !this.activeFadeTimer) {
      this.audio.volume = this.volume;
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
  // Fade In / Out Engine Helpers
  // ---------------------------------------------------------------------------

  private cancelActiveFade(restoreUserVolume: boolean): void {
    this.fadeToken += 1;
    if (this.activeFadeTimer !== null) {
      clearInterval(this.activeFadeTimer);
      this.activeFadeTimer = null;
    }
    if (restoreUserVolume) {
      this.audio.volume = this.volume;
    }
  }

  private rampAudioVolume(
    fromVolume: number,
    toVolume: number,
    durationMs: number,
  ): Promise<boolean> {
    this.cancelActiveFade(false);
    const token = this.fadeToken;
    const startVol = clamp(fromVolume, 0, 1);
    const targetVol = clamp(toVolume, 0, 1);

    if (durationMs <= this.fadeStepMs || Math.abs(targetVol - startVol) < 0.002) {
      this.audio.volume = targetVol;
      return Promise.resolve(true);
    }

    const startTime = this.nowMs();
    this.audio.volume = startVol;

    return new Promise<boolean>((resolve) => {
      const finish = (completed: boolean) => {
        if (this.activeFadeTimer !== null) {
          clearInterval(this.activeFadeTimer);
          this.activeFadeTimer = null;
        }
        resolve(completed);
      };

      this.activeFadeTimer = setInterval(() => {
        if (token !== this.fadeToken) {
          finish(false);
          return;
        }
        const elapsed = Math.max(0, this.nowMs() - startTime);
        const progress = Math.min(1, elapsed / durationMs);
        // Smooth ease-in-out curve for musical fade without abrupt clicks
        const eased =
          progress < 0.5
            ? 2 * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 2) / 2;

        // If target is user's volume, always track latest `this.volume`
        const effectiveTarget = targetVol > 0 ? this.volume : 0;
        const nextVol = clamp(startVol + (effectiveTarget - startVol) * eased, 0, 1);
        this.audio.volume = nextVol;

        if (progress >= 1) {
          this.audio.volume = effectiveTarget;
          finish(true);
        }
      }, this.fadeStepMs);
    });
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
