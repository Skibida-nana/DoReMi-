import type Database from 'better-sqlite3';
import type { TrackMetadataOverrideInput } from '../../shared/types/track';

export interface TrackMetadataOverrideRow {
  track_id: string;
  title_override: string | null;
  artist_override: string | null;
  album_override: string | null;
  updated_at: string;
}

function normalizeOverrideValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.normalize('NFC').trim();
  return trimmed.length > 0 ? trimmed : null;
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
        updated_at
      ) VALUES (
        @track_id,
        @title_override,
        @artist_override,
        @album_override,
        @updated_at
      )
      ON CONFLICT(track_id) DO UPDATE SET
        title_override = excluded.title_override,
        artist_override = excluded.artist_override,
        album_override = excluded.album_override,
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
    const titleOverride = normalizeOverrideValue(input.titleOverride);
    const artistOverride = normalizeOverrideValue(input.artistOverride);
    const albumOverride = normalizeOverrideValue(input.albumOverride);

    if (titleOverride === null && artistOverride === null && albumOverride === null) {
      this.stmtDelete.run(trackId);
      return;
    }

    this.stmtUpsert.run({
      track_id: trackId,
      title_override: titleOverride,
      artist_override: artistOverride,
      album_override: albumOverride,
      updated_at: new Date().toISOString(),
    });
  }

  deleteOverride(trackId: string): boolean {
    const res = this.stmtDelete.run(trackId);
    return res.changes > 0;
  }
}
