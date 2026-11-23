import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MetadataReadError, readTrackMetadata } from '../src/main/services/metadata-service';
import { discoverAudioFilesInFolder } from '../src/main/services/scanner-service';
import {
  createFlacMetadataBuffer,
  createWavBuffer,
  writeFixtureFile,
} from './helpers/audio-fixtures';

test('readTrackMetadata parses real FLAC tags & lossless specs without altering source file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lossless-meta-'));
  try {
    const flacPath = writeFixtureFile(
      path.join(dir, 'Nhạc Việt', 'Mùa Thu Cho Em.flac'),
      createFlacMetadataBuffer({
        sampleRate: 96000,
        bitsPerSample: 24,
        channels: 2,
        durationSeconds: 3,
        title: 'Mùa Thu Cho Em',
        artist: 'Ngô Thụy Miên',
        album: 'Tuyển Tập Acoustic',
      }),
    );

    const beforeBytes = fs.readFileSync(flacPath);
    const meta = await readTrackMetadata(flacPath);
    const afterBytes = fs.readFileSync(flacPath);

    assert.equal(meta.title, 'Mùa Thu Cho Em');
    assert.equal(meta.artist, 'Ngô Thụy Miên');
    assert.equal(meta.album, 'Tuyển Tập Acoustic');
    assert.equal(meta.sample_rate_hz, 96000);
    assert.equal(meta.bit_depth, 24);
    assert.equal(meta.duration_ms, 3000);
    assert.equal(meta.container, 'FLAC');
    assert.ok(beforeBytes.equals(afterBytes), 'Source audio file must remain byte-for-byte untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readTrackMetadata falls back to filename title & Unknown Artist on untagged WAV', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lossless-wav-'));
  try {
    const wavPath = writeFixtureFile(
      path.join(dir, 'Bản Thu Trực Tiếp 01.wav'),
      createWavBuffer({ sampleRate: 44100, bitsPerSample: 16, durationSeconds: 1 }),
    );

    const meta = await readTrackMetadata(wavPath);
    assert.equal(meta.title, 'Bản Thu Trực Tiếp 01');
    assert.equal(meta.artist, 'Unknown Artist');
    assert.equal(meta.album, null);
    assert.equal(meta.sample_rate_hz, 44100);
    assert.equal(meta.bit_depth, 16);
    assert.equal(meta.duration_ms, 1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readTrackMetadata throws MetadataReadError on corrupted file instead of guessing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lossless-corrupt-'));
  try {
    const brokenPath = writeFixtureFile(
      path.join(dir, 'broken.flac'),
      Buffer.from('NOT_A_VALID_AUDIO_FILE_CONTENT', 'utf8'),
    );

    await assert.rejects(() => readTrackMetadata(brokenPath), MetadataReadError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverAudioFilesInFolder recursively finds audio across Vietnamese subfolders and ignores non-audio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lossless-scan-'));
  try {
    writeFixtureFile(path.join(dir, 'Album 1', '01.flac'), createFlacMetadataBuffer());
    writeFixtureFile(path.join(dir, 'Album 1', 'CD2', '02 Tiếng Việt.wav'), createWavBuffer());
    writeFixtureFile(path.join(dir, 'Album 1', 'cover.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
    writeFixtureFile(path.join(dir, 'notes.txt'), Buffer.from('hello', 'utf8'));

    let progressEvents = 0;
    const result = await discoverAudioFilesInFolder(dir, {
      onProgress: () => {
        progressEvents += 1;
      },
    });

    assert.equal(result.errors.length, 0);
    assert.equal(result.files.length, 2);
    assert.ok(progressEvents > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
