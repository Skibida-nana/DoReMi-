import { memo, useEffect, useState, type CSSProperties } from 'react';
import {
  Disc3,
  Heart,
  ListMusic,
  Maximize2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import { libraryStore, useLibraryState } from '../stores/library-store';
import {
  playerActions,
  usePlaybackCoreState,
  usePlaybackTimeSeconds,
} from '../stores/player-store';
import { uiStore, useUiState } from '../stores/ui-store';
import { formatDurationSeconds } from '../utils/formatters';
import { getVolumeSliderVisualState } from '../utils/volume-slider';
import { PlaybackErrorBanner } from './PlaybackErrorBanner';
import { ShuffleButton } from './PlaybackModeControls';
import { PlaybackOptionsPopover } from './PlaybackOptionsPopover';

const MiniPlayerTimeReadout = memo(function MiniPlayerTimeReadout({
  hasTrack,
  duration,
}: {
  hasTrack: boolean;
  duration: number;
}) {
  const currentTime = usePlaybackTimeSeconds();
  return (
    <span className="font-mono-tabular shrink-0 text-[11px] text-[var(--text-muted)]">
      {formatDurationSeconds(hasTrack ? currentTime : 0)} / {formatDurationSeconds(duration)}
    </span>
  );
});

const MiniPlayerProgressBar = memo(function MiniPlayerProgressBar({
  hasTrack,
  duration,
  accentColor,
}: {
  hasTrack: boolean;
  duration: number;
  accentColor: string;
}) {
  const rawTime = usePlaybackTimeSeconds();
  const currentTime = hasTrack ? rawTime : 0;
  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div className="relative mt-1.5 flex items-center">
      <div className="pointer-events-none h-[3px] w-full overflow-hidden rounded-full bg-[var(--slider-track)]">
        <div
          className="h-full rounded-full transition-[width] duration-200"
          style={{
            width: `${progressPct}%`,
            backgroundColor: accentColor,
          }}
        />
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(1, duration)}
        step={0.5}
        disabled={!hasTrack}
        value={Math.min(currentTime, Math.max(1, duration))}
        onChange={(e) => uiStore.seek(Number(e.target.value))}
        aria-label="Tua tiến độ phát nhạc"
        className="absolute inset-0 h-3 w-full cursor-pointer opacity-0 disabled:cursor-default"
      />
    </div>
  );
});

