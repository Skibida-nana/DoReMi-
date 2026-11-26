import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { buildPlaylistArtworkUrl } from '../../shared/contracts/media-protocol';
import type {
  AddTracksToPlaylistOptions,
  AddTracksToPlaylistResult,
  CreatePlaylistInput,
  LegacyCollectionsMigrationInput,
  PlaylistRecord,
  PlaylistSnapshot,
  PlaylistTrackEntryRecord,
  UpdatePlaylistInput,
} from '../../shared/types/playlist';
import {
  isConfirmedDemoAlbumId,
  isConfirmedDemoPlaylistId,
  isConfirmedDemoTrackId,
} from '../../shared/utils/demo-cleanup';

interface PlaylistRow {
  id: string;
  name: string;
  description: string;
  custom_artwork_file: string | null;
  custom_artwork_mime: string | null;
  custom_artwork_hash: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface JoinedPlaylistEntryRow {
  entry_id: string;
  playlist_id: string;
  track_id: string;
  position: number;
  added_at: string;
  duration_ms: number | null;
  status: string;
  availability_state: string | null;
}

export class PlaylistRepository {
  constructor(private readonly db: Database.Database) {}

  getArtworkRow(playlistId: string): PlaylistRow | null {
    const row = this.db
      .prepare(
        `SELECT id, name, description, custom_artwork_file, custom_artwork_mime, custom_artwork_hash, sort_order, created_at, updated_at
         FROM playlists WHERE id = ?`,
      )
      .get(playlistId) as PlaylistRow | undefined;
    return row ?? null;
  }

  getSnapshot(): PlaylistSnapshot {
    return {
      playlists: this.findAll(),
      favoriteTrackIds: this.getFavoriteTrackIds(),
    };
  }

  getFavoriteTrackIds(): string[] {
    const rows = this.db
      .prepare('SELECT track_id FROM favorites ORDER BY added_at DESC')
      .all() as Array<{ track_id: string }>;
    return rows.map((r) => r.track_id);
  }

  findAll(): PlaylistRecord[] {
    const playlists = this.db
      .prepare(
        `SELECT id, name, description, custom_artwork_file, custom_artwork_mime, custom_artwork_hash, sort_order, created_at, updated_at
         FROM playlists
         ORDER BY sort_order ASC, created_at DESC`,
      )
      .all() as PlaylistRow[];

    const entries = this.db
      .prepare(
        `SELECT
           pt.id AS entry_id,
           pt.playlist_id,
           pt.track_id,
           pt.position,
           pt.added_at,
           t.duration_ms,
           t.status,
           t.availability_state
         FROM playlist_tracks pt
         INNER JOIN tracks t ON t.id = pt.track_id
         ORDER BY pt.playlist_id ASC, pt.position ASC, pt.added_at ASC`,
      )
      .all() as JoinedPlaylistEntryRow[];

    const byPlaylist = new Map<string, JoinedPlaylistEntryRow[]>();
    for (const row of entries) {
      let list = byPlaylist.get(row.playlist_id);
      if (!list) {
        list = [];
        byPlaylist.set(row.playlist_id, list);
      }
      list.push(row);
    }

    return playlists.map((p) => this.mapPlaylistRow(p, byPlaylist.get(p.id) ?? []));
  }

  findById(playlistId: string): PlaylistRecord | null {
    const row = this.getArtworkRow(playlistId);
    if (!row) {
      return null;
    }
    const entries = this.db
      .prepare(
        `SELECT
           pt.id AS entry_id,
           pt.playlist_id,
           pt.track_id,
           pt.position,
           pt.added_at,
           t.duration_ms,
           t.status,
           t.availability_state
         FROM playlist_tracks pt
         INNER JOIN tracks t ON t.id = pt.track_id
         WHERE pt.playlist_id = ?
         ORDER BY pt.position ASC, pt.added_at ASC`,
      )
      .all(playlistId) as JoinedPlaylistEntryRow[];
    return this.mapPlaylistRow(row, entries);
  }

