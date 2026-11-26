import type Database from 'better-sqlite3';
import type { TrackMetadataOverrideInput } from '../../shared/types/track';

export interface TrackMetadataOverrideRow {
  track_id: string;
  title_override: string | null;
  artist_override: string | null;
  album_override: string | null;
  genre_override: string | null;
  year_override: number | null;
  album_artist_override: string | null;
  track_number_override: number | null;
  track_total_override: number | null;
  disc_number_override: number | null;
  disc_total_override: number | null;
  composer_override: string | null;
  lyricist_override: string | null;
  comment_override: string | null;
  updated_at: string;
}

function normalizeOverrideValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.normalize('NFC').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePositiveInt(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.round(value);
}

function normalizeYearInt(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value);
  return rounded >= 1000 && rounded <= 2999 ? rounded : null;
}

export class MetadataOverrideRepository {
  private readonly stmtFindByTrackId: Database.Statement;
  private readonly stmtUpsert: Database.Statement;
  private readonly stmtDelete: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtFindByTrackId = db.prepare(`
      SELECT
        track_id,
        title_override,
        artist_override,
        album_override,
        genre_override,
        year_override,
        album_artist_override,
        track_number_override,
        track_total_override,
        disc_number_override,
        disc_total_override,
        composer_override,
        lyricist_override,
        comment_override,
        updated_at
      FROM track_metadata_overrides
      WHERE track_id = ?
    `);

    this.stmtUpsert = db.prepare(`
      INSERT INTO track_metadata_overrides (
        track_id,
        title_override,
        artist_override,
        album_override,
        genre_override,
        year_override,
        album_artist_override,
        track_number_override,
        track_total_override,
        disc_number_override,
        disc_total_override,
        composer_override,
        lyricist_override,
        comment_override,
        updated_at
      ) VALUES (
        @track_id,
        @title_override,
        @artist_override,
        @album_override,
        @genre_override,
        @year_override,
        @album_artist_override,
        @track_number_override,
        @track_total_override,
        @disc_number_override,
        @disc_total_override,
        @composer_override,
        @lyricist_override,
        @comment_override,
        @updated_at
      )
      ON CONFLICT(track_id) DO UPDATE SET
        title_override = excluded.title_override,
        artist_override = excluded.artist_override,
        album_override = excluded.album_override,
        genre_override = excluded.genre_override,
        year_override = excluded.year_override,
        album_artist_override = excluded.album_artist_override,
        track_number_override = excluded.track_number_override,
        track_total_override = excluded.track_total_override,
        disc_number_override = excluded.disc_number_override,
        disc_total_override = excluded.disc_total_override,
        composer_override = excluded.composer_override,
        lyricist_override = excluded.lyricist_override,
        comment_override = excluded.comment_override,
        updated_at = excluded.updated_at
    `);

    this.stmtDelete = db.prepare(`
      DELETE FROM track_metadata_overrides
      WHERE track_id = ?
    `);
  }

  findByTrackId(trackId: string): TrackMetadataOverrideRow | null {
    const row = this.stmtFindByTrackId.get(trackId) as TrackMetadataOverrideRow | undefined;
    return row ?? null;
  }

  upsertOverride(trackId: string, input: TrackMetadataOverrideInput): void {
    const existing = this.findByTrackId(trackId);
    const titleOverride = normalizeOverrideValue(input.titleOverride);
    const artistOverride = normalizeOverrideValue(input.artistOverride);
    const albumOverride = normalizeOverrideValue(input.albumOverride);

    const genreOverride =
      input.genreOverride !== undefined
        ? normalizeOverrideValue(input.genreOverride)
        : existing?.genre_override ?? null;
    const yearOverride =
      input.yearOverride !== undefined
        ? normalizeYearInt(input.yearOverride)
        : existing?.year_override ?? null;
    const albumArtistOverride =
      input.albumArtistOverride !== undefined
        ? normalizeOverrideValue(input.albumArtistOverride)
        : existing?.album_artist_override ?? null;
    const trackNumberOverride =
      input.trackNumberOverride !== undefined
        ? normalizePositiveInt(input.trackNumberOverride)
        : existing?.track_number_override ?? null;
    const trackTotalOverride =
      input.trackTotalOverride !== undefined
        ? normalizePositiveInt(input.trackTotalOverride)
        : existing?.track_total_override ?? null;
    const discNumberOverride =
      input.discNumberOverride !== undefined
        ? normalizePositiveInt(input.discNumberOverride)
        : existing?.disc_number_override ?? null;
    const discTotalOverride =
      input.discTotalOverride !== undefined
        ? normalizePositiveInt(input.discTotalOverride)
        : existing?.disc_total_override ?? null;
    const composerOverride =
      input.composerOverride !== undefined
        ? normalizeOverrideValue(input.composerOverride)
        : existing?.composer_override ?? null;
    const lyricistOverride =
      input.lyricistOverride !== undefined
        ? normalizeOverrideValue(input.lyricistOverride)
        : existing?.lyricist_override ?? null;
    const commentOverride =
      input.commentOverride !== undefined
        ? normalizeOverrideValue(input.commentOverride)
        : existing?.comment_override ?? null;

    const allNull =
      titleOverride === null &&
      artistOverride === null &&
      albumOverride === null &&
      genreOverride === null &&
      yearOverride === null &&
      albumArtistOverride === null &&
      trackNumberOverride === null &&
      trackTotalOverride === null &&
      discNumberOverride === null &&
      discTotalOverride === null &&
      composerOverride === null &&
      lyricistOverride === null &&
      commentOverride === null;

    if (allNull) {
      this.stmtDelete.run(trackId);
      return;
    }

    this.stmtUpsert.run({
      track_id: trackId,
      title_override: titleOverride,
      artist_override: artistOverride,
      album_override: albumOverride,
      genre_override: genreOverride,
      year_override: yearOverride,
      album_artist_override: albumArtistOverride,
      track_number_override: trackNumberOverride,
      track_total_override: trackTotalOverride,
      disc_number_override: discNumberOverride,
      disc_total_override: discTotalOverride,
      composer_override: composerOverride,
      lyricist_override: lyricistOverride,
      comment_override: commentOverride,
      updated_at: new Date().toISOString(),
    });
  }

  deleteOverride(trackId: string): boolean {
    const res = this.stmtDelete.run(trackId);
    return res.changes > 0;
  }
}
