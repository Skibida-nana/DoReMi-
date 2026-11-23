import type { ReplayGainSettings } from './stage6';

export type ThemeMode = 'dark' | 'light';

export type UiQualityPreset = 'high' | 'balanced' | 'power-saver';

export type HomeBackgroundMode = 'dynamic' | 'custom' | 'default';

export type FadeDurationSec = 0.5 | 1 | 2 | 3;

export type LyricsEncodingOption =
  | 'auto'
  | 'utf-8'
  | 'utf-16le'
  | 'utf-16be'
  | 'shift_jis'
  | 'gb18030'
  | 'euc-kr'
  | 'big5';

export interface ThemeAccentPreset {
  id: string;
  name: string;
  hex: string;
  glowRgb: string;
  secondaryHex: string;
  secondaryGlowRgb: string;
}

export interface LocalUserProfile {
  displayName: string;
  avatarUrl: string | null;
  avatarMime: string | null;
  avatarIsAnimated: boolean;
  avatarHash: string | null;
  updatedAt: string;
}

export interface PlaybackTransitionSettings {
  enabled: boolean;
  durationSec: FadeDurationSec;
}

export type EditorialFontFormat = 'ttf' | 'otf' | 'woff' | 'woff2';

export interface CustomEditorialFontRecord {
  id: string;
  name: string;
  fileName: string;
  format: EditorialFontFormat;
  mimeType: string;
  /** Served via lossless-media://profile/font/<id> in Electron or data:font/... in web preview */
  url: string;
  hash: string;
  sizeBytes: number;
  addedAt: string;
}

export interface EditorialTypographySettings {
  enabled: boolean;
  topText: string;
  bottomText: string;
  /** null = default DoReMi display font */
  selectedFontId: string | null;
  /** Responsive size multiplier (0.75..1.25, default 1) */
  fontSizeScale: number;
  /** Base visibility opacity (0.08..0.32, default 0.18) */
  opacity: number;
}

export interface PersonalizationPreferences {
  themeMode: ThemeMode;
  accentPresetId: string;
  customAccentHex: string | null;
  homeBackgroundMode: HomeBackgroundMode;
  customBackgroundUrl: string | null;
  customBackgroundHash: string | null;
  dynamicAlbumColors: boolean;
  vinylAnimation: boolean;
  reducedMotion: boolean;
  reduceMotionStaticGif: boolean;
  backgroundEffects: boolean;
  uiQualityPreset: UiQualityPreset;
  transition: PlaybackTransitionSettings;
  replayGain: ReplayGainSettings;
  autoScanFolders: boolean;
  resumePlaybackOnStartup: boolean;
  editorialTypography: EditorialTypographySettings;
  editorialFonts: CustomEditorialFontRecord[];
}

export interface PlaylistRecord {
  id: string;
  name: string;
  description: string;
  coverUrl: string | null;
  coverHash: string | null;
  trackIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type StatisticsTimeRange = 'today' | 'week' | 'month' | 'year' | 'all' | 'custom';

export interface StatisticsQuery {
  range: StatisticsTimeRange;
  /** 0 = current period, -1 = previous period, -2 = 2 periods ago, etc. */
  periodOffset?: number;
  /** Local YYYY-MM-DD bounds used when range === 'custom' */
  customStartDate?: string;
  customEndDate?: string;
  /** Reference epoch ms (defaults to Date.now(); injectable for deterministic tests) */
  nowMs?: number;
}

export interface ListeningSessionInput {
  sessionId: string;
  trackId: string;
  trackTitle: string;
  artist: string | null;
  album: string | null;
  durationMs: number | null;
  startedAtMs: number;
  endedAtMs: number;
  /** Actual active playback milliseconds (excludes pause, buffering, and seek skips) */
  listenedMs: number;
  /** Explicit per-segment active playback intervals for exact cross-midnight / hourly attribution */
  activeIntervals?: Array<{ startMs: number; endMs: number }>;
  isDeletedTrack?: boolean;
}

export interface StoredListeningSession extends ListeningSessionInput {
  qualifiedPlay: boolean;
  updatedAt: string;
}

export interface ListeningDayPoint {
  dateKey: string; // Local YYYY-MM-DD
  label: string;
  listenedMs: number;
  minutes: number;
  qualifiedPlays: number;
}

export interface ListeningHourPoint {
  hour: number; // 0..23 local hour
  label: string;
  listenedMs: number;
  minutes: number;
}

export interface TopTrackStat {
  trackId: string;
  title: string;
  artist: string;
  album: string;
  qualifiedPlays: number;
  listenedMs: number;
  isDeleted: boolean;
  artworkUrl: string | null;
}

export interface TopArtistStat {
  artist: string;
  qualifiedPlays: number;
  listenedMs: number;
  sharePct: number;
}

export interface TopAlbumStat {
  album: string;
  artist: string;
  qualifiedPlays: number;
  listenedMs: number;
  artworkUrl: string | null;
}

export interface DeletedTracksStatGroup {
  uniqueTrackCount: number;
  qualifiedPlays: number;
  listenedMs: number;
}

export interface StatisticsDashboardData {
  range: StatisticsTimeRange;
  periodLabel: string;
  startDateKey: string;
  endDateKey: string;
  canStepForward: boolean;
  totalListenedMs: number;
  qualifiedPlays: number;
  uniqueTracksPlayed: number;
  averageDailyMs: number;
  dayCountInPeriod: number;
  byDay: ListeningDayPoint[];
  byHour: ListeningHourPoint[];
  topTracks: TopTrackStat[];
  topArtists: TopArtistStat[];
  topAlbums: TopAlbumStat[];
  deletedGroup: DeletedTracksStatGroup;
  hasAnyData: boolean;
}
