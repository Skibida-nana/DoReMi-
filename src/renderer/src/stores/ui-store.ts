import { useSyncExternalStore } from 'react';
import type {
  AudioEqPreset,
  AudioLabSettings,
  EqMode,
  EqSlotId,
  ParametricBandConfig,
} from '../../../shared/types/audio-dsp';
import type {
  CustomEditorialFontRecord,
  EditorialTypographySettings,
  FadeDurationSec,
  ListeningSessionInput,
  LocalUserProfile,
  PersonalizationPreferences,
  StatisticsDashboardData,
  StatisticsQuery,
  StoredListeningSession,
} from '../../../shared/types/stage5';
import type { ReplayGainSettings } from '../../../shared/types/stage6';
import {
  applyPresetToSlot,
  clampFinite,
  cloneEqSlotConfig,
  createDefaultAudioLabSettings,
  createDefaultParametricBands,
  createFlatGraphicGains,
  EQ_MAX_GAIN_DB,
  EQ_MIN_GAIN_DB,
  getAllPresets,
  normalizeAudioLabSettings,
  PREAMP_MAX_DB,
  PREAMP_MIN_DB,
  roundTo,
  sanitizeGraphicGains,
  sanitizeParametricBand,
  SYSTEM_AUDIO_PRESETS,
} from '../../../shared/utils/audio-dsp';
import {
  DEFAULT_EDITORIAL_TYPOGRAPHY,
  MAX_EDITORIAL_FONT_BYTES,
  normalizeEditorialTypographySettings,
  validateEditorialFontBytes,
} from '../../../shared/utils/editorial-typography';
import {
  DEFAULT_REPLAYGAIN_SETTINGS,
  normalizeReplayGainSettings,
} from '../../../shared/utils/replaygain';
import {
  ensureEditorialFontLoaded,
  unloadEditorialFont,
} from '../utils/editorial-font-loader';
import type {
  ResolvedTrackLyrics,
  TrackMetadataOverrideInput,
  TrackRecord,
} from '../../../shared/types/track';
import {
  parseLrcContent,
  parsePlainTextLyrics,
} from '../../../shared/utils/lyrics-parser';
import {
  aggregateListeningStatistics,
  isQualifiedPlay,
} from '../../../shared/utils/statistics-engine';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import {
  DEFAULT_CATALOG_PALETTE,
  type AlbumColorPalette,
  type PrototypeAlbum,
  type PrototypePlaylist,
  type PrototypeTrack,
} from '../data/prototype-catalog';
import { formatTrackAudioSpecs } from '../utils/formatters';
import {
  isConfirmedDemoAlbumId,
  isConfirmedDemoPlaylistId,
  isConfirmedDemoTrackId,
} from '../../../shared/utils/demo-cleanup';
import type { PlaylistRecord } from '../../../shared/types/playlist';
import {
  THEME_ACCENT_PRESETS,
  accentToAlbumPalette,
  normalizeHexColor,
  resolveUserAccentPalette,
  type ResolvedAccentPalette,
} from '../utils/theme-presets';
import type {
  PlaybackContextDescriptor,
  PlaybackControlState,
  PlaybackQueueEntry,
  RepeatMode,
} from '../../../shared/types/player';
import {
  DEFAULT_PLAYBACK_CONTROLS,
  normalizePlaybackControls,
} from '../../../shared/utils/playback-controls';
import { sortAlbumTracksCanonical } from '../../../shared/utils/album-sort';
import {
  smartShuffleItems,
  type SmartShuffleTrackMeta,
} from '../../../shared/utils/smart-shuffle';
import type { AutoContinueRequest, AutoContinueResolution } from '../player/audio-engine';
import { resolveNextNowPlayingModePatch } from '../utils/animation-policy';
import {
  readSessionPresentation,
  writeSessionPresentation,
} from '../utils/presentation-lifecycle';
import { isRemoteTrackId } from '../../../shared/contracts/connect-api';
import { connectStore } from './connect-store';
import { libraryStore } from './library-store';
import {
  playbackQueueController,
  playerActions,
  setExternalQueueEntryListener,
  setLocalSessionCheckpointListener,
} from './player-store';

const CUSTOM_LYRICS_V2_KEY = 'doremi_custom_lyrics_v2';
const LEGACY_CUSTOM_LYRICS_KEY = 'lossless_player_custom_lyrics_v1';
const CUSTOM_COVERS_KEY = 'doremi_custom_covers_v1';
const METADATA_OVERRIDES_KEY = 'doremi_metadata_overrides_v1';
const PROFILE_STORAGE_KEY = 'doremi_local_profile_v1';
const PREFERENCES_STORAGE_KEY = 'doremi_personalization_prefs_v1';
const PLAYLISTS_STORAGE_KEY = 'doremi_local_playlists_v1';
const PLAYLISTS_DEMO_PURGED_KEY = 'doremi_demo_purged_v1';
const LISTENING_SESSIONS_KEY = 'doremi_listening_sessions_v1';

function computePaletteFromSeed(seed: string): AlbumColorPalette {
  if (!seed) {
    return DEFAULT_CATALOG_PALETTE;
  }
  const idx = hashStringToIndex(seed, THEME_ACCENT_PRESETS.length);
  const preset = THEME_ACCENT_PRESETS[idx] ?? THEME_ACCENT_PRESETS[0];
  return {
    dominant: preset.hex,
    secondary: preset.secondaryHex,
    glowRgb: preset.glowRgb,
    secondaryGlowRgb: preset.secondaryGlowRgb,
    badgeBg: `rgba(${preset.glowRgb}, 0.18)`,
    borderGlow: `rgba(${preset.glowRgb}, 0.42)`,
  };
}

function buildAlbumIdSlug(albumTitle: string, albumArtist: string): string {
  const input = `${albumTitle.normalize('NFC').toLowerCase()}::${albumArtist.normalize('NFC').toLowerCase()}`;
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `alb-local-${(h >>> 0).toString(16)}`;
}

function mapPlaylistRecordToUi(record: PlaylistRecord): PrototypePlaylist {
  const mins = Math.round(record.totalDurationMs / 60000);
  const durationNote = mins > 0 ? ` · ${mins} phút` : '';
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    trackIds: [...record.trackIds],
    entries: record.entries,
    updatedLabel: `${record.trackCount} bài hát${durationNote}`,
    coverUrl: record.artworkUrl,
    hasCustomArtwork: record.hasCustomArtwork,
    trackCount: record.trackCount,
    totalDurationMs: record.totalDurationMs,
    availableCount: record.availableCount,
    missingCount: record.missingCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export const DEFAULT_DISPLAY_NAME = 'Người nghe nhạc';
export const MAX_DISPLAY_NAME_LENGTH = 48;

export interface StoredCustomLyricsEntry {
  format: 'lrc' | 'txt';
  content: string;
}

function safeReadJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as T;
    return parsed !== null && parsed !== undefined ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function safeWriteJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota issues in restricted environments
  }
}

function loadStoredCustomLyrics(): Record<string, StoredCustomLyricsEntry> {
  const v2 = safeReadJson<Record<string, StoredCustomLyricsEntry>>(CUSTOM_LYRICS_V2_KEY, {});
  if (Object.keys(v2).length > 0) {
    return v2;
  }
  const legacy = safeReadJson<Record<string, Array<{ timeSec: number; text: string }>>>(
    LEGACY_CUSTOM_LYRICS_KEY,
    {},
  );
  const migrated: Record<string, StoredCustomLyricsEntry> = {};
  for (const [trackId, lines] of Object.entries(legacy)) {
    if (!Array.isArray(lines) || lines.length === 0) {
      continue;
    }
    const lrc = lines
      .map((l) => {
        const mins = String(Math.floor(l.timeSec / 60)).padStart(2, '0');
        const secs = String(Math.floor(l.timeSec % 60)).padStart(2, '0');
        return `[${mins}:${secs}.00] ${l.text}`;
      })
      .join('\n');
    migrated[trackId] = { format: 'lrc', content: lrc };
  }
  return migrated;
}

function sanitizeClientDisplayName(raw: string): string {
  if (typeof raw !== 'string') {
    return DEFAULT_DISPLAY_NAME;
  }
  const cleaned = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    return DEFAULT_DISPLAY_NAME;
  }
  return Array.from(cleaned).slice(0, MAX_DISPLAY_NAME_LENGTH).join('');
}

const DEFAULT_PROFILE: LocalUserProfile = {
  displayName: DEFAULT_DISPLAY_NAME,
  avatarUrl: null,
  avatarMime: null,
  avatarIsAnimated: false,
  avatarHash: null,
  updatedAt: new Date(0).toISOString(),
};

const DEFAULT_PREFERENCES: PersonalizationPreferences = {
  themeMode: 'dark',
  accentPresetId: 'violet',
  customAccentHex: null,
  homeBackgroundMode: 'dynamic',
  customBackgroundUrl: null,
  customBackgroundHash: null,
  dynamicAlbumColors: true,
  vinylAnimation: true,
  reducedMotion: false,
  reduceMotionStaticGif: true,
  backgroundEffects: true,
  uiQualityPreset: 'balanced',
  transition: {
    enabled: false,
    durationSec: 1,
  },
  replayGain: { ...DEFAULT_REPLAYGAIN_SETTINGS },
  audioLab: createDefaultAudioLabSettings(),
  playbackControls: { ...DEFAULT_PLAYBACK_CONTROLS },
  autoContinueEnabled: true,
  editorialTypography: { ...DEFAULT_EDITORIAL_TYPOGRAPHY },
  editorialFonts: [],
};

function loadInitialProfile(): LocalUserProfile {
  const stored = safeReadJson<Partial<LocalUserProfile>>(PROFILE_STORAGE_KEY, {});
  return {
    ...DEFAULT_PROFILE,
    ...stored,
    displayName: sanitizeClientDisplayName(stored.displayName ?? DEFAULT_DISPLAY_NAME),
  };
}

function loadInitialPreferences(): PersonalizationPreferences {
  const stored = safeReadJson<Partial<PersonalizationPreferences>>(PREFERENCES_STORAGE_KEY, {});
  const validDurations = new Set<FadeDurationSec>([0.5, 1, 2, 3]);
  const rawDur = stored.transition?.durationSec;
  const editorialFonts: CustomEditorialFontRecord[] = Array.isArray(stored.editorialFonts)
    ? stored.editorialFonts.filter(
        (f): f is CustomEditorialFontRecord =>
          Boolean(f && typeof f.id === 'string' && typeof f.url === 'string'),
      )
    : [];
  const validFontIds = new Set(editorialFonts.map((f) => f.id));

  return {
    ...DEFAULT_PREFERENCES,
    ...stored,
    themeMode: stored.themeMode === 'light' ? 'light' : 'dark',
    customAccentHex: normalizeHexColor(stored.customAccentHex),
    homeBackgroundMode:
      stored.homeBackgroundMode === 'custom' && stored.customBackgroundUrl
        ? 'custom'
        : stored.homeBackgroundMode === 'default'
          ? 'default'
          : 'dynamic',
    uiQualityPreset:
      stored.uiQualityPreset === 'high' ||
      stored.uiQualityPreset === 'balanced' ||
      stored.uiQualityPreset === 'power-saver'
        ? stored.uiQualityPreset
        : 'balanced',
    transition: {
      enabled: Boolean(stored.transition?.enabled),
      durationSec: rawDur && validDurations.has(rawDur) ? rawDur : 1,
    },
    replayGain: normalizeReplayGainSettings(stored.replayGain),
    audioLab: normalizeAudioLabSettings(stored.audioLab),
    playbackControls: normalizePlaybackControls(stored.playbackControls),
    autoContinueEnabled:
      typeof stored.autoContinueEnabled === 'boolean' ? stored.autoContinueEnabled : true,
    editorialTypography: normalizeEditorialTypographySettings(
      stored.editorialTypography,
      validFontIds,
    ),
    editorialFonts,
  };
}

function loadInitialPlaylists(): PrototypePlaylist[] {
  if (typeof window === 'undefined') {
    return [];
  }
  const raw = window.localStorage.getItem(PLAYLISTS_STORAGE_KEY);
  if (raw === null) {
    window.localStorage.setItem(PLAYLISTS_DEMO_PURGED_KEY, '1');
    return [];
  }
  const stored = safeReadJson<PrototypePlaylist[]>(PLAYLISTS_STORAGE_KEY, []);
  if (!Array.isArray(stored)) {
    return [];
  }
  // Safe idempotent cleanup of confirmed prototype playlists & track IDs
  const alreadyPurged = window.localStorage.getItem(PLAYLISTS_DEMO_PURGED_KEY) === '1';
  const cleaned = stored
    .filter((pl) => pl && typeof pl.name === 'string' && !isConfirmedDemoPlaylistId(pl.id))
    .map((pl) => {
      const nextTrackIds = Array.isArray(pl.trackIds)
        ? pl.trackIds.filter((id) => !isConfirmedDemoTrackId(id))
        : [];
      return {
        ...pl,
        trackIds: nextTrackIds,
        updatedLabel: `${nextTrackIds.length} bài hát`,
      };
    });

  if (!alreadyPurged) {
    safeWriteJson(PLAYLISTS_STORAGE_KEY, cleaned);
    window.localStorage.setItem(PLAYLISTS_DEMO_PURGED_KEY, '1');
  }
  return cleaned;
}

