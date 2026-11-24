import {
  GRAPHIC_EQ_FREQUENCIES,
  type AudioEqPreset,
  type AudioLabSettings,
  type ClippingRiskLevel,
  type EqMode,
  type EqSlotConfig,
  type EqSlotId,
  type FilterTypeCapabilities,
  type FrequencyResponsePoint,
  type HeadroomAnalysis,
  type ParametricBandConfig,
  type ParametricFilterType,
} from '../types/audio-dsp';

export const EQ_MIN_GAIN_DB = -12;
export const EQ_MAX_GAIN_DB = 12;
export const PREAMP_MIN_DB = -12;
export const PREAMP_MAX_DB = 12;
export const EFFECTIVE_PREAMP_MIN_DB = -18;
export const EFFECTIVE_PREAMP_MAX_DB = 12;
export const PARAMETRIC_MIN_FREQ_HZ = 20;
export const PARAMETRIC_DEFAULT_MAX_FREQ_HZ = 20000;
export const PARAMETRIC_MIN_Q = 0.1;
export const PARAMETRIC_MAX_Q = 18;
export const PARAMETRIC_BAND_COUNT = 8;
export const GRAPHIC_BAND_COUNT = GRAPHIC_EQ_FREQUENCIES.length;
export const GRAPHIC_OCTAVE_Q = 1.41;

export const DEFAULT_PARAMETRIC_ANCHOR_FREQS = [
  40, 120, 320, 800, 2000, 4500, 8500, 14000,
] as const;

const VALID_PARAMETRIC_TYPES = new Set<ParametricFilterType>([
  'peaking',
  'lowshelf',
  'highshelf',
  'lowpass',
  'highpass',
  'notch',
]);

