export const MEDIA_PROTOCOL_SCHEME = 'lossless-media';
export const MEDIA_PROTOCOL_HOST = 'track';
export const MEDIA_ARTWORK_HOST = 'artwork';
export const MEDIA_PROFILE_HOST = 'profile';
export const MEDIA_PLAYLIST_HOST = 'playlist';
export const MEDIA_REMOTE_TRACK_HOST = 'remote-track';
export const MEDIA_REMOTE_ARTWORK_HOST = 'remote-artwork';

export type ArtworkSizeVariant = 'full' | 'thumb';
export type ProfileMediaKind = 'avatar' | 'background' | 'font';
export const EDITORIAL_FONT_ID_REGEX = /^[a-z0-9_-]{4,48}$/i;

// Standard UUID pattern (case-insensitive hex, 8-4-4-4-12)
export const TRACK_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Formats explicitly verified in Phase 1 mandatory test scope.
 */
export const MANDATORY_AUDIO_EXTENSIONS = ['.flac', '.mp3', '.wav'] as const;

/**
 * Additional Chromium-supported audio containers allowed on a best-effort basis.
 * If Chromium cannot decode a specific codec (for example ALAC inside M4A),
 * the AudioEngine reports a clear error without crashing.
 */
export const OPTIONAL_AUDIO_EXTENSIONS = ['.m4a', '.aac', '.ogg', '.opus'] as const;

export const SUPPORTED_AUDIO_EXTENSIONS: readonly string[] = [
  ...MANDATORY_AUDIO_EXTENSIONS,
  ...OPTIONAL_AUDIO_EXTENSIONS,
];

const MIME_BY_EXTENSION: Record<string, string> = {
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg; codecs=opus',
};

export function isValidTrackUuid(value: unknown): value is string {
  return typeof value === 'string' && TRACK_UUID_REGEX.test(value);
}

export function buildTrackMediaUrl(trackId: string): string {
  if (!isValidTrackUuid(trackId)) {
    throw new Error(`Invalid track UUID: ${String(trackId)}`);
  }
  return `${MEDIA_PROTOCOL_SCHEME}://${MEDIA_PROTOCOL_HOST}/${trackId}`;
}

/**
 * Strictly extracts a track UUID from a lossless-media://track/<uuid> URL.
 * Rejects path traversal segments, arbitrary file paths, extra path components,
 * encoded slashes, or non-UUID identifiers.
 */
export function parseTrackIdFromMediaUrl(rawUrl: string): string | null {
  if (typeof rawUrl !== 'string' || rawUrl.length > 128) {
    return null;
  }

  // Reject any raw traversal tokens or encoded slashes before URL normalization
  if (
    rawUrl.includes('..') ||
    rawUrl.includes('\\') ||
    /%2f|%5c|%00/i.test(rawUrl)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== `${MEDIA_PROTOCOL_SCHEME}:`) {
    return null;
  }
  if (parsed.hostname !== MEDIA_PROTOCOL_HOST) {
    return null;
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password || parsed.port) {
    return null;
  }

  const pathname = parsed.pathname;
  if (!pathname.startsWith('/')) {
    return null;
  }

  const candidate = pathname.slice(1);
  if (candidate.includes('/') || !isValidTrackUuid(candidate)) {
    return null;
  }

  return candidate.toLowerCase();
}

export function buildTrackArtworkUrl(
  trackId: string,
  size: ArtworkSizeVariant = 'full',
  versionHash?: string | null,
): string {
  if (!isValidTrackUuid(trackId)) {
    throw new Error(`Invalid track UUID: ${String(trackId)}`);
  }
  const params = new URLSearchParams({ size });
  if (versionHash && /^[0-9a-f]{4,64}$/i.test(versionHash)) {
    params.set('v', versionHash.slice(0, 16));
  }
  return `${MEDIA_PROTOCOL_SCHEME}://${MEDIA_ARTWORK_HOST}/${trackId.toLowerCase()}?${params.toString()}`;
}

export interface ParsedArtworkMediaRequest {
  trackId: string;
  size: ArtworkSizeVariant;
  hasVersionToken: boolean;
}

/**
 * Strictly extracts track UUID and size variant from `lossless-media://artwork/<uuid>?size=full|thumb&v=<hash>`.
 * Rejects path traversal, arbitrary paths, invalid UUIDs, or unsupported size parameters.
 */
