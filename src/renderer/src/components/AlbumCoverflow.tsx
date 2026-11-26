import { useEffect } from 'react';
import { ChevronLeft, ChevronRight, Play, Shuffle } from 'lucide-react';
import type { PrototypeAlbum } from '../data/prototype-catalog';
import { uiStore, useUiState } from '../stores/ui-store';
import { getNonRepeatingEditorialSlots } from '../utils/vietnamese-search';

interface AlbumCoverflowProps {
  albums?: PrototypeAlbum[];
}

export function AlbumCoverflow({ albums = [] }: AlbumCoverflowProps) {
  const ui = useUiState();
  const userAccent = uiStore.getUserAccentPalette();
  const safeIndex = albums.length > 0 ? ui.selectedAlbumCoverflowIndex % albums.length : 0;
  const activeAlbum = albums[safeIndex] ?? null;
  const slots = getNonRepeatingEditorialSlots(albums.length, safeIndex, 5);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (albums.length <= 1) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        uiStore.selectAlbumCoverflowIndex(safeIndex - 1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        uiStore.selectAlbumCoverflowIndex(safeIndex + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [albums.length, safeIndex]);

  if (albums.length === 0 || !activeAlbum) {
    return (
      <div className="lp-glass-panel rounded-3xl p-10 text-center text-[14px] text-[var(--text-secondary)]">
        Chưa có album nào trong thư viện.
      </div>
    );
  }

  const isLight = ui.preferences.themeMode === 'light';

  return (
    <section
      aria-label="3D Album Coverflow"
      data-testid="album-3d-coverflow"
      className="space-y-6"
    >
      {/* 3D Perspective Stage */}
      <div
        className="relative flex h-[320px] w-full items-center justify-center overflow-hidden rounded-[28px]"
        style={{ perspective: '1200px' }}
      >
        {slots.map(({ itemIndex, offset }) => {
          const album = albums[itemIndex];
          if (!album) return null;
          const isCenter = offset === 0;
          const abs = Math.abs(offset);
          const translateX = offset === 0 ? 0 : offset * 176 + (offset > 0 ? 22 : -22);
          const translateZ = isCenter ? 40 : -abs * 95;
          const rotateY = offset === 0 ? 0 : offset > 0 ? -34 : 34;
          const scale = isCenter ? 1 : abs === 1 ? 0.84 : 0.7;

          return (
            <button
              key={album.id}
              type="button"
              onClick={() => {
                if (isCenter) {
                  uiStore.openAlbumDetail(album.id);
                } else {
                  uiStore.selectAlbumCoverflowIndex(itemIndex);
                }
              }}
              aria-label={isCenter ? `Mở album ${album.title}` : `Chọn album ${album.title}`}
              style={{
                width: 248,
                height: 248,
                zIndex: 30 - abs * 10,
                opacity: isCenter ? 1 : abs === 1 ? 0.85 : 0.55,
                transform: `translate3d(${translateX}px, 0, ${translateZ}px) rotateY(${rotateY}deg) scale(${scale})`,
                boxShadow: isCenter
                  ? isLight
                    ? `0 24px 52px rgba(18, 22, 34, 0.25), 0 0 0 1px rgba(${album.palette.glowRgb}, 0.35)`
                    : `0 28px 60px rgba(0, 0, 0, 0.72), 0 0 36px rgba(${album.palette.glowRgb}, 0.28)`
                  : '0 16px 32px rgba(0, 0, 0, 0.38)',
              }}
              className="group absolute aspect-square overflow-hidden rounded-2xl border border-white/15 transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
            >
              <img
                src={album.coverUrl}
                alt={album.title}
                draggable={false}
                className="h-full w-full object-cover"
              />
              {!isCenter && (
                <div className="pointer-events-none absolute inset-0 bg-black/22 transition group-hover:bg-black/5" />
              )}
            </button>
          );
        })}

        {albums.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => uiStore.selectAlbumCoverflowIndex(safeIndex - 1)}
              aria-label="Album trước"
              className="lp-glass-pill absolute left-4 top-1/2 z-40 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-[var(--text-primary)] transition hover:scale-105"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => uiStore.selectAlbumCoverflowIndex(safeIndex + 1)}
              aria-label="Album tiếp theo"
              className="lp-glass-pill absolute right-4 top-1/2 z-40 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-[var(--text-primary)] transition hover:scale-105"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </>
        )}
      </div>

      {/* Focused Album Metadata + Primary Actions */}
      <div className="flex flex-col items-center text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
          {activeAlbum.year} · {activeAlbum.formatLabel}
        </p>
        <h3 className="mt-1 font-display text-2xl font-bold tracking-tight text-[var(--text-primary)]">
          {activeAlbum.title}
        </h3>
        <button
          type="button"
          onClick={() => uiStore.openArtistDetail(activeAlbum.artist)}
          className="mt-0.5 text-[14px] text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] hover:underline"
        >
          {activeAlbum.artist} · {uiStore.getAlbumTrackCount(activeAlbum.id)} bài hát
        </button>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
          <button
            type="button"
            onClick={() => uiStore.playAlbum(activeAlbum.id, false)}
            style={{
              backgroundColor: userAccent.activeHex,
              color: userAccent.onAccentText,
            }}
            className="inline-flex items-center gap-2 rounded-full px-5 py-2 text-[13px] font-semibold shadow-md transition hover:brightness-110"
          >
            <Play className="h-4 w-4 fill-current" />
            Phát Album
          </button>
          <button
            type="button"
            onClick={() => uiStore.playAlbum(activeAlbum.id, true)}
            className="lp-btn-ghost inline-flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium"
          >
            <Shuffle className="h-4 w-4" />
            Trộn bài
          </button>
          <button
            type="button"
            onClick={() => uiStore.openAlbumDetail(activeAlbum.id)}
            className="lp-btn-ghost inline-flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium"
          >
            Mở chi tiết
          </button>
        </div>
      </div>
    </section>
  );
}