export function clampFinite(value: number, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

export function roundTo(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

export function dbToLinearGain(db: number): number {
  if (!Number.isFinite(db)) {
    return 1;
  }
  return Math.pow(10, clampFinite(db, -60, 24, 0) / 20);
}

export function linearGainToDb(linear: number): number {
  if (!Number.isFinite(linear) || linear <= 1e-6) {
    return -120;
  }
  return 20 * Math.log10(linear);
}

/**
 * Returns the maximum safe filter frequency for a given AudioContext sample rate
 * (safely below the Nyquist frequency to avoid unstable/NaN Web Audio biquad poles).
 */
export function getSafeMaxFrequencyHz(sampleRate = 48000): number {
  const safeRate = clampFinite(sampleRate, 8000, 384000, 48000);
  return Math.min(PARAMETRIC_DEFAULT_MAX_FREQ_HZ, Math.floor(safeRate * 0.48));
}

export function getGraphicBandFilterType(index: number): BiquadFilterType {
  if (index <= 0) {
    return 'lowshelf';
  }
  if (index >= GRAPHIC_BAND_COUNT - 1) {
    return 'highshelf';
  }
  return 'peaking';
}

export function getFilterTypeCapabilities(type: ParametricFilterType): FilterTypeCapabilities {
  switch (type) {
    case 'peaking':
      return { hasGain: true, hasQ: true, label: 'Peaking (Bell)', shortLabel: 'Peak' };
    case 'lowshelf':
      return { hasGain: true, hasQ: false, label: 'Low Shelf', shortLabel: 'Low Shelf' };
    case 'highshelf':
      return { hasGain: true, hasQ: false, label: 'High Shelf', shortLabel: 'High Shelf' };
    case 'lowpass':
      return { hasGain: false, hasQ: true, label: 'Low Pass', shortLabel: 'LPF' };
    case 'highpass':
      return { hasGain: false, hasQ: true, label: 'High Pass', shortLabel: 'HPF' };
    case 'notch':
      return { hasGain: false, hasQ: true, label: 'Notch', shortLabel: 'Notch' };
  }
}

export function formatFrequencyLabel(freqHz: number): string {
  if (!Number.isFinite(freqHz)) {
    return '1 kHz';
  }
  if (freqHz >= 1000) {
    const khz = freqHz / 1000;
    return `${Number.isInteger(khz) ? khz : Number(khz.toFixed(1))} kHz`;
  }
  return `${Math.round(freqHz)} Hz`;
}

export function formatDbLabel(db: number, decimals = 1): string {
  const safe = Number.isFinite(db) ? db : 0;
  const rounded = roundTo(safe, decimals);
  if (Math.abs(rounded) < 0.005) {
    return `0.${'0'.repeat(decimals)} dB`;
  }
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(decimals)} dB`;
}

export function createFlatGraphicGains(): number[] {
  return GRAPHIC_EQ_FREQUENCIES.map(() => 0);
}

export function createDefaultParametricBands(sampleRate = 48000): ParametricBandConfig[] {
  const maxFreq = getSafeMaxFrequencyHz(sampleRate);
  return DEFAULT_PARAMETRIC_ANCHOR_FREQS.map((freq, index) => ({
    id: `peq-${index + 1}`,
    enabled: true,
    type: index === 0 ? 'lowshelf' : index === PARAMETRIC_BAND_COUNT - 1 ? 'highshelf' : 'peaking',
    frequencyHz: Math.min(freq, maxFreq),
    gainDb: 0,
    q: 1.2,
  }));
}

export function sanitizeGraphicGains(raw: unknown): number[] {
  const fallback = createFlatGraphicGains();
  if (!Array.isArray(raw)) {
    return fallback;
  }
  return GRAPHIC_EQ_FREQUENCIES.map((_, idx) =>
    roundTo(clampFinite(Number(raw[idx]), EQ_MIN_GAIN_DB, EQ_MAX_GAIN_DB, 0), 2),
  );
}

export function sanitizeParametricBand(
  raw: Partial<ParametricBandConfig> | null | undefined,
  index: number,
  sampleRate = 48000,
): ParametricBandConfig {
  const defaults = createDefaultParametricBands(sampleRate);
  const fallback = defaults[index] ?? {
    id: `peq-${index + 1}`,
    enabled: true,
    type: 'peaking' as ParametricFilterType,
    frequencyHz: 1000,
    gainDb: 0,
    q: 1.2,
  };
  const maxFreq = getSafeMaxFrequencyHz(sampleRate);

  const rawType = raw?.type;
  const type: ParametricFilterType =
    typeof rawType === 'string' && VALID_PARAMETRIC_TYPES.has(rawType as ParametricFilterType)
      ? (rawType as ParametricFilterType)
      : fallback.type;

  const id =
    typeof raw?.id === 'string' && raw.id.trim().length > 0
      ? raw.id.trim().slice(0, 32)
      : fallback.id;

  return {
    id,
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    type,
    frequencyHz: roundTo(
      clampFinite(
        Number(raw?.frequencyHz),
        PARAMETRIC_MIN_FREQ_HZ,
        maxFreq,
        fallback.frequencyHz,
      ),
      1,
    ),
    gainDb: roundTo(
      clampFinite(Number(raw?.gainDb), EQ_MIN_GAIN_DB, EQ_MAX_GAIN_DB, fallback.gainDb),
      2,
    ),
    q: roundTo(clampFinite(Number(raw?.q), PARAMETRIC_MIN_Q, PARAMETRIC_MAX_Q, fallback.q), 2),
  };
}

export function sanitizeParametricBands(
  raw: unknown,
  sampleRate = 48000,
): ParametricBandConfig[] {
  const defaults = createDefaultParametricBands(sampleRate);
  if (!Array.isArray(raw)) {
    return defaults;
  }
  const usedIds = new Set<string>();
  return defaults.map((_, idx) => {
    const band = sanitizeParametricBand(
      raw[idx] as Partial<ParametricBandConfig> | undefined,
      idx,
      sampleRate,
    );
    if (usedIds.has(band.id)) {
      band.id = `peq-${idx + 1}`;
    }
    usedIds.add(band.id);
    return band;
  });
}

function makeSystemPreset(input: {
  id: string;
  name: string;
  description: string;
  graphicGainsDb: number[];
  preampDb: number;
  parametricOverrides?: Array<Partial<ParametricBandConfig> & { index: number }>;
}): AudioEqPreset {
  const parametricBands = createDefaultParametricBands();
  if (input.parametricOverrides) {
    for (const ov of input.parametricOverrides) {
      if (ov.index >= 0 && ov.index < parametricBands.length) {
        parametricBands[ov.index] = sanitizeParametricBand(
          { ...parametricBands[ov.index], ...ov },
          ov.index,
        );
      }
    }
  }
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    isSystem: true,
    mode: 'graphic',
    graphicGainsDb: sanitizeGraphicGains(input.graphicGainsDb),
    parametricBands,
    preampDb: roundTo(clampFinite(input.preampDb, PREAMP_MIN_DB, PREAMP_MAX_DB, 0), 2),
    autoHeadroom: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * 7 conservative reference EQ presets (no exaggerated loudness jumps).
 */
export const SYSTEM_AUDIO_PRESETS: readonly AudioEqPreset[] = [
  makeSystemPreset({
    id: 'sys-flat',
    name: 'Flat',
    description: 'Đáp tuyến trung tính 0 dB trên mọi băng tần tham chiếu.',
    graphicGainsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    preampDb: 0,
  }),
  makeSystemPreset({
    id: 'sys-bass-boost',
    name: 'Bass Boost',
    description: 'Tăng nhẹ dải trầm và siêu trầm với Preamp bù headroom thận trọng.',
    graphicGainsDb: [3.5, 4.0, 2.5, 1.0, 0, 0, 0, 0.5, 0.5, 0],
    preampDb: -2.0,
    parametricOverrides: [
      { index: 0, type: 'lowshelf', frequencyHz: 65, gainDb: 3.5 },
      { index: 1, type: 'peaking', frequencyHz: 110, gainDb: 1.5, q: 1.1 },
    ],
  }),
  makeSystemPreset({
    id: 'sys-warm',
    name: 'Warm',
    description: 'Nhấn nhẹ dải trung trầm ấm áp và làm dịu dải cao sắc gắt.',
    graphicGainsDb: [1.5, 2.0, 2.2, 1.4, 0.4, -0.4, -0.8, -1.2, -1.5, -1.8],
    preampDb: -1.0,
    parametricOverrides: [
      { index: 0, type: 'lowshelf', frequencyHz: 110, gainDb: 2.0 },
      { index: 7, type: 'highshelf', frequencyHz: 7500, gainDb: -1.6 },
    ],
  }),
  makeSystemPreset({
    id: 'sys-vocal-clarity',
    name: 'Vocal Clarity',
    description: 'Làm nổi bật độ rõ giọng hát ở dải trung và trung cao.',
    graphicGainsDb: [-1.0, -0.5, 0, 0.5, 1.5, 2.5, 2.8, 1.6, 0.5, 0],
    preampDb: -1.5,
    parametricOverrides: [
      { index: 3, type: 'peaking', frequencyHz: 1200, gainDb: 2.0, q: 1.0 },
      { index: 4, type: 'peaking', frequencyHz: 2600, gainDb: 2.4, q: 1.3 },
    ],
  }),
  makeSystemPreset({
    id: 'sys-treble-boost',
    name: 'Treble Boost',
    description: 'Tăng nhẹ độ thoáng và chi tiết dải cao ở mức kiểm soát.',
    graphicGainsDb: [0, 0, 0, 0, 0, 0.5, 1.5, 2.5, 3.2, 3.5],
    preampDb: -1.5,
    parametricOverrides: [
      { index: 6, type: 'peaking', frequencyHz: 6500, gainDb: 2.0, q: 1.1 },
      { index: 7, type: 'highshelf', frequencyHz: 10000, gainDb: 2.8 },
    ],
  }),
  makeSystemPreset({
    id: 'sys-balanced',
    name: 'Balanced',
    description: 'Đường cong nhẹ hai đầu dải tần cho trải nghiệm nghe cân bằng.',
    graphicGainsDb: [1.2, 1.5, 0.8, 0, -0.4, 0, 0.8, 1.2, 1.5, 1.0],
    preampDb: -0.8,
    parametricOverrides: [
      { index: 0, type: 'lowshelf', frequencyHz: 70, gainDb: 1.4 },
      { index: 7, type: 'highshelf', frequencyHz: 8500, gainDb: 1.3 },
    ],
  }),
  makeSystemPreset({
    id: 'sys-soft-listening',
    name: 'Soft Listening',
    description: 'Phù hợp nghe âm lượng nhỏ vào ban đêm, giảm gắt dải 2–4 kHz.',
    graphicGainsDb: [2.0, 1.5, 0.8, 0, -0.6, -1.0, -1.6, -1.4, -0.5, 0.5],
    preampDb: -1.0,
    parametricOverrides: [
      { index: 0, type: 'lowshelf', frequencyHz: 80, gainDb: 1.8 },
      { index: 4, type: 'peaking', frequencyHz: 2800, gainDb: -1.8, q: 1.1 },
    ],
  }),
];

export function cloneEqSlotConfig(slot: EqSlotConfig): EqSlotConfig {
  return {
    mode: slot.mode,
    graphicGainsDb: [...slot.graphicGainsDb],
    parametricBands: slot.parametricBands.map((b) => ({ ...b })),
    preampDb: slot.preampDb,
    autoHeadroom: slot.autoHeadroom,
    activePresetId: slot.activePresetId,
  };
}

export function createDefaultEqSlotConfig(sampleRate = 48000): EqSlotConfig {
  return {
    mode: 'graphic',
    graphicGainsDb: createFlatGraphicGains(),
    parametricBands: createDefaultParametricBands(sampleRate),
    preampDb: 0,
    autoHeadroom: false,
    activePresetId: 'sys-flat',
  };
}

export function createDefaultAudioLabSettings(sampleRate = 48000): AudioLabSettings {
  return {
    version: 1,
    enabled: false,
    activeSlot: 'A',
    slots: {
      A: createDefaultEqSlotConfig(sampleRate),
      B: createDefaultEqSlotConfig(sampleRate),
    },
    customPresets: [],
    spectrumEnabled: true,
  };
}

export function sanitizeEqSlotConfig(
  raw: Partial<EqSlotConfig> | null | undefined,
  sampleRate = 48000,
): EqSlotConfig {
  const mode: EqMode = raw?.mode === 'parametric' ? 'parametric' : 'graphic';
  return {
    mode,
    graphicGainsDb: sanitizeGraphicGains(raw?.graphicGainsDb),
    parametricBands: sanitizeParametricBands(raw?.parametricBands, sampleRate),
    preampDb: roundTo(clampFinite(Number(raw?.preampDb), PREAMP_MIN_DB, PREAMP_MAX_DB, 0), 2),
    autoHeadroom: typeof raw?.autoHeadroom === 'boolean' ? raw.autoHeadroom : false,
    activePresetId:
      typeof raw?.activePresetId === 'string' && raw.activePresetId.trim().length > 0
        ? raw.activePresetId.trim().slice(0, 64)
        : null,
  };
}

export function sanitizeCustomPreset(
  raw: Partial<AudioEqPreset> | null | undefined,
  sampleRate = 48000,
): AudioEqPreset | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const rawName = typeof raw.name === 'string' ? raw.name.replace(/[\u0000-\u001F\u007F]/g, '').trim() : '';
  if (!rawName) {
    return null;
  }
  const rawId = typeof raw.id === 'string' ? raw.id.trim() : '';
  // Never allow custom preset to impersonate a system preset ID
  if (!rawId || rawId.startsWith('sys-')) {
    return null;
  }
  const nowIso = new Date().toISOString();
  return {
    id: rawId.slice(0, 64),
    name: rawName.slice(0, 48),
    description:
      typeof raw.description === 'string'
        ? raw.description.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 140)
        : 'Preset tùy chỉnh của người dùng.',
    isSystem: false,
    mode: raw.mode === 'parametric' ? 'parametric' : 'graphic',
    graphicGainsDb: sanitizeGraphicGains(raw.graphicGainsDb),
    parametricBands: sanitizeParametricBands(raw.parametricBands, sampleRate),
    preampDb: roundTo(clampFinite(Number(raw.preampDb), PREAMP_MIN_DB, PREAMP_MAX_DB, 0), 2),
    autoHeadroom: typeof raw.autoHeadroom === 'boolean' ? raw.autoHeadroom : false,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso,
  };
}

export function normalizeAudioLabSettings(
  raw: Partial<AudioLabSettings> | null | undefined,
  sampleRate = 48000,
): AudioLabSettings {
  const defaults = createDefaultAudioLabSettings(sampleRate);
  if (!raw || typeof raw !== 'object') {
    return defaults;
  }

  const activeSlot: EqSlotId = raw.activeSlot === 'B' ? 'B' : 'A';
  const customPresets: AudioEqPreset[] = [];
  const seenPresetIds = new Set<string>(SYSTEM_AUDIO_PRESETS.map((p) => p.id));
  if (Array.isArray(raw.customPresets)) {
    for (const item of raw.customPresets) {
      const sanitized = sanitizeCustomPreset(item, sampleRate);
      if (sanitized && !seenPresetIds.has(sanitized.id)) {
        seenPresetIds.add(sanitized.id);
        customPresets.push(sanitized);
      }
      if (customPresets.length >= 64) {
        break;
      }
    }
  }

  return {
    version: 1,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled,
    activeSlot,
    slots: {
      A: sanitizeEqSlotConfig(raw.slots?.A, sampleRate),
      B: sanitizeEqSlotConfig(raw.slots?.B, sampleRate),
    },
    customPresets,
    spectrumEnabled:
      typeof raw.spectrumEnabled === 'boolean' ? raw.spectrumEnabled : defaults.spectrumEnabled,
  };
}

export function getActiveSlotConfig(settings: AudioLabSettings): EqSlotConfig {
  return settings.activeSlot === 'B' ? settings.slots.B : settings.slots.A;
}

export function getAllPresets(settings: AudioLabSettings): AudioEqPreset[] {
  return [...SYSTEM_AUDIO_PRESETS, ...settings.customPresets];
}

export function applyPresetToSlot(
  preset: AudioEqPreset,
  _currentSlot: EqSlotConfig,
  sampleRate = 48000,
): EqSlotConfig {
  return sanitizeEqSlotConfig(
    {
      mode: preset.mode,
      graphicGainsDb: [...preset.graphicGainsDb],
      parametricBands: preset.parametricBands.map((b) => ({ ...b })),
      preampDb: preset.preampDb,
      autoHeadroom: preset.autoHeadroom,
      activePresetId: preset.id,
    },
    sampleRate,
  );
}

// -----------------------------------------------------------------------------
// Analytical Robert Bristow-Johnson (RBJ) Biquad Frequency Response Calculator
// Matches Chromium / WebKit Web Audio API BiquadFilterNode transfer function H(e^{jw})
// -----------------------------------------------------------------------------

interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a0: number;
  a1: number;
  a2: number;
}

function computeRbjBiquadCoefficients(
  type: ParametricFilterType,
  frequencyHz: number,
  gainDb: number,
  q: number,
  sampleRate: number,
): BiquadCoefficients {
  const safeFs = clampFinite(sampleRate, 8000, 384000, 48000);
  const maxFreq = getSafeMaxFrequencyHz(safeFs);
  const f0 = clampFinite(frequencyHz, 10, maxFreq, 1000);
  const safeQ = clampFinite(q, PARAMETRIC_MIN_Q, PARAMETRIC_MAX_Q, 1.0);
  const safeGain = clampFinite(gainDb, -24, 24, 0);

  const w0 = (2 * Math.PI * f0) / safeFs;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const A = Math.pow(10, safeGain / 40);
  const alphaQ = sinW0 / (2 * safeQ);
  // Web Audio lowshelf/highshelf use shelf slope S = 1 -> alphaS = sin(w0)/2 * sqrt(2)
  const alphaShelf = (sinW0 / 2) * Math.SQRT2;
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alphaShelf;

  switch (type) {
    case 'peaking': {
      return {
        b0: 1 + alphaQ * A,
        b1: -2 * cosW0,
        b2: 1 - alphaQ * A,
        a0: 1 + alphaQ / A,
        a1: -2 * cosW0,
        a2: 1 - alphaQ / A,
      };
    }
    case 'lowshelf': {
      return {
        b0: A * (A + 1 - (A - 1) * cosW0 + twoSqrtAAlpha),
        b1: 2 * A * (A - 1 - (A + 1) * cosW0),
        b2: A * (A + 1 - (A - 1) * cosW0 - twoSqrtAAlpha),
        a0: A + 1 + (A - 1) * cosW0 + twoSqrtAAlpha,
        a1: -2 * (A - 1 + (A + 1) * cosW0),
        a2: A + 1 + (A - 1) * cosW0 - twoSqrtAAlpha,
      };
    }
    case 'highshelf': {
      return {
        b0: A * (A + 1 + (A - 1) * cosW0 + twoSqrtAAlpha),
        b1: -2 * A * (A - 1 + (A + 1) * cosW0),
        b2: A * (A + 1 + (A - 1) * cosW0 - twoSqrtAAlpha),
        a0: A + 1 - (A - 1) * cosW0 + twoSqrtAAlpha,
        a1: 2 * (A - 1 - (A + 1) * cosW0),
        a2: A + 1 - (A - 1) * cosW0 - twoSqrtAAlpha,
      };
    }
    case 'lowpass': {
      // Web Audio API lowpass treats Q in dB resonance: Q_linear = 10^(Q_db / 20)
      // For standard parametric Q factor (0.1..18), direct Q matches RBJ LPF cleanly.
      const alphaLpf = sinW0 / (2 * safeQ);
      return {
        b0: (1 - cosW0) / 2,
        b1: 1 - cosW0,
        b2: (1 - cosW0) / 2,
        a0: 1 + alphaLpf,
        a1: -2 * cosW0,
        a2: 1 - alphaLpf,
      };
    }
    case 'highpass': {
      const alphaHpf = sinW0 / (2 * safeQ);
      return {
        b0: (1 + cosW0) / 2,
        b1: -(1 + cosW0),
        b2: (1 + cosW0) / 2,
        a0: 1 + alphaHpf,
        a1: -2 * cosW0,
        a2: 1 - alphaHpf,
      };
    }
    case 'notch': {
      return {
        b0: 1,
        b1: -2 * cosW0,
        b2: 1,
        a0: 1 + alphaQ,
        a1: -2 * cosW0,
        a2: 1 - alphaQ,
      };
    }
  }
}

/**
 * Evaluates exact magnitude response in dB at frequency `evalFreqHz` for a single biquad filter.
 */
export function evaluateBiquadMagnitudeDb(
  type: ParametricFilterType,
  filterFreqHz: number,
  gainDb: number,
  q: number,
  evalFreqHz: number,
  sampleRate = 48000,
): number {
  const safeFs = clampFinite(sampleRate, 8000, 384000, 48000);
  // Short-circuit unity filters for fast zero-error neutral response
  if ((type === 'peaking' || type === 'lowshelf' || type === 'highshelf') && Math.abs(gainDb) < 1e-4) {
    return 0;
  }

  const c = computeRbjBiquadCoefficients(type, filterFreqHz, gainDb, q, safeFs);
  const b0 = c.b0 / c.a0;
  const b1 = c.b1 / c.a0;
  const b2 = c.b2 / c.a0;
  const a1 = c.a1 / c.a0;
  const a2 = c.a2 / c.a0;

  const w = (2 * Math.PI * clampFinite(evalFreqHz, 1, safeFs * 0.499, 1000)) / safeFs;
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const cos2W = Math.cos(2 * w);
  const sin2W = Math.sin(2 * w);

  const numRe = b0 + b1 * cosW + b2 * cos2W;
  const numIm = -(b1 * sinW + b2 * sin2W);
  const denRe = 1 + a1 * cosW + a2 * cos2W;
  const denIm = -(a1 * sinW + a2 * sin2W);

  const numMagSq = numRe * numRe + numIm * numIm;
  const denMagSq = denRe * denRe + denIm * denIm;
  if (denMagSq <= 1e-18) {
    return -60;
  }
  const magSq = numMagSq / denMagSq;
  if (magSq <= 1e-12) {
    return -60;
  }
  return clampFinite(10 * Math.log10(magSq), -48, 36, 0);
}

/**
 * Generates a logarithmically spaced array of evaluation frequencies from 20 Hz to maxFreqHz.
 */
export function generateLogFrequencyGrid(
  pointCount = 160,
  minFreqHz = 20,
  maxFreqHz = 20000,
): number[] {
  const count = Math.max(16, Math.min(512, Math.round(pointCount)));
  const minLog = Math.log10(Math.max(10, minFreqHz));
  const maxLog = Math.log10(Math.max(minFreqHz + 10, maxFreqHz));
  const freqs: number[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    freqs[i] = Math.pow(10, minLog + t * (maxLog - minLog));
  }
  return freqs;
}

export interface ActiveFilterSpec {
  type: ParametricFilterType;
  frequencyHz: number;
  gainDb: number;
  q: number;
}

export function extractActiveFilterSpecs(
  slot: EqSlotConfig,
  eqEnabled: boolean,
  sampleRate = 48000,
): ActiveFilterSpec[] {
  if (!eqEnabled) {
    return [];
  }
  const maxFreq = getSafeMaxFrequencyHz(sampleRate);

  if (slot.mode === 'graphic') {
    const gains = sanitizeGraphicGains(slot.graphicGainsDb);
    return GRAPHIC_EQ_FREQUENCIES.map((freq, idx) => ({
      type: getGraphicBandFilterType(idx) as ParametricFilterType,
      frequencyHz: Math.min(freq, maxFreq),
      gainDb: gains[idx],
      q: GRAPHIC_OCTAVE_Q,
    }));
  }

  return sanitizeParametricBands(slot.parametricBands, sampleRate)
    .filter((band) => band.enabled)
    .map((band) => ({
      type: band.type,
      frequencyHz: Math.min(band.frequencyHz, maxFreq),
      gainDb: band.gainDb,
      q: band.q,
    }));
}

/**
 * Computes headroom & clipping risk analysis based on the true composite frequency response
 * of all active EQ filters + manual preamp + optional ReplayGain offset.
 * Note: This estimates steady-state frequency-domain peak gain; it never claims
 * absolute zero inter-sample clipping without a real-time true-peak limiter.
 */
export function computeHeadroomAnalysis(
  slot: EqSlotConfig,
  eqEnabled: boolean,
  sampleRate = 48000,
  replayGainDb = 0,
): HeadroomAnalysis {
  if (!eqEnabled) {
    const safeRg = Number.isFinite(replayGainDb) ? replayGainDb : 0;
    return {
      maxEqBoostDb: 0,
      maxEqCutDb: 0,
      autoHeadroomOffsetDb: 0,
      effectivePreampDb: 0,
      peakTotalResponseDb: roundTo(safeRg, 2),
      clippingRisk: safeRg > 3 ? 'high' : safeRg > 0.5 ? 'moderate' : 'none',
    };
  }

  const maxFreq = getSafeMaxFrequencyHz(sampleRate);
  const filters = extractActiveFilterSpecs(slot, true, sampleRate);
  const grid = generateLogFrequencyGrid(120, 20, maxFreq);

  let maxEqBoostDb = 0;
  let maxEqCutDb = 0;

  for (const f of grid) {
    let sumDb = 0;
    for (const flt of filters) {
      sumDb += evaluateBiquadMagnitudeDb(
        flt.type,
        flt.frequencyHz,
        flt.gainDb,
        flt.q,
        f,
        sampleRate,
      );
    }
    if (sumDb > maxEqBoostDb) {
      maxEqBoostDb = sumDb;
    }
    if (sumDb < maxEqCutDb) {
      maxEqCutDb = sumDb;
    }
  }

  const manualPreampDb = clampFinite(slot.preampDb, PREAMP_MIN_DB, PREAMP_MAX_DB, 0);
  // Auto Headroom compensates positive EQ peak boost (rounded to 0.1 dB, clamped to -12..0 dB)
  const autoHeadroomOffsetDb = slot.autoHeadroom
    ? roundTo(-clampFinite(maxEqBoostDb, 0, 12, 0), 1)
    : 0;
  const effectivePreampDb = roundTo(
    clampFinite(
      manualPreampDb + autoHeadroomOffsetDb,
      EFFECTIVE_PREAMP_MIN_DB,
      EFFECTIVE_PREAMP_MAX_DB,
      0,
    ),
    2,
  );
  const safeRg = Number.isFinite(replayGainDb) ? replayGainDb : 0;
  const peakTotalResponseDb = roundTo(maxEqBoostDb + effectivePreampDb + safeRg, 2);

  let clippingRisk: ClippingRiskLevel = 'none';
  if (peakTotalResponseDb > 3.0) {
    clippingRisk = 'high';
  } else if (peakTotalResponseDb > 0.5) {
    clippingRisk = 'moderate';
  }

  return {
    maxEqBoostDb: roundTo(maxEqBoostDb, 2),
    maxEqCutDb: roundTo(maxEqCutDb, 2),
    autoHeadroomOffsetDb,
    effectivePreampDb,
    peakTotalResponseDb,
    clippingRisk,
  };
}

/**
 * Computes the complete composite frequency response curve across a logarithmic grid.
 * Returns both the pure EQ curve (`eqDb`) and the preamp-shifted output curve (`totalDb`).
 */
export function computeCompositeFrequencyResponse(
  slot: EqSlotConfig,
  eqEnabled: boolean,
  sampleRate = 48000,
  pointCount = 160,
): {
  points: FrequencyResponsePoint[];
  headroom: HeadroomAnalysis;
} {
  const maxFreq = getSafeMaxFrequencyHz(sampleRate);
  const grid = generateLogFrequencyGrid(pointCount, 20, maxFreq);
  const filters = extractActiveFilterSpecs(slot, eqEnabled, sampleRate);
  const headroom = computeHeadroomAnalysis(slot, eqEnabled, sampleRate, 0);

  const points: FrequencyResponsePoint[] = grid.map((frequencyHz) => {
    let eqDb = 0;
    for (const flt of filters) {
      eqDb += evaluateBiquadMagnitudeDb(
        flt.type,
        flt.frequencyHz,
        flt.gainDb,
        flt.q,
        frequencyHz,
        sampleRate,
      );
    }
    const clampedEq = clampFinite(eqDb, -36, 24, 0);
    const totalDb = clampFinite(clampedEq + headroom.effectivePreampDb, -36, 24, 0);
    return {
      frequencyHz,
      eqDb: roundTo(clampedEq, 2),
      totalDb: roundTo(totalDb, 2),
    };
  });

  return { points, headroom };
}

/**
 * Converts a Web Audio LPF/HPF linear Q factor (0.1..18) into Web Audio's dB Q parameter
 * (`Q_dB = 20 * log10(Q)`) because Web Audio `lowpass`/`highpass` BiquadFilterNode uses dB for Q!
 */
export function linearQToWebAudioFilterQ(type: ParametricFilterType, linearQ: number): number {
  const safeQ = clampFinite(linearQ, PARAMETRIC_MIN_Q, PARAMETRIC_MAX_Q, 1.0);
  if (type === 'lowpass' || type === 'highpass') {
    // Web Audio API defines lowpass/highpass Q in dB (range roughly -20..+25 dB)
    return clampFinite(20 * Math.log10(safeQ), -20, 25, 0);
  }
  return safeQ;
}
