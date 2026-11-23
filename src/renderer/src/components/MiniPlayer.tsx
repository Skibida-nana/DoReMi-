import { useEffect, useState, type CSSProperties } from 'react';
import {
  Heart,
  ListMusic,
  Maximize2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import { useLibraryState } from '../stores/library-store';
import { usePlaybackState } from '../stores/player-store';
import { uiStore, useUiState } from '../stores/ui-store';
import { formatDurationSeconds } from '../utils/formatters';
import { getVolumeSliderVisualState } from '../utils/volume-slider';

export function MiniPlayer() {
  const ui = useUiState();
  const playback = usePlaybackState();
  const library = useLibraryState();
  const [isVolumeHovered, setIsVolumeHovered] = useState(false);
  const [isVolumeDragging, setIsVolumeDragging] = useState(false);
  const [isVolumeFocused, setIsVolumeFocused] = useState(false);

  useEffect(() => {
    if (!isVolumeDragging) {
      return;
    }
    const handlePointerEnd = () => setIsVolumeDragging(false);
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    return () => {
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [isVolumeDragging]);

  // Never show duplicate players while Now Playing fullscreen is active
  if (ui.route === 'now-playing') {
    return null;
  }

  // M5.5 §5.5: Mini Player accent & volume fill strictly follow user's chosen Theme Accent
  const userAccent = uiStore.getUserAccentPalette();
  const isLight = ui.preferences.themeMode === 'light';
  const isLocal = ui.activeSource === 'local' && Boolean(playback.currentTrackId);
  const localTrack = isLocal
    ? library.tracks.find((t) => t.id === playback.currentTrackId) ?? playback.currentTrack ?? null
    : null;
  const sampleTrack = uiStore.getActiveSampleTrack();

  const activeTrackId = localTrack ? localTrack.id : sampleTrack.id;
  const title = localTrack ? localTrack.title : sampleTrack.title;
  const artist = localTrack ? localTrack.artist ?? 'Chưa rõ nghệ sĩ' : sampleTrack.artist;
  const coverUrl = uiStore.getCoverForTrack(activeTrackId, 'thumb');
  const formatSummary = localTrack
    ? `${(localTrack.container ?? localTrack.codec ?? 'AUDIO').toUpperCase()}${
        localTrack.bit_depth ? ` · ${localTrack.bit_depth}-bit` : ''
      }`
    : `${sampleTrack.container} · ${sampleTrack.bitDepth ?? 16}-bit`;

  const isPlaying = isLocal ? playback.status === 'playing' : ui.sampleIsPlaying;
  const currentTime = isLocal ? playback.currentTimeSeconds : ui.sampleCurrentTimeSec;
  const duration = isLocal
    ? playback.durationSeconds || (localTrack?.duration_ms ? localTrack.duration_ms / 1000 : 0)
    : sampleTrack.durationSec;
  const rawVolume = isLocal ? playback.volume : ui.sampleVolume;
  const rawMuted = isLocal ? playback.muted : ui.sampleMuted;
  const volumeVisual = getVolumeSliderVisualState(rawVolume, rawMuted);
  const showVolumeTooltip = isVolumeHovered || isVolumeDragging || isVolumeFocused;
  const isFavorite = ui.favoriteIds.includes(activeTrackId);
  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center pt-8 pb-5 pl-[76px] pr-6"
      style={{
        background: isLight
          ? 'linear-gradient(0deg, rgba(236,238,245,0.92) 0%, rgba(236,238,245,0.32) 60%, rgba(236,238,245,0) 100%)'
          : 'linear-gradient(0deg, rgba(9,10,13,0.90) 0%, rgba(9,10,13,0.35) 60%, rgba(9,10,13,0) 100%)',
      }}
    >
      <div
        role="region"
        aria-label="Trình phát thu gọn"
        className="lp-glass-pill pointer-events-auto relative flex h-[82px] w-full max-w-[920px] items-center justify-between gap-4 rounded-full px-6"
      >
        {/* Left: Transport Controls */}
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => uiStore.toggleShuffle()}
            title="Phát ngẫu nhiên"
            aria-label="Phát ngẫu nhiên"
            className={`flex h-9 w-9 items-center justify-center rounded-full transition ${
              ui.shuffle
                ? 'bg-[var(--surface-hover)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
            }`}
            style={ui.shuffle ? { color: userAccent.activeHex } : undefined}
          >
            <Shuffle className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => uiStore.previousTrack()}
            title="Bài trước"
            aria-label="Bài trước"
            className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <SkipBack className="h-[18px] w-[18px]" />
          </button>

          <button
            type="button"
            onClick={() => uiStore.togglePlayPause()}
            title={isPlaying ? 'Tạm dừng' : 'Phát nhạc'}
            aria-label={isPlaying ? 'Tạm dừng' : 'Phát nhạc'}
            style={
              isLight
                ? {
                    backgroundColor: userAccent.activeHex,
                    color: userAccent.onAccentText,
                    boxShadow: `0 8px 22px rgba(${userAccent.glowRgb}, 0.34)`,
                  }
                : undefined
            }
            className={`flex h-11 w-11 items-center justify-center rounded-full transition hover:scale-105 active:scale-95 ${
              isLight
                ? ''
                : 'bg-[#F5F6F8] text-[#090A0D] shadow-[0_6px_22px_rgba(255,255,255,0.22)]'
            }`}
          >
            {isPlaying ? (
              <Pause className="h-[18px] w-[18px] fill-current" />
            ) : (
              <Play className="ml-0.5 h-[18px] w-[18px] fill-current" />
            )}
          </button>

          <button
            type="button"
            onClick={() => uiStore.nextTrack()}
            title="Bài tiếp theo"
            aria-label="Bài tiếp theo"
            className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <SkipForward className="h-[18px] w-[18px]" />
          </button>

          <button
            type="button"
            onClick={() => uiStore.cycleRepeat()}
            title={`Lặp lại: ${ui.repeat === 'off' ? 'Tắt' : ui.repeat === 'all' ? 'Tất cả' : 'Một bài'}`}
            aria-label="Chế độ lặp lại"
            className={`flex h-9 w-9 items-center justify-center rounded-full transition ${
              ui.repeat !== 'off'
                ? 'bg-[var(--surface-hover)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
            }`}
            style={ui.repeat !== 'off' ? { color: userAccent.activeHex } : undefined}
          >
            {ui.repeat === 'one' ? (
              <Repeat1 className="h-4 w-4" />
            ) : (
              <Repeat className="h-4 w-4" />
            )}
          </button>
        </div>

        {/* Center: Artwork + Title/Artist + Thin Interactive Progress */}
        <div className="flex min-w-0 flex-1 items-center gap-3.5 px-2">
          <button
            type="button"
            onClick={() => uiStore.openNowPlaying()}
            title="Mở màn hình Đang phát"
            className="group relative h-11 w-11 shrink-0 overflow-hidden rounded-xl border border-[var(--border-glass)] shadow-md"
          >
            <img
              src={coverUrl}
              alt={title}
              data-testid="mini-player-artwork"
              onError={(e) => {
                const img = e.currentTarget;
                if (img.dataset.fallbackApplied !== '1') {
                  img.dataset.fallbackApplied = '1';
                  img.src = DEFAULT_DOREMI_ARTWORK_URL;
                }
              }}
              className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
            />
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <button
                type="button"
                onClick={() => uiStore.openNowPlaying()}
                data-testid="mini-player-title"
                className="truncate text-left text-[13.5px] font-semibold text-[var(--text-primary)] hover:underline"
              >
                {title}
              </button>
              <span className="font-mono-tabular shrink-0 text-[11px] text-[var(--text-muted)]">
                {formatDurationSeconds(currentTime)} / {formatDurationSeconds(duration)}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => uiStore.openArtistDetail(artist)}
                data-testid="mini-player-artist"
                className="truncate text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                {artist}
              </button>
              <span className="hidden shrink-0 text-[10px] font-medium tracking-[0.04em] text-[var(--text-muted)] xl:inline">
                {formatSummary}
              </span>
            </div>

            {/* Thin progress bar */}
            <div className="relative mt-1.5 flex items-center">
              <div className="pointer-events-none h-[3px] w-full overflow-hidden rounded-full bg-[var(--slider-track)]">
                <div
                  className="h-full rounded-full transition-[width] duration-200"
                  style={{
                    width: `${progressPct}%`,
                    backgroundColor: userAccent.activeHex,
                  }}
                />
              </div>
              <input
                type="range"
                min={0}
                max={Math.max(1, duration)}
                step={0.5}
                value={Math.min(currentTime, Math.max(1, duration))}
                onChange={(e) => uiStore.seek(Number(e.target.value))}
                aria-label="Tua tiến độ phát nhạc"
                className="absolute inset-0 h-3 w-full cursor-pointer opacity-0"
              />
            </div>
          </div>
        </div>

        {/* Right: Favorite, Queue, Expand, Volume */}
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => uiStore.toggleFavorite(activeTrackId)}
            title={isFavorite ? 'Bỏ yêu thích' : 'Yêu thích'}
            aria-label={isFavorite ? 'Bỏ yêu thích' : 'Yêu thích'}
            className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <Heart
              className="h-4 w-4 transition"
              style={
                isFavorite
                  ? { color: userAccent.activeHex, fill: userAccent.activeHex }
                  : undefined
              }
            />
          </button>

          <button
            type="button"
            onClick={() => uiStore.toggleQueue()}
            title="Hàng đợi"
            aria-label="Mở hàng đợi"
            className={`flex h-9 w-9 items-center justify-center rounded-full transition ${
              ui.isQueueOpen
                ? 'bg-[var(--surface-hover)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
            }`}
          >
            <ListMusic className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => uiStore.openNowPlaying()}
            title="Mở rộng toàn màn hình Đang phát"
            aria-label="Mở rộng Đang phát"
            className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <Maximize2 className="h-4 w-4" />
          </button>

          <div className="ml-1 hidden items-center gap-2 border-l border-[var(--border-subtle)] pl-3 lg:flex">
            <button
              type="button"
              onClick={() => uiStore.toggleMute()}
              title={volumeVisual.isMuted ? 'Bật âm thanh' : 'Tắt tiếng'}
              aria-label={volumeVisual.isMuted ? 'Bật âm thanh' : 'Tắt tiếng'}
              aria-pressed={volumeVisual.isMuted}
              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            >
              {volumeVisual.isMuted ? (
                <VolumeX className="h-4 w-4 text-[var(--text-muted)]" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>

            <div
              className="relative flex h-6 w-[76px] items-center"
              onMouseEnter={() => setIsVolumeHovered(true)}
              onMouseLeave={() => setIsVolumeHovered(false)}
            >
              {/* Floating volume percentage tooltip */}
              {showVolumeTooltip && (
                <div
                  role="tooltip"
                  data-testid="mini-volume-tooltip"
                  className="font-mono-tabular pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded-md border border-[var(--border-glass)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10.5px] font-medium whitespace-nowrap text-[var(--text-primary)] shadow-lg"
                  style={{ left: volumeVisual.thumbCenterLeftCss }}
                >
                  {volumeVisual.tooltipLabel}
                </div>
              )}

              {/* Contrast-safe unfilled rail + Theme Accent filled track */}
              <div
                data-testid="mini-volume-track"
                className="pointer-events-none h-[5px] w-full overflow-hidden rounded-full bg-[var(--volume-track-empty)] ring-1 ring-black/10"
              >
                <div
                  data-testid="mini-volume-fill"
                  className="h-full rounded-full"
                  style={{
                    width: volumeVisual.fillWidthCss,
                    background: `linear-gradient(90deg, ${userAccent.activeHex}, ${userAccent.hex})`,
                    boxShadow:
                      volumeVisual.percent > 0
                        ? `0 0 8px rgba(${userAccent.glowRgb}, 0.45)`
                        : 'none',
                  }}
                />
              </div>

              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volumeVisual.effectiveVolume}
                onChange={(e) => uiStore.setVolume(Number(e.target.value))}
                onPointerDown={() => setIsVolumeDragging(true)}
                onFocus={() => setIsVolumeFocused(true)}
                onBlur={() => setIsVolumeFocused(false)}
                title={`Âm lượng: ${volumeVisual.tooltipLabel}`}
                aria-label="Âm lượng"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={volumeVisual.percent}
                aria-valuetext={volumeVisual.tooltipLabel}
                style={{ '--volume-accent-rgb': userAccent.glowRgb } as CSSProperties}
                className="lp-volume-range absolute inset-0 h-full w-full"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
