import path from 'node:path';

const WINDOWS_DRIVE_REGEX = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_REGEX = /^\\\\[^\\]/;

/**
 * Detects whether a path string uses Windows drive or UNC semantics,
 * allowing deterministic Windows normalization testing even on non-Windows hosts.
 */
export function isWindowsStylePath(inputPath: string, platform: NodeJS.Platform = process.platform): boolean {
  return (
    platform === 'win32' ||
    WINDOWS_DRIVE_REGEX.test(inputPath) ||
    WINDOWS_UNC_REGEX.test(inputPath)
  );
}

/**
 * Produces a canonical path key for deduplication in SQLite:
 * - Normalizes Unicode to NFC so Vietnamese diacritics match consistently
 * - Unifies separators and resolves relative segments
 * - On Windows (or Windows drive/UNC paths), lowercases path & drive letter
 *   so C:\Music\Song.FLAC and c:/music/song.flac map to the same record
 * - Preserves distinct folders so two files with the same filename in different folders remain separate tracks
 */
export function normalizeTrackPath(
  rawPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmed = rawPath.trim().normalize('NFC');
  if (!trimmed) {
    throw new Error('File path cannot be empty.');
  }

  if (isWindowsStylePath(trimmed, platform)) {
    const unified = trimmed.replace(/\//g, '\\');
    let normalized = path.win32.normalize(unified);

    // Strip trailing backslash except for drive root (e.g. C:\) or UNC share root
    if (normalized.length > 3 && normalized.endsWith('\\')) {
      normalized = normalized.replace(/\\+$/, '');
    }

    return normalized.toLocaleLowerCase('en-US');
  }

  let normalized = path.posix.normalize(trimmed);
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.replace(/\/+$/, '');
  }

  return normalized;
}

/**
 * Preserves the original filesystem path in NFC Unicode form without altering drive/file casing,
 * suitable for passing directly back to Node fs APIs.
 */
export function cleanOriginalPath(
  rawPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmed = rawPath.trim().normalize('NFC');
  if (isWindowsStylePath(trimmed, platform)) {
    return path.win32.normalize(trimmed.replace(/\//g, '\\'));
  }
  return path.resolve(trimmed);
}

/**
 * Extracts file extension in lowercase (e.g. ".flac") safely for both Windows and POSIX paths.
 */
export function extractFileExtension(filePath: string): string {
  const useWin = isWindowsStylePath(filePath);
  const ext = useWin ? path.win32.extname(filePath) : path.posix.extname(filePath);
  return ext.toLowerCase();
}

/**
 * Fallback track title: file name without its extension.
 */
export function extractFallbackTitle(filePath: string): string {
  const useWin = isWindowsStylePath(filePath);
  const ext = useWin ? path.win32.extname(filePath) : path.posix.extname(filePath);
  const base = useWin ? path.win32.basename(filePath, ext) : path.posix.basename(filePath, ext);
  return base.normalize('NFC').trim() || 'Unknown Title';
}
