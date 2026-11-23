import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFallbackTitle,
  extractFileExtension,
  normalizeTrackPath,
} from '../src/main/services/path-utils';

test('normalizeTrackPath normalizes Windows drive casing and slashes for duplicate detection', () => {
  const a = normalizeTrackPath('C:\\Music\\Lossless\\Track 01.FLAC', 'win32');
  const b = normalizeTrackPath('c:/music/lossless/track 01.flac', 'win32');
  const c = normalizeTrackPath('C:\\Music\\..\\Music\\Lossless\\Track 01.flac', 'win32');

  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(a, 'c:\\music\\lossless\\track 01.flac');
});

test('normalizeTrackPath keeps identical filenames in different folders distinct', () => {
  const albumA = normalizeTrackPath('D:\\Nhạc\\Album A\\01 Intro.flac', 'win32');
  const albumB = normalizeTrackPath('D:\\Nhạc\\Album B\\01 Intro.flac', 'win32');

  assert.notEqual(albumA, albumB);
});

test('normalizeTrackPath normalizes Vietnamese Unicode NFD and NFC identically', () => {
  const nfc = 'D:\\Nhạc Việt\\Đêm Đông (24-bit).flac'.normalize('NFC');
  const nfd = 'D:\\Nhạc Việt\\Đêm Đông (24-bit).flac'.normalize('NFD');

  assert.equal(normalizeTrackPath(nfc, 'win32'), normalizeTrackPath(nfd, 'win32'));
});

test('extractFallbackTitle and extractFileExtension handle Vietnamese and spaces', () => {
  const winPath = 'E:\\Thư mục nhạc\\Trịnh Công Sơn - Diễm Xưa.FLAC';
  assert.equal(extractFallbackTitle(winPath), 'Trịnh Công Sơn - Diễm Xưa');
  assert.equal(extractFileExtension(winPath), '.flac');
});
