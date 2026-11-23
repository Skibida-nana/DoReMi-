import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtworkRepository } from '../src/main/database/artwork-repository';
import { openLibraryDatabase } from '../src/main/database/connection';
import { LibraryRootRepository } from '../src/main/database/library-root-repository';
import { TrackRepository } from '../src/main/database/track-repository';
import { ArtworkService, validateImageBuffer } from '../src/main/services/artwork-service';
import { LibraryService } from '../src/main/services/library-service';
import {
  createFlacMetadataBuffer,
  createValidJpegBuffer,
  createValidPngBuffer,
  createValidWebpBuffer,
  writeFixtureFile,
} from './helpers/audio-fixtures';

function fileSha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('validateImageBuffer accepts valid JPG/PNG/WEBP and rejects corrupt/text bytes', () => {
  assert.equal(validateImageBuffer(createValidJpegBuffer())?.mime, 'image/jpeg');
  assert.equal(validateImageBuffer(createValidPngBuffer())?.mime, 'image/png');
  assert.equal(validateImageBuffer(createValidWebpBuffer())?.mime, 'image/webp');
  assert.equal(validateImageBuffer(Buffer.from('not an image file', 'utf8')), null);
  assert.equal(validateImageBuffer(Buffer.alloc(4)), null);
});

test('M3.1 + M3.2: Artwork priority (Custom > Embedded > Folder > Default), persistence, and zero source FLAC mutation', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doremi-artwork-test-'));
  const userDataDir = path.join(rootDir, 'userData');
  const dbPath = path.join(userDataDir, 'library.db');
  const musicDir = path.join(rootDir, 'music');

  try {
    // 1. Track with embedded FLAC cover AND folder cover.jpg -> embedded must win over folder
    const embeddedPng = createValidPngBuffer(0x31);
    const flacWithEmbeddedPath = writeFixtureFile(
      path.join(musicDir, 'album-a', '01-embedded.flac'),
      createFlacMetadataBuffer({
        title: 'Embedded Cover Song',
        artist: 'DoReMi Artist',
        album: 'Album A',
        year: 2024,
        picture: { mime: 'image/png', data: embeddedPng },
      }),
    );
    writeFixtureFile(path.join(musicDir, 'album-a', 'cover.jpg'), createValidJpegBuffer(0x41));

    // 2. Track without embedded cover, but folder.jpg present -> folder must win
    const flacFolderOnlyPath = writeFixtureFile(
      path.join(musicDir, 'album-b', '02-folder.flac'),
      createFlacMetadataBuffer({
        title: 'Folder Cover Song',
        artist: 'DoReMi Artist',
        album: 'Album B',
      }),
    );
    writeFixtureFile(path.join(musicDir, 'album-b', 'folder.jpg'), createValidJpegBuffer(0x52));

    // 3. Track with no embedded & no folder cover -> default fallback
    const flacDefaultPath = writeFixtureFile(
      path.join(musicDir, 'album-c', '03-default.flac'),
      createFlacMetadataBuffer({
        title: 'Default Artwork Song',
        artist: 'DoReMi Artist',
      }),
    );

    const originalFlacHash = fileSha256(flacWithEmbeddedPath);
    const customWebpPath = writeFixtureFile(
      path.join(rootDir, 'imports', 'my-custom.webp'),
      createValidWebpBuffer(0x77),
    );
    const invalidImagePath = writeFixtureFile(
      path.join(rootDir, 'imports', 'fake.png'),
      Buffer.from('<html>not a png</html>', 'utf8'),
    );

    let embeddedTrackId = '';

    const conn1 = openLibraryDatabase(dbPath);
    try {
      const trackRepo = new TrackRepository(conn1.db);
      const rootRepo = new LibraryRootRepository(conn1.db);
      const artworkRepo = new ArtworkRepository(conn1.db);
      const artworkService = new ArtworkService({ trackRepo, artworkRepo, userDataDir });
      const libraryService = new LibraryService({
        trackRepo,
        rootRepo,
        databasePath: dbPath,
        artworkService,
      });

      const summary = await libraryService.importFiles([
        flacWithEmbeddedPath,
        flacFolderOnlyPath,
        flacDefaultPath,
      ]);
      assert.equal(summary.addedCount, 3);

      const snapshot = libraryService.getSnapshot();
      const tEmbedded = snapshot.tracks.find((t) => t.title === 'Embedded Cover Song')!;
      const tFolder = snapshot.tracks.find((t) => t.title === 'Folder Cover Song')!;
      const tDefault = snapshot.tracks.find((t) => t.title === 'Default Artwork Song')!;

      embeddedTrackId = tEmbedded.id;
      assert.equal(tEmbedded.year, 2024);
      assert.equal(tEmbedded.artwork_source, 'embedded');
      assert.ok(tEmbedded.artwork_url?.startsWith(`lossless-media://artwork/${tEmbedded.id}`));

      assert.equal(tFolder.artwork_source, 'folder');
      assert.ok(tFolder.artwork_url?.startsWith(`lossless-media://artwork/${tFolder.id}`));

      assert.equal(tDefault.artwork_source, 'default');
      assert.equal(tDefault.artwork_url, null);

      // Invalid image must be cleanly rejected
      await assert.rejects(
        () => artworkService.importCustomArtworkFromPath(embeddedTrackId, invalidImagePath),
        /không hợp lệ/i,
      );

      // Import custom WEBP cover -> Priority 1 overrides embedded cover
      const withCustom = await artworkService.importCustomArtworkFromPath(
        embeddedTrackId,
        customWebpPath,
      );
      assert.equal(withCustom.artwork_source, 'custom');
      assert.equal(withCustom.has_custom_artwork, true);
      assert.ok(withCustom.artwork_url);

      // Delete the imported source file -> app copy inside userData/artwork-custom must remain intact!
      fs.unlinkSync(customWebpPath);

      // Protocol handler serves valid image bytes & rejects traversal
      const okRes = await artworkService.resolveArtworkHttpResponse(
        new Request(withCustom.artwork_url),
      );
      assert.equal(okRes.status, 200);
      assert.equal(okRes.headers.get('Content-Type'), 'image/webp');
      const servedBytes = Buffer.from(await okRes.arrayBuffer());
      assert.deepEqual(servedBytes, createValidWebpBuffer(0x77));

      const badRes = await artworkService.resolveArtworkHttpResponse(
        new Request('lossless-media://artwork/../../etc/passwd'),
      );
      assert.equal(badRes.status, 400);
    } finally {
      conn1.close();
    }

    // Reopen database -> custom artwork persists across restart, then remove restores embedded cover!
    const conn2 = openLibraryDatabase(dbPath);
    try {
      const trackRepo = new TrackRepository(conn2.db);
      const artworkRepo = new ArtworkRepository(conn2.db);
      const artworkService = new ArtworkService({ trackRepo, artworkRepo, userDataDir });

      const persisted = artworkService.enrichTrack(trackRepo.findById(embeddedTrackId)!);
      assert.equal(persisted.artwork_source, 'custom');
      assert.equal(persisted.has_custom_artwork, true);

      const restored = await artworkService.removeCustomArtwork(embeddedTrackId);
      assert.equal(restored.artwork_source, 'embedded');
      assert.equal(restored.has_custom_artwork, false);
      assert.ok(restored.artwork_url);

      // Confirm original FLAC binary was NEVER modified
      assert.equal(fileSha256(flacWithEmbeddedPath), originalFlacHash);
    } finally {
      conn2.close();
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
