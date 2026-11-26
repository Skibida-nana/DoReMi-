import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TrackAvailabilityState, TrackRecord, TrackStatus } from '../../shared/types/track';
import { extractFileNameFromPath } from '../../shared/utils/natural-sort';

export interface UpsertTrackInput {
  original_path: string;
  normalized_path: string;
  title: string;
  artist: string;
  album: string | null;
  genre?: string | null;
  year?: number | null;
  album_artist?: string | null;
  track_number?: number | null;
  track_total?: number | null;
  disc_number?: number | null;
  disc_total?: number | null;
  composer?: string | null;
  lyricist?: string | null;
  comment?: string | null;
  channels?: number | null;
  encoder?: string | null;
  file_name?: string | null;
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
  availability_state?: TrackAvailabilityState;
  availability_reason?: string | null;
  last_verified_at?: string | null;
  metadata_version?: number | null;
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
  COALESCE(NULLIF(TRIM(m.genre_override), ''), t.genre) AS genre,
  t.genre AS original_genre,
  m.genre_override AS genre_override,
  COALESCE(m.year_override, t.year) AS year,
  t.year AS original_year,
  m.year_override AS year_override,
  COALESCE(NULLIF(TRIM(m.album_artist_override), ''), t.album_artist) AS album_artist,
  t.album_artist AS original_album_artist,
  m.album_artist_override AS album_artist_override,
  COALESCE(m.track_number_override, t.track_number) AS track_number,
  t.track_number AS original_track_number,
  m.track_number_override AS track_number_override,
  COALESCE(m.track_total_override, t.track_total) AS track_total,
  t.track_total AS original_track_total,
  m.track_total_override AS track_total_override,
  COALESCE(m.disc_number_override, t.disc_number) AS disc_number,
  t.disc_number AS original_disc_number,
  m.disc_number_override AS disc_number_override,
  COALESCE(m.disc_total_override, t.disc_total) AS disc_total,
  t.disc_total AS original_disc_total,
  m.disc_total_override AS disc_total_override,
  COALESCE(NULLIF(TRIM(m.composer_override), ''), t.composer) AS composer,
  t.composer AS original_composer,
  m.composer_override AS composer_override,
  COALESCE(NULLIF(TRIM(m.lyricist_override), ''), t.lyricist) AS lyricist,
  t.lyricist AS original_lyricist,
  m.lyricist_override AS lyricist_override,
  COALESCE(NULLIF(TRIM(m.comment_override), ''), t.comment) AS comment,
  t.comment AS original_comment,
  m.comment_override AS comment_override,
  t.channels,
  t.encoder,
  t.file_name,
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
  t.availability_state,
  t.availability_reason,
  t.last_verified_at,
  t.metadata_version,
  t.added_at,
  t.updated_at
`;

export function availabilityToTrackStatus(state: TrackAvailabilityState): TrackStatus {
  if (state === 'available' || state === 'unchecked') {
    return 'available';
  }
  if (state === 'access_error') {
    return 'error';
  }
  return 'missing';
}

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
        genre,
        year,
        album_artist,
        track_number,
        track_total,
        disc_number,
        disc_total,
        composer,
        lyricist,
        comment,
        channels,
        encoder,
        file_name,
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
        availability_state,
        availability_reason,
        last_verified_at,
        metadata_version,
        added_at,
        updated_at
      ) VALUES (
        @id,
        @original_path,
        @normalized_path,
        @title,
        @artist,
        @album,
        @genre,
        @year,
        @album_artist,
        @track_number,
        @track_total,
        @disc_number,
        @disc_total,
        @composer,
        @lyricist,
        @comment,
        @channels,
        @encoder,
        @file_name,
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
        @availability_state,
        @availability_reason,
        @last_verified_at,
        @metadata_version,
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
        genre = @genre,
        year = @year,
        album_artist = @album_artist,
        track_number = @track_number,
        track_total = @track_total,
        disc_number = @disc_number,
        disc_total = @disc_total,
        composer = @composer,
        lyricist = @lyricist,
        comment = @comment,
        channels = @channels,
        encoder = @encoder,
        file_name = @file_name,
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
        availability_state = @availability_state,
        availability_reason = @availability_reason,
        last_verified_at = @last_verified_at,
        metadata_version = @metadata_version,
        updated_at = @updated_at
      WHERE id = @id
    `);

    this.stmtUpdateStatus = db.prepare(`
      UPDATE tracks
      SET
        status = ?,
        availability_state = ?,
        availability_reason = ?,
        last_verified_at = ?,
        updated_at = ?
      WHERE id = ?
    `);
  }

  findAll(): TrackRecord[] {
    return this.stmtFindAll.all() as TrackRecord[];
  }

  findAvailableTracksNeedingMetadataRevalidation(
    currentVersion: number,
    limit = 64,
  ): TrackRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return this.db
      .prepare(
        `
        SELECT ${SELECT_TRACK_COLUMNS}
        FROM tracks t
        LEFT JOIN track_metadata_overrides m ON m.track_id = t.id
        WHERE t.status = 'available' AND COALESCE(t.metadata_version, 1) < ?
        ORDER BY t.added_at ASC
        LIMIT ?
      `,
      )
      .all(currentVersion, safeLimit) as TrackRecord[];
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
        const nextFileName = item.file_name ?? extractFileNameFromPath(item.original_path);
        const nextAvailState: TrackAvailabilityState =
          item.availability_state ??
          (item.status === 'available'
            ? 'available'
            : item.status === 'error'
              ? 'access_error'
              : 'missing');
        const nextAvailReason = item.availability_reason ?? null;
        const nextVerifiedAt = item.last_verified_at ?? now;
        const nextMetadataVersion = item.metadata_version ?? 2;

        if (!existing) {
          this.stmtInsertTrack.run({
            id: crypto.randomUUID(),
            original_path: item.original_path,
            normalized_path: item.normalized_path,
            title: item.title,
            artist: item.artist,
            album: item.album,
            genre: item.genre ?? null,
            year: nextYear,
            album_artist: item.album_artist ?? null,
            track_number: item.track_number ?? null,
            track_total: item.track_total ?? null,
            disc_number: item.disc_number ?? null,
            disc_total: item.disc_total ?? null,
            composer: item.composer ?? null,
            lyricist: item.lyricist ?? null,
            comment: item.comment ?? null,
            channels: item.channels ?? null,
            encoder: item.encoder ?? null,
            file_name: nextFileName,
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
            availability_state: nextAvailState,
            availability_reason: nextAvailReason,
            last_verified_at: nextVerifiedAt,
            metadata_version: nextMetadataVersion,
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
        const existingOrigYear =
          existing.original_year !== undefined ? existing.original_year : existing.year ?? null;
        const existingOrigGenre =
          existing.original_genre !== undefined ? existing.original_genre : existing.genre ?? null;
        const existingOrigAlbumArtist =
          existing.original_album_artist !== undefined
            ? existing.original_album_artist
            : existing.album_artist ?? null;
        const existingOrigTrackNum =
          existing.original_track_number !== undefined
            ? existing.original_track_number
            : existing.track_number ?? null;
        const existingOrigDiscNum =
          existing.original_disc_number !== undefined
            ? existing.original_disc_number
            : existing.disc_number ?? null;
        const existingAvail = existing.availability_state ?? existing.status;

        const existingOrigComposer =
          existing.original_composer !== undefined
            ? existing.original_composer
            : existing.composer ?? null;
        const existingOrigLyricist =
          existing.original_lyricist !== undefined
            ? existing.original_lyricist
            : existing.lyricist ?? null;
        const existingOrigComment =
          existing.original_comment !== undefined
            ? existing.original_comment
            : existing.comment ?? null;
        const existingOrigTrackTotal =
          existing.original_track_total !== undefined
            ? existing.original_track_total
            : existing.track_total ?? null;
        const existingOrigDiscTotal =
          existing.original_disc_total !== undefined
            ? existing.original_disc_total
            : existing.disc_total ?? null;

        const nextRgTrack = item.replaygain_track_gain_db ?? null;
        const nextRgAlbum = item.replaygain_album_gain_db ?? null;
        const nextRgTrackPeak = item.replaygain_track_peak ?? null;
        const nextRgAlbumPeak = item.replaygain_album_peak ?? null;

        const wasMissing = existing.status === 'missing' && item.status === 'available';
        const hasChanges =
          wasMissing ||
          existing.status !== item.status ||
          existingAvail !== nextAvailState ||
          existing.original_path !== item.original_path ||
          existing.modified_at_ms !== item.modified_at_ms ||
          existing.file_size_bytes !== item.file_size_bytes ||
          existingOrigTitle !== item.title ||
          existingOrigArtist !== item.artist ||
          existingOrigAlbum !== item.album ||
          existingOrigYear !== nextYear ||
          existingOrigGenre !== (item.genre ?? null) ||
          existingOrigAlbumArtist !== (item.album_artist ?? null) ||
          existingOrigTrackNum !== (item.track_number ?? null) ||
          existingOrigTrackTotal !== (item.track_total ?? null) ||
          existingOrigDiscNum !== (item.disc_number ?? null) ||
          existingOrigDiscTotal !== (item.disc_total ?? null) ||
          existingOrigComposer !== (item.composer ?? null) ||
          existingOrigLyricist !== (item.lyricist ?? null) ||
          existingOrigComment !== (item.comment ?? null) ||
          (existing.channels ?? null) !== (item.channels ?? null) ||
          (existing.encoder ?? null) !== (item.encoder ?? null) ||
          (existing.file_name ?? null) !== nextFileName ||
          existing.duration_ms !== item.duration_ms ||
          existing.codec !== item.codec ||
          existing.container !== item.container ||
          existing.sample_rate_hz !== item.sample_rate_hz ||
          existing.bit_depth !== item.bit_depth ||
          existing.bitrate_bps !== item.bitrate_bps ||
          (existing.replaygain_track_gain_db ?? null) !== nextRgTrack ||
          (existing.replaygain_album_gain_db ?? null) !== nextRgAlbum ||
          (existing.replaygain_track_peak ?? null) !== nextRgTrackPeak ||
          (existing.replaygain_album_peak ?? null) !== nextRgAlbumPeak ||
          (existing.metadata_version ?? 1) !== nextMetadataVersion;

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
          genre: item.genre ?? null,
          year: nextYear,
          album_artist: item.album_artist ?? null,
          track_number: item.track_number ?? null,
          track_total: item.track_total ?? null,
          disc_number: item.disc_number ?? null,
          disc_total: item.disc_total ?? null,
          composer: item.composer ?? null,
          lyricist: item.lyricist ?? null,
          comment: item.comment ?? null,
          channels: item.channels ?? null,
          encoder: item.encoder ?? null,
          file_name: nextFileName,
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
          availability_state: nextAvailState,
          availability_reason: nextAvailReason,
          last_verified_at: nextVerifiedAt,
          metadata_version: nextMetadataVersion,
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

  updateStatus(
    id: string,
    status: TrackStatus,
    availabilityState?: TrackAvailabilityState,
    reason: string | null = null,
  ): boolean {
    const now = new Date().toISOString();
    const resolvedAvailability: TrackAvailabilityState =
      availabilityState ??
      (status === 'available' ? 'available' : status === 'error' ? 'access_error' : 'missing');
    const result = this.stmtUpdateStatus.run(
      status,
      resolvedAvailability,
      reason,
      now,
      now,
      id,
    );
    return result.changes > 0;
  }

  updateStatusesBatch(
    updates: ReadonlyArray<{
      id: string;
      status: TrackStatus;
      availability_state?: TrackAvailabilityState;
      availability_reason?: string | null;
    }>,
  ): number {
    if (updates.length === 0) {
      return 0;
    }

    const now = new Date().toISOString();
    let changed = 0;

    const tx = this.db.transaction(
      (
        items: ReadonlyArray<{
          id: string;
          status: TrackStatus;
          availability_state?: TrackAvailabilityState;
          availability_reason?: string | null;
        }>,
      ) => {
        for (const item of items) {
          const resolvedAvailability: TrackAvailabilityState =
            item.availability_state ??
            (item.status === 'available'
              ? 'available'
              : item.status === 'error'
                ? 'access_error'
                : 'missing');
          const result = this.stmtUpdateStatus.run(
            item.status,
            resolvedAvailability,
            item.availability_reason ?? null,
            now,
            now,
            item.id,
          );
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

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE tracks
      SET
        original_path = @original_path,
        normalized_path = @normalized_path,
        file_name = @file_name,
        file_size_bytes = @file_size_bytes,
        modified_at_ms = @modified_at_ms,
        status = 'available',
        availability_state = 'available',
        availability_reason = NULL,
        last_verified_at = @now,
        updated_at = @now
      WHERE id = @id
    `);
    const result = stmt.run({
      id: params.id,
      original_path: params.originalPath,
      normalized_path: params.normalizedPath,
      file_name: extractFileNameFromPath(params.originalPath),
      file_size_bytes: params.fileSizeBytes,
      modified_at_ms: params.modifiedAtMs,
      now,
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
