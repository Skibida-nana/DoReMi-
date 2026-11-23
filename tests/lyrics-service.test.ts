import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openLibraryDatabase } from '../src/main/database/connection';
import { LibraryRootRepository } from '../src/main/database/library-root-repository';
import { LyricsRepository } from '../src/main/database/lyrics-repository';
import { TrackRepository } from '../src/main/database/track-repository';
import { LibraryService } from '../src/main/services/library-service';
import { LyricsService } from '../src/main/services/lyrics-service';
import {
  findActiveLyricLineIndex,
  parseLrcContent,
  parsePlainTextLyrics,
} from '../src/shared/utils/lyrics-parser';
import { createFlacMetadataBuffer, writeFixtureFile } from './helpers/audio-fixtures';

test('LRC parser supports multi-timestamp lines, offset, and chronological sorting', () => {
  const sampleLrc = [
    '[ti:Test Song]',
    '[offset:500]',
    '[00:20.00] Line B',
    '[00:05.50][00:30.00] Chorus Line',
    '[00:12] Line A',
  ].join('\n');

  const parsed = parseLrcContent(sampleLrc);
  assert.equal(parsed.offsetMs, 500);
  assert.equal(parsed.lines.length, 4);
  // With +500ms offset: timestamps shift earlier by 0.5s
  assert.equal(parsed.lines[0].timeSec, 5);
  assert.equal(parsed.lines[0].text, 'Chorus Line');
  assert.equal(parsed.lines[1].timeSec, 11.5);
  assert.equal(parsed.lines[1].text, 'Line A');
  assert.equal(parsed.lines[2].timeSec, 19.5);
  assert.equal(parsed.lines[2].text, 'Line B');
  assert.equal(parsed.lines[3].timeSec, 29.5);
  assert.equal(parsed.lines[3].text, 'Chorus Line');

  assert.equal(findActiveLyricLineIndex(parsed.lines, 2), -1);
  assert.equal(findActiveLyricLineIndex(parsed.lines, 5.1), 0);
  assert.equal(findActiveLyricLineIndex(parsed.lines, 15), 1);
  assert.equal(findActiveLyricLineIndex(parsed.lines, 35), 3);
});

test('Plain TXT parser preserves line breaks without fabricating timestamps', () => {
  const lines = parsePlainTextLyrics('Verse 1 line 1\r\nVerse 1 line 2\r\n\r\nChorus line');
  assert.deepEqual(lines, ['Verse 1 line 1', 'Verse 1 line 2', '', 'Chorus line']);
});