function loadInitialSessions(): StoredListeningSession[] {
  const stored = safeReadJson<StoredListeningSession[]>(LISTENING_SESSIONS_KEY, []);
  if (!Array.isArray(stored)) {
    return [];
  }
  return stored.filter((s) => s && !isConfirmedDemoTrackId(s.trackId));
}

function hashStringToIndex(input: string, modulo: number): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % Math.max(1, modulo);
}

export type AppRoute =
  | 'home'
  | 'library'
  | 'album-detail'
  | 'playlist-detail'
  | 'artist-detail'
  | 'now-playing'
  | 'audio-lab'
  | 'search'
  | 'statistics'
  | 'server'
  | 'settings'
  | 'profile';

export type { RepeatMode };

export type NowPlayingRightTab = 'lyrics' | 'queue' | 'info';

export type NowPlayingDisplayMode = 'standard' | 'focus';

export type VinylSwapPhase =
  | 'idle'
  | 'tonearm-lift'
  | 'disc-out'
  | 'empty-platter'
  | 'disc-in'
  | 'tonearm-drop';

export interface AppearanceSettings {
  dynamicAlbumColors: boolean;
  vinylAnimation: boolean;
  reducedMotion: boolean;
  backgroundEffects: boolean;
}

export interface UiStoreState {
  route: AppRoute;
  previousRoute: AppRoute;
  /** Centered index in the Home Editorial Playlist Gallery */
  selectedGalleryIndex: number;
  /** Centered index in the Library Albums 3D Square Coverflow */
  selectedAlbumCoverflowIndex: number;
  selectedAlbumId: string;
  selectedPlaylistId: string | null;
  selectedArtistName: string;
  libraryTab: 'songs' | 'albums' | 'artists' | 'folders' | 'playlists' | 'favorites';
  searchQuery: string;
  isQueueOpen: boolean;

  // Stage 5: Unified Local Profile & Personalization Preferences
  profile: LocalUserProfile;
  preferences: PersonalizationPreferences;

  // Prototype playback state (real Electron AudioEngine used for local SQLite tracks)
  activeSource: 'sample' | 'local';
  activeSampleTrackId: string;
  sampleIsPlaying: boolean;
  sampleCurrentTimeSec: number;
  sampleVolume: number;
  sampleMuted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  autoNext: boolean;
  queueTrackIds: string[];

  // Now Playing & Vinyl Swap
  showLyricsPanel: boolean;
  nowPlayingRightTab: NowPlayingRightTab;
  nowPlayingMode: NowPlayingDisplayMode;
  nowPlayingSidebarRevealed: boolean;
  /** Phase 4.3B: In-session Focus Lyrics Browse preservation across blur/background/remount */
  focusLyricsBrowse: { trackId: string; viewedIndex: number } | null;
  vinylSwapPhase: VinylSwapPhase;
  vinylDisplayTrackId: string;

  // Offline web-preview fallback overrides (Electron local tracks persist directly in SQLite + userData)
  customLyricsByTrackId: Record<string, StoredCustomLyricsEntry>;
  customCoversByTrackId: Record<string, string>;
  metadataOverridesByTrackId: Record<string, TrackMetadataOverrideInput>;

  // User organization
  favoriteIds: string[];
  playlists: PrototypePlaylist[];
  recentlyPlayedIds: string[];
  toastMessage: string | null;

  // Stage 5: Real persisted listening history sessions (100% real data, zero fake stats)
  listeningSessions: StoredListeningSession[];
  statsVersion: number;

  // Derived alias for backward compatibility with existing components
  appearance: AppearanceSettings;
}

class UiStore {
  private state: UiStoreState;
  private readonly listeners = new Set<() => void>();
  private cachedTracksSourceRef: TrackRecord[] | null = null;
  private cachedUnifiedTracks: PrototypeTrack[] = [];
  private cachedUnifiedTrackMap: Map<string, PrototypeTrack> = new Map();
  private cachedDerivedAlbums: PrototypeAlbum[] = [];
  private cachedDerivedAlbumMap: Map<string, PrototypeAlbum> = new Map();
  private cachedAlbumTrackCounts: Map<string, number> = new Map();
  private cachedFavoriteIdsRef: string[] | null = null;
  private cachedFavoriteIdSet: Set<string> = new Set();
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private audioLabIpcTimer: ReturnType<typeof setTimeout> | null = null;
  private hydratedFromElectron = false;

  constructor() {
    const initialPrefs = loadInitialPreferences();
    const initialProfile = loadInitialProfile();
    const initialPlaylists = loadInitialPlaylists();
    const initialControls = normalizePlaybackControls(
      initialPrefs.playbackControls,
      DEFAULT_PLAYBACK_CONTROLS,
    );
    const sessionPresentation = readSessionPresentation();
    const initialMode: NowPlayingDisplayMode = sessionPresentation?.nowPlayingMode ?? 'standard';
    const initialRightTab: NowPlayingRightTab = sessionPresentation?.nowPlayingRightTab ?? 'lyrics';

    this.state = {
      route: sessionPresentation?.route ?? 'home',
      previousRoute: sessionPresentation?.previousRoute ?? 'home',
      selectedGalleryIndex: 0,
      selectedAlbumCoverflowIndex: 0,
      selectedAlbumId: '',
      selectedPlaylistId: null,
      selectedArtistName: '',
      libraryTab: 'songs',
      searchQuery: '',
      isQueueOpen: false,

      profile: initialProfile,
      preferences: initialPrefs,

      activeSource: 'local',
      activeSampleTrackId: '',
      sampleIsPlaying: false,
      sampleCurrentTimeSec: 0,
      sampleVolume: 0.82,
      sampleMuted: false,
      shuffle: initialControls.shuffleEnabled,
      repeat: initialControls.repeatMode,
      autoNext: initialControls.autoNextEnabled,
      queueTrackIds: [],

      showLyricsPanel: initialRightTab === 'lyrics',
      nowPlayingRightTab: initialRightTab,
      nowPlayingMode: initialMode,
      nowPlayingSidebarRevealed: (sessionPresentation?.route ?? 'home') !== 'now-playing',
      focusLyricsBrowse: sessionPresentation?.focusLyricsBrowse ?? null,
      vinylSwapPhase: 'idle',
      vinylDisplayTrackId: '',
      customLyricsByTrackId: loadStoredCustomLyrics(),
      customCoversByTrackId: safeReadJson<Record<string, string>>(CUSTOM_COVERS_KEY, {}),
      metadataOverridesByTrackId: safeReadJson<Record<string, TrackMetadataOverrideInput>>(
        METADATA_OVERRIDES_KEY,
        {},
      ),

      favoriteIds: [],
      playlists: typeof window !== 'undefined' && window.losslessApi ? [] : initialPlaylists,
      recentlyPlayedIds: [],
      toastMessage: null,

      listeningSessions: loadInitialSessions(),
      statsVersion: 0,

      appearance: {
        dynamicAlbumColors: initialPrefs.dynamicAlbumColors,
        vinylAnimation: initialPrefs.vinylAnimation,
        reducedMotion: initialPrefs.reducedMotion,
        backgroundEffects: initialPrefs.backgroundEffects,
      },
    };

    // Sync initial Fade In/Out, Audio Lab DSP, ReplayGain, and Playback Controls into AudioEngine + Single Queue Controller
    playerActions.setTransitionConfig(initialPrefs.transition);
    playerActions.setAudioLabSettings(
      normalizeAudioLabSettings(initialPrefs.audioLab),
    );
    playerActions.setReplayGainSettings(
      normalizeReplayGainSettings(initialPrefs.replayGain),
    );
    playbackQueueController.setTrackPlayableChecker((trackId) => this.isTrackIdPlayable(trackId));
    playbackQueueController.setTrackMetadataResolver((trackId) =>
      this.resolveTrackMetaForShuffle(trackId),
    );
    playerActions.setPlaybackControls(initialControls);
    playerActions.setAutoContinueEnabled(initialPrefs.autoContinueEnabled ?? true);
    playerActions.setAutoContinueResolver((req) => this.resolveAutoContinuePlan(req));

    playbackQueueController.subscribe((qState) => {
      const nextIds: string[] = [];
      if (qState.currentEntry) {
        nextIds.push(qState.currentEntry.trackId);
      }
      for (const item of qState.upcoming) {
        nextIds.push(item.trackId);
      }
      if (
        qState.controls.shuffleEnabled !== this.state.shuffle ||
        qState.controls.repeatMode !== this.state.repeat ||
        qState.controls.autoNextEnabled !== this.state.autoNext ||
        nextIds.length !== this.state.queueTrackIds.length ||
        nextIds.some((id, idx) => id !== this.state.queueTrackIds[idx])
      ) {
        this.setState({
          shuffle: qState.controls.shuffleEnabled,
          repeat: qState.controls.repeatMode,
          autoNext: qState.controls.autoNextEnabled,
          queueTrackIds: nextIds,
        });
      }
    });

    // External queue entry callback (no prototype fallback in Phase 3)
    setExternalQueueEntryListener((_entry) => {
      // Reserved for future local sources; nothing to synthesize in pure offline mode.
    });

    // Keep Favorites / Playlists synchronized ONLY when Library tracks array actually changes
    // (avoid firing redundant IPC snapshot calls on every scanProgress tick)
    let lastTracksRef = libraryStore.getSnapshot().tracks;
    libraryStore.subscribe(() => {
      const snap = libraryStore.getSnapshot();
      if (snap.tracks === lastTracksRef) {
        return;
      }
      lastTracksRef = snap.tracks;
      if (this.state.playlists.length > 0 || this.state.favoriteIds.length > 0 || snap.tracks.length > 0) {
        if (typeof window !== 'undefined' && window.losslessApi?.getPlaylistSnapshot) {
          void this.refreshPlaylistsAndFavorites();
        } else {
          const validIds = new Set(snap.tracks.map((t) => t.id));
          const filteredFavs = this.state.favoriteIds.filter((id) => validIds.has(id));
          if (filteredFavs.length !== this.state.favoriteIds.length) {
            this.setState({ favoriteIds: filteredFavs });
            return;
          }
        }
      }
      this.emit();
    });

    // Mirror Electron local audio session checkpoints so Statistics view stays reactive
    setLocalSessionCheckpointListener((session) => {
      this.upsertLocalListeningSession(session, false);
    });
  }

  getSnapshot = (): UiStoreState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private setState(partial: Partial<UiStoreState>): void {
    const prev = this.state;
    this.state = { ...prev, ...partial };
    if (
      partial.route !== undefined ||
      partial.previousRoute !== undefined ||
      partial.nowPlayingMode !== undefined ||
      partial.nowPlayingRightTab !== undefined ||
      partial.focusLyricsBrowse !== undefined
    ) {
      writeSessionPresentation({
        route: this.state.route,
        previousRoute: this.state.previousRoute,
        nowPlayingMode: this.state.nowPlayingMode,
        nowPlayingRightTab: this.state.nowPlayingRightTab,
        focusLyricsBrowse: this.state.focusLyricsBrowse,
      });
    }
    this.emit();
  }

