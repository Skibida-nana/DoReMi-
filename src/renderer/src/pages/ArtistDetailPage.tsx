import { ArrowLeft, Play, Shuffle } from 'lucide-react';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import { PROTOTYPE_ALBUMS } from '../data/prototype-catalog';
import { useLibraryState } from '../stores/library-store';
import { uiStore, useUiState } from '../stores/ui-store';
import { formatDurationSeconds } from '../utils/formatters';

export function ArtistDetailPage() {
  const ui = useUiState();
  const library = useLibraryState();
  const accent = uiStore.getUserAccentPalette();
  const isLight = ui.preferences.themeMode === 'light';

  const artistName = ui.selectedArtistName;
  const allTracks = uiStore.getUnifiedTracks();
  const artistTracks = allTracks.filter((t) => t.artist === artistName);
  const artistAlbums = PROTOTYPE_ALBUMS.filter((a) => a.artist === artistName);
  const heroCover =
    artistTracks[0]?.coverUrl ?? artistAlbums[0]?.coverUrl ?? DEFAULT_DOREMI_ARTWORK_URL;
  const heroGlowRgb = artistAlbums[0]?.palette.glowRgb ?? accent.glowRgb;

  const uniqueAlbumCount = new Set(artistTracks.map((t) => t.albumTitle)).size;

  const playTrack = (trackId: string, source: 'local' | 'sample') => {
    if (source === 'local') {
      const real = library.tracks.find((t) => t.id === trackId);
      if (real) {
        void uiStore.playLocalElectronTrack(real);
        return;
      }
    }
    uiStore.playSampleTrack(trackId);
  };

  const playAll = (shuffle: boolean) => {
    const playable = artistTracks.filter((t) => t.status === 'available');
    if (playable.length === 0) {
      return;
    }
    const ordered = shuffle ? [...playable].sort(() => Math.random() - 0.5) : playable;
    playTrack(ordered[0].id, ordered[0].source);
  };

  return (
    <div data-testid="artist-detail-page" className="mx-auto w-full max-w-[1360px] space-y-8 pb-36">
      <button
        type="button"
        onClick={() => uiStore.openLibraryTab('artists')}
        className="flex items-center gap-2 text-[13px] font-medium text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
      >
        <ArrowLeft className="h-4 w-4" />
        Quay lại danh sách Nghệ sĩ
      </button>

      {/* Artist Hero — Strictly Local Library Facts Only (ZERO fake followers/monthly listeners) */}
      <section
        className="lp-glass-panel flex flex-col items-start gap-7 rounded-[28px] p-8 md:flex-row md:items-center"
        style={{
          background: isLight
            ? `linear-gradient(135deg, rgba(${heroGlowRgb}, 0.16) 0%, rgba(255, 255, 255, 0.88) 62%, rgba(246, 247, 251, 0.96) 100%)`
            : `linear-gradient(135deg, rgba(${heroGlowRgb}, 0.22) 0%, rgba(20, 22, 28, 0.9) 62%, rgba(10, 11, 14, 0.96) 100%)`,
        }}
      >
        <div className="h-44 w-44 shrink-0 overflow-hidden rounded-full border-2 border-[var(--border-glass)] shadow-2xl">
          <img
            src={heroCover}
            alt={artistName}
            onError={(e) => {
              const img = e.currentTarget;
              if (img.dataset.fallbackApplied !== '1') {
                img.dataset.fallbackApplied = '1';
                img.src = DEFAULT_DOREMI_ARTWORK_URL;
              }
            }}
            className="h-full w-full object-cover"
          />
        </div>

        <div className="space-y-3">
          <span className="text-[11px] font-semibold tracking-[0.16em] text-[var(--text-muted)] uppercase">
            Nghệ sĩ trong thư viện cục bộ
          </span>
          <h1 className="font-display text-[36px] font-bold tracking-[-0.025em] text-[var(--text-primary)]">
            {artistName}
          </h1>
          <p className="text-[14px] text-[var(--text-secondary)]">
            {uniqueAlbumCount} album · {artistTracks.length} bản thu cục bộ
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => playAll(false)}
              className="flex h-11 items-center gap-2 rounded-full bg-[var(--text-primary)] px-6 text-[13.5px] font-semibold text-[var(--bg-deep)] transition hover:opacity-90"
            >
              <Play className="h-4 w-4 fill-current" />
              Phát tất cả
            </button>
            <button
              type="button"
              onClick={() => playAll(true)}
              className="lp-btn-ghost flex h-11 items-center gap-2 rounded-full px-5 text-[13px] font-medium text-[var(--text-primary)]"
            >
              <Shuffle className="h-4 w-4" />
              Phát ngẫu nhiên
            </button>
          </div>
        </div>
      </section>

      {/* Local Tracks by this Artist */}
      <section className="space-y-3.5">
        <h2 className="font-display text-[19px] font-semibold text-[var(--text-primary)]">
          Bài hát trong thư viện cục bộ
        </h2>
        <div className="lp-glass-panel divide-y divide-[var(--border-subtle)] overflow-hidden rounded-[22px]">
          {artistTracks.map((track, idx) => (
            <button
              key={track.id}
              type="button"
              onClick={() => playTrack(track.id, track.source)}
              className="flex h-[62px] w-full items-center gap-4 px-5 text-left transition hover:bg-[var(--surface-glass-light)]"
            >
              <span className="font-mono-tabular w-5 text-center text-[12px] text-[var(--text-muted)]">
                {idx + 1}
              </span>
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
                <p className="truncate text-[12px] text-[var(--text-muted)]">{track.albumTitle}</p>
              </div>
              <span className="hidden rounded-full border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-2.5 py-0.5 text-[11px] text-[var(--text-secondary)] sm:inline-block">
                {track.formatBadge}
              </span>
              <span className="font-mono-tabular text-[12px] text-[var(--text-muted)]">
                {formatDurationSeconds(track.durationSec)}
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* Artist Albums */}
      {artistAlbums.length > 0 && (
        <section className="space-y-3.5">
          <h2 className="font-display text-[19px] font-semibold text-[var(--text-primary)]">
            Album
          </h2>
          <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
            {artistAlbums.map((album) => (
              <button
                key={album.id}
                type="button"
                onClick={() => uiStore.openAlbumDetail(album.id)}
                className="lp-glass-panel rounded-[22px] p-4 text-left transition hover:-translate-y-0.5"
              >
                <img
                  src={album.coverUrl}
                  alt={album.title}
                  className="aspect-square w-full rounded-[14px] border border-[var(--border-subtle)] object-cover"
                />
                <p className="mt-3 truncate text-[14.5px] font-semibold text-[var(--text-primary)]">
                  {album.title}
                </p>
                <p className="text-[12px] text-[var(--text-muted)]">
                  {album.year} · {album.formatLabel}
                </p>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
