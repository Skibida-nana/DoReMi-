import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { verifyDatabaseIntegrity, type DatabaseIntegrityReport } from './integrity';
import { hasPendingMigrations, runMigrations } from './migrations';

export interface DatabaseConnection {
  readonly db: Database.Database;
  readonly dbPath: string;
  readonly backupPath: string | null;
  readonly sqliteVersion: string;
  readonly integrity: DatabaseIntegrityReport;
  close(): void;
}

function createSafeMigrationBackup(db: Database.Database, dbPath: string): string | null {
  if (dbPath === ':memory:' || !fs.existsSync(dbPath)) {
    return null;
  }

  const stat = fs.statSync(dbPath);
  if (stat.size === 0) {
    return null;
  }

  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Non-fatal: proceed with direct file copy
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.backup-before-migration-${stamp}`;
  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
}

/**
 * Opens the local SQLite database at the specified path (Electron userData in production,
 * or a temp directory in automated tests), enforces WAL + foreign_keys, creates an automatic
 * backup before migrating an existing DB, and runs pending migrations.
 */
export function openLibraryDatabase(dbPath: string): DatabaseConnection {
  if (!dbPath || typeof dbPath !== 'string') {
    throw new Error('Database path must be a non-empty string.');
  }

  const existedBeforeOpen =
    dbPath !== ':memory:' && fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;

  const parentDir = path.dirname(dbPath);
  if (dbPath !== ':memory:') {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Enforce relational integrity and safe concurrent reads/writes
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  let backupPath: string | null = null;
  if (existedBeforeOpen && hasPendingMigrations(db)) {
    backupPath = createSafeMigrationBackup(db, dbPath);
  }

  runMigrations(db);
  const integrity = verifyDatabaseIntegrity(db);
  let sqliteVersion = '3.x';
  try {
    const row = db.prepare('SELECT sqlite_version() AS version').get() as
      | { version?: string }
      | undefined;
    if (row?.version) {
      sqliteVersion = row.version;
    }
  } catch {
    // Non-fatal fallback
  }

  return {
    db,
    dbPath,
    backupPath,
    sqliteVersion,
    integrity,
    close(): void {
      if (db.open) {
        if (dbPath !== ':memory:' && !db.readonly) {
          try {
            db.pragma('wal_checkpoint(PASSIVE)');
          } catch {
            // Best-effort WAL flush during shutdown
          }
        }
        db.close();
      }
    },
  };
}
