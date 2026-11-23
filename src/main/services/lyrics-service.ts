import fs from 'node:fs/promises';
import path from 'node:path';
import type { LyricsEncodingOption } from '../../shared/types/stage5';
import type { ResolvedTrackLyrics } from '../../shared/types/track';
import { decodeLyricsBuffer } from '../../shared/utils/lyrics-encoding';
import {
  parseLrcContent,
  parseLyricsAuto,
  parsePlainTextLyrics,
} from '../../shared/utils/lyrics-parser';
import type { LyricsRepository } from '../database/lyrics-repository';
import type { TrackRepository } from '../database/track-repository';
import { readEmbeddedLyrics } from './metadata-service';

const MAX_LYRICS_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

export interface LyricsServiceOptions {
  trackRepo: TrackRepository;
  lyricsRepo: LyricsRepository;
}

/**
 * Finds a sidecar `.lrc` file in the same directory with the exact same basename
 * as the audio file (case-insensitive matching for cross-platform safety).
 */
export async function findSidecarLrcPath(audioFilePath: string): Promise<string | null> {
  const dir = path.dirname(audioFilePath);
  const ext = path.extname(audioFilePath);
  const baseName = path.basename(audioFilePath, ext);
  const expectedLower = `${baseName}.lrc`.toLowerCase();

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  const matched = entries.find((entry) => entry.toLowerCase() === expectedLower);
  if (!matched) {
    return null;
  }

  const fullPath = path.join(dir, matched);
  try {
    const stat = await fs.stat(fullPath);
    if (stat.isFile() && stat.size > 0 && stat.size <= MAX_LYRICS_FILE_BYTES) {
      return fullPath;
    }
  } catch {
    return null;
  }

  return null;
}

function buildEmptyLyrics(trackId: string, sidecarPath: string | null = null): ResolvedTrackLyrics {
  return {
    trackId,
    source: 'none',
    format: 'none',
    rawContent: '',
    timedLines: [],
    plainLines: [],
    hasCustomLyrics: false,
    sidecarPath,
  };
}

export class LyricsService {
  private readonly trackRepo: TrackRepository;
  private readonly lyricsRepo: LyricsRepository;

  constructor(options: LyricsServiceOptions) {
    this.trackRepo = options.trackRepo;
    this.lyricsRepo = options.lyricsRepo;
  }

  /**
   * Resolves effective lyrics strictly following M3.3 + M5.7 priority:
   * 1. Custom lyrics saved by user in SQLite (LRC or TXT, full Unicode)
   * 2. Sidecar .lrc file with same basename in track directory (UTF-8 / BOM / UTF-16 / CJK auto-decoded)
   * 3. Embedded lyrics inside audio metadata (read-only)
   * 4. Empty state ('none')
   */
  async resolveTrackLyrics(trackId: string): Promise<ResolvedTrackLyrics> {
    const track = this.trackRepo.findById(trackId);
    if (!track) {
      return buildEmptyLyrics(trackId);
    }

    const row = this.lyricsRepo.findByTrackId(trackId);
    const sidecarPath = await findSidecarLrcPath(track.original_path);

    // Priority 1: Custom user lyrics
    if (row?.custom_content !== null && row?.custom_content !== undefined && row.custom_format) {
      const content = row.custom_content.replace(/^\uFEFF/, '');
      if (row.custom_format === 'lrc') {
        const parsed = parseLrcContent(content);
        if (parsed.lines.length > 0) {
          return {
            trackId,
            source: 'custom',
            format: 'lrc',
            rawContent: content,
            timedLines: parsed.lines,
            plainLines: parsed.lines.map((l) => l.text),
            hasCustomLyrics: true,
            sidecarPath,
          };
        }
      }

      const plainLines = parsePlainTextLyrics(content);
      return {
        trackId,
        source: 'custom',
        format: plainLines.length > 0 ? 'txt' : 'none',
        rawContent: content,
        timedLines: [],
        plainLines,
        hasCustomLyrics: true,
        sidecarPath,
      };
    }

    // Priority 2: Sidecar .lrc in same folder (BOM + UTF-8/UTF-16 + CJK safe decoding)
    if (sidecarPath) {
      try {
        const rawBytes = await fs.readFile(sidecarPath);
        const decoded = decodeLyricsBuffer(rawBytes, 'auto');
        const raw = decoded.text;
        const parsedLrc = parseLrcContent(raw);
        if (parsedLrc.lines.length > 0) {
          return {
            trackId,
            source: 'sidecar',
            format: 'lrc',
            rawContent: raw,
            timedLines: parsedLrc.lines,
            plainLines: parsedLrc.lines.map((l) => l.text),
            hasCustomLyrics: false,
            sidecarPath,
          };
        }
        const plain = parsePlainTextLyrics(raw);
        if (plain.length > 0) {
          return {
            trackId,
            source: 'sidecar',
            format: 'txt',
            rawContent: raw,
            timedLines: [],
            plainLines: plain,
            hasCustomLyrics: false,
            sidecarPath,
          };
        }
      } catch {
        // Fall through to embedded lyrics if sidecar is unreadable or undecodable
      }
    }

    // Priority 3: Embedded metadata lyrics (DB cached, or lazily extracted once for existing tracks)
    let embeddedContent = row?.embedded_content ?? null;
    if (embeddedContent === null && row === null && track.status !== 'missing') {
      embeddedContent = await readEmbeddedLyrics(track.original_path);
      this.lyricsRepo.setEmbeddedLyrics(trackId, embeddedContent);
    }

    if (embeddedContent && embeddedContent.trim().length > 0) {
      const parsed = parseLyricsAuto(embeddedContent);
      return {
        trackId,
        source: parsed.format === 'none' ? 'none' : 'embedded',
        format: parsed.format,
        rawContent: embeddedContent,
        timedLines: parsed.timedLines,
        plainLines: parsed.plainLines,
        hasCustomLyrics: false,
        sidecarPath,
      };
    }

    // Priority 4: Empty state
    return buildEmptyLyrics(trackId, sidecarPath);
  }

