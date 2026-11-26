import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentProps,
  type CSSProperties,
} from 'react';
import {
  ArrowLeft,
  ChevronDown,
  Disc3,
  Heart,
  ImagePlus,
  ListMusic,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  SkipBack,
  SkipForward,
  Trash2,
  Upload,
  User,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { LyricsEncodingOption } from '../../../shared/types/stage5';
import type {
  ResolvedTrackLyrics,
  TrackMetadataOverrideInput,
} from '../../../shared/types/track';
import { classifyTrackAudioCodec } from '../../../shared/utils/audio-codec';
import {
  decodeLyricsBuffer,
  getSupportedLyricsEncodings,
  LyricsEncodingError,
} from '../../../shared/utils/lyrics-encoding';
import {
  groupTimedLyricLines,
} from '../../../shared/utils/lyrics-parser';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import { FocusMinimalLyrics } from '../components/FocusMinimalLyrics';
import { NowPlayingLyricsPanel } from '../components/NowPlayingLyricsPanel';
import { AnchoredPopover, OverlayPortal } from '../components/OverlayLayer';
import { PlaybackErrorBanner } from '../components/PlaybackErrorBanner';
import { ShuffleButton } from '../components/PlaybackModeControls';
import { PlaybackOptionsPopover } from '../components/PlaybackOptionsPopover';
import { PlaybackQueuePanel } from '../components/PlaybackQueuePanel';
import { PlaybackTransitionControl } from '../components/PlaybackTransitionControl';
import { QuickEqPopover } from '../components/QuickEqPopover';
import {
  TrackMetadataModal,
  buildMetadataEditTargetFromTrack,
  type TrackMetadataEditTarget,
} from '../components/TrackMetadataModal';
import { VinylTurntable } from '../components/VinylTurntable';
import { libraryStore, useLibraryState } from '../stores/library-store';
import {
  playerActions,
  useActiveLyricGroupIndex,
  usePlaybackCoreState,
  usePlaybackTimeSeconds,
} from '../stores/player-store';
import { uiStore, useUiState } from '../stores/ui-store';
import {
  buildFallbackAdaptiveTheme,
  getCachedAdaptiveArtworkTheme,
  resolveAdaptiveArtworkTheme,
  type AdaptiveArtworkTheme,
} from '../utils/adaptive-artwork';
import {
  useForegroundResumeState,
  useUiAnimationPolicy,
} from '../utils/animation-policy';
import { FALLBACK_DOREMI_PALETTE } from '../utils/dynamic-color';
import {
  computeFocusRadialLayout,
  computeUnifiedVinylPlacement,
} from '../utils/focus-radial-layout';
import {
  formatDurationSeconds,
  formatFileSize,
  formatTrackAudioSpecs,
} from '../utils/formatters';
import { VinylSwapController, type VinylSwapSnapshot } from '../utils/vinyl-swap-controller';
import { getVolumeSliderVisualState } from '../utils/volume-slider';

const MAX_WEB_COVER_BYTES = 15 * 1024 * 1024;
const ALLOWED_WEB_COVER_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function formatArtworkSourceLabel(source: 'custom' | 'embedded' | 'folder' | 'default'): string {
  switch (source) {
    case 'custom':
      return 'Ảnh bìa tùy chỉnh';
    case 'embedded':
      return 'Ảnh nhúng trong file';
    case 'folder':
      return 'Ảnh thư mục';
    default:
      return 'Ảnh mặc định DoReMi';
  }
}

function formatLyricsSourceLabel(lyrics: ResolvedTrackLyrics): string {
  if (lyrics.format === 'none') {
    return 'Chưa có lời';
  }
  const kind = lyrics.format === 'lrc' ? 'LRC đồng bộ' : 'Văn bản tĩnh';
  switch (lyrics.source) {
    case 'custom':
      return `${kind} · Tùy chỉnh`;
    case 'sidecar':
      return `${kind} · File cạnh bài`;
    case 'embedded':
      return `${kind} · Nhúng trong file`;
    default:
      return kind;
  }
}

type LiveVinylTurntableProps = Omit<
  ComponentProps<typeof VinylTurntable>,
  'progressPct' | 'currentTimeSec'
> & {
  hasTrack: boolean;
  durationSec: number;
};

const LiveVinylTurntable = memo(function LiveVinylTurntable({
  hasTrack,
  durationSec,
  ...rest
}: LiveVinylTurntableProps) {
  const rawTime = usePlaybackTimeSeconds();
  const currentTimeSec = hasTrack ? rawTime : 0;
  const progressPct = durationSec > 0 ? Math.min(100, (currentTimeSec / durationSec) * 100) : 0;
  return (
    <VinylTurntable
      {...rest}
      progressPct={progressPct}
      currentTimeSec={currentTimeSec}
      durationSec={durationSec}
    />
  );
});

const LiveNowPlayingProgressBar = memo(function LiveNowPlayingProgressBar({
  variant,
  hasTrack,
  durationSec,
  accentColor,
  isLight,
  isFocusMode,
  shouldSnapResume,
  currentTimeTextColor,
  mutedTextColor,
  marginTopPx,
}: {
  variant: 'focus' | 'standard';
  hasTrack: boolean;
  durationSec: number;
  accentColor: string;
  isLight: boolean;
  isFocusMode: boolean;
  shouldSnapResume: boolean;
  currentTimeTextColor?: string;
  mutedTextColor?: string;
  marginTopPx?: number;
}) {
  const rawTime = usePlaybackTimeSeconds();
  const currentTimeSec = hasTrack ? rawTime : 0;
  const progressPct = durationSec > 0 ? Math.min(100, (currentTimeSec / durationSec) * 100) : 0;

  if (variant === 'focus') {
    return (
      <div
        className="flex w-full items-center gap-2.5"
        style={marginTopPx !== undefined ? { marginTop: `${marginTopPx}px` } : undefined}
      >
        <span
          data-testid="focus-current-time"
          className="font-mono-tabular w-10 shrink-0 text-[12px]"
          style={{ color: currentTimeTextColor }}
        >
          {formatDurationSeconds(currentTimeSec)}
        </span>
        <div className="relative flex h-4 flex-1 items-center">
          <div
            className="pointer-events-none h-[3px] w-full overflow-hidden rounded-full"
            style={{
              backgroundColor: isLight
                ? 'rgba(18, 20, 27, 0.18)'
                : 'rgba(255, 255, 255, 0.20)',
            }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${progressPct}%`,
                backgroundColor: accentColor,
              }}
            />
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(1, durationSec)}
            step={0.5}
            tabIndex={isFocusMode ? 0 : -1}
            value={Math.min(currentTimeSec, Math.max(1, durationSec))}
            onChange={(e) => uiStore.seek(Number(e.target.value))}
            aria-label="Thanh tua bài hát Focus Vinyl"
            className="lp-slider absolute inset-0 h-4 w-full"
          />
        </div>
        <span
          className="font-mono-tabular w-10 shrink-0 text-right text-[12px]"
          style={{ color: mutedTextColor }}
        >
          {formatDurationSeconds(durationSec)}
        </span>
      </div>
    );
  }

  return (
    <div className="flex w-full items-center gap-2.5">
      <span
        data-testid="now-playing-current-time"
        className="font-mono-tabular w-9 shrink-0 text-right text-[11px] text-[var(--np-text-secondary)]"
      >
        {formatDurationSeconds(currentTimeSec)}
      </span>
      <div className="relative flex h-3.5 flex-1 items-center">
        <div className="pointer-events-none h-[3px] w-full overflow-hidden rounded-full bg-[var(--np-ring-track)]">
          <div
            className={`h-full rounded-full ${
              shouldSnapResume ? '' : 'transition-[width] duration-150'
            }`}
            style={{
              width: `${progressPct}%`,
              backgroundColor: accentColor,
            }}
          />
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(1, durationSec)}
          step={0.5}
          value={Math.min(currentTimeSec, Math.max(1, durationSec))}
          onChange={(e) => uiStore.seek(Number(e.target.value))}
          aria-label="Thanh tua bài hát"
          className="lp-slider absolute inset-0 h-3.5 w-full"
        />
      </div>
      <span className="font-mono-tabular w-9 shrink-0 text-[11px] text-[var(--np-text-muted)]">
        {formatDurationSeconds(durationSec)}
      </span>
    </div>
  );
});

export function NowPlayingPage() {
  const ui = useUiState();
  const playback = usePlaybackCoreState();
  const library = useLibraryState();
  const foregroundResume = useForegroundResumeState();
  const policy = useUiAnimationPolicy(ui.preferences);

  const isFocusMode = ui.nowPlayingMode === 'focus';
  const isLight = ui.preferences.themeMode === 'light';
  const isHiddenRef = useRef(foregroundResume.isHidden);
  isHiddenRef.current = foregroundResume.isHidden;
  const shouldSnapResume = foregroundResume.shouldSnapNextPaint;
  const shouldSnapResumeRef = useRef(shouldSnapResume);
  shouldSnapResumeRef.current = shouldSnapResume;

  // Single source of truth: active AudioEngine track (zero demo fallback)
  const localTrack = useMemo(
    () =>
      playback.currentTrackId
        ? libraryStore.getTrackById(playback.currentTrackId) ?? playback.currentTrack ?? null
        : null,
    [library.tracks, playback.currentTrackId, playback.currentTrack],
  );

  const activeTrackId = localTrack?.id ?? '';
  const activeTitle = localTrack ? localTrack.title : 'Chưa phát bài hát';
  const activeArtist = localTrack ? localTrack.artist ?? 'Chưa rõ nghệ sĩ' : '—';
  const activeAlbumTitle = localTrack ? localTrack.album ?? 'Không có album' : '—';
  const activeYear: number | null = localTrack ? localTrack.year ?? null : null;
  const activeDurationSec = localTrack
    ? playback.durationSeconds || (localTrack.duration_ms ? localTrack.duration_ms / 1000 : 0)
    : 0;

  const isActuallyPlaying = Boolean(localTrack && playback.status === 'playing');
  const playbackError =
    localTrack && playback.status === 'error' ? playback.errorMessage : null;

  const activeTechSummary = localTrack ? formatTrackAudioSpecs(localTrack) : '';

  const activeCoverUrl = localTrack
    ? uiStore.getCoverForTrack(localTrack.id, 'full')
    : DEFAULT_DOREMI_ARTWORK_URL;
  const activeThumbUrl = localTrack
    ? uiStore.getCoverForTrack(localTrack.id, 'thumb')
    : DEFAULT_DOREMI_ARTWORK_URL;

  const hasCustomArtwork = Boolean(localTrack?.has_custom_artwork);
  const artworkSource: 'custom' | 'embedded' | 'folder' | 'default' =
    localTrack?.artwork_source ?? 'default';

  const rawVolume = playback.volume;
  const rawMuted = playback.muted;
  const volumeVisual = getVolumeSliderVisualState(rawVolume, rawMuted);
  const [isVolumeHovered, setIsVolumeHovered] = useState(false);
  const [isVolumeDragging, setIsVolumeDragging] = useState(false);
  const [isVolumeFocused, setIsVolumeFocused] = useState(false);

  useEffect(() => {
    if (!isVolumeDragging) return;
    const end = () => setIsVolumeDragging(false);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [isVolumeDragging]);

  // Escape exits Focus Vinyl Mode cleanly ONLY when no dialog/menu/popover/overlay sidebar is active
  useEffect(() => {
    if (!isFocusMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const target = event.target as HTMLElement | null;
        if (
          target?.closest('[role="menu"], [role="dialog"]') ||
          document.querySelector('[role="dialog"], [role="menu"]')
        ) {
          return;
        }
        if (ui.nowPlayingSidebarRevealed) {
          uiStore.setNowPlayingSidebarRevealed(false);
          return;
        }
        event.preventDefault();
        uiStore.setNowPlayingMode('standard');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFocusMode, ui.nowPlayingSidebarRevealed]);

  const userAccentPalette = uiStore.getCurrentPalette();
  const userAccentDynamicFallback = useMemo(
    () => ({
      dominant: userAccentPalette.dominant,
      secondary: userAccentPalette.secondary,
      glowRgb: userAccentPalette.glowRgb,
      secondaryGlowRgb: userAccentPalette.secondaryGlowRgb,
      badgeBg: userAccentPalette.badgeBg,
      borderGlow: userAccentPalette.borderGlow,
      isFallback: false,
    }),
    [userAccentPalette],
  );

  // =========================================================================
  // Shared Adaptive Artwork Extraction + Bounded Cache + Stale-Safe Crossfade
  // =========================================================================
  const [adaptiveTheme, setAdaptiveTheme] = useState<AdaptiveArtworkTheme>(() => {
    return (
      getCachedAdaptiveArtworkTheme({
        artworkUrl: activeCoverUrl,
        themeMode: ui.preferences.themeMode,
        dynamicAlbumColors: policy.dynamicAlbumColors,
        qualityPreset: policy.qualityPreset,
      }) ??
      buildFallbackAdaptiveTheme({
        artworkKey: activeCoverUrl,
        themeMode: ui.preferences.themeMode,
        palette: policy.dynamicAlbumColors ? FALLBACK_DOREMI_PALETTE : userAccentDynamicFallback,
      })
    );
  });

  const [previousTheme, setPreviousTheme] = useState<AdaptiveArtworkTheme | null>(null);
  const [isCrossfadingBg, setIsCrossfadingBg] = useState(false);
  const artworkRequestTokenRef = useRef(0);
  const crossfadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentThemeRef = useRef(adaptiveTheme);
  currentThemeRef.current = adaptiveTheme;

  // Cancel any in-flight artwork crossfade immediately when window hides or snaps back to foreground
  useEffect(() => {
    if (!foregroundResume.isHidden && !shouldSnapResume) {
      return;
    }
    if (crossfadeTimerRef.current) {
      clearTimeout(crossfadeTimerRef.current);
      crossfadeTimerRef.current = null;
    }
    setPreviousTheme(null);
    setIsCrossfadingBg(false);
  }, [foregroundResume.isHidden, shouldSnapResume]);

  useEffect(() => {
    const token = ++artworkRequestTokenRef.current;

    const applyNextTheme = (nextTheme: AdaptiveArtworkTheme) => {
      if (token !== artworkRequestTokenRef.current) {
        return;
      }
      const prev = currentThemeRef.current;
      if (
        prev.artworkKey === nextTheme.artworkKey &&
        prev.lightToneHex === nextTheme.lightToneHex &&
        prev.focusBaseColor === nextTheme.focusBaseColor
      ) {
        setAdaptiveTheme(nextTheme);
        return;
      }
      if (crossfadeTimerRef.current) {
        clearTimeout(crossfadeTimerRef.current);
        crossfadeTimerRef.current = null;
      }
      const allowBgCrossfade =
        policy.backgroundCrossfadeMs > 0 &&
        prev.artworkKey !== nextTheme.artworkKey &&
        !isHiddenRef.current &&
        !shouldSnapResumeRef.current;

      if (allowBgCrossfade) {
        setPreviousTheme(prev);
        setIsCrossfadingBg(true);
        setAdaptiveTheme(nextTheme);
        // Kick off smooth fade-out on next paint frame, then free previous DOM backdrop layer
        requestAnimationFrame(() => {
          if (token === artworkRequestTokenRef.current && !isHiddenRef.current) {
            setIsCrossfadingBg(false);
          }
        });
        crossfadeTimerRef.current = setTimeout(() => {
          setPreviousTheme(null);
          crossfadeTimerRef.current = null;
        }, policy.backgroundCrossfadeMs + 40);
      } else {
        // Hidden/resuming: never suspend a stale rAF holding previousTheme over new track art!
        setPreviousTheme(null);
        setIsCrossfadingBg(false);
        setAdaptiveTheme(nextTheme);
      }
    };

    const cached = getCachedAdaptiveArtworkTheme({
      artworkUrl: activeCoverUrl,
      themeMode: ui.preferences.themeMode,
      dynamicAlbumColors: policy.dynamicAlbumColors,
      qualityPreset: policy.qualityPreset,
    });
    if (cached) {
      applyNextTheme(cached);
      return;
    }

    void resolveAdaptiveArtworkTheme({
      artworkUrl: activeCoverUrl,
      themeMode: ui.preferences.themeMode,
      dynamicAlbumColors: policy.dynamicAlbumColors,
      qualityPreset: policy.qualityPreset,
      userAccentFallback: policy.dynamicAlbumColors
        ? FALLBACK_DOREMI_PALETTE
        : userAccentDynamicFallback,
    }).then((resolved) => {
      applyNextTheme(resolved);
    });
  }, [
    activeCoverUrl,
    ui.preferences.themeMode,
    policy.dynamicAlbumColors,
    policy.qualityPreset,
    policy.backgroundCrossfadeMs,
    userAccentDynamicFallback,
  ]);

  useEffect(() => {
    return () => {
      artworkRequestTokenRef.current += 1;
      if (crossfadeTimerRef.current) {
        clearTimeout(crossfadeTimerRef.current);
        crossfadeTimerRef.current = null;
      }
    };
  }, []);

  const palette = adaptiveTheme.palette;

  // Vinyl Swap Controller (decoupled from playback & NEVER triggered on Standard <-> Focus toggle)
  const swapControllerRef = useRef<VinylSwapController | null>(null);
  if (!swapControllerRef.current) {
    swapControllerRef.current = new VinylSwapController(activeTrackId);
  }
  const [swapSnapshot, setSwapSnapshot] = useState<VinylSwapSnapshot>(() =>
    swapControllerRef.current!.getSnapshot(),
  );

  useEffect(() => {
    const controller = swapControllerRef.current!;
    return controller.subscribe(setSwapSnapshot);
  }, []);

  useEffect(() => {
    const animateSwap =
      ui.appearance.vinylAnimation &&
      !policy.reducedMotionEffective &&
      !isHiddenRef.current &&
      !shouldSnapResumeRef.current;
    swapControllerRef.current?.transitionTo(activeTrackId, animateSwap);
  }, [activeTrackId, ui.appearance.vinylAnimation, policy.reducedMotionEffective]);

  // Immediately flush any pending background swap timers when window hides or resumes to foreground
  useEffect(() => {
    if (foregroundResume.isHidden || shouldSnapResume) {
      swapControllerRef.current?.settleImmediately(activeTrackId);
    }
  }, [foregroundResume.isHidden, shouldSnapResume, activeTrackId]);

  useEffect(() => {
    return () => {
      swapControllerRef.current?.dispose();
    };
  }, []);

  const displayedCoverUrl = swapSnapshot.displayedTrackId
    ? uiStore.getCoverForTrack(swapSnapshot.displayedTrackId, 'full')
    : DEFAULT_DOREMI_ARTWORK_URL;
  const displayedLocalTrack = useMemo(
    () => library.tracks.find((t) => t.id === swapSnapshot.displayedTrackId) ?? null,
    [library.tracks, swapSnapshot.displayedTrackId],
  );
  const displayedAlbumTitle = displayedLocalTrack?.album ?? activeAlbumTitle;

  // =========================================================================
  // Resolved Lyrics (Synchronized LRC + Plain TXT — stale-safe)
  // =========================================================================
  const [resolvedLyrics, setResolvedLyrics] = useState<ResolvedTrackLyrics>(() =>
    uiStore.getWebResolvedLyrics(activeTrackId),
  );
  const [isLoadingLyrics, setIsLoadingLyrics] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (localTrack && window.losslessApi) {
      setIsLoadingLyrics(true);
      void window.losslessApi
        .getTrackLyrics(localTrack.id)
        .then((res) => {
          if (!cancelled) {
            setResolvedLyrics(res);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setResolvedLyrics({
              trackId: localTrack.id,
              source: 'none',
              format: 'none',
              rawContent: '',
              timedLines: [],
              plainLines: [],
              hasCustomLyrics: false,
              sidecarPath: null,
            });
          }
        })
        .finally(() => {
          if (!cancelled) {
            setIsLoadingLyrics(false);
          }
        });
    } else {
      setResolvedLyrics(uiStore.getWebResolvedLyrics(activeTrackId));
      setIsLoadingLyrics(false);
    }
    return () => {
      cancelled = true;
    };
  }, [activeTrackId, localTrack?.id, ui.customLyricsByTrackId]);

  const isLrcLyrics =
    resolvedLyrics.format === 'lrc' && resolvedLyrics.timedLines.length > 0;
  const isTxtLyrics =
    resolvedLyrics.format === 'txt' && resolvedLyrics.plainLines.length > 0;

  const lyricGroups = useMemo(
    () => (isLrcLyrics ? groupTimedLyricLines(resolvedLyrics.timedLines) : []),
    [isLrcLyrics, resolvedLyrics.timedLines],
  );

  const activeLyricIndex = useActiveLyricGroupIndex(
    lyricGroups,
    Boolean(localTrack && isLrcLyrics),
  );
  const effectiveActiveLyricIdx = activeLyricIndex === -1 ? 0 : activeLyricIndex;

  const lyricsContainerRef = useRef<HTMLDivElement | null>(null);
  const activeLineRef = useRef<HTMLButtonElement | null>(null);
  const [isManualScrolling, setIsManualScrolling] = useState(false);

  const rightTabSafe = ui.nowPlayingRightTab;

  useEffect(() => {
    if (
      isFocusMode ||
      rightTabSafe !== 'lyrics' ||
      !isLrcLyrics ||
      isManualScrolling ||
      !activeLineRef.current ||
      !lyricsContainerRef.current
    ) {
      return;
    }
    const container = lyricsContainerRef.current;
    const activeEl = activeLineRef.current;
    const containerRect = container.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();
    const targetTop =
      container.scrollTop +
      (activeRect.top - containerRect.top) -
      containerRect.height * 0.42 +
      activeRect.height / 2;

    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: policy.reducedMotionEffective ? 'auto' : 'smooth',
    });
  }, [
    activeLyricIndex,
    isFocusMode,
    rightTabSafe,
    isLrcLyrics,
    isManualScrolling,
    policy.reducedMotionEffective,
  ]);

  useEffect(() => {
    if (!isFocusMode && rightTabSafe === 'lyrics') {
      setIsManualScrolling(false);
    }
  }, [isFocusMode, rightTabSafe]);

  useEffect(() => {
    setIsManualScrolling(false);
    setIsMoreOpen(false);
  }, [activeTrackId]);

  // Modals & Menus
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const [isLyricsModalOpen, setIsLyricsModalOpen] = useState(false);
  const [lyricsDraft, setLyricsDraft] = useState('');
  const [lyricsDraftFormat, setLyricsDraftFormat] = useState<'lrc' | 'txt'>('lrc');
  const [lyricsImportEncoding, setLyricsImportEncoding] = useState<LyricsEncodingOption>('auto');
  const [isMetadataModalOpen, setIsMetadataModalOpen] = useState(false);
  const [isSavingMeta, setIsSavingMeta] = useState(false);

  const coverFileInputRef = useRef<HTMLInputElement | null>(null);
  const lyricsFileInputRef = useRef<HTMLInputElement | null>(null);

  // =========================================================================
  // Unified Viewport, Title Wrap Observer & ResizeObserver Geometry
  // =========================================================================
  const [viewport, setViewport] = useState(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 1366,
    height: typeof window !== 'undefined' ? window.innerHeight : 768,
  }));
  const focusTitleRef = useRef<HTMLHeadingElement | null>(null);
  const [measuredTitleHeightPx, setMeasuredTitleHeightPx] = useState<number | undefined>(
    undefined,
  );

  useEffect(() => {
    const onResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    setMeasuredTitleHeightPx(undefined);
  }, [activeTitle, viewport.width]);

  useEffect(() => {
    if (!isFocusMode || typeof ResizeObserver === 'undefined') {
      return;
    }
    const el = focusTitleRef.current;
    if (!el) return;
    const syncHeight = () => {
      const rectHeight = Math.round(el.getBoundingClientRect().height);
      if (rectHeight > 24) {
        setMeasuredTitleHeightPx((prev) =>
          prev !== undefined && Math.abs(prev - rectHeight) < 2 ? prev : rectHeight,
        );
      }
    };
    syncHeight();
    const observer = new ResizeObserver(syncHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isFocusMode, activeTitle]);

  const placement = useMemo(
    () =>
      computeUnifiedVinylPlacement({
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        isFocusMode,
      }),
    [viewport.width, viewport.height, isFocusMode],
  );

  // If viewport grows narrow (< 1120px) and user was on inline 3-zone Queue, ensure Queue tab stays reachable
  useEffect(() => {
    if (placement.hasThreeZoneDesktop && ui.nowPlayingRightTab === 'queue') {
      uiStore.setNowPlayingRightTab('lyrics');
    }
  }, [placement.hasThreeZoneDesktop, ui.nowPlayingRightTab]);

  const hasMultilineLyrics = useMemo(
    () => lyricGroups.some((grp) => grp.lines.length > 1),
    [lyricGroups],
  );

  const focusRadial = useMemo(
    () =>
      computeFocusRadialLayout({
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        placement,
        hasLyrics: isLrcLyrics,
        measuredTitleHeightPx,
        hasMultilineLyrics,
      }),
    [
      viewport.width,
      viewport.height,
      placement,
      isLrcLyrics,
      measuredTitleHeightPx,
      hasMultilineLyrics,
    ],
  );

  const handleFocusBrowseStateChange = useCallback(
    (next: { trackId: string; viewedIndex: number } | null) => {
      uiStore.setFocusLyricsBrowseState(next);
    },
    [],
  );

  // Coordinates of the single persistent VinylTurntable wrapper relative to NowPlayingPage root
  // Sidebar renders as overlay in BOTH Standard & Focus so stage stays 100% invariant (`0px` shift).
  const vinylWrapperX = placement.translateX;
  const vinylWrapperY = placement.translateY;

  // Handlers
  const handleImportCustomCover = async () => {
    setIsMoreOpen(false);
    if (localTrack && window.losslessApi) {
      const result = await libraryStore.importCustomArtwork(localTrack.id);
      if (result.canceled) return;
      if (result.error) {
        uiStore.showToast(result.error);
      } else {
        uiStore.showToast('Đã cập nhật ảnh bìa tùy chỉnh');
      }
      return;
    }
    coverFileInputRef.current?.click();
  };

  const handleWebCoverFileSelected = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!ALLOWED_WEB_COVER_MIMES.has(file.type)) {
      uiStore.showToast('Định dạng ảnh không hợp lệ. Chỉ hỗ trợ JPG, PNG hoặc WEBP.');
      return;
    }
    if (file.size > MAX_WEB_COVER_BYTES) {
      uiStore.showToast('Ảnh bìa vượt quá giới hạn 15MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string' && reader.result.startsWith('data:image/')) {
        uiStore.setWebCustomCover(activeTrackId, reader.result);
      } else {
        uiStore.showToast('Không thể đọc dữ liệu hình ảnh đã chọn.');
      }
    };
    reader.onerror = () => uiStore.showToast('Lỗi khi đọc file ảnh bìa.');
    reader.readAsDataURL(file);
  };

  const handleRemoveCustomCover = async () => {
    setIsMoreOpen(false);
    if (localTrack && window.losslessApi) {
      const result = await libraryStore.removeCustomArtwork(localTrack.id);
      if (result.error) {
        uiStore.showToast(result.error);
      } else {
        uiStore.showToast('Đã xóa ảnh tùy chỉnh và khôi phục ảnh gốc');
      }
      return;
    }
    uiStore.removeWebCustomCover(activeTrackId);
  };

  const handleImportLyricsFile = async (encoding: LyricsEncodingOption = lyricsImportEncoding) => {
    setIsMoreOpen(false);
    if (localTrack && window.losslessApi) {
      const result = await window.losslessApi.importTrackLyricsFile(localTrack.id, encoding);
      if (result.canceled) return;
      if (result.error) {
        uiStore.showToast(result.error);
      } else if (result.lyrics) {
        setResolvedLyrics(result.lyrics);
        uiStore.setNowPlayingRightTab('lyrics');
        uiStore.showToast('Đã nhập file lời bài hát');
      }
      return;
    }
    lyricsFileInputRef.current?.click();
  };

  const handleWebLyricsFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.lrc') && !lower.endsWith('.txt')) {
      uiStore.showToast('Chỉ hỗ trợ file lời bài hát .lrc hoặc .txt.');
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const decoded = decodeLyricsBuffer(new Uint8Array(buffer), lyricsImportEncoding);
      const text = decoded.text;
      if (!text.trim()) {
        uiStore.showToast('File lời bài hát đang trống.');
        return;
      }
      const fmt: 'lrc' | 'txt' = lower.endsWith('.lrc') ? 'lrc' : 'txt';
      uiStore.setWebCustomLyrics(activeTrackId, fmt, text);
      uiStore.setNowPlayingRightTab('lyrics');
      uiStore.showToast(`Đã nhập lời bài hát (${decoded.detectedEncoding.toUpperCase()})`);
    } catch (error) {
      if (error instanceof LyricsEncodingError) {
        uiStore.showToast(error.message);
      } else {
        uiStore.showToast('Không thể giải mã file lời bài hát. Hãy thử chọn lại bảng mã.');
      }
    }
  };

  const openLyricsEditorModal = () => {
    setIsMoreOpen(false);
    setLyricsDraft(resolvedLyrics.rawContent);
    setLyricsDraftFormat(resolvedLyrics.format === 'txt' ? 'txt' : 'lrc');
    setIsLyricsModalOpen(true);
  };

  const handleSaveLyricsModal = async () => {
    if (localTrack && window.losslessApi) {
      const saved = await window.losslessApi.saveCustomLyrics(
        localTrack.id,
        lyricsDraftFormat,
        lyricsDraft,
      );
      setResolvedLyrics(saved);
      uiStore.setNowPlayingRightTab('lyrics');
      uiStore.showToast('Đã lưu lời bài hát vào thư viện');
    } else {
      uiStore.setWebCustomLyrics(activeTrackId, lyricsDraftFormat, lyricsDraft);
    }
    setIsLyricsModalOpen(false);
  };

  const handleRemoveCustomLyrics = async () => {
    setIsMoreOpen(false);
    if (localTrack && window.losslessApi) {
      const restored = await window.losslessApi.removeCustomLyrics(localTrack.id);
      setResolvedLyrics(restored);
      uiStore.showToast('Đã xóa lời tùy chỉnh và khôi phục nguồn tự động');
    } else {
      uiStore.removeWebCustomLyrics(activeTrackId);
    }
  };

  const metadataEditTarget: TrackMetadataEditTarget | null = useMemo(() => {
    if (!isMetadataModalOpen || !localTrack) return null;
    return buildMetadataEditTargetFromTrack(localTrack);
  }, [isMetadataModalOpen, localTrack]);

  const handleSaveMetadata = async (trackId: string, input: TrackMetadataOverrideInput) => {
    setIsSavingMeta(true);
    try {
      if (window.losslessApi) {
        await libraryStore.updateTrackMetadataOverride(trackId, input);
        uiStore.showToast('Đã lưu thông tin bài hát (file gốc không thay đổi)');
      }
    } finally {
      setIsSavingMeta(false);
    }
  };

  const handleRestoreMetadata = async (trackId: string) => {
    setIsSavingMeta(true);
    try {
      if (window.losslessApi) {
        await libraryStore.restoreTrackMetadataOriginal(trackId);
        uiStore.showToast('Đã khôi phục thông tin gốc của bài hát');
      }
    } finally {
      setIsSavingMeta(false);
    }
  };

  const snapBackToLyrics = useCallback(() => setIsManualScrolling(false), []);
  const handleVinylSeek = useCallback((nextSec: number) => uiStore.seek(nextSec), []);
  const handleManualLyricsScroll = useCallback(() => setIsManualScrolling(true), []);
  const handleSeekToLyricLine = useCallback((timeSec: number) => {
    uiStore.seek(timeSec);
    setIsManualScrolling(false);
  }, []);
  const handleImportLyricsClick = useCallback(() => {
    void handleImportLyricsFile();
  }, [handleImportLyricsFile]);

  const lyricsSourceLabel = useMemo(
    () => formatLyricsSourceLabel(resolvedLyrics),
    [resolvedLyrics],
  );

  const isFavorite = Boolean(activeTrackId && uiStore.isFavoriteTrack(activeTrackId));
  const showVolumeTooltip = isVolumeHovered || isVolumeDragging || isVolumeFocused;

  // Real technical metadata specs (never fabricated)
  const techSpecItems = useMemo(() => {
    const items: Array<{ label: string; value: string }> = [];
    if (!localTrack) return items;
    const classified = classifyTrackAudioCodec(localTrack);
    const formatLabel = classified.isM4aContainer
      ? classified.qualityTier === 'lossless'
        ? `${classified.displayCodec} (Lossless · M4A)`
        : classified.qualityTier === 'lossy'
          ? `${classified.displayCodec} (Lossy · M4A)`
          : `${classified.displayCodec} (M4A)`
      : classified.displayCodec;
    if (formatLabel) items.push({ label: 'Định dạng', value: formatLabel });
    const bitDepth = classified.qualityTier === 'lossy' ? null : localTrack.bit_depth;
    if (bitDepth) items.push({ label: 'Bit depth', value: `${bitDepth}-bit` });
    if (localTrack.sample_rate_hz) {
      items.push({
        label: 'Sample rate',
        value: `${Number((localTrack.sample_rate_hz / 1000).toFixed(1))} kHz`,
      });
    }
    const bitrateKbps = localTrack.bitrate_bps
      ? Math.round(localTrack.bitrate_bps / 1000)
      : null;
    if (bitrateKbps) items.push({ label: 'Bitrate', value: `${bitrateKbps} kbps` });
    if (localTrack.file_size_bytes && localTrack.file_size_bytes > 0) {
      items.push({ label: 'Dung lượng', value: formatFileSize(localTrack.file_size_bytes) });
    }
    return items;
  }, [localTrack]);

  // Soft diagonal boundary polygon matching standardZones
  const renderBackgroundSet = (themeObj: AdaptiveArtworkTheme, isOutgoingLayer: boolean) => {
    const { diagonalTopPct, diagonalBottomPct } = placement.standardZones;
    const diagPolygon = `polygon(${diagonalTopPct}% 0%, 100% 0%, 100% 100%, ${diagonalBottomPct}% 100%)`;
    const diagEdgeBand = `polygon(${Math.max(0, diagonalTopPct - 0.6)}% 0%, ${Math.min(100, diagonalTopPct + 1.6)}% 0%, ${Math.min(100, diagonalBottomPct + 1.6)}% 100%, ${Math.max(0, diagonalBottomPct - 0.6)}% 100%)`;

    const modeFadeStyle =
      !shouldSnapResume && policy.modeTransitionMs > 0
        ? `opacity ${policy.modeTransitionMs}ms cubic-bezier(0.22, 1, 0.36, 1)`
        : 'none';

    const effectiveFocusArtwork =
      themeObj.blurredArtworkUrl || (!themeObj.isFallback ? activeCoverUrl : '');
    const effectiveNpArtwork =
      themeObj.nowPlayingArtworkUrl || (!themeObj.isFallback ? activeCoverUrl : '');

    return (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          opacity: isOutgoingLayer ? (isCrossfadingBg ? 1 : 0) : 1,
          transition:
            isOutgoingLayer && !shouldSnapResume && policy.backgroundCrossfadeMs > 0
              ? `opacity ${policy.backgroundCrossfadeMs}ms ease`
              : 'none',
          zIndex: isOutgoingLayer ? 1 : 0,
        }}
      >
        {/* LAYER A: Authentic DoReMi Editorial Dual-Tone Diagonal Canvas (Standard Now Playing) */}
        <div
          data-testid={isOutgoingLayer ? undefined : 'now-playing-diagonal-backdrop'}
          className="absolute inset-0 overflow-hidden"
          style={{
            opacity: isFocusMode ? 0 : 1,
            transition: modeFadeStyle,
          }}
        >
          {/* Left Zone Rich Artwork Shadow Mood (un-dulled) */}
          <div
            data-testid={isOutgoingLayer ? undefined : 'now-playing-dark-tone'}
            className="absolute inset-0"
            style={{ background: themeObj.darkSurfaceGradient }}
          />

          {/* Right Diagonal Clipped Zone: Vivid Direct-Source Artwork + Subtle Contrast Veil */}
          <div
            data-testid={isOutgoingLayer ? undefined : 'now-playing-light-tone'}
            className="absolute inset-0 overflow-hidden"
            style={{
              clipPath: diagPolygon,
              WebkitClipPath: diagPolygon,
              background: themeObj.lightSurfaceGradient,
            }}
          >
            {policy.artworkBlurEnabled && effectiveNpArtwork && (
              <img
                src={effectiveNpArtwork}
                alt=""
                data-testid={isOutgoingLayer ? undefined : 'now-playing-right-artwork-bg'}
                className={`pointer-events-none absolute top-0 right-0 h-full w-[66%] object-cover object-center saturate-[1.04] ${
                  isLight ? 'opacity-[0.82]' : 'opacity-[0.86]'
                }`}
                style={{
                  transform: 'scale(1.03)',
                  maskImage:
                    'linear-gradient(90deg, rgba(0,0,0,0.08) 0%, rgba(0,0,0,0.78) 18%, black 42%, black 100%)',
                  WebkitMaskImage:
                    'linear-gradient(90deg, rgba(0,0,0,0.08) 0%, rgba(0,0,0,0.78) 18%, black 42%, black 100%)',
                }}
              />
            )}
            <div
              className="pointer-events-none absolute inset-0"
              style={{ background: themeObj.lightZoneOverlayCss }}
            />
          </div>

          {/* Luminous Artwork-Tinted Diagonal Divider Feather */}
          <div
            data-testid={isOutgoingLayer ? undefined : 'now-playing-diagonal-divider'}
            className="pointer-events-none absolute inset-0"
            style={{
              clipPath: diagEdgeBand,
              WebkitClipPath: diagEdgeBand,
              background: themeObj.diagonalGlowCss,
            }}
          />
        </div>

        {/* LAYER B: Simplified Cover-Fill Blurred Artwork Focus Backdrop (`Phase 4.4B`) */}
        <div
          data-testid={isOutgoingLayer ? undefined : 'focus-ambient-backdrop'}
          className="absolute inset-0 overflow-hidden"
          style={{
            opacity: isFocusMode ? 1 : 0,
            transition: modeFadeStyle,
            backgroundColor: themeObj.focusBaseColor,
          }}
        >
          {/* Full-bleed blurred artwork fill right to viewport edges: eliminates right boundary seam cleanly */}
          {policy.diffuseBackdropEnabled && effectiveFocusArtwork ? (
            <img
              src={effectiveFocusArtwork}
              alt=""
              data-testid={isOutgoingLayer ? undefined : 'focus-artwork-ambient-wash'}
              className={`pointer-events-none absolute inset-0 h-full w-full object-cover saturate-[1.06] ${
                isLight ? 'opacity-[0.84]' : 'opacity-[0.90]'
              }`}
              style={{
                objectPosition: '58% 50%',
                transform: 'scale(1.06)',
              }}
            />
          ) : (
            policy.diffuseBackdropEnabled && (
              <div
                className="pointer-events-none absolute inset-0"
                style={{ background: themeObj.focusDiffusionGradient }}
              />
            )
          )}

          {/* Soft Readability Protection Scrim (preserves natural cover saturation & >= 7:1 text contrast) */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{ background: themeObj.focusContrastScrimCss }}
          />
        </div>
      </div>
    );
  };

  if (!localTrack) {
    return (
      <div
        data-testid="now-playing-empty-screen"
        className="relative flex h-full w-full flex-col items-center justify-center px-6 text-center"
        style={{ backgroundColor: 'var(--np-bg)', color: 'var(--np-text-primary)' }}
      >
        <div className="lp-glass-panel max-w-md rounded-3xl p-8">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--surface-glass-light)] text-[var(--text-muted)]">
            <Disc3 className="h-8 w-8" />
          </div>
          <h1 className="font-display mt-5 text-2xl font-semibold">Chưa phát bài hát nào</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
            Hãy mở Thư viện hoặc Playlist để chọn một bản thu lossless cục bộ trên máy tính.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2.5">
            <button
              type="button"
              onClick={() => uiStore.openLibraryTab('songs')}
              style={{
                backgroundColor: userAccentPalette.dominant,
                color: '#FFFFFF',
              }}
              className="rounded-full px-5 py-2.5 text-[13px] font-semibold shadow-lg transition hover:brightness-110"
            >
              Mở Thư viện nhạc
            </button>
            <button
              type="button"
              onClick={() => uiStore.closeNowPlaying()}
              className="lp-btn-ghost rounded-full px-5 py-2.5 text-[13px] font-medium"
            >
              Quay lại
            </button>
          </div>
        </div>
      </div>
    );
  }

  const transitionTimingCss =
    policy.modeTransitionMs > 0
      ? `${policy.modeTransitionMs}ms cubic-bezier(0.22, 1, 0.36, 1)`
      : '0ms linear';

  const leftZoneScopedVars = {
    '--text-primary': adaptiveTheme.darkZoneTextPrimary,
    '--text-secondary': adaptiveTheme.darkZoneTextSecondary,
    '--text-muted': adaptiveTheme.darkZoneTextMuted,
    '--np-divider': adaptiveTheme.darkZoneDivider,
    '--border-subtle': adaptiveTheme.darkZoneDivider,
    '--border-glass': 'rgba(255, 255, 255, 0.16)',
    '--surface-hover': 'rgba(255, 255, 255, 0.1)',
    '--surface-glass-light': 'rgba(255, 255, 255, 0.055)',
    '--bg-elevated': adaptiveTheme.darkToneHex,
    color: adaptiveTheme.darkZoneTextPrimary,
  } as CSSProperties;

  const rightZoneScopedVars = {
    '--np-bg': adaptiveTheme.lightToneHex,
    '--np-text-primary': adaptiveTheme.lightZoneTextPrimary,
    '--np-text-secondary': adaptiveTheme.lightZoneTextSecondary,
    '--np-text-muted': adaptiveTheme.lightZoneTextMuted,
    '--np-btn-primary-bg': adaptiveTheme.lightZonePrimaryBtnBg,
    '--np-btn-primary-fg': adaptiveTheme.lightZonePrimaryBtnFg,
    '--np-btn-ghost-bg': adaptiveTheme.lightZoneGhostBtnBg,
    '--np-btn-ghost-fg': adaptiveTheme.lightZoneGhostBtnFg,
    '--np-btn-ghost-border': adaptiveTheme.lightZoneGhostBtnBorder,
    '--text-primary': adaptiveTheme.lightZoneTextPrimary,
    '--text-secondary': adaptiveTheme.lightZoneTextSecondary,
    '--text-muted': adaptiveTheme.lightZoneTextMuted,
    '--bg-deep': adaptiveTheme.lightToneHex,
    '--np-divider': adaptiveTheme.lightZoneDivider,
    '--border-subtle': adaptiveTheme.lightZoneDivider,
    '--border-glass': 'rgba(20, 22, 29, 0.22)',
    '--surface-hover': 'rgba(20, 22, 29, 0.09)',
    '--surface-glass-light': 'rgba(20, 22, 29, 0.075)',
    '--surface-glass-strong': 'rgba(255, 255, 255, 0.90)',
    color: adaptiveTheme.lightZoneTextPrimary,
  } as CSSProperties;

  const standardBarScopedVars = {
    '--np-surface-bar': adaptiveTheme.standardBarSurfaceCss,
    '--np-divider': adaptiveTheme.standardBarBorderCss,
    '--np-text-primary': adaptiveTheme.standardBarTextPrimary,
    '--np-text-secondary': adaptiveTheme.standardBarTextSecondary,
    '--np-text-muted': adaptiveTheme.standardBarTextMuted,
    '--text-primary': adaptiveTheme.standardBarTextPrimary,
    '--text-secondary': adaptiveTheme.standardBarTextSecondary,
    '--text-muted': adaptiveTheme.standardBarTextMuted,
    '--np-bg': isLight ? adaptiveTheme.lightToneHex : adaptiveTheme.darkToneHex,
    '--np-ring-track': isLight ? 'rgba(20, 22, 29, 0.16)' : 'rgba(255, 255, 255, 0.18)',
    '--volume-track-empty': isLight ? 'rgba(20, 22, 29, 0.18)' : 'rgba(255, 255, 255, 0.18)',
    '--surface-hover': isLight ? 'rgba(20, 22, 29, 0.08)' : 'rgba(255, 255, 255, 0.11)',
    '--surface-glass-strong': isLight ? 'rgba(255, 255, 255, 0.95)' : 'rgba(20, 22, 30, 0.95)',
    '--bg-elevated': isLight ? '#FFFFFF' : '#161822',
    '--border-glass': isLight ? 'rgba(18, 20, 27, 0.16)' : 'rgba(255, 255, 255, 0.16)',
    '--border-subtle': adaptiveTheme.standardBarBorderCss,
    color: adaptiveTheme.standardBarTextPrimary,
  } as CSSProperties;

  const focusReturnButtonBg = isLight
    ? 'rgba(16, 18, 25, 0.085)'
    : 'rgba(255, 255, 255, 0.12)';
  const focusReturnButtonBorder = isLight
    ? 'rgba(16, 18, 25, 0.20)'
    : 'rgba(255, 255, 255, 0.24)';

  const activeSurfaceAccentHex = isFocusMode
    ? adaptiveTheme.focusAccentHex
    : adaptiveTheme.lightZoneAccentHex;
  const activeBarAccentHex = isLight
    ? adaptiveTheme.lightZoneAccentHex
    : adaptiveTheme.darkZoneAccentHex;

  return (
    <div
      data-testid="now-playing-screen"
      data-mode={ui.nowPlayingMode}
      data-dynamic-glow={palette.glowRgb}
      data-adaptive-fallback={adaptiveTheme.isFallback ? 'true' : 'false'}
      data-has-blurred-artwork={adaptiveTheme.blurredArtworkUrl ? 'true' : 'false'}
      data-actual-disc-diameter={String(placement.actualDiscDiameterPx)}
      data-disc-vh-ratio={placement.discToViewportHeightRatio.toFixed(3)}
      data-label-visible-fraction={placement.visibleLabelAreaFraction.toFixed(3)}
      data-contrast-left={adaptiveTheme.darkZoneContrastRatio.toFixed(2)}
      data-contrast-right={adaptiveTheme.lightZoneContrastRatio.toFixed(2)}
      className="lp-resume-snap-target relative flex h-full w-full flex-col overflow-hidden"
      style={
        {
          backgroundColor: adaptiveTheme.darkToneHex,
          '--accent-primary': activeSurfaceAccentHex,
          '--accent-glow-rgb': palette.glowRgb,
          '--accent-secondary-rgb': palette.secondaryGlowRgb,
        } as CSSProperties
      }
    >
      {/* Hidden offline file inputs for Web Preview mode */}
      <input
        ref={coverFileInputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
        onChange={handleWebCoverFileSelected}
        data-testid="custom-cover-file-input"
        className="hidden"
      />
      <input
        ref={lyricsFileInputRef}
        type="file"
        accept=".lrc,.txt,text/plain"
        onChange={handleWebLyricsFileSelected}
        data-testid="custom-lyrics-file-input"
        className="hidden"
      />

      {/* Shared Dual-Tone + Focus Ambient Artwork Backdrops */}
      {renderBackgroundSet(adaptiveTheme, false)}
      {previousTheme && renderBackgroundSet(previousTheme, true)}

      {/* =================================================================== */}
      {/* SINGLE PERSISTENT VINYL TURNTABLE STAGE (Shared Bidirectional Hero) */}
      {/* Scaled & translated via GPU transform so rotor spin NEVER resets!   */}
      {/* =================================================================== */}
      <div
        data-testid="vinyl-shared-transform-stage"
        className="pointer-events-none fixed inset-0 overflow-hidden"
        style={{ zIndex: 20 }}
      >
        <div
          data-testid="vinyl-shared-wrapper"
          className="pointer-events-auto absolute top-0 left-0"
          style={{
            transformOrigin: '0 0',
            transform: `translate3d(${vinylWrapperX}px, ${vinylWrapperY}px, 0) scale(${placement.scale})`,
            transition:
              !shouldSnapResume && policy.modeTransitionMs > 0
                ? `transform ${transitionTimingCss}`
                : 'none',
            willChange: policy.modeTransitionMs > 0 ? 'transform' : 'auto',
          }}
        >
          <LiveVinylTurntable
            hasTrack={Boolean(localTrack)}
            coverUrl={displayedCoverUrl}
            albumTitle={displayedAlbumTitle}
            accentColor={activeSurfaceAccentHex}
            glowRgb={palette.glowRgb}
            isPlaying={isActuallyPlaying}
            sizePx={placement.baseSizePx}
            stageScale={placement.scale}
            focusArcRadiusPx={placement.focusArcRadiusPx}
            focusArcViewportCenter={{ x: placement.centerX, y: placement.centerY }}
            viewportHeight={viewport.height}
            progressTransitionMs={policy.modeTransitionMs}
            suppressResumeTransitions={shouldSnapResume}
            progressPresentation={isFocusMode ? 'arc' : 'circle'}
            seekResetKey={`${activeTrackId}:${ui.nowPlayingMode}`}
            themeMode={ui.preferences.themeMode}
            qualityPreset={ui.preferences.uiQualityPreset}
            swapPhase={swapSnapshot.phase}
            vinylAnimationEnabled={policy.vinylSpinAllowed}
            reducedMotion={policy.reducedMotionEffective}
            showProgressRing
            durationSec={activeDurationSec}
            onSeek={handleVinylSeek}
          />
        </div>
      </div>

      {/* =================================================================== */}
      {/* TOP NAVIGATION HEADER (Adaptive Contrast + Overlay Sidebar Offset)  */}
      {/* =================================================================== */}
      <header className="pointer-events-none relative z-30 flex h-[44px] shrink-0 items-center justify-between px-5 pt-1">
        <button
          type="button"
          onClick={() => uiStore.closeNowPlaying()}
          title="Trở về màn hình trước"
          aria-label="Quay lại"
          style={{
            color: isFocusMode
              ? adaptiveTheme.focusTextSecondary
              : adaptiveTheme.darkZoneTextSecondary,
            transform: ui.nowPlayingSidebarRevealed
              ? 'translate3d(76px, 0, 0)'
              : 'translate3d(0, 0, 0)',
            transition:
              !shouldSnapResume && policy.sidebarTransitionMs > 0
                ? `transform ${policy.sidebarTransitionMs}ms cubic-bezier(0.22, 1, 0.36, 1)`
                : 'none',
          }}
          className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium transition hover:bg-white/10"
        >
          <ChevronDown className="h-4 w-4" />
          <span>Quay lại</span>
        </button>

        <div className="pointer-events-auto relative flex items-center gap-1.5">
          {isFocusMode ? (
            <>
              <button
                key="hdr-focus-fav"
                type="button"
                onClick={() => uiStore.toggleFavorite(activeTrackId)}
                title={isFavorite ? 'Bỏ yêu thích' : 'Yêu thích bài hát'}
                aria-label={isFavorite ? 'Bỏ yêu thích' : 'Yêu thích'}
                style={{ color: adaptiveTheme.focusTextSecondary }}
                className="flex h-8 w-8 items-center justify-center rounded-full transition hover:bg-black/10 dark:hover:bg-white/10"
              >
                <Heart
                  className="h-4 w-4"
                  style={
                    isFavorite ? { color: palette.dominant, fill: palette.dominant } : undefined
                  }
                />
              </button>
              <button
                key="hdr-exit-focus"
                type="button"
                data-testid="btn-exit-focus-mode"
                onClick={() => uiStore.setNowPlayingMode('standard')}
                title="Thoát Focus Vinyl (Esc)"
                aria-label="Thoát chế độ Tập trung Vinyl"
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--border-glass)] bg-[var(--surface-glass-strong)] px-3.5 text-[12px] font-medium text-[var(--text-primary)] shadow-sm backdrop-blur-md transition hover:bg-[var(--surface-hover)]"
              >
                <Minimize2 className="h-3.5 w-3.5" />
                <span>Thoát Focus</span>
              </button>
            </>
          ) : (
            <>
              {!placement.hasThreeZoneDesktop && (
                <button
                  key="hdr-std-queue"
                  type="button"
                  data-testid="btn-compact-queue-toggle"
                  onClick={() =>
                    uiStore.setNowPlayingRightTab(
                      rightTabSafe === 'queue' ? 'lyrics' : 'queue',
                    )
                  }
                  title="Mở hàng đợi phát nhạc"
                  style={{
                    color: adaptiveTheme.lightZoneTextPrimary,
                    backgroundColor:
                      rightTabSafe === 'queue'
                        ? 'rgba(20, 22, 29, 0.12)'
                        : 'rgba(20, 22, 29, 0.05)',
                  }}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition hover:brightness-95"
                >
                  <ListMusic className="h-3.5 w-3.5" />
                  <span>Hàng đợi</span>
                </button>
              )}

              <button
                key="hdr-enter-focus"
                type="button"
                onClick={() => uiStore.setNowPlayingMode('focus')}
                data-testid="btn-header-focus-mode"
                title="Chế độ Tập trung Vinyl (Focus Vinyl Mode)"
                aria-label="Bật chế độ Tập trung Vinyl"
                style={{ color: adaptiveTheme.lightZoneTextPrimary }}
                className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition hover:bg-black/10"
              >
                <Maximize2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Focus Vinyl</span>
              </button>

              <button
                key="hdr-std-more"
                ref={moreBtnRef}
                type="button"
                onClick={() => setIsMoreOpen((prev) => !prev)}
                title="Tùy chọn bài hát, ảnh bìa và lời"
                aria-label="Tùy chọn khác"
                aria-expanded={isMoreOpen}
                style={{ color: adaptiveTheme.lightZoneTextPrimary }}
                className="flex h-8 w-8 items-center justify-center rounded-full transition hover:bg-black/10"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>

              <AnchoredPopover
                open={isMoreOpen}
                anchorRef={moreBtnRef}
                onClose={() => setIsMoreOpen(false)}
                placement="bottom"
                align="end"
                role="menu"
                ariaLabel="Tùy chọn bài hát"
                className="lp-glass-pill w-60 rounded-2xl p-1.5 text-[13px] text-[var(--text-primary)]"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleImportCustomCover()}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
                >
                  <ImagePlus className="h-4 w-4 text-[var(--text-secondary)]" />
                  <span>
                    {hasCustomArtwork ? 'Thay ảnh bìa tùy chỉnh' : 'Đổi ảnh bìa bài hát'}
                  </span>
                </button>
                {hasCustomArtwork && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleRemoveCustomCover()}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-amber-600 transition hover:bg-[var(--surface-hover)] dark:text-amber-300"
                  >
                    <RotateCcw className="h-4 w-4" />
                    <span>Khôi phục ảnh bìa gốc</span>
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsMoreOpen(false);
                    setIsMetadataModalOpen(true);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
                >
                  <Pencil className="h-4 w-4 text-[var(--text-secondary)]" />
                  <span>Chỉnh sửa thông tin bài hát</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleImportLyricsFile()}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
                >
                  <Upload className="h-4 w-4 text-[var(--text-secondary)]" />
                  <span>Nhập file lời (.lrc / .txt)</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={openLyricsEditorModal}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
                >
                  <Plus className="h-4 w-4 text-[var(--text-secondary)]" />
                  <span>
                    {resolvedLyrics.format !== 'none'
                      ? 'Chỉnh sửa lời bài hát'
                      : 'Thêm lời bài hát'}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsMoreOpen(false);
                    const matched = uiStore
                      .getUnifiedTracks()
                      .find((t) => t.id === localTrack.id);
                    if (matched) {
                      uiStore.openAlbumDetail(matched.albumId);
                    }
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
                >
                  <Disc3 className="h-4 w-4 text-[var(--text-secondary)]" />
                  <span>Xem Album</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsMoreOpen(false);
                    uiStore.openArtistDetail(activeArtist);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
                >
                  <User className="h-4 w-4 text-[var(--text-secondary)]" />
                  <span>Xem Nghệ sĩ</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsMoreOpen(false);
                    uiStore.closeNowPlaying();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                >
                  <ArrowLeft className="h-4 w-4" />
                  <span>Trở về màn hình trước</span>
                </button>
              </AnchoredPopover>
            </>
          )}
        </div>
      </header>

      {/* =================================================================== */}
      {/* THREE-ZONE NOW PLAYING STAGE (Standard Mode — Reference B)          */}
      {/* =================================================================== */}
      <div
        data-testid="now-playing-standard-layout"
        aria-hidden={isFocusMode}
        className="pointer-events-none relative flex min-h-0 flex-1 items-stretch overflow-hidden"
        style={{
          zIndex: 25,
          opacity: isFocusMode ? 0 : 1,
          transition:
            !shouldSnapResume && policy.modeTransitionMs > 0
              ? `opacity ${Math.round(policy.modeTransitionMs * 0.72)}ms ease`
              : 'none',
        }}
      >
        {/* LEFT ZONE (~26.5% on desktop): Dedicated Artwork-Tinted Editorial Playback Queue */}
        {placement.hasThreeZoneDesktop && (
          <aside
            data-testid="now-playing-left-zone"
            aria-label="Hàng đợi phát nhạc"
            style={{
              ...leftZoneScopedVars,
              pointerEvents: isFocusMode ? 'none' : 'auto',
              width: `${placement.standardZones.leftQueueWidth}px`,
              transform: isFocusMode ? 'translate3d(-24px, 0, 0)' : 'translate3d(0, 0, 0)',
              transition:
                !shouldSnapResume && policy.modeTransitionMs > 0
                  ? `transform ${transitionTimingCss}`
                  : 'none',
            }}
            className="flex min-h-0 shrink-0 flex-col px-5 pt-2 pb-3"
          >
            <div className="mb-1 flex items-center justify-between border-b border-[var(--np-divider)] pb-2">
              <div className="flex items-center gap-2">
                <ListMusic className="h-4 w-4" style={{ color: adaptiveTheme.darkZoneAccentHex }} />
                <h2 className="text-[12px] font-semibold tracking-[0.14em] text-[var(--text-secondary)] uppercase">
                  Hàng đợi phát
                </h2>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              <PlaybackQueuePanel
                accentColor={adaptiveTheme.darkZoneAccentHex}
                isVisible={!isFocusMode && placement.hasThreeZoneDesktop}
                variant="tab"
              />
            </div>
          </aside>
        )}

        {/* CENTER SPACER ZONE (~40%): Reserved visually for the shared center Vinyl */}
        <div
          aria-hidden="true"
          className="pointer-events-none min-h-0 flex-1"
        />

        {/* RIGHT ZONE (~34.5% on desktop): Translucent Artwork-Backed Info & Lyrics */}
        <aside
          data-testid="now-playing-right-zone"
          aria-label="Thông tin bài hát và lời bài hát"
          style={{
            ...rightZoneScopedVars,
            pointerEvents: isFocusMode ? 'none' : 'auto',
            width: `${placement.standardZones.rightInfoWidth}px`,
            transform: isFocusMode ? 'translate3d(24px, 0, 0)' : 'translate3d(0, 0, 0)',
            transition:
              !shouldSnapResume && policy.modeTransitionMs > 0
                ? `transform ${transitionTimingCss}`
                : 'none',
          }}
          className="flex min-h-0 shrink-0 flex-col overflow-hidden px-6 pt-1 pb-2 lg:px-7 xl:px-9"
        >
          {/* Editorial Track Header (Clean Vietnamese Display Typography, Original Casing) */}
          <div className="shrink-0">
            <h1
              data-testid="now-playing-hero-title"
              title={activeTitle}
              className="font-display line-clamp-2 font-semibold tracking-[-0.02em] text-[var(--np-text-primary)]"
              style={{
                fontSize: 'clamp(26px, 2.35vw, 40px)',
                lineHeight: 1.16,
              }}
            >
              {activeTitle}
            </h1>

            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                data-testid="now-playing-hero-artist"
                title={activeArtist}
                onClick={() => uiStore.openArtistDetail(activeArtist)}
                className="max-w-full truncate text-left text-[15.5px] font-medium text-[var(--np-text-secondary)] underline-offset-4 transition hover:text-[var(--np-text-primary)] hover:underline"
              >
                {activeArtist}
              </button>

              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => uiStore.toggleFavorite(activeTrackId)}
                  title={isFavorite ? 'Bỏ yêu thích' : 'Yêu thích bài hát'}
                  aria-label={isFavorite ? 'Bỏ yêu thích' : 'Yêu thích'}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--np-text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]"
                >
                  <Heart
                    className="h-3.5 w-3.5"
                    style={
                      isFavorite
                        ? {
                            color: adaptiveTheme.lightZoneAccentHex,
                            fill: adaptiveTheme.lightZoneAccentHex,
                          }
                        : undefined
                    }
                  />
                </button>
                <button
                  type="button"
                  onClick={() => setIsMetadataModalOpen(true)}
                  title="Chỉnh sửa thông tin và ảnh bìa"
                  aria-label="Chỉnh sửa thông tin bài hát"
                  className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--np-text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div
              data-testid="now-playing-hero-meta"
              title={`${activeAlbumTitle}${activeYear !== null ? ` · ${activeYear}` : ''}${activeTechSummary ? ` · ${activeTechSummary}` : ''}`}
              className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] text-[var(--np-text-muted)]"
            >
              <span className="truncate font-medium text-[var(--np-text-secondary)]">
                {activeAlbumTitle}
                {activeYear !== null ? ` · ${activeYear}` : ''}
              </span>
              {activeTechSummary && (
                <span
                  className="font-mono-tabular inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-[10.5px] font-medium tracking-tight"
                  style={{
                    borderColor: 'var(--np-divider)',
                    backgroundColor: 'var(--surface-glass-light)',
                    color: 'var(--np-text-secondary)',
                  }}
                >
                  {activeTechSummary}
                </span>
              )}
            </div>
          </div>

          {/* Minimal Tab Bar (Lyrics | Info, plus Queue fallback ONLY when screen < 1120px) */}
          <div className="mt-4 flex shrink-0 items-center justify-between gap-3 border-b border-[var(--np-divider)]">
            <div
              role="tablist"
              aria-label="Chuyển đổi Lời bài hát và Thông tin bản thu"
              className="flex items-center gap-5"
            >
              {(
                [
                  { id: 'lyrics', label: 'Lời bài hát' },
                  { id: 'info', label: 'Chi tiết bản thu' },
                  ...(!placement.hasThreeZoneDesktop
                    ? ([{ id: 'queue', label: 'Hàng đợi' }] as const)
                    : []),
                ] as const
              ).map((tab) => {
                const active = rightTabSafe === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    data-testid={`now-playing-tab-${tab.id}`}
                    aria-selected={active}
                    onClick={() => uiStore.setNowPlayingRightTab(tab.id)}
                    className={`relative pb-2 text-[13px] transition focus-visible:outline-none ${
                      active
                        ? 'font-semibold text-[var(--np-text-primary)]'
                        : 'font-medium text-[var(--np-text-muted)] hover:text-[var(--np-text-primary)]'
                    }`}
                  >
                    <span>{tab.label}</span>
                    {active && (
                      <span
                        aria-hidden="true"
                        className="absolute inset-x-0 bottom-[-1px] h-[2px] rounded-full"
                        style={{ backgroundColor: adaptiveTheme.lightZoneAccentHex }}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {rightTabSafe === 'lyrics' && (
              <div className="flex items-center gap-1 pb-1.5">
                <button
                  type="button"
                  data-testid="btn-import-lyrics"
                  onClick={() => void handleImportLyricsFile()}
                  title="Nhập file lời (.lrc hoặc .txt)"
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-[var(--np-text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]"
                >
                  <Upload className="h-3 w-3" />
                  <span>Import</span>
                </button>
                <button
                  type="button"
                  data-testid="btn-edit-lyrics"
                  onClick={openLyricsEditorModal}
                  title="Chỉnh sửa lời bài hát"
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-[var(--np-text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]"
                >
                  <Pencil className="h-3 w-3" />
                  <span>Sửa</span>
                </button>
                {resolvedLyrics.hasCustomLyrics && (
                  <button
                    type="button"
                    data-testid="btn-restore-lyrics"
                    onClick={() => void handleRemoveCustomLyrics()}
                    title="Khôi phục lời tự động"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-amber-700 transition hover:bg-amber-500/15"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>

          {rightTabSafe === 'queue' && !placement.hasThreeZoneDesktop ? (
            <div data-testid="now-playing-queue-panel" className="flex min-h-0 flex-1 flex-col">
              <PlaybackQueuePanel
                accentColor={adaptiveTheme.lightZoneAccentHex}
                isVisible={!isFocusMode && rightTabSafe === 'queue'}
                variant="tab"
              />
            </div>
          ) : rightTabSafe === 'info' ? (
            <div
              data-testid="now-playing-info-panel"
              className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-4 pr-2"
            >
              <div className="flex items-start gap-4">
                <div className="relative h-[96px] w-[96px] shrink-0 overflow-hidden rounded-xl border border-[var(--np-divider)] bg-black/10">
                  <img
                    src={activeCoverUrl}
                    alt={activeTitle}
                    data-testid="info-panel-artwork"
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

                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <p
                    data-testid="info-artwork-source"
                    className="text-[11.5px] font-medium text-[var(--np-text-muted)]"
                  >
                    {formatArtworkSourceLabel(artworkSource)}
                  </p>

                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      data-testid="btn-import-custom-cover"
                      onClick={() => void handleImportCustomCover()}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--np-divider)] bg-[var(--surface-glass-light)] px-3 text-[12px] font-medium text-[var(--np-text-primary)] transition hover:bg-[var(--surface-hover)]"
                    >
                      <ImagePlus className="h-3.5 w-3.5" />
                      <span>{hasCustomArtwork ? 'Thay ảnh bìa' : 'Đổi ảnh bìa'}</span>
                    </button>

                    <button
                      type="button"
                      data-testid="btn-edit-metadata"
                      onClick={() => setIsMetadataModalOpen(true)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--np-divider)] bg-[var(--surface-glass-light)] px-3 text-[12px] font-medium text-[var(--np-text-primary)] transition hover:bg-[var(--surface-hover)]"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      <span>Sửa thông tin</span>
                    </button>

                    {hasCustomArtwork && (
                      <button
                        type="button"
                        data-testid="btn-remove-custom-cover"
                        onClick={() => void handleRemoveCustomCover()}
                        style={{
                          backgroundColor: 'rgba(180, 83, 9, 0.14)',
                          borderColor: 'rgba(180, 83, 9, 0.36)',
                          color: '#78350F',
                        }}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-semibold transition hover:brightness-95"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span>Khôi phục ảnh gốc</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <dl className="mt-4 divide-y divide-[var(--np-divider)] border-t border-[var(--np-divider)] text-[12.5px]">
                <div className="flex items-baseline justify-between gap-4 py-2">
                  <dt className="shrink-0 text-[var(--np-text-muted)]">Bài hát</dt>
                  <dd
                    data-testid="info-track-title"
                    title={activeTitle}
                    className="truncate text-right font-medium text-[var(--np-text-primary)]"
                  >
                    {activeTitle}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 py-2">
                  <dt className="shrink-0 text-[var(--np-text-muted)]">Nghệ sĩ</dt>
                  <dd
                    data-testid="info-track-artist"
                    title={activeArtist}
                    className="truncate text-right font-medium text-[var(--np-text-primary)]"
                  >
                    {activeArtist}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 py-2">
                  <dt className="shrink-0 text-[var(--np-text-muted)]">Album</dt>
                  <dd
                    data-testid="info-track-album"
                    title={activeAlbumTitle}
                    className="truncate text-right font-medium text-[var(--np-text-primary)]"
                  >
                    {activeAlbumTitle}
                  </dd>
                </div>
                {activeYear !== null && (
                  <div className="flex items-baseline justify-between gap-4 py-2">
                    <dt className="shrink-0 text-[var(--np-text-muted)]">Năm phát hành</dt>
                    <dd
                      data-testid="info-track-year"
                      className="font-mono-tabular text-right font-medium text-[var(--np-text-primary)]"
                    >
                      {activeYear}
                    </dd>
                  </div>
                )}
                <div className="flex items-baseline justify-between gap-4 py-2">
                  <dt className="shrink-0 text-[var(--np-text-muted)]">Thời lượng</dt>
                  <dd className="font-mono-tabular text-right font-medium text-[var(--np-text-primary)]">
                    {formatDurationSeconds(activeDurationSec)}
                  </dd>
                </div>
                {techSpecItems.map((spec) => (
                  <div key={spec.label} className="flex items-baseline justify-between gap-4 py-2">
                    <dt className="shrink-0 text-[var(--np-text-muted)]">{spec.label}</dt>
                    <dd className="font-mono-tabular truncate text-right font-medium text-[var(--np-text-primary)]">
                      {spec.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : (
            <NowPlayingLyricsPanel
              sourceLabel={lyricsSourceLabel}
              isLoadingLyrics={isLoadingLyrics}
              isLrcLyrics={isLrcLyrics}
              isTxtLyrics={isTxtLyrics}
              lyricGroups={lyricGroups}
              effectiveActiveLyricIdx={effectiveActiveLyricIdx}
              resolvedLyrics={resolvedLyrics}
              isManualScrolling={isManualScrolling}
              accentHex={adaptiveTheme.lightZoneAccentHex}
              lyricsContainerRef={lyricsContainerRef}
              activeLineRef={activeLineRef}
              onManualScroll={handleManualLyricsScroll}
              onSeekToLine={handleSeekToLyricLine}
              onResyncLyrics={snapBackToLyrics}
              onOpenLyricsEditor={openLyricsEditorModal}
              onImportLyricsFile={handleImportLyricsClick}
            />
          )}
        </aside>
      </div>

      {/* =================================================================== */}
      {/* FOCUS VINYL 3-GROUP RADIAL MINIMALIST SHOWCASE                      */}
      {/* Group A (Track Identity), Group B (Playback Controls), Group C (5-9L)*/}
      {/* =================================================================== */}
      <section
        data-testid="now-playing-focus-showcase"
        aria-label="Chế độ Tập trung Vinyl"
        aria-hidden={!isFocusMode}
        className="pointer-events-none fixed inset-0 overflow-hidden"
        style={
          {
            zIndex: 25,
            '--np-focus-primary': adaptiveTheme.focusTextPrimary,
            '--np-focus-muted': adaptiveTheme.focusTextMuted,
            opacity: isFocusMode ? 1 : 0,
            transition:
              !shouldSnapResume && policy.modeTransitionMs > 0
                ? `opacity ${Math.round(policy.modeTransitionMs * 0.88)}ms cubic-bezier(0.22, 1, 0.36, 1)`
                : 'none',
          } as CSSProperties
        }
      >
        {/* GROUP A: Track Identity (Title + Artist closely bonded along continuous radial arc) */}
        <div
          data-testid="focus-group-track-identity"
          style={{
            position: 'fixed',
            left: `${focusRadial.groupATrackIdentity.leftPx}px`,
            top: `${focusRadial.groupATrackIdentity.topPx}px`,
            width: `${focusRadial.groupATrackIdentity.maxWidthPx}px`,
            pointerEvents: isFocusMode ? 'auto' : 'none',
            transform: isFocusMode ? 'translate3d(0, 0, 0)' : 'translate3d(44px, 0, 0)',
            transition:
              !shouldSnapResume && policy.modeTransitionMs > 0
                ? `transform ${transitionTimingCss}`
                : 'none',
          }}
        >
          <h1
            ref={focusTitleRef}
            data-testid="focus-track-title"
            title={activeTitle}
            className="font-display line-clamp-2 font-semibold tracking-[-0.026em]"
            style={{
              fontSize: 'clamp(52px, 4.4vw, 84px)',
              lineHeight: 1.06,
              color: adaptiveTheme.focusTextPrimary,
            }}
          >
            {activeTitle}
          </h1>

          <div
            style={{
              marginTop: `${focusRadial.groupATrackIdentity.titleArtistGapPx}px`,
              marginLeft: `${focusRadial.groupATrackIdentity.artistRadialOffsetPx}px`,
            }}
          >
            <button
              type="button"
              data-testid="focus-track-artist"
              data-artist-offset-px={focusRadial.groupATrackIdentity.artistRadialOffsetPx}
              title={activeArtist}
              tabIndex={isFocusMode ? 0 : -1}
              onClick={() => uiStore.openArtistDetail(activeArtist)}
              className="max-w-full truncate text-left font-medium underline-offset-4 transition hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{
                fontSize: 'clamp(21px, 1.55vw, 28px)',
                lineHeight: 1.24,
                color: adaptiveTheme.focusTextSecondary,
              }}
            >
              {activeArtist}
            </button>
          </div>
        </div>

        {/* GROUP B: Playback Interaction (5 compact Sample 2 icons + 360–540px progress slider) */}
        <div
          data-testid="focus-group-playback-interaction"
          className="flex flex-col"
          style={{
            position: 'fixed',
            left: `${focusRadial.groupBPlaybackInteraction.leftPx}px`,
            top: `${focusRadial.groupBPlaybackInteraction.topPx}px`,
            width: `${focusRadial.groupBPlaybackInteraction.progressWidthPx}px`,
            pointerEvents: isFocusMode ? 'auto' : 'none',
            transform: isFocusMode ? 'translate3d(0, 0, 0)' : 'translate3d(52px, 0, 0)',
            transition:
              !shouldSnapResume && policy.modeTransitionMs > 0
                ? `transform ${transitionTimingCss}`
                : 'none',
          }}
        >
          <div
            data-testid="focus-transport-bar"
            className="flex items-center gap-1.5"
          >
            <ShuffleButton
              enabled={ui.shuffle}
              accentColor={adaptiveTheme.focusAccentHex}
              onToggle={() => uiStore.toggleShuffle()}
              size="sm"
              testId="focus-shuffle-btn"
              neutralClassName="text-[var(--np-focus-muted)] hover:bg-black/10 dark:hover:bg-white/10 hover:text-[var(--np-focus-primary)]"
            />

            <button
              type="button"
              onClick={() => uiStore.previousTrack()}
              title="Bài trước"
              aria-label="Bài trước"
              tabIndex={isFocusMode ? 0 : -1}
              data-testid="focus-prev-btn"
              style={{ color: adaptiveTheme.focusTextSecondary }}
              className="flex h-8 w-8 items-center justify-center rounded-full transition hover:bg-black/10 dark:hover:bg-white/10"
            >
              <SkipBack className="h-[15px] w-[15px]" />
            </button>

            <button
              type="button"
              data-testid="focus-play-pause-btn"
              tabIndex={isFocusMode ? 0 : -1}
              onClick={() => uiStore.togglePlayPause()}
              title={isActuallyPlaying ? 'Tạm dừng' : 'Phát nhạc'}
              aria-label={isActuallyPlaying ? 'Tạm dừng' : 'Phát nhạc'}
              style={{
                backgroundColor: adaptiveTheme.focusPrimaryBtnBg,
                color: adaptiveTheme.focusPrimaryBtnFg,
              }}
              className="mx-0.5 flex h-9 w-9 items-center justify-center rounded-full shadow-sm transition hover:scale-105 active:scale-95"
            >
              {isActuallyPlaying ? (
                <Pause className="h-4 w-4 fill-current" />
              ) : (
                <Play className="ml-0.5 h-4 w-4 fill-current" />
              )}
            </button>

            <button
              type="button"
              onClick={() => uiStore.nextTrack()}
              title="Bài tiếp theo"
              aria-label="Bài tiếp theo"
              tabIndex={isFocusMode ? 0 : -1}
              data-testid="focus-next-btn"
              style={{ color: adaptiveTheme.focusTextSecondary }}
              className="flex h-8 w-8 items-center justify-center rounded-full transition hover:bg-black/10 dark:hover:bg-white/10"
            >
              <SkipForward className="h-[15px] w-[15px]" />
            </button>

            <PlaybackOptionsPopover
              repeatMode={ui.repeat}
              autoNextEnabled={ui.autoNext}
              remainingReplays={playback.remainingReplays}
              hasActiveTrack={Boolean(localTrack)}
              accentColor={adaptiveTheme.focusAccentHex}
              onSelectRepeat={(mode) => uiStore.setRepeatMode(mode)}
              onToggleAutoNext={() => uiStore.toggleAutoNext()}
              size="sm"
              placement="bottom"
              testId="focus-options-btn"
              neutralClassName="text-[var(--np-focus-muted)] hover:bg-black/10 dark:hover:bg-white/10 hover:text-[var(--np-focus-primary)]"
            />
          </div>

          {/* Thin Synced Horizontal Progress Bar (Audible Scrubbing Preserved) */}
          <LiveNowPlayingProgressBar
            variant="focus"
            hasTrack={Boolean(localTrack)}
            durationSec={activeDurationSec}
            accentColor={adaptiveTheme.focusAccentHex}
            isLight={isLight}
            isFocusMode={isFocusMode}
            shouldSnapResume={shouldSnapResume}
            currentTimeTextColor={adaptiveTheme.focusTextSecondary}
            mutedTextColor={adaptiveTheme.focusTextMuted}
            marginTopPx={focusRadial.groupBPlaybackInteraction.controlsToProgressGapPx}
          />
        </div>

        {/* GROUP C: Interactive 7/9-Line Curved Lyrics (Hidden completely when absent/plain) */}
        {isLrcLyrics && (
          <div
            data-testid="focus-group-lyrics"
            style={{
              position: 'fixed',
              left: `${focusRadial.groupCLyrics.baseLeftPx}px`,
              top: `${focusRadial.groupCLyrics.topPx}px`,
              width: `${focusRadial.groupCLyrics.maxWidthPx}px`,
              pointerEvents: isFocusMode ? 'auto' : 'none',
              transform: isFocusMode ? 'translate3d(0, 0, 0)' : 'translate3d(38px, 0, 0)',
              transition:
                !shouldSnapResume && policy.modeTransitionMs > 0
                  ? `transform ${transitionTimingCss}`
                  : 'none',
            }}
          >
            <FocusMinimalLyrics
              lyricGroups={lyricGroups}
              activeGroupIndex={effectiveActiveLyricIdx}
              trackKey={activeTrackId}
              isFocusActive={isFocusMode}
              isWindowHidden={foregroundResume.isHidden}
              suppressResumeTransitions={shouldSnapResume}
              persistedBrowseState={ui.focusLyricsBrowse}
              onBrowseStateChange={handleFocusBrowseStateChange}
              focusRadial={focusRadial}
              accentColor={adaptiveTheme.focusAccentHex}
              textPrimary={adaptiveTheme.focusTextPrimary}
              textSecondary={adaptiveTheme.focusTextSecondary}
              textMuted={adaptiveTheme.focusTextMuted}
              buttonBg={focusReturnButtonBg}
              buttonFg={adaptiveTheme.focusTextPrimary}
              buttonBorder={focusReturnButtonBorder}
              transitionMs={policy.lyricsTransitionMs}
              onSeekToLine={handleSeekToLyricLine}
            />
          </div>
        )}
      </section>

      {/* Floating Playback Error Banner (Never shifts layout) */}
      {playbackError && (
        <div
          className={`pointer-events-auto fixed left-1/2 z-40 w-[min(92vw,480px)] -translate-x-1/2 ${
            isFocusMode ? 'bottom-6' : 'bottom-[80px]'
          }`}
        >
          <PlaybackErrorBanner
            errorMessage={playbackError}
            playbackError={playback.playbackError}
            onRetry={() => void playerActions.resume()}
            compact
          />
        </div>
      )}

      {/* =================================================================== */}
      {/* BOTTOM SAMPLE 2 TRANSPORT BAR (Standard Mode Only)                  */}
      {/* =================================================================== */}
      {!isFocusMode && (
        <footer
          data-testid="now-playing-bottom-bar"
          aria-label="Thanh điều khiển phát nhạc"
          className="relative z-30 flex h-[68px] shrink-0 items-center justify-between gap-4 border-t border-[var(--np-divider)] px-6 backdrop-blur-md"
          style={{
            ...standardBarScopedVars,
            background: 'var(--np-surface-bar)',
          }}
        >
          {/* Compact Left Strip: Miniature artwork + Title + Artist + Favorite */}
          <div className="flex w-[196px] min-w-0 shrink-0 items-center gap-2.5 xl:w-[224px]">
            <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-[var(--np-divider)] bg-black/15">
              <img
                src={activeThumbUrl}
                alt={activeTitle}
                data-testid="now-playing-bottom-artwork"
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
            <div className="min-w-0 flex-1">
              <p
                data-testid="now-playing-bottom-title"
                title={activeTitle}
                className="truncate text-[12.5px] font-medium text-[var(--np-text-primary)]"
              >
                {activeTitle}
              </p>
              <p
                data-testid="now-playing-bottom-artist"
                title={activeArtist}
                className="truncate text-[11px] text-[var(--np-text-muted)]"
              >
                {activeArtist}
              </p>
            </div>
            <button
              type="button"
              onClick={() => uiStore.toggleFavorite(activeTrackId)}
              title={isFavorite ? 'Bỏ yêu thích' : 'Yêu thích'}
              aria-label={isFavorite ? 'Bỏ yêu thích' : 'Yêu thích'}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--np-text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]"
            >
              <Heart
                className="h-3.5 w-3.5"
                style={
                  isFavorite ? { color: palette.dominant, fill: palette.dominant } : undefined
                }
              />
            </button>
          </div>

          {/* Vertically centered Transport Bar accents using contrast-safe bar tokens */}
          <div className="flex min-w-0 flex-1 max-w-[540px] flex-col items-center gap-1">
            <div className="flex items-center gap-1.5 sm:gap-2">
              <ShuffleButton
                enabled={ui.shuffle}
                accentColor={activeBarAccentHex}
                onToggle={() => uiStore.toggleShuffle()}
                size="sm"
                testId="now-playing-shuffle-btn"
                neutralClassName="text-[var(--np-text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]"
              />

              <button
                type="button"
                onClick={() => uiStore.previousTrack()}
                title="Bài trước"
                aria-label="Bài trước"
                data-testid="now-playing-prev-btn"
                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--np-text-primary)] transition hover:bg-[var(--surface-hover)]"
              >
                <SkipBack className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={() => uiStore.togglePlayPause()}
                title={isActuallyPlaying ? 'Tạm dừng' : 'Phát nhạc'}
                aria-label={isActuallyPlaying ? 'Tạm dừng' : 'Phát nhạc'}
                data-testid="now-playing-play-pause-btn"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--np-text-primary)] text-[var(--np-bg)] shadow-sm transition hover:scale-105 active:scale-95"
              >
                {isActuallyPlaying ? (
                  <Pause className="h-4 w-4 fill-current" />
                ) : (
                  <Play className="ml-0.5 h-4 w-4 fill-current" />
                )}
              </button>

              <button
                type="button"
                onClick={() => uiStore.nextTrack()}
                title="Bài tiếp theo"
                aria-label="Bài tiếp theo"
                data-testid="now-playing-next-btn"
                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--np-text-primary)] transition hover:bg-[var(--surface-hover)]"
              >
                <SkipForward className="h-4 w-4" />
              </button>

              <PlaybackOptionsPopover
                repeatMode={ui.repeat}
                autoNextEnabled={ui.autoNext}
                remainingReplays={playback.remainingReplays}
                hasActiveTrack={Boolean(localTrack)}
                accentColor={activeBarAccentHex}
                onSelectRepeat={(mode) => uiStore.setRepeatMode(mode)}
                onToggleAutoNext={() => uiStore.toggleAutoNext()}
                size="sm"
                placement="top"
                testId="now-playing-options-btn"
                neutralClassName="text-[var(--np-text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]"
              />
            </div>

            <LiveNowPlayingProgressBar
              variant="standard"
              hasTrack={Boolean(localTrack)}
              durationSec={activeDurationSec}
              accentColor={activeBarAccentHex}
              isLight={isLight}
              isFocusMode={isFocusMode}
              shouldSnapResume={shouldSnapResume}
            />
          </div>

          {/* Right Controls: Quick EQ + Fade + Volume + Focus Mode Button */}
          <div className="flex shrink-0 items-center justify-end gap-2.5">
            <QuickEqPopover accentHex={activeBarAccentHex} accentGlowRgb={palette.glowRgb} />
            <PlaybackTransitionControl
              accentHex={activeBarAccentHex}
              accentGlowRgb={palette.glowRgb}
            />

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => uiStore.toggleMute()}
                title={volumeVisual.isMuted ? 'Bật âm lượng' : 'Tắt tiếng'}
                aria-label={volumeVisual.isMuted ? 'Bật âm lượng' : 'Tắt tiếng'}
                className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--np-text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]"
              >
                {volumeVisual.isMuted ? (
                  <VolumeX className="h-4 w-4 text-[var(--np-text-muted)]" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
              </button>

              <div
                className="relative flex h-6 w-[82px] items-center"
                onMouseEnter={() => setIsVolumeHovered(true)}
                onMouseLeave={() => setIsVolumeHovered(false)}
              >
                {showVolumeTooltip && (
                  <div
                    role="tooltip"
                    className="font-mono-tabular pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded-md border border-[var(--border-glass)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10.5px] font-medium whitespace-nowrap text-[var(--text-primary)] shadow-lg"
                    style={{ left: volumeVisual.thumbCenterLeftCss }}
                  >
                    {volumeVisual.tooltipLabel}
                  </div>
                )}

                <div className="pointer-events-none h-[4px] w-full overflow-hidden rounded-full bg-[var(--volume-track-empty)]">
                  <div
                    data-testid="now-playing-volume-fill"
                    className="h-full rounded-full"
                    style={{
                      width: volumeVisual.fillWidthCss,
                      backgroundColor: activeBarAccentHex,
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
                  aria-label="Điều chỉnh âm lượng"
                  style={{ '--volume-accent-rgb': palette.glowRgb } as CSSProperties}
                  className="lp-volume-range absolute inset-0 h-full w-full"
                />
              </div>
            </div>

            <button
              type="button"
              data-testid="btn-toggle-focus-mode"
              onClick={() => uiStore.toggleNowPlayingFocusMode()}
              title="Chế độ Tập trung Vinyl (Focus Vinyl)"
              aria-label="Chế độ Tập trung Vinyl"
              className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--np-text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </footer>
      )}

      {/* Offline Add/Edit Lyrics Modal (rendered on top-most global modal portal) */}
      {isLyricsModalOpen && (
        <OverlayPortal layer="modal">
          <div className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Chỉnh sửa lời bài hát"
              data-testid="lyrics-editor-modal"
              className="lp-glass-pill w-full max-w-[560px] rounded-[24px] p-6"
            >
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-[18px] font-semibold text-[var(--text-primary)]">
                  Lời bài hát cục bộ
                </h2>
                <p className="text-[12px] text-[var(--text-muted)]">
                  {activeTitle} — {activeArtist}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsLyricsModalOpen(false)}
                aria-label="Đóng"
                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-3.5 flex items-center gap-2">
              <button
                type="button"
                data-testid="lyrics-format-lrc"
                onClick={() => setLyricsDraftFormat('lrc')}
                className={`rounded-full px-3.5 py-1.5 text-[12px] font-medium transition ${
                  lyricsDraftFormat === 'lrc'
                    ? 'bg-[var(--text-primary)] text-[var(--bg-deep)]'
                    : 'lp-btn-ghost'
                }`}
              >
                LRC đồng bộ thời gian
              </button>
              <button
                type="button"
                data-testid="lyrics-format-txt"
                onClick={() => setLyricsDraftFormat('txt')}
                className={`rounded-full px-3.5 py-1.5 text-[12px] font-medium transition ${
                  lyricsDraftFormat === 'txt'
                    ? 'bg-[var(--text-primary)] text-[var(--bg-deep)]'
                    : 'lp-btn-ghost'
                }`}
              >
                Văn bản tĩnh (TXT)
              </button>
            </div>

            <p className="mt-2.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
              {lyricsDraftFormat === 'lrc'
                ? 'Hỗ trợ [mm:ss.xx], nhiều dòng cùng timestamp (song ngữ Trung/Nhật/Hàn/Việt/Anh) và [offset:±ms].'
                : 'Văn bản tĩnh hiển thị nguyên văn xuống dòng, hỗ trợ đầy đủ Unicode CJK & tiếng Việt.'}
            </p>

            <textarea
              data-testid="lyrics-editor-textarea"
              value={lyricsDraft}
              onChange={(e) => setLyricsDraft(e.target.value)}
              rows={9}
              placeholder={
                lyricsDraftFormat === 'lrc'
                  ? '[00:05.00] 静かな夜に...\n[00:05.00] Trong đêm tĩnh lặng...'
                  : 'Nhập hoặc dán lời bài hát tại đây...'
              }
              className="lp-surface-input lp-lyrics-text mt-3 w-full resize-none rounded-2xl p-3.5 text-[13.5px] focus:outline-none"
            />

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex items-center gap-2">
                <select
                  data-testid="lyrics-encoding-select"
                  aria-label="Bảng mã file lời bài hát"
                  value={lyricsImportEncoding}
                  onChange={(e) => setLyricsImportEncoding(e.target.value as LyricsEncodingOption)}
                  className="lp-surface-input h-9 rounded-full px-3 text-[11.5px] font-medium focus:outline-none"
                >
                  <option value="auto">Tự động nhận diện</option>
                  {getSupportedLyricsEncodings().map((enc) => (
                    <option key={enc} value={enc}>
                      {enc.toUpperCase()}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    setIsLyricsModalOpen(false);
                    void handleImportLyricsFile(lyricsImportEncoding);
                  }}
                  className="lp-btn-ghost flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-medium text-[var(--text-primary)]"
                >
                  <Upload className="h-3.5 w-3.5" />
                  Nhập file...
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsLyricsModalOpen(false)}
                  className="lp-btn-ghost rounded-full px-4 py-2 text-[12.5px] font-medium"
                >
                  Hủy
                </button>
                <button
                  type="button"
                  data-testid="lyrics-editor-save"
                  onClick={() => void handleSaveLyricsModal()}
                  className="rounded-full bg-[var(--text-primary)] px-5 py-2 text-[12.5px] font-semibold text-[var(--bg-deep)] hover:opacity-90"
                >
                  Lưu lời bài hát
                </button>
              </div>
            </div>
          </div>
        </div>
        </OverlayPortal>
      )}

      {/* In-App Metadata Override Modal */}
      <TrackMetadataModal
        target={metadataEditTarget}
        isSaving={isSavingMeta}
        onClose={() => setIsMetadataModalOpen(false)}
        onSave={handleSaveMetadata}
        onRestoreOriginal={handleRestoreMetadata}
        onImportCustomArtwork={async (id) => {
          const res = await libraryStore.importCustomArtwork(id);
          if (!res.canceled && res.error) {
            uiStore.showToast(resultErrorFallback(res.error));
          } else if (!res.canceled) {
            uiStore.showToast('Đã cập nhật ảnh bìa bài hát');
          }
        }}
        onRemoveCustomArtwork={async (id) => {
          const res = await libraryStore.removeCustomArtwork(id);
          if (res.error) {
            uiStore.showToast(res.error);
          } else {
            uiStore.showToast('Đã khôi phục ảnh bìa gốc');
          }
        }}
      />
    </div>
  );
}

function resultErrorFallback(err: string): string {
  return err || 'Không thể cập nhật ảnh bìa';
}
