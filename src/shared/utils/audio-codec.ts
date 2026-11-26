import type { TrackRecord } from '../types/track';

export type AudioCodecFamily =
  | 'alac'
  | 'aac'
  | 'flac'
  | 'wav'
  | 'mp3'
  | 'opus'
  | 'vorbis'
  | 'unknown';

export type AudioQualityTier = 'lossless' | 'lossy' | 'unknown';

export interface ClassifiedAudioCodec {
  family: AudioCodecFamily;
  displayCodec: string;
  containerLabel: string | null;
  qualityTier: AudioQualityTier;
  qualityLabel: 'Lossless' | 'Lossy' | 'Unknown';
  isM4aContainer: boolean;
}

function extractLowerExt(filePath: string | null | undefined): string {
  if (!filePath || typeof filePath !== 'string') {
    return '';
  }
  const normalized = filePath.trim().toLowerCase();
  const dotIdx = normalized.lastIndexOf('.');
  if (dotIdx < 0) {
    return '';
  }
  return normalized.slice(dotIdx);
}

/**
 * Classifies an audio track strictly from real metadata (`codec` / `container`)
 * rather than guessing Lossless from `.m4a` file extension.
 *
 * Rules:
 * - ALAC inside M4A -> Lossless (`ALAC`)
 * - AAC inside M4A -> Lossy (`AAC`)
 * - Unrecognized codec inside M4A -> Unknown (`M4A`), NEVER mislabeled Lossless
 */
export function classifyTrackAudioCodec(input: {
  codec?: string | null;
  container?: string | null;
  original_path?: string | null;
}): ClassifiedAudioCodec {
  const codecRaw = (input.codec ?? '').trim();
  const containerRaw = (input.container ?? '').trim();
  const codecUpper = codecRaw.toUpperCase();
  const containerUpper = containerRaw.toUpperCase();
  const ext = extractLowerExt(input.original_path);

  const isM4aContainer =
    ext === '.m4a' ||
    ext === '.mp4' ||
    containerUpper.includes('M4A') ||
    containerUpper.includes('MP4') ||
    containerUpper.includes('ISOM') ||
    containerUpper.includes('QUICKTIME');

  if (codecUpper.includes('ALAC') || codecUpper.includes('APPLE LOSSLESS')) {
    return {
      family: 'alac',
      displayCodec: 'ALAC',
      containerLabel: isM4aContainer ? 'M4A' : containerRaw || 'M4A',
      qualityTier: 'lossless',
      qualityLabel: 'Lossless',
      isM4aContainer: true,
    };
  }

  if (
    codecUpper.includes('AAC') ||
    codecUpper.includes('MP4A') ||
    codecUpper === 'MPEG-4/AAC' ||
    ext === '.aac'
  ) {
    return {
      family: 'aac',
      displayCodec: 'AAC',
      containerLabel: isM4aContainer ? 'M4A' : 'AAC',
      qualityTier: 'lossy',
      qualityLabel: 'Lossy',
      isM4aContainer,
    };
  }

  if (codecUpper.includes('FLAC') || containerUpper === 'FLAC' || ext === '.flac') {
    return {
      family: 'flac',
      displayCodec: 'FLAC',
      containerLabel: 'FLAC',
      qualityTier: 'lossless',
      qualityLabel: 'Lossless',
      isM4aContainer: false,
    };
  }

  if (
    codecUpper.includes('PCM') ||
    containerUpper === 'WAVE' ||
    containerUpper === 'WAV' ||
    ext === '.wav'
  ) {
    return {
      family: 'wav',
      displayCodec: 'WAV',
      containerLabel: 'WAV',
      qualityTier: 'lossless',
      qualityLabel: 'Lossless',
      isM4aContainer: false,
    };
  }

  if (
    codecUpper.includes('MPEG 1 LAYER 3') ||
    codecUpper.includes('MP3') ||
    containerUpper === 'MP3' ||
    ext === '.mp3'
  ) {
    return {
      family: 'mp3',
      displayCodec: 'MP3',
      containerLabel: 'MP3',
      qualityTier: 'lossy',
      qualityLabel: 'Lossy',
      isM4aContainer: false,
    };
  }

  if (codecUpper.includes('OPUS') || ext === '.opus') {
    return {
      family: 'opus',
      displayCodec: 'Opus',
      containerLabel: containerUpper.includes('OGG') ? 'OGG' : 'Opus',
      qualityTier: 'lossy',
      qualityLabel: 'Lossy',
      isM4aContainer: false,
    };
  }

  if (codecUpper.includes('VORBIS') || ext === '.ogg') {
    return {
      family: 'vorbis',
      displayCodec: 'Vorbis',
      containerLabel: 'OGG',
      qualityTier: 'lossy',
      qualityLabel: 'Lossy',
      isM4aContainer: false,
    };
  }

  if (isM4aContainer) {
    return {
      family: 'unknown',
      displayCodec: codecRaw || 'M4A',
      containerLabel: 'M4A',
      qualityTier: 'unknown',
      qualityLabel: 'Unknown',
      isM4aContainer: true,
    };
  }

  return {
    family: 'unknown',
    displayCodec: codecRaw || containerRaw || 'Unknown',
    containerLabel: containerRaw || null,
    qualityTier: 'unknown',
    qualityLabel: 'Unknown',
    isM4aContainer: false,
  };
}

