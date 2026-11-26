/**
 * Confirmed built-in prototype / demo catalog identifiers from earlier prototype builds.
 * Used strictly for safe, idempotent removal of confirmed demo records during migration
 * without ever guessing by track title, artist name, album name, or missing-file status.
 */

export const CONFIRMED_DEMO_TRACK_IDS = [
  'trk-afterlight-1',
  'trk-afterlight-2',
  'trk-afterlight-3',
  'trk-velvet-1',
  'trk-velvet-2',
  'trk-midnight-1',
  'trk-midnight-2',
  'trk-midnight-3',
  'trk-blue-1',
  'trk-blue-2',
  'trk-golden-1',
  'trk-golden-2',
  'trk-quiet-1',
  'trk-quiet-2',
  'trk-aurora-1',
  'trk-aurora-2',
] as const;

export const CONFIRMED_DEMO_ALBUM_IDS = [
  'alb-afterlight',
  'alb-velvet-sky',
  'alb-midnight-echoes',
  'alb-blue-hour',
  'alb-golden-bloom',
  'alb-quiet-tides',
  'alb-aurora-lines',
] as const;

export const CONFIRMED_DEMO_PLAYLIST_IDS = [
  'pl-late-night',
  'pl-velvet-vocal',
  'pl-acoustic-vn',
  'pl-cobalt-piano',
  'pl-golden-afternoon',
  'pl-quiet-tides',
  'pl-aurora-focus',
] as const;

export const CONFIRMED_DEMO_TRACK_ID_SET = new Set<string>(CONFIRMED_DEMO_TRACK_IDS);
export const CONFIRMED_DEMO_ALBUM_ID_SET = new Set<string>(CONFIRMED_DEMO_ALBUM_IDS);
export const CONFIRMED_DEMO_PLAYLIST_ID_SET = new Set<string>(CONFIRMED_DEMO_PLAYLIST_IDS);

export const CONFIRMED_DEMO_BUNDLED_COVER_FRAGMENTS = [
  'album_afterlight_1795373224459',
  'album_velvet_sky_1795373225564',
  'album_midnight_echoes_1795373225467',
  'album_blue_hour_1795373225132',
  'album_golden_bloom_1795373225778',
  'album_quiet_tides_1795373224426',
  'album_aurora_lines_1795373226748',
] as const;

export function isConfirmedDemoTrackId(id: string | null | undefined): boolean {
  return typeof id === 'string' && CONFIRMED_DEMO_TRACK_ID_SET.has(id);
}

export function isConfirmedDemoAlbumId(id: string | null | undefined): boolean {
  return typeof id === 'string' && CONFIRMED_DEMO_ALBUM_ID_SET.has(id);
}

export function isConfirmedDemoPlaylistId(id: string | null | undefined): boolean {
  return typeof id === 'string' && CONFIRMED_DEMO_PLAYLIST_ID_SET.has(id);
}

export function isConfirmedDemoAnyId(id: string | null | undefined): boolean {
  return (
    isConfirmedDemoTrackId(id) ||
    isConfirmedDemoAlbumId(id) ||
    isConfirmedDemoPlaylistId(id)
  );
}

export function isConfirmedDemoAssetPath(rawPath: string | null | undefined): boolean {
  if (typeof rawPath !== 'string' || !rawPath) {
    return false;
  }
  const lower = rawPath.toLowerCase();
  if (lower.startsWith('sample://')) {
    return true;
  }
  return CONFIRMED_DEMO_BUNDLED_COVER_FRAGMENTS.some((frag) => lower.includes(frag));
}
