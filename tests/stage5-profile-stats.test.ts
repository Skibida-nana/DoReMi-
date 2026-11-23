import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openLibraryDatabase } from '../src/main/database/connection';
import {
  DEFAULT_DISPLAY_NAME,
  ProfileService,
  isAnimatedGifBuffer,
  sanitizeDisplayName,
  validateProfileImageBuffer,
} from '../src/main/services/profile-service';
import {
  aggregateListeningStatistics,
  isQualifiedPlay,
  splitListeningIntoLocalBuckets,
} from '../src/shared/utils/statistics-engine';
import type { StoredListeningSession } from '../src/shared/types/stage5';
import { getNonRepeatingEditorialSlots } from '../src/renderer/src/utils/vietnamese-search';

function createMinimalTwoFrameGif(): Buffer {
  // Valid minimal GIF89a with two Image Descriptor blocks (0x2C) so isAnimatedGifBuffer === true
  return Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
    0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, // 1x1, GCT flag
    0x00, 0x00, 0x00, 0xff, 0xff, 0xff, // 2-color GCT
    // Frame 1
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x4c, 0x01, 0x00,
    // Frame 2
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x44, 0x01, 0x00,
    0x3b, // Trailer
  ]);
}

test('sanitizeDisplayName preserves Vietnamese, CJK, and falls back to default when empty', () => {
  assert.equal(sanitizeDisplayName('  Nguyễn Minh Đức  '), 'Nguyễn Minh Đức');
  assert.equal(sanitizeDisplayName('佐藤 健太 · 김민준 · 林俊傑'), '佐藤 健太 · 김민준 · 林俊傑');
  assert.equal(sanitizeDisplayName('   \u0000\u0007  '), DEFAULT_DISPLAY_NAME);
  assert.equal(Array.from(sanitizeDisplayName('a'.repeat(120))).length, 48);
});

test('ProfileService preserves raw animated GIF bytes and persists preferences across DB restarts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doremi-profile-test-'));
  const dbPath = path.join(dir, 'library.db');
  const gifPath = path.join(dir, 'animated-avatar.gif');
  const gifBytes = createMinimalTwoFrameGif();
  fs.writeFileSync(gifPath, gifBytes);

  try {
    assert.equal(isAnimatedGifBuffer(gifBytes), true);
    const validated = validateProfileImageBuffer(gifBytes, { allowGif: true });
    assert.equal(validated.mimeType, 'image/gif');
    assert.equal(validated.isAnimated, true);

    assert.throws(
      () => validateProfileImageBuffer(gifBytes, { allowGif: false }),
      /Ảnh nền chỉ hỗ trợ/,
    );

    const conn1 = openLibraryDatabase(dbPath);
    try {
      const svc = new ProfileService({ db: conn1.db, userDataDir: dir });
      svc.updateDisplayName('DoReMi 音楽リスナー');
      const afterGif = await svc.importAvatarFromFile(gifPath);
      assert.equal(afterGif.avatarIsAnimated, true);
      assert.equal(afterGif.avatarMime, 'image/gif');
      assert.ok(afterGif.avatarUrl?.startsWith('lossless-media://profile/avatar'));

      // Delete source file to verify app keeps its own independent copy
      fs.unlinkSync(gifPath);

      svc.updatePreferences({
        themeMode: 'light',
        accentPresetId: 'emerald',
        customAccentHex: '#10B981',
        reducedMotion: true,
        transition: { enabled: true, durationSec: 2 },
      });
    } finally {
      conn1.close();
    }

    // Reopen DB to verify persistence
    const conn2 = openLibraryDatabase(dbPath);
    try {
      const svc2 = new ProfileService({ db: conn2.db, userDataDir: dir });
      const profile = svc2.getProfile();
      assert.equal(profile.displayName, 'DoReMi 音楽リスナー');
      assert.equal(profile.avatarIsAnimated, true);
      assert.ok(profile.avatarUrl);

      const prefs = svc2.getPreferences();
      assert.equal(prefs.themeMode, 'light');
      assert.equal(prefs.customAccentHex, '#10B981');
      assert.equal(prefs.reducedMotion, true);
      assert.equal(prefs.transition.enabled, true);
      assert.equal(prefs.transition.durationSec, 2);
    } finally {
      conn2.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Qualified Play rules strictly enforce >= 30s for >= 60s tracks and >= 50% for short tracks', () => {
  // Standard 3-minute song
  assert.equal(isQualifiedPlay(0, 180_000), false);
  assert.equal(isQualifiedPlay(29_999, 180_000), false);
  assert.equal(isQualifiedPlay(30_000, 180_000), true);

  // Short 40s interlude -> threshold is 20s
  assert.equal(isQualifiedPlay(19_500, 40_000), false);
  assert.equal(isQualifiedPlay(20_000, 40_000), true);
});

