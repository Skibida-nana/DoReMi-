import { useEffect } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Disc3,
  Heart,
  Info,
  Play,
  Shuffle,
} from 'lucide-react';
import { uiStore, useUiState } from '../stores/ui-store';
import { getCircularGallerySlots } from '../utils/vietnamese-search';

interface SlotGeometry {
  leftPct: number;
  topPx: number;
  widthPct: number;
  heightPx: number;
  rotateDeg: number;
  opacity: number;
  zIndex: number;
  scale: number;
}

/**
 * Exact 7-card staggered editorial gallery geometry anchored to the 1290×490 reference stage.
 * Outer slots (-3 and +3) intentionally extend past left/right edges so they are partially cropped.
 */
const GALLERY_SLOTS: SlotGeometry[] = [
  // Slot 0: Far Left (partially cropped left)
  { leftPct: -4.2, topPx: 146, widthPct: 14.0, heightPx: 278, rotateDeg: -5, opacity: 0.7, zIndex: 1, scale: 0.96 },
  // Slot 1: Mid Left
  { leftPct: 10.6, topPx: 184, widthPct: 14.4, heightPx: 274, rotateDeg: -2, opacity: 0.85, zIndex: 2, scale: 0.98 },
  // Slot 2: Near Left
  { leftPct: 26.2, topPx: 96, widthPct: 15.0, heightPx: 300, rotateDeg: -1, opacity: 0.95, zIndex: 3, scale: 0.99 },
  // Slot 3: Center Focus (Highest prominence)
  { leftPct: 41.7, topPx: 24, widthPct: 16.6, heightPx: 342, rotateDeg: 0, opacity: 1.0, zIndex: 5, scale: 1.0 },
  // Slot 4: Near Right
  { leftPct: 58.8, topPx: 98, widthPct: 15.0, heightPx: 300, rotateDeg: 1, opacity: 0.95, zIndex: 3, scale: 0.99 },
  // Slot 5: Mid Right
  { leftPct: 74.8, topPx: 184, widthPct: 14.4, heightPx: 274, rotateDeg: 2, opacity: 0.85, zIndex: 2, scale: 0.98 },
  // Slot 6: Far Right (partially cropped right)
  { leftPct: 90.0, topPx: 144, widthPct: 14.0, heightPx: 278, rotateDeg: 5, opacity: 0.7, zIndex: 1, scale: 0.96 },
];

