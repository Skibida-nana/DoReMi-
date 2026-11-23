import type { TimedLyricEntry, TrackLyricsFormat } from '../types/track';

export interface ParsedLyricsResult {
  format: TrackLyricsFormat;
  timedLines: TimedLyricEntry[];
  plainLines: string[];
}

// Matches [mm:ss], [mm:ss.xx], [mm:ss.xxx], [mm:ss:xx], [hh:mm:ss.xx]
const LRC_TIMESTAMP_GLOBAL = /\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const LRC_OFFSET_TAG = /^\[offset:\s*([+-]?\d+)\s*\]$/i;
const LRC_META_TAG = /^\[(ti|ar|al|au|by|re|ve|length|tool|id|la):.*\]$/i;

function parseFractionToSeconds(rawFraction: string | undefined): number {
  if (!rawFraction) {
    return 0;
  }
  if (rawFraction.length === 1) {
    return Number(rawFraction) / 10;
  }
  if (rawFraction.length === 2) {
    return Number(rawFraction) / 100;
  }
  return Number(rawFraction.slice(0, 3)) / 1000;
}

export interface ParsedLrcResult {
  lines: TimedLyricEntry[];
  offsetMs: number;
}

/**
 * Parses LRC content with full support for:
 * - Multiple timestamps on a single line: `[00:12.50][01:04.20]Chorus`
 * - Standard LRC timestamp variants: `[mm:ss]`, `[mm:ss.xx]`, `[mm:ss.xxx]`, `[mm:ss:xx]`, `[hh:mm:ss.xx]`
 * - `[offset:±ms]` global shift tag (positive offset displays lyrics earlier per LRC spec)
 * - Chronological sorting while keeping relative order for equal timestamps
 */
export function parseLrcContent(rawContent: string): ParsedLrcResult {
  const normalized = rawContent.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rawLines = normalized.split('\n');

  let offsetMs = 0;
  let offsetSec = 0;
  const entries: Array<TimedLyricEntry & { order: number }> = [];
  let orderCounter = 0;

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }

    const offsetMatch = LRC_OFFSET_TAG.exec(trimmed);
    if (offsetMatch) {
      const ms = Number(offsetMatch[1]);
      if (Number.isFinite(ms)) {
        offsetMs = ms;
        offsetSec = ms / 1000;
      }
      continue;
    }

    if (LRC_META_TAG.test(trimmed)) {
      continue;
    }

    LRC_TIMESTAMP_GLOBAL.lastIndex = 0;
    const timestamps: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = LRC_TIMESTAMP_GLOBAL.exec(trimmed)) !== null) {
      const hours = match[1] ? Number(match[1]) : 0;
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);
      const fraction = parseFractionToSeconds(match[4]);

      if (
        Number.isFinite(hours) &&
        Number.isFinite(minutes) &&
        Number.isFinite(seconds) &&
        seconds < 60
      ) {
        // Standard LRC specification: positive [offset:+ms] shifts lyric timestamps earlier
        const totalSec = Math.max(0, hours * 3600 + minutes * 60 + seconds + fraction - offsetSec);
        timestamps.push(Number(totalSec.toFixed(3)));
      }
    }

    if (timestamps.length === 0) {
      continue;
    }

    const lyricText = trimmed.replace(LRC_TIMESTAMP_GLOBAL, '').trim();
    if (!lyricText) {
      continue;
    }

    for (const timeSec of timestamps) {
      entries.push({
        timeSec,
        text: lyricText,
        order: orderCounter++,
      });
    }
  }

  entries.sort((a, b) => (a.timeSec !== b.timeSec ? a.timeSec - b.timeSec : a.order - b.order));
  return {
    lines: entries.map(({ timeSec, text }) => ({ timeSec, text })),
    offsetMs,
  };
}

/**
 * Parses static plain-text lyrics (TXT) preserving intentional line breaks
 * and NEVER fabricating fake timestamps.
 */
export function parsePlainTextLyrics(rawContent: string): string[] {
  const normalized = rawContent.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) {
    return [];
  }
  return normalized.split('\n').map((line) => line.trimEnd());
}

/**
 * Detects whether raw lyrics text contains valid LRC timestamps and parses
 * accordingly, or forces explicit TXT static mode when requested.
 */
export function parseLyricsAuto(
  rawContent: string,
  preferredFormat?: 'lrc' | 'txt',
): ParsedLyricsResult {
  const normalized = rawContent.replace(/^\uFEFF/, '').trim();
  if (!normalized) {
    return { format: 'none', timedLines: [], plainLines: [] };
  }

  if (preferredFormat === 'txt') {
    const plainLines = parsePlainTextLyrics(normalized);
    return plainLines.length > 0
      ? { format: 'txt', timedLines: [], plainLines }
      : { format: 'none', timedLines: [], plainLines: [] };
  }

  const parsedLrc = parseLrcContent(normalized);
  if (parsedLrc.lines.length > 0) {
    return { format: 'lrc', timedLines: parsedLrc.lines, plainLines: [] };
  }

  const plainLines = parsePlainTextLyrics(normalized);
  return plainLines.length > 0
    ? { format: 'txt', timedLines: [], plainLines }
    : { format: 'none', timedLines: [], plainLines: [] };
}

export interface TimedLyricGroup {
  timeSec: number;
  lines: string[];
  firstLineIndex: number;
}

/**
 * Groups consecutive timed lyric lines that share the exact same timestamp
 * (e.g. bilingual Japanese + English lines at `[00:10.00]`) while preserving
 * all lines in their original order and NEVER dropping duplicate timestamps.
 */
export function groupTimedLyricLines(
  timedLines: readonly TimedLyricEntry[],
): TimedLyricGroup[] {
  const groups: TimedLyricGroup[] = [];
  for (let i = 0; i < timedLines.length; i += 1) {
    const entry = timedLines[i];
    const prev = groups[groups.length - 1];
    if (prev && Math.abs(prev.timeSec - entry.timeSec) < 0.001) {
      prev.lines.push(entry.text);
    } else {
      groups.push({
        timeSec: entry.timeSec,
        lines: [entry.text],
        firstLineIndex: i,
      });
    }
  }
  return groups;
}

/**
 * Finds the active timed lyric index for a given playback position in seconds.
 * Returns -1 before the first timestamp.
 */
export function findActiveLyricLineIndex(
  timedLines: readonly TimedLyricEntry[],
  currentTimeSec: number,
): number {
  if (timedLines.length === 0 || !Number.isFinite(currentTimeSec)) {
    return -1;
  }
  let active = -1;
  for (let i = 0; i < timedLines.length; i += 1) {
    if (currentTimeSec + 0.05 >= timedLines[i].timeSec) {
      active = i;
    } else {
      break;
    }
  }
  return active;
}

/**
 * Finds the active timed lyric group index for a given playback position in seconds.
 * Ensures all bilingual lines sharing a timestamp highlight simultaneously.
 */
export function findActiveLyricGroupIndex(
  groups: readonly TimedLyricGroup[],
  currentTimeSec: number,
): number {
  if (groups.length === 0 || !Number.isFinite(currentTimeSec)) {
    return -1;
  }
  let active = -1;
  for (let i = 0; i < groups.length; i += 1) {
    if (currentTimeSec + 0.05 >= groups[i].timeSec) {
      active = i;
    } else {
      break;
    }
  }
  return active;
}
