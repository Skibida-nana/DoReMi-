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
