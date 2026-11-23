import { ArrowLeft, Heart, ListPlus, Play, Shuffle } from 'lucide-react';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import { PROTOTYPE_TRACKS, getAlbumById } from '../data/prototype-catalog';
import { uiStore, useUiState } from '../stores/ui-store';
import { formatDurationSeconds } from '../utils/formatters';

export function AlbumDetailPage() {
  const ui = useUiState();
  const isLight = ui.preferences.themeMode === 'light';
  const album = getAlbumById(ui.selectedAlbumId);
  const tracks = PROTOTYPE_TRACKS.filter((t) => t.albumId === album.id).map((t) =>
    uiStore.applySampleTrackOverrides(t),
  );
  const totalSec = tracks.reduce((sum, t) => sum + t.durationSec, 0);
  const isFav = ui.favoriteIds.includes(album.id);

  return (
    <div data-testid="album-detail-page" className="mx-auto w-full max-w-[1360px] space-y-7 pb-36">
      <button
        type="button"
        onClick={() => uiStore.openLibraryTab('albums')}
        className="flex items-center gap-2 text-[13px] font-medium text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
      >
        <ArrowLeft className="h-4 w-4" />
        Quay lại danh sách Album
      </button>

      {/* Top Hero with album-colored gradient and Square 1:1 Artwork */}
      <section
        className="lp-glass-panel relative overflow-hidden rounded-[28px] p-7 md:p-8"
        style={{
          background: isLight
            ? `linear-gradient(135deg, rgba(${album.palette.glowRgb}, 0.16) 0%, rgba(255, 255, 255, 0.90) 56%, rgba(246, 247, 251, 0.96) 100%)`
            : `linear-gradient(135deg, rgba(${album.palette.glowRgb}, 0.24) 0%, rgba(22, 25, 32, 0.85) 55%, rgba(12, 14, 18, 0.96) 100%)`,
        }}
      >
        <div className="flex flex-col items-start gap-7 md:flex-row md:items-end">
          {/* Square 224×224 Album Artwork (Unstretched) */}
          <div className="h-[224px] w-[224px] shrink-0 overflow-hidden rounded-[22px] border border-[var(--border-glass)] shadow-[0_24px_54px_rgba(0,0,0,0.45)]">
            <img
              src={album.coverUrl}
              alt={album.title}
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

          <div className="min-w-0 flex-1 space-y-3">
            <span
              className="inline-block rounded-full border px-3 py-0.5 text-[11px] font-medium"
              style={{
                backgroundColor: isLight
                  ? `rgba(${album.palette.glowRgb}, 0.14)`
                  : album.palette.badgeBg,
                borderColor: album.palette.borderGlow,
                color: 'var(--text-primary)',
              }}
            >
              ALBUM · {album.formatLabel}
            </span>

            <h1 className="font-display text-[36px] font-bold leading-tight tracking-[-0.025em] text-[var(--text-primary)]">
              {album.title}
            </h1>

            <p className="text-[14px] text-[var(--text-secondary)]">
              <button
                type="button"
                onClick={() => uiStore.openArtistDetail(album.artist)}
                className="font-semibold text-[var(--text-primary)] hover:underline"
              >
                {album.artist}
              </button>
              <span className="mx-2 opacity-40">·</span>
              <span>{album.year}</span>
              <span className="mx-2 opacity-40">·</span>
              <span>{tracks.length} bài hát</span>
              <span className="mx-2 opacity-40">·</span>
              <span className="font-mono-tabular">{formatDurationSeconds(totalSec)}</span>
            </p>

            <p className="max-w-[640px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
              {album.description}
            </p>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => uiStore.playAlbum(album.id, false)}
                className="flex h-11 items-center gap-2 rounded-full bg-[var(--text-primary)] px-6 text-[13.5px] font-semibold text-[var(--bg-deep)] shadow-lg transition hover:scale-[1.02]"
              >
                <Play className="h-4 w-4 fill-current" />
                Phát Album
              </button>

              <button
                type="button"
                onClick={() => uiStore.playAlbum(album.id, true)}
                className="lp-btn-ghost flex h-11 items-center gap-2 rounded-full px-5 text-[13px] font-medium text-[var(--text-primary)]"
              >
                <Shuffle className="h-4 w-4" />
                Phát ngẫu nhiên
              </button>

              <button
                type="button"
                onClick={() => uiStore.toggleFavorite(album.id)}
                className="lp-btn-ghost flex h-11 w-11 items-center justify-center rounded-full text-[var(--text-primary)]"
                aria-label="Yêu thích album"
              >
                <Heart
                  className="h-4 w-4"
                  style={
                    isFav
                      ? { color: album.palette.dominant, fill: album.palette.dominant }
                      : undefined
                  }
                />
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Album Tracklist */}
      <section className="lp-glass-panel overflow-hidden rounded-[24px]">
        <div className="divide-y divide-[var(--border-subtle)]">
          {tracks.map((track) => {
            const isCurrent = ui.activeSampleTrackId === track.id;
            return (
              <div
                key={track.id}
                onClick={() => uiStore.playSampleTrack(track.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    uiStore.playSampleTrack(track.id);
                  }
                }}
                className={`group flex h-[64px] cursor-pointer items-center gap-4 px-6 transition ${
                  isCurrent ? 'bg-[var(--surface-hover)]' : 'hover:bg-[var(--surface-glass-light)]'
                }`}
              >
                <span className="font-mono-tabular w-6 text-center text-[13px] text-[var(--text-muted)]">
                  {track.trackNumber}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-[14.5px] font-medium"
                    style={{ color: isCurrent ? album.palette.dominant : 'var(--text-primary)' }}
                  >
                    {track.title}
                  </p>
                  <p className="truncate text-[12px] text-[var(--text-muted)]">
                    {track.formatBadge}
                    {track.lyrics && track.lyrics.length > 0 ? ' · Có lời đồng bộ' : ' · Không lời'}
                  </p>
                </div>
                <span className="font-mono-tabular text-[12.5px] text-[var(--text-muted)]">
                  {formatDurationSeconds(track.durationSec)}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    uiStore.playNextInQueue(track.id);
                  }}
                  title="Phát tiếp theo"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] opacity-70 transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] group-hover:opacity-100"
                >
                  <ListPlus className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
