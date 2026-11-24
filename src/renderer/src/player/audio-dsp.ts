import {
  GRAPHIC_EQ_FREQUENCIES,
  type AudioDspRuntimeSnapshot,
  type AudioLabSettings,
  type DspRuntimeMode,
  type EqMode,
  type ParametricFilterType,
} from '../../../shared/types/audio-dsp';
import type { ComputedReplayGain, ReplayGainSettings } from '../../../shared/types/stage6';
import {
  GRAPHIC_BAND_COUNT,
  GRAPHIC_OCTAVE_Q,
  PARAMETRIC_BAND_COUNT,
  clampFinite,
  computeHeadroomAnalysis,
  createDefaultAudioLabSettings,
  dbToLinearGain,
  getActiveSlotConfig,
  getGraphicBandFilterType,
  getSafeMaxFrequencyHz,
  linearQToWebAudioFilterQ,
  normalizeAudioLabSettings,
} from '../../../shared/utils/audio-dsp';
import { DEFAULT_REPLAYGAIN_SETTINGS } from '../../../shared/utils/replaygain';

/**
 * Minimal Web Audio interfaces allowing real browser/Electron AudioContext
 * as well as deterministic mock AudioContext testing in Node.js.
 */
export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): AudioParamLike;
  linearRampToValueAtTime(value: number, endTime: number): AudioParamLike;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): AudioParamLike;
  cancelScheduledValues(cancelTime: number): AudioParamLike;
  cancelAndHoldAtTime?(cancelTime: number): AudioParamLike;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): AudioNodeLike;
  disconnect(destination?: AudioNodeLike): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface BiquadFilterNodeLike extends AudioNodeLike {
  type: BiquadFilterType;
  readonly frequency: AudioParamLike;
  readonly gain: AudioParamLike;
  readonly Q: AudioParamLike;
  getFrequencyResponse?(
    frequencyHz: Float32Array,
    magResponse: Float32Array,
    phaseResponse: Float32Array,
  ): void;
}

export interface AnalyserNodeLike extends AudioNodeLike {
  fftSize: number;
  readonly frequencyBinCount: number;
  smoothingTimeConstant: number;
  minDecibels: number;
  maxDecibels: number;
  getByteFrequencyData(array: Uint8Array): void;
}

export interface AudioContextLike {
  readonly state: 'suspended' | 'running' | 'closed';
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNodeLike;
  createMediaElementSource(mediaElement: unknown): AudioNodeLike;
  createGain(): GainNodeLike;
  createBiquadFilter(): BiquadFilterNodeLike;
  createAnalyser?(): AnalyserNodeLike;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export type AudioContextFactory = () => AudioContextLike;

// Process-wide guard guaranteeing MediaElementAudioSourceNode is NEVER created twice for one element.
const boundAudioElements = new WeakSet<object>();

const PARAM_SMOOTH_TC_SEC = 0.015;
const MUTE_SMOOTH_TC_SEC = 0.008;
const BRANCH_XFADE_SEC = 0.014;

const NEUTRAL_REPLAYGAIN: ComputedReplayGain = {
  applied: false,
  source: 'none',
  gainDb: 0,
  peak: null,
  linearGain: 1,
  clippedPrevented: false,
};

function setParamSmooth(
  param: AudioParamLike,
  value: number,
  now: number,
  timeConstant = PARAM_SMOOTH_TC_SEC,
  immediate = false,
): void {
  const safeVal = Number.isFinite(value) ? value : 0;
  try {
    param.cancelScheduledValues(now);
    if (immediate) {
      param.setValueAtTime(safeVal, now);
      param.value = safeVal;
    } else {
      param.setTargetAtTime(safeVal, now, timeConstant);
    }
  } catch {
    param.value = safeVal;
  }
}

export function createBrowserAudioContextFactory(): AudioContextFactory | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const win = window as unknown as {
    AudioContext?: new () => AudioContextLike;
    webkitAudioContext?: new () => AudioContextLike;
  };
  const Ctor = win.AudioContext ?? win.webkitAudioContext;
  if (typeof Ctor !== 'function') {
    return null;
  }
  return () => new Ctor();
}

type ActiveRoutingBranch = 'none' | 'bypass' | 'graphic' | 'parametric';

