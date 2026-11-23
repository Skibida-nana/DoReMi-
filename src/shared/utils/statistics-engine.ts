import type {
  DeletedTracksStatGroup,
  ListeningDayPoint,
  ListeningHourPoint,
  ListeningSessionInput,
  StatisticsDashboardData,
  StatisticsQuery,
  StoredListeningSession,
  TopAlbumStat,
  TopArtistStat,
  TopTrackStat,
} from '../types/stage5';

export interface DailyHourBucket {
  localDate: string; // YYYY-MM-DD in local timezone
  localHour: number; // 0..23 in local timezone
  listenedMs: number;
}

/**
 * Qualified Play specification (M5.6 §6.6):
 * - Track duration >= 60s: actual active listening >= 30s (30,000 ms).
 * - Track duration < 60s (and > 0): actual active listening >= 50% of duration.
 * - Unknown/missing duration: fallback threshold >= 30s.
 * - Each listening session counts at most 1 qualified play.
 */
export function isQualifiedPlay(listenedMs: number, durationMs: number | null): boolean {
  if (!Number.isFinite(listenedMs) || listenedMs <= 0) {
    return false;
  }
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) {
    return listenedMs >= 30_000;
  }
  if (durationMs >= 60_000) {
    return listenedMs >= 30_000;
  }
  return listenedMs >= durationMs * 0.5;
}

export function formatLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseLocalDateKey(dateKey: string): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0);
}

/**
 * Splits active listening time across local calendar dates and local hours.
 * Handles cross-midnight sessions (e.g. 23:45 -> 00:15) accurately with zero double-counting.
 */
export function splitListeningIntoLocalBuckets(
  session: Pick<ListeningSessionInput, 'startedAtMs' | 'endedAtMs' | 'listenedMs' | 'activeIntervals'>,
): DailyHourBucket[] {
  const bucketMap = new Map<string, DailyHourBucket>();

  const addRange = (rangeStartMs: number, rangeEndMs: number, scale = 1) => {
    let cursor = Math.min(rangeStartMs, rangeEndMs);
    const limit = Math.max(rangeStartMs, rangeEndMs);
    if (!Number.isFinite(cursor) || !Number.isFinite(limit) || limit <= cursor) {
      return;
    }

    while (cursor < limit) {
      const currentDate = new Date(cursor);
      const nextHourBoundary = new Date(
        currentDate.getFullYear(),
        currentDate.getMonth(),
        currentDate.getDate(),
        currentDate.getHours() + 1,
        0,
        0,
        0,
      ).getTime();

      const sliceEnd = Math.min(limit, nextHourBoundary);
      const rawMs = Math.max(0, sliceEnd - cursor);
      const attributedMs = Math.round(rawMs * scale);

      if (attributedMs > 0) {
        const localDate = formatLocalDateKey(currentDate);
        const localHour = currentDate.getHours();
        const key = `${localDate}#${localHour}`;
        const existing = bucketMap.get(key);
        if (existing) {
          existing.listenedMs += attributedMs;
        } else {
          bucketMap.set(key, { localDate, localHour, listenedMs: attributedMs });
        }
      }

      cursor = sliceEnd;
    }
  };

  if (session.activeIntervals && session.activeIntervals.length > 0) {
    let totalRaw = 0;
    for (const seg of session.activeIntervals) {
      if (seg.endMs > seg.startMs) {
        totalRaw += seg.endMs - seg.startMs;
      }
    }
    const targetMs = Math.max(0, Math.round(session.listenedMs));
    const scale = totalRaw > 0 && targetMs > 0 ? Math.min(1, targetMs / totalRaw) : 1;
    for (const seg of session.activeIntervals) {
      addRange(seg.startMs, seg.endMs, scale);
    }
  } else {
    const clampedListened = Math.max(0, Math.round(session.listenedMs));
    if (clampedListened > 0) {
      const span = Math.max(0, session.endedAtMs - session.startedAtMs);
      if (span <= 0) {
        const d = new Date(session.startedAtMs);
        const localDate = formatLocalDateKey(d);
        const localHour = d.getHours();
        bucketMap.set(`${localDate}#${localHour}`, {
          localDate,
          localHour,
          listenedMs: clampedListened,
        });
      } else {
        // Proportionally distribute active listenedMs across the session's local wall-clock span
        // so pauses don't inflate listenedMs while cross-midnight proportions stay exact.
        const scale = clampedListened / span;
        addRange(session.startedAtMs, session.endedAtMs, scale);
      }
    }
  }

  return Array.from(bucketMap.values()).sort((a, b) =>
    a.localDate !== b.localDate
      ? a.localDate.localeCompare(b.localDate)
      : a.localHour - b.localHour,
  );
}

