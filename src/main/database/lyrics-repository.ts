import type Database from 'better-sqlite3';

export interface TrackLyricsRow {
  track_id: string;
  custom_format: 'lrc' | 'txt' | null;
  custom_content: string | null;
  embedded_content: string | null;
  updated_at: string;
}

export class LyricsRepository {
  private readonly stmtFindByTrackId: Database.Statement;
  private readonly stmtSetEmbedded: Database.Statement;
  private readonly stmtSetCustom: Database.Statement;
  private readonly stmtClearCustom: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtFindByTrackId = db.prepare(`
      SELECT
        track_id,
        custom_format,
        custom_content,
        embedded_content,
        updated_at
      FROM track_lyrics
      WHERE track_id = ?
    `);

    this.stmtSetEmbedded = db.prepare(`
      INSERT INTO track_lyrics (
        track_id,
        embedded_content,
        updated_at
      ) VALUES (
        @track_id,
        @embedded_content,
        @updated_at
      )
      ON CONFLICT(track_id) DO UPDATE SET
        embedded_content = excluded.embedded_content,
        updated_at = excluded.updated_at
    `);

    this.stmtSetCustom = db.prepare(`
      INSERT INTO track_lyrics (
        track_id,
        custom_format,
        custom_content,
        updated_at
      ) VALUES (
        @track_id,
        @custom_format,
        @custom_content,
        @updated_at
      )
      ON CONFLICT(track_id) DO UPDATE SET
        custom_format = excluded.custom_format,
        custom_content = excluded.custom_content,
        updated_at = excluded.updated_at
    `);

    this.stmtClearCustom = db.prepare(`
      UPDATE track_lyrics
      SET
        custom_format = NULL,
        custom_content = NULL,
        updated_at = ?
      WHERE track_id = ?
    `);
  }

  findByTrackId(trackId: string): TrackLyricsRow | null {
    const row = this.stmtFindByTrackId.get(trackId) as TrackLyricsRow | undefined;
    return row ?? null;
  }

  setEmbeddedLyrics(trackId: string, embeddedContent: string | null): void {
    this.stmtSetEmbedded.run({
      track_id: trackId,
      embedded_content: embeddedContent,
      updated_at: new Date().toISOString(),
    });
  }

  setCustomLyrics(trackId: string, format: 'lrc' | 'txt', content: string): void {
    this.stmtSetCustom.run({
      track_id: trackId,
      custom_format: format,
      custom_content: content,
      updated_at: new Date().toISOString(),
    });
  }

  clearCustomLyrics(trackId: string): boolean {
    const res = this.stmtClearCustom.run(new Date().toISOString(), trackId);
    return res.changes > 0;
  }
}
