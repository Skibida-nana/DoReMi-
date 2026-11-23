import path from 'node:path';

export const APP_DISPLAY_NAME = 'DoReMi';
export const LEGACY_PACKAGED_USER_DATA_DIR = 'Lossless Player';
export const LEGACY_DEV_USER_DATA_DIR = 'lossless-player';

export interface ResolveUserDataPathInput {
  isPackaged: boolean;
  appDataPath: string;
  currentUserDataPath: string;
}

export interface ResolveUserDataPathResult {
  targetUserDataPath: string;
  shouldOverride: boolean;
  reason: string;
}

/**
 * Ensures renaming the packaged display/product name to "DoReMi" never changes
 * Electron's userData directory away from the existing SQLite database and
 * Chromium localStorage directory.
 *
 * - Development runs (`npm run dev`, isPackaged = false) keep their existing
 *   package-name directory (`%APPDATA%\lossless-player`).
 * - Packaged Windows builds (`isPackaged = true`) stay pinned to the legacy
 *   `%APPDATA%\Lossless Player` directory so library.db, playlists, favorites,
 *   queue, listening history, and settings remain intact without creating an
 *   empty `%APPDATA%\DoReMi` folder.
 */
export function resolveSafeUserDataPath(
  input: ResolveUserDataPathInput,
): ResolveUserDataPathResult {
  if (!input.isPackaged) {
    return {
      targetUserDataPath: input.currentUserDataPath,
      shouldOverride: false,
      reason: 'Development mode preserves existing package-name userData path.',
    };
  }

  const legacyPath = path.join(input.appDataPath, LEGACY_PACKAGED_USER_DATA_DIR);
  const normalizedCurrent = path.resolve(input.currentUserDataPath).toLowerCase();
  const normalizedLegacy = path.resolve(legacyPath).toLowerCase();

  if (normalizedCurrent === normalizedLegacy) {
    return {
      targetUserDataPath: legacyPath,
      shouldOverride: false,
      reason: 'Packaged userData already points to legacy Lossless Player directory.',
    };
  }

  return {
    targetUserDataPath: legacyPath,
    shouldOverride: true,
    reason:
      'Pinned packaged userData to legacy Lossless Player directory to preserve SQLite library and settings after rename to DoReMi.',
  };
}
