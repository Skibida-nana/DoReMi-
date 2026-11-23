import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Disc3, Play, Plus } from 'lucide-react';
import type { PrototypePlaylist } from '../data/prototype-catalog';
import { uiStore, useUiState } from '../stores/ui-store';
import {
  buildStableEditorialRenderList,
  computeGalleryDirection,
  formatEditorialCardTransform,
  getEditorialCardGeometry,
  type GalleryNavigationDirection,
} from '../utils/gallery-motion';
import { HomeEditorialTypography } from './HomeEditorialTypography';

interface EditorialPlaylistGalleryProps {
  onRequestCreatePlaylist: () => void;
}

const PlaylistPortraitArtwork = memo(function PlaylistPortraitArtwork({
  playlist,
  accentHex,
  secondaryHex,
}: {
  playlist: PrototypePlaylist;
  accentHex: string;
  secondaryHex: string;
}) {
  const { primaryCover, collageCovers } = uiStore.getPlaylistCovers(playlist);

  if (collageCovers.length === 4 && !playlist.coverUrl) {
    return (
      <div className="grid h-full w-full grid-cols-2 grid-rows-2 gap-[1px] bg-black/35">
        {collageCovers.map((url, idx) => (
          <img
            key={`${playlist.id}-c-${idx}`}
            src={url}
            alt=""
            decoding="async"
            draggable={false}
            className="h-full w-full object-cover"
          />
        ))}
      </div>
    );
  }

  if (primaryCover) {
    return (
      <img
        src={primaryCover}
        alt={playlist.name}
        decoding="async"
        draggable={false}
        className="h-full w-full object-cover object-center transition-transform duration-700 group-hover:scale-[1.04]"
      />
    );
  }

  return (
    <div
      style={{
        background: `linear-gradient(145deg, ${accentHex} 0%, ${secondaryHex} 55%, #12141E 100%)`,
      }}
      className="flex h-full w-full flex-col items-center justify-center p-6 text-center text-white/90"
    >
      <Disc3 className="h-14 w-14 opacity-60" />
      <p className="mt-4 line-clamp-2 font-display text-lg font-semibold">{playlist.name}</p>
    </div>
  );
});

/**
 * M5.3 Immersive Home & Editorial Playlist Gallery
 * - Art-first near-fullscreen showcase with giant Editorial Background Typography behind cards
 * - Staggered portrait playlist cards (1 center hero + up to 6 flanking cards)
 * - Unified bi-directional GPU animation (`transform` + `opacity`) with STRICTLY STABLE DOM ORDER
 *   (sorted by itemIndex, keyed by playlist.id) so Next, Previous, Click Left/Right, Wrap-around,
 *   and rapid clicks all interpolate symmetrically with ZERO DOM insertBefore detaches and ZERO reflows.
 */
