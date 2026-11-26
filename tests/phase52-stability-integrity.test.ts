import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openLibraryDatabase } from '../src/main/database/connection';
import {
  createDatabaseSnapshotBackup,
  restoreDatabaseBackupSafely,
  verifyDatabaseIntegrity,
} from '../src/main/database/integrity';
import {
  createCrashRecoveryLimiter,
  formatUnexpectedErrorDetail,
  isIgnorableAbortError,
  writeBoundedCrashDumpSync,
} from '../src/main/utils/runtime-resilience';

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function seedSampleTrack(db: Database.Database, trackId: string, title = 'Bài Hát Thử Nghiệm'): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tracks (
      id, original_path, normalized_path, file_name, title, artist, album,
      container, codec, duration_ms, sample_rate_hz, bit_depth, bitrate_bps, channels,
      file_size_bytes, modified_at_ms, status, added_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    trackId,
    `C:\\Music\\${trackId}.flac`,
    `c:\\music\\${trackId}.flac`,
    `${trackId}.flac`,
    title,
    'Nghệ Sĩ Việt',
    'Album Lossless',
    'FLAC',
    'FLAC',
    215_000,
    96_000,
    24,
    2_800_000,
    2,
    45_000_000,
    1_700_000_000_000,
    'available',
    now,
    now,
  );
}

test('Phase 5.2A: formatUnexpectedErrorDetail, AbortError classification, crash recovery cooldown & bounded crash log rotation', async (t) => {
  const tmpDir = await createTempDir('doremi-p52-resilience-');
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const circular: Record<string, unknown> = { label: 'loop' };
  circular.self = circular;
  const serializedCircular = formatUnexpectedErrorDetail(circular);
  assert.equal(serializedCircular.name, 'NonErrorThrow');
  assert.ok(serializedCircular.message.length > 0);

  const errDetail = formatUnexpectedErrorDetail(new TypeError('Broken pipe\u0000detail'));
  assert.equal(errDetail.name, 'TypeError');
  assert.ok(!errDetail.message.includes('\u0000'));

  assert.equal(isIgnorableAbortError(Object.assign(new Error('aborted'), { name: 'AbortError' })), true);
  assert.equal(isIgnorableAbortError(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })), true);
  assert.equal(isIgnorableAbortError(new Error('Disk I/O failure')), false);

  const limiter = createCrashRecoveryLimiter(15_000);
  assert.equal(limiter.canAutoRecover(1000), true);
  assert.equal(limiter.canAutoRecover(5000), false);
  assert.equal(limiter.canAutoRecover(16_000), true);

  // Fill >512 KB to verify log rotation keeps disk usage bounded
  const largeMsg = 'X'.repeat(580);
  for (let i = 0; i < 1000; i += 1) {
    const ok = writeBoundedCrashDumpSync(tmpDir, {
      kind: 'unhandledRejection',
      timestamp: '2026-11-26T00:00:00.000Z',
      detail: { name: 'StressError', message: `${i}-${largeMsg}` },
    });
    assert.equal(ok, true);
  }

  const mainCrashLog = path.join(tmpDir, 'logs', 'main-crash.log');
  const rotatedCrashLog = path.join(tmpDir, 'logs', 'main-crash.1.log');
  const [statMain, statRotated] = await Promise.all([fs.stat(mainCrashLog), fs.stat(rotatedCrashLog)]);
  assert.ok(statRotated.size >= 512 * 1024);
  assert.ok(statMain.size > 0 && statMain.size < 512 * 1024 + 4096);
});

