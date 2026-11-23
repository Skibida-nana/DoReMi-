import type Database from 'better-sqlite3';

export interface TrackArtworkRow {
  track_id: string;
  custom_file: string | null;
  custom_mime: string | null;
  custom_hash: string | null;
  embedded_cache_file: string | null;
  embedded_mime: string | null;
  embedded_hash: string | null;
  folder_source_path: string | null;
  folder_cache_file: string | null;
  folder_mime: string | null;
  folder_hash: string | null;
  source_mtime_ms: number | null;
  updated_at: string;
}

export interface UpsertAutoArtworkInput {
  track_id: string;
  embedded_cache_file: string | null;
  embedded_mime: string | null;
  embedded_hash: string | null;
  folder_source_path: string | null;
  folder_cache_file: string | null;
  folder_mime: string | null;
  folder_hash: string | null;
  source_mtime_ms: number | null;
}

export interface SetCustomArtworkInput {
  track_id: string;
  custom_file: string;
  custom_mime: string;
  custom_hash: string;
}

export class ArtworkRepository {
  private readonly stmtFindByTrackId: Database.Statement;
  private readonly stmtFindAll: Database.Statement;
  private readonly stmtUpsertAuto: Database.Statement;
  private readonly stmtSetCustom: Database.Statement;
  private readonly stmtClearCustom: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtFindByTrackId = db.prepare(`
      SELECT
        track_id,
        custom_file,
        custom_mime,
        custom_hash,
        embedded_cache_file,
        embedded_mime,
        embedded_hash,
        folder_source_path,
        folder_cache_file,
        folder_mime,
        folder_hash,
        source_mtime_ms,
        updated_at
      FROM track_artwork
      WHERE track_id = ?
    `);

    this.stmtFindAll = db.prepare(`
      SELECT
        track_id,
        custom_file,
        custom_mime,
        custom_hash,
        embedded_cache_file,
        embedded_mime,
        embedded_hash,
        folder_source_path,
        folder_cache_file,
        folder_mime,
        folder_hash,
        source_mtime_ms,
        updated_at
      FROM track_artwork
    `);

    this.stmtUpsertAuto = db.prepare(`
      INSERT INTO track_artwork (
        track_id,
        embedded_cache_file,
        embedded_mime,
        embedded_hash,
        folder_source_path,
        folder_cache_file,
        folder_mime,
        folder_hash,
        source_mtime_ms,
        updated_at
      ) VALUES (
        @track_id,
        @embedded_cache_file,
        @embedded_mime,
        @embedded_hash,
        @folder_source_path,
        @folder_cache_file,
        @folder_mime,
        @folder_hash,
        @source_mtime_ms,
        @updated_at
      )
      ON CONFLICT(track_id) DO UPDATE SET
        embedded_cache_file = excluded.embedded_cache_file,
        embedded_mime = excluded.embedded_mime,
        embedded_hash = excluded.embedded_hash,
        folder_source_path = excluded.folder_source_path,
        folder_cache_file = excluded.folder_cache_file,
        folder_mime = excluded.folder_mime,
        folder_hash = excluded.folder_hash,
        source_mtime_ms = excluded.source_mtime_ms,
        updated_at = excluded.updated_at
    `);

    this.stmtSetCustom = db.prepare(`
      INSERT INTO track_artwork (
        track_id,
        custom_file,
        custom_mime,
        custom_hash,
        updated_at
      ) VALUES (
        @track_id,
        @custom_file,
        @custom_mime,
        @custom_hash,
        @updated_at
      )
      ON CONFLICT(track_id) DO UPDATE SET
        custom_file = excluded.custom_file,
        custom_mime = excluded.custom_mime,
        custom_hash = excluded.custom_hash,
        updated_at = excluded.updated_at
    `);

    this.stmtClearCustom = db.prepare(`
      UPDATE track_artwork
      SET
        custom_file = NULL,
        custom_mime = NULL,
        custom_hash = NULL,
        updated_at = ?
      WHERE track_id = ?
    `);
  }

  findByTrackId(trackId: string): TrackArtworkRow | null {
    const row = this.stmtFindByTrackId.get(trackId) as TrackArtworkRow | undefined;
    return row ?? null;
  }

  findAllMap(): Map<string, TrackArtworkRow> {
    const rows = this.stmtFindAll.all() as TrackArtworkRow[];
    const map = new Map<string, TrackArtworkRow>();
    for (const row of rows) {
      map.set(row.track_id, row);
    }
    return map;
  }

  upsertAutoArtwork(input: UpsertAutoArtworkInput): void {
    this.stmtUpsertAuto.run({
      ...input,
      updated_at: new Date().toISOString(),
    });
  }

  setCustomArtwork(input: SetCustomArtworkInput): void {
    this.stmtSetCustom.run({
      ...input,
      updated_at: new Date().toISOString(),
    });
  }

  clearCustomArtwork(trackId: string): boolean {
    const res = this.stmtClearCustom.run(new Date().toISOString(), trackId);
    return res.changes > 0;
  }
}