/**
 * Single-source Web Audio API DSP Manager for DoReMi AudioEngine.
 *
 * Signal topology (strictly single-path, never duplicated):
 *   HTMLAudioElement
 *     -> MediaElementAudioSourceNode (created ONCE per audio element)
 *     -> ReplayGain GainNode
 *     -> Preamp GainNode (manual preamp + Auto Headroom; unity 1.0 when EQ bypassed)
 *     -> [Bypass | 10-band Graphic EQ | 8-band Parametric EQ] (strictly ONE active path)
 *     -> Fade GainNode (smooth AudioParam Fade In/Out)
 *     -> User Volume GainNode (isolated user volume 0..1)
 *     -> Mute GainNode (0 or 1, preserves user volume/EQ/preamp/ReplayGain)
 *     -> AnalyserNode (optional read-only FFT tap)
 *     -> AudioContext.destination
 */
export class AudioDspGraph {
  private readonly audioElement: object;
  private readonly contextFactory: AudioContextFactory | null;

  private ctx: AudioContextLike | null = null;
  private sourceNode: AudioNodeLike | null = null;
  private replayGainNode: GainNodeLike | null = null;
  private preampNode: GainNodeLike | null = null;
  private bypassBranchGain: GainNodeLike | null = null;
  private graphicBranchGain: GainNodeLike | null = null;
  private parametricBranchGain: GainNodeLike | null = null;
  private graphicFilters: BiquadFilterNodeLike[] = [];
  private parametricFilters: BiquadFilterNodeLike[] = [];
  private fadeGainNode: GainNodeLike | null = null;
  private userVolumeNode: GainNodeLike | null = null;
  private muteGainNode: GainNodeLike | null = null;
  private analyserNode: AnalyserNodeLike | null = null;
  private emergencyVolumeNode: GainNodeLike | null = null;

  private runtimeMode: DspRuntimeMode = 'direct';
  private activeBranch: ActiveRoutingBranch = 'none';
  private sourceBound = false;
  private lastError: string | null = null;
  private disposed = false;

  // Authoritative parameter state (kept in sync even before AudioContext lazy init)
  private settings: AudioLabSettings = createDefaultAudioLabSettings(48000);
  private replayGainSettings: ReplayGainSettings = { ...DEFAULT_REPLAYGAIN_SETTINGS };
  private activeReplayGain: ComputedReplayGain = { ...NEUTRAL_REPLAYGAIN };
  private userVolume = 0.85;
  private muted = false;
  private fadeGain = 1;

  constructor(audioElement: object, contextFactory: AudioContextFactory | null) {
    this.audioElement = audioElement;
    this.contextFactory = contextFactory;
  }

  canInitialize(): boolean {
    return !this.disposed && this.contextFactory !== null;
  }

  isActive(): boolean {
    return this.runtimeMode === 'dsp' && this.ctx !== null && !this.disposed;
  }

  isSourceBound(): boolean {
    return this.sourceBound;
  }

  getSampleRate(): number {
    return this.ctx?.sampleRate && Number.isFinite(this.ctx.sampleRate)
      ? this.ctx.sampleRate
      : 48000;
  }

  getSettings(): AudioLabSettings {
    return this.settings;
  }

  getReplayGainSettings(): ReplayGainSettings {
    return { ...this.replayGainSettings };
  }

