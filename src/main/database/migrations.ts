import type Database from 'better-sqlite3';
import { CONFIRMED_DEMO_TRACK_IDS } from '../../shared/utils/demo-cleanup';

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
  {
    version: 6,
    name: '006_phase3_library_sources_availability_metadata',
    up(db: Database.Database): void {
      const trackCols = new Set(
        (db.prepare('PRAGMA table_info(tracks)').all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      const trackAlterStatements: Array<[string, string]> = [
        ['genre', 'ALTER TABLE tracks ADD COLUMN genre TEXT;'],
        ['album_artist', 'ALTER TABLE tracks ADD COLUMN album_artist TEXT;'],
        ['track_number', 'ALTER TABLE tracks ADD COLUMN track_number INTEGER;'],
        ['track_total', 'ALTER TABLE tracks ADD COLUMN track_total INTEGER;'],
        ['disc_number', 'ALTER TABLE tracks ADD COLUMN disc_number INTEGER;'],
        ['disc_total', 'ALTER TABLE tracks ADD COLUMN disc_total INTEGER;'],
        ['composer', 'ALTER TABLE tracks ADD COLUMN composer TEXT;'],
        ['lyricist', 'ALTER TABLE tracks ADD COLUMN lyricist TEXT;'],
        ['comment', 'ALTER TABLE tracks ADD COLUMN comment TEXT;'],
        ['channels', 'ALTER TABLE tracks ADD COLUMN channels INTEGER;'],
        ['encoder', 'ALTER TABLE tracks ADD COLUMN encoder TEXT;'],
        ['file_name', 'ALTER TABLE tracks ADD COLUMN file_name TEXT;'],
        [
          'availability_state',
          "ALTER TABLE tracks ADD COLUMN availability_state TEXT NOT NULL DEFAULT 'available';",
        ],
        ['availability_reason', 'ALTER TABLE tracks ADD COLUMN availability_reason TEXT;'],
        ['last_verified_at', 'ALTER TABLE tracks ADD COLUMN last_verified_at TEXT;'],
      ];
      for (const [col, sql] of trackAlterStatements) {
        if (!trackCols.has(col)) {
          db.exec(sql);
        }
      }

      db.exec(`
        UPDATE tracks
        SET availability_state = CASE
          WHEN status = 'error' THEN 'access_error'
          WHEN status = 'missing' THEN 'missing'
          ELSE 'available'
        END
        WHERE availability_state IS NULL OR availability_state = 'available';

        CREATE INDEX IF NOT EXISTS idx_tracks_availability_state
          ON tracks(availability_state);
        CREATE INDEX IF NOT EXISTS idx_tracks_album_artist
          ON tracks(album_artist);
      `);

      const overrideCols = new Set(
        (
          db
            .prepare('PRAGMA table_info(track_metadata_overrides)')
            .all() as Array<{ name: string }>
        ).map((c) => c.name),
      );
      const overrideAlterStatements: Array<[string, string]> = [
        ['genre_override', 'ALTER TABLE track_metadata_overrides ADD COLUMN genre_override TEXT;'],
        [
          'year_override',
          'ALTER TABLE track_metadata_overrides ADD COLUMN year_override INTEGER;',
        ],
        [
          'album_artist_override',
          'ALTER TABLE track_metadata_overrides ADD COLUMN album_artist_override TEXT;',
        ],
        [
          'track_number_override',
          'ALTER TABLE track_metadata_overrides ADD COLUMN track_number_override INTEGER;',
        ],
        [
          'track_total_override',
          'ALTER TABLE track_metadata_overrides ADD COLUMN track_total_override INTEGER;',
        ],
        [
          'disc_number_override',
          'ALTER TABLE track_metadata_overrides ADD COLUMN disc_number_override INTEGER;',
        ],
        [
          'disc_total_override',
          'ALTER TABLE track_metadata_overrides ADD COLUMN disc_total_override INTEGER;',
        ],
        [
          'composer_override',
          'ALTER TABLE track_metadata_overrides ADD COLUMN composer_override TEXT;',
        ],
        [
          'lyricist_override',
          'ALTER TABLE track_metadata_overrides ADD COLUMN lyricist_override TEXT;',
        ],
        [
          'comment_override',
          'ALTER TABLE track_metadata_overrides ADD COLUMN comment_override TEXT;',
        ],
      ];
      for (const [col, sql] of overrideAlterStatements) {
        if (!overrideCols.has(col)) {
          db.exec(sql);
        }
      }

      const rootCols = new Set(
        (db.prepare('PRAGMA table_info(library_roots)').all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      const rootAlterStatements: Array<[string, string]> = [
        ['recursive', 'ALTER TABLE library_roots ADD COLUMN recursive INTEGER NOT NULL DEFAULT 1;'],
        ['enabled', 'ALTER TABLE library_roots ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;'],
        [
          'availability_state',
          "ALTER TABLE library_roots ADD COLUMN availability_state TEXT NOT NULL DEFAULT 'available';",
        ],
        [
          'availability_reason',
          'ALTER TABLE library_roots ADD COLUMN availability_reason TEXT;',
        ],
        [
          'last_successful_scan_at',
          'ALTER TABLE library_roots ADD COLUMN last_successful_scan_at TEXT;',
        ],
      ];
      for (const [col, sql] of rootAlterStatements) {
        if (!rootCols.has(col)) {
          db.exec(sql);
        }
      }

      db.exec(`
        UPDATE library_roots
        SET
          availability_state = CASE
            WHEN status = 'missing' THEN 'source_unavailable'
            ELSE 'available'
          END,
          last_successful_scan_at = COALESCE(last_successful_scan_at, last_scanned_at);
      `);
    },
  },
  {
    version: 7,
    name: '007_phase3_playlists_favorites_and_demo_cleanup',
    up(db: Database.Database): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS playlists (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          custom_artwork_file TEXT,
          custom_artwork_mime TEXT,
          custom_artwork_hash TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_playlists_sort_order
          ON playlists(sort_order, updated_at);

        CREATE TABLE IF NOT EXISTS playlist_tracks (
          id TEXT PRIMARY KEY,
          playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
          track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          added_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_pos
          ON playlist_tracks(playlist_id, position);
        CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track
          ON playlist_tracks(track_id);

        CREATE TABLE IF NOT EXISTS favorites (
          track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
          added_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_favorites_added_at
          ON favorites(added_at);
      `);

      // Safe idempotent cleanup of strictly confirmed prototype demo records if any leaked into SQLite
      const placeholders = CONFIRMED_DEMO_TRACK_IDS.map(() => '?').join(', ');
      if (placeholders.length > 0) {
        db.prepare(
          `DELETE FROM tracks WHERE id IN (${placeholders}) OR original_path LIKE 'sample://%'`,
        ).run(...CONFIRMED_DEMO_TRACK_IDS);
        db.prepare(
          `DELETE FROM listening_sessions WHERE track_id IN (${placeholders})`,
        ).run(...CONFIRMED_DEMO_TRACK_IDS);
      }
    },
  },
  {
    version: 8,
    name: '008_phase451_track_metadata_version',
    up(db: Database.Database): void {
      const trackCols = new Set(
        (db.prepare('PRAGMA table_info(tracks)').all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      if (!trackCols.has('metadata_version')) {
        db.exec('ALTER TABLE tracks ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 1;');
      }
      // Confirmed non-M4A/MP4/ALAC/AAC tracks were unaffected by the MP4 ALAC sample-rate bug;
      // keep M4A/MP4/ALAC/AAC/unknown tracks at version 1 so selective recovery re-reads ONLY their headers.
      db.exec(`
        UPDATE tracks
        SET metadata_version = 2
        WHERE LOWER(COALESCE(original_path, '')) NOT LIKE '%.m4a'
          AND LOWER(COALESCE(original_path, '')) NOT LIKE '%.mp4'
          AND UPPER(COALESCE(container, '')) NOT IN ('M4A', 'MP4', 'ISOM', 'QUICKTIME')
          AND UPPER(COALESCE(codec, '')) NOT IN ('ALAC', 'AAC', 'MP4A')
          AND COALESCE(codec, '') <> '';

        CREATE INDEX IF NOT EXISTS idx_tracks_metadata_version
          ON tracks(metadata_version);
      `);
    },
  },
  {
    version: 9,
    name: '009_phase61_connect_hybrid_server',
    up(db: Database.Database): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS connect_host_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          enabled INTEGER NOT NULL DEFAULT 0,
          auto_start INTEGER NOT NULL DEFAULT 0,
          display_name TEXT NOT NULL DEFAULT 'DoReMi Desktop',
          port INTEGER NOT NULL DEFAULT 48620,
          bind_address TEXT NOT NULL DEFAULT 'auto-private',
          max_active_clients INTEGER NOT NULL DEFAULT 3,
          max_requests_per_device INTEGER NOT NULL DEFAULT 4,
          max_global_requests INTEGER NOT NULL DEFAULT 12,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS connect_shared_sources (
          id TEXT PRIMARY KEY,
          root_id TEXT NOT NULL UNIQUE REFERENCES library_roots(id) ON DELETE CASCADE,
          enabled INTEGER NOT NULL DEFAULT 1,
          added_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_connect_shared_sources_root
          ON connect_shared_sources(root_id);

        CREATE TABLE IF NOT EXISTS connect_authorized_devices (
          device_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          platform TEXT NOT NULL,
          auth_state TEXT NOT NULL DEFAULT 'authorized'
            CHECK (auth_state IN ('authorized', 'revoked')),
          token_hash TEXT NOT NULL,
          token_salt TEXT NOT NULL,
          enrolled_at TEXT NOT NULL,
          last_activity_at TEXT,
          last_ip TEXT,
          revoked_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_connect_authorized_devices_state
          ON connect_authorized_devices(auth_state);

        CREATE TABLE IF NOT EXISTS connect_remembered_hosts (
          host_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          last_address TEXT NOT NULL,
          port INTEGER NOT NULL,
          pinned_fingerprint TEXT NOT NULL,
          short_fingerprint TEXT NOT NULL,
          device_id TEXT NOT NULL,
          api_version TEXT NOT NULL DEFAULT '1',
          credential_ref TEXT NOT NULL,
          last_connected_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 10,
    name: '010_phase63_remote_https_access',
    up(db: Database.Database): void {
      db.exec(`
        ALTER TABLE connect_host_config
          ADD COLUMN remote_provider TEXT NOT NULL DEFAULT 'tailscale-funnel';
        ALTER TABLE connect_host_config
          ADD COLUMN remote_public_port INTEGER NOT NULL DEFAULT 443;
        ALTER TABLE connect_host_config
          ADD COLUMN remote_mount_path TEXT NOT NULL DEFAULT '/doremi-connect';
        ALTER TABLE connect_host_config
          ADD COLUMN remote_endpoint_generation INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE connect_host_config
          ADD COLUMN remote_owned_route_json TEXT;
        ALTER TABLE connect_host_config
          ADD COLUMN remote_user_acknowledged INTEGER NOT NULL DEFAULT 0;

        ALTER TABLE connect_authorized_devices
          ADD COLUMN remote_access_enabled INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE connect_authorized_devices
          ADD COLUMN remote_token_hash TEXT NOT NULL DEFAULT '';
        ALTER TABLE connect_authorized_devices
          ADD COLUMN remote_token_salt TEXT NOT NULL DEFAULT '';
        ALTER TABLE connect_authorized_devices
          ADD COLUMN remote_granted_at TEXT;

        ALTER TABLE connect_remembered_hosts
          ADD COLUMN preferred_transport TEXT NOT NULL DEFAULT 'lan-direct';
        ALTER TABLE connect_remembered_hosts
          ADD COLUMN remote_descriptor_json TEXT;
        ALTER TABLE connect_remembered_hosts
          ADD COLUMN remote_credential_ref TEXT;
        ALTER TABLE connect_remembered_hosts
          ADD COLUMN last_remote_connected_at TEXT;
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
