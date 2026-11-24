import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TrackRecord, TrackStatus } from '../../shared/types/track';

export interface UpsertTrackInput {
  original_path: string;
  normalized_path: string;
  title: string;
  artist: string;
  album: string | null;
  year?: number | null;
  duration_ms: number | null;
  codec: string | null;
  container: string | null;
  sample_rate_hz: number | null;
  bit_depth: number | null;
  bitrate_bps: number | null;
  file_size_bytes: number | null;
  modified_at_ms: number | null;
  replaygain_track_gain_db?: number | null;
  replaygain_album_gain_db?: number | null;
  replaygain_track_peak?: number | null;
  replaygain_album_peak?: number | null;
  status: TrackStatus;
}

export interface UpsertBatchSummary {
  addedCount: number;
  updatedCount: number;
  skippedCount: number;
  recoveredCount: number;
}

const SELECT_TRACK_COLUMNS = `
  t.id,
  t.original_path,
  t.normalized_path,
  COALESCE(NULLIF(TRIM(m.title_override), ''), t.title) AS title,
  COALESCE(NULLIF(TRIM(m.artist_override), ''), t.artist) AS artist,
  COALESCE(NULLIF(TRIM(m.album_override), ''), t.album) AS album,
  t.title AS original_title,
  t.artist AS original_artist,
  t.album AS original_album,
  m.title_override AS title_override,
  m.artist_override AS artist_override,
  m.album_override AS album_override,
  t.year,
  t.duration_ms,
  t.codec,
  t.container,
  t.sample_rate_hz,
  t.bit_depth,
  t.bitrate_bps,
  t.file_size_bytes,
  t.modified_at_ms,
  t.replaygain_track_gain_db,
  t.replaygain_album_gain_db,
  t.replaygain_track_peak,
  t.replaygain_album_peak,
  t.status,
  t.added_at,
  t.updated_at
`;

export class TrackRepository {
  private readonly stmtFindAll: Database.Statement;
  private readonly stmtFindById: Database.Statement;
  private readonly stmtFindByNormalizedPath: Database.Statement;
  private readonly stmtInsertTrack: Database.Statement;
  private readonly stmtUpdateTrack: Database.Statement;
  private readonly stmtUpdateStatus: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.stmtFindAll = db.prepare(`
      SELECT ${SELECT_TRACK_COLUMNS}
      FROM tracks t
      LEFT JOIN track_metadata_overrides m ON m.track_id = t.id
      ORDER BY t.added_at ASC, COALESCE(NULLIF(TRIM(m.title_override), ''), t.title) COLLATE NOCASE ASC
    `);

    this.stmtFindById = db.prepare(`
      SELECT ${SELECT_TRACK_COLUMNS}
      FROM tracks t
      LEFT JOIN track_metadata_overrides m ON m.track_id = t.id
      WHERE t.id = ?
    `);

    this.stmtFindByNormalizedPath = db.prepare(`
      SELECT ${SELECT_TRACK_COLUMNS}
      FROM tracks t
      LEFT JOIN track_metadata_overrides m ON m.track_id = t.id
      WHERE t.normalized_path = ?
    `);

    this.stmtInsertTrack = db.prepare(`
      INSERT INTO tracks (
        id,
        original_path,
        normalized_path,
        title,
        artist,
        album,
        year,
        duration_ms,
        codec,
        container,
        sample_rate_hz,
        bit_depth,
        bitrate_bps,
        file_size_bytes,
        modified_at_ms,
        replaygain_track_gain_db,
        replaygain_album_gain_db,
        replaygain_track_peak,
        replaygain_album_peak,
        status,
        added_at,
        updated_at
      ) VALUES (
        @id,
        @original_path,
        @normalized_path,
        @title,
        @artist,
        @album,
        @year,
        @duration_ms,
        @codec,
        @container,
        @sample_rate_hz,
        @bit_depth,
        @bitrate_bps,
        @file_size_bytes,
        @modified_at_ms,
        @replaygain_track_gain_db,
        @replaygain_album_gain_db,
        @replaygain_track_peak,
        @replaygain_album_peak,
        @status,
        @added_at,
        @updated_at
      )
    `);