  /**
   * Imports a local `.lrc` or `.txt` file as custom lyrics in SQLite (never modifies source audio).
   * Uses strict encoding detection (UTF-8, UTF-8 BOM, UTF-16 LE/BE, Shift-JIS, GB18030, EUC-KR, Big5)
   * and throws a clear error instead of saving corrupted mojibake.
   */
  async importCustomLyricsFromFile(
    trackId: string,
    filePath: string,
    preferredEncoding: LyricsEncodingOption = 'auto',
  ): Promise<ResolvedTrackLyrics & { detectedEncoding: string }> {
    const track = this.trackRepo.findById(trackId);
    if (!track) {
      throw new Error('Không tìm thấy bài hát trong cơ sở dữ liệu.');
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.lrc' && ext !== '.txt') {
      throw new Error('Chỉ hỗ trợ nhập file lời bài hát định dạng .lrc hoặc .txt.');
    }

    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_LYRICS_FILE_BYTES) {
      throw new Error('File lời bài hát không hợp lệ hoặc vượt quá giới hạn 2MB.');
    }

    const rawBytes = await fs.readFile(filePath);
    const decoded = decodeLyricsBuffer(rawBytes, preferredEncoding);
    const raw = decoded.text;
    if (raw.trim().length === 0) {
      throw new Error('File lời bài hát đang trống.');
    }

    // Strictly respect .txt as non-synced plain text; for .lrc verify timestamps exist
    const format: 'lrc' | 'txt' =
      ext === '.lrc' && parseLrcContent(raw).lines.length > 0 ? 'lrc' : 'txt';

    this.lyricsRepo.setCustomLyrics(trackId, format, raw);
    const resolved = await this.resolveTrackLyrics(trackId);
    return {
      ...resolved,
      detectedEncoding: decoded.detectedEncoding,
    };
  }

  /**
   * Saves custom lyrics entered or edited inside DoReMi into SQLite.
   */
  async saveCustomLyrics(
    trackId: string,
    format: 'lrc' | 'txt',
    content: string,
  ): Promise<ResolvedTrackLyrics> {
    const track = this.trackRepo.findById(trackId);
    if (!track) {
      throw new Error('Không tìm thấy bài hát trong cơ sở dữ liệu.');
    }

    const cleaned = content.replace(/^\uFEFF/, '');
    if (cleaned.trim().length === 0) {
      this.lyricsRepo.clearCustomLyrics(trackId);
      return this.resolveTrackLyrics(trackId);
    }

    const effectiveFormat: 'lrc' | 'txt' =
      format === 'lrc' && parseLrcContent(cleaned).lines.length > 0 ? 'lrc' : 'txt';

    this.lyricsRepo.setCustomLyrics(trackId, effectiveFormat, cleaned);
    return this.resolveTrackLyrics(trackId);
  }

  /**
   * Removes user custom lyrics and automatically falls back to sidecar .lrc / embedded / empty.
   */
  async removeCustomLyrics(trackId: string): Promise<ResolvedTrackLyrics> {
    this.lyricsRepo.clearCustomLyrics(trackId);
    return this.resolveTrackLyrics(trackId);
  }
}