export interface ResolvedPeriodWindow {
  startDateKey: string;
  endDateKey: string;
  periodLabel: string;
  canStepForward: boolean;
  dayKeys: string[];
}

function enumerateDateKeys(start: Date, end: Date, maxDays = 400): string[] {
  const keys: string[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const limit = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  let guard = 0;
  while (cursor <= limit && guard < maxDays) {
    keys.push(formatLocalDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }
  return keys;
}

/**
 * Resolves the local-timezone date boundaries for Today, This Week (Mon-Sun),
 * This Month, This Year, All Time, or Custom Range.
 */
export function resolveStatisticsPeriodWindow(
  query: StatisticsQuery,
  earliestDateKey?: string | null,
): ResolvedPeriodWindow {
  const now = new Date(query.nowMs ?? Date.now());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const offset = Math.min(0, Math.trunc(query.periodOffset ?? 0));

  if (query.range === 'today') {
    const target = new Date(today);
    target.setDate(target.getDate() + offset);
    const key = formatLocalDateKey(target);
    const label =
      offset === 0
        ? 'Hôm nay'
        : offset === -1
          ? 'Hôm qua'
          : target.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    return {
      startDateKey: key,
      endDateKey: key,
      periodLabel: label,
      canStepForward: offset < 0,
      dayKeys: [key],
    };
  }

  if (query.range === 'week') {
    const dayOfWeek = today.getDay(); // 0 = Sun, 1 = Mon...
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(today);
    monday.setDate(today.getDate() - daysSinceMonday + offset * 7);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const startKey = formatLocalDateKey(monday);
    const endKey = formatLocalDateKey(sunday);
    const label =
      offset === 0
        ? 'Tuần này'
        : `${monday.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })} – ${sunday.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })}`;
    return {
      startDateKey: startKey,
      endDateKey: endKey,
      periodLabel: label,
      canStepForward: offset < 0,
      dayKeys: enumerateDateKeys(monday, sunday),
    };
  }

  if (query.range === 'month') {
    const start = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
    const label =
      offset === 0
        ? `Tháng ${start.getMonth() + 1}/${start.getFullYear()}`
        : `Tháng ${start.getMonth() + 1}/${start.getFullYear()}`;
    return {
      startDateKey: formatLocalDateKey(start),
      endDateKey: formatLocalDateKey(end),
      periodLabel: label,
      canStepForward: offset < 0,
      dayKeys: enumerateDateKeys(start, end),
    };
  }

  if (query.range === 'year') {
    const year = today.getFullYear() + offset;
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);
    return {
      startDateKey: formatLocalDateKey(start),
      endDateKey: formatLocalDateKey(end),
      periodLabel: `Năm ${year}`,
      canStepForward: offset < 0,
      dayKeys: enumerateDateKeys(start, end),
    };
  }

  if (query.range === 'custom') {
    const start = query.customStartDate ? parseLocalDateKey(query.customStartDate) : today;
    const end = query.customEndDate ? parseLocalDateKey(query.customEndDate) : today;
    const orderedStart = start <= end ? start : end;
    const orderedEnd = start <= end ? end : start;
    const startKey = formatLocalDateKey(orderedStart);
    const endKey = formatLocalDateKey(orderedEnd);
    return {
      startDateKey: startKey,
      endDateKey: endKey,
      periodLabel: `${orderedStart.toLocaleDateString('vi-VN')} – ${orderedEnd.toLocaleDateString('vi-VN')}`,
      canStepForward: false,
      dayKeys: enumerateDateKeys(orderedStart, orderedEnd),
    };
  }

  // 'all'
  const start = earliestDateKey ? parseLocalDateKey(earliestDateKey) : today;
  const startKey = formatLocalDateKey(start <= today ? start : today);
  const endKey = formatLocalDateKey(today);
  return {
    startDateKey: startKey,
    endDateKey: endKey,
    periodLabel: 'Toàn thời gian',
    canStepForward: false,
    dayKeys: enumerateDateKeys(parseLocalDateKey(startKey), today),
  };
}

export interface TrackLookupMetadata {
  title: string;
  artist: string | null;
  album: string | null;
  artworkUrl: string | null;
  isDeleted: boolean;
}

/**
 * Pure deterministic statistics aggregator operating on real listening sessions.
 * Used identically for SQLite-backed Electron stats and browser-preview persisted sessions.
 */
export function aggregateListeningStatistics(
  sessions: readonly StoredListeningSession[],
  query: StatisticsQuery,
  trackLookup?: (trackId: string) => TrackLookupMetadata | null,
): StatisticsDashboardData {
  // Determine earliest local date across sessions for 'all' range
  let earliestDateKey: string | null = null;
  const sessionBuckets = sessions.map((session) => {
    const buckets = splitListeningIntoLocalBuckets(session);
    for (const b of buckets) {
      if (!earliestDateKey || b.localDate < earliestDateKey) {
        earliestDateKey = b.localDate;
      }
    }
    return { session, buckets };
  });

  const window = resolveStatisticsPeriodWindow(query, earliestDateKey);
  const { startDateKey, endDateKey } = window;

  const dayTotals = new Map<string, { listenedMs: number; qualifiedPlays: number }>();
  const hourTotals = new Array<number>(24).fill(0);

  let totalListenedMs = 0;
  let qualifiedPlays = 0;
  const uniqueTrackIds = new Set<string>();

  const trackStats = new Map<
    string,
    {
      trackId: string;
      title: string;
      artist: string;
      album: string;
      qualifiedPlays: number;
      listenedMs: number;
      isDeleted: boolean;
      artworkUrl: string | null;
    }
  >();

  const artistStats = new Map<string, { qualifiedPlays: number; listenedMs: number }>();
  const albumStats = new Map<
    string,
    { album: string; artist: string; qualifiedPlays: number; listenedMs: number; artworkUrl: string | null }
  >();

  const deletedTrackIds = new Set<string>();
  let deletedQualifiedPlays = 0;
  let deletedListenedMs = 0;

  for (const { session, buckets } of sessionBuckets) {
    const inRangeBuckets = buckets.filter(
      (b) => b.localDate >= startDateKey && b.localDate <= endDateKey,
    );
    const inRangeMs = inRangeBuckets.reduce((sum, b) => sum + b.listenedMs, 0);
    if (inRangeMs <= 0) {
      continue;
    }

    totalListenedMs += inRangeMs;
    for (const b of inRangeBuckets) {
      const prev = dayTotals.get(b.localDate) ?? { listenedMs: 0, qualifiedPlays: 0 };
      prev.listenedMs += b.listenedMs;
      dayTotals.set(b.localDate, prev);
      hourTotals[b.localHour] += b.listenedMs;
    }

    // Attribute a session's qualified play to the local date when the session ended (or started if ended outside)
    const sessionEndDate = formatLocalDateKey(new Date(session.endedAtMs));
    const qualifiedInRange =
      session.qualifiedPlay &&
      sessionEndDate >= startDateKey &&
      sessionEndDate <= endDateKey;

    if (qualifiedInRange) {
      qualifiedPlays += 1;
      const dayEntry = dayTotals.get(sessionEndDate) ?? { listenedMs: 0, qualifiedPlays: 0 };
      dayEntry.qualifiedPlays += 1;
      dayTotals.set(sessionEndDate, dayEntry);
    }

    uniqueTrackIds.add(session.trackId);

    const liveInfo = trackLookup ? trackLookup(session.trackId) : null;
    const isDeleted = liveInfo ? liveInfo.isDeleted : Boolean(session.isDeletedTrack);
    const title = liveInfo?.title ?? session.trackTitle;
    const artist = liveInfo?.artist ?? session.artist ?? 'Chưa rõ nghệ sĩ';
    const album = liveInfo?.album ?? session.album ?? 'Đĩa đơn / Chưa phân loại';
    const artworkUrl = liveInfo?.artworkUrl ?? null;

    if (isDeleted) {
      deletedTrackIds.add(session.trackId);
      deletedListenedMs += inRangeMs;
      if (qualifiedInRange) {
        deletedQualifiedPlays += 1;
      }
    }

    const existingTrack = trackStats.get(session.trackId);
    if (existingTrack) {
      existingTrack.listenedMs += inRangeMs;
      if (qualifiedInRange) {
        existingTrack.qualifiedPlays += 1;
      }
    } else {
      trackStats.set(session.trackId, {
        trackId: session.trackId,
        title: isDeleted ? `${title} (Bài đã xóa)` : title,
        artist,
        album,
        qualifiedPlays: qualifiedInRange ? 1 : 0,
        listenedMs: inRangeMs,
        isDeleted,
        artworkUrl,
      });
    }

    const existingArtist = artistStats.get(artist) ?? { qualifiedPlays: 0, listenedMs: 0 };
    existingArtist.listenedMs += inRangeMs;
    if (qualifiedInRange) {
      existingArtist.qualifiedPlays += 1;
    }
    artistStats.set(artist, existingArtist);

    const albumKey = `${album}__${artist}`;
    const existingAlbum = albumStats.get(albumKey);
    if (existingAlbum) {
      existingAlbum.listenedMs += inRangeMs;
      if (qualifiedInRange) {
        existingAlbum.qualifiedPlays += 1;
      }
      if (!existingAlbum.artworkUrl && artworkUrl) {
        existingAlbum.artworkUrl = artworkUrl;
      }
    } else {
      albumStats.set(albumKey, {
        album,
        artist,
        qualifiedPlays: qualifiedInRange ? 1 : 0,
        listenedMs: inRangeMs,
        artworkUrl,
      });
    }
  }

  // Build Listening By Day series (if year/all > 31 days, group into monthly buckets for readability)
  let byDay: ListeningDayPoint[];
  if (query.range === 'year' || window.dayKeys.length > 45) {
    const monthBuckets = new Map<string, { listenedMs: number; qualifiedPlays: number }>();
    for (const [dateKey, entry] of dayTotals.entries()) {
      const monthKey = dateKey.slice(0, 7); // YYYY-MM
      const cur = monthBuckets.get(monthKey) ?? { listenedMs: 0, qualifiedPlays: 0 };
      cur.listenedMs += entry.listenedMs;
      cur.qualifiedPlays += entry.qualifiedPlays;
      monthBuckets.set(monthKey, cur);
    }

    if (query.range === 'year') {
      const yearPrefix = startDateKey.slice(0, 4);
      byDay = Array.from({ length: 12 }, (_, idx) => {
        const mKey = `${yearPrefix}-${String(idx + 1).padStart(2, '0')}`;
        const entry = monthBuckets.get(mKey) ?? { listenedMs: 0, qualifiedPlays: 0 };
        return {
          dateKey: `${mKey}-01`,
          label: `T${idx + 1}`,
          listenedMs: entry.listenedMs,
          minutes: Math.round(entry.listenedMs / 60_000),
          qualifiedPlays: entry.qualifiedPlays,
        };
      });
    } else {
      const sortedMonths = Array.from(monthBuckets.entries()).sort((a, b) =>
        a[0].localeCompare(b[0]),
      );
      byDay = sortedMonths.map(([mKey, entry]) => ({
        dateKey: `${mKey}-01`,
        label: `${mKey.slice(5)}/${mKey.slice(2, 4)}`,
        listenedMs: entry.listenedMs,
        minutes: Math.round(entry.listenedMs / 60_000),
        qualifiedPlays: entry.qualifiedPlays,
      }));
    }
  } else {
    byDay = window.dayKeys.map((dateKey) => {
      const entry = dayTotals.get(dateKey) ?? { listenedMs: 0, qualifiedPlays: 0 };
      const d = parseLocalDateKey(dateKey);
      const label =
        query.range === 'week'
          ? ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][d.getDay()]
          : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
      return {
        dateKey,
        label,
        listenedMs: entry.listenedMs,
        minutes: Math.round(entry.listenedMs / 60_000),
        qualifiedPlays: entry.qualifiedPlays,
      };
    });
  }

  const byHour: ListeningHourPoint[] = hourTotals.map((ms, hour) => ({
    hour,
    label: `${String(hour).padStart(2, '0')}h`,
    listenedMs: ms,
    minutes: Math.round(ms / 60_000),
  }));

  const topTracks: TopTrackStat[] = Array.from(trackStats.values())
    .sort((a, b) =>
      b.qualifiedPlays !== a.qualifiedPlays
        ? b.qualifiedPlays - a.qualifiedPlays
        : b.listenedMs - a.listenedMs,
    )
    .slice(0, 5);

  const topArtists: TopArtistStat[] = Array.from(artistStats.entries())
    .map(([artist, stat]) => ({
      artist,
      qualifiedPlays: stat.qualifiedPlays,
      listenedMs: stat.listenedMs,
      sharePct:
        totalListenedMs > 0 ? Math.max(1, Math.round((stat.listenedMs / totalListenedMs) * 100)) : 0,
    }))
    .sort((a, b) =>
      b.listenedMs !== a.listenedMs
        ? b.listenedMs - a.listenedMs
        : b.qualifiedPlays - a.qualifiedPlays,
    )
    .slice(0, 5);

  const topAlbums: TopAlbumStat[] = Array.from(albumStats.values())
    .sort((a, b) =>
      b.qualifiedPlays !== a.qualifiedPlays
        ? b.qualifiedPlays - a.qualifiedPlays
        : b.listenedMs - a.listenedMs,
    )
    .slice(0, 4);

  const deletedGroup: DeletedTracksStatGroup = {
    uniqueTrackCount: deletedTrackIds.size,
    qualifiedPlays: deletedQualifiedPlays,
    listenedMs: deletedListenedMs,
  };

  // Compute elapsed days in the selected window up to today so daily average is realistic
  const todayKey = formatLocalDateKey(new Date(query.nowMs ?? Date.now()));
  const effectiveEndKey = endDateKey > todayKey ? todayKey : endDateKey;
  const elapsedDays =
    effectiveEndKey < startDateKey
      ? Math.max(1, window.dayKeys.length)
      : Math.max(
          1,
          Math.floor(
            (parseLocalDateKey(effectiveEndKey).getTime() -
              parseLocalDateKey(startDateKey).getTime()) /
              86_400_000,
          ) + 1,
        );

  return {
    range: query.range,
    periodLabel: window.periodLabel,
    startDateKey,
    endDateKey,
    canStepForward: window.canStepForward,
    totalListenedMs,
    qualifiedPlays,
    uniqueTracksPlayed: uniqueTrackIds.size,
    averageDailyMs: totalListenedMs > 0 ? Math.round(totalListenedMs / elapsedDays) : 0,
    dayCountInPeriod: elapsedDays,
    byDay,
    byHour,
    topTracks,
    topArtists,
    topAlbums,
    deletedGroup,
    hasAnyData: totalListenedMs > 0,
  };
}
