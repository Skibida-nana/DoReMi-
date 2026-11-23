import type Database from 'better-sqlite3';
import type {
  ListeningSessionInput,
  StatisticsDashboardData,
  StatisticsQuery,
  StoredListeningSession,
} from '../../shared/types/stage5';
import {
  aggregateListeningStatistics,
  isQualifiedPlay,
  splitListeningIntoLocalBuckets,
  type TrackLookupMetadata,
} from '../../shared/utils/statistics-engine';
import type { TrackRepository } from '../database/track-repository';
import type { ArtworkService } from './artwork-service';

interface SessionRow {
  id: string;
  track_id: string;
  track_title_snapshot: string;
  artist_snapshot: string | null;
  album_snapshot: string | null;
  duration_ms: number | null;
  started_at_ms: number;
  ended_at_ms: number;
  listened_ms: number;
  qualified_play: number;
  active_intervals_json: string | null;
  updated_at: string;
}

export class StatisticsService {
  private readonly db: Database.Database;
  private readonly trackRepo: TrackRepository;
  private readonly artworkService?: ArtworkService;

  constructor(options: {
    db: Database.Database;
    trackRepo: TrackRepository;
    artworkService?: ArtworkService;
  }) {
    this.db = options.db;
    this.trackRepo = options.trackRepo;
    this.artworkService = options.artworkService;
  }

  /**
   * Idempotently records or updates a listening session by `sessionId`.
   * Re-running checkpoints for the same session NEVER double-counts listening time
   * or qualified plays, and cross-midnight intervals are split accurately per local date/hour.
   */
  recordListeningSession(input: ListeningSessionInput): { qualifiedPlay: boolean } {
    if (!input.sessionId || !input.trackId) {
      throw new Error('sessionId và trackId là bắt buộc để ghi lịch sử nghe.');
    }

    const safeListenedMs = Math.max(0, Math.round(input.listenedMs));
    const safeStartedAt = Math.round(input.startedAtMs);
    const safeEndedAt = Math.max(safeStartedAt, Math.round(input.endedAtMs));
    const qualified = isQualifiedPlay(safeListenedMs, input.durationMs);
    const nowIso = new Date().toISOString();

    const buckets = splitListeningIntoLocalBuckets({
      startedAtMs: safeStartedAt,
      endedAtMs: safeEndedAt,
      listenedMs: safeListenedMs,
      activeIntervals: input.activeIntervals,
    });

    const writeTx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO listening_sessions (
            id, track_id, track_title_snapshot, artist_snapshot, album_snapshot,
            duration_ms, started_at_ms, ended_at_ms, listened_ms, qualified_play,
            active_intervals_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            ended_at_ms = excluded.ended_at_ms,
            listened_ms = excluded.listened_ms,
            qualified_play = excluded.qualified_play,
            active_intervals_json = excluded.active_intervals_json,
            updated_at = excluded.updated_at`,
        )
        .run(
          input.sessionId,
          input.trackId,
          input.trackTitle || 'Bài hát chưa đặt tên',
          input.artist,
          input.album,
          input.durationMs,
          safeStartedAt,
          safeEndedAt,
          safeListenedMs,
          qualified ? 1 : 0,
          input.activeIntervals ? JSON.stringify(input.activeIntervals) : null,
          nowIso,
        );

      this.db
        .prepare('DELETE FROM listening_daily_buckets WHERE session_id = ?')
        .run(input.sessionId);

      const insertBucket = this.db.prepare(
        `INSERT INTO listening_daily_buckets (session_id, local_date, local_hour, listened_ms)
         VALUES (?, ?, ?, ?)`,
      );
      for (const b of buckets) {
        insertBucket.run(input.sessionId, b.localDate, b.localHour, b.listenedMs);
      }
    });

    writeTx();
    return { qualifiedPlay: qualified };
  }

  /**
   * Computes full Statistics Dashboard directly from SQLite `listening_sessions`,
   * preserving deleted track history ("Bài đã xóa") and resolving live metadata & artwork.
   */
  getDashboard(query: StatisticsQuery): StatisticsDashboardData {
    const rows = this.db
      .prepare(
        `SELECT id, track_id, track_title_snapshot, artist_snapshot, album_snapshot,
                duration_ms, started_at_ms, ended_at_ms, listened_ms, qualified_play,
                active_intervals_json, updated_at
         FROM listening_sessions
         ORDER BY started_at_ms ASC`,
      )
      .all() as SessionRow[];

    const sessions: StoredListeningSession[] = rows.map((row) => {
      let activeIntervals: Array<{ startMs: number; endMs: number }> | undefined;
      if (row.active_intervals_json) {
        try {
          activeIntervals = JSON.parse(row.active_intervals_json);
        } catch {
          activeIntervals = undefined;
        }
      }
      return {
        sessionId: row.id,
        trackId: row.track_id,
        trackTitle: row.track_title_snapshot,
        artist: row.artist_snapshot,
        album: row.album_snapshot,
        durationMs: row.duration_ms,
        startedAtMs: row.started_at_ms,
        endedAtMs: row.ended_at_ms,
        listenedMs: row.listened_ms,
        qualifiedPlay: row.qualified_play === 1,
        activeIntervals,
        updatedAt: row.updated_at,
      };
    });

    // Build fast lookup map of current tracks (with metadata overrides & artwork URLs)
    const liveTracks = this.trackRepo.findAll();
    const enrichedTracks = this.artworkService
      ? this.artworkService.enrichTracks(liveTracks)
      : liveTracks;

    const liveTrackMap = new Map<string, TrackLookupMetadata>();
    for (const track of enrichedTracks) {
      liveTrackMap.set(track.id, {
        title: track.title,
        artist: track.artist,
        album: track.album,
        artworkUrl: track.artwork_thumb_url ?? track.artwork_url ?? null,
        isDeleted: false,
      });
    }

    return aggregateListeningStatistics(sessions, query, (trackId) => {
      const found = liveTrackMap.get(trackId);
      if (found) {
        return found;
      }
      return {
        title:
          sessions.find((s) => s.trackId === trackId)?.trackTitle ?? 'Bài hát không còn tồn tại',
        artist: sessions.find((s) => s.trackId === trackId)?.artist ?? null,
        album: sessions.find((s) => s.trackId === trackId)?.album ?? null,
        artworkUrl: null,
        isDeleted: true,
      };
    });
  }
}