test('Phase 5.2B: SQLite integrity check, FK check, WAL-safe Online Backup, Safe Restore & Corruption Isolation', async (t) => {
  const tmpDir = await createTempDir('doremi-p52-db-');
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const dbPath = path.join(tmpDir, 'Thư viện nhạc', 'library.db');
  const conn = openLibraryDatabase(dbPath);
  try {
    assert.equal(conn.integrity.ok, true);
    assert.equal(conn.integrity.integrityOk, true);
    assert.equal(conn.integrity.foreignKeyViolations, 0);

    const trackId = '11111111-1111-4111-8111-111111111111';
    seedSampleTrack(conn.db, trackId, 'Dữ liệu nguyên vẹn 24-bit');

    // Verify clean integrity with populated data + WAL active
    const preBackupReport = verifyDatabaseIntegrity(conn.db);
    assert.equal(preBackupReport.ok, true);

    const backupPath = path.join(tmpDir, 'backups', 'doremi-snapshot-Việt.db');
    const backupRes = await createDatabaseSnapshotBackup(conn.db, backupPath);
    assert.equal(backupRes.integrity.ok, true);
    assert.ok(backupRes.bytes > 0);

    // Mutate DB further after backup (delete track + insert different one), then restore backup
    conn.db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId);
    const secondId = '22222222-2222-4222-8222-222222222222';
    seedSampleTrack(conn.db, secondId, 'Bản ghi tạm sau backup');

    // Attempt restore from an explicitly corrupted backup file MUST reject & preserve live DB!
    const corruptBackupPath = path.join(tmpDir, 'backups', 'corrupt.db');
    await fs.writeFile(corruptBackupPath, Buffer.from('NOT A SQLITE DATABASE BYTES', 'utf8'));
    assert.throws(() => restoreDatabaseBackupSafely(corruptBackupPath, dbPath));
    const stillHasSecond = conn.db
      .prepare('SELECT id FROM tracks WHERE id = ?')
      .get(secondId) as { id: string } | undefined;
    assert.equal(stillHasSecond?.id, secondId);

    conn.close();

    // Valid restore swaps back original track cleanly and cleans WAL sidecars
    const restoreRes = restoreDatabaseBackupSafely(backupPath, dbPath);
    assert.equal(restoreRes.integrity.ok, true);
    assert.ok(restoreRes.rollbackBackupPath);

    const reopened = openLibraryDatabase(dbPath);
    try {
      assert.equal(reopened.integrity.ok, true);
      const restoredTrack = reopened.db
        .prepare('SELECT title FROM tracks WHERE id = ?')
        .get(trackId) as { title: string } | undefined;
      assert.equal(restoredTrack?.title, 'Dữ liệu nguyên vẹn 24-bit');

      const missingSecond = reopened.db
        .prepare('SELECT id FROM tracks WHERE id = ?')
        .get(secondId);
      assert.equal(missingSecond, undefined);

      // Simulate FK violation detected cleanly by verifyDatabaseIntegrity
      reopened.db.pragma('foreign_keys = OFF');
      reopened.db
        .prepare(
          `INSERT INTO favorites (track_id, added_at) VALUES (?, ?)`,
        )
        .run('99999999-9999-4999-8999-999999999999', new Date().toISOString());
      reopened.db.pragma('foreign_keys = ON');

      const fkReport = verifyDatabaseIntegrity(reopened.db);
      assert.equal(fkReport.integrityOk, true);
      assert.equal(fkReport.foreignKeyViolations, 1);
      assert.equal(fkReport.ok, false);
    } finally {
      reopened.close();
    }
  } finally {
    conn.close();
  }
});

test('Phase 5.2B: Interrupted WAL write & reopen preserves committed records cleanly', async (t) => {
  const tmpDir = await createTempDir('doremi-p52-wal-');
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const dbPath = path.join(tmpDir, 'wal-test.db');
  const first = openLibraryDatabase(dbPath);
  const trackId = '33333333-3333-4333-8333-333333333333';
  seedSampleTrack(first.db, trackId, 'WAL Committed Track');

  // Uncommitted transaction rollback leaves DB consistent
  assert.throws(() => {
    const tx = first.db.transaction(() => {
      seedSampleTrack(first.db, '44444444-4444-4444-8444-444444444444', 'Should Rollback');
      throw new Error('Simulated abrupt power/process error mid-tx');
    });
    tx();
  });
  first.close();

  const second = openLibraryDatabase(dbPath);
  try {
    assert.equal(second.integrity.ok, true);
    const rows = second.db.prepare('SELECT id, title FROM tracks').all() as Array<{
      id: string;
      title: string;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, trackId);
  } finally {
    second.close();
  }
});
