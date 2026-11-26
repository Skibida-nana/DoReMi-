import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface DatabaseIntegrityReport {
  ok: boolean;
  integrityOk: boolean;
  integrityMessages: string[];
  foreignKeyViolations: number;
  checkedAt: string;
  error?: string;
}

export interface DatabaseBackupResult {
  backupPath: string;
  bytes: number;
  integrity: DatabaseIntegrityReport;
}

export interface DatabaseRestoreResult {
  restoredPath: string;
  rollbackBackupPath: string | null;
  integrity: DatabaseIntegrityReport;
}

/**
 * Runs SQLite `PRAGMA integrity_check` and `PRAGMA foreign_key_check` cleanly
 * without modifying rows or blocking concurrent WAL readers.
 */
export function verifyDatabaseIntegrity(db: Database.Database): DatabaseIntegrityReport {
  const checkedAt = new Date().toISOString();
  try {
    const integrityRows = db.pragma('integrity_check') as Array<Record<string, unknown>>;
    const integrityMessages = integrityRows
      .map((row) => String(Object.values(row)[0] ?? ''))
      .filter((msg) => msg.length > 0);
    const integrityOk =
      integrityMessages.length === 1 && integrityMessages[0].toLowerCase() === 'ok';

    const fkRows = db.pragma('foreign_key_check') as unknown[];
    const foreignKeyViolations = Array.isArray(fkRows) ? fkRows.length : 0;

    return {
      ok: integrityOk && foreignKeyViolations === 0,
      integrityOk,
      integrityMessages,
      foreignKeyViolations,
      checkedAt,
    };
  } catch (error) {
    return {
      ok: false,
      integrityOk: false,
      integrityMessages: [],
      foreignKeyViolations: 0,
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Creates a WAL-safe consistent snapshot backup using SQLite Online Backup API (`db.backup`),
 * verifies the backup file via read-only `integrity_check`, then atomically commits it to `destinationPath`.
 */
export async function createDatabaseSnapshotBackup(
  db: Database.Database,
  destinationPath: string,
): Promise<DatabaseBackupResult> {
  if (!destinationPath || typeof destinationPath !== 'string') {
    throw new Error('Đường dẫn sao lưu cơ sở dữ liệu không hợp lệ.');
  }

  const resolvedDest = path.resolve(destinationPath);
  const parentDir = path.dirname(resolvedDest);
  fs.mkdirSync(parentDir, { recursive: true });

  const tempPath = `${resolvedDest}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await db.backup(tempPath);

    const verifyConn = new Database(tempPath, { readonly: true });
    let integrity: DatabaseIntegrityReport;
    try {
      integrity = verifyDatabaseIntegrity(verifyConn);
    } finally {
      verifyConn.close();
    }

    if (!integrity.ok) {
      throw new Error(
        `Bản sao lưu SQLite không đạt kiểm tra toàn vẹn: ${integrity.error ?? integrity.integrityMessages.join('; ')}`,
      );
    }

    fs.renameSync(tempPath, resolvedDest);
    const stat = fs.statSync(resolvedDest);
    return {
      backupPath: resolvedDest,
      bytes: stat.size,
      integrity,
    };
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

/**
 * Safely validates an existing SQLite backup file BEFORE restoring it over `targetDbPath`,
 * taking a rollback snapshot first and cleaning stale `-wal` / `-shm` sidecar files.
 */
export function restoreDatabaseBackupSafely(
  backupPath: string,
  targetDbPath: string,
): DatabaseRestoreResult {
  const resolvedBackup = path.resolve(backupPath);
  const resolvedTarget = path.resolve(targetDbPath);

  if (!fs.existsSync(resolvedBackup)) {
    throw new Error('File sao lưu cơ sở dữ liệu không tồn tại.');
  }
  const backupStat = fs.statSync(resolvedBackup);
  if (!backupStat.isFile() || backupStat.size === 0) {
    throw new Error('File sao lưu cơ sở dữ liệu bị rỗng hoặc không hợp lệ.');
  }

  let verifyReport: DatabaseIntegrityReport;
  const probe = new Database(resolvedBackup, { readonly: true });
  try {
    verifyReport = verifyDatabaseIntegrity(probe);
  } finally {
    probe.close();
  }

  if (!verifyReport.ok) {
    throw new Error(
      `File sao lưu bị lỗi toàn vẹn (${verifyReport.error ?? verifyReport.integrityMessages.join('; ')}); hủy khôi phục để bảo vệ dữ liệu hiện tại.`,
    );
  }

  fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
  let rollbackBackupPath: string | null = null;
  if (fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).size > 0) {
    rollbackBackupPath = `${resolvedTarget}.pre-restore-${Date.now()}`;
    fs.copyFileSync(resolvedTarget, rollbackBackupPath);
  }

  const stagedRestorePath = `${resolvedTarget}.restore-tmp-${process.pid}`;
  try {
    fs.copyFileSync(resolvedBackup, stagedRestorePath);
    fs.rmSync(`${resolvedTarget}-wal`, { force: true });
    fs.rmSync(`${resolvedTarget}-shm`, { force: true });
    fs.renameSync(stagedRestorePath, resolvedTarget);
  } catch (error) {
    fs.rmSync(stagedRestorePath, { force: true });
    throw error;
  }

  // Re-verify target database after swap
  const finalProbe = new Database(resolvedTarget, { readonly: true });
  let finalIntegrity: DatabaseIntegrityReport;
  try {
    finalIntegrity = verifyDatabaseIntegrity(finalProbe);
  } finally {
    finalProbe.close();
  }

  if (!finalIntegrity.ok) {
    if (rollbackBackupPath && fs.existsSync(rollbackBackupPath)) {
      fs.copyFileSync(rollbackBackupPath, resolvedTarget);
    }
    throw new Error('Khôi phục thất bại sau khi ghi file đích; đã hoàn tác về bản trước đó.');
  }

  return {
    restoredPath: resolvedTarget,
    rollbackBackupPath,
    integrity: finalIntegrity,
  };
}
