import path from 'node:path';
import { isAudioExtensionSupported } from '../../shared/contracts/media-protocol';
import { cleanOriginalPath, extractFileExtension } from '../services/path-utils';

/**
 * Extracts verified, supported audio file paths from Electron command-line argv
 * (initial Windows Explorer Open With launch or `second-instance` event).
 *
 * Security & Unicode guarantees:
 * - Never splits arguments by whitespace (Windows passes each full path as one argv item).
 * - Preserves Vietnamese diacritics, CJK characters, spaces, and UNC/drive paths in NFC.
 * - Rejects null bytes, CLI flags (`--*`, `-*`), URLs (`http://`, `file://` except local file),
 *   Electron executable/app script paths, and unsupported file extensions.
 * - Never executes shell commands.
 */
export function extractAudioFilePathsFromArgv(
  argv: readonly string[],
  options: {
    isPackaged: boolean;
    platform?: NodeJS.Platform;
  },
): string[] {
  const platform = options.platform ?? process.platform;
  // In packaged Electron apps: argv[0] is DoReMi.exe, argv[1..] are user arguments.
  // In dev Electron apps: argv[0] is electron.exe, argv[1] is app entry path ('.' or out/main/index.js).
  const startIndex = options.isPackaged ? 1 : 2;
  const results: string[] = [];
  const seen = new Set<string>();

  for (let i = startIndex; i < argv.length; i += 1) {
    const rawArg = argv[i];
    if (typeof rawArg !== 'string') {
      continue;
    }

    const trimmed = rawArg.trim();
    if (!trimmed || trimmed.includes('\0')) {
      continue;
    }

    // Ignore Chromium / Electron switches and flags
    if (trimmed.startsWith('-')) {
      continue;
    }

    // Strip matching outer quotes if any shell wrapper passed them literally
    const unquoted =
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
        ? trimmed.slice(1, -1).trim()
        : trimmed;

    if (!unquoted || unquoted === '.' || unquoted === '..') {
      continue;
    }

    // Reject network or arbitrary URI schemes
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(unquoted)) {
      continue;
    }

    const cleaned = cleanOriginalPath(unquoted, platform);
    const ext = extractFileExtension(cleaned);
    if (!isAudioExtensionSupported(ext)) {
      continue;
    }

    // Require an absolute path (Windows drive C:\..., UNC \\server\..., or POSIX /...)
    const isAbsolute =
      platform === 'win32'
        ? path.win32.isAbsolute(cleaned)
        : path.isAbsolute(cleaned);
    if (!isAbsolute) {
      continue;
    }

    const dedupeKey = platform === 'win32' ? cleaned.toLowerCase() : cleaned;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    results.push(cleaned);
  }

  return results;
}