export function EditorialPlaylistGallery({
  onRequestCreatePlaylist,
}: EditorialPlaylistGalleryProps) {
  const ui = useUiState();
  const playlists = ui.playlists;
  const userAccent = uiStore.getUserAccentPalette();
  const [viewportWidth, setViewportWidth] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1440,
  );

  const cardNodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevOffsetByIdRef = useRef<Map<string, number>>(new Map());
  const prevSelectedIndexRef = useRef<number>(ui.selectedGalleryIndex);
  const activeDirectionRef = useRef<GalleryNavigationDirection>(0);
  const pendingRafIdsRef = useRef<number[]>([]);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Keyboard Left/Right/Enter navigation (strictly ignored when typing inside input/textarea/select)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
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
      if (playlists.length === 0) {
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        uiStore.stepGallery(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        uiStore.stepGallery(1);
      } else if (event.key === 'Enter') {
        const active = playlists[ui.selectedGalleryIndex];
        if (active) {
          event.preventDefault();
          uiStore.openPlaylistDetail(active.id);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [playlists, ui.selectedGalleryIndex]);

  const compact = viewportWidth < 1260;
  const maxVisibleSlots = viewportWidth < 1080 ? 5 : 7;
  const isLight = ui.preferences.themeMode === 'light';
  const reducedMotion = ui.preferences.reducedMotion;
  const qualityPreset = ui.preferences.uiQualityPreset ?? 'balanced';
  const isPowerSaver = qualityPreset === 'power-saver';
  const hasCustomBackground =
    ui.preferences.homeBackgroundMode === 'custom' &&
    Boolean(ui.preferences.customBackgroundUrl);

  const navDirection = computeGalleryDirection(
    prevSelectedIndexRef.current,
    ui.selectedGalleryIndex,
    playlists.length,
  );
  if (navDirection !== 0) {
    activeDirectionRef.current = navDirection;
  }

  // Strictly stable DOM-ordered list (NEVER sorted by slotIndex -> 0 DOM insertBefore on Previous!)
  const stableCards = useMemo(
    () =>
      buildStableEditorialRenderList(
        playlists,
        ui.selectedGalleryIndex,
        prevOffsetByIdRef.current,
        maxVisibleSlots,
      ),
    [playlists, ui.selectedGalleryIndex, maxVisibleSlots],
  );

  const cardTransitionCss = reducedMotion
    ? 'transform 120ms ease, opacity 120ms ease'
    : isPowerSaver
      ? 'transform 380ms cubic-bezier(0.22, 1, 0.36, 1), opacity 320ms ease'
      : 'transform 480ms cubic-bezier(0.22, 1, 0.36, 1), opacity 420ms ease';

  // Stage any circularly wrapping outer edge card cleanly from offstage (+/-4) before paint
  useLayoutEffect(() => {
    for (const rafId of pendingRafIdsRef.current) {
      cancelAnimationFrame(rafId);
    }
    pendingRafIdsRef.current = [];

    const stagedEntries: Array<{
      el: HTMLDivElement;
      targetTransform: string;
      targetOpacity: string;
    }> = [];

    for (const entry of stableCards) {
      const el = cardNodeRefs.current.get(entry.item.id);
      if (!el) {
        continue;
      }
      const targetGeo = getEditorialCardGeometry(entry.offset, compact);
      const targetTransform = formatEditorialCardTransform(targetGeo);
      const targetOpacity = String(targetGeo.opacity);

      if (reducedMotion || entry.enterFromOffset === null) {
        // Guarantee any previously interrupted rapid-click edge card resumes normal smooth CSS transition
        if (el.style.transition === 'none' || el.style.transition !== cardTransitionCss) {
          el.style.transition = cardTransitionCss;
        }
        if (el.style.transform !== targetTransform) {
          el.style.transform = targetTransform;
        }
        if (el.style.opacity !== targetOpacity) {
          el.style.opacity = targetOpacity;
        }
        continue;
      }

      const startGeo = getEditorialCardGeometry(entry.enterFromOffset, compact);

      // Snap the single wrapping edge card to offstage wing before browser paint
      el.style.transition = 'none';
      el.style.transform = formatEditorialCardTransform(startGeo);
      el.style.opacity = '0';

      stagedEntries.push({
        el,
        targetTransform,
        targetOpacity,
      });
    }

    if (stagedEntries.length > 0) {
      // Commit offstage start state on the wrapped edge node(s) only
      void stagedEntries[0].el.offsetWidth;
      const rafId = requestAnimationFrame(() => {
        for (const item of stagedEntries) {
          if (!item.el.isConnected) continue;
          item.el.style.transition = cardTransitionCss;
          item.el.style.transform = item.targetTransform;
          item.el.style.opacity = item.targetOpacity;
        }
      });
      pendingRafIdsRef.current.push(rafId);
    }

    const nextMap = new Map<string, number>();
    for (const entry of stableCards) {
      nextMap.set(entry.item.id, entry.offset);
    }
    prevOffsetByIdRef.current = nextMap;
    prevSelectedIndexRef.current = ui.selectedGalleryIndex;

    return () => {
      for (const rafId of pendingRafIdsRef.current) {
        cancelAnimationFrame(rafId);
      }
      pendingRafIdsRef.current = [];
      for (const item of stagedEntries) {
        if (item.el.isConnected && item.el.style.transition === 'none') {
          item.el.style.transition = cardTransitionCss;
        }
      }
    };
  }, [stableCards, compact, reducedMotion, cardTransitionCss, ui.selectedGalleryIndex]);

  const activePlaylist = playlists[ui.selectedGalleryIndex] ?? null;
  const activePalette = uiStore.getPaletteForPlaylist(activePlaylist);

  const handleEditorialFontLoadError = useCallback((fontName: string) => {
    uiStore.showToast(
      `Không thể tải font "${fontName}". Đã tự động dùng font mặc định DoReMi.`,
    );
  }, []);

  // 0 playlists: clean editorial Empty State
  if (playlists.length === 0) {
    return (
      <section
        aria-label="Playlist Gallery"
        data-testid="editorial-gallery-empty"
        className="relative flex min-h-[calc(100vh-196px)] flex-col items-center justify-center overflow-hidden rounded-[32px] px-6 py-12 text-center"
      >
        <HomeEditorialTypography
          settings={ui.preferences.editorialTypography}
          fonts={ui.preferences.editorialFonts}
          themeMode={ui.preferences.themeMode}
          hasCustomBackground={hasCustomBackground}
          onFontLoadError={handleEditorialFontLoadError}
        />

        <div className="lp-glass-panel relative z-20 max-w-md rounded-3xl px-8 py-9">
          <div
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl"
            style={{
              backgroundColor: `rgba(${userAccent.glowRgb}, 0.16)`,
              color: userAccent.activeHex,
            }}
          >
            <Disc3 className="h-7 w-7" />
          </div>
          <h2 className="mt-5 font-display text-2xl font-semibold text-[var(--text-primary)]">
            Tạo bộ sưu tập đầu tiên của bạn
          </h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
            Tổ chức những bản thu lossless yêu thích thành playlist mang dấu ấn riêng để hiển thị tại phòng trưng bày trang chủ.
          </p>
          <button
            type="button"
            onClick={onRequestCreatePlaylist}
            data-testid="empty-create-playlist-btn"
            style={{
              backgroundColor: userAccent.activeHex,
              color: userAccent.onAccentText,
            }}
            className="mt-6 inline-flex items-center gap-2 rounded-full px-6 py-2.5 text-[13.5px] font-semibold shadow-lg transition hover:brightness-110"
          >
            <Plus className="h-4 w-4" />
            Tạo playlist đầu tiên
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Editorial Playlist Gallery"
      data-testid="editorial-playlist-gallery"
      data-gallery-direction={String(activeDirectionRef.current)}
      className="relative flex min-h-[calc(100vh-192px)] flex-col justify-between overflow-hidden rounded-[32px] select-none"
    >
      {/* Layer 3: Dedicated Editorial Background Typography strictly behind Playlist Portrait Cards */}
      <HomeEditorialTypography
        settings={ui.preferences.editorialTypography}
        fonts={ui.preferences.editorialFonts}
        themeMode={ui.preferences.themeMode}
        hasCustomBackground={hasCustomBackground}
        onFontLoadError={handleEditorialFontLoadError}
      />

      {/* Minimal top strip: playlist index & subtle Create button */}
      <div className="relative z-30 flex items-center justify-between px-4 pt-2">
        <div className="flex items-center gap-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--text-muted)]">
            Playlist Gallery
          </span>
          <span className="font-mono-tabular text-[11px] text-[var(--text-muted)]">
            {String(ui.selectedGalleryIndex + 1).padStart(2, '0')} /{' '}
            {String(playlists.length).padStart(2, '0')}
          </span>
        </div>

        <button
          type="button"
          onClick={onRequestCreatePlaylist}
          data-testid="gallery-create-playlist-btn"
          className="lp-btn-ghost inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium"
        >
          <Plus className="h-3.5 w-3.5" />
          Tạo playlist
        </button>
      </div>

      {/* Staggered asymmetric portrait cards stage (GPU-composited transform + opacity only) */}
      <div
        data-testid="editorial-gallery-stage"
        className="relative z-20 mx-auto flex w-full flex-1 items-center justify-center overflow-visible"
        style={{ minHeight: compact ? 375 : 464 }}
      >
        {stableCards.map(({ item: playlist, itemIndex, offset }) => {
          const geo = getEditorialCardGeometry(offset, compact);
          const isCenter = offset === 0;
          const cardPalette = uiStore.getPaletteForPlaylist(playlist);

          const cardShadow = isPowerSaver
            ? isCenter
              ? '0 14px 28px rgba(0, 0, 0, 0.36)'
              : '0 8px 18px rgba(0, 0, 0, 0.24)'
            : isCenter
              ? isLight
                ? `0 26px 56px rgba(18, 22, 34, 0.22), 0 0 0 1px rgba(${cardPalette.glowRgb}, 0.3)`
                : `0 28px 64px rgba(0, 0, 0, 0.68), 0 0 36px rgba(${cardPalette.glowRgb}, 0.22)`
              : isLight
                ? '0 16px 32px rgba(18, 22, 34, 0.13)'
                : '0 18px 36px rgba(0, 0, 0, 0.5)';

          return (
            <div
              key={playlist.id}
              ref={(node) => {
                if (node) {
                  cardNodeRefs.current.set(playlist.id, node);
                } else {
                  cardNodeRefs.current.delete(playlist.id);
                }
              }}
              data-testid={isCenter ? 'gallery-center-card' : `gallery-side-card-${offset}`}
              data-playlist-id={playlist.id}
              data-slot-offset={String(offset)}
              style={{
                width: geo.baseWidth,
                height: geo.baseHeight,
                zIndex: geo.zIndex,
                opacity: geo.opacity,
                transform: formatEditorialCardTransform(geo),
                transition: cardTransitionCss,
                boxShadow: cardShadow,
                willChange: reducedMotion ? 'auto' : 'transform, opacity',
              }}
              onClick={() => {
                if (isCenter) {
                  uiStore.openPlaylistDetail(playlist.id);
                } else {
                  // Clicking a side card brings it to center — NEVER auto-plays
                  uiStore.selectGalleryIndex(itemIndex);
                }
              }}
              role="button"
              tabIndex={isCenter ? 0 : -1}
              aria-label={
                isCenter
                  ? `Mở playlist ${playlist.name} (${playlist.trackIds.length} bài)`
                  : `Chọn playlist ${playlist.name}`
              }
              className={`group absolute cursor-pointer overflow-hidden rounded-[22px] border ${
                isCenter
                  ? 'border-white/28'
                  : 'border-white/12 hover:border-white/24'
              }`}
            >
              <PlaylistPortraitArtwork
                playlist={playlist}
                accentHex={cardPalette.dominant}
                secondaryHex={cardPalette.secondary}
              />

              {/* Lightweight dimming veil on flanking cards (avoids expensive per-frame CSS filter: brightness!) */}
              {!isCenter && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 bg-black transition-opacity duration-300 group-hover:opacity-0"
                  style={{ opacity: Math.max(0, Math.min(0.42, 1 - geo.brightness)) }}
                />
              )}

              {/* Subtle bottom scrim for crisp artwork-first caption */}
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0 h-[44%]"
                style={{
                  background: isCenter
                    ? 'linear-gradient(180deg, rgba(8,10,16,0) 0%, rgba(8,10,16,0.58) 54%, rgba(8,10,16,0.92) 100%)'
                    : 'linear-gradient(180deg, rgba(8,10,16,0) 0%, rgba(8,10,16,0.72) 100%)',
                }}
              />

              {/* Minimal card metadata: Playlist name + subtle track count */}
              <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-4 sm:p-5">
                <div className="min-w-0">
                  <p
                    className={`truncate font-display font-semibold tracking-tight text-white drop-shadow ${
                      isCenter ? 'text-[20px] leading-tight' : 'text-[18px] leading-snug opacity-92'
                    }`}
                  >
                    {playlist.name}
                  </p>
                  <p className="mt-1 text-[12px] text-white/74">
                    {playlist.trackIds.length} bài hát
                  </p>
                </div>

                {isCenter && (
                  <button
                    type="button"
                    aria-label={`Phát playlist ${playlist.name}`}
                    data-testid="gallery-center-play-btn"
                    onClick={(event) => {
                      event.stopPropagation();
                      uiStore.playPlaylist(playlist.id);
                    }}
                    style={{
                      backgroundColor: activePalette.dominant,
                      color: '#FFFFFF',
                      boxShadow: isPowerSaver
                        ? '0 6px 14px rgba(0, 0, 0, 0.35)'
                        : `0 10px 26px rgba(${activePalette.glowRgb}, 0.52)`,
                    }}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition hover:scale-105 active:scale-95"
                  >
                    <Play className="ml-0.5 h-5 w-5 fill-current" />
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {/* Floating left / right controls when 2+ playlists */}
        {playlists.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => uiStore.stepGallery(-1)}
              aria-label="Playlist trước"
              data-testid="gallery-prev-btn"
              className="lp-glass-pill absolute left-3 top-1/2 z-50 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-[var(--text-primary)] transition hover:scale-105"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => uiStore.stepGallery(1)}
              aria-label="Playlist tiếp theo"
              data-testid="gallery-next-btn"
              className="lp-glass-pill absolute right-3 top-1/2 z-50 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-[var(--text-primary)] transition hover:scale-105"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </>
        )}
      </div>

      {/* Minimal bottom caption & indicator dots */}
      {activePlaylist && (
        <div className="relative z-30 flex flex-col items-center gap-3 pb-3 pt-1">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => uiStore.openPlaylistDetail(activePlaylist.id)}
              className="text-[12.5px] font-medium text-[var(--text-secondary)] underline-offset-4 transition hover:text-[var(--text-primary)] hover:underline"
            >
              Mở chi tiết “{activePlaylist.name}”
            </button>
          </div>

          {playlists.length > 1 && (
            <div className="flex items-center gap-1.5" role="tablist" aria-label="Chọn playlist">
              {playlists.map((pl, idx) => {
                const active = idx === ui.selectedGalleryIndex;
                return (
                  <button
                    key={pl.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-label={pl.name}
                    onClick={() => uiStore.selectGalleryIndex(idx)}
                    style={active ? { backgroundColor: userAccent.activeHex } : undefined}
                    className={`h-1.5 rounded-full transition-all duration-300 ${
                      active ? 'w-7' : 'w-1.5 bg-[var(--slider-track)] hover:bg-[var(--text-muted)]'
                    }`}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
