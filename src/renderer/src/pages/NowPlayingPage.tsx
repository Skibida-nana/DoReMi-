import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  Disc3,
  Heart,
  ImagePlus,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat,
  Repeat1,
  RotateCcw,
  Shuffle,
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
  findActiveLyricGroupIndex,
  groupTimedLyricLines,
} from '../../../shared/utils/lyrics-parser';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import { NowPlayingLyricsPanel } from '../components/NowPlayingLyricsPanel';
import { PlaybackTransitionControl } from '../components/PlaybackTransitionControl';
import { QuickEqPopover } from '../components/QuickEqPopover';
import {
  TrackMetadataModal,
  type TrackMetadataEditTarget,
} from '../components/TrackMetadataModal';
import { VinylTurntable } from '../components/VinylTurntable';
import { PROTOTYPE_TRACKS, getAlbumById } from '../data/prototype-catalog';
import { libraryStore, useLibraryState } from '../stores/library-store';
import { usePlaybackState } from '../stores/player-store';
import { uiStore, useUiState } from '../stores/ui-store';
import {
  FALLBACK_DOREMI_PALETTE,
  extractPaletteFromImageUrl,
  getCachedPaletteForImageUrl,
  type DynamicArtworkPalette,
} from '../utils/dynamic-color';
import { formatDurationSeconds, formatFileSize, formatTrackAudioSpecs } from '../utils/formatters';
import { computeNowPlayingVinylSizing } from '../utils/vinyl-geometry';
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

