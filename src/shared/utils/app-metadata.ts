import type { AppReleaseChannel, AppRuntimeInfo } from '../types/library';

export const DOREMI_PRODUCT_NAME = 'DoReMi';
export const DOREMI_PRODUCT_SUBTITLE = 'Offline Windows Hi-Res Audio Player';
export const DOREMI_DEVELOPER_HANDLE = 'kamisamao';
export const DOREMI_DESIGN_SLOGAN = 'Built with passion. Designed for music lovers.';
export const DOREMI_ALAC_DECODER_LABEL = '@mgz-dev/alac (WASM) · v0.1.1';
export const DOREMI_ALAC_DECODER_VERSION = '0.1.1';

/**
 * Derives the display release channel dynamically from `app.getVersion()`
 * so About / docs never drift from `package.json`.
 */
export function resolveReleaseChannel(version: string): AppReleaseChannel {
  const normalized = (version || '').trim().toLowerCase();
  if (normalized.includes('-rc.') || normalized.endsWith('-rc')) {
    return 'Release Candidate';
  }
  if (normalized.includes('-beta')) {
    return 'Beta';
  }
  if (normalized.includes('-alpha') || normalized.includes('-dev')) {
    return 'Development';
  }
  return 'Stable';
}

export function formatReleaseChannelBadge(channel: AppReleaseChannel): string {
  switch (channel) {
    case 'Release Candidate':
      return 'Release Candidate (UAT)';
    case 'Beta':
      return 'Beta';
    case 'Development':
      return 'Development';
    default:
      return 'Stable';
  }
}

export function formatOperatingPlatformLabel(
  info: Pick<AppRuntimeInfo, 'platform' | 'arch' | 'osRelease'>,
): string {
  const osName =
    info.platform === 'win32'
      ? 'Windows'
      : info.platform === 'darwin'
        ? 'macOS'
        : info.platform === 'linux'
          ? 'Linux'
          : info.platform;
  const archPart = info.arch ? ` (${info.arch})` : '';
  const releasePart = info.osRelease ? ` · Kernel/Build ${info.osRelease}` : '';
  return `${osName}${archPart}${releasePart}`;
}
