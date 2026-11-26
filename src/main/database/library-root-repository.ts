import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { LibraryRootRecord, LibraryRootStatus } from '../../shared/types/library';
import type { TrackAvailabilityState } from '../../shared/types/track';

interface LibraryRootRawRow {
  id: string;
  original_path: string;
  normalized_path: string;
  added_at: string;
  last_scanned_at: string | null;
  status: LibraryRootStatus;
  availability_state: TrackAvailabilityState | null;
  availability_reason: string | null;
  recursive: number | null;
  enabled: number | null;
  auto_watch: number | null;
  last_successful_scan_at: string | null;
}

function mapRootRow(row: LibraryRootRawRow): LibraryRootRecord {
  return {
    id: row.id,
    original_path: row.original_path,
    normalized_path: row.normalized_path,
    added_at: row.added_at,
    last_scanned_at: row.last_scanned_at,
    status: row.status,
    availability_state:
      row.availability_state ?? (row.status === 'missing' ? 'source_unavailable' : 'available'),
    availability_reason: row.availability_reason ?? null,
    recursive: row.recursive !== 0,
    enabled: row.enabled !== 0,
    auto_watch: row.auto_watch !== 0,
    last_successful_scan_at: row.last_successful_scan_at ?? row.last_scanned_at ?? null,
  };
}

export class LibraryRootRepository {
  private readonly stmtFindAll: Database.Statement;
  private readonly stmtFindByNormalizedPath: Database.Statement;
  private readonly stmtFindById: Database.Statement;
  private readonly stmtInsertRoot: Database.Statement;
  private readonly stmtUpdateScanState: Database.Statement;

  constructor(private readonly db: Database.Database) {
    const cols = `
      id,
      original_path,
      normalized_path,
      added_at,
      last_scanned_at,
      status,
      availability_state,
      availability_reason,
      recursive,
      enabled,
      auto_watch,
      last_successful_scan_at
    `;

    this.stmtFindAll = db.prepare(`
      SELECT ${cols}
      FROM library_roots
      ORDER BY added_at ASC
    `);

    this.stmtFindByNormalizedPath = db.prepare(`
      SELECT ${cols}
      FROM library_roots
      WHERE normalized_path = ?
    `);

    this.stmtFindById = db.prepare(`
      SELECT ${cols}
      FROM library_roots
      WHERE id = ?
    `);

    this.stmtInsertRoot = db.prepare(`
      INSERT INTO library_roots (
        id,
        original_path,
        normalized_path,
        added_at,
        last_scanned_at,
        status,
        availability_state,
        availability_reason,
        recursive,
        enabled,
        auto_watch,
        last_successful_scan_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?)
    `);

    this.stmtUpdateScanState = db.prepare(`
      UPDATE library_roots
      SET
        original_path = ?,
        last_scanned_at = ?,
        status = ?,
        availability_state = ?,
        availability_reason = ?,
        last_successful_scan_at = COALESCE(?, last_successful_scan_at)
      WHERE id = ?
    `);
  }

  findAll(): LibraryRootRecord[] {
    const rows = this.stmtFindAll.all() as LibraryRootRawRow[];
    return rows.map(mapRootRow);
  }

  findByNormalizedPath(normalizedPath: string): LibraryRootRecord | null {
    const row = this.stmtFindByNormalizedPath.get(normalizedPath) as
      | LibraryRootRawRow
      | undefined;
    return row ? mapRootRow(row) : null;
  }

  upsertRoot(originalPath: string, normalizedPath: string): LibraryRootRecord {
    const now = new Date().toISOString();
    const existing = this.findByNormalizedPath(normalizedPath);

    if (existing) {
      this.stmtUpdateScanState.run(
        originalPath,
        now,
        'available',
        'available',
        null,
        now,
        existing.id,
      );
      return {
        ...existing,
        original_path: originalPath,
        last_scanned_at: now,
        last_successful_scan_at: now,
        status: 'available',
        availability_state: 'available',
        availability_reason: null,
      };
    }

    const id = crypto.randomUUID();
    this.stmtInsertRoot.run(
      id,
      originalPath,
      normalizedPath,
      now,
      now,
      'available',
      'available',
      null,
      now,
    );

    return {
      id,
      original_path: originalPath,
      normalized_path: normalizedPath,
      added_at: now,
      last_scanned_at: now,
      status: 'available',
      availability_state: 'available',
      availability_reason: null,
      recursive: true,
      enabled: true,
      auto_watch: true,
      last_successful_scan_at: now,
    };
  }

  markScanState(
    id: string,
    originalPath: string,
    status: LibraryRootStatus,
    options?: {
      availabilityState?: TrackAvailabilityState;
      availabilityReason?: string | null;
      succeeded?: boolean;
    },
  ): void {
    const now = new Date().toISOString();
    const availabilityState =
      options?.availabilityState ??
      (status === 'missing' ? 'source_unavailable' : 'available');
    const availabilityReason =
      options?.availabilityReason !== undefined ? options.availabilityReason : null;
    const successTs =
      options?.succeeded === true || (options?.succeeded !== false && status === 'available')
        ? now
        : null;
    this.stmtUpdateScanState.run(
      originalPath,
      now,
      status,
      availabilityState,
      availabilityReason,
      successTs,
      id,
    );
  }

  updateRootSettings(
    id: string,
    patch: { recursive?: boolean; enabled?: boolean; auto_watch?: boolean },
  ): LibraryRootRecord | null {
    const existing = this.findById(id);
    if (!existing) {
      return null;
    }
    const recursive = patch.recursive !== undefined ? (patch.recursive ? 1 : 0) : existing.recursive === false ? 0 : 1;
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled === false ? 0 : 1;
    const autoWatch = patch.auto_watch !== undefined ? (patch.auto_watch ? 1 : 0) : existing.auto_watch === false ? 0 : 1;
    this.db
      .prepare(
        `UPDATE library_roots SET recursive = ?, enabled = ?, auto_watch = ? WHERE id = ?`,
      )
      .run(recursive, enabled, autoWatch, id);
    return this.findById(id);
  }

  findById(id: string): LibraryRootRecord | null {
    const row = this.stmtFindById.get(id) as LibraryRootRawRow | undefined;
    return row ? mapRootRow(row) : null;
  }

  deleteRoot(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM library_roots WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  deleteAllRoots(): number {
    const stmt = this.db.prepare('DELETE FROM library_roots');
    return stmt.run().changes;
  }
}