export function NowPlayingPage() {
  const ui = useUiState();
  const playback = usePlaybackState();
  const library = useLibraryState();

  const isFocusMode = ui.nowPlayingMode === 'focus';
  const isLight = ui.preferences.themeMode === 'light';

  // Single source of truth: real Electron AudioEngine when activeSource === 'local', else prototype catalog
  const isLocalActive = ui.activeSource === 'local' && Boolean(playback.currentTrackId);
  const localTrack = useMemo(
    () =>
      isLocalActive
        ? library.tracks.find((t) => t.id === playback.currentTrackId) ??
          playback.currentTrack ??
          null
        : null,
    [isLocalActive, library.tracks, playback.currentTrackId, playback.currentTrack],
  );
  const sampleTrack = uiStore.getActiveSampleTrack();
  const sampleAlbum = getAlbumById(sampleTrack.albumId);

  const activeTrackId = localTrack ? localTrack.id : sampleTrack.id;
  const activeTitle = localTrack ? localTrack.title : sampleTrack.title;
  const activeArtist = localTrack ? localTrack.artist ?? 'Chưa rõ nghệ sĩ' : sampleTrack.artist;
  const activeAlbumTitle = localTrack
    ? localTrack.album ?? 'Không có album'
    : sampleTrack.albumTitle;
  const activeYear: number | null = localTrack
    ? localTrack.year ?? null
    : sampleAlbum.year ?? null;
  const activeDurationSec = localTrack
    ? playback.durationSeconds || (localTrack.duration_ms ? localTrack.duration_ms / 1000 : 0)
    : sampleTrack.durationSec;
  const activeCurrentTimeSec = localTrack ? playback.currentTimeSeconds : ui.sampleCurrentTimeSec;

  // Rotation & Play state strictly reflect real AudioEngine status (never faked)
  const isActuallyPlaying = localTrack ? playback.status === 'playing' : ui.sampleIsPlaying;
  const playbackError = localTrack && playback.status === 'error' ? playback.errorMessage : null;

  const activeTechSummary = localTrack
    ? formatTrackAudioSpecs(localTrack)
    : `${sampleTrack.container} · ${sampleTrack.bitDepth ?? 16}-bit / ${
        sampleTrack.sampleRateHz ? Number((sampleTrack.sampleRateHz / 1000).toFixed(1)) : 44.1
      } kHz`;

  const activeCoverUrl = uiStore.getCoverForTrack(activeTrackId, 'full');
  const activeThumbUrl = uiStore.getCoverForTrack(activeTrackId, 'thumb');

  const hasCustomArtwork = localTrack
    ? Boolean(localTrack.has_custom_artwork)
    : uiStore.hasWebCustomCover(activeTrackId);

  const artworkSource: 'custom' | 'embedded' | 'folder' | 'default' = localTrack
    ? localTrack.artwork_source ?? 'default'
    : hasCustomArtwork
      ? 'custom'
      : 'embedded';

  // Volume visual state (consistent high-contrast two-tone slider)
  const rawVolume = localTrack ? playback.volume : ui.sampleVolume;
  const rawMuted = localTrack ? playback.muted : ui.sampleMuted;
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

  // Escape exits Focus Vinyl Mode cleanly so the listener is never trapped
  useEffect(() => {
    if (!isFocusMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        uiStore.setNowPlayingMode('standard');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFocusMode]);

  const fallbackAccentPalette = uiStore.getCurrentPalette();

  // Dynamic Album Colors extracted deterministically from effective artwork
  const [extractedPalette, setExtractedPalette] = useState<DynamicArtworkPalette>(() => {
    if (!ui.appearance.dynamicAlbumColors) {
      return FALLBACK_DOREMI_PALETTE;
    }
    return getCachedPaletteForImageUrl(activeCoverUrl) ?? FALLBACK_DOREMI_PALETTE;
  });

  useEffect(() => {
    if (!ui.appearance.dynamicAlbumColors) {
      setExtractedPalette(FALLBACK_DOREMI_PALETTE);
      return;
    }
    let cancelled = false;
    const cached = getCachedPaletteForImageUrl(activeCoverUrl);
    if (cached) {
      setExtractedPalette(cached);
      return;
    }
    void extractPaletteFromImageUrl(activeCoverUrl).then((paletteResult) => {
      if (!cancelled) {
        setExtractedPalette(paletteResult);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeCoverUrl, ui.appearance.dynamicAlbumColors]);

  const palette = ui.appearance.dynamicAlbumColors
    ? extractedPalette
    : {
        dominant: fallbackAccentPalette.dominant,
        glowRgb: fallbackAccentPalette.glowRgb,
        secondaryGlowRgb: fallbackAccentPalette.secondaryGlowRgb,
        isFallback: false,
      };

  // Vinyl Swap Controller (decoupled from playback & NEVER triggered when toggling Focus Mode)
  const swapControllerRef = useRef<VinylSwapController | null>(null);
  if (!swapControllerRef.current) {
    swapControllerRef.current = new VinylSwapController(activeTrackId);
  }
  const [swapSnapshot, setSwapSnapshot] = useState<VinylSwapSnapshot>(() =>
    swapControllerRef.current!.getSnapshot(),
  );

  useEffect(() => {
    const controller = swapControllerRef.current!;
    const unsubscribe = controller.subscribe(setSwapSnapshot);
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const animateSwap = ui.appearance.vinylAnimation && !ui.appearance.reducedMotion;
    swapControllerRef.current?.transitionTo(activeTrackId, animateSwap);
  }, [activeTrackId, ui.appearance.vinylAnimation, ui.appearance.reducedMotion]);

  useEffect(() => {
    return () => {
      swapControllerRef.current?.dispose();
    };
  }, []);

  const displayedCoverUrl = uiStore.getCoverForTrack(swapSnapshot.displayedTrackId, 'full');
  const displayedLocalTrack = useMemo(
    () => library.tracks.find((t) => t.id === swapSnapshot.displayedTrackId) ?? null,
    [library.tracks, swapSnapshot.displayedTrackId],
  );
  const displayedAlbumTitle =
    displayedLocalTrack?.album ??
    PROTOTYPE_TRACKS.find((t) => t.id === swapSnapshot.displayedTrackId)?.albumTitle ??
    activeAlbumTitle;

  // Resolved Lyrics (Electron IPC for local SQLite tracks, offline store for web preview)
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

  const activeLyricIndex = useMemo(
    () => (isLrcLyrics ? findActiveLyricGroupIndex(lyricGroups, activeCurrentTimeSec) : -1),
    [isLrcLyrics, lyricGroups, activeCurrentTimeSec],
  );
  const effectiveActiveLyricIdx = activeLyricIndex === -1 ? 0 : activeLyricIndex;

  const lyricsContainerRef = useRef<HTMLDivElement | null>(null);
  const activeLineRef = useRef<HTMLButtonElement | null>(null);
  const [isManualScrolling, setIsManualScrolling] = useState(false);

  // Auto-scroll active LRC line to center/slightly-below-center of reading zone
  useEffect(() => {
    if (
      isFocusMode ||
      ui.nowPlayingRightTab !== 'lyrics' ||
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
    // Place active line cleanly around ~44% from top of lyrics viewport (never stuck at bottom!)
    const targetTop =
      container.scrollTop +
      (activeRect.top - containerRect.top) -
      containerRect.height * 0.42 +
      activeRect.height / 2;

    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: ui.appearance.reducedMotion ? 'auto' : 'smooth',
    });
  }, [
    activeLyricIndex,
    isFocusMode,
    ui.nowPlayingRightTab,
    isLrcLyrics,
    isManualScrolling,
    ui.appearance.reducedMotion,
  ]);

  // Re-sync lyrics immediately when returning from Focus Mode or switching back to Lyrics tab
  useEffect(() => {
    if (!isFocusMode && ui.nowPlayingRightTab === 'lyrics') {
      setIsManualScrolling(false);
    }
  }, [isFocusMode, ui.nowPlayingRightTab]);

  useEffect(() => {
    setIsManualScrolling(false);
    setIsMoreOpen(false);
  }, [activeTrackId]);

  // Modals, Menus & Offline File Inputs
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [isLyricsModalOpen, setIsLyricsModalOpen] = useState(false);
  const [lyricsDraft, setLyricsDraft] = useState('');
  const [lyricsDraftFormat, setLyricsDraftFormat] = useState<'lrc' | 'txt'>('lrc');
  const [lyricsImportEncoding, setLyricsImportEncoding] = useState<LyricsEncodingOption>('auto');
  const [isMetadataModalOpen, setIsMetadataModalOpen] = useState(false);
  const [isSavingMeta, setIsSavingMeta] = useState(false);

  const coverFileInputRef = useRef<HTMLInputElement | null>(null);
  const lyricsFileInputRef = useRef<HTMLInputElement | null>(null);

  // Viewport-aware Hero Vinyl sizing (92-96% of hero height at 1366x768 & 1440x900)
  const [viewport, setViewport] = useState(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 1366,
    height: typeof window !== 'undefined' ? window.innerHeight : 768,
  }));

  useEffect(() => {
    const onResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const vinylSizing = useMemo(
    () =>
      computeNowPlayingVinylSizing({
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        isFocusMode,
      }),
    [viewport.width, viewport.height, isFocusMode],
  );

  // Queue / Context Track List
  const unifiedTracks = uiStore.getUnifiedTracks();
  const contextTracks = useMemo(() => {
    if (localTrack) {
      return unifiedTracks.filter((t) => t.source === 'local');
    }
    const byId = new Map(unifiedTracks.map((t) => [t.id, t]));
    const queued = ui.queueTrackIds
      .map((id) => byId.get(id))
      .filter((t): t is NonNullable<typeof t> => Boolean(t));
    return queued.length > 0 ? queued : unifiedTracks;
  }, [localTrack, unifiedTracks, ui.queueTrackIds]);

  const handleSelectContextTrack = (trackId: string, source: 'local' | 'sample') => {
    if (source === 'local') {
      const real = library.tracks.find((t) => t.id === trackId);
      if (real) {
        void uiStore.playLocalElectronTrack(real);
        return;
      }
    }
    uiStore.playSampleTrack(trackId);
  };

  // Custom Artwork Actions
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
    reader.onerror = () => {
      uiStore.showToast('Lỗi khi đọc file ảnh bìa.');
    };
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

  // Lyrics Actions
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
      uiStore.showToast('Đã lưu lời bài hát vào cơ sở dữ liệu');
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

  // Metadata Edit Target & Handlers
  const metadataEditTarget: TrackMetadataEditTarget | null = useMemo(() => {
    if (!isMetadataModalOpen) return null;
    if (localTrack) {
      return {
        id: localTrack.id,
        title: localTrack.title,
        artist: localTrack.artist ?? 'Unknown Artist',
        album: localTrack.album,
        originalTitle: localTrack.original_title ?? localTrack.title,
        originalArtist: localTrack.original_artist ?? localTrack.artist ?? 'Unknown Artist',
        originalAlbum:
          localTrack.original_album !== undefined ? localTrack.original_album : localTrack.album,
        hasOverride: Boolean(
          localTrack.title_override ||
            localTrack.artist_override ||
            localTrack.album_override,
        ),
      };
    }
    const baseSample = PROTOTYPE_TRACKS.find((t) => t.id === sampleTrack.id) ?? sampleTrack;
    const override = ui.metadataOverridesByTrackId[sampleTrack.id];
    return {
      id: sampleTrack.id,
      title: sampleTrack.title,
      artist: sampleTrack.artist,
      album: sampleTrack.albumTitle,
      originalTitle: baseSample.title,
      originalArtist: baseSample.artist,
      originalAlbum: baseSample.albumTitle,
      hasOverride: Boolean(override),
    };
  }, [isMetadataModalOpen, localTrack, sampleTrack, ui.metadataOverridesByTrackId]);

  const handleSaveMetadata = async (trackId: string, input: TrackMetadataOverrideInput) => {
    setIsSavingMeta(true);
    try {
      if (localTrack && window.losslessApi) {
        await libraryStore.updateTrackMetadataOverride(trackId, input);
        uiStore.showToast('Đã lưu thông tin bài hát trong SQLite (file gốc không thay đổi)');
      } else {
        uiStore.setWebMetadataOverride(trackId, input);
      }
    } finally {
      setIsSavingMeta(false);
    }
  };

  const handleRestoreMetadata = async (trackId: string) => {
    setIsSavingMeta(true);
    try {
      if (localTrack && window.losslessApi) {
        await libraryStore.restoreTrackMetadataOriginal(trackId);
        uiStore.showToast('Đã khôi phục thông tin gốc của bài hát');
      } else {
        uiStore.restoreWebMetadataOriginal(trackId);
      }
    } finally {
      setIsSavingMeta(false);
    }
  };

  const snapBackToLyrics = useCallback(() => {
    setIsManualScrolling(false);
  }, []);

  const handleVinylSeek = useCallback((nextSec: number) => {
    uiStore.seek(nextSec);
  }, []);

  const handleManualLyricsScroll = useCallback(() => {
    setIsManualScrolling(true);
  }, []);

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

  const isFavorite = ui.favoriteIds.includes(activeTrackId);
  const progressPct =
    activeDurationSec > 0 ? Math.min(100, (activeCurrentTimeSec / activeDurationSec) * 100) : 0;
  const showVolumeTooltip = isVolumeHovered || isVolumeDragging || isVolumeFocused;

  // Real technical metadata fields for Info Tab (never fabricated)
  const techSpecItems = useMemo(() => {
    const items: Array<{ label: string; value: string }> = [];
    const classified = localTrack ? classifyTrackAudioCodec(localTrack) : null;
    if (classified) {
      const formatLabel = classified.isM4aContainer
        ? classified.qualityTier === 'lossless'
          ? `${classified.displayCodec} (Lossless · M4A)`
          : classified.qualityTier === 'lossy'
            ? `${classified.displayCodec} (Lossy · M4A)`
            : `${classified.displayCodec} (M4A)`
        : classified.displayCodec;
      if (formatLabel) {
        items.push({ label: 'Định dạng', value: formatLabel });
      }
    } else if (sampleTrack.container) {
      items.push({ label: 'Định dạng', value: sampleTrack.container });
    }
    const bitDepth =
      classified?.qualityTier === 'lossy'
        ? null
        : localTrack
          ? localTrack.bit_depth
          : sampleTrack.bitDepth;
    if (bitDepth) {
      items.push({ label: 'Bit depth', value: `${bitDepth}-bit` });
    }
    const sampleRateHz = localTrack ? localTrack.sample_rate_hz : sampleTrack.sampleRateHz;
    if (sampleRateHz) {
      items.push({
        label: 'Sample rate',
        value: `${Number((sampleRateHz / 1000).toFixed(1))} kHz`,
      });
    }
    const bitrateKbps = localTrack
      ? localTrack.bitrate_bps
        ? Math.round(localTrack.bitrate_bps / 1000)
        : null
      : sampleTrack.bitrateKbps || null;
    if (bitrateKbps) {
      items.push({ label: 'Bitrate', value: `${bitrateKbps} kbps` });
    }
    const fileSize = localTrack ? localTrack.file_size_bytes : sampleTrack.fileSizeBytes;
    if (fileSize && fileSize > 0) {
      items.push({ label: 'Dung lượng', value: formatFileSize(fileSize) });
    }
    return items;
  }, [localTrack, sampleTrack]);

  return (
    <div
      data-testid="now-playing-screen"
      data-mode={ui.nowPlayingMode}
      data-dynamic-glow={palette.glowRgb}
      className="relative flex h-full w-full flex-col overflow-hidden"
      style={{ backgroundColor: 'var(--np-bg)', color: 'var(--np-text-primary)' }}
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

      {/* Restrained Hi-Fi Studio Atmospheric Wash (No loud purple fog, no heavy gradients) */}
      <div
        aria-hidden="true"
        className="lp-ambient-layer pointer-events-none absolute inset-0 z-0"
        style={{
          background: ui.appearance.backgroundEffects
            ? isLight
              ? `radial-gradient(ellipse 42% 58% at 28% 48%, rgba(${palette.glowRgb}, 0.065) 0%, rgba(245, 245, 243, 0) 74%)`
              : `radial-gradient(ellipse 46% 62% at 28% 48%, rgba(${palette.glowRgb}, 0.14) 0%, rgba(16, 17, 20, 0) 74%)`
            : 'none',
        }}
      />

      {/* Top Slim Header Bar (Minimal in Standard; Ultra-clean Floating Exit in Focus Vinyl Mode) */}
      {isFocusMode ? (
        <header className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center justify-between px-6 pt-4">
          <button
            type="button"
            onClick={() => uiStore.closeNowPlaying()}
            aria-label="Quay lại"
            className="pointer-events-auto inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-[var(--np-text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]"
          >
            <ChevronDown className="h-4 w-4" />
            <span>Quay lại</span>
          </button>

          <button
            type="button"
            data-testid="btn-exit-focus-mode"
            onClick={() => uiStore.setNowPlayingMode('standard')}
            aria-label="Thoát chế độ Tập trung Vinyl"
            className="pointer-events-auto inline-flex h-9 items-center gap-2 rounded-full border border-[var(--np-divider)] bg-[var(--np-surface-bar)] px-4 text-[12.5px] font-medium text-[var(--np-text-primary)] shadow-sm backdrop-blur-md transition hover:bg-[var(--surface-hover)]"
          >
            <Minimize2 className="h-3.5 w-3.5" />
            <span>Thoát Focus</span>
          </button>
        </header>
      ) : (
        <header className="relative z-20 flex h-[42px] shrink-0 items-center justify-between px-6 pt-1">
          <button
            type="button"
            onClick={() => uiStore.closeNowPlaying()}
            aria-label="Quay lại"
            className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium text-[var(--np-text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]"
          >
            <ChevronDown className="h-4 w-4" />
            <span>Quay lại</span>
          </button>

          <div className="relative flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => uiStore.setNowPlayingMode('focus')}
              data-testid="btn-header-focus-mode"
              title="Chế độ Tập trung Vinyl (Focus Vinyl Mode)"
              aria-label="Bật chế độ Tập trung Vinyl"
              className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium text-[var(--np-text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Focus Vinyl</span>
            </button>

            <button
              type="button"
              onClick={() => setIsMoreOpen((prev) => !prev)}
              aria-label="Tùy chọn khác"
              aria-expanded={isMoreOpen}
              className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--np-text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>

            {isMoreOpen && (
              <div
                role="menu"
                className="lp-glass-pill absolute top-10 right-0 z-30 w-60 rounded-2xl p-1.5 text-[13px]"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleImportCustomCover()}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
                >
                  <ImagePlus className="h-4 w-4 text-[var(--text-secondary)]" />
                  <span>{hasCustomArtwork ? 'Thay ảnh bìa tùy chỉnh' : 'Đổi ảnh bìa bài hát'}</span>
                </button>
                {hasCustomArtwork && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleRemoveCustomCover()}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-amber-600 transition hover:bg-[var(--surface-hover)] dark:text-amber-200"
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
                {!localTrack && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsMoreOpen(false);
                      uiStore.openAlbumDetail(sampleTrack.albumId);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
                  >
                    <Disc3 className="h-4 w-4 text-[var(--text-secondary)]" />
                    <span>Xem Album</span>
                  </button>
                )}
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
              </div>
            )}
          </div>
        </header>
      )}

      {/*
        MAIN STAGE:
        - Standard Mode: Giant Left Vinyl Hero (~54%) | Unboxed Editorial Right Column (~46%)
        - Focus Vinyl Mode: Dedicated Showcase — Expanded Vinyl (~58%) | Pure Negative-Space Title & Artist + Minimal Controls
        Single persistent VinylTurntable instance keeps rotation & tonearm 100% seamless across mode switches!
      */}
      <div
        className={`relative z-10 flex min-h-0 flex-1 items-stretch overflow-hidden transition-all duration-350 ${
          isFocusMode ? 'px-4 py-3 lg:px-8' : 'px-3 py-0 lg:px-4'
        }`}
      >
        {/* LEFT HERO ZONE: Giant Vinyl + Thin Progress Ring + Right-Side Tonearm */}
        <section
          data-testid="now-playing-center-zone"
          aria-label="Mâm đĩa than và vòng tiến độ phát nhạc"
          style={{
            width: viewport.width >= 1024 ? `${vinylSizing.heroColumnWidth}px` : '100%',
            transition: ui.appearance.reducedMotion
              ? 'none'
              : 'width 360ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
          className="relative flex min-h-0 shrink-0 flex-col items-center justify-center overflow-visible"
        >
          <VinylTurntable
            coverUrl={displayedCoverUrl}
            albumTitle={displayedAlbumTitle}
            accentColor={palette.dominant}
            glowRgb={palette.glowRgb}
            isPlaying={isActuallyPlaying}
            sizePx={vinylSizing.ringCanvasSize}
            themeMode={ui.preferences.themeMode}
            qualityPreset={ui.preferences.uiQualityPreset}
            swapPhase={swapSnapshot.phase}
            vinylAnimationEnabled={ui.appearance.vinylAnimation}
            reducedMotion={ui.appearance.reducedMotion}
            showProgressRing
            progressPct={progressPct}
            currentTimeSec={activeCurrentTimeSec}
            durationSec={activeDurationSec}
            onSeek={handleVinylSeek}
          />

          {playbackError && (
            <p className="mt-2 rounded-full border border-rose-400/25 bg-rose-500/10 px-3.5 py-1 text-[12px] text-rose-500 dark:text-rose-200">
              {playbackError}
            </p>
          )}
        </section>

        {/* RIGHT ZONE: Unboxed Hi-Fi Editorial Column (Standard) OR Minimalist Showcase (Focus) */}
        {isFocusMode ? (
          <section
            data-testid="now-playing-focus-showcase"
            aria-label="Chế độ Tập trung Vinyl"
            className="flex min-h-0 min-w-0 flex-1 flex-col justify-center px-8 lg:px-12 xl:px-16"
          >
            <div className="max-w-[540px]">
              <h1
                data-testid="focus-track-title"
                className="font-display line-clamp-3 font-bold tracking-[-0.028em] text-[var(--np-text-primary)]"
                style={{
                  fontSize: 'clamp(40px, 3.8vw, 56px)',
                  lineHeight: 1.06,
                }}
              >
                {activeTitle}
              </h1>

              <p
                data-testid="focus-track-artist"
                className="mt-4 font-normal text-[var(--np-text-secondary)]"
                style={{ fontSize: 'clamp(17px, 1.4vw, 20px)', lineHeight: 1.35 }}
              >
                {activeArtist}
              </p>

              {/* Quiet Minimal Focus Transport Controls */}
              <div className="mt-10 flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => uiStore.previousTrack()}
                  aria-label="Bài trước"
                  className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--np-text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]"
                >
                  <SkipBack className="h-5 w-5" />
                </button>

                <button
                  type="button"
                  data-testid="focus-play-pause-btn"
                  onClick={() => uiStore.togglePlayPause()}
                  aria-label={isActuallyPlaying ? 'Tạm dừng' : 'Phát nhạc'}
                  className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--np-text-primary)] text-[var(--np-bg)] shadow-sm transition hover:scale-105 active:scale-95"
                >
                  {isActuallyPlaying ? (
                    <Pause className="h-5 w-5 fill-current" />
                  ) : (
                    <Play className="ml-0.5 h-5 w-5 fill-current" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => uiStore.nextTrack()}
                  aria-label="Bài tiếp theo"
                  className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--np-text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]"
                >
                  <SkipForward className="h-5 w-5" />
                </button>

                <button
                  type="button"
                  onClick={() => uiStore.toggleFavorite(activeTrackId)}
                  aria-label={isFavorite ? 'Bỏ yêu thích' : 'Yêu thích'}
                  className="ml-1 flex h-9 w-9 items-center justify-center rounded-full text-[var(--np-text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]"
                >
                  <Heart
                    className="h-4 w-4"
                    style={
                      isFavorite
                        ? { color: palette.dominant, fill: palette.dominant }
                        : undefined
                    }
                  />
                </button>

                <span className="font-mono-tabular ml-2 text-[12px] text-[var(--np-text-muted)]">
                  <span className="text-[var(--np-text-primary)]">
                    {formatDurationSeconds(activeCurrentTimeSec)}
                  </span>{' '}
                  / {formatDurationSeconds(activeDurationSec)}
                </span>
              </div>
            </div>
          </section>
        ) : (
          <aside
            data-testid="now-playing-right-zone"
            aria-label={
              ui.nowPlayingRightTab === 'info'
                ? 'Thông tin bài hát'
                : ui.nowPlayingRightTab === 'queue'
                  ? 'Hàng đợi phát nhạc'
                  : 'Lời bài hát'
            }
            className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-6 pt-3 pb-2 lg:px-8 xl:px-10"
          >
            {/*
              UNBOXED EDITORIAL TRACK HEADER (2nd Visual Focal Point right after Vinyl!)
              Single left alignment axis, zero dashboard card box, clean spacing hierarchy.
            */}
            <div className="shrink-0">
              <h1
                data-testid="now-playing-hero-title"
                className="font-display line-clamp-2 font-bold tracking-[-0.025em] text-[var(--np-text-primary)]"
                style={{
                  fontSize: 'clamp(34px, 3.25vw, 52px)',
                  lineHeight: 1.08,
                }}
              >
                {activeTitle}
              </h1>

              <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <button
                  type="button"
                  data-testid="now-playing-hero-artist"
                  onClick={() => uiStore.openArtistDetail(activeArtist)}
                  className="text-left text-[16px] font-medium text-[var(--np-text-secondary)] transition hover:text-[var(--np-text-primary)] hover:underline underline-offset-4 xl:text-[18px]"
                >
                  {activeArtist}
                </button>
              </div>

              <p
                data-testid="now-playing-hero-meta"
                className="mt-1.5 truncate text-[12px] font-normal tracking-[0.01em] text-[var(--np-text-muted)]"
              >
                {activeAlbumTitle}
                {activeYear !== null ? ` · ${activeYear}` : ''} · {activeTechSummary}
              </p>
            </div>

            {/*
              MINIMAL EDITORIAL TAB BAR (24–28px below Track Header):
              Clean underline active indicator in effective Now Playing color — zero thick pill box!
              Preserves ALL 3 tabs: Lời bài hát | Hàng đợi | Thông tin.
            */}
            <div className="mt-6 flex shrink-0 items-center justify-between gap-3 border-b border-[var(--np-divider)]">
              <div
                role="tablist"
                aria-label="Chuyển đổi Lời bài hát, Hàng đợi và Thông tin"
                className="flex items-center gap-6"
              >
                {(
                  [
                    { id: 'lyrics', label: 'Lời bài hát' },
                    { id: 'queue', label: 'Hàng đợi' },
                    { id: 'info', label: 'Thông tin' },
                  ] as const
                ).map((tab) => {
                  const active = ui.nowPlayingRightTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      data-testid={`now-playing-tab-${tab.id}`}
                      aria-selected={active}
                      onClick={() => uiStore.setNowPlayingRightTab(tab.id)}
                      className={`relative pb-2.5 text-[13.5px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
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
                          style={{ backgroundColor: palette.dominant }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Quiet inline contextual actions (never adds a second stacked toolbar) */}
              {ui.nowPlayingRightTab === 'lyrics' && (
                <div className="flex items-center gap-1 pb-2">
                  <button
                    type="button"
                    data-testid="btn-import-lyrics"
                    onClick={() => void handleImportLyricsFile()}
                    title="Nhập file .lrc hoặc .txt (UTF-8, UTF-16, Shift-JIS, GB18030, EUC-KR, Big5)"
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
                      title="Xóa lời tùy chỉnh và khôi phục nguồn tự động"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-amber-600 transition hover:bg-amber-500/12 dark:text-amber-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}

              {ui.nowPlayingRightTab === 'queue' && !localTrack && contextTracks.length > 1 && (
                <button
                  type="button"
                  data-testid="now-playing-queue-clear"
                  onClick={() => uiStore.clearQueue()}
                  className="mb-2 inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-[var(--np-text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]"
                >
                  <Trash2 className="h-3 w-3" />
                  <span>Dọn hàng đợi</span>
                </button>
              )}
            </div>

            {/* TAB CONTENT AREA — Directly on Clean Canvas (Zero Box Borders) */}
            {ui.nowPlayingRightTab === 'queue' ? (
              /* -------------------- QUEUE TAB (Flat Hi-Fi Reference Track List) -------------------- */
              <div
                data-testid="now-playing-queue-panel"
                className="flex min-h-0 flex-1 flex-col pt-2"
              >
                <div className="flex-1 overflow-y-auto pr-2">
                  <ul className="divide-y divide-[var(--np-divider)]">
                    {contextTracks.map((track, idx) => {
                      const isCurrent = track.id === activeTrackId;
                      return (
                        <li
                          key={`${track.id}-${idx}`}
                          data-testid={isCurrent ? 'queue-item-current' : 'queue-item'}
                          className={`group flex items-center gap-3 py-2.5 transition ${
                            isCurrent ? '' : 'hover:bg-[var(--surface-glass-light)]'
                          }`}
                        >
                          <span
                            className="font-mono-tabular w-6 shrink-0 text-[12px]"
                            style={{
                              color: isCurrent ? palette.dominant : 'var(--np-text-muted)',
                              fontWeight: isCurrent ? 600 : 400,
                            }}
                          >
                            {idx + 1}.
                          </span>

                          <button
                            type="button"
                            onClick={() => handleSelectContextTrack(track.id, track.source)}
                            className="flex min-w-0 flex-1 items-center gap-3 text-left"
                          >
                            <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-md bg-black/15">
                              <img
                                src={track.coverUrl}
                                alt={track.title}
                                onError={(e) => {
                                  const img = e.currentTarget;
                                  if (img.dataset.fallbackApplied !== '1') {
                                    img.dataset.fallbackApplied = '1';
                                    img.src = DEFAULT_DOREMI_ARTWORK_URL;
                                  }
                                }}
                                className="h-full w-full object-cover"
                              />
                              {isCurrent && (
                                <span
                                  className="absolute right-0.5 bottom-0.5 h-2 w-2 rounded-full ring-2 ring-black/50"
                                  style={{ backgroundColor: palette.dominant }}
                                />
                              )}
                            </div>

                            <div className="min-w-0 flex-1">
                              <p
                                className="truncate text-[13.5px] font-semibold leading-snug"
                                style={{
                                  color: isCurrent ? palette.dominant : 'var(--np-text-primary)',
                                }}
                              >
                                {track.title}
                              </p>
                              <p className="truncate text-[11.5px] text-[var(--np-text-muted)]">
                                {track.artist}
                              </p>
                            </div>
                          </button>

                          {!localTrack && (
                            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                              <button
                                type="button"
                                onClick={() => uiStore.moveQueueItem(idx, -1)}
                                disabled={idx === 0}
                                aria-label={`Di chuyển ${track.title} lên`}
                                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--np-text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)] disabled:opacity-30"
                              >
                                <ArrowUp className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => uiStore.moveQueueItem(idx, 1)}
                                disabled={idx === contextTracks.length - 1}
                                aria-label={`Di chuyển ${track.title} xuống`}
                                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--np-text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)] disabled:opacity-30"
                              >
                                <ArrowDown className="h-3 w-3" />
                              </button>
                              {!isCurrent && (
                                <button
                                  type="button"
                                  onClick={() => uiStore.removeFromQueue(track.id)}
                                  aria-label={`Xóa ${track.title} khỏi hàng đợi`}
                                  className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--np-text-muted)] hover:bg-rose-500/15 hover:text-rose-500"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              )}
                            </div>
                          )}

                          <span
                            className="font-mono-tabular shrink-0 text-[12px]"
                            style={{
                              color: isCurrent ? palette.dominant : 'var(--np-text-muted)',
                            }}
                          >
                            {formatDurationSeconds(track.durationSec)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            ) : ui.nowPlayingRightTab === 'info' ? (
              /* -------------------- INFO TAB (Unboxed Editorial Spec Sheet — Real Data Only) -------------------- */
              <div
                data-testid="now-playing-info-panel"
                className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-4 pr-2"
              >
                <div className="flex items-start gap-4">
                  <div className="relative h-[108px] w-[108px] shrink-0 overflow-hidden rounded-xl border border-[var(--np-divider)] bg-black/15">
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

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        data-testid="btn-import-custom-cover"
                        onClick={() => void handleImportCustomCover()}
                        className="lp-btn-ghost inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium text-[var(--np-text-primary)]"
                      >
                        <ImagePlus className="h-3.5 w-3.5" />
                        <span>{hasCustomArtwork ? 'Thay ảnh bìa' : 'Đổi ảnh bìa'}</span>
                      </button>

                      <button
                        type="button"
                        data-testid="btn-edit-metadata"
                        onClick={() => setIsMetadataModalOpen(true)}
                        className="lp-btn-ghost inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium text-[var(--np-text-primary)]"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        <span>Sửa thông tin</span>
                      </button>

                      {hasCustomArtwork && (
                        <button
                          type="button"
                          data-testid="btn-remove-custom-cover"
                          onClick={() => void handleRemoveCustomCover()}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 text-[12px] font-medium text-amber-600 transition hover:bg-amber-500/18 dark:text-amber-200"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          <span>Khôi phục ảnh gốc</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <dl className="mt-5 divide-y divide-[var(--np-divider)] border-t border-[var(--np-divider)] text-[13px]">
                  <div className="flex items-baseline justify-between gap-4 py-2.5">
                    <dt className="shrink-0 text-[var(--np-text-muted)]">Bài hát</dt>
                    <dd
                      data-testid="info-track-title"
                      className="truncate text-right font-medium text-[var(--np-text-primary)]"
                    >
                      {activeTitle}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4 py-2.5">
                    <dt className="shrink-0 text-[var(--np-text-muted)]">Nghệ sĩ</dt>
                    <dd
                      data-testid="info-track-artist"
                      className="truncate text-right font-medium text-[var(--np-text-primary)]"
                    >
                      {activeArtist}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4 py-2.5">
                    <dt className="shrink-0 text-[var(--np-text-muted)]">Album</dt>
                    <dd
                      data-testid="info-track-album"
                      className="truncate text-right font-medium text-[var(--np-text-primary)]"
                    >
                      {activeAlbumTitle}
                    </dd>
                  </div>
                  {activeYear !== null && (
                    <div className="flex items-baseline justify-between gap-4 py-2.5">
                      <dt className="shrink-0 text-[var(--np-text-muted)]">Năm phát hành</dt>
                      <dd
                        data-testid="info-track-year"
                        className="font-mono-tabular text-right font-medium text-[var(--np-text-primary)]"
                      >
                        {activeYear}
                      </dd>
                    </div>
                  )}
                  <div className="flex items-baseline justify-between gap-4 py-2.5">
                    <dt className="shrink-0 text-[var(--np-text-muted)]">Thời lượng</dt>
                    <dd className="font-mono-tabular text-right font-medium text-[var(--np-text-primary)]">
                      {formatDurationSeconds(activeDurationSec)}
                    </dd>
                  </div>
                  {techSpecItems.map((spec) => (
                    <div key={spec.label} className="flex items-baseline justify-between gap-4 py-2.5">
                      <dt className="shrink-0 text-[var(--np-text-muted)]">{spec.label}</dt>
                      <dd className="font-mono-tabular truncate text-right font-medium text-[var(--np-text-primary)]">
                        {spec.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : (
              /* -------------------- LYRICS TAB (Memoized Editorial Reading Hierarchy) -------------------- */
              <NowPlayingLyricsPanel
                sourceLabel={lyricsSourceLabel}
                isLoadingLyrics={isLoadingLyrics}
                isLrcLyrics={isLrcLyrics}
                isTxtLyrics={isTxtLyrics}
                lyricGroups={lyricGroups}
                effectiveActiveLyricIdx={effectiveActiveLyricIdx}
                resolvedLyrics={resolvedLyrics}
                isManualScrolling={isManualScrolling}
                accentHex={palette.dominant}
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
        )}
      </div>

      {/*
        SLIM CLEAN BOTTOM CONTROL BAR (68px height in Standard Mode; Hidden in Focus Mode to keep stage pure)
      */}
      {!isFocusMode && (
        <footer
          data-testid="now-playing-bottom-bar"
          aria-label="Thanh điều khiển phát nhạc"
          className="relative z-20 flex h-[68px] shrink-0 items-center justify-between gap-4 border-t border-[var(--np-divider)] px-6 backdrop-blur-md"
          style={{ backgroundColor: 'var(--np-surface-bar)' }}
        >
          {/* Compact Left Strip: Miniature cover + subtle title + Favorite (never competes with Hero Track Title!) */}
          <div className="flex w-[196px] min-w-0 shrink-0 items-center gap-2.5 xl:w-[220px]">
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
                className="truncate text-[12.5px] font-medium text-[var(--np-text-primary)]"
              >
                {activeTitle}
              </p>
              <p
                data-testid="now-playing-bottom-artist"
                className="truncate text-[11px] text-[var(--np-text-muted)]"
              >
                {activeArtist}
              </p>
            </div>
            <button
              type="button"
              onClick={() => uiStore.toggleFavorite(activeTrackId)}
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

          {/* Clean Center Transport Controls + Sleek Progress Strip */}
          <div className="flex min-w-0 flex-1 max-w-[540px] flex-col items-center gap-1">
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => uiStore.toggleShuffle()}
                aria-label="Phát ngẫu nhiên"
                aria-pressed={ui.shuffle}
                className={`flex h-7 w-7 items-center justify-center rounded-full transition ${
                  ui.shuffle
                    ? 'text-[var(--np-text-primary)]'
                    : 'text-[var(--np-text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]'
                }`}
                style={ui.shuffle ? { color: palette.dominant } : undefined}
              >
                <Shuffle className="h-3.5 w-3.5" />
              </button>

              <button
                type="button"
                onClick={() => uiStore.previousTrack()}
                aria-label="Bài trước"
                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--np-text-primary)] transition hover:bg-[var(--surface-hover)]"
              >
                <SkipBack className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={() => uiStore.togglePlayPause()}
                aria-label={isActuallyPlaying ? 'Tạm dừng' : 'Phát nhạc'}
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
                aria-label="Bài tiếp theo"
                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--np-text-primary)] transition hover:bg-[var(--surface-hover)]"
              >
                <SkipForward className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={() => uiStore.cycleRepeat()}
                aria-label="Lặp lại"
                className={`flex h-7 w-7 items-center justify-center rounded-full transition ${
                  ui.repeat !== 'off'
                    ? 'text-[var(--np-text-primary)]'
                    : 'text-[var(--np-text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]'
                }`}
                style={ui.repeat !== 'off' ? { color: palette.dominant } : undefined}
              >
                {ui.repeat === 'one' ? (
                  <Repeat1 className="h-3.5 w-3.5" />
                ) : (
                  <Repeat className="h-3.5 w-3.5" />
                )}
              </button>
            </div>

            <div className="flex w-full items-center gap-2.5">
              <span
                data-testid="now-playing-current-time"
                className="font-mono-tabular w-9 shrink-0 text-right text-[11px] text-[var(--np-text-secondary)]"
              >
                {formatDurationSeconds(activeCurrentTimeSec)}
              </span>
              <div className="relative flex h-3.5 flex-1 items-center">
                <div className="pointer-events-none h-[3px] w-full overflow-hidden rounded-full bg-[var(--np-ring-track)]">
                  <div
                    className="h-full rounded-full transition-[width] duration-150"
                    style={{
                      width: `${progressPct}%`,
                      backgroundColor: palette.dominant,
                    }}
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, activeDurationSec)}
                  step={0.5}
                  value={Math.min(activeCurrentTimeSec, Math.max(1, activeDurationSec))}
                  onChange={(e) => uiStore.seek(Number(e.target.value))}
                  aria-label="Thanh tua bài hát"
                  className="lp-slider absolute inset-0 h-3.5 w-full"
                />
              </div>
              <span className="font-mono-tabular w-9 shrink-0 text-[11px] text-[var(--np-text-muted)]">
                {formatDurationSeconds(activeDurationSec)}
              </span>
            </div>
          </div>

          {/* Right Controls: Quick EQ + Fade Quick Control + Clean Volume + Focus Mode Button */}
          <div className="flex shrink-0 items-center justify-end gap-2.5">
            <QuickEqPopover
              accentHex={palette.dominant}
              accentGlowRgb={palette.glowRgb}
            />

            <PlaybackTransitionControl
              accentHex={palette.dominant}
              accentGlowRgb={palette.glowRgb}
            />

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => uiStore.toggleMute()}
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
                      backgroundColor: palette.dominant,
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
              title="Chế độ Tập trung Vinyl (Focus Mode)"
              aria-label="Chế độ Tập trung Vinyl"
              className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--np-text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </footer>
      )}

      {/* Offline Add/Edit Lyrics Modal (supports LRC, TXT & Multi-Encoding CJK Import) */}
      {isLyricsModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
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
      )}

      {/* In-App Metadata Override Modal (SQLite Only) */}
      <TrackMetadataModal
        target={metadataEditTarget}
        isSaving={isSavingMeta}
        onClose={() => setIsMetadataModalOpen(false)}
        onSave={handleSaveMetadata}
        onRestoreOriginal={handleRestoreMetadata}
      />
    </div>
  );
}
