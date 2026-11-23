import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { LibraryRootRecord, LibraryRootStatus } from '../../shared/types/library';

export class LibraryRootRepository {
  private readonly stmtFindAll: Database.Statement;
  private readonly stmtFindByNormalizedPath: Database.Statement;
  private readonly stmtInsertRoot: Database.Statement;
  private readonly stmtUpdateScanState: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtFindAll = db.prepare(`
      SELECT id, original_path, normalized_path, added_at, last_scanned_at, status
      FROM library_roots
      ORDER BY added_at ASC
    `);

    this.stmtFindByNormalizedPath = db.prepare(`
      SELECT id, original_path, normalized_path, added_at, last_scanned_at, status
      FROM library_roots
      WHERE normalized_path = ?
    `);

    this.stmtInsertRoot = db.prepare(`
      INSERT INTO library_roots (
        id,
        original_path,
        normalized_path,
        added_at,
        last_scanned_at,
        status
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.stmtUpdateScanState = db.prepare(`
      UPDATE library_roots
      SET original_path = ?, last_scanned_at = ?, status = ?
      WHERE id = ?
    `);
  }

  findAll(): LibraryRootRecord[] {
    return this.stmtFindAll.all() as LibraryRootRecord[];
  }

  findByNormalizedPath(normalizedPath: string): LibraryRootRecord | null {
    const row = this.stmtFindByNormalizedPath.get(normalizedPath) as
      | LibraryRootRecord
      | undefined;
    return row ?? null;
  }

  upsertRoot(originalPath: string, normalizedPath: string): LibraryRootRecord {
    const now = new Date().toISOString();
    const existing = this.findByNormalizedPath(normalizedPath);

    if (existing) {
      this.stmtUpdateScanState.run(originalPath, now, 'available', existing.id);
      return {
        ...existing,
        original_path: originalPath,
        last_scanned_at: now,
        status: 'available',
      };
    }

    const id = crypto.randomUUID();
    this.stmtInsertRoot.run(id, originalPath, normalizedPath, now, now, 'available');

    return {
      id,
      original_path: originalPath,
      normalized_path: normalizedPath,
      added_at: now,
      last_scanned_at: now,
      status: 'available',
    };
  }

  markScanState(id: string, originalPath: string, status: LibraryRootStatus): void {
    this.stmtUpdateScanState.run(originalPath, new Date().toISOString(), status, id);
  }

  findById(id: string): LibraryRootRecord | null {
    const row = this.stmtFindAll.all() as LibraryRootRecord[];
    return row.find((item) => item.id === id) ?? null;
  }

  deleteRoot(id: string): boolean {
    const stmt = this.stmtFindByNormalizedPath.database.prepare(
      'DELETE FROM library_roots WHERE id = ?',
    );
    const result = stmt.run(id);
    return result.changes > 0;
  }
}
