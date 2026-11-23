import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openLibraryDatabase } from '../src/main/database/connection';
import { ProfileService } from '../src/main/services/profile-service';
import {
  buildEditorialFontMediaUrl,
  parseProfileMediaRequest,
} from '../src/shared/contracts/media-protocol';
import {
  computeEditorialTypographyMetrics,
  sanitizeEditorialTextLine,
  validateEditorialFontBytes,
} from '../src/shared/utils/editorial-typography';

function makeFakeFontBuffer(magic: number[], size = 64): Buffer {
  const buf = Buffer.alloc(size, 0x20);
  for (let i = 0; i < magic.length; i += 1) {
    buf[i] = magic[i];
  }
  return buf;
}

test('validateEditorialFontBytes accepts valid TTF, OTF, WOFF, and WOFF2 binary signatures', () => {
  const ttf = validateEditorialFontBytes(
    makeFakeFontBuffer([0x00, 0x01, 0x00, 0x00]),
    'My_Display-Font.ttf',
  );
  assert.equal(ttf.format, 'ttf');
  assert.equal(ttf.mimeType, 'font/ttf');
  assert.equal(ttf.displayName, 'My Display Font');

  const otf = validateEditorialFontBytes(
    makeFakeFontBuffer([0x4f, 0x54, 0x54, 0x4f]),
    'EditorialSerif.otf',
  );
  assert.equal(otf.format, 'otf');
  assert.equal(otf.mimeType, 'font/otf');

  const woff = validateEditorialFontBytes(
    makeFakeFontBuffer([0x77, 0x4f, 0x46, 0x46]),
    'Studio.woff',
  );
  assert.equal(woff.format, 'woff');
  assert.equal(woff.mimeType, 'font/woff');

  const woff2 = validateEditorialFontBytes(
    makeFakeFontBuffer([0x77, 0x4f, 0x46, 0x32]),
    'HiFiSans.woff2',
  );
  assert.equal(woff2.format, 'woff2');
  assert.equal(woff2.mimeType, 'font/woff2');
});

test('validateEditorialFontBytes rejects corrupt, mismatched, unsupported, or oversized files', () => {
  assert.throws(
    () => validateEditorialFontBytes(Buffer.from('not-a-real-font-file-bytes'), 'bad.ttf'),
    /không hợp lệ/i,
  );
  assert.throws(
    () => validateEditorialFontBytes(makeFakeFontBuffer([0x00, 0x01, 0x00, 0x00]), 'fake.exe'),
    /không được hỗ trợ/i,
  );
  assert.throws(
    () => validateEditorialFontBytes(makeFakeFontBuffer([0x77, 0x4f, 0x46, 0x46]), 'mismatch.woff2'),
    /không khớp/i,
  );
  assert.throws(
    () => validateEditorialFontBytes(makeFakeFontBuffer([0x00, 0x01, 0x00, 0x00], 200), 'big.ttf', 100),
    /vượt quá giới hạn/i,
  );
});

test('sanitizeEditorialTextLine preserves exact casing and full Vietnamese/CJK Unicode', () => {
  assert.equal(sanitizeEditorialTextLine('  Âm Nhạc Của Bạn  '), 'Âm Nhạc Của Bạn');
  assert.equal(sanitizeEditorialTextLine('静かな夜 · 고요한 밤'), '静かな夜 · 고요한 밤');
  assert.equal(sanitizeEditorialTextLine('your music'), 'your music');
});

test('computeEditorialTypographyMetrics lands within 110-160px on 1440x900 and scales safely on long text', () => {
  const m1440 = computeEditorialTypographyMetrics({
    topText: 'YOUR MUSIC',
    bottomText: 'YOUR WORLD',
    containerWidth: 1290,
    containerHeight: 700,
    fontSizeScale: 1,
  });
  assert.ok(m1440.topFontSizePx >= 110 && m1440.topFontSizePx <= 160, `got ${m1440.topFontSizePx}`);
  assert.ok(
    m1440.bottomFontSizePx >= 110 && m1440.bottomFontSizePx <= 160,
    `got ${m1440.bottomFontSizePx}`,
  );
  assert.equal(m1440.topLineLongWarning, false);

  const mLong = computeEditorialTypographyMetrics({
    topText: 'Thế Giới Âm Nhạc Lossless Dành Riêng Cho Bạn',
    bottomText: '静かな夜のハイファイ音楽コレクション',
    containerWidth: 940,
    containerHeight: 560,
    fontSizeScale: 1,
  });
  assert.equal(mLong.topLineLongWarning, true);
  assert.ok(mLong.topFontSizePx >= 42 && mLong.topFontSizePx < m1440.topFontSizePx);
  assert.ok(mLong.bottomFontSizePx >= 42 && mLong.bottomFontSizePx < m1440.bottomFontSizePx);
});

test('parseProfileMediaRequest supports lossless-media://profile/font/<id> and rejects traversal', () => {
  const url = buildEditorialFontMediaUrl('font_abcdef123456', 'abcdef123456');
  const parsed = parseProfileMediaRequest(url);
  assert.deepEqual(parsed, {
    kind: 'font',
    fontId: 'font_abcdef123456',
    hasVersionToken: true,
  });

  assert.equal(parseProfileMediaRequest('lossless-media://profile/font/../../etc/passwd'), null);
  assert.equal(parseProfileMediaRequest('lossless-media://profile/font/bad/nested'), null);
  assert.equal(parseProfileMediaRequest('lossless-media://profile/unknown'), null);
});

test('ProfileService imports local font independently of source path, serves via protocol, and deletes cleanly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doremi-font-test-'));
  const dbPath = path.join(tmpDir, 'doremi.db');
  const sourceFontPath = path.join(tmpDir, 'Custom_Editorial.woff2');
  const fontBytes = makeFakeFontBuffer([0x77, 0x4f, 0x46, 0x32], 128);
  fs.writeFileSync(sourceFontPath, fontBytes);

  const conn = openLibraryDatabase(dbPath);
  try {
    const service = new ProfileService({ db: conn.db, userDataDir: tmpDir });
    const imported = await service.importEditorialFontFromFile(sourceFontPath);
    assert.equal(imported.font.format, 'woff2');
    assert.equal(imported.font.name, 'Custom Editorial');
    assert.equal(imported.preferences.editorialTypography.selectedFontId, imported.font.id);

    // Delete original source file to prove full independence in userData/profile-media/fonts/
    fs.unlinkSync(sourceFontPath);

    // Reload preferences (simulates restart)
    const reloaded = service.getPreferences();
    assert.equal(reloaded.editorialFonts.length, 1);
    assert.equal(reloaded.editorialTypography.selectedFontId, imported.font.id);

    // Serve font through custom media protocol
    const res = await service.resolveProfileMediaHttpResponse(
      new Request(imported.font.url, { method: 'GET' }),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'font/woff2');
    const servedBytes = Buffer.from(await res.arrayBuffer());
    assert.equal(servedBytes.equals(fontBytes), true);

    // Delete font and verify active selection safely falls back to null (default font)
    const afterDelete = await service.deleteEditorialFont(imported.font.id);
    assert.equal(afterDelete.editorialFonts.length, 0);
    assert.equal(afterDelete.editorialTypography.selectedFontId, null);
  } finally {
    conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
