import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { LibraryExclusionRecord } from '../../shared/types/library';

export interface UpsertExclusionInput {
  normalized_path: string;
  original_path: string;
  root_id: string | null;
  file_size_bytes: number | null;
  modified_at_ms: number | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  reason?: string;
}

/**
 * Determines whether a discovered file on disk matches a stored exclusion record.
 * - If size + mtime were recorded when the track was excluded and both match the file on disk,
 *   the file is treated as the exact same removed file and skipped during automatic rescan.
 * - If the file on disk was genuinely replaced by a different file (different size or mtime),
 *   returns false so the newly placed file is not permanently hidden.
 * - If size/mtime were unavailable when excluded (e.g. missing track), path match excludes it
 *   until the user explicitly reimports it.
 */
export function matchesExclusionFingerprint(
  exclusion: LibraryExclusionRecord,
  fileSizeBytes: number | null,
  modifiedAtMs: number | null,
): boolean {
  if (
    exclusion.file_size_bytes !== null &&
    exclusion.modified_at_ms !== null &&
    fileSizeBytes !== null &&
    modifiedAtMs !== null
  ) {
    return (
      exclusion.file_size_bytes === fileSizeBytes &&
      exclusion.modified_at_ms === modifiedAtMs
    );
  }
  return true;
}

export class ExclusionRepository {
  private readonly stmtFindAll: Database.Statement;
  private readonly stmtFindById: Database.Statement;
  private readonly stmtFindByNormalizedPath: Database.Statement;
  private readonly stmtUpsert: Database.Statement;
  private readonly stmtDeleteById: Database.Statement;
  private readonly stmtDeleteByNormalizedPath: Database.Statement;
  private readonly stmtClearAll: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.stmtFindAll = db.prepare(`
      SELECT
        id,
        normalized_path,
        original_path,
        root_id,
        file_size_bytes,
        modified_at_ms,
        title,
        artist,
        album,
        reason,
        excluded_at
      FROM library_exclusions
      ORDER BY excluded_at DESC
    `);

    this.stmtFindById = db.prepare(`
      SELECT
        id,
        normalized_path,
        original_path,
        root_id,
        file_size_bytes,
        modified_at_ms,
        title,
        artist,
        album,
        reason,
        excluded_at
      FROM library_exclusions
      WHERE id = ?
    `);

    this.stmtFindByNormalizedPath = db.prepare(`
      SELECT
        id,
        normalized_path,
        original_path,
        root_id,
        file_size_bytes,
        modified_at_ms,
        title,
        artist,
        album,
        reason,
        excluded_at
      FROM library_exclusions
      WHERE normalized_path = ?
    `);

    this.stmtUpsert = db.prepare(`
      INSERT INTO library_exclusions (
        id,
        normalized_path,
        original_path,
        root_id,
        file_size_bytes,
        modified_at_ms,
        title,
        artist,
        album,
        reason,
        excluded_at
      ) VALUES (
        @id,
        @normalized_path,
        @original_path,
        @root_id,
        @file_size_bytes,
        @modified_at_ms,
        @title,
        @artist,
        @album,
        @reason,
        @excluded_at
      )
      ON CONFLICT(normalized_path) DO UPDATE SET
        original_path = excluded.original_path,
        root_id = excluded.root_id,
        file_size_bytes = excluded.file_size_bytes,
        modified_at_ms = excluded.modified_at_ms,
        title = excluded.title,
        artist = excluded.artist,
        album = excluded.album,
        reason = excluded.reason,
        excluded_at = excluded.excluded_at
    `);

    this.stmtDeleteById = db.prepare('DELETE FROM library_exclusions WHERE id = ?');
    this.stmtDeleteByNormalizedPath = db.prepare(
      'DELETE FROM library_exclusions WHERE normalized_path = ?',
    );
    this.stmtClearAll = db.prepare('DELETE FROM library_exclusions');
  }

  findAll(): LibraryExclusionRecord[] {
    return this.stmtFindAll.all() as LibraryExclusionRecord[];
  }

  findById(id: string): LibraryExclusionRecord | null {
    const row = this.stmtFindById.get(id) as LibraryExclusionRecord | undefined;
    return row ?? null;
  }

  findByIds(ids: readonly string[]): LibraryExclusionRecord[] {
    if (ids.length === 0) {
      return [];
    }
    const result: LibraryExclusionRecord[] = [];
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

  findByNormalizedPath(normalizedPath: string): LibraryExclusionRecord | null {
    const row = this.stmtFindByNormalizedPath.get(normalizedPath) as
      | LibraryExclusionRecord
      | undefined;
    return row ?? null;
  }

  upsertOne(input: UpsertExclusionInput, nowIso = new Date().toISOString()): void {
    this.stmtUpsert.run({
      id: crypto.randomUUID(),
      normalized_path: input.normalized_path,
      original_path: input.original_path,
      root_id: input.root_id,
      file_size_bytes: input.file_size_bytes,
      modified_at_ms: input.modified_at_ms,
      title: input.title,
      artist: input.artist,
      album: input.album,
      reason: input.reason ?? 'user-removed',
      excluded_at: nowIso,
    });
  }

  upsertBatch(inputs: readonly UpsertExclusionInput[]): number {
    if (inputs.length === 0) {
      return 0;
    }
    const nowIso = new Date().toISOString();
    const tx = this.db.transaction((rows: readonly UpsertExclusionInput[]) => {
      for (const row of rows) {
        this.upsertOne(row, nowIso);
      }
      return rows.length;
    });
    return tx(inputs);
  }

  deleteById(id: string): boolean {
    return this.stmtDeleteById.run(id).changes > 0;
  }

  deleteByIds(ids: readonly string[]): number {
    if (ids.length === 0) {
      return 0;
    }
    const tx = this.db.transaction((targetIds: readonly string[]) => {
      let deleted = 0;
      for (const id of targetIds) {
        deleted += this.stmtDeleteById.run(id).changes;
      }
      return deleted;
    });
    return tx(ids);
  }

  deleteByNormalizedPaths(normalizedPaths: readonly string[]): number {
    if (normalizedPaths.length === 0) {
      return 0;
    }
    const tx = this.db.transaction((paths: readonly string[]) => {
      let deleted = 0;
      for (const p of paths) {
        deleted += this.stmtDeleteByNormalizedPath.run(p).changes;
      }
      return deleted;
    });
    return tx(normalizedPaths);
  }

  clearAll(): number {
    return this.stmtClearAll.run().changes;
  }
}