test('M3.3 Lyrics priority: Custom > Sidecar .lrc > Embedded > Empty + persistence + zero audio mutation', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doremi-lyrics-test-'));
  const dbPath = path.join(rootDir, 'library.db');
  const musicDir = path.join(rootDir, 'music');

  try {
    const flacWithBothPath = writeFixtureFile(
      path.join(musicDir, 'song-one.flac'),
      createFlacMetadataBuffer({
        title: 'Song One',
        artist: 'Artist One',
        lyrics: 'Embedded plain line 1\nEmbedded plain line 2',
      }),
    );
    const sidecarPath = writeFixtureFile(
      path.join(musicDir, 'song-one.lrc'),
      Buffer.from('[00:04.00] Sidecar line 1\n[00:10.00] Sidecar line 2', 'utf8'),
    );

    const flacEmbeddedOnlyPath = writeFixtureFile(
      path.join(musicDir, 'song-two.flac'),
      createFlacMetadataBuffer({
        title: 'Song Two',
        artist: 'Artist Two',
        lyrics: '[00:03.00] Embedded LRC line 1\n[00:09.00] Embedded LRC line 2',
      }),
    );

    const flacNoLyricsPath = writeFixtureFile(
      path.join(musicDir, 'song-three.flac'),
      createFlacMetadataBuffer({
        title: 'Instrumental Track',
        artist: 'Artist Three',
      }),
    );

    const customTxtImportPath = writeFixtureFile(
      path.join(rootDir, 'custom.txt'),
      Buffer.from('Custom static line 1\n\nCustom static line 2', 'utf8'),
    );

    const originalHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(flacWithBothPath))
      .digest('hex');

    let songOneId = '';

    const conn1 = openLibraryDatabase(dbPath);
    try {
      const trackRepo = new TrackRepository(conn1.db);
      const rootRepo = new LibraryRootRepository(conn1.db);
      const lyricsRepo = new LyricsRepository(conn1.db);
      const lyricsService = new LyricsService({ trackRepo, lyricsRepo });
      const libraryService = new LibraryService({
        trackRepo,
        rootRepo,
        databasePath: dbPath,
        lyricsRepo,
      });

      await libraryService.importFiles([
        flacWithBothPath,
        flacEmbeddedOnlyPath,
        flacNoLyricsPath,
      ]);

      const tracks = libraryService.getSnapshot().tracks;
      const tOne = tracks.find((t) => t.title === 'Song One')!;
      const tTwo = tracks.find((t) => t.title === 'Song Two')!;
      const tThree = tracks.find((t) => t.title === 'Instrumental Track')!;
      songOneId = tOne.id;

      // Sidecar .lrc overrides embedded lyrics
      const lOne = await lyricsService.resolveTrackLyrics(tOne.id);
      assert.equal(lOne.source, 'sidecar');
      assert.equal(lOne.format, 'lrc');
      assert.equal(lOne.sidecarPath, sidecarPath);
      assert.equal(lOne.timedLines.length, 2);

      // Embedded LRC works when no sidecar exists
      const lTwo = await lyricsService.resolveTrackLyrics(tTwo.id);
      assert.equal(lTwo.source, 'embedded');
      assert.equal(lTwo.format, 'lrc');
      assert.equal(lTwo.timedLines[0].text, 'Embedded LRC line 1');

      // Empty state when neither custom, sidecar, nor embedded exist
      const lThree = await lyricsService.resolveTrackLyrics(tThree.id);
      assert.equal(lThree.source, 'none');
      assert.equal(lThree.format, 'none');
      assert.equal(lThree.timedLines.length, 0);

      // Import custom TXT -> overrides sidecar .lrc and NEVER fabricates timedLines
      const importedCustom = await lyricsService.importCustomLyricsFromFile(
        tOne.id,
        customTxtImportPath,
      );
      assert.equal(importedCustom.source, 'custom');
      assert.equal(importedCustom.format, 'txt');
      assert.equal(importedCustom.hasCustomLyrics, true);
      assert.equal(importedCustom.timedLines.length, 0);
      assert.deepEqual(importedCustom.plainLines, [
        'Custom static line 1',
        '',
        'Custom static line 2',
      ]);
    } finally {
      conn1.close();
    }

    // Reopen DB -> custom lyrics persist, and removeCustomLyrics restores sidecar .lrc
    const conn2 = openLibraryDatabase(dbPath);
    try {
      const trackRepo = new TrackRepository(conn2.db);
      const lyricsRepo = new LyricsRepository(conn2.db);
      const lyricsService = new LyricsService({ trackRepo, lyricsRepo });

      const persisted = await lyricsService.resolveTrackLyrics(songOneId);
      assert.equal(persisted.source, 'custom');
      assert.equal(persisted.format, 'txt');

      const restored = await lyricsService.removeCustomLyrics(songOneId);
      assert.equal(restored.source, 'sidecar');
      assert.equal(restored.format, 'lrc');
      assert.equal(restored.hasCustomLyrics, false);

      // Verify source FLAC bytes untouched
      const afterHash = crypto
        .createHash('sha256')
        .update(fs.readFileSync(flacWithBothPath))
        .digest('hex');
      assert.equal(afterHash, originalHash);
    } finally {
      conn2.close();
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
