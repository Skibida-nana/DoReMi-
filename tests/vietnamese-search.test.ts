import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getActiveLyricIndex,
  getCircularGallerySlots,
  matchesVietnameseQuery,
  normalizeVietnameseText,
} from '../src/renderer/src/utils/vietnamese-search';

describe('vietnamese-search and gallery pure helpers', () => {
  it('normalizes Vietnamese diacritics including đ and Đ', () => {
    assert.equal(normalizeVietnameseText('Đen Vâu'), 'den vau');
    assert.equal(normalizeVietnameseText('Đêm Hà Nội Mùa Thu'), 'dem ha noi mua thu');
    assert.equal(normalizeVietnameseText('  Ánh   Sáng  Cuối  Ngày  '), 'anh sang cuoi ngay');
  });

  it('matches Vietnamese names with accent-insensitive queries', () => {
    assert.equal(matchesVietnameseQuery('Đen Vâu', 'den vau'), true);
    assert.equal(matchesVietnameseQuery('Vũ Cát Tường', 'vu cat'), true);
    assert.equal(matchesVietnameseQuery('Trịnh Công Sơn', 'trinh cong son'), true);
    assert.equal(matchesVietnameseQuery('Afterlight', 'velvet'), false);
    assert.equal(matchesVietnameseQuery('Afterlight', ''), true);
  });

  it('computes active lyric line index accurately for synced timestamps', () => {
    const lines = [
      { timeSec: 5, text: 'Line 1' },
      { timeSec: 12, text: 'Line 2' },
      { timeSec: 20, text: 'Line 3' },
    ];
    assert.equal(getActiveLyricIndex(lines, 0), -1);
    assert.equal(getActiveLyricIndex(lines, 5), 0);
    assert.equal(getActiveLyricIndex(lines, 11.5), 0);
    assert.equal(getActiveLyricIndex(lines, 12), 1);
    assert.equal(getActiveLyricIndex(lines, 25), 2);
  });

  it('maps 7 gallery slots circularly with centerIndex at slot 3', () => {
    assert.deepEqual(getCircularGallerySlots(7, 0), [4, 5, 6, 0, 1, 2, 3]);
    assert.deepEqual(getCircularGallerySlots(7, 3), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(getCircularGallerySlots(7, 6), [3, 4, 5, 6, 0, 1, 2]);
  });
});
