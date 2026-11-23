import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeLyricsBuffer,
  getSupportedLyricsEncodings,
  LyricsEncodingError,
} from '../src/shared/utils/lyrics-encoding';
import {
  findActiveLyricGroupIndex,
  groupTimedLyricLines,
  parseLrcContent,
  parsePlainTextLyrics,
} from '../src/shared/utils/lyrics-parser';
import {
  compareUnicodeText,
  matchesVietnameseQuery,
} from '../src/renderer/src/utils/vietnamese-search';

function encodeUtf16LeWithBom(text: string): Uint8Array {
  const buf = new Uint8Array(2 + text.length * 2);
  buf[0] = 0xff;
  buf[1] = 0xfe;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    buf[2 + i * 2] = code & 0xff;
    buf[2 + i * 2 + 1] = code >> 8;
  }
  return buf;
}

function encodeUtf16BeWithBom(text: string): Uint8Array {
  const buf = new Uint8Array(2 + text.length * 2);
  buf[0] = 0xfe;
  buf[1] = 0xff;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    buf[2 + i * 2] = code >> 8;
    buf[2 + i * 2 + 1] = code & 0xff;
  }
  return buf;
}

test('Multilingual & CJK Lyrics Suite (20 core cases: UTF-8/BOM/UTF-16/CJK encodings, bilingual LRC, offset, search/sort)', () => {
  // 1. UTF-8 Simplified Chinese LRC
  const zhCnLrc = '[00:05.00] 晴天微风吹过校园\n[00:12.50] 故事的小黄花';
  const r1 = decodeLyricsBuffer(new TextEncoder().encode(zhCnLrc));
  assert.equal(r1.detectedEncoding, 'utf-8');
  assert.equal(parseLrcContent(r1.text).lines[0].text, '晴天微风吹过校园');

  // 2. UTF-8 Traditional Chinese LRC
  const zhTwLrc = '[00:08.00] 遙遠的夢境裡\n[00:15.00] 閃爍著星光';
  const r2 = decodeLyricsBuffer(new TextEncoder().encode(zhTwLrc));
  assert.equal(parseLrcContent(r2.text).lines[1].text, '閃爍著星光');

  // 3. UTF-8 Japanese (Kanji + Hiragana + Katakana)
  const jaLrc = '[00:03.20] 静かな夜にメロディーが響く';
  const r3 = decodeLyricsBuffer(new TextEncoder().encode(jaLrc));
  assert.equal(parseLrcContent(r3.text).lines[0].text, '静かな夜にメロディーが響く');

  // 4. UTF-8 Korean (Hangul)
  const koLrc = '[00:04.00] 밤하늘에 별이 빛나고 있어';
  const r4 = decodeLyricsBuffer(new TextEncoder().encode(koLrc));
  assert.equal(parseLrcContent(r4.text).lines[0].text, '밤하늘에 별이 빛나고 있어');

  // 5. UTF-8 Vietnamese with full diacritics
  const viLrc = '[00:06.50] Đêm thu nghe tiếng đàn dương cầm ngân vang';
  const r5 = decodeLyricsBuffer(new TextEncoder().encode(viLrc));
  assert.equal(parseLrcContent(r5.text).lines[0].text, 'Đêm thu nghe tiếng đàn dương cầm ngân vang');

  // 6. UTF-8 with BOM stripped cleanly
  const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(jaLrc)]);
  const r6 = decodeLyricsBuffer(bomBytes);
  assert.equal(r6.confidence, 'bom');
  assert.equal(r6.text.startsWith('\uFEFF'), false);

  // 7. UTF-16 LE with BOM
  const r7 = decodeLyricsBuffer(encodeUtf16LeWithBom('[00:02.00] 桜の花びら'));
  assert.equal(r7.detectedEncoding, 'utf-16le');
  assert.equal(parseLrcContent(r7.text).lines[0].text, '桜の花びら');

  // 8. UTF-16 BE with BOM
  const r8 = decodeLyricsBuffer(encodeUtf16BeWithBom('[00:02.00] 사랑해요'));
  assert.equal(r8.detectedEncoding, 'utf-16be');
  assert.equal(parseLrcContent(r8.text).lines[0].text, '사랑해요');

  // 9. Shift-JIS Japanese binary LRC ("静かな夜" in Shift-JIS = 90 C3 82 A9 82 C8 96 E9)
  const sjisBytes = new Uint8Array([
    ...new TextEncoder().encode('[00:10.00] '),
    0x90, 0xc3, 0x82, 0xa9, 0x82, 0xc8, 0x96, 0xe9,
  ]);
  const r9 = decodeLyricsBuffer(sjisBytes, 'auto');
  assert.equal(r9.detectedEncoding, 'shift_jis');
  assert.ok(r9.text.includes('静かな夜'));

  // 10. Explicit Shift-JIS override
  const r10 = decodeLyricsBuffer(sjisBytes, 'shift_jis');
  assert.equal(r10.confidence, 'explicit');
  assert.ok(r10.text.includes('静かな夜'));

  // 11. GB18030 / GBK Simplified Chinese ("晴天" = C7 E7 CC EC)
  const gbkBytes = new Uint8Array([
    ...new TextEncoder().encode('[00:05.00] '),
    0xc7, 0xe7, 0xcc, 0xec,
  ]);
  const r11 = decodeLyricsBuffer(gbkBytes, 'gb18030');
  assert.ok(r11.text.includes('晴天'));

  // 12. EUC-KR Korean ("사랑" = BB E7 B6 FB)
  const eucKrBytes = new Uint8Array([
    ...new TextEncoder().encode('[00:07.00] '),
    0xbb, 0xe7, 0xb6, 0xfb,
  ]);
  const r12 = decodeLyricsBuffer(eucKrBytes, 'euc-kr');
  assert.ok(r12.text.includes('사랑'));

  // 13. Big5 Traditional Chinese ("星光" = AC 50 A5 FA)
  const big5Bytes = new Uint8Array([
    ...new TextEncoder().encode('[00:09.00] '),
    0xac, 0x50, 0xa5, 0xfa,
  ]);
  const r13 = decodeLyricsBuffer(big5Bytes, 'big5');
  assert.ok(r13.text.includes('星光'));

  // 14. Corrupt/invalid binary sequence throws LyricsEncodingError safely (never saves mojibake)
  const garbage = new Uint8Array([0xff, 0xfe, 0x00, 0xd8, 0x00, 0x00, 0x80, 0x81, 0xfe, 0xff]);
  assert.throws(() => decodeLyricsBuffer(garbage, 'utf-8'), LyricsEncodingError);

  // 15. Bilingual same-timestamp LRC grouping (Japanese + Vietnamese)
  const bilingualLrc = [
    '[00:05.00] 静かな夜に光が降る',
    '[00:05.00] Ánh sáng rơi xuống trong đêm tĩnh lặng',
    '[00:12.00] 君の声を探している',
    '[00:12.00] Anh vẫn đi tìm giọng nói của em',
  ].join('\n');
  const parsedBilingual = parseLrcContent(bilingualLrc);
  const groups = groupTimedLyricLines(parsedBilingual.lines);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].lines, [
    '静かな夜に光が降る',
    'Ánh sáng rơi xuống trong đêm tĩnh lặng',
  ]);
  assert.equal(findActiveLyricGroupIndex(groups, 6.2), 0);
  assert.equal(findActiveLyricGroupIndex(groups, 13.0), 1);

  // 16. Multi-timestamp chorus line [00:10.00][01:20.00]
  const multiTs = parseLrcContent('[00:10.00][01:20.00] La la la 桜');
  assert.equal(multiTs.lines.length, 2);
  assert.equal(multiTs.lines[0].timeSec, 10);
  assert.equal(multiTs.lines[1].timeSec, 80);

  // 17. [offset:+500] shifts timestamps 0.5s earlier per LRC spec (10.0 - 0.5 = 9.5)
  const withOffset = parseLrcContent('[offset:500]\n[00:10.00] Offset line');
  assert.equal(withOffset.lines[0].timeSec, 9.5);

  // 18. Static TXT preserves CJK & blank stanza lines without inventing timestamps
  const plainLines = parsePlainTextLyrics('第一行\n\n第二行\r\n日本語');
  assert.deepEqual(plainLines, ['第一行', '', '第二行', '日本語']);

  // 19. Multilingual search matches Vietnamese (with/without diacritics) AND CJK exact text
  assert.equal(matchesVietnameseQuery('Đêm Mưa Sài Gòn', 'dem mua'), true);
  assert.equal(matchesVietnameseQuery('夜に駆ける — YOASOBI', '夜に駆'), true);
  assert.equal(matchesVietnameseQuery('봄날 (Spring Day)', '봄날'), true);

  // 20. Unicode collation sort + supported encodings list
  const sorted = ['Đêm', 'Anh', '桜', '사랑'].sort(compareUnicodeText);
  assert.equal(sorted.length, 4);
  const encodings = getSupportedLyricsEncodings();
  assert.ok(encodings.includes('utf-8'));
  assert.ok(encodings.includes('shift_jis'));
});