export function EditorialAlbumGallery() {
  const ui = useUiState();
  const albums = uiStore.getDerivedAlbums();
  const selectedAlbum = uiStore.getSelectedGalleryAlbum() ?? albums[0] ?? null;
  const palette = uiStore.getCurrentPalette();
  const slotAlbumIndices = getCircularGallerySlots(
    albums.length,
    ui.selectedGalleryIndex,
  );
  const selectedTrackCount = selectedAlbum ? uiStore.getAlbumTrackCount(selectedAlbum.id) : 0;
  const isSelectedFavorite = selectedAlbum ? ui.favoriteIds.includes(selectedAlbum.id) : false;

  if (albums.length === 0 || !selectedAlbum) {
    return null;
  }

  // Keyboard navigation (ArrowLeft / ArrowRight) on Home screen
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        uiStore.stepGallery(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        uiStore.stepGallery(1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Build reverse lookup: for each album index (0..6), which visual slot (0..6) is it currently in?
  const slotByAlbumIndex = new Map<number, number>();
  slotAlbumIndices.forEach((albumIdx, slotIdx) => {
    slotByAlbumIndex.set(albumIdx, slotIdx);
  });

  return (
    <section aria-label="Bộ sưu tập Album nổi bật" className="relative">
      {/* Spatial Editorial Stage (edge-cropped container) */}
      <div className="relative mx-auto h-[468px] w-full overflow-hidden rounded-[28px] border border-white/[0.08] bg-[#0B0C10]/60">
        {/* Dynamic Central Radial Ambient Glow behind Center Focus Card */}
        {ui.appearance.backgroundEffects && (
          <div
            aria-hidden="true"
            className="lp-ambient-layer pointer-events-none absolute inset-0"
            style={{
              background: `
                radial-gradient(ellipse 46% 58% at 50% 42%, rgba(${palette.glowRgb}, 0.34) 0%, rgba(${palette.secondaryGlowRgb}, 0.14) 44%, rgba(9, 10, 13, 0) 76%),
                radial-gradient(ellipse 75% 42% at 50% 98%, rgba(${palette.glowRgb}, 0.14) 0%, rgba(9, 10, 13, 0) 70%)
              `,
            }}
          />
        )}

        {/* Giant Editorial Decorative Typography Behind Cards */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0 flex flex-col items-center justify-between px-6 py-7 select-none"
        >
          <span
            className="font-display whitespace-nowrap text-center text-[78px] font-bold leading-[1.06] tracking-[-0.03em] uppercase transition-colors duration-700 lg:text-[106px] xl:text-[118px]"
            style={{
              backgroundImage: `linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(${palette.glowRgb}, 0.16) 100%)`,
              WebkitBackgroundClip: 'text',
              color: 'transparent',
            }}
          >
            YOUR MUSIC
          </span>
          <span
            className="font-display whitespace-nowrap text-center text-[78px] font-bold leading-[1.06] tracking-[-0.03em] uppercase transition-colors duration-700 lg:text-[106px] xl:text-[118px]"
            style={{
              backgroundImage: `linear-gradient(180deg, rgba(${palette.glowRgb}, 0.15) 0%, rgba(255,255,255,0.08) 100%)`,
              WebkitBackgroundClip: 'text',
              color: 'transparent',
            }}
          >
            YOUR WORLD
          </span>
        </div>

        {/* Subtle Left / Right Spatial Navigation Chevrons */}
        <button
          type="button"
          onClick={() => uiStore.stepGallery(-1)}
          aria-label="Album trước"
          className="lp-glass-subtle absolute top-1/2 left-4 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-[#F5F6F8]/80 transition hover:scale-105 hover:bg-white/15 hover:text-white"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>

        <button
          type="button"
          onClick={() => uiStore.stepGallery(1)}
          aria-label="Album tiếp theo"
          className="lp-glass-subtle absolute top-1/2 right-4 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-[#F5F6F8]/80 transition hover:scale-105 hover:bg-white/15 hover:text-white"
        >
          <ChevronRight className="h-5 w-5" />
        </button>

        {/* 7 Staggered Portrait Album Cards (stable DOM keys by album.id for smooth 450ms reposition) */}
        <div className="relative z-10 h-full w-full">
          {albums.map((album, albumIdx) => {
            const slotIdx = slotByAlbumIndex.get(albumIdx) ?? 3;
            const slot = GALLERY_SLOTS[slotIdx];
            const isCenter = slotIdx === 3;
            const trackCount = uiStore.getAlbumTrackCount(album.id);
            const isFav = ui.favoriteIds.includes(album.id);

            return (
              <div
                key={album.id}
                role="button"
                tabIndex={0}
                aria-label={`Album ${album.title} — ${album.artist}${isCenter ? ' (Đang chọn)' : ''}`}
                aria-pressed={isCenter}
                data-album-id={album.id}
                data-slot={slotIdx}
                onClick={() => {
                  if (isCenter) {
                    uiStore.openAlbumDetail(album.id);
                  } else {
                    uiStore.selectGalleryIndex(albumIdx);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (isCenter) {
                      uiStore.openAlbumDetail(album.id);
                    } else {
                      uiStore.selectGalleryIndex(albumIdx);
                    }
                  }
                }}
                className="group absolute cursor-pointer overflow-hidden rounded-[22px] text-left outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                style={{
                  left: `${slot.leftPct}%`,
                  top: `${slot.topPx}px`,
                  width: `${slot.widthPct}%`,
                  height: `${slot.heightPx}px`,
                  opacity: slot.opacity,
                  zIndex: slot.zIndex,
                  transform: `rotate(${slot.rotateDeg}deg) scale(${slot.scale})`,
                  transition:
                    'left 450ms cubic-bezier(0.16, 1, 0.3, 1), top 450ms cubic-bezier(0.16, 1, 0.3, 1), width 450ms cubic-bezier(0.16, 1, 0.3, 1), height 450ms cubic-bezier(0.16, 1, 0.3, 1), transform 450ms cubic-bezier(0.16, 1, 0.3, 1), opacity 400ms ease, box-shadow 500ms ease',
                  border: isCenter
                    ? `1.5px solid ${album.palette.borderGlow}`
                    : '1px solid rgba(255, 255, 255, 0.14)',
                  boxShadow: isCenter
                    ? `0 28px 65px rgba(0, 0, 0, 0.72), 0 0 42px rgba(${album.palette.glowRgb}, 0.28)`
                    : '0 20px 42px rgba(0, 0, 0, 0.52)',
                }}
              >
                {/* Portrait Card Background: Blurred Artwork Extension + Album Gradient (Never Stretches Cover) */}
                <div className="absolute inset-0 bg-[#12141A]">
                  <img
                    src={album.coverUrl}
                    alt=""
                    aria-hidden="true"
                    className="h-full w-full scale-150 object-cover opacity-55 blur-2xl"
                  />
                  <div
                    className="absolute inset-0"
                    style={{
                      background: `linear-gradient(180deg, rgba(16,17,20,0.22) 0%, rgba(${album.palette.secondaryGlowRgb}, 0.45) 58%, rgba(9,10,13,0.94) 100%)`,
                    }}
                  />
                </div>

                {/* Inner Composition: Top Controls + Unstretched 1:1 Square Artwork + Bottom Glass Info */}
                <div className="relative z-10 flex h-full flex-col justify-between p-2.5">
                  {/* Top Row: Track Count Pill + Favorite Icon */}
                  <div className="flex items-center justify-between gap-1">
                    <span className="rounded-full border border-white/15 bg-black/45 px-2.5 py-0.5 text-[10px] font-medium tracking-[0.03em] text-[#F5F6F8]/90 backdrop-blur-md">
                      {trackCount} bài
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        uiStore.toggleFavorite(album.id);
                      }}
                      aria-label={isFav ? `Bỏ yêu thích ${album.title}` : `Yêu thích ${album.title}`}
                      className="flex h-7 w-7 items-center justify-center rounded-full border border-white/15 bg-black/45 text-[#F5F6F8]/85 backdrop-blur-md transition hover:scale-105 hover:bg-black/65"
                    >
                      <Heart
                        className="h-3.5 w-3.5"
                        style={
                          isFav
                            ? { color: album.palette.dominant, fill: album.palette.dominant }
                            : undefined
                        }
                      />
                    </button>
                  </div>

                  {/* Intact 1:1 Square Album Cover Frame (NEVER stretched) */}
                  <div className="relative mx-auto my-1.5 aspect-square w-full overflow-hidden rounded-[14px] border border-white/15 shadow-[0_12px_28px_rgba(0,0,0,0.45)]">
                    <img
                      src={album.coverUrl}
                      alt={album.title}
                      className="h-full w-full scale-[1.08] object-cover transition duration-500 group-hover:scale-[1.12]"
                    />
                    {isCenter && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          uiStore.playAlbum(album.id);
                        }}
                        aria-label={`Phát album ${album.title}`}
                        className="absolute right-2.5 bottom-2.5 flex h-10 w-10 items-center justify-center rounded-full bg-[#F5F6F8] text-[#090A0D] shadow-[0_10px_24px_rgba(0,0,0,0.5)] transition hover:scale-105 active:scale-95"
                      >
                        <Play className="ml-0.5 h-4 w-4 fill-current" />
                      </button>
                    )}
                  </div>

                  {/* Bottom Info Glass Bar */}
                  <div className="rounded-[14px] border border-white/12 bg-black/45 px-3 py-2 backdrop-blur-md">
                    <p className="truncate text-[13px] font-semibold tracking-[-0.01em] text-[#F5F6F8]">
                      {album.title}
                    </p>
                    <p className="truncate text-[11px] text-[#B9BEC8]">{album.artist}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Subtle bottom-center album selector indicator dots */}
        <div className="absolute bottom-3.5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5">
          {albums.map((album, idx) => {
            const active = idx === ui.selectedGalleryIndex;
            return (
              <button
                key={album.id}
                type="button"
                onClick={() => uiStore.selectGalleryIndex(idx)}
                aria-label={`Chọn album ${album.title}`}
                className="h-1.5 rounded-full transition-all duration-300"
                style={{
                  width: active ? '22px' : '6px',
                  backgroundColor: active ? palette.dominant : 'rgba(255,255,255,0.24)',
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Selected Album Information Glass Strip (Directly Below Gallery) */}
      <div className="lp-glass-panel mt-5 flex flex-wrap items-center justify-between gap-4 rounded-[24px] px-6 py-4">
        <div className="flex min-w-0 items-center gap-4">
          <div className="h-[58px] w-[58px] shrink-0 overflow-hidden rounded-[14px] border border-white/15 shadow-lg">
            <img
              src={selectedAlbum.coverUrl}
              alt={selectedAlbum.title}
              className="h-full w-full object-cover"
            />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-display truncate text-[22px] font-semibold tracking-[-0.02em] text-[#F5F6F8]">
                {selectedAlbum.title}
              </h1>
              <span
                className="rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-[0.04em]"
                style={{
                  backgroundColor: palette.badgeBg,
                  borderColor: palette.borderGlow,
                  color: '#F5F6F8',
                }}
              >
                {selectedAlbum.formatLabel}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[13px] text-[#B9BEC8]">
              <button
                type="button"
                onClick={() => uiStore.openArtistDetail(selectedAlbum.artist)}
                className="font-medium text-[#F5F6F8]/90 hover:underline"
              >
                {selectedAlbum.artist}
              </button>
              <span className="mx-2 text-white/25">·</span>
              <span>{selectedAlbum.year}</span>
              <span className="mx-2 text-white/25">·</span>
              <span>{selectedTrackCount} bài hát</span>
              <span className="mx-2 text-white/25">·</span>
              <span className="text-[#858B97]">{selectedAlbum.genre}</span>
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => uiStore.playAlbum(selectedAlbum.id, false)}
            className="flex h-10 items-center gap-2 rounded-full bg-[#F5F6F8] px-5 text-[13px] font-semibold text-[#090A0D] shadow-[0_8px_24px_rgba(255,255,255,0.18)] transition hover:scale-[1.02] active:scale-[0.98]"
          >
            <Play className="h-4 w-4 fill-current" />
            Phát Album
          </button>

          <button
            type="button"
            onClick={() => uiStore.playAlbum(selectedAlbum.id, true)}
            className="flex h-10 items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-4 text-[13px] font-medium text-[#F5F6F8] transition hover:border-white/25 hover:bg-white/[0.11]"
          >
            <Shuffle className="h-3.5 w-3.5" />
            Ngẫu nhiên
          </button>

          <button
            type="button"
            onClick={() => uiStore.openAlbumDetail(selectedAlbum.id)}
            className="flex h-10 items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-4 text-[13px] font-medium text-[#B9BEC8] transition hover:border-white/25 hover:bg-white/[0.11] hover:text-[#F5F6F8]"
          >
            <Info className="h-3.5 w-3.5" />
            Chi tiết
          </button>

          <button
            type="button"
            onClick={() => uiStore.openNowPlaying()}
            title="Mở đĩa than đang phát"
            className="flex h-10 items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-4 text-[13px] font-medium text-[#B9BEC8] transition hover:border-white/25 hover:bg-white/[0.11] hover:text-[#F5F6F8]"
          >
            <Disc3 className="h-4 w-4" style={{ color: palette.dominant }} />
            Đĩa than
          </button>

          <button
            type="button"
            onClick={() => uiStore.toggleFavorite(selectedAlbum.id)}
            aria-label={isSelectedFavorite ? 'Bỏ yêu thích album' : 'Yêu thích album'}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/[0.06] text-[#B9BEC8] transition hover:border-white/25 hover:bg-white/[0.11] hover:text-[#F5F6F8]"
          >
            <Heart
              className="h-4 w-4"
              style={
                isSelectedFavorite
                  ? { color: palette.dominant, fill: palette.dominant }
                  : undefined
              }
            />
          </button>
        </div>
      </div>
    </section>
  );
}
