export type TrackStatus = 'available' | 'missing' | 'error';

export type TrackArtworkSource = 'custom' | 'embedded' | 'folder' | 'default';

export type TrackLyricsSource = 'custom' | 'sidecar' | 'embedded' | 'none';

export type TrackLyricsFormat = 'lrc' | 'txt' | 'none';

export interface TimedLyricEntry {
  timeSec: number;
  text: string;
}

export interface ResolvedTrackLyrics {
  trackId: string;
  source: TrackLyricsSource;
  format: TrackLyricsFormat;
  rawContent: string;
  timedLines: TimedLyricEntry[];
  plainLines: string[];
  hasCustomLyrics: boolean;
  sidecarPath: string | null;
}

export interface TrackMetadataOverrideInput {
  titleOverride: string | null;
  artistOverride: string | null;
  albumOverride: string | null;
}

export interface TrackRecord {
  id: string;
  original_path: string;
  normalized_path: string;
  /** Effective display title (user override if set, otherwise original metadata title) */
  title: string;
  /** Effective display artist (user override if set, otherwise original metadata artist) */
  artist: string;
  /** Effective display album (user override if set, otherwise original metadata album) */
  album: string | null;
  /** Original file metadata values (never modified by in-app edits) */
  original_title?: string;
  original_artist?: string;
  original_album?: string | null;
  /** User in-app overrides stored in SQLite (null means use original) */
  title_override?: string | null;
  artist_override?: string | null;
  album_override?: string | null;
  year?: number | null;
  duration_ms: number | null;
  codec: string | null;
  container: string | null;
  sample_rate_hz: number | null;
  bit_depth: number | null;
  bitrate_bps: number | null;
  file_size_bytes: number | null;
  modified_at_ms: number | null;
  status: TrackStatus;
  added_at: string;
  updated_at: string;
  /** Resolved artwork protocol URLs & provenance (populated by ArtworkService) */
  artwork_url?: string | null;
  artwork_thumb_url?: string | null;
  artwork_source?: TrackArtworkSource;
  has_custom_artwork?: boolean;
  /** Optional ReplayGain tags parsed read-only from file metadata */
  replaygain_track_gain_db?: number | null;
  replaygain_album_gain_db?: number | null;
  replaygain_track_peak?: number | null;
  replaygain_album_peak?: number | null;
}

export interface ParsedTrackMetadata {
  title: string;
  artist: string;
  album: string | null;
  year?: number | null;
  embedded_lyrics?: string | null;
  duration_ms: number | null;
  codec: string | null;
  container: string | null;
  sample_rate_hz: number | null;
  bit_depth: number | null;
  bitrate_bps: number | null;
  file_size_bytes: number;
  modified_at_ms: number;
  replaygain_track_gain_db?: number | null;
  replaygain_album_gain_db?: number | null;
  replaygain_track_peak?: number | null;
  replaygain_album_peak?: number | null;
  metadataWarning?: string;
}