test('splitListeningIntoLocalBuckets splits cross-midnight sessions across calendar dates accurately', () => {
  const start = new Date(2026, 4, 10, 23, 45, 0, 0).getTime();
  const end = new Date(2026, 4, 11, 0, 15, 0, 0).getTime();
  const buckets = splitListeningIntoLocalBuckets({
    startedAtMs: start,
    endedAtMs: end,
    listenedMs: 30 * 60_000,
    activeIntervals: [{ startMs: start, endMs: end }],
  });

  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].localDate, '2026-05-10');
  assert.equal(buckets[0].localHour, 23);
  assert.equal(buckets[0].listenedMs, 15 * 60_000);
  assert.equal(buckets[1].localDate, '2026-05-11');
  assert.equal(buckets[1].localHour, 0);
  assert.equal(buckets[1].listenedMs, 15 * 60_000);
});

test('aggregateListeningStatistics computes real stats across all 6 time ranges and groups deleted tracks', () => {
  const now = new Date(2026, 4, 15, 14, 0, 0, 0).getTime();
  const s1Start = new Date(2026, 4, 15, 10, 0, 0, 0).getTime();
  const s1End = s1Start + 180_000;
  const s2Start = new Date(2026, 4, 14, 21, 0, 0, 0).getTime();
  const s2End = s2Start + 90_000;

  const sessions: StoredListeningSession[] = [
    {
      sessionId: 'sess-1',
      trackId: 'trk-live',
      trackTitle: 'Bài Hát Còn Tồn Tại',
      artist: 'Nghệ Sĩ A',
      album: 'Album A',
      durationMs: 200_000,
      startedAtMs: s1Start,
      endedAtMs: s1End,
      listenedMs: 180_000,
      qualifiedPlay: true,
      isDeletedTrack: false,
      activeIntervals: [{ startMs: s1Start, endMs: s1End }],
      updatedAt: new Date(s1End).toISOString(),
    },
    {
      sessionId: 'sess-2',
      trackId: 'trk-deleted',
      trackTitle: 'Bản Thu Đã Xóa',
      artist: 'Nghệ Sĩ B',
      album: 'Album B',
      durationMs: 150_000,
      startedAtMs: s2Start,
      endedAtMs: s2End,
      listenedMs: 90_000,
      qualifiedPlay: true,
      isDeletedTrack: true,
      activeIntervals: [{ startMs: s2Start, endMs: s2End }],
      updatedAt: new Date(s2End).toISOString(),
    },
  ];

  const todayStats = aggregateListeningStatistics(sessions, { range: 'today', nowMs: now });
  assert.equal(todayStats.hasAnyData, true);
  assert.equal(todayStats.qualifiedPlays, 1);
  assert.equal(todayStats.totalListenedMs, 180_000);

  const weekStats = aggregateListeningStatistics(sessions, { range: 'week', nowMs: now });
  assert.equal(weekStats.qualifiedPlays, 2);
  assert.equal(weekStats.uniqueTracksPlayed, 2);
  assert.equal(weekStats.deletedGroup.uniqueTrackCount, 1);
  assert.equal(weekStats.deletedGroup.qualifiedPlays, 1);
  assert.ok(weekStats.topTracks.some((t) => t.title.includes('Bài đã xóa')));

  const monthStats = aggregateListeningStatistics(sessions, { range: 'month', nowMs: now });
  const yearStats = aggregateListeningStatistics(sessions, { range: 'year', nowMs: now });
  const allStats = aggregateListeningStatistics(sessions, { range: 'all', nowMs: now });
  const customStats = aggregateListeningStatistics(sessions, {
    range: 'custom',
    customStartDate: '2026-05-14',
    customEndDate: '2026-05-15',
    nowMs: now,
  });

  assert.equal(monthStats.qualifiedPlays, 2);
  assert.equal(yearStats.byDay.length, 12);
  assert.equal(allStats.qualifiedPlays, 2);
  assert.equal(customStats.qualifiedPlays, 2);
});

test('getNonRepeatingEditorialSlots never duplicates playlist IDs for small counts (0..8)', () => {
  for (let count = 0; count <= 8; count += 1) {
    const slots = getNonRepeatingEditorialSlots(count, 0);
    const seen = new Set(slots.map((s) => s.itemIndex));
    assert.equal(seen.size, slots.length, `Duplicate slot found for count=${count}`);
    if (count > 0 && count <= 7) {
      assert.equal(slots.length, count);
    }
    if (count > 7) {
      assert.equal(slots.length, 7);
    }
  }
});
