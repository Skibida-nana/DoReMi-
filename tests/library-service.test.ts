import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openLibraryDatabase } from '../src/main/database/connection';
import { LibraryRootRepository } from '../src/main/database/library-root-repository';
import { TrackRepository } from '../src/main/database/track-repository';
import { LibraryService } from '../src/main/services/library-service';
import {
  createFlacMetadataBuffer,
  createWavBuffer,
  writeFixtureFile,
} from './helpers/audio-fixtures';

test('LibraryService handles recursive import, duplicate re-import, corrupted file isolation, missing & recovery', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lossless-lib-'));
  const musicDir = path.join(workspace, 'Thư viện nhạc Việt');
  const dbPath = path.join(workspace, 'userData', 'library.db');

  try {
    const flacA = writeFixtureFile(
      path.join(musicDir, 'Album A', 'Track 01.flac'),
      createFlacMetadataBuffer({ title: 'Track 01 A', artist: 'Artist A' }),
    );
    // Same filename in a different subfolder -> must be two distinct valid tracks
    const flacB = writeFixtureFile(
      path.join(musicDir, 'Album B', 'Track 01.flac'),
      createFlacMetadataBuffer({ title: 'Track 01 B', artist: 'Artist B' }),
    );
    const wavPath = writeFixtureFile(
      path.join(musicDir, 'Live', 'Đêm Nhạc.wav'),
      createWavBuffer({ durationSeconds: 1 }),
    );
    // Corrupted file must report an error without aborting the rest of the folder import
    writeFixtureFile(
      path.join(musicDir, 'Live', 'corrupted.flac'),
      Buffer.from('corrupted bytes', 'utf8'),
    );

    const conn = openLibraryDatabase(dbPath);
    try {
      const service = new LibraryService({
        trackRepo: new TrackRepository(conn.db),
        rootRepo: new LibraryRootRepository(conn.db),
        databasePath: dbPath,
      });

      // 1. Initial folder import
      const firstImport = await service.importFolder(musicDir);
      assert.equal(firstImport.canceled, false);
      assert.equal(firstImport.addedCount, 3);
      assert.equal(firstImport.errors.length, 1);
      assert.ok(firstImport.errors[0].path.endsWith('corrupted.flac'));

      const snapshot1 = service.getSnapshot();
      assert.equal(snapshot1.tracks.length, 3);
      assert.equal(snapshot1.roots.length, 1);
      const uuidsBefore = new Set(snapshot1.tracks.map((t) => t.id));
      assert.equal(uuidsBefore.size, 3);

      // 2. Re-import same folder -> must NOT create duplicates and must preserve UUIDs
      const secondImport = await service.importFolder(musicDir);
      assert.equal(secondImport.addedCount, 0);
      assert.equal(secondImport.skippedCount, 3);

      const snapshot2 = service.getSnapshot();
      assert.equal(snapshot2.tracks.length, 3);
      const uuidsAfter = new Set(snapshot2.tracks.map((t) => t.id));
      assert.deepEqual(uuidsAfter, uuidsBefore);

      // 3. Delete one source file -> rescan must mark it "missing" and NEVER delete the DB record
      const movedBackup = path.join(workspace, 'moved-backup.flac');
      fs.renameSync(flacA, movedBackup);

      const rescanMissing = await service.rescanLibrary();
      assert.equal(rescanMissing.missingMarkedCount, 1);

      const snapshot3 = service.getSnapshot();
      assert.equal(snapshot3.tracks.length, 3);
      const missingTrack = snapshot3.tracks.find((t) => t.original_path === flacA);
      assert.ok(missingTrack);
      assert.equal(missingTrack.status, 'missing');

      // 4. Verify other source files remain untouched on disk
      assert.equal(fs.existsSync(flacB), true);
      assert.equal(fs.existsSync(wavPath), true);

      // 5. Restore file to original location -> rescan recovers status to "available" with same UUID
      fs.renameSync(movedBackup, flacA);
      const rescanRecovered = await service.rescanLibrary();
      assert.equal(rescanRecovered.recoveredCount, 1);

      const snapshot4 = service.getSnapshot();
      const recoveredTrack = snapshot4.tracks.find((t) => t.id === missingTrack.id);
      assert.ok(recoveredTrack);
      assert.equal(recoveredTrack.status, 'available');
    } finally {
      conn.close();
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