export function parseArtworkRequestFromMediaUrl(
  rawUrl: string,
): ParsedArtworkMediaRequest | null {
  if (typeof rawUrl !== 'string' || rawUrl.length > 200) {
    return null;
  }

  if (
    rawUrl.includes('..') ||
    rawUrl.includes('\\') ||
    /%2f|%5c|%00/i.test(rawUrl)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== `${MEDIA_PROTOCOL_SCHEME}:`) {
    return null;
  }
  if (parsed.hostname !== MEDIA_ARTWORK_HOST) {
    return null;
  }
  if (parsed.hash || parsed.username || parsed.password || parsed.port) {
    return null;
  }

  const pathname = parsed.pathname;
  if (!pathname.startsWith('/')) {
    return null;
  }

  const candidate = pathname.slice(1);
  if (candidate.includes('/') || !isValidTrackUuid(candidate)) {
    return null;
  }

  const rawSize = parsed.searchParams.get('size');
  let size: ArtworkSizeVariant = 'full';
  if (rawSize !== null) {
    if (rawSize !== 'full' && rawSize !== 'thumb') {
      return null;
    }
    size = rawSize;
  }

  const rawVersion = parsed.searchParams.get('v');
  const hasVersionToken = Boolean(rawVersion && /^[0-9a-f]{4,64}$/i.test(rawVersion));

  return {
    trackId: candidate.toLowerCase(),
    size,
    hasVersionToken,
  };
}

export function isAudioExtensionSupported(extension: string): boolean {
  return SUPPORTED_AUDIO_EXTENSIONS.includes(extension.toLowerCase());
}

export function isMandatoryAudioExtension(extension: string): boolean {
  return (MANDATORY_AUDIO_EXTENSIONS as readonly string[]).includes(
    extension.toLowerCase(),
  );
}

export function getMimeTypeForExtension(extension: string): string {
  return MIME_BY_EXTENSION[extension.toLowerCase()] ?? 'application/octet-stream';
}

export function buildProfileMediaUrl(
  kind: 'avatar' | 'background',
  versionHash?: string | null,
): string {
  const params = new URLSearchParams();
  if (versionHash && /^[0-9a-f]{4,64}$/i.test(versionHash)) {
    params.set('v', versionHash.slice(0, 16));
  }
  const query = params.toString();
  return `${MEDIA_PROTOCOL_SCHEME}://${MEDIA_PROFILE_HOST}/${kind}${query ? `?${query}` : ''}`;
}

export function buildEditorialFontMediaUrl(
  fontId: string,
  versionHash?: string | null,
): string {
  if (!EDITORIAL_FONT_ID_REGEX.test(fontId)) {
    throw new Error(`Invalid editorial font ID: ${String(fontId)}`);
  }
  const params = new URLSearchParams();
  if (versionHash && /^[0-9a-f]{4,64}$/i.test(versionHash)) {
    params.set('v', versionHash.slice(0, 16));
  }
  const query = params.toString();
  return `${MEDIA_PROTOCOL_SCHEME}://${MEDIA_PROFILE_HOST}/font/${fontId.toLowerCase()}${query ? `?${query}` : ''}`;
}

export interface ParsedProfileMediaRequest {
  kind: ProfileMediaKind;
  fontId?: string;
  hasVersionToken: boolean;
}

export function parseProfileMediaRequest(rawUrl: string): ParsedProfileMediaRequest | null {
  if (typeof rawUrl !== 'string' || rawUrl.length > 220) {
    return null;
  }
  if (
    rawUrl.includes('..') ||
    rawUrl.includes('\\') ||
    /%2f|%5c|%00/i.test(rawUrl)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== `${MEDIA_PROTOCOL_SCHEME}:`) {
    return null;
  }
  if (parsed.hostname !== MEDIA_PROFILE_HOST) {
    return null;
  }
  if (parsed.hash || parsed.username || parsed.password || parsed.port) {
    return null;
  }

  const candidate = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
  const rawVersion = parsed.searchParams.get('v');
  const hasVersionToken = Boolean(rawVersion && /^[0-9a-f]{4,64}$/i.test(rawVersion));

  if (candidate === 'avatar' || candidate === 'background') {
    return {
      kind: candidate,
      hasVersionToken,
    };
  }

  if (candidate.startsWith('font/')) {
    const fontId = candidate.slice('font/'.length);
    if (!fontId || fontId.includes('/') || !EDITORIAL_FONT_ID_REGEX.test(fontId)) {
      return null;
    }
    return {
      kind: 'font',
      fontId: fontId.toLowerCase(),
      hasVersionToken,
    };
  }

  return null;
}

export function buildPlaylistArtworkUrl(
  playlistId: string,
  versionHash?: string | null,
): string {
  if (!isValidTrackUuid(playlistId)) {
    throw new Error(`Invalid playlist UUID: ${String(playlistId)}`);
  }
  const params = new URLSearchParams();
  if (versionHash && /^[0-9a-f]{4,64}$/i.test(versionHash)) {
    params.set('v', versionHash.slice(0, 16));
  }
  const query = params.toString();
  return `${MEDIA_PROTOCOL_SCHEME}://${MEDIA_PLAYLIST_HOST}/${playlistId.toLowerCase()}${query ? `?${query}` : ''}`;
}

export interface ParsedPlaylistArtworkRequest {
  playlistId: string;
  hasVersionToken: boolean;
}