  createPlaylist(input: CreatePlaylistInput): PlaylistRecord {
    const trimmedName = (input.name ?? '').normalize('NFC').trim();
    if (!trimmedName) {
      throw new Error('Tên playlist không được để trống.');
    }
    const cleanedDesc = (input.description ?? '').normalize('NFC').trim();

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const tx = this.db.transaction(() => {
      // Shift sort_order or assign min sort_order - 1 so newest playlists appear first cleanly
      const minRow = this.db
        .prepare('SELECT MIN(sort_order) AS min_order FROM playlists')
        .get() as { min_order: number | null };
      const nextSortOrder =
        typeof minRow?.min_order === 'number' ? minRow.min_order - 1 : 0;

      this.db
        .prepare(
          `INSERT INTO playlists (
            id, name, description, custom_artwork_file, custom_artwork_mime, custom_artwork_hash, sort_order, created_at, updated_at
          ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
        )
        .run(id, trimmedName, cleanedDesc, nextSortOrder, now, now);

      const initialIds = Array.isArray(input.initialTrackIds) ? input.initialTrackIds : [];
      if (initialIds.length > 0) {
        const allowDuplicates = Boolean(input.allowDuplicates);
        const existingSet = new Set<string>(
          (this.db.prepare('SELECT id FROM tracks').all() as Array<{ id: string }>).map(
            (r) => r.id,
          ),
        );
        const insertedSet = new Set<string>();
        const insertEntry = this.db.prepare(
          `INSERT INTO playlist_tracks (id, playlist_id, track_id, position, added_at)
           VALUES (?, ?, ?, ?, ?)`,
        );

        let pos = 0;
        for (const trackId of initialIds) {
          if (!trackId || !existingSet.has(trackId)) {
            continue;
          }
          if (!allowDuplicates && insertedSet.has(trackId)) {
            continue;
          }
          insertedSet.add(trackId);
          insertEntry.run(crypto.randomUUID(), id, trackId, pos, now);
          pos += 1;
        }
      }
    });

    tx();
    return this.findById(id)!;
  }

  updatePlaylist(playlistId: string, input: UpdatePlaylistInput): PlaylistRecord {
    const existing = this.getArtworkRow(playlistId);
    if (!existing) {
      throw new Error('Playlist không còn tồn tại.');
    }

    const nextName =
      input.name !== undefined ? input.name.normalize('NFC').trim() : existing.name;
    if (!nextName) {
      throw new Error('Tên playlist không được để trống.');
    }
    const nextDesc =
      input.description !== undefined
        ? (input.description ?? '').normalize('NFC').trim()
        : existing.description;

    this.db
      .prepare('UPDATE playlists SET name = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(nextName, nextDesc, new Date().toISOString(), playlistId);

    return this.findById(playlistId)!;
  }

  deletePlaylist(playlistId: string): { deleted: boolean; oldArtworkFile: string | null } {
    const existing = this.getArtworkRow(playlistId);
    if (!existing) {
      return { deleted: false, oldArtworkFile: null };
    }
    const res = this.db.prepare('DELETE FROM playlists WHERE id = ?').run(playlistId);
    return {
      deleted: res.changes > 0,
      oldArtworkFile: existing.custom_artwork_file,
    };
  }

  addTracksToPlaylist(
    playlistId: string,
    trackIds: readonly string[],
    options?: AddTracksToPlaylistOptions,
  ): AddTracksToPlaylistResult {
    const existingPlaylist = this.getArtworkRow(playlistId);
    if (!existingPlaylist) {
      throw new Error('Playlist không còn tồn tại.');
    }

    const allowDuplicates = Boolean(options?.allowDuplicates);
    let addedCount = 0;
    let skippedDuplicateCount = 0;
    let ignoredInvalidCount = 0;

    const tx = this.db.transaction(() => {
      const validTrackSet = new Set<string>(
        (this.db.prepare('SELECT id FROM tracks').all() as Array<{ id: string }>).map(
          (r) => r.id,
        ),
      );
      const currentRows = this.db
        .prepare('SELECT track_id, position FROM playlist_tracks WHERE playlist_id = ?')
        .all(playlistId) as Array<{ track_id: string; position: number }>;

      const currentTrackSet = new Set<string>(currentRows.map((r) => r.track_id));
      let nextPos =
        currentRows.length > 0
          ? Math.max(...currentRows.map((r) => r.position)) + 1
          : 0;

      const now = new Date().toISOString();
      const insertStmt = this.db.prepare(
        `INSERT INTO playlist_tracks (id, playlist_id, track_id, position, added_at)
         VALUES (?, ?, ?, ?, ?)`,
      );

      for (const trackId of trackIds) {
        if (!trackId || !validTrackSet.has(trackId)) {
          ignoredInvalidCount += 1;
          continue;
        }
        if (!allowDuplicates && currentTrackSet.has(trackId)) {
          skippedDuplicateCount += 1;
          continue;
        }
        currentTrackSet.add(trackId);
        insertStmt.run(crypto.randomUUID(), playlistId, trackId, nextPos, now);
        nextPos += 1;
        addedCount += 1;
      }

      if (addedCount > 0) {
        this.db
          .prepare('UPDATE playlists SET updated_at = ? WHERE id = ?')
          .run(now, playlistId);
      }
    });

    tx();
    return {
      playlist: this.findById(playlistId)!,
      addedCount,
      skippedDuplicateCount,
      ignoredInvalidCount,
    };
  }

  removeEntriesFromPlaylist(
    playlistId: string,
    entryIds: readonly string[],
  ): PlaylistRecord {
    const existingPlaylist = this.getArtworkRow(playlistId);
    if (!existingPlaylist) {
      throw new Error('Playlist không còn tồn tại.');
    }
    if (entryIds.length === 0) {
      return this.findById(playlistId)!;
    }

    const tx = this.db.transaction(() => {
      const delStmt = this.db.prepare(
        'DELETE FROM playlist_tracks WHERE playlist_id = ? AND id = ?',
      );
      let deleted = 0;
      for (const entryId of entryIds) {
        deleted += delStmt.run(playlistId, entryId).changes;
      }
      if (deleted > 0) {
        this.reindexPositions(playlistId);
        this.db
          .prepare('UPDATE playlists SET updated_at = ? WHERE id = ?')
          .run(new Date().toISOString(), playlistId);
      }
    });

    tx();
    return this.findById(playlistId)!;
  }

  reorderPlaylistEntries(
    playlistId: string,
    orderedEntryIds: readonly string[],
  ): PlaylistRecord {
    const existingPlaylist = this.getArtworkRow(playlistId);
    if (!existingPlaylist) {
      throw new Error('Playlist không còn tồn tại.');
    }

    const tx = this.db.transaction(() => {
      const existingRows = this.db
        .prepare(
          'SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC, added_at ASC',
        )
        .all(playlistId) as Array<{ id: string }>;

      const existingIdSet = new Set(existingRows.map((r) => r.id));
      const nextOrder: string[] = [];
      const placed = new Set<string>();

      for (const entryId of orderedEntryIds) {
        if (existingIdSet.has(entryId) && !placed.has(entryId)) {
          nextOrder.push(entryId);
          placed.add(entryId);
        }
      }
      for (const row of existingRows) {
        if (!placed.has(row.id)) {
          nextOrder.push(row.id);
        }
      }

      const updStmt = this.db.prepare(
        'UPDATE playlist_tracks SET position = ? WHERE id = ? AND playlist_id = ?',
      );
      nextOrder.forEach((entryId, idx) => {
        updStmt.run(idx, entryId, playlistId);
      });

      this.db
        .prepare('UPDATE playlists SET updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), playlistId);
    });

    tx();
    return this.findById(playlistId)!;
  }

  setCustomArtwork(
    playlistId: string,
    fileName: string,
    mime: string,
    hash: string,
  ): PlaylistRecord {
    const existing = this.getArtworkRow(playlistId);
    if (!existing) {
      throw new Error('Playlist không còn tồn tại.');
    }
    this.db
      .prepare(
        `UPDATE playlists
         SET custom_artwork_file = ?, custom_artwork_mime = ?, custom_artwork_hash = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(fileName, mime, hash, new Date().toISOString(), playlistId);
    return this.findById(playlistId)!;
  }

  clearCustomArtwork(playlistId: string): {
    playlist: PlaylistRecord;
    oldArtworkFile: string | null;
  } {
    const existing = this.getArtworkRow(playlistId);
    if (!existing) {
      throw new Error('Playlist không còn tồn tại.');
    }
    this.db
      .prepare(
        `UPDATE playlists
         SET custom_artwork_file = NULL, custom_artwork_mime = NULL, custom_artwork_hash = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(new Date().toISOString(), playlistId);
    return {
      playlist: this.findById(playlistId)!,
      oldArtworkFile: existing.custom_artwork_file,
    };
  }

  toggleFavorite(trackId: string): { isFavorite: boolean; favoriteTrackIds: string[] } {
    const existing = this.db
      .prepare('SELECT track_id FROM favorites WHERE track_id = ?')
      .get(trackId) as { track_id: string } | undefined;

    if (existing) {
      this.db.prepare('DELETE FROM favorites WHERE track_id = ?').run(trackId);
      return { isFavorite: false, favoriteTrackIds: this.getFavoriteTrackIds() };
    }

    const trackExists = this.db
      .prepare('SELECT id FROM tracks WHERE id = ?')
      .get(trackId) as { id: string } | undefined;
    if (!trackExists) {
      throw new Error('Không tìm thấy bài hát trong thư viện SQLite.');
    }

    this.db
      .prepare('INSERT INTO favorites (track_id, added_at) VALUES (?, ?)')
      .run(trackId, new Date().toISOString());

    return { isFavorite: true, favoriteTrackIds: this.getFavoriteTrackIds() };
  }

  setFavorites(trackIds: readonly string[], favorite: boolean): string[] {
    const tx = this.db.transaction(() => {
      if (!favorite) {
        const delStmt = this.db.prepare('DELETE FROM favorites WHERE track_id = ?');
        for (const id of trackIds) {
          delStmt.run(id);
        }
        return;
      }

      const validTrackSet = new Set<string>(
        (this.db.prepare('SELECT id FROM tracks').all() as Array<{ id: string }>).map(
          (r) => r.id,
        ),
      );
      const now = new Date().toISOString();
      const upsertStmt = this.db.prepare(
        `INSERT INTO favorites (track_id, added_at) VALUES (?, ?)
         ON CONFLICT(track_id) DO NOTHING`,
      );
      for (const id of trackIds) {
        if (validTrackSet.has(id)) {
          upsertStmt.run(id, now);
        }
      }
    });

    tx();
    return this.getFavoriteTrackIds();
  }

  /**
   * Safely migrates real user-created legacy playlists & favorites from localStorage/Stage6 JSON
   * into normalized SQLite tables while stripping strictly confirmed demo IDs.
   */
  migrateLegacyCollections(legacy: LegacyCollectionsMigrationInput): PlaylistSnapshot {
    const flagRow = this.db
      .prepare("SELECT value_json FROM app_preferences WHERE key = 'phase3_collections_migrated'")
      .get() as { value_json: string } | undefined;

    if (flagRow?.value_json === 'true') {
      return this.getSnapshot();
    }

    const tx = this.db.transaction(() => {
      const validTrackSet = new Set<string>(
        (this.db.prepare('SELECT id FROM tracks').all() as Array<{ id: string }>).map(
          (r) => r.id,
        ),
      );
      const now = new Date().toISOString();

      const favStmt = this.db.prepare(
        `INSERT INTO favorites (track_id, added_at) VALUES (?, ?)
         ON CONFLICT(track_id) DO NOTHING`,
      );
      for (const favId of legacy.favoriteIds ?? []) {
        if (
          !isConfirmedDemoTrackId(favId) &&
          !isConfirmedDemoAlbumId(favId) &&
          validTrackSet.has(favId)
        ) {
          favStmt.run(favId, now);
        }
      }

      const existingPlaylistNames = new Set(
        (this.db.prepare('SELECT name FROM playlists').all() as Array<{ name: string }>).map(
          (r) => r.name.normalize('NFC').trim().toLocaleLowerCase('vi-VN'),
        ),
      );

      let sortOrder = 0;
      const insertPlaylist = this.db.prepare(
        `INSERT INTO playlists (id, name, description, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insertEntry = this.db.prepare(
        `INSERT INTO playlist_tracks (id, playlist_id, track_id, position, added_at)
         VALUES (?, ?, ?, ?, ?)`,
      );

      for (const item of legacy.playlists ?? []) {
        if (isConfirmedDemoPlaylistId(item.id)) {
          continue;
        }
        const trimmedName = (item.name ?? '').normalize('NFC').trim();
        if (!trimmedName) {
          continue;
        }
        const lowerKey = trimmedName.toLocaleLowerCase('vi-VN');
        if (existingPlaylistNames.has(lowerKey)) {
          continue;
        }
        existingPlaylistNames.add(lowerKey);

        const playlistId = crypto.randomUUID();
        const desc = (item.description ?? '').normalize('NFC').trim();
        insertPlaylist.run(playlistId, trimmedName, desc, sortOrder, now, now);
        sortOrder += 1;

        const seenTracks = new Set<string>();
        let pos = 0;
        for (const tid of item.trackIds ?? []) {
          if (isConfirmedDemoTrackId(tid) || !validTrackSet.has(tid) || seenTracks.has(tid)) {
            continue;
          }
          seenTracks.add(tid);
          insertEntry.run(crypto.randomUUID(), playlistId, tid, pos, now);
          pos += 1;
        }
      }

      this.db
        .prepare(
          `INSERT INTO app_preferences (key, value_json, updated_at)
           VALUES ('phase3_collections_migrated', 'true', ?)
           ON CONFLICT(key) DO UPDATE SET value_json = 'true', updated_at = excluded.updated_at`,
        )
        .run(now);
    });

    tx();
    return this.getSnapshot();
  }

  private reindexPositions(playlistId: string): void {
    const rows = this.db
      .prepare(
        'SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC, added_at ASC',
      )
      .all(playlistId) as Array<{ id: string }>;
    const upd = this.db.prepare('UPDATE playlist_tracks SET position = ? WHERE id = ?');
    rows.forEach((row, index) => {
      upd.run(index, row.id);
    });
  }

  private mapPlaylistRow(
    row: PlaylistRow,
    rawEntries: JoinedPlaylistEntryRow[],
  ): PlaylistRecord {
    const entries: PlaylistTrackEntryRecord[] = [];
    const trackIds: string[] = [];
    let totalDurationMs = 0;
    let availableCount = 0;
    let missingCount = 0;

    for (const item of rawEntries) {
      entries.push({
        entryId: item.entry_id,
        trackId: item.track_id,
        position: item.position,
        addedAt: item.added_at,
      });
      trackIds.push(item.track_id);
      if (typeof item.duration_ms === 'number' && Number.isFinite(item.duration_ms)) {
        totalDurationMs += item.duration_ms;
      }
      const avail = item.availability_state ?? item.status;
      if (item.status === 'available' && avail === 'available') {
        availableCount += 1;
      } else {
        missingCount += 1;
      }
    }

    const hasCustomArtwork = Boolean(row.custom_artwork_file);
    let artworkUrl: string | null = null;
    if (hasCustomArtwork) {
      try {
        artworkUrl = buildPlaylistArtworkUrl(row.id, row.custom_artwork_hash);
      } catch {
        artworkUrl = null;
      }
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      artworkUrl,
      hasCustomArtwork,
      trackIds,
      entries,
      trackCount: entries.length,
      totalDurationMs,
      availableCount,
      missingCount,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
