import { useMemo, useRef } from 'react';
import { Disc3, Play, Search, X } from 'lucide-react';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import { libraryStore, useLibraryState } from '../stores/library-store';
import { uiStore, useUiState } from '../stores/ui-store';
import { formatDurationSeconds } from '../utils/formatters';
import { useWindowedListSlice } from '../utils/use-windowed-slice';
import {
  matchesNormalizedVietnameseQuery,
  normalizeVietnameseText,
} from '../utils/vietnamese-search';

const QUICK_SUGGESTIONS = ['flac', '24-bit', 'alac', 'wav'];

export function SearchPage() {
  const ui = useUiState();
  const library = useLibraryState();
  const query = ui.searchQuery;
  const accent = uiStore.getUserAccentPalette();
  const songsContainerRef = useRef<HTMLDivElement | null>(null);

  const allTracks = useMemo(() => uiStore.getUnifiedTracks(), [library.tracks]);
  const allAlbums = useMemo(() => uiStore.getDerivedAlbums(), [library.tracks]);

  const results = useMemo(() => {
    const normalizedQuery = normalizeVietnameseText(query);
    if (!normalizedQuery) {
      return { songs: [], albums: [], artists: [], playlists: [] };
    }

    const songs = allTracks.filter(
      (t) =>
        matchesNormalizedVietnameseQuery(t.title, normalizedQuery) ||
        matchesNormalizedVietnameseQuery(t.artist, normalizedQuery) ||
        matchesNormalizedVietnameseQuery(t.albumTitle, normalizedQuery) ||
        matchesNormalizedVietnameseQuery(t.formatBadge, normalizedQuery),
    );

    const albums = allAlbums.filter(
      (a) =>
        matchesNormalizedVietnameseQuery(a.title, normalizedQuery) ||
        matchesNormalizedVietnameseQuery(a.artist, normalizedQuery) ||
        matchesNormalizedVietnameseQuery(a.genre, normalizedQuery),
    );

    const artistNames = Array.from(
      new Set([
        ...allTracks.map((t) => t.artist),
        ...allAlbums.map((a) => a.artist),
      ]),
    ).filter((name) => matchesNormalizedVietnameseQuery(name, normalizedQuery));

    const playlists = ui.playlists.filter(
      (p) =>
        matchesNormalizedVietnameseQuery(p.name, normalizedQuery) ||
        matchesNormalizedVietnameseQuery(p.description, normalizedQuery),
    );

    return { songs, albums, artists: artistNames, playlists };
  }, [query, allTracks, allAlbums, ui.playlists]);

  const songSlice = useWindowedListSlice({
    containerRef: songsContainerRef,
    totalItems: results.songs.length,
    itemHeightPx: 62,
  });
  const visibleSongs = useMemo(
    () => results.songs.slice(songSlice.startIndex, songSlice.endIndex),
    [results.songs, songSlice.startIndex, songSlice.endIndex],
  );

  const hasQuery = query.trim().length > 0;
  const totalCount =
    results.songs.length +
    results.albums.length +
    results.artists.length +
    results.playlists.length;

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-8 pb-36">
      <div>
        <p className="text-[11px] font-semibold tracking-[0.16em] text-[var(--text-muted)] uppercase">
          Tìm kiếm đa ngôn ngữ & tiếng Việt không dấu
        </p>
        <h1 className="font-display mt-1 text-[30px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
          Tìm kiếm trong thư viện
        </h1>
      </div>

      {/* Prominent Frosted Search Field */}
      <div className="lp-glass-panel relative flex items-center rounded-full px-5 py-3.5">
        <Search className="h-5 w-5 shrink-0 text-[var(--text-muted)]" />
        <input
          type="text"
          value={query}
          onChange={(e) => uiStore.setSearchQuery(e.target.value)}
          placeholder='Tìm bài hát, album, nghệ sĩ, CJK hoặc tiếng Việt không dấu (vd: "den vau")...'
          autoFocus
          className="ml-3.5 flex-1 bg-transparent text-[15px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
        />
        {hasQuery && (
          <button
            type="button"
            onClick={() => uiStore.setSearchQuery('')}
            aria-label="Xóa từ khóa"
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Quick search chips */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-[var(--text-muted)]">Thử tìm nhanh:</span>
        {QUICK_SUGGESTIONS.map((chip) => (
          <button
            key={chip}
            type="button"
            onClick={() => uiStore.setSearchQuery(chip)}
            className="lp-btn-ghost rounded-full px-3.5 py-1 text-[12px]"
          >
            {chip}
          </button>
        ))}
      </div>

      {!hasQuery ? (
        <div className="lp-glass-panel flex flex-col items-center justify-center rounded-[26px] py-20 text-center">
          <Search className="h-10 w-10 text-[var(--text-muted)]/55" />
          <p className="mt-4 text-[16px] font-medium text-[var(--text-primary)]">
            Tìm kiếm hoàn toàn offline — hỗ trợ tiếng Việt không dấu & Unicode CJK
          </p>
          <p className="mt-1.5 max-w-[460px] text-[13px] text-[var(--text-muted)]">
            Hỗ trợ tìm tên bài hát, nghệ sĩ, album, định dạng FLAC / ALAC / WAV và chữ tiếng Việt có dấu hoặc không dấu.
          </p>
        </div>
      ) : totalCount === 0 ? (
        <div className="lp-glass-panel flex flex-col items-center justify-center rounded-[26px] py-20 text-center">
          <Disc3 className="h-10 w-10 text-[var(--text-muted)]/55" />
          <p className="mt-4 text-[16px] font-medium text-[var(--text-primary)]">
            Không có kết quả cho &ldquo;{query}&rdquo;
          </p>
          <p className="mt-1 text-[13px] text-[var(--text-muted)]">
            Kiểm tra lại chính tả hoặc thử tìm theo tên album, nghệ sĩ hoặc định dạng FLAC/WAV.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {/* Grouped Results: Songs */}
          {results.songs.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-display text-[17px] font-semibold text-[var(--text-primary)]">
                Bài hát ({results.songs.length})
              </h2>
              <div
                ref={songsContainerRef}
                className="lp-glass-panel divide-y divide-[var(--border-subtle)] overflow-hidden rounded-[22px]"
              >
                {songSlice.topSpacerPx > 0 && (
                  <div aria-hidden="true" style={{ height: `${songSlice.topSpacerPx}px` }} />
                )}
                {visibleSongs.map((track) => (
                  <button
                    key={track.id}
                    type="button"
                    onClick={() => {
                      const searchContext = {
                        contextId: `search-${query.trim()}`,
                        label: `Kết quả: ${query.trim()}`,
                        kind: 'search' as const,
                        trackIds: results.songs
                          .filter((s) => s.status === 'available')
                          .map((s) => s.id),
                      };
                      if (track.source === 'local') {
                        const real = libraryStore.getTrackById(track.id);
                        if (real) {
                          void uiStore.playLocalElectronTrack(real, searchContext);
                          return;
                        }
                      }
                      uiStore.playSampleTrack(track.id, false, searchContext);
                    }}
                    className="flex h-[62px] w-full items-center gap-4 px-5 text-left transition hover:bg-[var(--surface-glass-light)]"
                  >
                    <img
                      src={track.coverUrl}
                      alt={track.albumTitle}
                      onError={(e) => {
                        const img = e.currentTarget;
                        if (img.dataset.fallbackApplied !== '1') {
                          img.dataset.fallbackApplied = '1';
                          img.src = DEFAULT_DOREMI_ARTWORK_URL;
                        }
                      }}
                      className="h-10 w-10 rounded-lg border border-[var(--border-subtle)] object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium text-[var(--text-primary)]">
                        {track.title}
                      </p>
                      <p className="truncate text-[12px] text-[var(--text-muted)]">
                        {track.artist} · {track.albumTitle}
                      </p>
                    </div>
                    <span className="hidden rounded-full border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-2.5 py-0.5 text-[11px] text-[var(--text-secondary)] md:inline-block">
                      {track.formatBadge}
                    </span>
                    <span className="font-mono-tabular text-[12px] text-[var(--text-muted)]">
                      {formatDurationSeconds(track.durationSec)}
                    </span>
                  </button>
                ))}
                {songSlice.bottomSpacerPx > 0 && (
                  <div aria-hidden="true" style={{ height: `${songSlice.bottomSpacerPx}px` }} />
                )}
              </div>
            </section>
          )}

          {/* Grouped Results: Albums */}
          {results.albums.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-display text-[17px] font-semibold text-[var(--text-primary)]">
                Album ({results.albums.length})
              </h2>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                {results.albums.map((album) => (
                  <button
                    key={album.id}
                    type="button"
                    onClick={() => uiStore.openAlbumDetail(album.id)}
                    className="lp-glass-panel rounded-[20px] p-3.5 text-left transition hover:-translate-y-0.5"
                  >
                    <img
                      src={album.coverUrl}
                      alt={album.title}
                      className="aspect-square w-full rounded-[14px] border border-[var(--border-subtle)] object-cover"
                    />
                    <p className="mt-2.5 truncate text-[14px] font-semibold text-[var(--text-primary)]">
                      {album.title}
                    </p>
                    <p className="truncate text-[12px] text-[var(--text-muted)]">{album.artist}</p>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Grouped Results: Artists */}
          {results.artists.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-display text-[17px] font-semibold text-[var(--text-primary)]">
                Nghệ sĩ ({results.artists.length})
              </h2>
              <div className="flex flex-wrap gap-3">
                {results.artists.map((artistName) => {
                  const album = allAlbums.find((a) => a.artist === artistName);
                  return (
                    <button
                      key={artistName}
                      type="button"
                      onClick={() => uiStore.openArtistDetail(artistName)}
                      className="lp-glass-subtle flex items-center gap-3 rounded-full py-2 pr-5 pl-2.5 transition hover:bg-[var(--surface-hover)]"
                    >
                      {album && (
                        <img
                          src={album.coverUrl}
                          alt={artistName}
                          className="h-9 w-9 rounded-full object-cover"
                        />
                      )}
                      <span className="text-[13.5px] font-medium text-[var(--text-primary)]">
                        {artistName}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* Grouped Results: Playlists */}
          {results.playlists.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-display text-[17px] font-semibold text-[var(--text-primary)]">
                Playlist ({results.playlists.length})
              </h2>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {results.playlists.map((pl) => (
                  <div
                    key={pl.id}
                    onClick={() => uiStore.openPlaylistDetail(pl.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        uiStore.openPlaylistDetail(pl.id);
                      }
                    }}
                    className="lp-glass-panel flex cursor-pointer items-center justify-between gap-4 rounded-[20px] p-4 text-left transition hover:-translate-y-0.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[14.5px] font-semibold text-[var(--text-primary)]">
                        {pl.name}
                      </p>
                      <p className="truncate text-[12px] text-[var(--text-muted)]">
                        {pl.description}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        uiStore.playPlaylist(pl.id);
                      }}
                      aria-label={`Phát ${pl.name}`}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                      style={{
                        backgroundColor: accent.activeHex,
                        color: accent.onAccentText,
                      }}
                    >
                      <Play className="ml-0.5 h-4 w-4 fill-current" />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