export function parsePlaylistArtworkRequestFromMediaUrl(
  rawUrl: string,
): ParsedPlaylistArtworkRequest | null {
  if (typeof rawUrl !== 'string' || rawUrl.length > 200) {
    return null;
  }
  if (
    rawUrl.includes('..') ||
    rawUrl.includes('\\') ||
    /%2f|%5c|%00/i.test(rawUrl)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== `${MEDIA_PROTOCOL_SCHEME}:`) {
    return null;
  }
  if (parsed.hostname !== MEDIA_PLAYLIST_HOST) {
    return null;
  }
  if (parsed.hash || parsed.username || parsed.password || parsed.port) {
    return null;
  }

  const candidate = parsed.pathname.startsWith('/')
    ? parsed.pathname.slice(1)
    : parsed.pathname;
  if (candidate.includes('/') || !isValidTrackUuid(candidate)) {
    return null;
  }

  const rawVersion = parsed.searchParams.get('v');
  const hasVersionToken = Boolean(rawVersion && /^[0-9a-f]{4,64}$/i.test(rawVersion));

  return {
    playlistId: candidate.toLowerCase(),
    hasVersionToken,
  };
}

export interface ParsedRemoteTrackMediaRequest {
  hostId: string;
  trackId: string;
}

export interface ParsedRemoteArtworkMediaRequest {
  hostId: string;
  trackId: string;
  size: ArtworkSizeVariant;
  hasVersionToken: boolean;
}

export function buildRemoteTrackMediaUrl(hostId: string, trackId: string): string {
  if (!isValidTrackUuid(hostId) || !isValidTrackUuid(trackId)) {
    throw new Error(`Invalid remote track media identifier: ${String(hostId)}/${String(trackId)}`);
  }
  return `${MEDIA_PROTOCOL_SCHEME}://${MEDIA_REMOTE_TRACK_HOST}/${hostId.toLowerCase()}/${trackId.toLowerCase()}`;
}

export function parseRemoteTrackMediaUrl(rawUrl: string): ParsedRemoteTrackMediaRequest | null {
  if (typeof rawUrl !== 'string' || rawUrl.length > 180) {
    return null;
  }
  if (
    rawUrl.includes('..') ||
    rawUrl.includes('\\') ||
    /%2f|%5c|%00/i.test(rawUrl)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== `${MEDIA_PROTOCOL_SCHEME}:` ||
    parsed.hostname !== MEDIA_REMOTE_TRACK_HOST ||
    parsed.hash ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    return null;
  }

  if (parsed.search) {
    for (const [key, val] of parsed.searchParams.entries()) {
      if (key !== 'ho' || !/^[0-9]{1,9}$/.test(val)) {
        return null;
      }
    }
  }

  const parts = parsed.pathname.slice(1).split('/');
  if (parts.length !== 2 || !isValidTrackUuid(parts[0]) || !isValidTrackUuid(parts[1])) {
    return null;
  }

  return {
    hostId: parts[0].toLowerCase(),
    trackId: parts[1].toLowerCase(),
  };
}

export function buildRemoteArtworkMediaUrl(
  hostId: string,
  trackId: string,
  size: ArtworkSizeVariant = 'full',
  versionHash?: string | null,
): string {
  if (!isValidTrackUuid(hostId) || !isValidTrackUuid(trackId)) {
    throw new Error(`Invalid remote artwork identifier: ${String(hostId)}/${String(trackId)}`);
  }
  const params = new URLSearchParams({ size });
  if (versionHash && /^[0-9a-f]{4,64}$/i.test(versionHash)) {
    params.set('v', versionHash.slice(0, 16));
  }
  return `${MEDIA_PROTOCOL_SCHEME}://${MEDIA_REMOTE_ARTWORK_HOST}/${hostId.toLowerCase()}/${trackId.toLowerCase()}?${params.toString()}`;
}

export function parseRemoteArtworkMediaUrl(rawUrl: string): ParsedRemoteArtworkMediaRequest | null {
  if (typeof rawUrl !== 'string' || rawUrl.length > 240) {
    return null;
  }
  if (
    rawUrl.includes('..') ||
    rawUrl.includes('\\') ||
    /%2f|%5c|%00/i.test(rawUrl)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== `${MEDIA_PROTOCOL_SCHEME}:` ||
    parsed.hostname !== MEDIA_REMOTE_ARTWORK_HOST ||
    parsed.hash ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    return null;
  }

  const parts = parsed.pathname.slice(1).split('/');
  if (parts.length !== 2 || !isValidTrackUuid(parts[0]) || !isValidTrackUuid(parts[1])) {
    return null;
  }

  const rawSize = parsed.searchParams.get('size');
  let size: ArtworkSizeVariant = 'full';
  if (rawSize !== null) {
    if (rawSize !== 'full' && rawSize !== 'thumb') {
      return null;
    }
    size = rawSize;
  }

  const rawVersion = parsed.searchParams.get('v');
  const hasVersionToken = Boolean(rawVersion && /^[0-9a-f]{4,64}$/i.test(rawVersion));

  return {
    hostId: parts[0].toLowerCase(),
    trackId: parts[1].toLowerCase(),
    size,
    hasVersionToken,
  };
}


