import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openLibraryDatabase } from '../src/main/database/connection';
import { LibraryRootRepository } from '../src/main/database/library-root-repository';
import { MetadataOverrideRepository } from '../src/main/database/metadata-override-repository';
import { TrackRepository } from '../src/main/database/track-repository';
import { LibraryService } from '../src/main/services/library-service';
import { createFlacMetadataBuffer, writeFixtureFile } from './helpers/audio-fixtures';

test('M3.4 Metadata Overrides persist in SQLite, survive rescan & restart, preserve UUID, and never edit source FLAC', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doremi-meta-override-'));
  const dbPath = path.join(rootDir, 'library.db');
  const musicDir = path.join(rootDir, 'music');

  try {
    const flacPath = writeFixtureFile(
      path.join(musicDir, 'original-song.flac'),
      createFlacMetadataBuffer({
        title: 'Original Title',
        artist: 'Original Artist',
        album: 'Original Album',
      }),
    );

    const originalSha = crypto
      .createHash('sha256')
      .update(fs.readFileSync(flacPath))
      .digest('hex');

    let stableTrackId = '';

    const conn1 = openLibraryDatabase(dbPath);
    try {
      const trackRepo = new TrackRepository(conn1.db);
      const rootRepo = new LibraryRootRepository(conn1.db);
      const metadataOverrideRepo = new MetadataOverrideRepository(conn1.db);
      const libraryService = new LibraryService({
        trackRepo,
        rootRepo,
        databasePath: dbPath,
        metadataOverrideRepo,
      });

      await libraryService.importFolder(musicDir);
      const initial = libraryService.getSnapshot().tracks[0];
      assert.ok(initial);
      stableTrackId = initial.id;
      assert.equal(initial.title, 'Original Title');
      assert.equal(initial.original_title, 'Original Title');

      // Apply user override in SQLite
      const edited = libraryService.updateTrackMetadataOverride(stableTrackId, {
        titleOverride: 'Tên Bài Đã Sửa',
        artistOverride: 'Nghệ Sĩ Mới',
        albumOverride: 'Album Mới',
      });

      assert.equal(edited.id, stableTrackId);
      assert.equal(edited.title, 'Tên Bài Đã Sửa');
      assert.equal(edited.artist, 'Nghệ Sĩ Mới');
      assert.equal(edited.album, 'Album Mới');
      assert.equal(edited.original_title, 'Original Title');
      assert.equal(edited.original_artist, 'Original Artist');
      assert.equal(edited.original_album, 'Original Album');

      // Rescanning library must NOT wipe overrides or alter Stable Track ID
      await libraryService.rescanLibrary();
      const afterRescan = libraryService.getSnapshot().tracks[0];
      assert.equal(afterRescan.id, stableTrackId);
      assert.equal(afterRescan.title, 'Tên Bài Đã Sửa');
      assert.equal(afterRescan.artist, 'Nghệ Sĩ Mới');
      assert.equal(afterRescan.album, 'Album Mới');
    } finally {
      conn1.close();
    }

    // Reopen DB -> overrides persist, then Restore Original restores exact original tags
    const conn2 = openLibraryDatabase(dbPath);
    try {
      const trackRepo = new TrackRepository(conn2.db);
      const rootRepo = new LibraryRootRepository(conn2.db);
      const metadataOverrideRepo = new MetadataOverrideRepository(conn2.db);
      const libraryService = new LibraryService({
        trackRepo,
        rootRepo,
        databasePath: dbPath,
        metadataOverrideRepo,
      });

      const persisted = libraryService.getSnapshot().tracks[0];
      assert.equal(persisted.id, stableTrackId);
      assert.equal(persisted.title, 'Tên Bài Đã Sửa');

      const restored = libraryService.restoreTrackMetadataOriginal(stableTrackId);
      assert.equal(restored.id, stableTrackId);
      assert.equal(restored.title, 'Original Title');
      assert.equal(restored.artist, 'Original Artist');
      assert.equal(restored.album, 'Original Album');
      assert.equal(restored.title_override, null);

      // Confirm audio file on disk was NEVER modified
      const afterSha = crypto
        .createHash('sha256')
        .update(fs.readFileSync(flacPath))
        .digest('hex');
      assert.equal(afterSha, originalSha);
    } finally {
      conn2.close();
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