    this.stmtUpdateTrack = db.prepare(`
      UPDATE tracks
      SET
        original_path = @original_path,
        title = @title,
        artist = @artist,
        album = @album,
        year = @year,
        duration_ms = @duration_ms,
        codec = @codec,
        container = @container,
        sample_rate_hz = @sample_rate_hz,
        bit_depth = @bit_depth,
        bitrate_bps = @bitrate_bps,
        file_size_bytes = @file_size_bytes,
        modified_at_ms = @modified_at_ms,
        replaygain_track_gain_db = @replaygain_track_gain_db,
        replaygain_album_gain_db = @replaygain_album_gain_db,
        replaygain_track_peak = @replaygain_track_peak,
        replaygain_album_peak = @replaygain_album_peak,
        status = @status,
        updated_at = @updated_at
      WHERE id = @id
    `);

    this.stmtUpdateStatus = db.prepare(`
      UPDATE tracks
      SET status = ?, updated_at = ?
      WHERE id = ?
    `);
  }

  findAll(): TrackRecord[] {
    return this.stmtFindAll.all() as TrackRecord[];
  }

  findById(id: string): TrackRecord | null {
    const row = this.stmtFindById.get(id) as TrackRecord | undefined;
    return row ?? null;
  }

  findByNormalizedPath(normalizedPath: string): TrackRecord | null {
    const row = this.stmtFindByNormalizedPath.get(normalizedPath) as TrackRecord | undefined;
    return row ?? null;
  }

  /**
   * Upserts a batch of tracks inside a single SQLite transaction.
   * Existing tracks matched by normalized_path preserve their stable UUID, added_at,
   * and any user metadata overrides in track_metadata_overrides.
   */
  upsertBatch(inputs: readonly UpsertTrackInput[]): UpsertBatchSummary {
    const summary: UpsertBatchSummary = {
      addedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      recoveredCount: 0,
    };

    const runBatch = this.db.transaction((rows: readonly UpsertTrackInput[]) => {
      const now = new Date().toISOString();

      for (const item of rows) {
        const existing = this.findByNormalizedPath(item.normalized_path);
        const nextYear = item.year ?? null;

        if (!existing) {
          this.stmtInsertTrack.run({
            id: crypto.randomUUID(),
            original_path: item.original_path,
            normalized_path: item.normalized_path,
            title: item.title,
            artist: item.artist,
            album: item.album,
            year: nextYear,
            duration_ms: item.duration_ms,
            codec: item.codec,
            container: item.container,
            sample_rate_hz: item.sample_rate_hz,
            bit_depth: item.bit_depth,
            bitrate_bps: item.bitrate_bps,
            file_size_bytes: item.file_size_bytes,
            modified_at_ms: item.modified_at_ms,
            replaygain_track_gain_db: item.replaygain_track_gain_db ?? null,
            replaygain_album_gain_db: item.replaygain_album_gain_db ?? null,
            replaygain_track_peak: item.replaygain_track_peak ?? null,
            replaygain_album_peak: item.replaygain_album_peak ?? null,
            status: item.status,
            added_at: now,
            updated_at: now,
          });
          summary.addedCount += 1;
          continue;
        }

        const existingOrigTitle = existing.original_title ?? existing.title;
        const existingOrigArtist = existing.original_artist ?? existing.artist;
        const existingOrigAlbum =
          existing.original_album !== undefined ? existing.original_album : existing.album;
        const existingYear = existing.year ?? null;
        const nextRgTrack = item.replaygain_track_gain_db ?? null;
        const nextRgAlbum = item.replaygain_album_gain_db ?? null;
        const nextRgTrackPeak = item.replaygain_track_peak ?? null;
        const nextRgAlbumPeak = item.replaygain_album_peak ?? null;

        const wasMissing = existing.status === 'missing' && item.status === 'available';
        const hasChanges =
          wasMissing ||
          existing.status !== item.status ||
          existing.original_path !== item.original_path ||
          existing.modified_at_ms !== item.modified_at_ms ||
          existing.file_size_bytes !== item.file_size_bytes ||
          existingOrigTitle !== item.title ||
          existingOrigArtist !== item.artist ||
          existingOrigAlbum !== item.album ||
          existingYear !== nextYear ||
          existing.duration_ms !== item.duration_ms ||
          existing.codec !== item.codec ||
          existing.container !== item.container ||
          existing.sample_rate_hz !== item.sample_rate_hz ||
          existing.bit_depth !== item.bit_depth ||
          existing.bitrate_bps !== item.bitrate_bps ||
          (existing.replaygain_track_gain_db ?? null) !== nextRgTrack ||
          (existing.replaygain_album_gain_db ?? null) !== nextRgAlbum ||
          (existing.replaygain_track_peak ?? null) !== nextRgTrackPeak ||
          (existing.replaygain_album_peak ?? null) !== nextRgAlbumPeak;

        if (!hasChanges) {
          summary.skippedCount += 1;
          continue;
        }

        this.stmtUpdateTrack.run({
          id: existing.id,
          original_path: item.original_path,
          title: item.title,
          artist: item.artist,
          album: item.album,
          year: nextYear,
          duration_ms: item.duration_ms,
          codec: item.codec,
          container: item.container,
          sample_rate_hz: item.sample_rate_hz,
          bit_depth: item.bit_depth,
          bitrate_bps: item.bitrate_bps,
          file_size_bytes: item.file_size_bytes,
          modified_at_ms: item.modified_at_ms,
          replaygain_track_gain_db: nextRgTrack,
          replaygain_album_gain_db: nextRgAlbum,
          replaygain_track_peak: nextRgTrackPeak,
          replaygain_album_peak: nextRgAlbumPeak,
          status: item.status,
          updated_at: now,
        });

        if (wasMissing) {
          summary.recoveredCount += 1;
        } else {
          summary.updatedCount += 1;
        }
      }
    });

    runBatch(inputs);
    return summary;
  }

  updateStatus(id: string, status: TrackStatus): boolean {
    const result = this.stmtUpdateStatus.run(status, new Date().toISOString(), id);
    return result.changes > 0;
  }

  updateStatusesBatch(updates: ReadonlyArray<{ id: string; status: TrackStatus }>): number {
    if (updates.length === 0) {
      return 0;
    }

    const now = new Date().toISOString();
    let changed = 0;

    const tx = this.db.transaction(
      (items: ReadonlyArray<{ id: string; status: TrackStatus }>) => {
        for (const item of items) {
          const result = this.stmtUpdateStatus.run(item.status, now, item.id);
          changed += result.changes;
        }
      },
    );

    tx(updates);
    return changed;
  }

  /**
   * Relinks an existing track to a new file path on disk while strictly preserving its Stable Track ID,
   * playlists, favorites, listening history, metadata overrides, custom artwork, and custom lyrics.
   */
  relinkTrackPath(params: {
    id: string;
    originalPath: string;
    normalizedPath: string;
    fileSizeBytes: number | null;
    modifiedAtMs: number | null;
  }): boolean {
    const conflict = this.findByNormalizedPath(params.normalizedPath);
    if (conflict && conflict.id !== params.id) {
      throw new Error(
        `Đường dẫn đích đã thuộc về một bài hát khác trong thư viện ("${conflict.title}").`,
      );
    }

    const stmt = this.db.prepare(`
      UPDATE tracks
      SET
        original_path = @original_path,
        normalized_path = @normalized_path,
        file_size_bytes = @file_size_bytes,
        modified_at_ms = @modified_at_ms,
        status = 'available',
        updated_at = @updated_at
      WHERE id = @id
    `);
    const result = stmt.run({
      id: params.id,
      original_path: params.originalPath,
      normalized_path: params.normalizedPath,
      file_size_bytes: params.fileSizeBytes,
      modified_at_ms: params.modifiedAtMs,
      updated_at: new Date().toISOString(),
    });
    return result.changes > 0;
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  findByIds(ids: readonly string[]): TrackRecord[] {
    if (ids.length === 0) {
      return [];
    }
    const result: TrackRecord[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const found = this.findById(id);
      if (found) {
        result.push(found);
      }
    }
    return result;
  }

  deleteById(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM tracks WHERE id = ?');
    return stmt.run(id).changes > 0;
  }

  deleteByIds(ids: readonly string[]): number {
    if (ids.length === 0) {
      return 0;
    }
    const stmt = this.db.prepare('DELETE FROM tracks WHERE id = ?');
    const tx = this.db.transaction((targetIds: readonly string[]) => {
      let deleted = 0;
      for (const id of targetIds) {
        deleted += stmt.run(id).changes;
      }
      return deleted;
    });
    return tx(ids);
  }

  deleteAll(): number {
    const stmt = this.db.prepare('DELETE FROM tracks');
    return stmt.run().changes;
  }
}