  /**
   * Hydrates profile & preferences from Electron SQLite once on app startup.
   */
  async hydrateFromDesktop(): Promise<void> {
    if (this.hydratedFromElectron || typeof window === 'undefined' || !window.losslessApi) {
      return;
    }
    this.hydratedFromElectron = true;
    try {
      const legacyPlaylists = loadInitialPlaylists();
      const rawFavs = this.state.favoriteIds.filter(
        (id) => !isConfirmedDemoTrackId(id) && !isConfirmedDemoAlbumId(id),
      );
      if (window.losslessApi.migrateLegacyCollectionsToSqlite) {
        await window.losslessApi.migrateLegacyCollectionsToSqlite({
          playlists: legacyPlaylists.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            trackIds: p.trackIds,
          })),
          favoriteIds: rawFavs,
        });
      }

      const [profile, preferences, playlistSnap] = await Promise.all([
        window.losslessApi.getProfile(),
        window.losslessApi.getPreferences(),
        window.losslessApi.getPlaylistSnapshot
          ? window.losslessApi.getPlaylistSnapshot()
          : Promise.resolve(null),
      ]);
      const normalizedPreferences: PersonalizationPreferences = {
        ...preferences,
        replayGain: normalizeReplayGainSettings(preferences.replayGain),
        audioLab: normalizeAudioLabSettings(preferences.audioLab),
        playbackControls: normalizePlaybackControls(preferences.playbackControls),
        autoContinueEnabled:
          typeof preferences.autoContinueEnabled === 'boolean'
            ? preferences.autoContinueEnabled
            : true,
      };
      playerActions.setTransitionConfig(normalizedPreferences.transition);
      playerActions.setAudioLabSettings(normalizedPreferences.audioLab!);
      playerActions.setReplayGainSettings(normalizedPreferences.replayGain!);
      playerActions.setPlaybackControls(normalizedPreferences.playbackControls!);
      playerActions.setAutoContinueEnabled(normalizedPreferences.autoContinueEnabled ?? true);
      safeWriteJson(PREFERENCES_STORAGE_KEY, normalizedPreferences);

      const nextPlaylists = playlistSnap
        ? playlistSnap.playlists.map(mapPlaylistRecordToUi)
        : this.state.playlists;
      const nextFavs = playlistSnap ? playlistSnap.favoriteTrackIds : this.state.favoriteIds;

      this.setState({
        profile,
        preferences: normalizedPreferences,
        playlists: nextPlaylists,
        favoriteIds: nextFavs,
        shuffle: normalizedPreferences.playbackControls!.shuffleEnabled,
        repeat: normalizedPreferences.playbackControls!.repeatMode,
        autoNext: normalizedPreferences.playbackControls!.autoNextEnabled,
        appearance: {
          dynamicAlbumColors: normalizedPreferences.dynamicAlbumColors,
          vinylAnimation: normalizedPreferences.vinylAnimation,
          reducedMotion: normalizedPreferences.reducedMotion,
          backgroundEffects: normalizedPreferences.backgroundEffects,
        },
      });
    } catch {
      // Fallback safely to persisted localStorage values
    }
  }

  async refreshPlaylistsAndFavorites(): Promise<void> {
    if (typeof window === 'undefined' || !window.losslessApi?.getPlaylistSnapshot) {
      return;
    }
    try {
      const snap = await window.losslessApi.getPlaylistSnapshot();
      const mapped = snap.playlists.map(mapPlaylistRecordToUi);
      const maxIdx = Math.max(0, mapped.length - 1);
      const selectedStillExists =
        this.state.selectedPlaylistId !== null &&
        mapped.some((p) => p.id === this.state.selectedPlaylistId);
      this.setState({
        playlists: mapped,
        favoriteIds: snap.favoriteTrackIds,
        selectedGalleryIndex: Math.min(this.state.selectedGalleryIndex, maxIdx),
        selectedPlaylistId: selectedStillExists ? this.state.selectedPlaylistId : null,
      });
    } catch {
      // Ignore transient IPC refresh error
    }
  }

  showToast(message: string): void {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
    }
    this.setState({ toastMessage: message });
    this.toastTimer = setTimeout(() => {
      this.setState({ toastMessage: null });
    }, 3400);
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  navigate(route: AppRoute): void {
    if (route === this.state.route) {
      return;
    }
    const previousRoute =
      this.state.route === 'now-playing' ? this.state.previousRoute : this.state.route;
    this.setState({
      route,
      previousRoute,
      isQueueOpen: route === 'now-playing' ? false : this.state.isQueueOpen,
    });
  }

  openProfileHub(): void {
    this.navigate('profile');
  }

  openLibraryTab(tab: UiStoreState['libraryTab']): void {
    this.setState({
      route: 'library',
      previousRoute:
        this.state.route === 'now-playing' ? this.state.previousRoute : this.state.route,
      libraryTab: tab,
    });
  }

  openAlbumDetail(albumId: string): void {
    const albums = this.getDerivedAlbums();
    const albumIndex = albums.findIndex((a) => a.id === albumId);
    this.setState({
      route: 'album-detail',
      previousRoute:
        this.state.route === 'now-playing' ? this.state.previousRoute : this.state.route,
      selectedAlbumId: albumId,
      selectedAlbumCoverflowIndex:
        albumIndex >= 0 ? albumIndex : this.state.selectedAlbumCoverflowIndex,
    });
  }

  openPlaylistDetail(playlistId: string): void {
    const idx = this.state.playlists.findIndex((p) => p.id === playlistId);
    this.setState({
      route: 'playlist-detail',
      previousRoute:
        this.state.route === 'now-playing' ? this.state.previousRoute : this.state.route,
      selectedPlaylistId: playlistId,
      selectedGalleryIndex: idx >= 0 ? idx : this.state.selectedGalleryIndex,
    });
  }

  openArtistDetail(artistName: string): void {
    this.setState({
      route: 'artist-detail',
      previousRoute:
        this.state.route === 'now-playing' ? this.state.previousRoute : this.state.route,
      selectedArtistName: artistName,
    });
  }

  openNowPlaying(withLyrics?: boolean): void {
    const currentTab: NowPlayingRightTab =
      this.state.nowPlayingRightTab === 'queue' ? 'queue' : 'lyrics';
    const targetTab: NowPlayingRightTab =
      typeof withLyrics === 'boolean' ? (withLyrics ? 'lyrics' : 'queue') : currentTab;
    this.setState({
      previousRoute:
        this.state.route === 'now-playing' ? this.state.previousRoute : this.state.route,
      route: 'now-playing',
      isQueueOpen: false,
      showLyricsPanel: targetTab === 'lyrics',
      nowPlayingRightTab: targetTab,
      nowPlayingSidebarRevealed: false,
    });
  }

  closeNowPlaying(): void {
    const target = this.state.previousRoute === 'now-playing' ? 'home' : this.state.previousRoute;
    this.setState({ route: target, nowPlayingMode: 'standard', nowPlayingSidebarRevealed: true });
  }

  setNowPlayingRightTab(tab: NowPlayingRightTab): void {
    this.setState({
      nowPlayingRightTab: tab,
      showLyricsPanel: tab === 'lyrics',
    });
  }

  setNowPlayingSidebarRevealed(revealed: boolean): void {
    if (this.state.nowPlayingSidebarRevealed === revealed) {
      return;
    }
    this.setState({ nowPlayingSidebarRevealed: revealed });
  }

  setNowPlayingMode(mode: NowPlayingDisplayMode): void {
    const patch = resolveNextNowPlayingModePatch(
      this.state.route,
      this.state.nowPlayingMode,
      mode,
    );
    if (!patch) {
      return;
    }
    this.setState(patch);
  }

  setFocusLyricsBrowseState(next: { trackId: string; viewedIndex: number } | null): void {
    const curr = this.state.focusLyricsBrowse;
    if (
      (curr === null && next === null) ||
      (curr !== null &&
        next !== null &&
        curr.trackId === next.trackId &&
        curr.viewedIndex === next.viewedIndex)
    ) {
      return;
    }
    this.setState({ focusLyricsBrowse: next });
  }

  toggleNowPlayingFocusMode(): void {
    this.setNowPlayingMode(this.state.nowPlayingMode === 'focus' ? 'standard' : 'focus');
  }

  selectGalleryIndex(index: number): void {
    const total = this.state.playlists.length;
    if (total === 0) {
      this.setState({ selectedGalleryIndex: 0 });
      return;
    }
    const normalized = ((index % total) + total) % total;
    const playlist = this.state.playlists[normalized];
    this.setState({
      selectedGalleryIndex: normalized,
      selectedPlaylistId: playlist?.id ?? this.state.selectedPlaylistId,
    });
  }

  stepGallery(delta: number): void {
    if (this.state.playlists.length <= 1) {
      return;
    }
    this.selectGalleryIndex(this.state.selectedGalleryIndex + delta);
  }

  selectAlbumCoverflowIndex(index: number): void {
    const albums = this.getDerivedAlbums();
    const total = albums.length;
    if (total === 0) {
      return;
    }
    const normalized = ((index % total) + total) % total;
    this.setState({
      selectedAlbumCoverflowIndex: normalized,
      selectedAlbumId: albums[normalized].id,
    });
  }

  setSearchQuery(query: string): void {
    this.setState({ searchQuery: query });
  }

  toggleQueue(force?: boolean): void {
    this.setState({
      isQueueOpen: typeof force === 'boolean' ? force : !this.state.isQueueOpen,
    });
  }

  toggleLyricsPanel(force?: boolean): void {
    const next = typeof force === 'boolean' ? force : !this.state.showLyricsPanel;
    this.setState({
      showLyricsPanel: next,
      nowPlayingRightTab: next ? 'lyrics' : 'info',
    });
  }

  // ---------------------------------------------------------------------------
  // Stage 5: Local Profile & Personalization Hub (Single Source of Truth)
  // ---------------------------------------------------------------------------

  async updateDisplayName(rawName: string): Promise<void> {
    const sanitized = sanitizeClientDisplayName(rawName);
    if (typeof window !== 'undefined' && window.losslessApi) {
      try {
        const updated = await window.losslessApi.updateProfileDisplayName(sanitized);
        this.setState({ profile: updated });
        this.showToast(`Đã cập nhật tên hiển thị "${updated.displayName}"`);
        return;
      } catch {
        // Fall through to local persistence
      }
    }
    const nextProfile: LocalUserProfile = {
      ...this.state.profile,
      displayName: sanitized,
      updatedAt: new Date().toISOString(),
    };
    safeWriteJson(PROFILE_STORAGE_KEY, nextProfile);
    this.setState({ profile: nextProfile });
    this.showToast(`Đã cập nhật tên hiển thị "${sanitized}"`);
  }

  async importProfileAvatarDesktop(): Promise<void> {
    if (typeof window !== 'undefined' && window.losslessApi) {
      const result = await window.losslessApi.importProfileAvatar();
      if (result.canceled) {
        return;
      }
      if (result.error) {
        this.showToast(result.error);
        return;
      }
      if (result.profile) {
        this.setState({ profile: result.profile });
        this.showToast(
          result.profile.avatarIsAnimated
            ? 'Đã cập nhật avatar GIF động'
            : 'Đã cập nhật ảnh đại diện',
        );
      }
    }
  }

  setWebProfileAvatar(dataUrl: string, mime: string, isAnimated: boolean): void {
    const nextProfile: LocalUserProfile = {
      ...this.state.profile,
      avatarUrl: dataUrl,
      avatarMime: mime,
      avatarIsAnimated: isAnimated,
      avatarHash: String(Date.now()),
      updatedAt: new Date().toISOString(),
    };
    safeWriteJson(PROFILE_STORAGE_KEY, nextProfile);
    this.setState({ profile: nextProfile });
    this.showToast(isAnimated ? 'Đã cập nhật avatar GIF động' : 'Đã cập nhật ảnh đại diện');
  }

  async removeProfileAvatar(): Promise<void> {
    if (typeof window !== 'undefined' && window.losslessApi) {
      try {
        const updated = await window.losslessApi.removeProfileAvatar();
        this.setState({ profile: updated });
        this.showToast('Đã xóa ảnh đại diện');
        return;
      } catch {
        // fallback below
      }
    }
    const nextProfile: LocalUserProfile = {
      ...this.state.profile,
      avatarUrl: null,
      avatarMime: null,
      avatarIsAnimated: false,
      avatarHash: null,
      updatedAt: new Date().toISOString(),
    };
    safeWriteJson(PROFILE_STORAGE_KEY, nextProfile);
    this.setState({ profile: nextProfile });
    this.showToast('Đã xóa ảnh đại diện');
  }

  updatePreferences(partial: Partial<PersonalizationPreferences>): void {
    const current = this.state.preferences;
    const nextFonts = partial.editorialFonts ?? current.editorialFonts;
    const validFontIds = new Set(nextFonts.map((f) => f.id));
    const merged: PersonalizationPreferences = {
      ...current,
      ...partial,
      transition: {
        ...current.transition,
        ...(partial.transition ?? {}),
      },
      replayGain: normalizeReplayGainSettings({
        ...(current.replayGain ?? DEFAULT_REPLAYGAIN_SETTINGS),
        ...(partial.replayGain ?? {}),
      }),
      audioLab: normalizeAudioLabSettings(
        partial.audioLab !== undefined ? partial.audioLab : current.audioLab,
      ),
      playbackControls: normalizePlaybackControls(
        partial.playbackControls
          ? {
              ...(current.playbackControls ?? DEFAULT_PLAYBACK_CONTROLS),
              ...partial.playbackControls,
            }
          : current.playbackControls,
      ),
      editorialTypography: normalizeEditorialTypographySettings(
        {
          ...current.editorialTypography,
          ...(partial.editorialTypography ?? {}),
        },
        validFontIds,
      ),
      editorialFonts: nextFonts,
    };
    if (partial.customAccentHex !== undefined) {
      merged.customAccentHex = normalizeHexColor(partial.customAccentHex);
    }

    safeWriteJson(PREFERENCES_STORAGE_KEY, merged);
    playerActions.setTransitionConfig(merged.transition);
    if (merged.audioLab) {
      playerActions.setAudioLabSettings(merged.audioLab);
    }
    if (merged.replayGain) {
      playerActions.setReplayGainSettings(merged.replayGain);
    }

    this.setState({
      preferences: merged,
      appearance: {
        dynamicAlbumColors: merged.dynamicAlbumColors,
        vinylAnimation: merged.vinylAnimation,
        reducedMotion: merged.reducedMotion,
        backgroundEffects: merged.backgroundEffects,
      },
    });

    if (typeof window !== 'undefined' && window.losslessApi) {
      const ipcPartial: Partial<PersonalizationPreferences> = { ...partial };
      delete ipcPartial.editorialFonts;
      void window.losslessApi
        .updatePreferences(ipcPartial)
        .then((persisted) => {
          const normalizedPersisted: PersonalizationPreferences = {
            ...persisted,
            replayGain: normalizeReplayGainSettings(persisted.replayGain),
            audioLab: normalizeAudioLabSettings(persisted.audioLab),
            // Keep latest synchronous queue controls so rapid clicks never revert from stale IPC
            playbackControls: this.state.preferences.playbackControls,
          };
          playerActions.setTransitionConfig(normalizedPersisted.transition);
          playerActions.setAudioLabSettings(normalizedPersisted.audioLab!);
          playerActions.setReplayGainSettings(normalizedPersisted.replayGain!);
          this.setState({
            preferences: normalizedPersisted,
            appearance: {
              dynamicAlbumColors: normalizedPersisted.dynamicAlbumColors,
              vinylAnimation: normalizedPersisted.vinylAnimation,
              reducedMotion: normalizedPersisted.reducedMotion,
              backgroundEffects: normalizedPersisted.backgroundEffects,
            },
          });
        })
        .catch(() => {});
    }
  }

  updateEditorialTypography(partial: Partial<EditorialTypographySettings>): void {
    this.updatePreferences({
      editorialTypography: {
        ...this.state.preferences.editorialTypography,
        ...partial,
      },
    });
  }

  restoreDefaultEditorialTypography(): void {
    this.updatePreferences({
      editorialTypography: { ...DEFAULT_EDITORIAL_TYPOGRAPHY },
    });
    this.showToast('Đã khôi phục chữ nền trang chủ về mặc định');
  }

  selectEditorialFont(fontId: string | null): void {
    this.updateEditorialTypography({ selectedFontId: fontId });
  }

  async importEditorialFontDesktop(): Promise<void> {
    if (typeof window === 'undefined' || !window.losslessApi) {
      return;
    }
    const result = await window.losslessApi.importEditorialFont();
    if (result.canceled) {
      return;
    }
    if (result.error) {
      this.showToast(result.error);
      return;
    }
    if (result.preferences) {
      safeWriteJson(PREFERENCES_STORAGE_KEY, result.preferences);
      this.setState({ preferences: result.preferences });
      if (result.font) {
        const loaded = await ensureEditorialFontLoaded(result.font);
        if (loaded.failed) {
          this.showToast(
            `Không thể tải font "${result.font.name}". Đã chuyển về font mặc định DoReMi.`,
          );
          this.selectEditorialFont(null);
          return;
        }
        this.showToast(`Đã áp dụng font chữ nền "${result.font.name}"`);
      }
    }
  }

  async importWebEditorialFont(file: File): Promise<boolean> {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const validated = validateEditorialFontBytes(bytes, file.name, MAX_EDITORIAL_FONT_BYTES);

      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error('Không thể đọc dữ liệu file font.'));
        reader.readAsDataURL(file);
      });

      const hash = `${bytes.length.toString(16)}_${Date.now().toString(36)}`;
      const fontId = `font_${hash}`;
      const record: CustomEditorialFontRecord = {
        id: fontId,
        name: validated.displayName,
        fileName: file.name,
        format: validated.format,
        mimeType: validated.mimeType,
        url: dataUrl,
        hash,
        sizeBytes: bytes.length,
        addedAt: new Date().toISOString(),
      };

      const loadResult = await ensureEditorialFontLoaded(record);
      if (loadResult.failed) {
        this.showToast('File font không thể nạp vào trình duyệt. Đã giữ nguyên font mặc định.');
        return false;
      }

      const nextFonts = [
        record,
        ...this.state.preferences.editorialFonts.filter((f) => f.fileName !== file.name),
      ].slice(0, 12);

      this.updatePreferences({
        editorialFonts: nextFonts,
        editorialTypography: {
          ...this.state.preferences.editorialTypography,
          selectedFontId: record.id,
        },
      });
      this.showToast(`Đã áp dụng font chữ nền "${record.name}"`);
      return true;
    } catch (error) {
      this.showToast(
        error instanceof Error ? error.message : 'Định dạng font không hợp lệ hoặc bị hỏng.',
      );
      return false;
    }
  }

  async deleteEditorialFont(fontId: string): Promise<void> {
    unloadEditorialFont(fontId);
    if (typeof window !== 'undefined' && window.losslessApi) {
      try {
        const persisted = await window.losslessApi.deleteEditorialFont(fontId);
        safeWriteJson(PREFERENCES_STORAGE_KEY, persisted);
        this.setState({ preferences: persisted });
        this.showToast('Đã xóa font chữ nền tùy chỉnh');
        return;
      } catch {
        // Fallback to local state below
      }
    }
    const nextFonts = this.state.preferences.editorialFonts.filter((f) => f.id !== fontId);
    const wasSelected = this.state.preferences.editorialTypography.selectedFontId === fontId;
    this.updatePreferences({
      editorialFonts: nextFonts,
      editorialTypography: {
        ...this.state.preferences.editorialTypography,
        selectedFontId: wasSelected
          ? null
          : this.state.preferences.editorialTypography.selectedFontId,
      },
    });
    this.showToast('Đã xóa font chữ nền tùy chỉnh');
  }

  updateAppearance(partial: Partial<AppearanceSettings>): void {
    this.updatePreferences(partial);
  }

  updateTransitionSettings(partial: { enabled?: boolean; durationSec?: FadeDurationSec }): void {
    this.updatePreferences({
      transition: {
        ...this.state.preferences.transition,
        ...partial,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 7: Audio Lab DSP & ReplayGain (Single Source of Truth -> AudioEngine)
  // ---------------------------------------------------------------------------

  getAudioLabSettings(): AudioLabSettings {
    return normalizeAudioLabSettings(this.state.preferences.audioLab);
  }

  getReplayGainSettings(): ReplayGainSettings {
    return normalizeReplayGainSettings(this.state.preferences.replayGain);
  }

  private commitAudioLabSettings(next: AudioLabSettings, debounceIpc = false): void {
    const normalized = normalizeAudioLabSettings(next);
    const merged: PersonalizationPreferences = {
      ...this.state.preferences,
      audioLab: normalized,
    };

    // Immediate 0ms audio DSP update + localStorage mirror
    playerActions.setAudioLabSettings(normalized);
    safeWriteJson(PREFERENCES_STORAGE_KEY, merged);
    this.setState({ preferences: merged });

    if (typeof window !== 'undefined' && window.losslessApi) {
      if (this.audioLabIpcTimer) {
        clearTimeout(this.audioLabIpcTimer);
        this.audioLabIpcTimer = null;
      }
      const flush = () => {
        const latest = this.getAudioLabSettings();
        void window.losslessApi?.updatePreferences({ audioLab: latest }).catch(() => {});
      };
      if (debounceIpc) {
        this.audioLabIpcTimer = setTimeout(flush, 250);
      } else {
        flush();
      }
    }
  }

  setAudioLabEnabled(enabled: boolean): void {
    const current = this.getAudioLabSettings();
    if (current.enabled === enabled) {
      return;
    }
    this.commitAudioLabSettings({ ...current, enabled }, false);
    if (enabled && this.state.activeSource === 'local') {
      void playerActions.ensureDspReady();
    }
  }

  setEqMode(mode: EqMode): void {
    const current = this.getAudioLabSettings();
    const slotId = current.activeSlot;
    const slot = cloneEqSlotConfig(current.slots[slotId]);
    if (slot.mode === mode) {
      return;
    }
    slot.mode = mode;
    this.commitAudioLabSettings(
      {
        ...current,
        slots: { ...current.slots, [slotId]: slot },
      },
      false,
    );
  }

  setActiveEqSlot(slotId: EqSlotId): void {
    const current = this.getAudioLabSettings();
    if (current.activeSlot === slotId) {
      return;
    }
    this.commitAudioLabSettings({ ...current, activeSlot: slotId }, false);
  }

  copyActiveEqSlotToOther(): void {
    const current = this.getAudioLabSettings();
    const sourceId = current.activeSlot;
    const targetId: EqSlotId = sourceId === 'A' ? 'B' : 'A';
    this.commitAudioLabSettings(
      {
        ...current,
        slots: {
          ...current.slots,
          [targetId]: cloneEqSlotConfig(current.slots[sourceId]),
        },
      },
      false,
    );
    this.showToast(`Đã sao chép cấu hình Slot ${sourceId} sang Slot ${targetId}`);
  }

  setGraphicBandGain(bandIndex: number, gainDb: number): void {
    const current = this.getAudioLabSettings();
    const slotId = current.activeSlot;
    const slot = cloneEqSlotConfig(current.slots[slotId]);
    if (bandIndex < 0 || bandIndex >= slot.graphicGainsDb.length) {
      return;
    }
    const clamped = roundTo(clampFinite(gainDb, EQ_MIN_GAIN_DB, EQ_MAX_GAIN_DB, 0), 1);
    slot.graphicGainsDb[bandIndex] = clamped;
    slot.graphicGainsDb = sanitizeGraphicGains(slot.graphicGainsDb);
    slot.activePresetId = null;
    this.commitAudioLabSettings(
      {
        ...current,
        slots: { ...current.slots, [slotId]: slot },
      },
      true,
    );
  }

  resetGraphicBands(): void {
    const current = this.getAudioLabSettings();
    const slotId = current.activeSlot;
    const slot = cloneEqSlotConfig(current.slots[slotId]);
    slot.graphicGainsDb = createFlatGraphicGains();
    slot.activePresetId = slot.mode === 'graphic' && slot.preampDb === 0 ? 'sys-flat' : null;
    this.commitAudioLabSettings(
      {
        ...current,
        slots: { ...current.slots, [slotId]: slot },
      },
      false,
    );
  }

  updateParametricBand(bandIndex: number, patch: Partial<ParametricBandConfig>): void {
    const current = this.getAudioLabSettings();
    const slotId = current.activeSlot;
    const slot = cloneEqSlotConfig(current.slots[slotId]);
    if (bandIndex < 0 || bandIndex >= slot.parametricBands.length) {
      return;
    }
    slot.parametricBands[bandIndex] = sanitizeParametricBand(
      { ...slot.parametricBands[bandIndex], ...patch },
      bandIndex,
    );
    slot.activePresetId = null;
    this.commitAudioLabSettings(
      {
        ...current,
        slots: { ...current.slots, [slotId]: slot },
      },
      true,
    );
  }

  resetParametricBand(bandIndex: number): void {
    const defaults = createDefaultParametricBands();
    if (bandIndex < 0 || bandIndex >= defaults.length) {
      return;
    }
    this.updateParametricBand(bandIndex, defaults[bandIndex]);
  }

  resetParametricBands(): void {
    const current = this.getAudioLabSettings();
    const slotId = current.activeSlot;
    const slot = cloneEqSlotConfig(current.slots[slotId]);
    slot.parametricBands = createDefaultParametricBands();
    slot.activePresetId = slot.mode === 'parametric' && slot.preampDb === 0 ? 'sys-flat' : null;
    this.commitAudioLabSettings(
      {
        ...current,
        slots: { ...current.slots, [slotId]: slot },
      },
      false,
    );
  }

  setEqPreampDb(preampDb: number): void {
    const current = this.getAudioLabSettings();
    const slotId = current.activeSlot;
    const slot = cloneEqSlotConfig(current.slots[slotId]);
    slot.preampDb = roundTo(clampFinite(preampDb, PREAMP_MIN_DB, PREAMP_MAX_DB, 0), 1);
    slot.activePresetId = null;
    this.commitAudioLabSettings(
      {
        ...current,
        slots: { ...current.slots, [slotId]: slot },
      },
      true,
    );
  }

  setEqAutoHeadroom(enabled: boolean): void {
    const current = this.getAudioLabSettings();
    const slotId = current.activeSlot;
    const slot = cloneEqSlotConfig(current.slots[slotId]);
    slot.autoHeadroom = enabled;
    this.commitAudioLabSettings(
      {
        ...current,
        slots: { ...current.slots, [slotId]: slot },
      },
      false,
    );
  }

  setSpectrumEnabled(enabled: boolean): void {
    const current = this.getAudioLabSettings();
    this.commitAudioLabSettings({ ...current, spectrumEnabled: enabled }, false);
  }

  applyEqPreset(presetId: string): void {
    const current = this.getAudioLabSettings();
    const preset = getAllPresets(current).find((p) => p.id === presetId);
    if (!preset) {
      return;
    }
    const slotId = current.activeSlot;
    const nextSlot = applyPresetToSlot(preset, current.slots[slotId]);
    this.commitAudioLabSettings(
      {
        ...current,
        enabled: true,
        slots: { ...current.slots, [slotId]: nextSlot },
      },
      false,
    );
    if (this.state.activeSource === 'local') {
      void playerActions.ensureDspReady();
    }
  }

  saveCustomEqPreset(rawName: string, rawDescription?: string): AudioEqPreset | null {
    const name = rawName.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 48);
    if (!name) {
      return null;
    }
    const current = this.getAudioLabSettings();
    const slotId = current.activeSlot;
    const slot = cloneEqSlotConfig(current.slots[slotId]);
    const nowIso = new Date().toISOString();
    const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const newPreset: AudioEqPreset = {
      id,
      name,
      description:
        rawDescription?.trim().slice(0, 140) ||
        `Preset ${slot.mode === 'parametric' ? 'Parametric 8-band' : 'Graphic 10-band'} tùy chỉnh.`,
      isSystem: false,
      mode: slot.mode,
      graphicGainsDb: [...slot.graphicGainsDb],
      parametricBands: slot.parametricBands.map((b) => ({ ...b })),
      preampDb: slot.preampDb,
      autoHeadroom: slot.autoHeadroom,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    slot.activePresetId = id;
    this.commitAudioLabSettings(
      {
        ...current,
        slots: { ...current.slots, [slotId]: slot },
        customPresets: [newPreset, ...current.customPresets].slice(0, 64),
      },
      false,
    );
    this.showToast(`Đã lưu preset "${name}"`);
    return newPreset;
  }

  renameCustomEqPreset(presetId: string, rawName: string): boolean {
    if (SYSTEM_AUDIO_PRESETS.some((p) => p.id === presetId)) {
      this.showToast('Không thể đổi tên preset hệ thống mặc định.');
      return false;
    }
    const name = rawName.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 48);
    if (!name) {
      return false;
    }
    const current = this.getAudioLabSettings();
    const exists = current.customPresets.some((p) => p.id === presetId);
    if (!exists) {
      return false;
    }
    const nowIso = new Date().toISOString();
    const customPresets = current.customPresets.map((p) =>
      p.id === presetId ? { ...p, name, updatedAt: nowIso } : p,
    );
    this.commitAudioLabSettings({ ...current, customPresets }, false);
    this.showToast(`Đã đổi tên preset thành "${name}"`);
    return true;
  }

  duplicateEqPreset(presetId: string): AudioEqPreset | null {
    const current = this.getAudioLabSettings();
    const source = getAllPresets(current).find((p) => p.id === presetId);
    if (!source) {
      return null;
    }
    const nowIso = new Date().toISOString();
    const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const copyName = `${source.name} (Bản sao)`.slice(0, 48);
    const duplicated: AudioEqPreset = {
      ...source,
      id,
      name: copyName,
      isSystem: false,
      graphicGainsDb: [...source.graphicGainsDb],
      parametricBands: source.parametricBands.map((b) => ({ ...b })),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const slotId = current.activeSlot;
    const nextSlot = applyPresetToSlot(duplicated, current.slots[slotId]);
    this.commitAudioLabSettings(
      {
        ...current,
        slots: { ...current.slots, [slotId]: nextSlot },
        customPresets: [duplicated, ...current.customPresets].slice(0, 64),
      },
      false,
    );
    this.showToast(`Đã nhân bản preset "${copyName}"`);
    return duplicated;
  }

  deleteCustomEqPreset(presetId: string): boolean {
    if (SYSTEM_AUDIO_PRESETS.some((p) => p.id === presetId)) {
      this.showToast('Preset hệ thống mặc định được bảo vệ và không thể xóa.');
      return false;
    }
    const current = this.getAudioLabSettings();
    const target = current.customPresets.find((p) => p.id === presetId);
    if (!target) {
      return false;
    }
    const customPresets = current.customPresets.filter((p) => p.id !== presetId);
    const slotA = cloneEqSlotConfig(current.slots.A);
    const slotB = cloneEqSlotConfig(current.slots.B);
    if (slotA.activePresetId === presetId) {
      slotA.activePresetId = null;
    }
    if (slotB.activePresetId === presetId) {
      slotB.activePresetId = null;
    }
    this.commitAudioLabSettings(
      {
        ...current,
        slots: { A: slotA, B: slotB },
        customPresets,
      },
      false,
    );
    this.showToast(`Đã xóa preset "${target.name}"`);
    return true;
  }

  resetActiveEqSlotToFlat(): void {
    const current = this.getAudioLabSettings();
    const slotId = current.activeSlot;
    const slot = cloneEqSlotConfig(current.slots[slotId]);
    slot.graphicGainsDb = createFlatGraphicGains();
    slot.parametricBands = createDefaultParametricBands();
    slot.preampDb = 0;
    slot.autoHeadroom = false;
    slot.activePresetId = 'sys-flat';
    this.commitAudioLabSettings(
      {
        ...current,
        slots: { ...current.slots, [slotId]: slot },
      },
      false,
    );
    this.showToast(`Đã đặt Slot ${slotId} về đáp tuyến phẳng (Flat 0 dB)`);
  }

  updateReplayGainSettings(partial: Partial<ReplayGainSettings>): void {
    const next = normalizeReplayGainSettings({
      ...this.getReplayGainSettings(),
      ...partial,
    });
    this.updatePreferences({ replayGain: next });
  }

  async importCustomBackgroundDesktop(): Promise<void> {
    if (typeof window !== 'undefined' && window.losslessApi) {
      const result = await window.losslessApi.importCustomBackground();
      if (result.canceled) {
        return;
      }
      if (result.error) {
        this.showToast(result.error);
        return;
      }
      if (result.preferences) {
        this.setState({ preferences: result.preferences });
        this.showToast('Đã áp dụng ảnh nền tùy chỉnh cho Home');
      }
    }
  }

  setWebCustomBackground(dataUrl: string): void {
    this.updatePreferences({
      homeBackgroundMode: 'custom',
      customBackgroundUrl: dataUrl,
      customBackgroundHash: String(Date.now()),
    });
    this.showToast('Đã áp dụng ảnh nền tùy chỉnh cho Home');
  }

  async removeCustomBackground(): Promise<void> {
    if (typeof window !== 'undefined' && window.losslessApi) {
      try {
        const persisted = await window.losslessApi.removeCustomBackground();
        this.setState({ preferences: persisted });
        this.showToast('Đã gỡ ảnh nền tùy chỉnh');
        return;
      } catch {
        // fallback below
      }
    }
    this.updatePreferences({
      homeBackgroundMode:
        this.state.preferences.homeBackgroundMode === 'custom'
          ? 'dynamic'
          : this.state.preferences.homeBackgroundMode,
      customBackgroundUrl: null,
      customBackgroundHash: null,
    });
    this.showToast('Đã gỡ ảnh nền tùy chỉnh');
  }

  getUserAccentPalette(): ResolvedAccentPalette {
    return resolveUserAccentPalette(this.state.preferences);
  }

  // ---------------------------------------------------------------------------
  // Stage 3: Offline web-preview fallback helpers (Custom Cover / Lyrics / Metadata)
  // ---------------------------------------------------------------------------

  setWebCustomCover(trackId: string, dataUrl: string): void {
    const next = { ...this.state.customCoversByTrackId, [trackId]: dataUrl };
    safeWriteJson(CUSTOM_COVERS_KEY, next);
    this.setState({ customCoversByTrackId: next });
    this.showToast('Đã cập nhật ảnh bìa tùy chỉnh');
  }

  removeWebCustomCover(trackId: string): void {
    const next = { ...this.state.customCoversByTrackId };
    delete next[trackId];
    safeWriteJson(CUSTOM_COVERS_KEY, next);
    this.setState({ customCoversByTrackId: next });
    this.showToast('Đã khôi phục ảnh bìa gốc');
  }

  hasWebCustomCover(trackId: string): boolean {
    return Boolean(this.state.customCoversByTrackId[trackId]);
  }

  setWebCustomLyrics(trackId: string, format: 'lrc' | 'txt', content: string): void {
    const cleaned = content.replace(/^\uFEFF/, '');
    const nextMap = { ...this.state.customLyricsByTrackId };
    if (cleaned.trim().length === 0) {
      delete nextMap[trackId];
    } else {
      const effectiveFormat: 'lrc' | 'txt' =
        format === 'lrc' && parseLrcContent(cleaned).lines.length > 0 ? 'lrc' : 'txt';
      nextMap[trackId] = { format: effectiveFormat, content: cleaned };
    }
    safeWriteJson(CUSTOM_LYRICS_V2_KEY, nextMap);
    this.setState({
      customLyricsByTrackId: nextMap,
      nowPlayingRightTab: 'lyrics',
      showLyricsPanel: true,
    });
    this.showToast(
      cleaned.trim().length > 0
        ? 'Đã lưu lời bài hát tùy chỉnh'
        : 'Đã khôi phục lời bài hát mặc định',
    );
  }

  removeWebCustomLyrics(trackId: string): void {
    const nextMap = { ...this.state.customLyricsByTrackId };
    delete nextMap[trackId];
    safeWriteJson(CUSTOM_LYRICS_V2_KEY, nextMap);
    this.setState({ customLyricsByTrackId: nextMap });
    this.showToast('Đã xóa lời tùy chỉnh và khôi phục nguồn tự động');
  }

  getWebResolvedLyrics(trackId: string): ResolvedTrackLyrics {
    const custom = this.state.customLyricsByTrackId[trackId];
    if (custom && custom.content.trim().length > 0) {
      if (custom.format === 'lrc') {
        const parsed = parseLrcContent(custom.content);
        if (parsed.lines.length > 0) {
          return {
            trackId,
            source: 'custom',
            format: 'lrc',
            rawContent: custom.content,
            timedLines: parsed.lines,
            plainLines: parsed.lines.map((l) => l.text),
            hasCustomLyrics: true,
            sidecarPath: null,
          };
        }
      }
      const plainLines = parsePlainTextLyrics(custom.content);
      return {
        trackId,
        source: 'custom',
        format: plainLines.length > 0 ? 'txt' : 'none',
        rawContent: custom.content,
        timedLines: [],
        plainLines,
        hasCustomLyrics: true,
        sidecarPath: null,
      };
    }

    return {
      trackId,
      source: 'none',
      format: 'none',
      rawContent: '',
      timedLines: [],
      plainLines: [],
      hasCustomLyrics: false,
      sidecarPath: null,
    };
  }

  setWebMetadataOverride(trackId: string, input: TrackMetadataOverrideInput): void {
    const clean = (v: string | null | undefined): string | null => {
      if (typeof v !== 'string') return null;
      const t = v.normalize('NFC').trim();
      return t.length > 0 ? t : null;
    };

    const titleOverride = clean(input.titleOverride);
    const artistOverride = clean(input.artistOverride);
    const albumOverride = clean(input.albumOverride);

    const normalized: TrackMetadataOverrideInput = {
      titleOverride,
      artistOverride,
      albumOverride,
    };

    const next = { ...this.state.metadataOverridesByTrackId };
    if (
      normalized.titleOverride === null &&
      normalized.artistOverride === null &&
      normalized.albumOverride === null
    ) {
      delete next[trackId];
    } else {
      next[trackId] = normalized;
    }

    safeWriteJson(METADATA_OVERRIDES_KEY, next);
    this.setState({ metadataOverridesByTrackId: next });
    this.showToast('Đã lưu thông tin bài hát trong ứng dụng (file gốc không thay đổi)');
  }

  restoreWebMetadataOriginal(trackId: string): void {
    const next = { ...this.state.metadataOverridesByTrackId };
    delete next[trackId];
    safeWriteJson(METADATA_OVERRIDES_KEY, next);
    this.setState({ metadataOverridesByTrackId: next });
    this.showToast('Đã khôi phục thông tin gốc của bài hát');
  }

  applySampleTrackOverrides(track: PrototypeTrack): PrototypeTrack {
    const override = this.state.metadataOverridesByTrackId[track.id];
    const customCover = this.state.customCoversByTrackId[track.id];
    if (!override && !customCover) {
      return track;
    }
    return {
      ...track,
      title: override?.titleOverride ?? track.title,
      artist: override?.artistOverride ?? track.artist,
      albumTitle: override?.albumOverride ?? track.albumTitle,
      coverUrl: customCover ?? track.coverUrl,
    };
  }

  getPaletteForTrack(trackId: string, localSeed?: string): AlbumColorPalette {
    if (!this.state.preferences.dynamicAlbumColors) {
      return accentToAlbumPalette(
        this.getUserAccentPalette(),
        this.state.preferences.themeMode,
      );
    }
    if (isRemoteTrackId(trackId)) {
      const remote = connectStore.getRemoteTrackRecord(trackId);
      const seed = remote?.album || remote?.title || localSeed || trackId;
      return computePaletteFromSeed(seed);
    }
    const local = libraryStore.getTrackById(trackId);
    const seed = local?.album || local?.title || localSeed || trackId;
    return computePaletteFromSeed(seed);
  }

  getPaletteForPlaylist(playlist: PrototypePlaylist | null | undefined): AlbumColorPalette {
    if (!this.state.preferences.dynamicAlbumColors || !playlist) {
      return accentToAlbumPalette(
        this.getUserAccentPalette(),
        this.state.preferences.themeMode,
      );
    }
    const firstTrackId = playlist.trackIds[0];
    if (firstTrackId) {
      return this.getPaletteForTrack(firstTrackId, playlist.name);
    }
    return computePaletteFromSeed(playlist.id || playlist.name);
  }

  getCoverForTrack(trackId: string, size: 'full' | 'thumb' = 'full'): string {
    if (!trackId) {
      return DEFAULT_DOREMI_ARTWORK_URL;
    }
    if (isRemoteTrackId(trackId)) {
      return connectStore.getCoverForTrack(trackId, size);
    }
    const lib = libraryStore.getSnapshot();
    const localTrack = lib.tracks.find((t) => t.id === trackId);
    if (localTrack) {
      const url =
        size === 'thumb'
          ? localTrack.artwork_thumb_url ?? localTrack.artwork_url
          : localTrack.artwork_url ?? localTrack.artwork_thumb_url;
      return url || DEFAULT_DOREMI_ARTWORK_URL;
    }

    const customWebCover = this.state.customCoversByTrackId[trackId];
    if (customWebCover) {
      return customWebCover;
    }

    return DEFAULT_DOREMI_ARTWORK_URL;
  }

  getPlaylistCovers(playlist: PrototypePlaylist): {
    primaryCover: string | null;
    collageCovers: string[];
  } {
    if (playlist.coverUrl) {
      return { primaryCover: playlist.coverUrl, collageCovers: [] };
    }
    const distinctCovers: string[] = [];
    for (const trackId of playlist.trackIds) {
      const cover = this.getCoverForTrack(trackId, 'full');
      if (cover && cover !== DEFAULT_DOREMI_ARTWORK_URL && !distinctCovers.includes(cover)) {
        distinctCovers.push(cover);
      }
      if (distinctCovers.length >= 4) {
        break;
      }
    }
    if (distinctCovers.length >= 1) {
      return {
        primaryCover: distinctCovers[0],
        collageCovers: distinctCovers.length >= 4 ? distinctCovers.slice(0, 4) : [],
      };
    }
    return { primaryCover: null, collageCovers: [] };
  }

  // ---------------------------------------------------------------------------
  // Favorites & Playlists Management (SQLite in Electron, clean localStorage fallback)
  // ---------------------------------------------------------------------------

  private savePlaylists(
    playlists: PrototypePlaylist[],
    selectedGalleryIndex?: number,
    preserveMissingSelection = false,
  ): void {
    safeWriteJson(PLAYLISTS_STORAGE_KEY, playlists);
    const maxIdx = Math.max(0, playlists.length - 1);
    const nextIdx =
      typeof selectedGalleryIndex === 'number'
        ? Math.min(Math.max(0, selectedGalleryIndex), maxIdx)
        : Math.min(this.state.selectedGalleryIndex, maxIdx);
    const selectionStillExists =
      this.state.selectedPlaylistId !== null &&
      playlists.some((p) => p.id === this.state.selectedPlaylistId);
    this.setState({
      playlists,
      selectedGalleryIndex: nextIdx,
      selectedPlaylistId: preserveMissingSelection
        ? this.state.selectedPlaylistId
        : selectionStillExists
          ? this.state.selectedPlaylistId
          : null,
    });
  }

  async toggleFavorite(id: string): Promise<void> {
    if (!id) {
      return;
    }
    if (isRemoteTrackId(id)) {
      this.showToast('Nhạc phát từ Host LAN chỉ hỗ trợ nghe đọc (chưa lưu vào Yêu thích cục bộ).');
      return;
    }
    if (typeof window !== 'undefined' && window.losslessApi?.toggleFavoriteTrack) {
      try {
        const res = await window.losslessApi.toggleFavoriteTrack(id);
        this.setState({ favoriteIds: res.favoriteTrackIds });
        return;
      } catch (err) {
        this.showToast(
          err instanceof Error ? err.message : 'Không thể cập nhật trạng thái yêu thích.',
        );
        return;
      }
    }
    const exists = this.state.favoriteIds.includes(id);
    const favoriteIds = exists
      ? this.state.favoriteIds.filter((item) => item !== id)
      : [id, ...this.state.favoriteIds];
    this.setState({ favoriteIds });
  }

  async setFavoriteMany(trackIds: readonly string[], favorite: boolean): Promise<void> {
    if (trackIds.length === 0) return;
    if (typeof window !== 'undefined' && window.losslessApi?.setFavoriteTracks) {
      const res = await window.losslessApi.setFavoriteTracks(trackIds, favorite);
      this.setState({ favoriteIds: res.favoriteTrackIds });
      return;
    }
    const set = new Set(this.state.favoriteIds);
    for (const id of trackIds) {
      if (favorite) set.add(id);
      else set.delete(id);
    }
    this.setState({ favoriteIds: Array.from(set) });
  }

  /**
   * Creates a new playlist. When `initialTrackIds` is omitted or empty,
   * the playlist is strictly created empty (0 tracks) — NEVER injects sample/active track.
   */
  async createPlaylist(
    name: string,
    description: string,
    initialTrackIds: readonly string[] = [],
  ): Promise<PrototypePlaylist | null> {
    const trimmed = name.normalize('NFC').trim();
    if (!trimmed) {
      return null;
    }
    const cleanTrackIds = initialTrackIds.filter((id) => typeof id === 'string' && id.length > 0);

    if (typeof window !== 'undefined' && window.losslessApi?.createPlaylist) {
      const record = await window.losslessApi.createPlaylist({
        name: trimmed,
        description: description.trim(),
        initialTrackIds: cleanTrackIds,
      });
      const uiPlaylist = mapPlaylistRecordToUi(record);
      this.savePlaylists([uiPlaylist, ...this.state.playlists], 0);
      this.showToast(`Đã tạo playlist "${trimmed}"`);
      return uiPlaylist;
    }

    const next: PrototypePlaylist = {
      id: `pl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: trimmed,
      description: description.trim(),
      trackIds: [...cleanTrackIds],
      entries: cleanTrackIds.map((trackId, position) => ({
        entryId: `pe-${Date.now()}-${position}`,
        trackId,
        position,
        addedAt: new Date().toISOString(),
      })),
      updatedLabel: `${cleanTrackIds.length} bài hát`,
      coverUrl: null,
      trackCount: cleanTrackIds.length,
    };
    this.savePlaylists([next, ...this.state.playlists], 0);
    this.showToast(`Đã tạo playlist "${trimmed}"`);
    return next;
  }

  async renamePlaylist(playlistId: string, name: string, description?: string): Promise<void> {
    const trimmed = name.normalize('NFC').trim();
    if (!trimmed) {
      return;
    }
    if (typeof window !== 'undefined' && window.losslessApi?.updatePlaylist) {
      const updated = await window.losslessApi.updatePlaylist(playlistId, {
        name: trimmed,
        description: typeof description === 'string' ? description : undefined,
      });
      const mapped = mapPlaylistRecordToUi(updated);
      this.savePlaylists(
        this.state.playlists.map((pl) => (pl.id === playlistId ? mapped : pl)),
      );
      this.showToast(`Đã cập nhật playlist "${trimmed}"`);
      return;
    }

    const updated = this.state.playlists.map((pl) =>
      pl.id === playlistId
        ? {
            ...pl,
            name: trimmed,
            description:
              typeof description === 'string' ? description.trim() : pl.description,
          }
        : pl,
    );
    this.savePlaylists(updated);
    this.showToast(`Đã cập nhật playlist "${trimmed}"`);
  }

  async importPlaylistCustomCover(playlistId: string): Promise<void> {
    if (typeof window !== 'undefined' && window.losslessApi?.importPlaylistArtwork) {
      const res = await window.losslessApi.importPlaylistArtwork(playlistId);
      if (res.canceled) return;
      if (res.error) {
        this.showToast(res.error);
        return;
      }
      if (res.playlist) {
        const mapped = mapPlaylistRecordToUi(res.playlist);
        this.savePlaylists(
          this.state.playlists.map((pl) => (pl.id === playlistId ? mapped : pl)),
        );
        this.showToast('Đã cập nhật ảnh bìa playlist');
      }
    }
  }

  async removePlaylistCustomCover(playlistId: string): Promise<void> {
    if (typeof window !== 'undefined' && window.losslessApi?.removePlaylistArtwork) {
      const res = await window.losslessApi.removePlaylistArtwork(playlistId);
      if (res.error) {
        this.showToast(res.error);
        return;
      }
      if (res.playlist) {
        const mapped = mapPlaylistRecordToUi(res.playlist);
        this.savePlaylists(
          this.state.playlists.map((pl) => (pl.id === playlistId ? mapped : pl)),
        );
        this.showToast('Đã gỡ ảnh bìa tùy chỉnh');
      }
      return;
    }
    this.setPlaylistCustomCover(playlistId, null);
  }

  setPlaylistCustomCover(playlistId: string, coverUrl: string | null): void {
    const updated = this.state.playlists.map((pl) =>
      pl.id === playlistId ? { ...pl, coverUrl } : pl,
    );
    this.savePlaylists(updated);
    this.showToast(coverUrl ? 'Đã cập nhật ảnh bìa playlist' : 'Đã gỡ ảnh bìa tùy chỉnh');
  }

  async addTracksToPlaylist(
    playlistId: string,
    trackIds: readonly string[],
    options?: { allowDuplicates?: boolean },
  ): Promise<{ addedCount: number; skippedDuplicateCount: number }> {
    const cleanIds = trackIds.filter((id) => typeof id === 'string' && id.length > 0);
    if (cleanIds.length === 0) {
      return { addedCount: 0, skippedDuplicateCount: 0 };
    }

    if (typeof window !== 'undefined' && window.losslessApi?.addTracksToPlaylist) {
      const res = await window.losslessApi.addTracksToPlaylist(playlistId, cleanIds, options);
      const mapped = mapPlaylistRecordToUi(res.playlist);
      this.savePlaylists(
        this.state.playlists.map((pl) => (pl.id === playlistId ? mapped : pl)),
      );
      if (res.addedCount > 0 && res.skippedDuplicateCount > 0) {
        this.showToast(
          `Đã thêm ${res.addedCount} bài vào "${mapped.name}" (bỏ qua ${res.skippedDuplicateCount} bài trùng)`,
        );
      } else if (res.addedCount > 0) {
        this.showToast(`Đã thêm ${res.addedCount} bài vào "${mapped.name}"`);
      } else if (res.skippedDuplicateCount > 0) {
        this.showToast(`Tất cả ${res.skippedDuplicateCount} bài đã có trong "${mapped.name}"`);
      }
      return {
        addedCount: res.addedCount,
        skippedDuplicateCount: res.skippedDuplicateCount,
      };
    }

    let addedCount = 0;
    let skippedDuplicateCount = 0;
    const allowDup = Boolean(options?.allowDuplicates);
    const updated = this.state.playlists.map((pl) => {
      if (pl.id !== playlistId) return pl;
      const existingSet = new Set(pl.trackIds);
      const nextTrackIds = [...pl.trackIds];
      for (const tid of cleanIds) {
        if (!allowDup && existingSet.has(tid)) {
          skippedDuplicateCount += 1;
          continue;
        }
        existingSet.add(tid);
        nextTrackIds.push(tid);
        addedCount += 1;
      }
      return {
        ...pl,
        trackIds: nextTrackIds,
        updatedLabel: `${nextTrackIds.length} bài hát`,
      };
    });
    this.savePlaylists(updated);
    this.showToast(
      addedCount > 0 ? `Đã thêm ${addedCount} bài vào playlist` : 'Bài hát đã có trong playlist',
    );
    return { addedCount, skippedDuplicateCount };
  }

  async addTrackToPlaylist(playlistId: string, trackId: string): Promise<void> {
    await this.addTracksToPlaylist(playlistId, [trackId]);
  }

  async removeEntriesFromPlaylist(playlistId: string, entryIds: readonly string[]): Promise<void> {
    if (entryIds.length === 0) return;
    if (typeof window !== 'undefined' && window.losslessApi?.removeEntriesFromPlaylist) {
      const updated = await window.losslessApi.removeEntriesFromPlaylist(playlistId, entryIds);
      const mapped = mapPlaylistRecordToUi(updated);
      this.savePlaylists(
        this.state.playlists.map((pl) => (pl.id === playlistId ? mapped : pl)),
      );
      this.showToast(`Đã gỡ ${entryIds.length} bài khỏi playlist`);
      return;
    }
    const entrySet = new Set(entryIds);
    const updated = this.state.playlists.map((pl) => {
      if (pl.id !== playlistId) return pl;
      const nextEntries = (pl.entries ?? []).filter((e) => !entrySet.has(e.entryId));
      const nextTrackIds = nextEntries.length > 0 ? nextEntries.map((e) => e.trackId) : pl.trackIds;
      return {
        ...pl,
        entries: nextEntries,
        trackIds: nextTrackIds,
        updatedLabel: `${nextTrackIds.length} bài hát`,
      };
    });
    this.savePlaylists(updated);
    this.showToast('Đã gỡ bài hát khỏi playlist');
  }

  async removeTrackFromPlaylist(playlistId: string, trackId: string): Promise<void> {
    const pl = this.state.playlists.find((p) => p.id === playlistId);
    const entryMatch = pl?.entries?.find((e) => e.trackId === trackId);
    if (entryMatch && typeof window !== 'undefined' && window.losslessApi?.removeEntriesFromPlaylist) {
      await this.removeEntriesFromPlaylist(playlistId, [entryMatch.entryId]);
      return;
    }
    const updated = this.state.playlists.map((p) => {
      if (p.id !== playlistId) return p;
      const nextTrackIds = p.trackIds.filter((id) => id !== trackId);
      return {
        ...p,
        trackIds: nextTrackIds,
        updatedLabel: `${nextTrackIds.length} bài hát`,
      };
    });
    this.savePlaylists(updated);
    this.showToast('Đã gỡ bài hát khỏi playlist');
  }

  async reorderPlaylistEntries(playlistId: string, orderedEntryIds: readonly string[]): Promise<void> {
    if (typeof window !== 'undefined' && window.losslessApi?.reorderPlaylistEntries) {
      const updated = await window.losslessApi.reorderPlaylistEntries(playlistId, orderedEntryIds);
      const mapped = mapPlaylistRecordToUi(updated);
      this.savePlaylists(
        this.state.playlists.map((pl) => (pl.id === playlistId ? mapped : pl)),
      );
    }
  }

  /**
   * Deletes a playlist cleanly without touching disk audio files or interrupting playback.
   * When the deleted playlist was currently open, navigates cleanly back to Library -> Playlists overview
   * and NEVER auto-opens another playlist!
   */
  async deletePlaylist(playlistId: string): Promise<void> {
    const target = this.state.playlists.find((p) => p.id === playlistId);
    if (typeof window !== 'undefined' && window.losslessApi?.deletePlaylist) {
      await window.losslessApi.deletePlaylist(playlistId);
    }
    const remaining = this.state.playlists.filter((p) => p.id !== playlistId);
    const wasViewingDeleted =
      this.state.route === 'playlist-detail' && this.state.selectedPlaylistId === playlistId;

    this.savePlaylists(remaining);

    if (wasViewingDeleted) {
      this.setState({
        selectedPlaylistId: null,
        route: 'library',
        libraryTab: 'playlists',
      });
    }
    if (target) {
      this.showToast(`Đã xóa playlist "${target.name}"`);
    }
  }

  isTrackIdPlayable(trackId: string): boolean {
    if (isRemoteTrackId(trackId)) {
      return connectStore.isRemoteTrackPlayable(trackId);
    }
    const local = libraryStore.getTrackById(trackId);
    return Boolean(local && local.status === 'available');
  }

  private persistPlaybackControls(controls: PlaybackControlState): void {
    this.updatePreferences({ playbackControls: controls });
  }

  playPlaylist(playlistId: string, shuffleFirst?: boolean): void {
    const playlist = this.state.playlists.find((p) => p.id === playlistId);
    if (!playlist || playlist.trackIds.length === 0) {
      this.showToast('Playlist chưa có bài hát nào để phát.');
      return;
    }
    const allTracks = this.getUnifiedTracks();
    const byId = new Map(allTracks.map((t) => [t.id, t]));
    const playableIds = playlist.trackIds.filter((id) => {
      const t = byId.get(id);
      return Boolean(t && t.status === 'available');
    });

    if (playableIds.length === 0) {
      this.showToast('Không có bài hát khả dụng trong playlist này.');
      return;
    }

    this.playFromContext(
      {
        contextId: `playlist-${playlist.id}`,
        label: playlist.name,
        kind: 'playlist',
        trackIds: playableIds,
      },
      undefined,
      shuffleFirst,
    );
  }

  // ---------------------------------------------------------------------------
  // Unified Queue Controls (Single Source of Truth -> PlaybackQueueController)
  // ---------------------------------------------------------------------------

  playFromContext(
    context: PlaybackContextDescriptor,
    startTrackId?: string,
    shuffleOverride?: boolean,
  ): void {
    const prevControls = playbackQueueController.getControls();
    const entry = playbackQueueController.startContext({
      context,
      startTrackId,
      shuffle: shuffleOverride,
    });
    const nextControls = playbackQueueController.getControls();
    if (
      nextControls.shuffleEnabled !== prevControls.shuffleEnabled ||
      nextControls.repeatMode !== prevControls.repeatMode ||
      nextControls.autoNextEnabled !== prevControls.autoNextEnabled
    ) {
      this.persistPlaybackControls(nextControls);
    }
    if (entry) {
      void this.playQueueEntry(entry);
    }
  }

  async playQueueEntry(entry: PlaybackQueueEntry): Promise<void> {
    if (isRemoteTrackId(entry.trackId)) {
      this.setState({
        activeSource: 'local',
        sampleIsPlaying: false,
      });
      await playerActions.playQueueEntry(entry);
      return;
    }
    const localRecord = libraryStore.getTrackById(entry.trackId);
    if (localRecord) {
      this.setState({
        activeSource: 'local',
        sampleIsPlaying: false,
      });
      await playerActions.playQueueEntry(entry);
    }
  }

  playNextInQueue(trackId: string): void {
    playbackQueueController.playNext(trackId);
    this.showToast('Đã thêm vào phát tiếp theo');
  }

  addToQueue(trackId: string): void {
    playbackQueueController.addToQueue(trackId);
    this.showToast('Đã thêm vào cuối hàng đợi');
  }

  promoteQueueEntryToPlayNext(queueEntryId: string): void {
    if (playbackQueueController.promoteUpcomingEntryToPlayNext(queueEntryId)) {
      this.showToast('Đã đưa lên phát tiếp theo');
    }
  }

  playQueueEntryNow(queueEntryId: string): void {
    const qState = playbackQueueController.getState();
    if (qState.currentEntry?.queueEntryId === queueEntryId) {
      void this.playQueueEntry(qState.currentEntry);
      return;
    }
    const fromUpcoming = playbackQueueController.playUpcomingEntryNow(queueEntryId);
    if (fromUpcoming) {
      void this.playQueueEntry(fromUpcoming);
      return;
    }
    const fromHistory = playbackQueueController.jumpToHistoryEntry(queueEntryId);
    if (fromHistory) {
      void this.playQueueEntry(fromHistory);
    }
  }

  playContextIndex(contextOrderIndex: number): void {
    const entry = playbackQueueController.playContextIndexNow(contextOrderIndex);
    if (entry) {
      void this.playQueueEntry(entry);
    }
  }

  removeQueueEntry(queueEntryId: string): void {
    playbackQueueController.removeUpcomingEntry(queueEntryId);
  }

  removeFromQueue(trackId: string): void {
    const match = playbackQueueController
      .getState()
      .upcoming.find((e) => e.trackId === trackId);
    if (match) {
      playbackQueueController.removeUpcomingEntry(match.queueEntryId);
    }
  }

  moveQueueEntry(queueEntryId: string, direction: -1 | 1): void {
    playbackQueueController.moveUpcomingEntry(queueEntryId, direction);
  }

  reorderUpcomingQueue(fromIndex: number, toIndex: number): void {
    playbackQueueController.reorderUpcoming(fromIndex, toIndex);
  }

  moveQueueItem(index: number, direction: -1 | 1): void {
    playbackQueueController.reorderUpcoming(index, index + direction);
  }

  clearUpcomingQueue(): void {
    playbackQueueController.clearUpcoming();
    this.showToast('Đã xóa các bài kế tiếp');
  }

  clearQueue(): void {
    this.clearUpcomingQueue();
  }

  setShuffle(enabled: boolean): void {
    const controls = playbackQueueController.setShuffle(enabled);
    this.persistPlaybackControls(controls);
  }

  toggleShuffle(): void {
    const controls = playbackQueueController.toggleShuffle();
    this.persistPlaybackControls(controls);
  }

  setRepeatMode(mode: RepeatMode): void {
    const controls = playbackQueueController.setRepeatMode(mode);
    this.persistPlaybackControls(controls);
  }

  cycleRepeat(): void {
    const controls = playbackQueueController.cycleRepeatMode();
    this.persistPlaybackControls(controls);
  }

  setAutoNext(enabled: boolean): void {
    const controls = playbackQueueController.setAutoNext(enabled);
    this.persistPlaybackControls(controls);
  }

  toggleAutoNext(): void {
    const controls = playbackQueueController.toggleAutoNext();
    this.persistPlaybackControls(controls);
  }

  setAutoContinueEnabled(enabled: boolean): void {
    const normalized = Boolean(enabled);
    playerActions.setAutoContinueEnabled(normalized);
    this.updatePreferences({ autoContinueEnabled: normalized });
  }

  private resolveTrackMetaForShuffle(trackId: string): SmartShuffleTrackMeta {
    if (isRemoteTrackId(trackId)) {
      const remote = connectStore.getRemoteTrackRecord(trackId);
      return remote
        ? {
            trackId,
            albumTitle: remote.album,
            albumArtist: remote.album_artist ?? remote.artist,
            artist: remote.artist,
          }
        : { trackId };
    }
    const local = libraryStore.getTrackById(trackId);
    const override = this.state.metadataOverridesByTrackId[trackId];
    if (!local) {
      return {
        trackId,
        albumTitle: override?.albumOverride ?? null,
        artist: override?.artistOverride ?? null,
      };
    }
    return {
      trackId,
      albumTitle: override?.albumOverride ?? local.album,
      albumArtist: local.album_artist ?? null,
      artist: override?.artistOverride ?? local.artist,
    };
  }

  private resolveAutoContinuePlan(
    request: AutoContinueRequest,
  ): AutoContinueResolution | null {
    if (!request.lastTrackId || isRemoteTrackId(request.lastTrackId)) {
      return null;
    }
    if (request.lastContext?.contextId?.startsWith('remote-')) {
      return null;
    }
    const localAvailable = this.getUnifiedTracks().filter(
      (t) => t.source === 'local' && t.status === 'available',
    );
    if (localAvailable.length === 0) {
      return null;
    }
    if (localAvailable.length === 1 && localAvailable[0].id === request.lastTrackId) {
      return null;
    }

    const MAX_CONTINUATION_WAVE = 64;

    if (request.shuffleEnabled) {
      const withoutLast = localAvailable.filter((t) => t.id !== request.lastTrackId);
      const recentSet = new Set(request.recentTrackIds);
      const nonRecent = withoutLast.filter((t) => !recentSet.has(t.id));
      const candidatePool = nonRecent.length > 0 ? nonRecent : withoutLast;
      if (candidatePool.length === 0) {
        return null;
      }

      const shuffled = smartShuffleItems({
        items: candidatePool,
        getTrackMeta: (t) => ({
          trackId: t.id,
          albumKey: t.albumId,
          albumTitle: t.albumTitle,
          albumArtist: t.albumArtist ?? null,
          artist: t.artist,
        }),
        anchorTrack: this.resolveTrackMetaForShuffle(request.lastTrackId),
        recentTrackIds: request.recentTrackIds,
      });
      const wave = shuffled.slice(0, MAX_CONTINUATION_WAVE);
      return {
        context: {
          contextId: `auto-continue-shuffle-${Date.now().toString(36)}`,
          label: 'Phát tiếp từ Thư viện',
          kind: 'library',
          trackIds: wave.map((t) => t.id),
        },
        startTrackId: wave[0].id,
      };
    }

    const anchorIdx = localAvailable.findIndex((t) => t.id === request.lastTrackId);
    const startIdx = anchorIdx >= 0 ? (anchorIdx + 1) % localAvailable.length : 0;
    const maxCount = Math.min(
      MAX_CONTINUATION_WAVE,
      anchorIdx >= 0 ? localAvailable.length - 1 : localAvailable.length,
    );
    const waveIds: string[] = [];
    for (let offset = 0; offset < maxCount; offset += 1) {
      const idx = (startIdx + offset) % localAvailable.length;
      const track = localAvailable[idx];
      if (track && track.id !== request.lastTrackId) {
        waveIds.push(track.id);
      }
    }
    if (waveIds.length === 0) {
      return null;
    }
    return {
      context: {
        contextId: `auto-continue-seq-${Date.now().toString(36)}`,
        label: 'Phát tiếp từ Thư viện',
        kind: 'library',
        trackIds: waveIds,
      },
      startTrackId: waveIds[0],
    };
  }

  playRandomFromLibrary(): void {
    const available = this.getUnifiedTracks().filter(
      (t) => t.source === 'local' && t.status === 'available',
    );
    if (available.length === 0) {
      this.showToast('Không có bài hát khả dụng trong thư viện để phát ngẫu nhiên.');
      return;
    }

    const qState = playbackQueueController.getState();
    const currentId = qState.currentEntry?.trackId ?? null;
    const recentIds = qState.history.slice(-15).map((e) => e.trackId);
    const anchorMeta = currentId ? this.resolveTrackMetaForShuffle(currentId) : null;

    const previewShuffled = smartShuffleItems({
      items: available,
      getTrackMeta: (t) => ({
        trackId: t.id,
        albumKey: t.albumId,
        albumTitle: t.albumTitle,
        albumArtist: t.albumArtist ?? null,
        artist: t.artist,
      }),
      anchorTrack: anchorMeta,
      recentTrackIds: recentIds,
    });

    const pickedStart = previewShuffled[0];
    this.playFromContext(
      {
        contextId: 'library-random',
        label: 'Thư viện nhạc (Ngẫu nhiên)',
        kind: 'library',
        trackIds: available.map((t) => t.id),
      },
      pickedStart?.id,
      true,
    );
  }

  getActiveSampleTrack(): PrototypeTrack | null {
    return null;
  }

  getVinylDisplayTrack(): PrototypeTrack | null {
    return null;
  }

  getCurrentPalette(): AlbumColorPalette {
    if (!this.state.preferences.dynamicAlbumColors) {
      return accentToAlbumPalette(
        this.getUserAccentPalette(),
        this.state.preferences.themeMode,
      );
    }
    if (this.state.route === 'home') {
      const playlist = this.state.playlists[this.state.selectedGalleryIndex];
      if (playlist) {
        return this.getPaletteForPlaylist(playlist);
      }
      return accentToAlbumPalette(
        this.getUserAccentPalette(),
        this.state.preferences.themeMode,
      );
    }
    if (this.state.route === 'playlist-detail') {
      const playlist = this.state.playlists.find((p) => p.id === this.state.selectedPlaylistId);
      return this.getPaletteForPlaylist(playlist);
    }
    if (this.state.route === 'album-detail') {
      const album = this.getAlbumById(this.state.selectedAlbumId);
      return album?.palette ?? computePaletteFromSeed(this.state.selectedAlbumId);
    }
    const qState = playbackQueueController.getState();
    const currentId = qState.currentEntry?.trackId;
    if (currentId) {
      return this.getPaletteForTrack(currentId);
    }
    return accentToAlbumPalette(
      this.getUserAccentPalette(),
      this.state.preferences.themeMode,
    );
  }

  // ---------------------------------------------------------------------------
  // Real Listening Statistics Tracking (SQLite in Electron, localStorage in Browser)
  // ---------------------------------------------------------------------------

  upsertLocalListeningSession(input: ListeningSessionInput, syncToElectron = true): void {
    const qualified = isQualifiedPlay(input.listenedMs, input.durationMs);
    const stored: StoredListeningSession = {
      ...input,
      qualifiedPlay: qualified,
      updatedAt: new Date().toISOString(),
    };

    const existingIdx = this.state.listeningSessions.findIndex(
      (s) => s.sessionId === input.sessionId,
    );
    const nextSessions =
      existingIdx >= 0
        ? this.state.listeningSessions.map((s, idx) => (idx === existingIdx ? stored : s))
        : [...this.state.listeningSessions, stored];

    safeWriteJson(LISTENING_SESSIONS_KEY, nextSessions);
    this.setState({
      listeningSessions: nextSessions,
      statsVersion: this.state.statsVersion + 1,
    });

    if (syncToElectron && typeof window !== 'undefined' && window.losslessApi) {
      void window.losslessApi.recordListeningSession(input).catch(() => {});
    }
  }

  async getListeningStatistics(query: StatisticsQuery): Promise<StatisticsDashboardData> {
    if (typeof window !== 'undefined' && window.losslessApi) {
      try {
        return await window.losslessApi.getListeningStatistics(query);
      } catch {
        // Fallback to local aggregated sessions if IPC unavailable
      }
    }

    const unified = this.getUnifiedTracks();
    const trackMap = new Map(unified.map((t) => [t.id, t]));
    return aggregateListeningStatistics(this.state.listeningSessions, query, (trackId) => {
      const found = trackMap.get(trackId);
      if (!found) {
        return null;
      }
      return {
        title: found.title,
        artist: found.artist,
        album: found.albumTitle,
        artworkUrl: found.coverUrl,
        isDeleted: false,
      };
    });
  }

  playSampleTrack(
    trackId: string,
    openNowPlayingView = false,
    context?: PlaybackContextDescriptor,
  ): void {
    const local = libraryStore.getTrackById(trackId);
    if (local) {
      void this.playLocalElectronTrack(local, context);
      if (openNowPlayingView) {
        this.openNowPlaying();
      }
    }
  }

  getAlbumTracksSorted(albumId: string): PrototypeTrack[] {
    const allTracks = this.getUnifiedTracks();
    return sortAlbumTracksCanonical(allTracks.filter((t) => t.albumId === albumId));
  }

  playAlbum(albumId: string, shuffleFirst?: boolean): void {
    const album = this.getAlbumById(albumId);
    const tracks = this.getAlbumTracksSorted(albumId).filter((t) => t.status === 'available');
    if (tracks.length === 0) {
      this.showToast('Không có bài hát khả dụng trong album này.');
      return;
    }
    this.playFromContext(
      {
        contextId: `album-${albumId}`,
        label: album?.title ?? tracks[0].albumTitle,
        kind: 'album',
        trackIds: tracks.map((t) => t.id),
      },
      undefined,
      shuffleFirst,
    );
  }

  async playLocalElectronTrack(
    track: TrackRecord,
    context?: PlaybackContextDescriptor,
  ): Promise<void> {
    this.setState({
      activeSource: 'local',
      sampleIsPlaying: false,
    });
    const resolvedContext: PlaybackContextDescriptor =
      context ??
      playbackQueueController.getState().context ?? {
        contextId: 'library-local',
        label: 'Thư viện nhạc',
        kind: 'library',
        trackIds: libraryStore.getSnapshot().tracks.map((t) => t.id),
      };
    const entry = playbackQueueController.playTrackInCurrentOrNewContext(
      track.id,
      resolvedContext,
    );
    await playerActions.playQueueEntry(entry);
  }

  togglePlayPause(): void {
    if (this.state.activeSource === 'local') {
      void playerActions.togglePlayPause();
      return;
    }
    const qState = playbackQueueController.getState();
    // On first press of Play when no queue context has started yet, prefer local library if available
    if (!qState.currentEntry) {
      const firstLocal = libraryStore
        .getSnapshot()
        .tracks.find((t) => t.status === 'available');
      if (firstLocal) {
        void this.playLocalElectronTrack(firstLocal);
      } else {
        this.showToast('Thư viện chưa có bài hát khả dụng để phát.');
      }
      return;
    }
    void playerActions.togglePlayPause();
  }

  seek(seconds: number): void {
    playerActions.seek(seconds);
  }

  setVolume(value: number): void {
    const clamped = Math.max(0, Math.min(1, value));
    playerActions.setVolume(clamped);
    this.setState({
      sampleVolume: clamped,
      sampleMuted: clamped === 0,
    });
  }

  toggleMute(): void {
    playerActions.toggleMute();
    this.setState({ sampleMuted: !this.state.sampleMuted });
  }

  nextTrack(): void {
    void playerActions.next();
  }

  previousTrack(): void {
    void playerActions.previous();
  }

  private ensureDerivedLibraryCaches(): void {
    const lib = libraryStore.getSnapshot();
    if (this.cachedTracksSourceRef === lib.tracks) {
      return;
    }

    const unifiedTracks: PrototypeTrack[] = new Array(lib.tracks.length);
    const trackMap = new Map<string, PrototypeTrack>();
    const byAlbum = new Map<string, PrototypeAlbum>();
    const albumTrackCounts = new Map<string, number>();

    for (let index = 0; index < lib.tracks.length; index += 1) {
      const t = lib.tracks[index];
      const albumTitle = t.album ?? 'Không rõ Album';
      const albumArtist = t.album_artist ?? t.artist ?? 'Unknown Artist';
      const albumId = buildAlbumIdSlug(albumTitle, albumArtist);
      const formatBadge = formatTrackAudioSpecs(t);
      const container = (t.container ?? t.codec ?? 'AUDIO').toUpperCase();
      const durationSec = t.duration_ms ? Math.round(t.duration_ms / 1000) : 0;
      const coverUrl = t.artwork_thumb_url ?? t.artwork_url ?? DEFAULT_DOREMI_ARTWORK_URL;

      const unified: PrototypeTrack = {
        id: t.id,
        albumId,
        title: t.title,
        artist: t.artist ?? 'Unknown Artist',
        albumTitle,
        albumArtist: t.album_artist ?? null,
        trackNumber: t.track_number ?? null,
        trackTotal: t.track_total ?? null,
        discNumber: t.disc_number ?? null,
        discTotal: t.disc_total ?? null,
        year: t.year ?? null,
        genre: t.genre ?? null,
        composer: t.composer ?? null,
        lyricist: t.lyricist ?? null,
        comment: t.comment ?? null,
        channels: t.channels ?? null,
        encoder: t.encoder ?? null,
        fileName: t.file_name ?? null,
        durationSec,
        formatBadge,
        container,
        bitDepth: t.bit_depth,
        sampleRateHz: t.sample_rate_hz,
        bitrateKbps: t.bitrate_bps ? Math.round(t.bitrate_bps / 1000) : 0,
        fileSizeBytes: t.file_size_bytes ?? 0,
        coverUrl,
        status: t.status === 'available' ? 'available' : 'missing',
        availabilityState:
          t.availability_state ?? (t.status === 'error' ? 'access_error' : t.status),
        availabilityReason: t.availability_reason ?? null,
        source: 'local',
        addedOrder: index,
        playCount: 0,
        filePathDisplay: t.original_path,
      };

      unifiedTracks[index] = unified;
      trackMap.set(unified.id, unified);
      albumTrackCounts.set(albumId, (albumTrackCounts.get(albumId) ?? 0) + 1);

      const existingAlbum = byAlbum.get(albumId);
      if (!existingAlbum) {
        byAlbum.set(albumId, {
          id: albumId,
          title: albumTitle,
          artist: albumArtist,
          year: t.year ?? null,
          genre: t.genre ?? '',
          coverUrl: coverUrl !== DEFAULT_DOREMI_ARTWORK_URL ? coverUrl : DEFAULT_DOREMI_ARTWORK_URL,
          formatLabel: formatBadge || container,
          palette: computePaletteFromSeed(`${albumTitle}::${albumArtist}`),
          description: `${albumTitle} — ${albumArtist}`,
          trackCount: 1,
          totalDurationSec: durationSec,
        });
      } else {
        existingAlbum.trackCount = (existingAlbum.trackCount ?? 0) + 1;
        existingAlbum.totalDurationSec = (existingAlbum.totalDurationSec ?? 0) + durationSec;
        if (!existingAlbum.year && t.year) {
          existingAlbum.year = t.year;
        }
        if (!existingAlbum.genre && t.genre) {
          existingAlbum.genre = t.genre;
        }
        if (
          existingAlbum.coverUrl === DEFAULT_DOREMI_ARTWORK_URL &&
          coverUrl !== DEFAULT_DOREMI_ARTWORK_URL
        ) {
          existingAlbum.coverUrl = coverUrl;
        }
      }
    }

    this.cachedTracksSourceRef = lib.tracks;
    this.cachedUnifiedTracks = unifiedTracks;
    this.cachedUnifiedTrackMap = trackMap;
    this.cachedDerivedAlbumMap = byAlbum;
    this.cachedDerivedAlbums = Array.from(byAlbum.values());
    this.cachedAlbumTrackCounts = albumTrackCounts;
  }

  getFavoriteIdSet(): Set<string> {
    if (this.cachedFavoriteIdsRef !== this.state.favoriteIds) {
      this.cachedFavoriteIdsRef = this.state.favoriteIds;
      this.cachedFavoriteIdSet = new Set(this.state.favoriteIds);
    }
    return this.cachedFavoriteIdSet;
  }

  isFavoriteTrack(trackId: string): boolean {
    return this.getFavoriteIdSet().has(trackId);
  }

  getUnifiedTracks(): PrototypeTrack[] {
    this.ensureDerivedLibraryCaches();
    return this.cachedUnifiedTracks;
  }

  getUnifiedTrackMap(): Map<string, PrototypeTrack> {
    this.ensureDerivedLibraryCaches();
    return this.cachedUnifiedTrackMap;
  }

  getDerivedAlbums(): PrototypeAlbum[] {
    this.ensureDerivedLibraryCaches();
    return this.cachedDerivedAlbums;
  }

  getAlbumById(albumId: string): PrototypeAlbum | null {
    this.ensureDerivedLibraryCaches();
    return this.cachedDerivedAlbumMap.get(albumId) ?? null;
  }

  getAlbumTrackCount(albumId: string): number {
    this.ensureDerivedLibraryCaches();
    return this.cachedAlbumTrackCounts.get(albumId) ?? 0;
  }

  getSelectedGalleryAlbum(): PrototypeAlbum | null {
    const albums = this.getDerivedAlbums();
    if (albums.length === 0) return null;
    const idx = this.state.selectedAlbumCoverflowIndex % albums.length;
    return albums[idx] ?? albums[0];
  }
}

export const uiStore = new UiStore();

export function useUiState(): UiStoreState {
  return useSyncExternalStore(uiStore.subscribe, uiStore.getSnapshot);
}