export function MiniPlayer() {
  const ui = useUiState();
  const playback = usePlaybackCoreState();
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

  const userAccent = uiStore.getUserAccentPalette();
  const isLight = ui.preferences.themeMode === 'light';
  void library.tracks;
  const localTrack = playback.currentTrackId
    ? libraryStore.getTrackById(playback.currentTrackId) ?? playback.currentTrack ?? null
    : null;

  const hasTrack = Boolean(localTrack);
  const activeTrackId = localTrack?.id ?? '';
  const title = localTrack ? localTrack.title : 'Chưa phát bài hát';
  const artist = localTrack ? localTrack.artist ?? 'Chưa rõ nghệ sĩ' : 'Chọn nhạc từ Thư viện';
  const coverUrl = localTrack
    ? uiStore.getCoverForTrack(localTrack.id, 'thumb')
    : DEFAULT_DOREMI_ARTWORK_URL;
  const formatSummary = localTrack
    ? `${(localTrack.container ?? localTrack.codec ?? 'AUDIO').toUpperCase()}${
        localTrack.bit_depth ? ` · ${localTrack.bit_depth}-bit` : ''
      }`
    : 'Sẵn sàng phát lossless';

  const isPlaying = Boolean(localTrack && playback.status === 'playing');
  const playbackError =
    localTrack && playback.status === 'error' ? playback.errorMessage : null;
  const duration = localTrack
    ? playback.durationSeconds || (localTrack.duration_ms ? localTrack.duration_ms / 1000 : 0)
    : 0;
  const rawVolume = playback.volume;
  const rawMuted = playback.muted;
  const volumeVisual = getVolumeSliderVisualState(rawVolume, rawMuted);
  const showVolumeTooltip = isVolumeHovered || isVolumeDragging || isVolumeFocused;
  const isFavorite = Boolean(activeTrackId && uiStore.isFavoriteTrack(activeTrackId));

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex flex-col items-center justify-end gap-2 pt-8 pb-5 pl-[76px] pr-6"
      style={{
        background: isLight
          ? 'linear-gradient(0deg, rgba(236,238,245,0.92) 0%, rgba(236,238,245,0.32) 60%, rgba(236,238,245,0) 100%)'
          : 'linear-gradient(0deg, rgba(9,10,13,0.90) 0%, rgba(9,10,13,0.35) 60%, rgba(9,10,13,0) 100%)',
      }}
    >
      {playbackError && (
        <PlaybackErrorBanner
          errorMessage={playbackError}
          playbackError={playback.playbackError}
          onRetry={() => void playerActions.resume()}
          compact
          className="pointer-events-auto w-full max-w-[920px]"
        />
      )}

      <div
        role="region"
        aria-label="Trình phát thu gọn"
        className="lp-glass-pill pointer-events-auto relative flex h-[82px] w-full max-w-[920px] items-center justify-between gap-4 rounded-full px-6"
      >
        {/* Left: Layout Sample 2 — strictly 5 transport controls: Shuffle | Previous | Play/Pause | Next | Playback Options */}
        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1" data-testid="mini-player-transport-bar">
          <ShuffleButton
            enabled={ui.shuffle}
            accentColor={userAccent.activeHex}
            onToggle={() => uiStore.toggleShuffle()}
            size="sm"
            testId="mini-player-shuffle-btn"
          />

          <button
            type="button"
            disabled={!hasTrack && !playback.canPrevious}
            onClick={() => uiStore.previousTrack()}
            title="Bài trước"
            aria-label="Bài trước"
            data-testid="mini-player-prev-btn"
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 sm:h-9 sm:w-9"
          >
            <SkipBack className="h-[17px] w-[17px]" />
          </button>

          <button
            type="button"
            onClick={() => uiStore.togglePlayPause()}
            title={isPlaying ? 'Tạm dừng' : 'Phát nhạc'}
            aria-label={isPlaying ? 'Tạm dừng' : 'Phát nhạc'}
            data-testid="mini-player-play-pause-btn"
            style={
              isLight
                ? {
                    backgroundColor: userAccent.activeHex,
                    color: userAccent.onAccentText,
                    boxShadow: `0 8px 22px rgba(${userAccent.glowRgb}, 0.34)`,
                  }
                : undefined
            }
            className={`flex h-10 w-10 items-center justify-center rounded-full transition hover:scale-105 active:scale-95 sm:h-11 sm:w-11 ${
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
            disabled={!hasTrack && !playback.canNext}
            onClick={() => uiStore.nextTrack()}
            title="Bài tiếp theo"
            aria-label="Bài tiếp theo"
            data-testid="mini-player-next-btn"
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 sm:h-9 sm:w-9"
          >
            <SkipForward className="h-[17px] w-[17px]" />
          </button>

          <PlaybackOptionsPopover
            repeatMode={ui.repeat}
            autoNextEnabled={ui.autoNext}
            remainingReplays={playback.remainingReplays}
            hasActiveTrack={hasTrack}
            accentColor={userAccent.activeHex}
            onSelectRepeat={(mode) => uiStore.setRepeatMode(mode)}
            onToggleAutoNext={() => uiStore.toggleAutoNext()}
            size="sm"
            placement="top"
            testId="mini-player-options-btn"
          />
        </div>

        {/* Center: Artwork + Title/Artist + Thin Interactive Progress */}
        <div className="flex min-w-0 flex-1 items-center gap-3.5 px-2">
          <button
            type="button"
            onClick={() => (hasTrack ? uiStore.openNowPlaying() : uiStore.openLibraryTab('songs'))}
            title={hasTrack ? 'Mở màn hình Đang phát' : 'Mở Thư viện nhạc'}
            className="group relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--border-glass)] bg-[var(--surface-glass-light)] shadow-md"
          >
            {hasTrack ? (
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
            ) : (
              <Disc3 className="h-5 w-5 text-[var(--text-muted)]" />
            )}
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <button
                type="button"
                onClick={() => (hasTrack ? uiStore.openNowPlaying() : uiStore.openLibraryTab('songs'))}
                data-testid="mini-player-title"
                title={title}
                className="truncate text-left text-[13.5px] font-semibold text-[var(--text-primary)] hover:underline"
              >
                {title}
              </button>
              <MiniPlayerTimeReadout hasTrack={hasTrack} duration={duration} />
            </div>

            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                disabled={!hasTrack}
                onClick={() => {
                  if (hasTrack) uiStore.openArtistDetail(artist);
                }}
                data-testid="mini-player-artist"
                title={artist}
                className="truncate text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:hover:text-[var(--text-secondary)]"
              >
                {artist}
              </button>
              <span
                title={formatSummary}
                className="font-mono-tabular hidden shrink-0 text-[10px] font-medium tracking-[0.04em] text-[var(--text-muted)] xl:inline"
              >
                {formatSummary}
              </span>
            </div>

            {/* Thin progress bar (isolated from outer MiniPlayer re-renders on timeupdate) */}
            <MiniPlayerProgressBar
              hasTrack={hasTrack}
              duration={duration}
              accentColor={userAccent.activeHex}
            />
          </div>
        </div>

        {/* Right: Favorite, Queue, Expand, Volume */}
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            disabled={!hasTrack}
            onClick={() => {
              if (activeTrackId) void uiStore.toggleFavorite(activeTrackId);
            }}
            title={isFavorite ? 'Bỏ yêu thích' : 'Yêu thích'}
            aria-label={isFavorite ? 'Bỏ yêu thích' : 'Yêu thích'}
            className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
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
