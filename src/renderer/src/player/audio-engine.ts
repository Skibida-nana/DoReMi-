import { buildTrackMediaUrl } from '../../../shared/contracts/media-protocol';
import type {
  AudioDspRuntimeSnapshot,
  AudioLabSettings,
} from '../../../shared/types/audio-dsp';
import type { VerifyTrackResult } from '../../../shared/types/library';
import type {
  AudioEngineController,
  PlaybackContextDescriptor,
  PlaybackControlState,
  PlaybackErrorDetails,
  PlaybackQueueEntry,
  PlaybackQueueState,
  PlaybackState,
  PlaybackStatus,
  RepeatMode,
} from '../../../shared/types/player';
import {
  PlaybackQueueController,
} from './playback-queue';
import type {
  FadeDurationSec,
  ListeningSessionInput,
  PlaybackTransitionSettings,
} from '../../../shared/types/stage5';
import type {
  ComputedReplayGain,
  DiagnosticRecordInput,
  ReplayGainSettings,
  TrackReplayGainMetadata,
} from '../../../shared/types/stage6';
import type { TrackRecord } from '../../../shared/types/track';
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
import {
  buildPlaybackErrorDetails,
  type MediaErrorContext,
} from './playback-error';

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
  onDiagnostic?: (entry: DiagnosticRecordInput) => void;
  /** Optional shared queue controller (Single Source of Truth across app UI & engine) */
  queueController?: PlaybackQueueController;
  /** Optional callback when auto-advance / next / prev lands on a track outside local TrackRecord catalog */
  onExternalEntryActivated?: (entry: PlaybackQueueEntry) => Promise<void> | void;
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
  private readonly onDiagnosticFn?: (entry: DiagnosticRecordInput) => void;
  private readonly onExternalEntryActivatedFn?: (
    entry: PlaybackQueueEntry,
  ) => Promise<void> | void;
  private readonly fadeStepMs: number;
  private readonly nowMs: () => number;
  private readonly listeners = new Set<(state: PlaybackState) => void>();
  private readonly coreListeners = new Set<(state: PlaybackState) => void>();
  private readonly dspListeners = new Set<(snapshot: AudioDspRuntimeSnapshot) => void>();
  readonly queueController: PlaybackQueueController;

  private trackCatalog = new Map<string, TrackRecord>();
  private trackCatalogOrder: TrackRecord[] = [];
  private currentTrackId: string | null = null;
  private currentTrackSnapshot: TrackRecord | null = null;
  private currentQueueEntryId: string | null = null;
  private status: PlaybackStatus = 'idle';
  private currentTimeSeconds = 0;
  private durationSeconds = 0;
  private volume = DEFAULT_VOLUME;
  private muted = false;
  private errorMessage: string | null = null;
  private playbackError: PlaybackErrorDetails | null = null;
  private playRequestSeq = 0;
  private playbackGeneration = 0;
  private endedHandledGeneration = 0;
  private currentAttemptId = 'pb-init';
  private activeAudioSrc: string | null = null;
  private switchingTrack = false;
  private inAudioPlayCall = false;
  private currentAttemptFromAutoAdvance = false;
  private currentAttemptStartedPlaying = false;
  private lastLoggedFailureAttemptId: string | null = null;
  private cachedSnapshot: PlaybackState;
  private cachedCoreSnapshot: PlaybackState;
  private cachedCanNext = false;
  private canNextDirty = true;
  private cachedDspSnapshot: AudioDspRuntimeSnapshot;
  private unsubscribeQueueController: (() => void) | null = null;

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
    this.onDiagnosticFn = deps.onDiagnostic;
    this.onExternalEntryActivatedFn = deps.onExternalEntryActivated;
    this.fadeStepMs = Math.max(8, deps.fadeStepMs ?? 24);
    this.nowMs = deps.nowMs ?? (() => Date.now());

    this.queueController =
      deps.queueController ??
      new PlaybackQueueController({
        isTrackPlayable: (trackId) => this.isLocalTrackPlayable(trackId),
      });
    this.unsubscribeQueueController = this.queueController.subscribe(() => {
      this.canNextDirty = true;
      this.emitState();
    });

    this.bindAudioEvents();
    this.cachedSnapshot = this.buildSnapshot();
    this.cachedCoreSnapshot = this.cachedSnapshot;
    this.cachedDspSnapshot = this.dsp.getRuntimeSnapshot();
  }

  private isLocalTrackPlayable(trackId: string): boolean {
    const track = this.trackCatalog.get(trackId);
    return Boolean(track && track.status === 'available');
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
    this.unsubscribeQueueController?.();
    this.unsubscribeQueueController = null;
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

  syncTrackCatalog(tracks: TrackRecord[]): void {
    this.canNextDirty = true;
    const prevTrackIds = new Set(this.trackCatalog.keys());
    this.trackCatalog = new Map(tracks.map((t) => [t.id, t]));
    this.trackCatalogOrder = [...tracks];

    const removedIds: string[] = [];
    for (const prevId of prevTrackIds) {
      if (!this.trackCatalog.has(prevId)) {
        removedIds.push(prevId);
      }
    }
    if (removedIds.length > 0) {
      this.queueController.removeTracksFromQueue(removedIds);
    }

    // Refresh current track metadata if it was updated (e.g. marked missing or metadata override edited)
    if (this.currentTrackId) {
      const updated = this.trackCatalog.get(this.currentTrackId) ?? null;
      if (updated && updated.status === 'missing' && this.status === 'playing') {
        this.currentTrackSnapshot = updated;
        this.finalizeSession(true);
        this.cancelActiveFade(true);
        this.switchingTrack = true;
        this.audio.pause();
        this.switchingTrack = false;
        this.activeAudioSrc = null;
        this.queueController.markCurrentPlaybackFailed();
        this.setErrorState(
          buildPlaybackErrorDetails({
            attemptId: this.currentAttemptId || `pb-queue-${this.nowMs().toString(36)}`,
            stage: 'file-verify',
            track: updated,
            explicitCode: 'ERR_FILE_MISSING',
            isMissingFile: true,
          }),
        );
      } else if (updated) {
        this.currentTrackSnapshot = updated;
        this.recomputeTrackReplayGain(updated, false);
        this.emitDspState();
      }
    }
    this.emitState();
  }

  setQueue(tracks: TrackRecord[]): void {
    this.syncTrackCatalog(tracks);
    this.queueController.initializeIdleContext({
      contextId: 'engine-queue',
      label: 'Hàng đợi phát',
      kind: 'custom',
      trackIds: tracks.map((t) => t.id),
    });
  }

  getQueueState(): PlaybackQueueState {
    return this.queueController.getState();
  }

  getPlaybackControls(): PlaybackControlState {
    return this.queueController.getControls();
  }

  setShuffle(enabled: boolean): PlaybackControlState {
    return this.queueController.setShuffle(enabled);
  }

  toggleShuffle(): PlaybackControlState {
    return this.queueController.toggleShuffle();
  }

  setRepeatMode(mode: RepeatMode): PlaybackControlState {
    return this.queueController.setRepeatMode(mode);
  }

  cycleRepeatMode(): PlaybackControlState {
    return this.queueController.cycleRepeatMode();
  }

  setAutoNext(enabled: boolean): PlaybackControlState {
    return this.queueController.setAutoNext(enabled);
  }

  toggleAutoNext(): PlaybackControlState {
    return this.queueController.toggleAutoNext();
  }

  async playFromContext(
    context: PlaybackContextDescriptor,
    startTrackId?: string,
    shuffle?: boolean,
  ): Promise<void> {
    const entry = this.queueController.startContext({
      context,
      startTrackId,
      shuffle,
    });
    if (entry) {
      await this.playQueueEntry(entry, { fromAutoAdvance: false });
    }
  }

  async play(trackId: string): Promise<void> {
    const fallbackContext: PlaybackContextDescriptor | undefined =
      this.queueController.getState().context ??
      (this.trackCatalogOrder.length > 0
        ? {
            contextId: 'library-default',
            label: 'Thư viện nhạc',
            kind: 'library',
            trackIds: this.trackCatalogOrder.map((t) => t.id),
          }
        : undefined);

    const entry = this.queueController.playTrackInCurrentOrNewContext(trackId, fallbackContext);
    await this.playQueueEntry(entry, { fromAutoAdvance: false });
  }

  async playQueueEntry(
    entry: PlaybackQueueEntry,
    options: { fromAutoAdvance?: boolean } = {},
  ): Promise<void> {
    const fromAutoAdvance = Boolean(options.fromAutoAdvance);
    const requestToken = ++this.playRequestSeq;
    this.playbackGeneration += 1;
    const generation = this.playbackGeneration;
    const attemptId = `pb-${requestToken}-${this.nowMs().toString(36)}`;
    this.currentAttemptFromAutoAdvance = fromAutoAdvance;
    this.currentAttemptStartedPlaying = false;
    this.currentQueueEntryId = entry.queueEntryId;

    const track = this.trackCatalog.get(entry.trackId) ?? null;
    if (!track) {
      if (this.onExternalEntryActivatedFn) {
        this.switchingTrack = true;
        this.audio.pause();
        this.switchingTrack = false;
        this.activeAudioSrc = null;
        this.currentTrackId = null;
        this.currentTrackSnapshot = null;
        this.status = 'idle';
        this.emitState();
        await this.onExternalEntryActivatedFn(entry);
        return;
      }
      this.currentTrackSnapshot = null;
      this.cancelActiveFade(true);
      this.currentAttemptId = attemptId;
      this.queueController.markCurrentPlaybackFailed();
      this.setErrorState(
        buildPlaybackErrorDetails({
          attemptId,
          stage: 'queue-lookup',
          track: null,
          explicitCode: 'ERR_FILE_MISSING',
          explicitMessage: 'Không tìm thấy bài hát trong danh sách thư viện.',
        }),
      );
      this.emitState();
      if (fromAutoAdvance) {
        await this.tryAutoAdvanceAfterFailure(requestToken, generation);
      }
      return;
    }

    if (track.status === 'missing') {
      this.currentTrackSnapshot = track;
      this.finalizeSession(true);
      this.cancelActiveFade(true);
      this.switchingTrack = true;
      this.audio.pause();
      this.switchingTrack = false;
      this.activeAudioSrc = null;
      this.currentTrackId = track.id;
      this.currentAttemptId = attemptId;
      this.queueController.markCurrentPlaybackFailed();
      this.setErrorState(
        buildPlaybackErrorDetails({
          attemptId,
          stage: 'file-verify',
          track,
          explicitCode: 'ERR_FILE_MISSING',
          explicitMessage: `File gốc không còn tồn tại: ${track.original_path}`,
          isMissingFile: true,
        }),
      );
      this.emitState();
      if (fromAutoAdvance) {
        await this.tryAutoAdvanceAfterFailure(requestToken, generation);
      }
      return;
    }

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

    // Stop outgoing audio cleanly so stale events from previous track cannot hijack the new attempt
    this.switchingTrack = true;
    this.audio.pause();
    this.switchingTrack = false;
    this.activeAudioSrc = null;

    this.currentTrackId = track.id;
    this.currentTrackSnapshot = track;
    this.currentAttemptId = attemptId;
    this.status = 'loading';
    this.errorMessage = null;
    this.playbackError = null;
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
          this.queueController.markCurrentPlaybackFailed();
          this.setErrorState(
            buildPlaybackErrorDetails({
              attemptId,
              stage: 'file-verify',
              track,
              explicitCode: 'ERR_FILE_MISSING',
              explicitMessage: check.reason ?? `File gốc không còn tồn tại: ${track.original_path}`,
              isMissingFile: true,
            }),
          );
          this.onTrackMissingFn?.(track.id);
          this.emitState();
          if (fromAutoAdvance) {
            await this.tryAutoAdvanceAfterFailure(requestToken, generation);
          }
          return;
        }
      } catch (error) {
        if (requestToken !== this.playRequestSeq) {
          return;
        }
        this.setFadeMultiplier(1);
        this.queueController.markCurrentPlaybackFailed();
        this.setErrorState(
          buildPlaybackErrorDetails({
            attemptId,
            stage: 'file-verify',
            track,
            thrownError: error,
            explicitMessage: `Lỗi kiểm tra file trước khi phát: ${error instanceof Error ? error.message : String(error)}`,
          }),
        );
        this.emitState();
        if (fromAutoAdvance) {
          await this.tryAutoAdvanceAfterFailure(requestToken, generation);
        }
        return;
      }
    }

    let mediaUrl: string;
    try {
      mediaUrl = buildTrackMediaUrl(track.id);
    } catch (error) {
      this.setFadeMultiplier(1);
      this.setErrorState(
        buildPlaybackErrorDetails({
          attemptId,
          stage: 'protocol-url',
          track,
          thrownError: error,
          explicitCode: 'ERR_FILE_ACCESS_DENIED',
          explicitMessage: error instanceof Error ? error.message : String(error),
        }),
      );
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
    this.activeAudioSrc = mediaUrl;
    this.audio.src = mediaUrl;
    this.audio.load();

    this.inAudioPlayCall = true;
    try {
      await this.audio.play();
      this.inAudioPlayCall = false;
      if (requestToken !== this.playRequestSeq) {
        return;
      }
      if (this.dsp.isActive()) {
        await this.dsp.resumeIfSuspended();
        this.emitDspState();
      }
      if (this.status === 'loading') {
        this.status = 'playing';
        this.errorMessage = null;
        this.playbackError = null;
        this.currentAttemptStartedPlaying = true;
        this.queueController.markCurrentPlaybackStarted();
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
      this.inAudioPlayCall = false;
      this.cancelActiveFade(true);
      if (requestToken !== this.playRequestSeq) {
        return;
      }
      // AbortError happens naturally when user rapidly switches tracks
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      this.queueController.markCurrentPlaybackFailed();
      // Preserve richer MediaError classification if audio 'error' event already fired for this attempt
      if (this.lastLoggedFailureAttemptId !== attemptId || !this.playbackError) {
        this.setErrorState(
          buildPlaybackErrorDetails({
            attemptId,
            stage: this.audio.error ? 'audio-decode' : 'play-start',
            track,
            mediaError: this.audio.error as MediaErrorContext | null,
            thrownError: error,
          }),
        );
        this.emitState();
      }
      if (fromAutoAdvance) {
        await this.tryAutoAdvanceAfterFailure(requestToken, generation);
      }
    }
  }

  pauseSilently(): void {
    this.playRequestSeq += 1;
    this.cancelActiveFade(true);
    this.pauseSessionSegment(true);
    this.switchingTrack = true;
    this.audio.pause();
    this.switchingTrack = false;
    this.activeAudioSrc = null;
    if (this.status === 'playing' || this.status === 'loading') {
      this.status = 'paused';
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
      const queueState = this.queueController.getState();
      if (queueState.currentEntry && this.trackCatalog.has(queueState.currentEntry.trackId)) {
        await this.playQueueEntry(queueState.currentEntry, { fromAutoAdvance: false });
        return;
      }
      const firstPlayable = this.trackCatalogOrder.find((t) => t.status === 'available');
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
      this.playbackGeneration += 1;
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
      this.inAudioPlayCall = true;
      await this.audio.play();
      this.inAudioPlayCall = false;
      if (requestToken !== this.playRequestSeq) {
        return;
      }
      if (this.dsp.isActive()) {
        await this.dsp.resumeIfSuspended();
        this.emitDspState();
      }
      this.status = 'playing';
      this.errorMessage = null;
      this.playbackError = null;
      this.currentAttemptStartedPlaying = true;
      this.queueController.markCurrentPlaybackStarted();
      const current = this.getCurrentTrack();
      if (current) {
        this.startOrResumeSession(current);
      }
      this.emitState();
    } catch (error) {
      this.inAudioPlayCall = false;
      this.setFadeMultiplier(1);
      if (requestToken !== this.playRequestSeq) {
        return;
      }
      this.queueController.markCurrentPlaybackFailed();
      this.setErrorState(
        buildPlaybackErrorDetails({
          attemptId: this.currentAttemptId,
          stage: 'play-start',
          track: this.getCurrentTrack(),
          mediaError: this.audio.error as MediaErrorContext | null,
          thrownError: error,
        }),
      );
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
      this.playbackGeneration += 1;
      this.status = 'paused';
    }

    this.emitState();
  }

  async next(): Promise<void> {
    const advanced = this.queueController.advanceManualNext();
    if (advanced.status === 'ok') {
      await this.playQueueEntry(advanced.entry, { fromAutoAdvance: false });
    }
  }

  async previous(): Promise<void> {
    // Standard desktop player behavior: restart current track if past 3 seconds
    if (this.currentTrackId && this.currentTimeSeconds > 3) {
      this.seek(0);
      return;
    }

    const prevEntry = this.queueController.advanceManualPrevious();
    if (prevEntry) {
      await this.playQueueEntry(prevEntry, { fromAutoAdvance: false });
      return;
    }

    if (this.currentTrackId && this.currentTimeSeconds > 0) {
      this.seek(0);
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

  getCorePlaybackState(): PlaybackState {
    return this.cachedCoreSnapshot;
  }

  subscribe(listener: (state: PlaybackState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeCore(listener: (state: PlaybackState) => void): () => void {
    this.coreListeners.add(listener);
    return () => {
      this.coreListeners.delete(listener);
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

  private setErrorState(details: PlaybackErrorDetails): void {
    this.status = 'error';
    this.errorMessage = details.summary;
    this.playbackError = details;
    if (this.lastLoggedFailureAttemptId !== details.attemptId) {
      this.lastLoggedFailureAttemptId = details.attemptId;
      this.onDiagnosticFn?.({
        level: 'error',
        scope: 'audio-engine',
        code: details.code,
        stage: details.stage,
        attemptId: details.attemptId,
        message: `${details.summary}${details.trackTitle ? ` (${details.trackTitle})` : ''}`,
        detail: details.technicalDetail,
      });
    }
  }

  private bindAudioEvents(): void {
    this.audio.addEventListener('loadedmetadata', () => {
      if (!this.activeAudioSrc) {
        return;
      }
      if (Number.isFinite(this.audio.duration) && this.audio.duration >= 0) {
        this.durationSeconds = this.audio.duration;
      }
      this.emitState();
    });

    this.audio.addEventListener('timeupdate', () => {
      if (!this.activeAudioSrc) {
        return;
      }
      const nextTime = this.audio.currentTime;
      if (Number.isFinite(nextTime)) {
        if (Math.abs(nextTime - this.currentTimeSeconds) < 0.0005 && this.status !== 'playing') {
          return;
        }
        this.currentTimeSeconds = nextTime;
        if (this.status === 'playing' && this.activeSession) {
          this.emitSessionCheckpoint(false);
        }
        this.emitState();
      }
    });

    this.audio.addEventListener('playing', () => {
      if (!this.activeAudioSrc) {
        return;
      }
      this.status = 'playing';
      this.errorMessage = null;
      this.playbackError = null;
      this.currentAttemptStartedPlaying = true;
      this.queueController.markCurrentPlaybackStarted();
      const track = this.getCurrentTrack();
      if (track) {
        this.startOrResumeSession(track);
      }
      this.emitState();
    });

    this.audio.addEventListener('pause', () => {
      if (this.switchingTrack || !this.activeAudioSrc) {
        return;
      }
      this.pauseSessionSegment(true);
      if (this.status === 'playing' || this.status === 'loading') {
        this.status = 'paused';
        this.emitState();
      }
    });

    this.audio.addEventListener('waiting', () => {
      if (!this.activeAudioSrc) {
        return;
      }
      // Buffering MUST NOT count as active listening time
      this.pauseSessionSegment(false);
      if (this.currentTrackId && this.status !== 'paused' && this.status !== 'error') {
        this.status = 'loading';
        this.emitState();
      }
    });

    this.audio.addEventListener('ended', () => {
      if (!this.activeAudioSrc || this.switchingTrack) {
        return;
      }
      if (this.endedHandledGeneration === this.playbackGeneration) {
        return;
      }
      this.endedHandledGeneration = this.playbackGeneration;
      const endedGeneration = this.playbackGeneration;

      this.finalizeSession(true);
      this.cancelActiveFade(true);
      this.status = 'ended';
      if (this.durationSeconds > 0) {
        this.currentTimeSeconds = this.durationSeconds;
      }
      this.emitState();
      void this.handleNaturalTrackEnded(endedGeneration);
    });

    this.audio.addEventListener('error', () => {
      if (this.switchingTrack || !this.activeAudioSrc) {
        return;
      }
      this.finalizeSession(true);
      this.cancelActiveFade(true);
      this.queueController.markCurrentPlaybackFailed();
      const track = this.getCurrentTrack();
      this.setErrorState(
        buildPlaybackErrorDetails({
          attemptId: this.currentAttemptId,
          stage: 'runtime-media',
          track,
          mediaError: this.audio.error as MediaErrorContext | null,
        }),
      );
      this.emitState();

      if (
        !this.inAudioPlayCall &&
        this.currentAttemptFromAutoAdvance &&
        !this.currentAttemptStartedPlaying
      ) {
        void this.tryAutoAdvanceAfterFailure(this.playRequestSeq, this.playbackGeneration);
      }
    });
  }

  private async tryAutoAdvanceAfterFailure(
    requestToken: number,
    generation: number,
  ): Promise<void> {
    if (requestToken !== this.playRequestSeq || generation !== this.playbackGeneration) {
      return;
    }
    const nextCandidate = this.queueController.advanceAfterAutoPlayFailure();
    if (nextCandidate.status === 'ok') {
      await this.playQueueEntry(nextCandidate.entry, { fromAutoAdvance: true });
    }
  }

  private async handleNaturalTrackEnded(endedGeneration: number): Promise<void> {
    if (endedGeneration !== this.playbackGeneration) {
      return;
    }
    const resolution = this.queueController.resolveNaturalTrackEnd();
    if (endedGeneration !== this.playbackGeneration) {
      return;
    }

    if (resolution.action === 'replay') {
      this.playbackGeneration += 1;
      const requestToken = ++this.playRequestSeq;
      const track = this.getCurrentTrack();
      this.currentAttemptFromAutoAdvance = false;
      this.currentAttemptStartedPlaying = false;
      this.audio.currentTime = 0;
      this.currentTimeSeconds = 0;
      this.status = 'loading';
      this.errorMessage = null;
      this.playbackError = null;
      this.emitState();

      try {
        this.inAudioPlayCall = true;
        await this.audio.play();
        this.inAudioPlayCall = false;
        if (requestToken !== this.playRequestSeq) {
          return;
        }
        if (this.dsp.isActive()) {
          await this.dsp.resumeIfSuspended();
          this.emitDspState();
        }
        this.status = 'playing';
        this.currentAttemptStartedPlaying = true;
        this.queueController.markCurrentPlaybackStarted();
        if (track) {
          this.startOrResumeSession(track);
        }
        this.emitState();
      } catch (error) {
        this.inAudioPlayCall = false;
        if (requestToken !== this.playRequestSeq) {
          return;
        }
        this.queueController.markCurrentPlaybackFailed();
        this.setErrorState(
          buildPlaybackErrorDetails({
            attemptId: this.currentAttemptId,
            stage: 'play-start',
            track,
            mediaError: this.audio.error as MediaErrorContext | null,
            thrownError: error,
          }),
        );
        this.emitState();
      }
      return;
    }

    if (resolution.action === 'play-entry') {
      await this.playQueueEntry(resolution.entry, { fromAutoAdvance: true });
    }
  }

  private getCurrentTrack(): TrackRecord | null {
    if (!this.currentTrackId) {
      return null;
    }
    return this.trackCatalog.get(this.currentTrackId) ?? this.currentTrackSnapshot ?? null;
  }

  private buildSnapshot(): PlaybackState {
    const currentTrack = this.getCurrentTrack();
    const queueState = this.queueController.getState();
    const controls = queueState.controls;
    const canPrevious = this.queueController.canGoPrevious(this.currentTimeSeconds);
    if (this.canNextDirty) {
      this.cachedCanNext = this.queueController.canGoNext();
      this.canNextDirty = false;
    }
    const canNext = this.cachedCanNext;

    return {
      status: this.status,
      currentTrackId: this.currentTrackId,
      currentQueueEntryId: this.currentQueueEntryId,
      currentTrack,
      currentTimeSeconds: this.currentTimeSeconds,
      durationSeconds: this.durationSeconds,
      volume: this.volume,
      muted: this.muted,
      errorMessage: this.errorMessage,
      playbackError: this.playbackError,
      canPrevious,
      canNext,
      playbackGeneration: this.playbackGeneration,
      shuffleEnabled: controls.shuffleEnabled,
      repeatMode: controls.repeatMode,
      autoNextEnabled: controls.autoNextEnabled,
      remainingReplays: queueState.repeatRuntime.remainingReplays,
    };
  }

  private emitState(): void {
    const next = this.buildSnapshot();
    this.cachedSnapshot = next;
    const prevCore = this.cachedCoreSnapshot;
    const coreChanged =
      !prevCore ||
      prevCore.status !== next.status ||
      prevCore.currentTrackId !== next.currentTrackId ||
      prevCore.currentQueueEntryId !== next.currentQueueEntryId ||
      prevCore.currentTrack !== next.currentTrack ||
      prevCore.durationSeconds !== next.durationSeconds ||
      prevCore.volume !== next.volume ||
      prevCore.muted !== next.muted ||
      prevCore.errorMessage !== next.errorMessage ||
      prevCore.playbackError !== next.playbackError ||
      prevCore.canPrevious !== next.canPrevious ||
      prevCore.canNext !== next.canNext ||
      prevCore.playbackGeneration !== next.playbackGeneration ||
      prevCore.shuffleEnabled !== next.shuffleEnabled ||
      prevCore.repeatMode !== next.repeatMode ||
      prevCore.autoNextEnabled !== next.autoNextEnabled ||
      prevCore.remainingReplays !== next.remainingReplays;
    if (coreChanged) {
      this.cachedCoreSnapshot = next;
    }

    for (const listener of this.listeners) {
      listener(next);
    }
    if (coreChanged) {
      for (const listener of this.coreListeners) {
        listener(next);
      }
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
