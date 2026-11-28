import type { RemoteTrackDto } from '../types/connect';
import type { TrackRecord } from '../types/track';
import { isValidTrackUuid } from './media-protocol';

export const CONNECT_API_VERSION = '1';
export const CONNECT_MIN_SUPPORTED_API_VERSION = '1';
export const CONNECT_API_PREFIX = '/api/v1';

export const CONNECT_DEFAULT_PORT = 48620;
export const CONNECT_DEFAULT_MAX_CLIENTS = 3;
export const CONNECT_DEFAULT_MAX_REQUESTS_PER_DEVICE = 16;
export const CONNECT_DEFAULT_MAX_GLOBAL_REQUESTS = 48;

export const CONNECT_DEFAULT_PAGE_LIMIT = 100;
export const CONNECT_MAX_PAGE_LIMIT = 200;
export const CONNECT_MAX_JSON_BODY_BYTES = 32 * 1024;
export const CONNECT_INVITATION_TTL_MS = 5 * 60 * 1000;
export const CONNECT_STREAM_HIGH_WATER_MARK = 64 * 1024;

export const CONNECT_MDNS_SERVICE_TYPE = '_doremi._tcp.local';
export const CONNECT_MDNS_MULTICAST_ADDR = '224.0.0.251';
export const CONNECT_MDNS_PORT = 5353;

export const REMOTE_TRACK_ID_PREFIX = 'remote::';

export interface ParsedRemoteTrackId {
  hostId: string;
  trackId: string;
}

/**
 * Builds a collision-free composite identifier (`remote::<hostId>::<trackId>`)
 * so remote tracks never collide with local SQLite UUIDs or tracks from other Hosts.
 */
export function buildRemoteTrackId(hostId: string, trackId: string): string {
  const cleanHost = hostId.trim().toLowerCase();
  const cleanTrack = trackId.trim().toLowerCase();
  if (!isValidTrackUuid(cleanHost) || !isValidTrackUuid(cleanTrack)) {
    throw new Error('Invalid hostId or trackId UUID for remote track identifier.');
  }
  return `${REMOTE_TRACK_ID_PREFIX}${cleanHost}::${cleanTrack}`;
}

export function isRemoteTrackId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(REMOTE_TRACK_ID_PREFIX);
}

export function parseRemoteTrackId(compositeId: unknown): ParsedRemoteTrackId | null {
  if (!isRemoteTrackId(compositeId) || compositeId.length > 128) {
    return null;
  }
  const rest = compositeId.slice(REMOTE_TRACK_ID_PREFIX.length);
  const parts = rest.split('::');
  if (parts.length !== 2) {
    return null;
  }
  const [hostId, trackId] = parts;
  if (!isValidTrackUuid(hostId) || !isValidTrackUuid(trackId)) {
    return null;
  }
  return {
    hostId: hostId.toLowerCase(),
    trackId: trackId.toLowerCase(),
  };
}

/**
 * Maps a sanitized RemoteTrackDto (containing zero Host filesystem paths) into a TrackRecord
 * shape consumable by AudioEngine & UI display components under a remote composite ID.
 */
export function mapRemoteTrackDtoToTrackRecord(
  hostId: string,
  dto: RemoteTrackDto,
  artworkUrls?: { fullUrl: string | null; thumbUrl: string | null },
): TrackRecord {
  const compositeId = buildRemoteTrackId(hostId, dto.trackId);
  const available = dto.availabilityState === 'available' || dto.availabilityState === 'unchecked';
  const now = new Date(0).toISOString();

  return {
    id: compositeId,
    original_path: `doremi-remote://${hostId}/${dto.trackId}`,
    normalized_path: `doremi-remote://${hostId}/${dto.trackId}`,
    title: dto.title,
    artist: dto.artist,
    album: dto.album,
    album_artist: dto.albumArtist,
    genre: dto.genre,
    year: dto.year,
    track_number: dto.trackNumber,
    track_total: dto.trackTotal,
    disc_number: dto.discNumber,
    disc_total: dto.discTotal,
    channels: dto.channels,
    duration_ms: dto.durationMs,
    codec: dto.codec,
    container: dto.container,
    sample_rate_hz: dto.sampleRateHz,
    bit_depth: dto.bitDepth,
    bitrate_bps: dto.bitrateBps,
    file_size_bytes: dto.fileSizeBytes,
    modified_at_ms: null,
    status: available ? 'available' : 'missing',
    availability_state: dto.availabilityState,
    availability_reason: available ? null : 'File trên Host hiện không khả dụng.',
    added_at: now,
    updated_at: now,
    artwork_url: artworkUrls?.fullUrl ?? null,
    artwork_thumb_url: artworkUrls?.thumbUrl ?? null,
    artwork_source: artworkUrls?.fullUrl ? 'embedded' : 'default',
    has_custom_artwork: false,
  };
}

export function clampConnectPageLimit(rawLimit: unknown): number {
  const num = typeof rawLimit === 'number' ? rawLimit : Number(rawLimit);
  if (!Number.isFinite(num) || num <= 0) {
    return CONNECT_DEFAULT_PAGE_LIMIT;
  }
  return Math.min(CONNECT_MAX_PAGE_LIMIT, Math.max(1, Math.floor(num)));
}

export function clampConnectPageOffset(rawOffset: unknown): number {
  const num = typeof rawOffset === 'number' ? rawOffset : Number(rawOffset);
  if (!Number.isFinite(num) || num < 0) {
    return 0;
  }
  return Math.floor(num);
}