  /**
   * Lazily initializes AudioContext and builds the entire pre-allocated DSP graph ONCE.
   * Safe to call repeatedly — subsequent calls only resume a suspended AudioContext.
   */
  async ensureInitialized(): Promise<boolean> {
    if (this.disposed) {
      return false;
    }

    if (this.ctx && this.runtimeMode === 'dsp') {
      await this.resumeIfSuspended();
      return true;
    }

    if (!this.contextFactory) {
      return false;
    }

    // Never call createMediaElementSource twice on the same HTMLAudioElement
    if (boundAudioElements.has(this.audioElement) && !this.sourceNode) {
      this.runtimeMode = 'error';
      this.lastError =
        'HTMLAudioElement đã được gắn với một MediaElementAudioSourceNode khác trước đó.';
      return false;
    }

    let createdCtx: AudioContextLike | null = null;
    try {
      createdCtx = this.contextFactory();
      const source = createdCtx.createMediaElementSource(this.audioElement);
      // Mark bound IMMEDIATELY after createMediaElementSource succeeds!
      boundAudioElements.add(this.audioElement);
      this.ctx = createdCtx;
      this.sourceNode = source;
      this.sourceBound = true;
    } catch (error) {
      // Failed BEFORE MediaElementAudioSourceNode bound the audio element:
      // Direct HTMLAudioElement playback remains completely functional!
      if (createdCtx) {
        void createdCtx.close().catch(() => {});
      }
      this.runtimeMode = 'fallback-direct';
      this.lastError = `Không thể khởi tạo Web Audio DSP (đã chuyển về chế độ phát trực tiếp): ${
        error instanceof Error ? error.message : String(error)
      }`;
      return false;
    }

    // Build pre-allocated DSP node graph (if anything fails here, attach emergency direct bypass!)
    try {
      const ctx = this.ctx;
      const replayGainNode = ctx.createGain();
      const preampNode = ctx.createGain();
      const bypassBranchGain = ctx.createGain();
      const graphicBranchGain = ctx.createGain();
      const parametricBranchGain = ctx.createGain();
      const fadeGainNode = ctx.createGain();
      const userVolumeNode = ctx.createGain();
      const muteGainNode = ctx.createGain();

      // Pre-allocate 10 Graphic EQ BiquadFilterNodes in series
      const graphicFilters: BiquadFilterNodeLike[] = [];
      for (let i = 0; i < GRAPHIC_BAND_COUNT; i += 1) {
        const filter = ctx.createBiquadFilter();
        filter.type = getGraphicBandFilterType(i);
        filter.frequency.value = Math.min(
          GRAPHIC_EQ_FREQUENCIES[i],
          getSafeMaxFrequencyHz(ctx.sampleRate),
        );
        filter.Q.value = GRAPHIC_OCTAVE_Q;
        filter.gain.value = 0;
        if (i > 0) {
          graphicFilters[i - 1].connect(filter);
        }
        graphicFilters.push(filter);
      }

      // Pre-allocate 8 Parametric EQ BiquadFilterNodes in series
      const parametricFilters: BiquadFilterNodeLike[] = [];
      for (let i = 0; i < PARAMETRIC_BAND_COUNT; i += 1) {
        const filter = ctx.createBiquadFilter();
        filter.type = 'peaking';
        filter.frequency.value = 1000;
        filter.Q.value = 1.2;
        filter.gain.value = 0;
        if (i > 0) {
          parametricFilters[i - 1].connect(filter);
        }
        parametricFilters.push(filter);
      }

      let analyserNode: AnalyserNodeLike | null = null;
      if (typeof ctx.createAnalyser === 'function') {
        analyserNode = ctx.createAnalyser();
        analyserNode.fftSize = 1024;
        analyserNode.smoothingTimeConstant = 0.8;
        analyserNode.minDecibels = -88;
        analyserNode.maxDecibels = -8;
      }

      // Fixed topology with click-free constant-sum branch matrix:
      //   source -> replayGain -> preamp
      //     ├─> bypassBranchGain ------------------> fadeGain
      //     ├─> graphicFilters[0..9] -> graphicBranchGain -> fadeGain
      //     └─> parametricFilters[0..7] -> parametricBranchGain -> fadeGain
      //   fadeGain -> userVolume -> muteGain -> [analyser] -> destination
      // Strictly ONE branch has gain 1.0 in steady state; transitions crossfade linearly
      // so bypass + graphic + parametric === 1.0 at every sample (zero clicks, zero gain > 1.0).
      bypassBranchGain.gain.value = 1;
      graphicBranchGain.gain.value = 0;
      parametricBranchGain.gain.value = 0;

      this.sourceNode.connect(replayGainNode);
      replayGainNode.connect(preampNode);

      preampNode.connect(bypassBranchGain);
      bypassBranchGain.connect(fadeGainNode);

      preampNode.connect(graphicFilters[0]);
      graphicFilters[graphicFilters.length - 1].connect(graphicBranchGain);
      graphicBranchGain.connect(fadeGainNode);

      preampNode.connect(parametricFilters[0]);
      parametricFilters[parametricFilters.length - 1].connect(parametricBranchGain);
      parametricBranchGain.connect(fadeGainNode);

      fadeGainNode.connect(userVolumeNode);
      userVolumeNode.connect(muteGainNode);
      if (analyserNode) {
        muteGainNode.connect(analyserNode);
        analyserNode.connect(ctx.destination);
      } else {
        muteGainNode.connect(ctx.destination);
      }

      this.replayGainNode = replayGainNode;
      this.preampNode = preampNode;
      this.bypassBranchGain = bypassBranchGain;
      this.graphicBranchGain = graphicBranchGain;
      this.parametricBranchGain = parametricBranchGain;
      this.graphicFilters = graphicFilters;
      this.parametricFilters = parametricFilters;
      this.fadeGainNode = fadeGainNode;
      this.userVolumeNode = userVolumeNode;
      this.muteGainNode = muteGainNode;
      this.analyserNode = analyserNode;
      this.emergencyVolumeNode = null;

      this.runtimeMode = 'dsp';
      this.lastError = null;
      this.activeBranch = 'none';

      // Re-normalize settings against actual AudioContext sampleRate and apply all params immediately
      this.settings = normalizeAudioLabSettings(this.settings, ctx.sampleRate);
      this.syncAllNodes(true);
      await this.resumeIfSuspended();
      return true;
    } catch (error) {
      // Source is ALREADY bound to AudioContext, so direct HTMLAudioElement cannot output by itself.
      // Attach an emergency fail-safe path (with user volume/mute if createGain works) so audio is NEVER silently lost!
      this.runtimeMode = 'error';
      this.lastError = `Lỗi dựng chuỗi DSP sau khi liên kết nguồn âm thanh (đã bật bypass khẩn cấp): ${
        error instanceof Error ? error.message : String(error)
      }`;
      try {
        this.sourceNode?.disconnect();
        try {
          const emergencyGain = this.ctx.createGain();
          emergencyGain.gain.value = this.muted ? 0 : this.userVolume;
          this.sourceNode?.connect(emergencyGain);
          emergencyGain.connect(this.ctx.destination);
          this.emergencyVolumeNode = emergencyGain;
        } catch {
          this.emergencyVolumeNode = null;
          this.sourceNode?.connect(this.ctx.destination);
        }
      } catch {
        // Ignore secondary cleanup error
      }
      return false;
    }
  }

