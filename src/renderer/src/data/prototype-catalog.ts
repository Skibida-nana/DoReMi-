import type { PlaylistTrackEntryRecord } from '../../../shared/types/playlist';
import type { TrackAvailabilityState } from '../../../shared/types/track';
import type { TimedLyricLine } from '../utils/vietnamese-search';

export interface AlbumColorPalette {
  dominant: string;
  secondary: string;
  glowRgb: string;
  secondaryGlowRgb: string;
  badgeBg: string;
  borderGlow: string;
}

export interface PrototypeAlbum {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  genre: string;
  coverUrl: string;
  formatLabel: string;
  palette: AlbumColorPalette;
  description: string;
  trackCount?: number;
  totalDurationSec?: number;
}

export interface PrototypeTrack {
  id: string;
  albumId: string;
  title: string;
  artist: string;
  albumTitle: string;
  albumArtist?: string | null;
  trackNumber: number;
  trackTotal?: number | null;
  discNumber?: number | null;
  discTotal?: number | null;
  year?: number | null;
  genre?: string | null;
  composer?: string | null;
  lyricist?: string | null;
  comment?: string | null;
  channels?: number | null;
  encoder?: string | null;
  fileName?: string | null;
  durationSec: number;
  formatBadge: string;
  container: string;
  bitDepth: number | null;
  sampleRateHz: number | null;
  bitrateKbps: number;
  fileSizeBytes: number;
  coverUrl: string;
  status: 'available' | 'missing';
  availabilityState?: TrackAvailabilityState;
  availabilityReason?: string | null;
  source: 'local' | 'sample';
  addedOrder: number;
  playCount: number;
  lyrics?: TimedLyricLine[];
  plainLyrics?: string[];
  filePathDisplay: string;
}

export interface PrototypePlaylist {
  id: string;
  name: string;
  description: string;
  trackIds: string[];
  entries?: PlaylistTrackEntryRecord[];
  updatedLabel: string;
  coverUrl?: string | null;
  hasCustomArtwork?: boolean;
  trackCount?: number;
  totalDurationMs?: number;
  availableCount?: number;
  missingCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export const DEFAULT_CATALOG_PALETTE: AlbumColorPalette = {
  dominant: '#8B5CF6',
  secondary: '#6D28D9',
  glowRgb: '139, 92, 246',
  secondaryGlowRgb: '109, 40, 217',
  badgeBg: 'rgba(139, 92, 246, 0.18)',
  borderGlow: 'rgba(167, 139, 250, 0.42)',
};
