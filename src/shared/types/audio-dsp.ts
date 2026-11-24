import type { ComputedReplayGain, ReplayGainSettings } from './stage6';

export type EqMode = 'graphic' | 'parametric';

export type EqSlotId = 'A' | 'B';

export type ParametricFilterType =
  | 'peaking'
  | 'lowshelf'
  | 'highshelf'
  | 'lowpass'
  | 'highpass'
  | 'notch';

export const GRAPHIC_EQ_FREQUENCIES = [
  31,
  62,
  125,
  250,
  500,
  1000,
  2000,
  4000,
  8000,
  16000,
] as const;

export type GraphicEqFrequencyHz = (typeof GRAPHIC_EQ_FREQUENCIES)[number];

export type GraphicEqGainsTuple = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface ParametricBandConfig {
  id: string;
  enabled: boolean;
  type: ParametricFilterType;
  frequencyHz: number;
  gainDb: number;
  q: number;
}

export interface EqSlotConfig {
  mode: EqMode;
  graphicGainsDb: number[];
  parametricBands: ParametricBandConfig[];
  preampDb: number;
  autoHeadroom: boolean;
  activePresetId: string | null;
}

export interface AudioEqPreset {
  id: string;
  name: string;
  description: string;
  isSystem: boolean;
  mode: EqMode;
  graphicGainsDb: number[];
  parametricBands: ParametricBandConfig[];
  preampDb: number;
  autoHeadroom: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AudioLabSettings {
  version: 1;
  enabled: boolean;
  activeSlot: EqSlotId;
  slots: {
    A: EqSlotConfig;
    B: EqSlotConfig;
  };
  customPresets: AudioEqPreset[];
  spectrumEnabled: boolean;
}

export type DspRuntimeMode = 'direct' | 'dsp' | 'fallback-direct' | 'error';

export type ClippingRiskLevel = 'none' | 'moderate' | 'high';

export interface HeadroomAnalysis {
  maxEqBoostDb: number;
  maxEqCutDb: number;
  autoHeadroomOffsetDb: number;
  effectivePreampDb: number;
  peakTotalResponseDb: number;
  clippingRisk: ClippingRiskLevel;
}

export interface AudioDspRuntimeSnapshot {
  mode: DspRuntimeMode;
  contextState: 'uninitialized' | 'suspended' | 'running' | 'closed';
  sampleRate: number;
  nyquistMaxFreqHz: number;
  eqActive: boolean;
  activeEqMode: EqMode;
  activeSlot: EqSlotId;
  sourceBound: boolean;
  analyserAvailable: boolean;
  replayGainSettings: ReplayGainSettings;
  activeReplayGain: ComputedReplayGain;
  headroom: HeadroomAnalysis;
  lastError: string | null;
}

export interface FrequencyResponsePoint {
  frequencyHz: number;
  eqDb: number;
  totalDb: number;
}

export interface FilterTypeCapabilities {
  hasGain: boolean;
  hasQ: boolean;
  label: string;
  shortLabel: string;
}