  async resumeIfSuspended(): Promise<void> {
    if (!this.ctx || this.disposed) {
      return;
    }
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        // Browser autoplay policy may defer resume until next user gesture
      }
    }
  }

  setSettings(next: AudioLabSettings): void {
    this.settings = normalizeAudioLabSettings(next, this.getSampleRate());
    if (this.isActive()) {
      this.syncEqRoutingAndParams(false);
    }
  }

  setUserVolume(volume: number, immediate = false): void {
    this.userVolume = clampFinite(volume, 0, 1, 0.85);
    if (this.isActive() && this.userVolumeNode && this.ctx) {
      setParamSmooth(
        this.userVolumeNode.gain,
        this.userVolume,
        this.ctx.currentTime,
        PARAM_SMOOTH_TC_SEC,
        immediate,
      );
    } else if (this.emergencyVolumeNode && this.ctx) {
      setParamSmooth(
        this.emergencyVolumeNode.gain,
        this.muted ? 0 : this.userVolume,
        this.ctx.currentTime,
        PARAM_SMOOTH_TC_SEC,
        immediate,
      );
    }
  }

  setMuted(muted: boolean, immediate = false): void {
    this.muted = Boolean(muted);
    if (this.isActive() && this.muteGainNode && this.ctx) {
      setParamSmooth(
        this.muteGainNode.gain,
        this.muted ? 0 : 1,
        this.ctx.currentTime,
        MUTE_SMOOTH_TC_SEC,
        immediate,
      );
    } else if (this.emergencyVolumeNode && this.ctx) {
      setParamSmooth(
        this.emergencyVolumeNode.gain,
        this.muted ? 0 : this.userVolume,
        this.ctx.currentTime,
        MUTE_SMOOTH_TC_SEC,
        immediate,
      );
    }
  }

  setReplayGain(
    settings: ReplayGainSettings,
    computed: ComputedReplayGain,
    immediate = false,
  ): void {
    this.replayGainSettings = { ...settings };
    this.activeReplayGain = { ...computed };
    if (this.isActive() && this.replayGainNode && this.ctx) {
      const targetGain = clampFinite(computed.linearGain, 0.063, 4.0, 1.0);
      setParamSmooth(
        this.replayGainNode.gain,
        targetGain,
        this.ctx.currentTime,
        PARAM_SMOOTH_TC_SEC,
        immediate,
      );
    }
  }

  /**
   * Sets Fade GainNode immediately or schedules an AudioParam linear ramp.
   * Never touches User Volume, Preamp, EQ, or ReplayGain nodes.
   */
  setFadeGainImmediate(gain: number): void {
    const safe = clampFinite(gain, 0, 1, 1);
    this.fadeGain = safe;
    if (this.isActive() && this.fadeGainNode && this.ctx) {
      const now = this.ctx.currentTime;
      this.fadeGainNode.gain.cancelScheduledValues(now);
      this.fadeGainNode.gain.setValueAtTime(safe, now);
      this.fadeGainNode.gain.value = safe;
    }
  }

  scheduleFadeRamp(fromGain: number, toGain: number, durationSec: number): void {
    const startVal = clampFinite(fromGain, 0, 1, 1);
    const endVal = clampFinite(toGain, 0, 1, 1);
    const safeDur = Math.max(0.01, Number.isFinite(durationSec) ? durationSec : 0.01);
    this.fadeGain = endVal;

    if (this.isActive() && this.fadeGainNode && this.ctx) {
      const now = this.ctx.currentTime;
      this.fadeGainNode.gain.cancelScheduledValues(now);
      this.fadeGainNode.gain.setValueAtTime(startVal, now);
      this.fadeGainNode.gain.linearRampToValueAtTime(endVal, now + safeDur);
    }
  }

  getFadeGain(): number {
    if (this.isActive() && this.fadeGainNode) {
      const v = this.fadeGainNode.gain.value;
      if (Number.isFinite(v)) {
        return clampFinite(v, 0, 1, this.fadeGain);
      }
    }
    return this.fadeGain;
  }

  /**
   * Zero-allocation FFT spectrum sample read for Spectrum Analyzer canvas.
   * Returns false if DSP/Analyser is inactive or AudioContext is not running.
   */
  readSpectrumData(target: Uint8Array): boolean {
    if (!this.isActive() || !this.analyserNode || !this.ctx || this.ctx.state !== 'running') {
      return false;
    }
    if (target.length < this.analyserNode.frequencyBinCount) {
      return false;
    }
    this.analyserNode.getByteFrequencyData(target);
    return true;
  }

  getAnalyserBinCount(): number {
    return this.analyserNode?.frequencyBinCount ?? 512;
  }

  getRuntimeSnapshot(): AudioDspRuntimeSnapshot {
    const sampleRate = this.getSampleRate();
    const slot = getActiveSlotConfig(this.settings);
    const replayGainDb = this.activeReplayGain.applied ? this.activeReplayGain.gainDb : 0;
    const headroom = computeHeadroomAnalysis(slot, this.settings.enabled, sampleRate, replayGainDb);

    return {
      mode: this.runtimeMode,
      contextState: this.ctx ? this.ctx.state : 'uninitialized',
      sampleRate,
      nyquistMaxFreqHz: getSafeMaxFrequencyHz(sampleRate),
      eqActive: this.settings.enabled,
      activeEqMode: slot.mode,
      activeSlot: this.settings.activeSlot,
      sourceBound: this.sourceBound,
      analyserAvailable: this.analyserNode !== null,
      replayGainSettings: { ...this.replayGainSettings },
      activeReplayGain: { ...this.activeReplayGain },
      headroom,
      lastError: this.lastError,
    };
  }

  /**
   * Exposed for unit test inspection of the live DSP node chain.
   */
  getDebugNodes(): {
    context: AudioContextLike | null;
    source: AudioNodeLike | null;
    replayGain: GainNodeLike | null;
    preamp: GainNodeLike | null;
    branchGains: {
      bypass: GainNodeLike | null;
      graphic: GainNodeLike | null;
      parametric: GainNodeLike | null;
    };
    graphicFilters: readonly BiquadFilterNodeLike[];
    parametricFilters: readonly BiquadFilterNodeLike[];
    fadeGain: GainNodeLike | null;
    userVolume: GainNodeLike | null;
    muteGain: GainNodeLike | null;
    analyser: AnalyserNodeLike | null;
    emergencyVolume: GainNodeLike | null;
    activeBranch: ActiveRoutingBranch;
  } {
    return {
      context: this.ctx,
      source: this.sourceNode,
      replayGain: this.replayGainNode,
      preamp: this.preampNode,
      branchGains: {
        bypass: this.bypassBranchGain,
        graphic: this.graphicBranchGain,
        parametric: this.parametricBranchGain,
      },
      graphicFilters: this.graphicFilters,
      parametricFilters: this.parametricFilters,
      fadeGain: this.fadeGainNode,
      userVolume: this.userVolumeNode,
      muteGain: this.muteGainNode,
      analyser: this.analyserNode,
      emergencyVolume: this.emergencyVolumeNode,
      activeBranch: this.activeBranch,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      this.sourceNode?.disconnect();
      this.replayGainNode?.disconnect();
      this.preampNode?.disconnect();
      this.bypassBranchGain?.disconnect();
      this.graphicBranchGain?.disconnect();
      this.parametricBranchGain?.disconnect();
      for (const f of this.graphicFilters) {
        f.disconnect();
      }
      for (const f of this.parametricFilters) {
        f.disconnect();
      }
      this.fadeGainNode?.disconnect();
      this.userVolumeNode?.disconnect();
      this.muteGainNode?.disconnect();
      this.analyserNode?.disconnect();
      this.emergencyVolumeNode?.disconnect();
    } catch {
      // Best-effort cleanup
    }

    const ctxToClose = this.ctx;
    this.ctx = null;
    this.activeBranch = 'none';
    if (ctxToClose && ctxToClose.state !== 'closed') {
      void ctxToClose.close().catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Internal Node Sync (Strict Single-Branch Routing & Pop-Free Smoothing)
  // ---------------------------------------------------------------------------

  private syncAllNodes(immediate: boolean): void {
    if (!this.ctx || !this.isActive()) {
      return;
    }
    const now = this.ctx.currentTime;
    if (this.replayGainNode) {
      setParamSmooth(
        this.replayGainNode.gain,
        clampFinite(this.activeReplayGain.linearGain, 0.063, 4.0, 1.0),
        now,
        PARAM_SMOOTH_TC_SEC,
        immediate,
      );
    }
    if (this.fadeGainNode) {
      setParamSmooth(this.fadeGainNode.gain, this.fadeGain, now, PARAM_SMOOTH_TC_SEC, immediate);
    }
    if (this.userVolumeNode) {
      setParamSmooth(
        this.userVolumeNode.gain,
        this.userVolume,
        now,
        PARAM_SMOOTH_TC_SEC,
        immediate,
      );
    }
    if (this.muteGainNode) {
      setParamSmooth(
        this.muteGainNode.gain,
        this.muted ? 0 : 1,
        now,
        MUTE_SMOOTH_TC_SEC,
        immediate,
      );
    }
    this.syncEqRoutingAndParams(immediate);
  }

  private syncEqRoutingAndParams(immediate: boolean): void {
    if (!this.ctx || !this.preampNode || !this.fadeGainNode) {
      return;
    }

    const now = this.ctx.currentTime;
    const sampleRate = this.ctx.sampleRate;
    const maxFreq = getSafeMaxFrequencyHz(sampleRate);
    const slot = getActiveSlotConfig(this.settings);
    const desiredBranch: ActiveRoutingBranch = !this.settings.enabled
      ? 'bypass'
      : slot.mode === 'parametric'
        ? 'parametric'
        : 'graphic';

    // 1. Update Preamp GainNode (unity 1.0 in Bypass so EQ Off has neutral gain!)
    const headroom = computeHeadroomAnalysis(slot, this.settings.enabled, sampleRate, 0);
    const targetPreampLinear = this.settings.enabled
      ? dbToLinearGain(headroom.effectivePreampDb)
      : 1.0;
    setParamSmooth(this.preampNode.gain, targetPreampLinear, now, PARAM_SMOOTH_TC_SEC, immediate);

    // 2. Update Graphic EQ 10-band filter AudioParams in place (never recreates nodes)
    for (let i = 0; i < this.graphicFilters.length; i += 1) {
      const filter = this.graphicFilters[i];
      const expectedType = getGraphicBandFilterType(i);
      if (filter.type !== expectedType) {
        filter.type = expectedType;
      }
      const freq = Math.min(GRAPHIC_EQ_FREQUENCIES[i], maxFreq);
      const gainDb = this.settings.enabled ? (slot.graphicGainsDb[i] ?? 0) : 0;
      setParamSmooth(filter.frequency, freq, now, PARAM_SMOOTH_TC_SEC, immediate);
      setParamSmooth(filter.Q, GRAPHIC_OCTAVE_Q, now, PARAM_SMOOTH_TC_SEC, immediate);
      setParamSmooth(filter.gain, gainDb, now, PARAM_SMOOTH_TC_SEC, immediate);
    }

    // 3. Update Parametric EQ 8-band filter AudioParams in place (never recreates nodes)
    for (let i = 0; i < this.parametricFilters.length; i += 1) {
      const filter = this.parametricFilters[i];
      const band = slot.parametricBands[i];
      if (!band || !band.enabled || !this.settings.enabled) {
        // Neutral peaking 0 dB bypass in place -> zero graph teardown clicks when toggling one band
        if (filter.type !== 'peaking') {
          filter.type = 'peaking';
        }
        setParamSmooth(filter.frequency, band ? Math.min(band.frequencyHz, maxFreq) : 1000, now, PARAM_SMOOTH_TC_SEC, immediate);
        setParamSmooth(filter.Q, 1.0, now, PARAM_SMOOTH_TC_SEC, immediate);
        setParamSmooth(filter.gain, 0, now, PARAM_SMOOTH_TC_SEC, immediate);
        continue;
      }

      const targetType: ParametricFilterType = band.type;
      if (filter.type !== targetType) {
        filter.type = targetType;
      }
      const freq = clampFinite(band.frequencyHz, 20, maxFreq, 1000);
      const qParam = linearQToWebAudioFilterQ(targetType, band.q);
      const gainParam =
        targetType === 'peaking' || targetType === 'lowshelf' || targetType === 'highshelf'
          ? clampFinite(band.gainDb, -12, 12, 0)
          : 0;

      setParamSmooth(filter.frequency, freq, now, PARAM_SMOOTH_TC_SEC, immediate);
      setParamSmooth(filter.Q, qParam, now, PARAM_SMOOTH_TC_SEC, immediate);
      setParamSmooth(filter.gain, gainParam, now, PARAM_SMOOTH_TC_SEC, immediate);
    }

    // 4. Smoothly crossfade EQ routing matrix ONLY when branch changes (sum of all 3 branch gains === 1.0 always!)
    if (desiredBranch !== this.activeBranch) {
      this.transitionEqBranch(desiredBranch, immediate || this.activeBranch === 'none');
    }
  }

  private transitionEqBranch(nextBranch: ActiveRoutingBranch, immediate: boolean): void {
    if (
      !this.ctx ||
      !this.bypassBranchGain ||
      !this.graphicBranchGain ||
      !this.parametricBranchGain
    ) {
      return;
    }

    const now = this.ctx.currentTime;
    const targets: Array<{ node: GainNodeLike; target: number }> = [
      { node: this.bypassBranchGain, target: nextBranch === 'bypass' ? 1 : 0 },
      { node: this.graphicBranchGain, target: nextBranch === 'graphic' ? 1 : 0 },
      { node: this.parametricBranchGain, target: nextBranch === 'parametric' ? 1 : 0 },
    ];

    // Linear crossfade guarantees g_bypass(t) + g_graphic(t) + g_parametric(t) === 1.0 at every instant
    // (never exceeds unity gain, zero disconnect/connect clicks or pops).
    for (const { node, target } of targets) {
      const param = node.gain;
      try {
        param.cancelScheduledValues(now);
        if (immediate) {
          param.setValueAtTime(target, now);
          param.value = target;
        } else {
          const current = clampFinite(param.value, 0, 1, target);
          param.setValueAtTime(current, now);
          param.linearRampToValueAtTime(target, now + BRANCH_XFADE_SEC);
          param.value = target;
        }
      } catch {
        param.value = target;
      }
    }

    this.activeBranch = nextBranch;
  }
}

export function getActiveEqModeLabel(mode: EqMode): string {
  return mode === 'parametric' ? 'Parametric 8-Band' : 'Graphic 10-Band';
}
