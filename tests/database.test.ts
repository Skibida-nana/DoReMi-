import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { openLibraryDatabase } from '../src/main/database/connection';
import { MIGRATIONS, runMigrations } from '../src/main/database/migrations';
import { LibraryRootRepository } from '../src/main/database/library-root-repository';
import { TrackRepository } from '../src/main/database/track-repository';

function createTempDbPath(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lossless-player-db-'));
  return { dir, dbPath: path.join(dir, 'library.db') };
}

test('SQLite opens with foreign_keys ON, WAL mode, and applies idempotent v1+v2 migrations', () => {
  const { dir, dbPath } = createTempDbPath();
  try {
    const conn = openLibraryDatabase(dbPath);
    try {
      const fk = conn.db.pragma('foreign_keys', { simple: true });
      const journalMode = String(conn.db.pragma('journal_mode', { simple: true })).toLowerCase();
      assert.equal(fk, 1);
      assert.equal(journalMode, 'wal');

      const applied1 = runMigrations(conn.db);
      const applied2 = runMigrations(conn.db);
      assert.equal(applied1.length, MIGRATIONS.length);
      assert.equal(applied2.length, MIGRATIONS.length);
      assert.equal(applied1[0].name, '001_initial_library_schema');
      assert.equal(applied1[1].name, '002_stage3_artwork_lyrics_metadata_overrides');
      assert.equal(applied1[2].name, '003_stage5_profile_preferences_stats');
      assert.equal(applied1[3].name, '004_stage6_replaygain_watcher_backup');
      assert.equal(applied1[4].name, '005_phase8_library_exclusions');
      assert.equal(applied1[5].name, '006_phase3_library_sources_availability_metadata');
      assert.equal(applied1[6].name, '007_phase3_playlists_favorites_and_demo_cleanup');
    } finally {
      conn.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite creates automatic backup file before applying v2 migration to existing v1 database', () => {
  const { dir, dbPath } = createTempDbPath();
  try {
    // Bootstrap a legacy v1-only SQLite file
    const rawDb = new Database(dbPath);
    try {
      rawDb.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      MIGRATIONS[0].up(rawDb);
      rawDb
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(1, MIGRATIONS[0].name, new Date().toISOString());
      rawDb
        .prepare(
          `INSERT INTO tracks (id, original_path, normalized_path, title, artist, album, status, added_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?)`,
        )
        .run(
          '11111111-1111-4111-8111-111111111111',
          'D:\\Music\\Legacy.flac',
          'd:\\music\\legacy.flac',
          'Legacy Song',
          'Legacy Artist',
          'Legacy Album',
          new Date().toISOString(),
          new Date().toISOString(),
        );
    } finally {
      rawDb.close();
    }

    // Reopen through openLibraryDatabase -> must create backup BEFORE applying v2 and preserve legacy track
    const conn = openLibraryDatabase(dbPath);
    try {
      assert.ok(conn.backupPath, 'Expected an automatic backup path before running v2 migration');
      assert.equal(fs.existsSync(conn.backupPath), true);

      const trackRepo = new TrackRepository(conn.db);
      const migrated = trackRepo.findById('11111111-1111-4111-8111-111111111111');
      assert.ok(migrated);
      assert.equal(migrated.title, 'Legacy Song');
      assert.equal(migrated.original_title, 'Legacy Song');
    } finally {
      conn.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite persists tracks and roots across close/reopen and preserves UUID on upsert', () => {
  const { dir, dbPath } = createTempDbPath();
  try {
    let originalUuid = '';

    const conn1 = openLibraryDatabase(dbPath);
    try {
      const trackRepo = new TrackRepository(conn1.db);
      const rootRepo = new LibraryRootRepository(conn1.db);

      rootRepo.upsertRoot('D:\\Nhạc Lossless', 'd:\\nhạc lossless');

      const res1 = trackRepo.upsertBatch([
        {
          original_path: 'D:\\Nhạc Lossless\\Bài 1.flac',
          normalized_path: 'd:\\nhạc lossless\\bài 1.flac',
          title: 'Bài 1',
          artist: 'Nghệ sĩ A',
          album: 'Album Đầu Tiên',
          duration_ms: 215000,
          codec: 'FLAC',
          container: 'FLAC',
          sample_rate_hz: 96000,
          bit_depth: 24,
          bitrate_bps: 2800000,
          file_size_bytes: 54000000,
          modified_at_ms: 1700000000000,
          status: 'available',
        },
      ]);

      assert.equal(res1.addedCount, 1);
      const inserted = trackRepo.findByNormalizedPath('d:\\nhạc lossless\\bài 1.flac');
      assert.ok(inserted);
      originalUuid = inserted.id;

      // Re-upsert same normalized_path with updated title -> must preserve UUID
      const res2 = trackRepo.upsertBatch([
        {
          original_path: 'D:\\Nhạc Lossless\\Bài 1.flac',
          normalized_path: 'd:\\nhạc lossless\\bài 1.flac',
          title: 'Bài 1 (Remastered)',
          artist: 'Nghệ sĩ A',
          album: 'Album Đầu Tiên',
          duration_ms: 215000,
          codec: 'FLAC',
          container: 'FLAC',
          sample_rate_hz: 96000,
          bit_depth: 24,
          bitrate_bps: 2800000,
          file_size_bytes: 54000128,
          modified_at_ms: 1700000005000,
          status: 'available',
        },
      ]);

      assert.equal(res2.addedCount, 0);
      assert.equal(res2.updatedCount, 1);
    } finally {
      conn1.close();
    }

    // Reopen database from disk (simulates restarting Electron app)
    const conn2 = openLibraryDatabase(dbPath);
    try {
      const trackRepo = new TrackRepository(conn2.db);
      const rootRepo = new LibraryRootRepository(conn2.db);

      const tracks = trackRepo.findAll();
      const roots = rootRepo.findAll();

      assert.equal(tracks.length, 1);
      assert.equal(tracks[0].id, originalUuid);
      assert.equal(tracks[0].title, 'Bài 1 (Remastered)');
      assert.equal(roots.length, 1);
      assert.equal(roots[0].original_path, 'D:\\Nhạc Lossless');
    } finally {
      conn2.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite creates automatic backup and preserves RC.6 v9 Connect data when migrating v9 -> v10', () => {
  const { dir, dbPath } = createTempDbPath();
  try {
    const now = new Date().toISOString();
    const rawDb = new Database(dbPath);
    try {
      rawDb.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const m of MIGRATIONS.slice(0, 9)) {
        m.up(rawDb);
        rawDb
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(m.version, m.name, now);
      }

      rawDb
        .prepare(
          `INSERT INTO library_roots (id, original_path, normalized_path, added_at, status)
           VALUES (?, ?, ?, ?, 'available')`,
        )
        .run('root-rc6-1', 'D:\\RC6Music', 'd:\\rc6music', now);

      rawDb
        .prepare(
          `INSERT INTO connect_host_config (id, enabled, auto_start, display_name, port, bind_address, max_active_clients, max_requests_per_device, max_global_requests, updated_at)
           VALUES (1, 1, 0, 'My RC6 Desktop', 48620, 'auto-private', 3, 4, 12, ?)`,
        )
        .run(now);

      rawDb
        .prepare(
          `INSERT INTO connect_shared_sources (id, root_id, enabled, added_at)
           VALUES (?, ?, 1, ?)`,
        )
        .run('src-rc6-1', 'root-rc6-1', now);

      rawDb
        .prepare(
          `INSERT INTO connect_authorized_devices (device_id, display_name, platform, auth_state, token_hash, token_salt, enrolled_at)
           VALUES (?, ?, 'win32', 'authorized', ?, ?, ?)`,
        )
        .run('dev-rc6-1', 'RC6 Laptop', 'hash-abc', 'salt-xyz', now);

      rawDb
        .prepare(
          `INSERT INTO connect_remembered_hosts (host_id, display_name, last_address, port, pinned_fingerprint, short_fingerprint, device_id, api_version, credential_ref, created_at, updated_at)
           VALUES (?, ?, '192.168.1.50', 48620, 'sha256:deadbeef', 'deadbeef', 'dev-self-1', '1', 'cred-ref-1', ?, ?)`,
        )
        .run('host-rc6-1', 'Living Room Host', now, now);
    } finally {
      rawDb.close();
    }

    const conn = openLibraryDatabase(dbPath);
    try {
      assert.ok(conn.backupPath, 'Expected automatic pre-migration SQLite backup before v9 -> v10 upgrade');
      assert.equal(fs.existsSync(conn.backupPath), true);

      const applied = conn.db
        .prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC')
        .all() as Array<{ version: number; name: string }>;
      assert.equal(applied.length, MIGRATIONS.length);
      assert.equal(applied[applied.length - 1].version, 10);

      const hostCfg = conn.db.prepare('SELECT * FROM connect_host_config WHERE id = 1').get() as any;
      assert.equal(hostCfg.display_name, 'My RC6 Desktop');
      assert.equal(hostCfg.remote_provider, 'tailscale-funnel');
      assert.equal(hostCfg.remote_public_port, 443);
      assert.equal(hostCfg.remote_mount_path, '/doremi-connect');
      assert.equal(hostCfg.remote_endpoint_generation, 1);

      const sharedSrc = conn.db.prepare('SELECT * FROM connect_shared_sources WHERE id = ?').get('src-rc6-1') as any;
      assert.equal(sharedSrc.root_id, 'root-rc6-1');

      const dev = conn.db.prepare('SELECT * FROM connect_authorized_devices WHERE device_id = ?').get('dev-rc6-1') as any;
      assert.equal(dev.auth_state, 'authorized');
      assert.equal(dev.token_hash, 'hash-abc');
      assert.equal(dev.remote_access_enabled, 0);
      assert.equal(dev.remote_token_hash, '');

      const remHost = conn.db.prepare('SELECT * FROM connect_remembered_hosts WHERE host_id = ?').get('host-rc6-1') as any;
      assert.equal(remHost.last_address, '192.168.1.50');
      assert.equal(remHost.preferred_transport, 'lan-direct');
      assert.equal(remHost.credential_ref, 'cred-ref-1');
    } finally {
      conn.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
