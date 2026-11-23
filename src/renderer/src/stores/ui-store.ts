import { useSyncExternalStore } from 'react';
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
import {
  DEFAULT_EDITORIAL_TYPOGRAPHY,
  MAX_EDITORIAL_FONT_BYTES,
  normalizeEditorialTypographySettings,
  validateEditorialFontBytes,
} from '../../../shared/utils/editorial-typography';
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
  INITIAL_PROTOTYPE_PLAYLISTS,
  PROTOTYPE_ALBUMS,
  PROTOTYPE_TRACKS,
  getAlbumById,
  type AlbumColorPalette,
  type PrototypeAlbum,
  type PrototypePlaylist,
  type PrototypeTrack,
} from '../data/prototype-catalog';
import { formatTrackAudioSpecs } from '../utils/formatters';
import {
  accentToAlbumPalette,
  normalizeHexColor,
  resolveUserAccentPalette,
  type ResolvedAccentPalette,
} from '../utils/theme-presets';
import { libraryStore } from './library-store';
import { playerActions, setLocalSessionCheckpointListener } from './player-store';

const CUSTOM_LYRICS_V2_KEY = 'doremi_custom_lyrics_v2';
const LEGACY_CUSTOM_LYRICS_KEY = 'lossless_player_custom_lyrics_v1';
const CUSTOM_COVERS_KEY = 'doremi_custom_covers_v1';
const METADATA_OVERRIDES_KEY = 'doremi_metadata_overrides_v1';
const PROFILE_STORAGE_KEY = 'doremi_local_profile_v1';
const PREFERENCES_STORAGE_KEY = 'doremi_personalization_prefs_v1';
const PLAYLISTS_STORAGE_KEY = 'doremi_local_playlists_v1';
const LISTENING_SESSIONS_KEY = 'doremi_listening_sessions_v1';

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
    editorialTypography: normalizeEditorialTypographySettings(
      stored.editorialTypography,
      validFontIds,
    ),
    editorialFonts,
  };
}

function loadInitialPlaylists(): PrototypePlaylist[] {
  if (typeof window !== 'undefined' && window.localStorage.getItem(PLAYLISTS_STORAGE_KEY) !== null) {
    const stored = safeReadJson<PrototypePlaylist[]>(PLAYLISTS_STORAGE_KEY, []);
    if (Array.isArray(stored)) {
      return stored;
    }
  }
  return INITIAL_PROTOTYPE_PLAYLISTS;
}

