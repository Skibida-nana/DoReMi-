import type Database from 'better-sqlite3';

export interface MigrationDefinition {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

/**
 * Schema migrations list.
 * Future phases can append Version 2+ migrations for:
 * - playlists
 * - playlist_tracks (FK -> tracks.id)
 * - custom_covers (FK -> tracks.id)
 * - custom_lyrics (FK -> tracks.id)
 * - favorites (FK -> tracks.id)
 * without altering existing track UUID primary keys.
 */
export const MIGRATIONS: readonly MigrationDefinition[] = [
  {
    version: 1,
    name: '001_initial_library_schema',
    up(db: Database.Database): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tracks (
          id TEXT PRIMARY KEY,
          original_path TEXT NOT NULL,
          normalized_path TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          artist TEXT,
          album TEXT,
          duration_ms INTEGER,
          codec TEXT,
          container TEXT,
          sample_rate_hz INTEGER,
          bit_depth INTEGER,
          bitrate_bps INTEGER,
          file_size_bytes INTEGER,
          modified_at_ms INTEGER,
          status TEXT NOT NULL DEFAULT 'available'
            CHECK (status IN ('available', 'missing', 'error')),
          added_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tracks_status ON tracks(status);
        CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
        CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);
        CREATE INDEX IF NOT EXISTS idx_tracks_added_at ON tracks(added_at);

        CREATE TABLE IF NOT EXISTS library_roots (
          id TEXT PRIMARY KEY,
          original_path TEXT NOT NULL,
          normalized_path TEXT NOT NULL UNIQUE,
          added_at TEXT NOT NULL,
          last_scanned_at TEXT,
          status TEXT NOT NULL DEFAULT 'available'
            CHECK (status IN ('available', 'missing'))
        );

        CREATE INDEX IF NOT EXISTS idx_library_roots_status ON library_roots(status);
      `);
    },
  },
  {
    version: 2,
    name: '002_stage3_artwork_lyrics_metadata_overrides',
    up(db: Database.Database): void {
      const trackColumns = db
        .prepare('PRAGMA table_info(tracks)')
        .all() as Array<{ name: string }>;
      const hasYearColumn = trackColumns.some((column) => column.name === 'year');
      if (!hasYearColumn) {
        db.exec('ALTER TABLE tracks ADD COLUMN year INTEGER;');
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS track_artwork (
          track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
          custom_file TEXT,
          custom_mime TEXT,
          custom_hash TEXT,
          embedded_cache_file TEXT,
          embedded_mime TEXT,
          embedded_hash TEXT,
          folder_source_path TEXT,
          folder_cache_file TEXT,
          folder_mime TEXT,
          folder_hash TEXT,
          source_mtime_ms INTEGER,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS track_lyrics (
          track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
          custom_format TEXT CHECK (custom_format IN ('lrc', 'txt')),
          custom_content TEXT,
          embedded_content TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS track_metadata_overrides (
          track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
          title_override TEXT,
          artist_override TEXT,
          album_override TEXT,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    name: '003_stage5_profile_preferences_stats',
    up(db: Database.Database): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_profile (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          display_name TEXT NOT NULL DEFAULT 'Người nghe nhạc',
          avatar_file TEXT,
          avatar_mime TEXT,
          avatar_is_animated INTEGER NOT NULL DEFAULT 0,
          avatar_hash TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_preferences (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS listening_sessions (
          id TEXT PRIMARY KEY,
          track_id TEXT NOT NULL,
          track_title_snapshot TEXT NOT NULL,
          artist_snapshot TEXT,
          album_snapshot TEXT,
          duration_ms INTEGER,
          started_at_ms INTEGER NOT NULL,
          ended_at_ms INTEGER NOT NULL,
          listened_ms INTEGER NOT NULL,
          qualified_play INTEGER NOT NULL DEFAULT 0,
          active_intervals_json TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_listening_sessions_track_id
          ON listening_sessions(track_id);
        CREATE INDEX IF NOT EXISTS idx_listening_sessions_started_at
          ON listening_sessions(started_at_ms);
        CREATE INDEX IF NOT EXISTS idx_listening_sessions_ended_at
          ON listening_sessions(ended_at_ms);

        CREATE TABLE IF NOT EXISTS listening_daily_buckets (
          session_id TEXT NOT NULL REFERENCES listening_sessions(id) ON DELETE CASCADE,
          local_date TEXT NOT NULL,
          local_hour INTEGER NOT NULL CHECK (local_hour >= 0 AND local_hour <= 23),
          listened_ms INTEGER NOT NULL,
          PRIMARY KEY (session_id, local_date, local_hour)
        );

        CREATE INDEX IF NOT EXISTS idx_listening_daily_buckets_date
          ON listening_daily_buckets(local_date);
        CREATE INDEX IF NOT EXISTS idx_listening_daily_buckets_hour
          ON listening_daily_buckets(local_hour);
      `);
    },
  },
  {
    version: 4,
    name: '004_stage6_replaygain_watcher_backup',
    up(db: Database.Database): void {
      const trackColumns = db
        .prepare('PRAGMA table_info(tracks)')
        .all() as Array<{ name: string }>;
      const trackColSet = new Set(trackColumns.map((c) => c.name));

      if (!trackColSet.has('replaygain_track_gain_db')) {
        db.exec('ALTER TABLE tracks ADD COLUMN replaygain_track_gain_db REAL;');
      }
      if (!trackColSet.has('replaygain_album_gain_db')) {
        db.exec('ALTER TABLE tracks ADD COLUMN replaygain_album_gain_db REAL;');
      }
      if (!trackColSet.has('replaygain_track_peak')) {
        db.exec('ALTER TABLE tracks ADD COLUMN replaygain_track_peak REAL;');
      }
      if (!trackColSet.has('replaygain_album_peak')) {
        db.exec('ALTER TABLE tracks ADD COLUMN replaygain_album_peak REAL;');
      }

      const rootColumns = db
        .prepare('PRAGMA table_info(library_roots)')
        .all() as Array<{ name: string }>;
      const rootColSet = new Set(rootColumns.map((c) => c.name));
      if (!rootColSet.has('auto_watch')) {
        db.exec('ALTER TABLE library_roots ADD COLUMN auto_watch INTEGER NOT NULL DEFAULT 1;');
      }
    },
  },
  {
    version: 5,
    name: '005_phase8_library_exclusions',
    up(db: Database.Database): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS library_exclusions (
          id TEXT PRIMARY KEY,
          normalized_path TEXT NOT NULL UNIQUE,
          original_path TEXT NOT NULL,
          root_id TEXT,
          file_size_bytes INTEGER,
          modified_at_ms INTEGER,
          title TEXT,
          artist TEXT,
          album TEXT,
          reason TEXT NOT NULL DEFAULT 'user-removed',
          excluded_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_library_exclusions_path
          ON library_exclusions(normalized_path);
        CREATE INDEX IF NOT EXISTS idx_library_exclusions_root
          ON library_exclusions(root_id);
      `);
    },
  },
];

export interface AppliedMigrationRecord {
  version: number;
  name: string;
  applied_at: string;
}

/**
 * Checks whether the database has any unapplied schema migrations without mutating the file.
 */
export function hasPendingMigrations(db: Database.Database): boolean {
  const tableRow = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get() as { name: string } | undefined;

  if (!tableRow) {
    return MIGRATIONS.length > 0;
  }

  const appliedRows = db
    .prepare('SELECT version FROM schema_migrations')
    .all() as Array<{ version: number }>;
  const appliedSet = new Set<number>(appliedRows.map((row) => row.version));

  return MIGRATIONS.some((migration) => !appliedSet.has(migration.version));
}

export function runMigrations(db: Database.Database): AppliedMigrationRecord[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
    .all() as Array<{ version: number }>;

  const appliedVersions = new Set<number>(appliedRows.map((row) => row.version));
  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    const applyTransaction = db.transaction(() => {
      migration.up(db);
      insertMigration.run(migration.version, migration.name, new Date().toISOString());
    });

    applyTransaction();
  }

  return db
    .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC')
    .all() as AppliedMigrationRecord[];
}
