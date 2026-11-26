export interface PlaylistTrackEntryRecord {
  entryId: string;
  trackId: string;
  position: number;
  addedAt: string;
}

export interface PlaylistRecord {
  id: string;
  name: string;
  description: string;
  artworkUrl: string | null;
  hasCustomArtwork: boolean;
  /** Ordered track IDs (convenience mirror of `entries`) */
  trackIds: string[];
  /** Canonical ordered entries with entryId for duplicate-safe reorder/removal */
  entries: PlaylistTrackEntryRecord[];
  trackCount: number;
  totalDurationMs: number;
  availableCount: number;
  missingCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePlaylistInput {
  name: string;
  description?: string | null;
  initialTrackIds?: readonly string[];
  allowDuplicates?: boolean;
}

export interface UpdatePlaylistInput {
  name?: string;
  description?: string | null;
}

export interface AddTracksToPlaylistOptions {
  allowDuplicates?: boolean;
}

export interface AddTracksToPlaylistResult {
  playlist: PlaylistRecord;
  addedCount: number;
  skippedDuplicateCount: number;
  ignoredInvalidCount: number;
}

export interface PlaylistArtworkActionResult {
  canceled: boolean;
  playlist: PlaylistRecord | null;
  error?: string;
}

export interface LegacyPlaylistMigrationItem {
  id?: string;
  name: string;
  description?: string | null;
  trackIds: readonly string[];
}

export interface LegacyCollectionsMigrationInput {
  playlists: readonly LegacyPlaylistMigrationItem[];
  favoriteIds: readonly string[];
}

export interface PlaylistSnapshot {
  playlists: PlaylistRecord[];
  favoriteTrackIds: string[];
}