function loadInitialSessions(): StoredListeningSession[] {
  const stored = safeReadJson<StoredListeningSession[]>(LISTENING_SESSIONS_KEY, []);
  return Array.isArray(stored) ? stored : [];
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
  | 'search'
  | 'statistics'
  | 'settings'
  | 'profile';

export type RepeatMode = 'off' | 'all' | 'one';

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
  libraryTab: 'songs' | 'albums' | 'artists' | 'playlists' | 'favorites';
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
  queueTrackIds: string[];

  // Now Playing & Vinyl Swap
  showLyricsPanel: boolean;
  nowPlayingRightTab: NowPlayingRightTab;
  nowPlayingMode: NowPlayingDisplayMode;
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

interface ActiveSampleSession {
  sessionId: string;
  track: PrototypeTrack;
  startedAtMs: number;
  accumulatedMs: number;
  activeSegmentStartMs: number | null;
  intervals: Array<{ startMs: number; endMs: number }>;
  lastFlushedMs: number;
}

class UiStore {
  private state: UiStoreState;
  private readonly listeners = new Set<() => void>();
  private playbackTimer: ReturnType<typeof setInterval> | null = null;
  private swapTimers: Array<ReturnType<typeof setTimeout>> = [];
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private sampleSession: ActiveSampleSession | null = null;
  private hydratedFromElectron = false;

  constructor() {
    const initialPrefs = loadInitialPreferences();
    const initialProfile = loadInitialProfile();
    const initialPlaylists = loadInitialPlaylists();

    this.state = {
      route: 'home',
      previousRoute: 'home',
      selectedGalleryIndex: 0,
      selectedAlbumCoverflowIndex: 0,
      selectedAlbumId: PROTOTYPE_ALBUMS[0].id,
      selectedPlaylistId: initialPlaylists[0]?.id ?? null,
      selectedArtistName: PROTOTYPE_ALBUMS[2].artist,
      libraryTab: 'songs',
      searchQuery: '',
      isQueueOpen: false,

      profile: initialProfile,
      preferences: initialPrefs,

      activeSource: 'sample',
      activeSampleTrackId: PROTOTYPE_TRACKS[0].id,
      sampleIsPlaying: false,
      sampleCurrentTimeSec: 18,
      sampleVolume: 0.82,
      sampleMuted: false,
      shuffle: false,
      repeat: 'all',
      queueTrackIds: PROTOTYPE_TRACKS.filter((t) => t.status === 'available').map((t) => t.id),

      showLyricsPanel: true,
      nowPlayingRightTab: 'lyrics',
      nowPlayingMode: 'standard',
      vinylSwapPhase: 'idle',
      vinylDisplayTrackId: PROTOTYPE_TRACKS[0].id,
      customLyricsByTrackId: loadStoredCustomLyrics(),
      customCoversByTrackId: safeReadJson<Record<string, string>>(CUSTOM_COVERS_KEY, {}),
      metadataOverridesByTrackId: safeReadJson<Record<string, TrackMetadataOverrideInput>>(
        METADATA_OVERRIDES_KEY,
        {},
      ),

      favoriteIds: [
        'trk-afterlight-1',
        'trk-midnight-1',
        'trk-golden-1',
        'trk-velvet-1',
        'alb-afterlight',
        'alb-golden-bloom',
      ],
      playlists: initialPlaylists,
      recentlyPlayedIds: [
        'trk-afterlight-1',
        'trk-midnight-1',
        'trk-golden-1',
        'trk-velvet-1',
        'trk-blue-1',
        'trk-quiet-1',
      ],
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

    // Sync initial Fade In/Out config into singleton AudioEngine immediately
    playerActions.setTransitionConfig(initialPrefs.transition);

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
    this.state = { ...this.state, ...partial };
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
      const [profile, preferences] = await Promise.all([
        window.losslessApi.getProfile(),
        window.losslessApi.getPreferences(),
      ]);
      playerActions.setTransitionConfig(preferences.transition);
      this.setState({
        profile,
        preferences,
        appearance: {
          dynamicAlbumColors: preferences.dynamicAlbumColors,
          vinylAnimation: preferences.vinylAnimation,
          reducedMotion: preferences.reducedMotion,
          backgroundEffects: preferences.backgroundEffects,
        },
      });
    } catch {
      // Fallback safely to persisted localStorage values
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
    const albumIndex = PROTOTYPE_ALBUMS.findIndex((a) => a.id === albumId);
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
    });
  }

  closeNowPlaying(): void {
    const target = this.state.previousRoute === 'now-playing' ? 'home' : this.state.previousRoute;
    this.setState({ route: target, nowPlayingMode: 'standard' });
  }

  setNowPlayingRightTab(tab: NowPlayingRightTab): void {
    this.setState({
      nowPlayingRightTab: tab,
      showLyricsPanel: tab === 'lyrics',
    });
  }

  setNowPlayingMode(mode: NowPlayingDisplayMode): void {
    if (mode === this.state.nowPlayingMode) {
      return;
    }
    this.setState({ nowPlayingMode: mode });
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
    const total = PROTOTYPE_ALBUMS.length;
    if (total === 0) {
      return;
    }
    const normalized = ((index % total) + total) % total;
    this.setState({
      selectedAlbumCoverflowIndex: normalized,
      selectedAlbumId: PROTOTYPE_ALBUMS[normalized].id,
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
          playerActions.setTransitionConfig(persisted.transition);
          this.setState({
            preferences: persisted,
            appearance: {
              dynamicAlbumColors: persisted.dynamicAlbumColors,
              vinylAnimation: persisted.vinylAnimation,
              reducedMotion: persisted.reducedMotion,
              backgroundEffects: persisted.backgroundEffects,
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

    const sample = PROTOTYPE_TRACKS.find((t) => t.id === trackId);
    if (sample?.lyrics && sample.lyrics.length > 0) {
      const rawContent = sample.lyrics
        .map((line) => {
          const mins = String(Math.floor(line.timeSec / 60)).padStart(2, '0');
          const secs = (line.timeSec % 60).toFixed(2).padStart(5, '0');
          return `[${mins}:${secs}] ${line.text}`;
        })
        .join('\n');
      return {
        trackId,
        source: 'embedded',
        format: 'lrc',
        rawContent,
        timedLines: sample.lyrics.map((l) => ({ timeSec: l.timeSec, text: l.text })),
        plainLines: sample.lyrics.map((l) => l.text),
        hasCustomLyrics: false,
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
    const sample = PROTOTYPE_TRACKS.find((t) => t.id === trackId);
    const clean = (v: string | null | undefined): string | null => {
      if (typeof v !== 'string') return null;
      const t = v.normalize('NFC').trim();
      return t.length > 0 ? t : null;
    };

    const titleOverride = clean(input.titleOverride);
    const artistOverride = clean(input.artistOverride);
    const albumOverride = clean(input.albumOverride);

    const normalized: TrackMetadataOverrideInput = {
      titleOverride: sample && titleOverride === sample.title ? null : titleOverride,
      artistOverride: sample && artistOverride === sample.artist ? null : artistOverride,
      albumOverride: sample && albumOverride === sample.albumTitle ? null : albumOverride,
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
    const sample = PROTOTYPE_TRACKS.find((t) => t.id === trackId);
    if (sample) {
      return getAlbumById(sample.albumId).palette;
    }
    const seed = localSeed || trackId;
    const idx = hashStringToIndex(seed, PROTOTYPE_ALBUMS.length);
    return PROTOTYPE_ALBUMS[idx].palette;
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
    const idx = hashStringToIndex(playlist.id || playlist.name, PROTOTYPE_ALBUMS.length);
    return PROTOTYPE_ALBUMS[idx].palette;
  }

  getCoverForTrack(trackId: string, size: 'full' | 'thumb' = 'full'): string {
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

    const sample = PROTOTYPE_TRACKS.find((t) => t.id === trackId);
    if (sample) {
      return sample.coverUrl || DEFAULT_DOREMI_ARTWORK_URL;
    }

    return DEFAULT_DOREMI_ARTWORK_URL;
  }

  /**
   * Resolves playlist artwork strictly following M5.3 priority:
   * 1) Custom playlist cover
   * 2) First track cover
   * 3) Up to 4 distinct covers for 2x2 collage
   * 4) Default artwork fallback
   */
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
  // Favorites & Playlists Management (Persisted)
  // ---------------------------------------------------------------------------

  private savePlaylists(playlists: PrototypePlaylist[], selectedGalleryIndex?: number): void {
    safeWriteJson(PLAYLISTS_STORAGE_KEY, playlists);
    const maxIdx = Math.max(0, playlists.length - 1);
    const nextIdx =
      typeof selectedGalleryIndex === 'number'
        ? Math.min(Math.max(0, selectedGalleryIndex), maxIdx)
        : Math.min(this.state.selectedGalleryIndex, maxIdx);
    this.setState({
      playlists,
      selectedGalleryIndex: nextIdx,
      selectedPlaylistId:
        playlists.some((p) => p.id === this.state.selectedPlaylistId)
          ? this.state.selectedPlaylistId
          : playlists[nextIdx]?.id ?? null,
    });
  }

  toggleFavorite(id: string): void {
    const exists = this.state.favoriteIds.includes(id);
    const favoriteIds = exists
      ? this.state.favoriteIds.filter((item) => item !== id)
      : [id, ...this.state.favoriteIds];
    this.setState({ favoriteIds });
  }

  createPlaylist(name: string, description: string, initialTrackIds?: string[]): PrototypePlaylist | null {
    const trimmed = name.normalize('NFC').trim();
    if (!trimmed) {
      return null;
    }
    const trackIds =
      initialTrackIds !== undefined
        ? initialTrackIds
        : this.state.activeSampleTrackId
          ? [this.state.activeSampleTrackId]
          : [];
    const next: PrototypePlaylist = {
      id: `pl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: trimmed,
      description: description.trim() || 'Playlist cục bộ tùy chỉnh.',
      trackIds,
      updatedLabel: `${trackIds.length} bài hát`,
      coverUrl: null,
    };
    this.savePlaylists([next, ...this.state.playlists], 0);
    this.showToast(`Đã tạo playlist "${trimmed}"`);
    return next;
  }

  renamePlaylist(playlistId: string, name: string, description?: string): void {
    const trimmed = name.normalize('NFC').trim();
    if (!trimmed) {
      return;
    }
    const updated = this.state.playlists.map((pl) =>
      pl.id === playlistId
        ? {
            ...pl,
            name: trimmed,
            description:
              typeof description === 'string' ? description.trim() || pl.description : pl.description,
          }
        : pl,
    );
    this.savePlaylists(updated);
    this.showToast(`Đã cập nhật playlist "${trimmed}"`);
  }

  setPlaylistCustomCover(playlistId: string, coverUrl: string | null): void {
    const updated = this.state.playlists.map((pl) =>
      pl.id === playlistId ? { ...pl, coverUrl } : pl,
    );
    this.savePlaylists(updated);
    this.showToast(coverUrl ? 'Đã cập nhật ảnh bìa playlist' : 'Đã gỡ ảnh bìa tùy chỉnh');
  }

  addTrackToPlaylist(playlistId: string, trackId: string): void {
    const updated = this.state.playlists.map((pl) => {
      if (pl.id !== playlistId) {
        return pl;
      }
      if (pl.trackIds.includes(trackId)) {
        return pl;
      }
      const nextTrackIds = [...pl.trackIds, trackId];
      return {
        ...pl,
        trackIds: nextTrackIds,
        updatedLabel: `${nextTrackIds.length} bài hát`,
      };
    });
    this.savePlaylists(updated);
    this.showToast('Đã thêm bài hát vào playlist');
  }

  removeTrackFromPlaylist(playlistId: string, trackId: string): void {
    const updated = this.state.playlists.map((pl) => {
      if (pl.id !== playlistId) {
        return pl;
      }
      const nextTrackIds = pl.trackIds.filter((id) => id !== trackId);
      return {
        ...pl,
        trackIds: nextTrackIds,
        updatedLabel: `${nextTrackIds.length} bài hát`,
      };
    });
    this.savePlaylists(updated);
    this.showToast('Đã gỡ bài hát khỏi playlist');
  }

  deletePlaylist(playlistId: string): void {
    const target = this.state.playlists.find((p) => p.id === playlistId);
    const remaining = this.state.playlists.filter((p) => p.id !== playlistId);
    this.savePlaylists(remaining);
    if (this.state.route === 'playlist-detail' && this.state.selectedPlaylistId === playlistId) {
      this.navigate('home');
    }
    if (target) {
      this.showToast(`Đã xóa playlist "${target.name}"`);
    }
  }

  playPlaylist(playlistId: string, shuffleFirst = false): void {
    const playlist = this.state.playlists.find((p) => p.id === playlistId);
    if (!playlist || playlist.trackIds.length === 0) {
      this.showToast('Playlist chưa có bài hát nào để phát.');
      return;
    }
    const allTracks = this.getUnifiedTracks();
    const playable = playlist.trackIds
      .map((id) => allTracks.find((t) => t.id === id))
      .filter((t): t is PrototypeTrack => Boolean(t && t.status === 'available'));

    if (playable.length === 0) {
      this.showToast('Không có bài hát khả dụng trong playlist này.');
      return;
    }

    const ordered = shuffleFirst
      ? [...playable].sort(() => Math.random() - 0.5)
      : playable;

    this.setState({
      queueTrackIds: ordered.map((t) => t.id),
      shuffle: shuffleFirst,
    });

    const first = ordered[0];
    if (first.source === 'local') {
      const localRecord = libraryStore.getSnapshot().tracks.find((t) => t.id === first.id);
      if (localRecord) {
        void this.playLocalElectronTrack(localRecord);
        return;
      }
    }
    this.playSampleTrack(first.id);
  }

  // ---------------------------------------------------------------------------
  // Queue Controls
  // ---------------------------------------------------------------------------

  playNextInQueue(trackId: string): void {
    const filtered = this.state.queueTrackIds.filter((id) => id !== trackId);
    const activeIndex = filtered.indexOf(this.state.activeSampleTrackId);
    const insertAt = activeIndex >= 0 ? activeIndex + 1 : 0;
    filtered.splice(insertAt, 0, trackId);
    this.setState({ queueTrackIds: filtered });
    this.showToast('Đã thêm vào phát tiếp theo');
  }

  removeFromQueue(trackId: string): void {
    this.setState({
      queueTrackIds: this.state.queueTrackIds.filter((id) => id !== trackId),
    });
  }

  moveQueueItem(index: number, direction: -1 | 1): void {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= this.state.queueTrackIds.length) {
      return;
    }
    const copy = [...this.state.queueTrackIds];
    const [item] = copy.splice(index, 1);
    copy.splice(nextIndex, 0, item);
    this.setState({ queueTrackIds: copy });
  }

  clearQueue(): void {
    this.setState({
      queueTrackIds: [this.state.activeSampleTrackId],
    });
    this.showToast('Đã dọn hàng đợi phát');
  }

  toggleShuffle(): void {
    this.setState({ shuffle: !this.state.shuffle });
  }

  cycleRepeat(): void {
    const order: RepeatMode[] = ['off', 'all', 'one'];
    const idx = order.indexOf(this.state.repeat);
    this.setState({ repeat: order[(idx + 1) % order.length] });
  }

  getActiveSampleTrack(): PrototypeTrack {
    const base =
      PROTOTYPE_TRACKS.find((t) => t.id === this.state.activeSampleTrackId) ??
      PROTOTYPE_TRACKS[0];
    return this.applySampleTrackOverrides(base);
  }

  getVinylDisplayTrack(): PrototypeTrack {
    const base =
      PROTOTYPE_TRACKS.find((t) => t.id === this.state.vinylDisplayTrackId) ??
      PROTOTYPE_TRACKS[0];
    return this.applySampleTrackOverrides(base);
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
      return getAlbumById(this.state.selectedAlbumId).palette;
    }
    const activeTrack = this.getActiveSampleTrack();
    return getAlbumById(activeTrack.albumId).palette;
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

  private startSampleSession(track: PrototypeTrack): void {
    const now = Date.now();
    this.finalizeSampleSession(true);
    this.sampleSession = {
      sessionId: `ls-web-${now}-${Math.random().toString(36).slice(2, 8)}`,
      track,
      startedAtMs: now,
      accumulatedMs: 0,
      activeSegmentStartMs: now,
      intervals: [],
      lastFlushedMs: 0,
    };
  }

  private pauseSampleSession(flush: boolean): void {
    if (!this.sampleSession) {
      return;
    }
    const now = Date.now();
    if (this.sampleSession.activeSegmentStartMs !== null) {
      const delta = Math.max(0, now - this.sampleSession.activeSegmentStartMs);
      if (delta > 0) {
        this.sampleSession.accumulatedMs += delta;
        this.sampleSession.intervals.push({
          startMs: this.sampleSession.activeSegmentStartMs,
          endMs: now,
        });
      }
      this.sampleSession.activeSegmentStartMs = null;
    }
    if (flush) {
      this.flushSampleSession(true);
    }
  }

  private resumeSampleSession(track: PrototypeTrack): void {
    if (!this.sampleSession || this.sampleSession.track.id !== track.id) {
      this.startSampleSession(track);
      return;
    }
    if (this.sampleSession.activeSegmentStartMs === null) {
      this.sampleSession.activeSegmentStartMs = Date.now();
    }
  }

  private finalizeSampleSession(flush: boolean): void {
    if (!this.sampleSession) {
      return;
    }
    this.pauseSampleSession(flush);
    this.sampleSession = null;
  }

  private flushSampleSession(force = false): void {
    if (!this.sampleSession) {
      return;
    }
    const now = Date.now();
    let totalMs = this.sampleSession.accumulatedMs;
    const intervals = [...this.sampleSession.intervals];
    if (this.sampleSession.activeSegmentStartMs !== null) {
      const delta = Math.max(0, now - this.sampleSession.activeSegmentStartMs);
      if (delta > 0) {
        totalMs += delta;
        intervals.push({
          startMs: this.sampleSession.activeSegmentStartMs,
          endMs: now,
        });
      }
    }
    if (totalMs < 1000) {
      return;
    }
    if (!force && totalMs - this.sampleSession.lastFlushedMs < 4000) {
      return;
    }
    this.sampleSession.lastFlushedMs = totalMs;
    const track = this.sampleSession.track;
    this.upsertLocalListeningSession({
      sessionId: this.sampleSession.sessionId,
      trackId: track.id,
      trackTitle: track.title,
      artist: track.artist,
      album: track.albumTitle,
      durationMs: track.durationSec * 1000,
      startedAtMs: this.sampleSession.startedAtMs,
      endedAtMs: Math.max(this.sampleSession.startedAtMs, now),
      listenedMs: Math.round(totalMs),
      activeIntervals: intervals,
    });
  }

  // ---------------------------------------------------------------------------
  // Playback & Vinyl Swap
  // ---------------------------------------------------------------------------

  private clearSwapTimers(): void {
    for (const timer of this.swapTimers) {
      clearTimeout(timer);
    }
    this.swapTimers = [];
  }

  private ensureSamplePlaybackTimer(): void {
    if (this.playbackTimer) {
      return;
    }
    this.playbackTimer = setInterval(() => {
      if (this.state.activeSource !== 'sample' || !this.state.sampleIsPlaying) {
        return;
      }
      const track = this.getActiveSampleTrack();
      if (!this.sampleSession || this.sampleSession.track.id !== track.id) {
        this.startSampleSession(track);
      } else {
        this.flushSampleSession(false);
      }

      const nextTime = this.state.sampleCurrentTimeSec + 0.25;
      if (nextTime >= track.durationSec) {
        this.finalizeSampleSession(true);
        if (this.state.repeat === 'one') {
          this.setState({ sampleCurrentTimeSec: 0 });
          this.startSampleSession(track);
        } else {
          this.nextTrack();
        }
      } else {
        this.setState({ sampleCurrentTimeSec: nextTime });
      }
    }, 250);
  }

  private triggerVinylSwapTo(targetTrackId: string, startPlaying = true): void {
    this.clearSwapTimers();

    const targetTrack = PROTOTYPE_TRACKS.find((t) => t.id === targetTrackId);
    if (!targetTrack) {
      return;
    }
    if (targetTrack.status === 'missing') {
      this.showToast(
        `File "${targetTrack.title}" hiện không tồn tại trên ổ đĩa (trạng thái thiếu file).`,
      );
      return;
    }

    const effectiveTrack = this.applySampleTrackOverrides(targetTrack);
    if (startPlaying) {
      this.startSampleSession(effectiveTrack);
    } else {
      this.finalizeSampleSession(true);
    }

    const recent = [
      targetTrackId,
      ...this.state.recentlyPlayedIds.filter((id) => id !== targetTrackId),
    ].slice(0, 10);

    const isSameTrack = targetTrackId === this.state.activeSampleTrackId;
    const shouldAnimateSwap =
      !isSameTrack &&
      !this.state.preferences.reducedMotion &&
      this.state.preferences.vinylAnimation;

    if (!shouldAnimateSwap) {
      this.setState({
        activeSource: 'sample',
        activeSampleTrackId: targetTrackId,
        vinylDisplayTrackId: targetTrackId,
        vinylSwapPhase: 'idle',
        sampleIsPlaying: startPlaying,
        sampleCurrentTimeSec: 0,
        recentlyPlayedIds: recent,
      });
      if (startPlaying) {
        this.ensureSamplePlaybackTimer();
      }
      return;
    }

    this.setState({
      activeSource: 'sample',
      activeSampleTrackId: targetTrackId,
      sampleIsPlaying: startPlaying,
      sampleCurrentTimeSec: 0,
      vinylSwapPhase: 'tonearm-lift',
      recentlyPlayedIds: recent,
    });
    if (startPlaying) {
      this.ensureSamplePlaybackTimer();
    }

    this.swapTimers.push(
      setTimeout(() => {
        this.setState({ vinylSwapPhase: 'disc-out' });
      }, 170),
    );

    this.swapTimers.push(
      setTimeout(() => {
        this.setState({ vinylSwapPhase: 'empty-platter' });
      }, 490),
    );

    this.swapTimers.push(
      setTimeout(() => {
        this.setState({
          vinylDisplayTrackId: targetTrackId,
          vinylSwapPhase: 'disc-in',
        });
      }, 630),
    );

    this.swapTimers.push(
      setTimeout(() => {
        this.setState({ vinylSwapPhase: 'tonearm-drop' });
      }, 920),
    );

    this.swapTimers.push(
      setTimeout(() => {
        this.setState({ vinylSwapPhase: 'idle' });
      }, 1080),
    );
  }

  playSampleTrack(trackId: string, openNowPlayingView = false): void {
    const track = PROTOTYPE_TRACKS.find((t) => t.id === trackId);
    if (!track) {
      return;
    }
    if (track.status === 'missing') {
      this.showToast(`Không thể phát "${track.title}" — file gốc không tồn tại.`);
      return;
    }
    if (this.state.activeSource === 'local') {
      playerActions.pause();
    }
    this.triggerVinylSwapTo(trackId, true);
    if (openNowPlayingView) {
      this.openNowPlaying();
    }
  }

  playAlbum(albumId: string, shuffleFirst = false): void {
    const tracks = PROTOTYPE_TRACKS.filter(
      (t) => t.albumId === albumId && t.status === 'available',
    );
    if (tracks.length === 0) {
      return;
    }
    const ordered = shuffleFirst
      ? [...tracks].sort(() => Math.random() - 0.5)
      : tracks;
    this.setState({
      queueTrackIds: ordered.map((t) => t.id),
      shuffle: shuffleFirst,
    });
    this.playSampleTrack(ordered[0].id);
  }

  async playLocalElectronTrack(track: TrackRecord): Promise<void> {
    this.finalizeSampleSession(true);
    this.setState({
      activeSource: 'local',
      sampleIsPlaying: false,
    });
    await playerActions.play(track.id);
  }

  togglePlayPause(): void {
    if (this.state.activeSource === 'local') {
      void playerActions.togglePlayPause();
      return;
    }
    const nextPlaying = !this.state.sampleIsPlaying;
    if (nextPlaying) {
      this.resumeSampleSession(this.getActiveSampleTrack());
    } else {
      this.pauseSampleSession(true);
    }
    this.setState({ sampleIsPlaying: nextPlaying });
    if (nextPlaying) {
      this.ensureSamplePlaybackTimer();
    }
  }

  seek(seconds: number): void {
    if (this.state.activeSource === 'local') {
      playerActions.seek(seconds);
      return;
    }
    // Split active session interval without adding seek-skipped duration
    if (this.state.sampleIsPlaying && this.sampleSession) {
      this.pauseSampleSession(false);
      this.sampleSession.activeSegmentStartMs = Date.now();
    }
    const track = this.getActiveSampleTrack();
    const clamped = Math.max(0, Math.min(seconds, track.durationSec));
    this.setState({ sampleCurrentTimeSec: clamped });
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
    if (this.state.activeSource === 'local') {
      void playerActions.next();
      return;
    }
    const availableQueue = this.state.queueTrackIds.filter((id) => {
      const t = PROTOTYPE_TRACKS.find((x) => x.id === id);
      return t && t.status === 'available';
    });
    if (availableQueue.length === 0) {
      return;
    }
    const currentIdx = availableQueue.indexOf(this.state.activeSampleTrackId);
    let nextIdx = 0;
    if (this.state.shuffle && availableQueue.length > 1) {
      do {
        nextIdx = Math.floor(Math.random() * availableQueue.length);
      } while (nextIdx === currentIdx);
    } else {
      nextIdx = currentIdx >= 0 ? (currentIdx + 1) % availableQueue.length : 0;
    }
    this.triggerVinylSwapTo(availableQueue[nextIdx], true);
  }

  previousTrack(): void {
    if (this.state.activeSource === 'local') {
      void playerActions.previous();
      return;
    }
    if (this.state.sampleCurrentTimeSec > 4) {
      this.seek(0);
      return;
    }
    const availableQueue = this.state.queueTrackIds.filter((id) => {
      const t = PROTOTYPE_TRACKS.find((x) => x.id === id);
      return t && t.status === 'available';
    });
    if (availableQueue.length === 0) {
      return;
    }
    const currentIdx = availableQueue.indexOf(this.state.activeSampleTrackId);
    const prevIdx = currentIdx > 0 ? currentIdx - 1 : availableQueue.length - 1;
    this.triggerVinylSwapTo(availableQueue[prevIdx], true);
  }

  getUnifiedTracks(): PrototypeTrack[] {
    const lib = libraryStore.getSnapshot();
    const mappedLocal: PrototypeTrack[] = lib.tracks.map((t, index) => {
      return {
        id: t.id,
        albumId: `local-album-${(t.album ?? 'unknown').toLowerCase()}`,
        title: t.title,
        artist: t.artist ?? 'Chưa rõ nghệ sĩ',
        albumTitle: t.album ?? 'Thư viện cục bộ',
        trackNumber: index + 1,
        durationSec: t.duration_ms ? Math.round(t.duration_ms / 1000) : 0,
        formatBadge: formatTrackAudioSpecs(t),
        container: (t.container ?? t.codec ?? 'AUDIO').toUpperCase(),
        bitDepth: t.bit_depth,
        sampleRateHz: t.sample_rate_hz,
        bitrateKbps: t.bitrate_bps ? Math.round(t.bitrate_bps / 1000) : 0,
        fileSizeBytes: t.file_size_bytes ?? 0,
        coverUrl: t.artwork_thumb_url ?? t.artwork_url ?? DEFAULT_DOREMI_ARTWORK_URL,
        status: t.status === 'available' ? 'available' : 'missing',
        source: 'local',
        addedOrder: 1000 + index,
        playCount: 0,
        filePathDisplay: t.original_path,
      };
    });

    const mappedSamples = PROTOTYPE_TRACKS.map((track) =>
      this.applySampleTrackOverrides(track),
    );

    return [...mappedLocal, ...mappedSamples];
  }

  getAlbumTrackCount(albumId: string): number {
    return PROTOTYPE_TRACKS.filter((t) => t.albumId === albumId).length;
  }

  getSelectedGalleryAlbum(): PrototypeAlbum {
    return PROTOTYPE_ALBUMS[this.state.selectedAlbumCoverflowIndex] ?? PROTOTYPE_ALBUMS[0];
  }
}

export const uiStore = new UiStore();

export function useUiState(): UiStoreState {
  return useSyncExternalStore(uiStore.subscribe, uiStore.getSnapshot);
}