export function isAlacTrackMetadata(
  track: Pick<TrackRecord, 'codec' | 'container' | 'original_path'>,
): boolean {
  return classifyTrackAudioCodec(track).family === 'alac';
}

const VALID_ALAC_BIT_DEPTHS = new Set([8, 16, 20, 24, 32]);

export function toValidatedAudioPositiveInt(
  value: number | null | undefined,
  maxAllowed = 10_000_000,
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const rounded = Math.round(value);
  if (rounded <= 0 || rounded > maxAllowed) {
    return null;
  }
  return rounded;
}

export interface Mp4ProbeResolutionInput {
  mp4Probe: {
    codec: 'alac' | 'aac' | 'unknown';
    sampleRateHz: number | null;
    bitDepth: number | null;
    channels: number | null;
  };
  parsedCodec: string | null;
  parsedContainer: string | null;
  parsedSampleRateHz: number | null;
  parsedBitDepth: number | null;
  parsedChannels: number | null;
}

export interface Mp4ProbeResolutionOutput {
  codec: string | null;
  container: string | null;
  sampleRateHz: number | null;
  bitDepth: number | null;
  channels: number | null;
}

/**
 * Authoritative shared MP4/M4A metadata resolver used by both MetadataService and AudioAnalyzerService.
 * - For ALAC: verified `ALACSpecificConfig` fields take strict priority over generic MP4/stsd parser fields
 *   (fixing Hi-Res >65.5 kHz sample rates like 88.2/96/176.4/192 kHz that overflow ISO-BMFF 16.16 stsd).
 * - For AAC: enforces `bitDepth = null` (never exposes container-default 16-bit for lossy AAC).
 * - Never fabricates default sample rate (44100/48000), bit depth (16), or channel count (2).
 */
export function resolveMp4AudioMetadataOverride(
  input: Mp4ProbeResolutionInput,
): Mp4ProbeResolutionOutput {
  const probeRate = toValidatedAudioPositiveInt(input.mp4Probe.sampleRateHz, 768_000);
  const probeBitsRaw = toValidatedAudioPositiveInt(input.mp4Probe.bitDepth, 64);
  const probeBits =
    probeBitsRaw !== null && VALID_ALAC_BIT_DEPTHS.has(probeBitsRaw) ? probeBitsRaw : null;
  const probeChannels = toValidatedAudioPositiveInt(input.mp4Probe.channels, 32);

  const parsedRate = toValidatedAudioPositiveInt(input.parsedSampleRateHz, 768_000);
  const parsedBits = toValidatedAudioPositiveInt(input.parsedBitDepth, 64);
  const parsedChannels = toValidatedAudioPositiveInt(input.parsedChannels, 32);

  if (input.mp4Probe.codec === 'alac') {
    const validatedParsedBits =
      parsedBits !== null && VALID_ALAC_BIT_DEPTHS.has(parsedBits) ? parsedBits : null;
    return {
      codec: 'ALAC',
      container: 'M4A',
      sampleRateHz: probeRate ?? parsedRate,
      bitDepth: probeBits ?? validatedParsedBits,
      channels: probeChannels ?? parsedChannels,
    };
  }

  if (
    input.mp4Probe.codec === 'aac' ||
    (input.parsedCodec && /AAC|MP4A/i.test(input.parsedCodec))
  ) {
    return {
      codec: 'AAC',
      container: 'M4A',
      sampleRateHz: parsedRate,
      bitDepth: null,
      channels: parsedChannels,
    };
  }

  return {
    codec: input.parsedCodec,
    container: input.parsedContainer,
    sampleRateHz: parsedRate,
    bitDepth: parsedBits,
    channels: parsedChannels,
  };
}
