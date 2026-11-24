import fs from 'node:fs/promises';
import { parseFile } from 'music-metadata';
import type { ParsedTrackMetadata } from '../../shared/types/track';
import { extractReplayGainFromMetadata } from '../../shared/utils/replaygain';
import { detectMp4AudioCodec } from './alac-decoder';
import { extractFallbackTitle, extractFileExtension } from './path-utils';

export class MetadataReadError extends Error {
  constructor(
    public readonly filePath: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MetadataReadError';
  }
}

function toNullablePositiveInt(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.round(value);
}

function toNullableDurationMs(seconds: number | undefined): number | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return Math.round(seconds * 1000);
}

function cleanOptionalText(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.normalize('NFC').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeEmbeddedLyrics(rawLyrics: unknown): string | null {
  if (!Array.isArray(rawLyrics) || rawLyrics.length === 0) {
    return null;
  }

  const parts: string[] = [];
  for (const entry of rawLyrics) {
    if (typeof entry === 'string') {
      const cleaned = entry.trim();
      if (cleaned.length > 0) {
        parts.push(cleaned);
      }
      continue;
    }

    if (entry && typeof entry === 'object') {
      const candidate = entry as {
        text?: unknown;
        syncText?: Array<{ text?: unknown; timestamp?: unknown }>;
      };

      if (Array.isArray(candidate.syncText) && candidate.syncText.length > 0) {
        const syncedLines: string[] = [];
        for (const item of candidate.syncText) {
          const lineText = typeof item?.text === 'string' ? item.text.trim() : '';
          const tsMs = typeof item?.timestamp === 'number' && Number.isFinite(item.timestamp)
            ? Math.max(0, item.timestamp)
            : null;
          if (tsMs !== null) {
            const totalSec = tsMs / 1000;
            const mins = Math.floor(totalSec / 60);
            const secs = (totalSec - mins * 60).toFixed(2).padStart(5, '0');
            syncedLines.push(`[${String(mins).padStart(2, '0')}:${secs}]${lineText}`);
          } else if (lineText.length > 0) {
            syncedLines.push(lineText);
          }
        }
        if (syncedLines.length > 0) {
          parts.push(syncedLines.join('\n'));
          continue;
        }
      }

      if (typeof candidate.text === 'string' && candidate.text.trim().length > 0) {
        parts.push(candidate.text.trim());
      }
    }
  }

  if (parts.length === 0) {
    return null;
  }
  return parts.join('\n\n').replace(/^\uFEFF/, '');
}

function toNullableYear(rawYear: number | undefined, rawDate: string | undefined): number | null {
  if (typeof rawYear === 'number' && Number.isInteger(rawYear) && rawYear >= 1000 && rawYear <= 2999) {
    return rawYear;
  }
  if (typeof rawDate === 'string') {
    const match = rawDate.match(/\b(1\d{3}|2\d{3})\b/);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
}

export interface ExtractedEmbeddedArtwork {
  data: Buffer;
  mime: string;
}

/**
 * Reads audio metadata from a local file in read-only mode using music-metadata.
 * - Never modifies, moves, copies, or deletes the source file.
 * - Uses filename (without extension) if title is missing.
 * - Uses "Unknown Artist" if artist is missing.
 * - Never guesses technical specs (sample rate, bit depth, bitrate, duration): leaves them NULL if unreadable.
 */
export async function readTrackMetadata(filePath: string): Promise<ParsedTrackMetadata> {
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch (error) {
    throw new MetadataReadError(
      filePath,
      `Không thể truy cập file: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }

  if (!stats.isFile()) {
    throw new MetadataReadError(filePath, 'Đường dẫn không phải là một tập tin hợp lệ.');
  }

  const fallbackTitle = extractFallbackTitle(filePath);
  const ext = extractFileExtension(filePath);
  const fallbackContainer = ext ? ext.slice(1).toUpperCase() : null;

  try {
    const metadata = await parseFile(filePath, {
      duration: true,
      skipCovers: true,
      skipPostHeaders: false,
    });

    const title = cleanOptionalText(metadata.common.title) ?? fallbackTitle;
    const artist =
      cleanOptionalText(metadata.common.artist) ??
      cleanOptionalText(metadata.common.artists?.[0]) ??
      'Unknown Artist';
    const album = cleanOptionalText(metadata.common.album);
    const year = toNullableYear(metadata.common.year, metadata.common.date);
    const embeddedLyrics = normalizeEmbeddedLyrics(metadata.common.lyrics);

    let codec = cleanOptionalText(metadata.format.codec);
    let container = cleanOptionalText(metadata.format.container) ?? fallbackContainer;
    const durationMs = toNullableDurationMs(metadata.format.duration);
    let sampleRateHz = toNullablePositiveInt(metadata.format.sampleRate);
    let bitDepth = toNullablePositiveInt(metadata.format.bitsPerSample);
    const bitrateBps = toNullablePositiveInt(metadata.format.bitrate);
    const rg = extractReplayGainFromMetadata(metadata);

    // For M4A/MP4 containers, inspect real ISO-BMFF `stsd` boxes so ALAC (Lossless, including
    // >65.5kHz high-res sample rates that overflow MP4 16.16 stsd fields) and AAC (Lossy, no
    // PCM bit depth) are always classified accurately without guessing from file extension.
    if (ext === '.m4a' || ext === '.mp4') {
      const mp4Probe = await detectMp4AudioCodec(filePath);
      if (mp4Probe.codec === 'alac') {
        codec = 'ALAC';
        container = 'M4A';
        if (!sampleRateHz && mp4Probe.sampleRateHz) {
          sampleRateHz = mp4Probe.sampleRateHz;
        }
        if (!bitDepth && mp4Probe.bitDepth) {
          bitDepth = mp4Probe.bitDepth;
        }
      } else if (mp4Probe.codec === 'aac') {
        codec = 'AAC';
        container = 'M4A';
        // Lossy AAC does not have a PCM bit depth (music-metadata reports container default 16)
        bitDepth = null;
      } else if (codec && /AAC|MP4A/i.test(codec)) {
        codec = 'AAC';
        container = 'M4A';
        bitDepth = null;
      }
    }

    return {
      title,
      artist,
      album,
      year,
      embedded_lyrics: embeddedLyrics,
      duration_ms: durationMs,
      codec,
      container,
      sample_rate_hz: sampleRateHz,
      bit_depth: bitDepth,
      bitrate_bps: bitrateBps,
      file_size_bytes: stats.size,
      modified_at_ms: Math.round(stats.mtimeMs),
      replaygain_track_gain_db: rg.trackGainDb,
      replaygain_album_gain_db: rg.albumGainDb,
      replaygain_track_peak: rg.trackPeak,
      replaygain_album_peak: rg.albumPeak,
    };
  } catch (error) {
    throw new MetadataReadError(
      filePath,
      `Không thể đọc metadata âm thanh: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/**
 * Extracts the primary embedded artwork (front cover preferred) from an audio file in read-only mode.
 */
export async function readEmbeddedArtwork(
  filePath: string,
): Promise<ExtractedEmbeddedArtwork | null> {
  try {
    const metadata = await parseFile(filePath, {
      duration: false,
      skipCovers: false,
      skipPostHeaders: false,
    });

    const pictures = metadata.common.picture;
    if (!Array.isArray(pictures) || pictures.length === 0) {
      return null;
    }

    const preferred =
      pictures.find((pic) => /front/i.test(pic.type ?? '')) ?? pictures[0];
    if (!preferred || !preferred.data || preferred.data.length === 0) {
      return null;
    }

    return {
      data: Buffer.from(preferred.data),
      mime: preferred.format || 'image/jpeg',
    };
  } catch {
    return null;
  }
}

/**
 * Lazily reads embedded lyrics from an existing audio file in read-only mode.
 */
export async function readEmbeddedLyrics(filePath: string): Promise<string | null> {
  try {
    const metadata = await parseFile(filePath, {
      duration: false,
      skipCovers: true,
      skipPostHeaders: false,
    });
    return normalizeEmbeddedLyrics(metadata.common.lyrics);
  } catch {
    return null;
  }
}
