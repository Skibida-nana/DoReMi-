import fs from 'node:fs/promises';
import path from 'node:path';
import { isAudioExtensionSupported } from '../../shared/contracts/media-protocol';
import type {
  ClearLibraryResult,
  ImportErrorItem,
  ImportSummary,
  LibraryExclusionRecord,
  LibraryRootRecord,
  LibrarySnapshot,
  ReimportExcludedResult,
  RelinkSingleFileResult,
  RemoveTracksResult,
  RemoveWatchedFolderMode,
  RemoveWatchedFolderResult,
  ScanProgressEvent,
  VerifyTrackResult,
  WatchedFolderSummary,
} from '../../shared/types/library';
import type {
  RelinkApplyResult,
  RelinkApplySelection,
  RelinkFileCandidate,
  RelinkScanResult,
  RelinkTrackProposal,
} from '../../shared/types/stage6';
import type {
  TrackAvailabilityState,
  TrackMetadataOverrideInput,
  TrackRecord,
  TrackStatus,
} from '../../shared/types/track';
import {
  extractFileNameFromPath,
  normalizeFolderKey,
} from '../../shared/utils/natural-sort';
import {
  matchesExclusionFingerprint,
  type ExclusionRepository,
} from '../database/exclusion-repository';
import type { LibraryRootRepository } from '../database/library-root-repository';
import type { LyricsRepository } from '../database/lyrics-repository';
import type { MetadataOverrideRepository } from '../database/metadata-override-repository';
import {
  availabilityToTrackStatus,
  type TrackRepository,
  type UpsertTrackInput,
} from '../database/track-repository';
import type { ArtworkService } from './artwork-service';
import { MetadataReadError, readTrackMetadata } from './metadata-service';
import {
  cleanOriginalPath,
  extractFallbackTitle,
  extractFileExtension,
  findMostSpecificWatchedRootId,
  isNormalizedPathWithinRoot,
  normalizeTrackPath,
} from './path-utils';
import { discoverAudioFilesInFolder } from './scanner-service';

export interface LibraryServiceOptions {
  trackRepo: TrackRepository;
  rootRepo: LibraryRootRepository;
  databasePath: string;
  platform?: NodeJS.Platform;
  artworkService?: ArtworkService;
  lyricsRepo?: LyricsRepository;
  metadataOverrideRepo?: MetadataOverrideRepository;
  exclusionRepo?: ExclusionRepository;
}

interface PreparedTrackPayload {
  input: UpsertTrackInput;
  embeddedLyrics?: string | null;
  shouldSyncArtwork: boolean;
}

interface StatResult {
  stat: import('node:fs').Stats | null;
  kind: 'ok' | 'missing' | 'access_error' | 'not_file';
  reason?: string;
}

export const CURRENT_TRACK_METADATA_VERSION = 2;

export interface LegacyMetadataRevalidationResult {
  checkedCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  canceled: boolean;
}

export class LibraryService {
  private readonly trackRepo: TrackRepository;
  private readonly rootRepo: LibraryRootRepository;
  private readonly databasePath: string;
  private readonly platform: NodeJS.Platform;
  private readonly artworkService?: ArtworkService;
  private readonly lyricsRepo?: LyricsRepository;
  private readonly metadataOverrideRepo?: MetadataOverrideRepository;
  private readonly exclusionRepo?: ExclusionRepository;
  private activeScanAbort: AbortController | null = null;

  constructor(options: LibraryServiceOptions) {
    this.trackRepo = options.trackRepo;
    this.rootRepo = options.rootRepo;
    this.databasePath = options.databasePath;
    this.platform = options.platform ?? process.platform;
    this.artworkService = options.artworkService;
    this.lyricsRepo = options.lyricsRepo;
    this.metadataOverrideRepo = options.metadataOverrideRepo;
    this.exclusionRepo = options.exclusionRepo;
  }

  getSnapshot(): LibrarySnapshot {
    const rawTracks = this.trackRepo.findAll();
    const tracks = this.artworkService
      ? this.artworkService.enrichTracks(rawTracks)
      : rawTracks;

    return {
      tracks,
      roots: this.rootRepo.findAll(),
      databasePath: this.databasePath,
    };
  }

  cancelActiveScan(): boolean {
    if (this.activeScanAbort && !this.activeScanAbort.signal.aborted) {
      this.activeScanAbort.abort();
      return true;
    }
    return false;
  }

  removeLibraryRoot(rootId: string): boolean {
    return this.rootRepo.deleteRoot(rootId);
  }

  updateLibraryRootSettings(
    rootId: string,
    patch: { recursive?: boolean; enabled?: boolean; auto_watch?: boolean },
  ): LibraryRootRecord | null {
    return this.rootRepo.updateRootSettings(rootId, patch);
  }

  markPathsMissing(filePaths: readonly string[]): number {
    const updates: Array<{
      id: string;
      status: TrackStatus;
      availability_state: TrackAvailabilityState;
      availability_reason: string;
    }> = [];
    for (const rawPath of filePaths) {
      let normalized: string;
      try {
        normalized = normalizeTrackPath(cleanOriginalPath(rawPath, this.platform), this.platform);
      } catch {
        continue;
      }
      const existing = this.trackRepo.findByNormalizedPath(normalized);
      if (existing && existing.status !== 'missing') {
        updates.push({
          id: existing.id,
          status: 'missing',
          availability_state: 'missing',
          availability_reason: 'File âm thanh gốc không còn tại đường dẫn đã lưu.',
        });
      }
    }
    if (updates.length === 0) {
      return 0;
    }
    return this.trackRepo.updateStatusesBatch(updates);
  }

  /**
   * Saves in-app metadata overrides strictly inside SQLite.
   * Never modifies the source audio file or changes Stable Track ID.
   */
  updateTrackMetadataOverride(
    trackId: string,
    input: TrackMetadataOverrideInput,
  ): TrackRecord {
    const existing = this.trackRepo.findById(trackId);
    if (!existing) {
      throw new Error('Không tìm thấy bài hát trong cơ sở dữ liệu.');
    }
    if (!this.metadataOverrideRepo) {
      throw new Error('Dịch vụ chỉnh sửa metadata chưa được khởi tạo.');
    }

    const cleanOrNull = (val: string | null | undefined): string | null => {
      if (typeof val !== 'string') return null;
      const trimmed = val.normalize('NFC').trim();
      return trimmed.length > 0 ? trimmed : null;
    };

    const cleanPosInt = (val: number | null | undefined): number | null => {
      if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) return null;
      return Math.round(val);
    };

    const cleanYear = (val: number | null | undefined): number | null => {
      if (typeof val !== 'number' || !Number.isFinite(val)) return null;
      const r = Math.round(val);
      return r >= 1000 && r <= 2999 ? r : null;
    };

    const origTitle = existing.original_title ?? existing.title;
    const origArtist = existing.original_artist ?? existing.artist;
    const origAlbum =
      existing.original_album !== undefined ? existing.original_album : existing.album;
    const origGenre =
      existing.original_genre !== undefined ? existing.original_genre : existing.genre ?? null;
    const origYear =
      existing.original_year !== undefined ? existing.original_year : existing.year ?? null;
    const origAlbumArtist =
      existing.original_album_artist !== undefined
        ? existing.original_album_artist
        : existing.album_artist ?? null;
    const origTrackNum =
      existing.original_track_number !== undefined
        ? existing.original_track_number
        : existing.track_number ?? null;
    const origTrackTotal =
      existing.original_track_total !== undefined
        ? existing.original_track_total
        : existing.track_total ?? null;
    const origDiscNum =
      existing.original_disc_number !== undefined
        ? existing.original_disc_number
        : existing.disc_number ?? null;
    const origDiscTotal =
      existing.original_disc_total !== undefined
        ? existing.original_disc_total
        : existing.disc_total ?? null;
    const origComposer =
      existing.original_composer !== undefined
        ? existing.original_composer
        : existing.composer ?? null;
    const origLyricist =
      existing.original_lyricist !== undefined
        ? existing.original_lyricist
        : existing.lyricist ?? null;
    const origComment =
      existing.original_comment !== undefined
        ? existing.original_comment
        : existing.comment ?? null;

    const nextTitle = cleanOrNull(input.titleOverride);
    const nextArtist = cleanOrNull(input.artistOverride);
    const nextAlbum = cleanOrNull(input.albumOverride);

    const payload: TrackMetadataOverrideInput = {
      titleOverride: nextTitle && nextTitle !== origTitle ? nextTitle : null,
      artistOverride: nextArtist && nextArtist !== origArtist ? nextArtist : null,
      albumOverride: nextAlbum && nextAlbum !== (origAlbum ?? '') ? nextAlbum : null,
    };

    if (input.genreOverride !== undefined) {
      const nextGenre = cleanOrNull(input.genreOverride);
      payload.genreOverride = nextGenre && nextGenre !== (origGenre ?? '') ? nextGenre : null;
    }
    if (input.yearOverride !== undefined) {
      const nextYear = cleanYear(input.yearOverride);
      payload.yearOverride = nextYear !== null && nextYear !== origYear ? nextYear : null;
    }
    if (input.albumArtistOverride !== undefined) {
      const nextAA = cleanOrNull(input.albumArtistOverride);
      payload.albumArtistOverride =
        nextAA && nextAA !== (origAlbumArtist ?? '') ? nextAA : null;
    }
    if (input.trackNumberOverride !== undefined) {
      const nextTN = cleanPosInt(input.trackNumberOverride);
      payload.trackNumberOverride = nextTN !== null && nextTN !== origTrackNum ? nextTN : null;
    }
    if (input.trackTotalOverride !== undefined) {
      const nextTT = cleanPosInt(input.trackTotalOverride);
      payload.trackTotalOverride = nextTT !== null && nextTT !== origTrackTotal ? nextTT : null;
    }
    if (input.discNumberOverride !== undefined) {
      const nextDN = cleanPosInt(input.discNumberOverride);
      payload.discNumberOverride = nextDN !== null && nextDN !== origDiscNum ? nextDN : null;
    }
    if (input.discTotalOverride !== undefined) {
      const nextDT = cleanPosInt(input.discTotalOverride);
      payload.discTotalOverride = nextDT !== null && nextDT !== origDiscTotal ? nextDT : null;
    }
    if (input.composerOverride !== undefined) {
      const nextComp = cleanOrNull(input.composerOverride);
      payload.composerOverride =
        nextComp && nextComp !== (origComposer ?? '') ? nextComp : null;
    }
    if (input.lyricistOverride !== undefined) {
      const nextLyr = cleanOrNull(input.lyricistOverride);
      payload.lyricistOverride = nextLyr && nextLyr !== (origLyricist ?? '') ? nextLyr : null;
    }
    if (input.commentOverride !== undefined) {
      const nextCom = cleanOrNull(input.commentOverride);
      payload.commentOverride = nextCom && nextCom !== (origComment ?? '') ? nextCom : null;
    }

    this.metadataOverrideRepo.upsertOverride(trackId, payload);

    const refreshed = this.trackRepo.findById(trackId) ?? existing;
    return this.artworkService ? this.artworkService.enrichTrack(refreshed) : refreshed;
  }

  restoreTrackMetadataOriginal(trackId: string): TrackRecord {
    const existing = this.trackRepo.findById(trackId);
    if (!existing) {
      throw new Error('Không tìm thấy bài hát trong cơ sở dữ liệu.');
    }
    this.metadataOverrideRepo?.deleteOverride(trackId);
    const refreshed = this.trackRepo.findById(trackId) ?? existing;
    return this.artworkService ? this.artworkService.enrichTrack(refreshed) : refreshed;
  }

  /**
   * Removes selected tracks from SQLite library ONLY (never modifies or deletes original audio files).
   * Cascade cleans playlist_tracks / favorites / overrides / custom artwork while preserving listening_sessions.
   */
  removeTracks(
    trackIds: readonly string[],
    options?: { addExclusion?: boolean },
  ): RemoveTracksResult {
    const addExclusion = options?.addExclusion !== false;
    const uniqueIds = Array.from(new Set(trackIds.filter((id) => typeof id === 'string' && id)));
    const foundTracks = this.trackRepo.findByIds(uniqueIds);
    const foundSet = new Set(foundTracks.map((t) => t.id));
    const notFoundIds = uniqueIds.filter((id) => !foundSet.has(id));

    if (foundTracks.length === 0) {
      return { removedTrackIds: [], excludedCount: 0, notFoundIds };
    }

    const roots = this.rootRepo.findAll();
    const db = this.trackRepo.getDatabase();
    let excludedCount = 0;

    const tx = db.transaction(() => {
      if (addExclusion && this.exclusionRepo) {
        const exclusions = foundTracks.map((t) => ({
          normalized_path: t.normalized_path,
          original_path: t.original_path,
          root_id: findMostSpecificWatchedRootId(t.normalized_path, roots),
          file_size_bytes: t.file_size_bytes,
          modified_at_ms: t.modified_at_ms,
          title: t.original_title ?? t.title,
          artist: t.original_artist ?? t.artist,
          album: t.original_album !== undefined ? t.original_album : t.album,
          reason: 'user-removed',
        }));
        excludedCount = this.exclusionRepo.upsertBatch(exclusions);
      }

      this.trackRepo.deleteByIds(foundTracks.map((t) => t.id));
    });

    tx();

    if (this.artworkService) {
      void this.artworkService.pruneOrphanedMediaFiles().catch(() => {});
    }

    return {
      removedTrackIds: foundTracks.map((t) => t.id),
      excludedCount,
      notFoundIds,
    };
  }

  async listWatchedFolders(): Promise<WatchedFolderSummary[]> {
    const roots = this.rootRepo.findAll();
    const tracks = this.trackRepo.findAll();
    const summaries: WatchedFolderSummary[] = [];

    for (const root of roots) {
      const dirProbe = await inspectDirectory(root.original_path);
      const exists = dirProbe === 'ok';

      let trackCount = 0;
      let missingCount = 0;
      for (const track of tracks) {
        if (findMostSpecificWatchedRootId(track.normalized_path, roots) === root.id) {
          trackCount += 1;
          if (track.status !== 'available') {
            missingCount += 1;
          }
        }
      }

      summaries.push({
        ...root,
        exists,
        trackCount,
        missingCount,
      });
    }

    return summaries;
  }

  removeWatchedFolder(
    rootId: string,
    mode: RemoveWatchedFolderMode = 'stop-watching',
  ): RemoveWatchedFolderResult {
    const existing = this.rootRepo.findById(rootId);
    if (!existing) {
      return {
        removed: false,
        rootId,
        mode,
        removedTrackIds: [],
        remainingRootCount: this.rootRepo.findAll().length,
      };
    }

    const roots = this.rootRepo.findAll();
    const removedTrackIds: string[] = [];
    const db = this.trackRepo.getDatabase();

    const tx = db.transaction(() => {
      if (mode === 'remove-tracks') {
        const allTracks = this.trackRepo.findAll();
        const targetIds = allTracks
          .filter((t) => findMostSpecificWatchedRootId(t.normalized_path, roots) === rootId)
          .map((t) => t.id);

        if (targetIds.length > 0) {
          this.trackRepo.deleteByIds(targetIds);
          removedTrackIds.push(...targetIds);
        }
        this.exclusionRepo?.deleteByRootId(rootId);
      }
      this.rootRepo.deleteRoot(rootId);
    });

    tx();

    if (removedTrackIds.length > 0 && this.artworkService) {
      void this.artworkService.pruneOrphanedMediaFiles().catch(() => {});
    }

    return {
      removed: true,
      rootId,
      mode,
      removedTrackIds,
      remainingRootCount: this.rootRepo.findAll().length,
    };
  }

  clearAllImportedMusic(): ClearLibraryResult {
    const db = this.trackRepo.getDatabase();
    let removedTrackCount = 0;
    let removedRootCount = 0;
    let clearedExclusionCount = 0;

    const tx = db.transaction(() => {
      removedTrackCount = this.trackRepo.deleteAll();
      removedRootCount = this.rootRepo.deleteAllRoots();
      clearedExclusionCount = this.exclusionRepo ? this.exclusionRepo.clearAll() : 0;
    });

    tx();

    if (removedTrackCount > 0 && this.artworkService) {
      void this.artworkService.pruneOrphanedMediaFiles().catch(() => {});
    }

    return {
      removedTrackCount,
      removedRootCount,
      clearedExclusionCount,
    };
  }

  listExcludedTracks(): LibraryExclusionRecord[] {
    return this.exclusionRepo ? this.exclusionRepo.findAll() : [];
  }

  clearExclusions(exclusionIds?: readonly string[]): number {
    if (!this.exclusionRepo) {
      return 0;
    }
    if (!exclusionIds || exclusionIds.length === 0) {
      return this.exclusionRepo.clearAll();
    }
    return this.exclusionRepo.deleteByIds(exclusionIds);
  }

  async reimportExcludedTracks(
    exclusionIds?: readonly string[],
    onProgress?: (event: ScanProgressEvent) => void,
  ): Promise<ReimportExcludedResult> {
    if (!this.exclusionRepo) {
      return {
        reimportedCount: 0,
        clearedExclusionCount: 0,
        summary: createEmptySummary(false),
      };
    }

    const targets =
      exclusionIds && exclusionIds.length > 0
        ? this.exclusionRepo.findByIds(exclusionIds)
        : this.exclusionRepo.findAll();

    if (targets.length === 0) {
      return {
        reimportedCount: 0,
        clearedExclusionCount: 0,
        summary: createEmptySummary(false),
      };
    }

    const targetIds = targets.map((e) => e.id);
    const pathsToImport = targets.map((e) => e.original_path);
    const clearedExclusionCount = this.exclusionRepo.deleteByIds(targetIds);
    const summary = await this.importFiles(pathsToImport, onProgress, {
      respectExclusions: false,
    });

    return {
      reimportedCount: summary.addedCount + summary.recoveredCount + summary.updatedCount,
      clearedExclusionCount,
      summary,
    };
  }

  /**
   * Imports individual audio files selected by the user.
   * Respects exclusions ONLY when `options.respectExclusions` is explicitly true (automatic scans).
   * Manual file selection clears matching exclusion rows so the user stays in full control.
   */
  async importFiles(
    filePaths: readonly string[],
    onProgress?: (event: ScanProgressEvent) => void,
    options?: {
      respectExclusions?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<ImportSummary> {
    if (filePaths.length === 0) {
      return createEmptySummary(true);
    }

    const respectExclusions = Boolean(options?.respectExclusions);
    const signal = options?.signal;
    const exclusionMap = new Map<string, LibraryExclusionRecord>();
    if (respectExclusions && this.exclusionRepo) {
      for (const exc of this.exclusionRepo.findAll()) {
        exclusionMap.set(exc.normalized_path, exc);
      }
    }

    const errors: ImportErrorItem[] = [];
    const payloads: PreparedTrackPayload[] = [];
    const seenNormalized = new Set<string>();
    const total = filePaths.length;
    let excludedSkippedCount = 0;
    let duplicateSkippedCount = 0;

    // Bounded concurrent preparation (batch size = 4) for fast U-series laptop performance
    const CONCURRENCY = 4;
    let processed = 0;

    for (let start = 0; start < total; start += CONCURRENCY) {
      if (signal?.aborted) {
        onProgress?.({
          phase: 'canceled',
          current: processed,
          total,
          currentPath: null,
          message: `Đã hủy quét (${processed}/${total} file đã kiểm tra).`,
        });
        break;
      }

      const slice = filePaths.slice(start, start + CONCURRENCY);
      const batchPayloads = await Promise.all(
        slice.map(async (rawPath, offset) => {
          const idx = start + offset;
          const cleanedPath = cleanOriginalPath(rawPath, this.platform);
          const ext = extractFileExtension(cleanedPath);

          onProgress?.({
            phase: 'importing',
            current: idx + 1,
            total,
            currentPath: cleanedPath,
            message: `Đang đọc metadata (${idx + 1}/${total})...`,
          });

          if (!isAudioExtensionSupported(ext)) {
            errors.push({
              path: cleanedPath,
              reason: `Định dạng "${ext || 'không xác định'}" chưa được hỗ trợ trong DoReMi.`,
            });
            return null;
          }

          let normalizedPath: string;
          try {
            normalizedPath = normalizeTrackPath(cleanedPath, this.platform);
          } catch (error) {
            errors.push({
              path: cleanedPath,
              reason: error instanceof Error ? error.message : String(error),
            });
            return null;
          }

          if (seenNormalized.has(normalizedPath)) {
            duplicateSkippedCount += 1;
            return null;
          }
          seenNormalized.add(normalizedPath);

          if (respectExclusions && exclusionMap.has(normalizedPath)) {
            const excl = exclusionMap.get(normalizedPath)!;
            const probe = await inspectFile(cleanedPath);
            if (
              probe.stat &&
              matchesExclusionFingerprint(
                excl,
                probe.stat.size,
                Math.round(probe.stat.mtimeMs),
              )
            ) {
              excludedSkippedCount += 1;
              return null;
            }
          } else if (!respectExclusions && this.exclusionRepo) {
            // User explicitly selected this path -> clear any stale exclusion cleanly
            this.exclusionRepo.deleteByNormalizedPaths([normalizedPath]);
          }

          return this.prepareTrackInput(cleanedPath, normalizedPath, errors);
        }),
      );

      for (const prepared of batchPayloads) {
        if (prepared) {
          payloads.push(prepared);
        }
      }

      processed += slice.length;
      if (processed % 8 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    const wasCanceled = Boolean(signal?.aborted);
    const batchSummary =
      payloads.length > 0
        ? this.trackRepo.upsertBatch(payloads.map((item) => item.input))
        : { addedCount: 0, updatedCount: 0, skippedCount: 0, recoveredCount: 0 };

    if (this.artworkService || this.lyricsRepo) {
      const folderCoverCache = new Map<string, string | null>();
      let syncedCount = 0;
      for (let i = 0; i < payloads.length; i += 1) {
        if (signal?.aborted) {
          break;
        }
        const item = payloads[i];
        if (item.embeddedLyrics === undefined && !item.shouldSyncArtwork) {
          continue;
        }
        const persisted = this.trackRepo.findByNormalizedPath(item.input.normalized_path);
        if (!persisted) {
          continue;
        }

        if (this.lyricsRepo && item.embeddedLyrics !== undefined) {
          this.lyricsRepo.setEmbeddedLyrics(persisted.id, item.embeddedLyrics);
        }

        if (this.artworkService && item.shouldSyncArtwork && persisted.status === 'available') {
          await this.artworkService.syncAutoArtworkForTrack(persisted, { folderCoverCache });
        }

        syncedCount += 1;
        if (syncedCount % 10 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    }

    onProgress?.({
      phase: wasCanceled ? 'canceled' : 'completed',
      current: processed,
      total,
      currentPath: null,
      message: wasCanceled
        ? `Đã hủy quét (${batchSummary.addedCount} bài đã lưu).`
        : `Hoàn tất import: thêm ${batchSummary.addedCount}, cập nhật ${batchSummary.updatedCount}, lỗi ${errors.length}.`,
    });

    return {
      canceled: wasCanceled,
      scannedCount: processed,
      addedCount: batchSummary.addedCount,
      updatedCount: batchSummary.updatedCount,
      skippedCount: batchSummary.skippedCount + duplicateSkippedCount,
      missingMarkedCount: 0,
      recoveredCount: batchSummary.recoveredCount,
      excludedSkippedCount,
      duplicateSkippedCount,
      errors,
    };
  }

  async importFolder(
    folderPath: string,
    onProgress?: (event: ScanProgressEvent) => void,
  ): Promise<ImportSummary> {
    const cleanedFolder = cleanOriginalPath(folderPath, this.platform);
    const normalizedFolder = normalizeTrackPath(cleanedFolder, this.platform);

    const dirProbe = await inspectDirectory(cleanedFolder);
    if (dirProbe !== 'ok') {
      return {
        ...createEmptySummary(false),
        errors: [
          {
            path: cleanedFolder,
            reason:
              dirProbe === 'access_error'
                ? 'Không đủ quyền truy cập thư mục đã chọn.'
                : 'Không thể mở thư mục hoặc thư mục không tồn tại.',
          },
        ],
      };
    }

    const root = this.rootRepo.upsertRoot(cleanedFolder, normalizedFolder);
    const controller = new AbortController();
    this.activeScanAbort = controller;

    try {
      const discovery = await discoverAudioFilesInFolder(cleanedFolder, {
        recursive: root.recursive !== false,
        signal: controller.signal,
        onProgress,
      });

      if (discovery.canceled) {
        return {
          ...createEmptySummary(true),
          errors: discovery.errors,
        };
      }

      if (discovery.files.length === 0) {
        onProgress?.({
          phase: 'completed',
          current: 0,
          total: 0,
          currentPath: null,
          message: 'Không tìm thấy file nhạc hợp lệ nào trong thư mục đã chọn.',
        });

        return {
          ...createEmptySummary(false),
          errors: discovery.errors,
        };
      }

      const fileSummary = await this.importFiles(discovery.files, onProgress, {
        respectExclusions: false,
        signal: controller.signal,
      });
      return {
        ...fileSummary,
        rootCount: 1,
        errors: [...discovery.errors, ...fileSummary.errors],
      };
    } finally {
      if (this.activeScanAbort === controller) {
        this.activeScanAbort = null;
      }
    }
  }

  /**
   * Smart Rescan across all enabled roots (or one specific watched root):
   * - Respects library_exclusions
   * - Distinguishes missing vs source_unavailable vs access_error
   * - Deduplicates overlapping nested roots
   * - Supports clean cancellation
   */
  async rescanLibrary(
    onProgress?: (event: ScanProgressEvent) => void,
    options?: { targetRootId?: string },
  ): Promise<ImportSummary> {
    const controller = new AbortController();
    this.activeScanAbort = controller;

    try {
      const errors: ImportErrorItem[] = [];
      const allRoots = this.rootRepo.findAll();
      const targetRoots = options?.targetRootId
        ? allRoots.filter((r) => r.id === options.targetRootId)
        : allRoots.filter((r) => r.enabled !== false);

      const rootProbeResults = new Map<string, 'ok' | 'missing' | 'access_error'>();
      for (const root of allRoots) {
        const probe = await inspectDirectory(root.original_path);
        rootProbeResults.set(root.id, probe);
      }

      const existingTracks = this.trackRepo.findAll();
      const scopedTracks = options?.targetRootId
        ? existingTracks.filter(
            (t) => findMostSpecificWatchedRootId(t.normalized_path, allRoots) === options.targetRootId,
          )
        : existingTracks;

      const statusUpdates: Array<{
        id: string;
        status: TrackStatus;
        availability_state: TrackAvailabilityState;
        availability_reason: string | null;
      }> = [];
      const pathsToReimport: string[] = [];
      const newMissingIds: string[] = [];
      const unchangedNormalizedPaths = new Set<string>();
      const artworkRowMap = this.artworkService ? this.artworkService.getAllRowsMap() : null;
      const artworkDirSets = this.artworkService ? this.artworkService.getArtworkDirSets() : undefined;
      const folderCoverCache = new Map<string, string | null>();
      let missingMarkedCount = 0;
      let sourceUnavailableCount = 0;
      let accessErrorCount = 0;

      const VERIFY_CONCURRENCY = 16;
      for (let start = 0; start < scopedTracks.length; start += VERIFY_CONCURRENCY) {
        if (controller.signal.aborted) {
          break;
        }
        const batch = scopedTracks.slice(start, start + VERIFY_CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map(async (track) => {
            const ownerRootId = findMostSpecificWatchedRootId(track.normalized_path, allRoots);
            const ownerRootState = ownerRootId ? rootProbeResults.get(ownerRootId) : undefined;
            const probe = await inspectFile(track.original_path);
            let sourceUnavail = false;
            if ((probe.kind !== 'ok' || !probe.stat) && probe.kind !== 'access_error' && ownerRootState !== 'access_error') {
              sourceUnavail =
                ownerRootState === 'missing' ||
                (await isDriveOrParentSourceUnavailable(track.original_path));
            }
            return { track, ownerRootState, probe, sourceUnavail };
          }),
        );

        for (let offset = 0; offset < batchResults.length; offset += 1) {
          if (controller.signal.aborted) {
            break;
          }
          const idx = start + offset;
          const { track, ownerRootState, probe, sourceUnavail } = batchResults[offset];

          onProgress?.({
            phase: 'verifying',
            current: idx + 1,
            total: scopedTracks.length,
            currentPath: track.original_path,
            message: `Đang kiểm tra file tồn tại (${idx + 1}/${scopedTracks.length})...`,
          });

          if (probe.kind !== 'ok' || !probe.stat) {
            let nextAvail: TrackAvailabilityState = 'missing';
            let nextReason = 'File âm thanh gốc không còn tại đường dẫn đã lưu.';

            if (probe.kind === 'access_error' || ownerRootState === 'access_error') {
              nextAvail = 'access_error';
              nextReason = probe.reason ?? 'Không có quyền truy cập file hoặc thư mục chứa nhạc.';
              accessErrorCount += 1;
            } else if (sourceUnavail) {
              nextAvail = 'source_unavailable';
              nextReason = 'Thư mục nguồn hoặc ổ đĩa chứa nhạc hiện không khả dụng.';
              sourceUnavailableCount += 1;
            }

            const nextStatus = availabilityToTrackStatus(nextAvail);
            if (
              track.status !== nextStatus ||
              (track.availability_state ?? track.status) !== nextAvail
            ) {
              statusUpdates.push({
                id: track.id,
                status: nextStatus,
                availability_state: nextAvail,
                availability_reason: nextReason,
              });
              if (track.status === 'available' && nextStatus !== 'available') {
                missingMarkedCount += 1;
                newMissingIds.push(track.id);
              }
            }
          } else {
            const modifiedMs = Math.round(probe.stat.mtimeMs);
            const needsMetadataRecovery =
              (track.metadata_version ?? 1) < CURRENT_TRACK_METADATA_VERSION;
            const changedOnDisk =
              track.status !== 'available' ||
              (track.availability_state ?? 'available') !== 'available' ||
              track.modified_at_ms !== modifiedMs ||
              track.file_size_bytes !== probe.stat.size ||
              needsMetadataRecovery;

            if (changedOnDisk) {
              pathsToReimport.push(track.original_path);
            } else {
              if (track.file_name) {
                unchangedNormalizedPaths.add(track.normalized_path);
              }
              if (this.artworkService && artworkRowMap) {
                const artRow = artworkRowMap.get(track.id) ?? null;
                const resolvedArt = this.artworkService.resolveArtworkFieldsFromRow(
                  track.id,
                  artRow,
                  artworkDirSets,
                );
                if (resolvedArt.artwork_source === 'default') {
                  const alreadySyncedAtMtime =
                    artRow !== null && artRow.source_mtime_ms === modifiedMs;
                  const parentDir = path.dirname(track.original_path);
                  const folderCoverChecked = folderCoverCache.has(parentDir);
                  // Skip re-parsing unchanged audio files unless folder artwork has not been checked yet
                  if (!alreadySyncedAtMtime || !folderCoverChecked) {
                    await this.artworkService.syncAutoArtworkForTrack(track, {
                      existingRow: artRow,
                      folderCoverCache,
                    });
                  }
                }
              }
            }
          }
        }

        if (start % 32 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }

      if (statusUpdates.length > 0) {
        this.trackRepo.updateStatusesBatch(statusUpdates);
      }

      const discoveredFiles = new Set<string>(pathsToReimport);
      const scannedRootsForDedup = new Set<string>();
      let unchangedDiscoveredCount = 0;

      // Sort shallower roots first so recursive root deduplicates nested child roots cleanly
      const sortedRoots = [...targetRoots].sort(
        (a, b) => a.normalized_path.length - b.normalized_path.length,
      );

      for (const root of sortedRoots) {
        if (controller.signal.aborted) {
          break;
        }
        const probe = rootProbeResults.get(root.id) ?? (await inspectDirectory(root.original_path));
        if (probe !== 'ok') {
          const rootAvail: TrackAvailabilityState =
            probe === 'access_error' ? 'access_error' : 'source_unavailable';
          const reason =
            probe === 'access_error'
              ? 'Không đủ quyền truy cập thư mục nguồn.'
              : 'Thư mục nguồn không còn tồn tại hoặc ổ đĩa chưa được gắn.';
          this.rootRepo.markScanState(root.id, root.original_path, 'missing', {
            availabilityState: rootAvail,
            availabilityReason: reason,
            succeeded: false,
          });
          errors.push({ path: root.original_path, reason });
          continue;
        }

        // Deduplicate overlapping nested root when an already-scanned recursive parent encloses it
        if (!options?.targetRootId && root.recursive !== false) {
          const alreadyCoveredByParent = Array.from(scannedRootsForDedup).some((parentNorm) =>
            isNormalizedPathWithinRoot(root.normalized_path, parentNorm),
          );
          if (alreadyCoveredByParent) {
            this.rootRepo.markScanState(root.id, root.original_path, 'available', {
              availabilityState: 'available',
              availabilityReason: null,
              succeeded: true,
            });
            continue;
          }
        }

        const discovery = await discoverAudioFilesInFolder(root.original_path, {
          recursive: root.recursive !== false,
          signal: controller.signal,
          onProgress,
        });
        errors.push(...discovery.errors);

        if (discovery.canceled) {
          break;
        }

        this.rootRepo.markScanState(root.id, root.original_path, 'available', {
          availabilityState: 'available',
          availabilityReason: null,
          succeeded: true,
        });

        if (root.recursive !== false) {
          scannedRootsForDedup.add(root.normalized_path);
        }

        for (const file of discovery.files) {
          let norm: string | null = null;
          try {
            norm = normalizeTrackPath(cleanOriginalPath(file, this.platform), this.platform);
          } catch {
            norm = null;
          }
          if (norm && unchangedNormalizedPaths.has(norm)) {
            unchangedDiscoveredCount += 1;
            continue;
          }
          discoveredFiles.add(file);
        }
      }

      const filesToProcess = Array.from(discoveredFiles);
      let importResult = createEmptySummary(controller.signal.aborted);

      if (filesToProcess.length > 0 && !controller.signal.aborted) {
        importResult = await this.importFiles(filesToProcess, onProgress, {
          respectExclusions: true,
          signal: controller.signal,
        });
      } else {
        onProgress?.({
          phase: controller.signal.aborted ? 'canceled' : 'completed',
          current: scopedTracks.length,
          total: scopedTracks.length,
          currentPath: null,
          message: controller.signal.aborted
            ? 'Đã hủy quét thư viện.'
            : 'Hoàn tất quét lại thư viện.',
        });
      }

      const allMissingAfterScan = this.trackRepo
        .findAll()
        .filter((t) => t.status !== 'available');

      return {
        canceled: controller.signal.aborted || importResult.canceled,
        scannedCount: Math.max(scopedTracks.length, importResult.scannedCount),
        addedCount: importResult.addedCount,
        updatedCount: importResult.updatedCount,
        skippedCount: importResult.skippedCount + unchangedDiscoveredCount,
        missingMarkedCount,
        recoveredCount: importResult.recoveredCount,
        rootCount: targetRoots.length,
        excludedSkippedCount: importResult.excludedSkippedCount ?? 0,
        duplicateSkippedCount: importResult.duplicateSkippedCount ?? 0,
        sourceUnavailableCount,
        accessErrorCount,
        relinkCandidateCount: allMissingAfterScan.length,
        newMissingIds,
        relinkSuggestedTrackIds: allMissingAfterScan.slice(0, 25).map((t) => t.id),
        errors: [...errors, ...importResult.errors],
      };
    } finally {
      if (this.activeScanAbort === controller) {
        this.activeScanAbort = null;
      }
    }
  }

  async verifyTrackAvailability(trackId: string): Promise<VerifyTrackResult> {
    const track = this.trackRepo.findById(trackId);
    if (!track) {
      return {
        trackId,
        exists: false,
        status: 'missing',
        reason: 'Không tìm thấy bản ghi bài hát trong cơ sở dữ liệu.',
      };
    }

    const probe = await inspectFile(track.original_path);
    if (probe.kind !== 'ok' || !probe.stat) {
      let avail: TrackAvailabilityState = 'missing';
      let reason = `File gốc không còn tồn tại tại: ${track.original_path}`;
      if (probe.kind === 'access_error') {
        avail = 'access_error';
        reason = probe.reason ?? reason;
      } else if (await isDriveOrParentSourceUnavailable(track.original_path)) {
        avail = 'source_unavailable';
        reason = `Ổ đĩa hoặc thư mục nguồn chứa file hiện không khả dụng: ${track.original_path}`;
      }
      const nextStatus = availabilityToTrackStatus(avail);
      if (track.status !== nextStatus || track.availability_state !== avail) {
        this.trackRepo.updateStatus(track.id, nextStatus, avail, reason);
      }
      return {
        trackId: track.id,
        exists: false,
        status: nextStatus,
        reason,
      };
    }

    if (track.status !== 'available' || track.availability_state !== 'available') {
      this.trackRepo.updateStatus(track.id, 'available', 'available', null);
    }

    return {
      trackId: track.id,
      exists: true,
      status: 'available',
    };
  }

  /**
   * Relinks one missing/unavailable track to a user-chosen replacement file path,
   * preserving Track ID, Playlists, Favorites, Custom Metadata/Artwork, and Statistics.
   */
  async relinkSingleTrack(
    trackId: string,
    newFilePath: string,
  ): Promise<RelinkSingleFileResult> {
    const existing = this.trackRepo.findById(trackId);
    if (!existing) {
      return {
        canceled: false,
        success: false,
        track: null,
        error: 'Không tìm thấy bài hát trong cơ sở dữ liệu.',
      };
    }

    const cleanedPath = cleanOriginalPath(newFilePath, this.platform);
    const ext = extractFileExtension(cleanedPath);
    if (!isAudioExtensionSupported(ext)) {
      return {
        canceled: false,
        success: false,
        track: null,
        error: `Định dạng file "${ext || 'không xác định'}" không phải tập tin nhạc hợp lệ.`,
      };
    }

    const probe = await inspectFile(cleanedPath);
    if (probe.kind !== 'ok' || !probe.stat) {
      return {
        canceled: false,
        success: false,
        track: null,
        error: probe.reason ?? 'Không thể đọc hoặc không tìm thấy file đích đã chọn.',
      };
    }

    let normalizedPath: string;
    try {
      normalizedPath = normalizeTrackPath(cleanedPath, this.platform);
    } catch (error) {
      return {
        canceled: false,
        success: false,
        track: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const conflict = this.trackRepo.findByNormalizedPath(normalizedPath);
    if (conflict && conflict.id !== trackId) {
      return {
        canceled: false,
        success: false,
        track: null,
        conflictTrackId: conflict.id,
        conflictTrackTitle: conflict.title,
        error: `File đã chọn đang thuộc về một bài hát khác trong thư viện ("${conflict.title}").`,
      };
    }

    try {
      await readTrackMetadata(cleanedPath);
    } catch (error) {
      return {
        canceled: false,
        success: false,
        track: null,
        error:
          error instanceof MetadataReadError
            ? error.message
            : 'Không thể giải mã metadata từ file nhạc đã chọn.',
      };
    }

    this.trackRepo.relinkTrackPath({
      id: trackId,
      originalPath: cleanedPath,
      normalizedPath,
      fileSizeBytes: probe.stat.size,
      modifiedAtMs: Math.round(probe.stat.mtimeMs),
    });
    this.exclusionRepo?.deleteByNormalizedPaths([normalizedPath]);

    const updated = this.trackRepo.findById(trackId)!;
    if (this.artworkService) {
      await this.artworkService.syncAutoArtworkForTrack(updated).catch(() => {});
    }

    const enriched = this.artworkService
      ? this.artworkService.enrichTrack(this.trackRepo.findById(trackId) ?? updated)
      : updated;

    return {
      canceled: false,
      success: true,
      track: enriched,
    };
  }

  /**
   * Scans a folder to propose high-confidence, ambiguous, conflicting, or unmatched relink candidates
   * for missing/source-unavailable tracks without modifying database records yet.
   */
  async scanRelinkFolder(
    folderPath: string,
    targetTrackIds?: readonly string[],
  ): Promise<RelinkScanResult> {
    const cleanedFolder = cleanOriginalPath(folderPath, this.platform);
    const dirProbe = await inspectDirectory(cleanedFolder);
    if (dirProbe !== 'ok') {
      return {
        canceled: false,
        folderPath: cleanedFolder,
        totalMissingTracks: 0,
        matchedCount: 0,
        ambiguousCount: 0,
        unmatchedCount: 0,
        conflictCount: 0,
        proposals: [],
        error: 'Không thể truy cập thư mục đã chọn để tìm file thay thế.',
      };
    }

    const allTracks = this.trackRepo.findAll();
    const targetSet = targetTrackIds ? new Set(targetTrackIds) : null;
    const missingTracks = allTracks.filter(
      (t) =>
        (t.status !== 'available' || (t.availability_state ?? t.status) !== 'available') &&
        (!targetSet || targetSet.has(t.id)),
    );

    if (missingTracks.length === 0) {
      return {
        canceled: false,
        folderPath: cleanedFolder,
        totalMissingTracks: 0,
        matchedCount: 0,
        ambiguousCount: 0,
        unmatchedCount: 0,
        conflictCount: 0,
        proposals: [],
      };
    }

    const discovery = await discoverAudioFilesInFolder(cleanedFolder, { recursive: true });
    interface ScannedFileInfo {
      filePath: string;
      normalizedPath: string;
      relativePath: string;
      fileName: string;
      stemLower: string;
      sizeBytes: number;
      durationMs: number | null;
      title: string | null;
      artist: string | null;
      album: string | null;
    }

    const candidatesPool: ScannedFileInfo[] = [];
    for (const rawFile of discovery.files) {
      const cleaned = cleanOriginalPath(rawFile, this.platform);
      let norm: string;
      try {
        norm = normalizeTrackPath(cleaned, this.platform);
      } catch {
        continue;
      }
      try {
        const meta = await readTrackMetadata(cleaned);
        const fileName = extractFileNameFromPath(cleaned);
        const stem = path.basename(fileName, path.extname(fileName)).toLowerCase();
        candidatesPool.push({
          filePath: cleaned,
          normalizedPath: norm,
          relativePath: path.relative(cleanedFolder, cleaned) || fileName,
          fileName,
          stemLower: stem,
          sizeBytes: meta.file_size_bytes,
          durationMs: meta.duration_ms,
          title: meta.title,
          artist: meta.artist,
          album: meta.album,
        });
      } catch {
        // Ignore corrupt/unreadable candidate files cleanly
      }
    }

    const ownerByPath = new Map<string, TrackRecord>();
    for (const t of allTracks) {
      ownerByPath.set(t.normalized_path, t);
    }

    const proposals: RelinkTrackProposal[] = [];
    let matchedCount = 0;
    let ambiguousCount = 0;
    let unmatchedCount = 0;
    let conflictCount = 0;

    for (const missing of missingTracks) {
      const origFileName = extractFileNameFromPath(missing.original_path);
      const origStemLower = path
        .basename(origFileName, path.extname(origFileName))
        .toLowerCase();
      const origTitleLower = (missing.original_title ?? missing.title).toLowerCase();
      const origArtistLower = (missing.original_artist ?? missing.artist).toLowerCase();
      const origAlbumLower = (missing.original_album ?? missing.album ?? '').toLowerCase();

      const scored: RelinkFileCandidate[] = [];
      for (const cand of candidatesPool) {
        let score = 0;
        const reasons: string[] = [];

        if (
          missing.file_size_bytes !== null &&
          missing.file_size_bytes > 0 &&
          cand.sizeBytes === missing.file_size_bytes
        ) {
          score += 45;
          reasons.push('Khớp dung lượng file');
        }
        if (cand.stemLower === origStemLower) {
          score += 40;
          reasons.push('Khớp tên file gốc');
        } else if (cand.fileName.toLowerCase() === origFileName.toLowerCase()) {
          score += 35;
          reasons.push('Khớp tên file');
        }
        if (
          missing.duration_ms !== null &&
          cand.durationMs !== null &&
          Math.abs(cand.durationMs - missing.duration_ms) <= 1500
        ) {
          score += 20;
          reasons.push('Khớp thời lượng');
        }
        if (cand.title && cand.title.toLowerCase() === origTitleLower) {
          score += 18;
          reasons.push('Khớp tiêu đề');
        }
        if (cand.artist && cand.artist.toLowerCase() === origArtistLower) {
          score += 10;
          reasons.push('Khớp nghệ sĩ');
        }
        if (origAlbumLower && cand.album && cand.album.toLowerCase() === origAlbumLower) {
          score += 5;
        }

        if (score >= 30) {
          scored.push({
            filePath: cand.filePath,
            normalizedPath: cand.normalizedPath,
            relativePath: cand.relativePath,
            fileName: cand.fileName,
            durationMs: cand.durationMs,
            title: cand.title,
            artist: cand.artist,
            album: cand.album,
            score,
            reasons,
          });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      const top = scored[0] ?? null;
      const second = scored[1] ?? null;

      let matchStatus: RelinkTrackProposal['matchStatus'] = 'unmatched';
      let suggestedPath: string | null = null;
      let conflictTrackId: string | undefined;
      let conflictTrackTitle: string | undefined;
      let conflictReason: string | undefined;

      if (top) {
        const owner = ownerByPath.get(top.normalizedPath);
        if (owner && owner.id !== missing.id) {
          matchStatus = 'conflict';
          conflictTrackId = owner.id;
          conflictTrackTitle = owner.title;
          conflictReason = `File khớp nhất đang thuộc bài hát "${owner.title}" trong thư viện.`;
          conflictCount += 1;
        } else if (top.score >= 70 && (!second || top.score - second.score >= 15)) {
          matchStatus = 'matched';
          suggestedPath = top.filePath;
          matchedCount += 1;
        } else {
          matchStatus = 'ambiguous';
          ambiguousCount += 1;
        }
      } else {
        unmatchedCount += 1;
      }

      proposals.push({
        trackId: missing.id,
        title: missing.title,
        artist: missing.artist,
        album: missing.album,
        previousPath: missing.original_path,
        durationMs: missing.duration_ms,
        matchStatus,
        suggestedPath,
        conflictTrackId,
        conflictTrackTitle,
        conflictReason,
        candidates: scored.slice(0, 6),
      });
    }

    return {
      canceled: false,
      folderPath: cleanedFolder,
      totalMissingTracks: missingTracks.length,
      matchedCount,
      ambiguousCount,
      unmatchedCount,
      conflictCount,
      proposals,
    };
  }

  async applyRelink(selections: readonly RelinkApplySelection[]): Promise<RelinkApplyResult> {
    let relinkedCount = 0;
    let failedCount = 0;
    const errors: Array<{ trackId: string; path: string; reason: string }> = [];

    for (const sel of selections) {
      const res = await this.relinkSingleTrack(sel.trackId, sel.newFilePath);
      if (res.success) {
        relinkedCount += 1;
      } else {
        failedCount += 1;
        errors.push({
          trackId: sel.trackId,
          path: sel.newFilePath,
          reason: res.error ?? 'Không thể liên kết lại bài hát.',
        });
      }
    }

    return {
      relinkedCount,
      failedCount,
      errors,
    };
  }

  private async prepareTrackInput(
    cleanedPath: string,
    normalizedPath: string,
    errors: ImportErrorItem[],
  ): Promise<PreparedTrackPayload | null> {
    const existing = this.trackRepo.findByNormalizedPath(normalizedPath);
    const probe = await inspectFile(cleanedPath);

    if (probe.kind !== 'ok' || !probe.stat) {
      const avail: TrackAvailabilityState =
        probe.kind === 'access_error' ? 'access_error' : 'missing';
      const status = availabilityToTrackStatus(avail);
      if (existing) {
        this.trackRepo.updateStatus(existing.id, status, avail, probe.reason ?? null);
      }
      errors.push({
        path: cleanedPath,
        reason: probe.reason ?? 'File không tồn tại hoặc không thể truy cập.',
      });
      return null;
    }

    const stat = probe.stat;
    const modifiedMs = Math.round(stat.mtimeMs);

    // Fast path: unchanged available file already in SQLite AND extended columns & current metadata schema already populated
    if (
      existing &&
      existing.status === 'available' &&
      existing.modified_at_ms === modifiedMs &&
      existing.file_size_bytes === stat.size &&
      existing.file_name &&
      (existing.metadata_version ?? 1) >= CURRENT_TRACK_METADATA_VERSION
    ) {
      const origTitle = existing.original_title ?? existing.title;
      const origArtist = existing.original_artist ?? existing.artist;
      const origAlbum =
        existing.original_album !== undefined ? existing.original_album : existing.album;

      return {
        input: {
          original_path: cleanedPath,
          normalized_path: normalizedPath,
          title: origTitle,
          artist: origArtist,
          album: origAlbum,
          genre: existing.original_genre ?? existing.genre ?? null,
          year: existing.original_year ?? existing.year ?? null,
          album_artist: existing.original_album_artist ?? existing.album_artist ?? null,
          track_number: existing.original_track_number ?? existing.track_number ?? null,
          track_total: existing.original_track_total ?? existing.track_total ?? null,
          disc_number: existing.original_disc_number ?? existing.disc_number ?? null,
          disc_total: existing.original_disc_total ?? existing.disc_total ?? null,
          composer: existing.original_composer ?? existing.composer ?? null,
          lyricist: existing.original_lyricist ?? existing.lyricist ?? null,
          comment: existing.original_comment ?? existing.comment ?? null,
          channels: existing.channels ?? null,
          encoder: existing.encoder ?? null,
          file_name: existing.file_name,
          duration_ms: existing.duration_ms,
          codec: existing.codec,
          container: existing.container,
          sample_rate_hz: existing.sample_rate_hz,
          bit_depth: existing.bit_depth,
          bitrate_bps: existing.bitrate_bps,
          file_size_bytes: existing.file_size_bytes,
          modified_at_ms: existing.modified_at_ms,
          replaygain_track_gain_db: existing.replaygain_track_gain_db ?? null,
          replaygain_album_gain_db: existing.replaygain_album_gain_db ?? null,
          replaygain_track_peak: existing.replaygain_track_peak ?? null,
          replaygain_album_peak: existing.replaygain_album_peak ?? null,
          status: 'available',
          availability_state: 'available',
          availability_reason: null,
          metadata_version: existing.metadata_version ?? CURRENT_TRACK_METADATA_VERSION,
        },
        shouldSyncArtwork: false,
      };
    }

    try {
      const meta = await readTrackMetadata(cleanedPath);
      return {
        input: {
          original_path: cleanedPath,
          normalized_path: normalizedPath,
          title: meta.title,
          artist: meta.artist,
          album: meta.album,
          genre: meta.genre ?? null,
          year: meta.year ?? null,
          album_artist: meta.album_artist ?? null,
          track_number: meta.track_number ?? null,
          track_total: meta.track_total ?? null,
          disc_number: meta.disc_number ?? null,
          disc_total: meta.disc_total ?? null,
          composer: meta.composer ?? null,
          lyricist: meta.lyricist ?? null,
          comment: meta.comment ?? null,
          channels: meta.channels ?? null,
          encoder: meta.encoder ?? null,
          file_name: meta.file_name ?? extractFileNameFromPath(cleanedPath),
          duration_ms: meta.duration_ms,
          codec: meta.codec,
          container: meta.container,
          sample_rate_hz: meta.sample_rate_hz,
          bit_depth: meta.bit_depth,
          bitrate_bps: meta.bitrate_bps,
          file_size_bytes: meta.file_size_bytes,
          modified_at_ms: meta.modified_at_ms,
          replaygain_track_gain_db: meta.replaygain_track_gain_db ?? null,
          replaygain_album_gain_db: meta.replaygain_album_gain_db ?? null,
          replaygain_track_peak: meta.replaygain_track_peak ?? null,
          replaygain_album_peak: meta.replaygain_album_peak ?? null,
          status: 'available',
          availability_state: 'available',
          availability_reason: null,
          metadata_version: CURRENT_TRACK_METADATA_VERSION,
        },
        embeddedLyrics: meta.embedded_lyrics ?? null,
        shouldSyncArtwork: true,
      };
    } catch (error) {
      const reason =
        error instanceof MetadataReadError
          ? error.message
          : `Lỗi đọc metadata: ${error instanceof Error ? error.message : String(error)}`;

      errors.push({ path: cleanedPath, reason });

      if (existing) {
        const origTitle = existing.original_title ?? existing.title;
        const origArtist = existing.original_artist ?? existing.artist;
        const origAlbum =
          existing.original_album !== undefined ? existing.original_album : existing.album;

        return {
          input: {
            original_path: cleanedPath,
            normalized_path: normalizedPath,
            title: origTitle || extractFallbackTitle(cleanedPath),
            artist: origArtist || 'Unknown Artist',
            album: origAlbum,
            year: existing.original_year ?? existing.year ?? null,
            file_name: extractFileNameFromPath(cleanedPath),
            duration_ms: null,
            codec: null,
            container: null,
            sample_rate_hz: null,
            bit_depth: null,
            bitrate_bps: null,
            file_size_bytes: stat.size,
            modified_at_ms: modifiedMs,
            status: 'error',
            availability_state: 'access_error',
            availability_reason: reason,
          },
          shouldSyncArtwork: false,
        };
      }

      return null;
    }
  }

  /**
   * Selectively revalidates existing available tracks whose `metadata_version < CURRENT_TRACK_METADATA_VERSION`
   * using header-only native parsing in bounded low-concurrency batches (zero FFmpeg spawn, zero DB reset).
   * Strictly preserves Track UUID, playlists, favorites, custom artwork/lyrics, metadata overrides & stats.
   */
  async revalidateLegacyMetadata(options?: {
    batchSize?: number;
    concurrency?: number;
    signal?: AbortSignal;
    onProgress?: (event: ScanProgressEvent) => void;
  }): Promise<LegacyMetadataRevalidationResult> {
    const batchSize = Math.max(1, Math.min(64, Math.floor(options?.batchSize ?? 16)));
    const concurrency = Math.max(1, Math.min(4, Math.floor(options?.concurrency ?? 2)));
    const signal = options?.signal;

    let checkedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    while (!signal?.aborted) {
      const staleTracks = this.trackRepo.findAvailableTracksNeedingMetadataRevalidation(
        CURRENT_TRACK_METADATA_VERSION,
        batchSize,
      );
      if (staleTracks.length === 0) {
        break;
      }

      const batchInputs: UpsertTrackInput[] = [];
      for (let start = 0; start < staleTracks.length; start += concurrency) {
        if (signal?.aborted) {
          break;
        }
        const chunk = staleTracks.slice(start, start + concurrency);
        const results = await Promise.all(
          chunk.map(async (track): Promise<UpsertTrackInput | null> => {
            checkedCount += 1;
            options?.onProgress?.({
              phase: 'verifying',
              current: checkedCount,
              total: checkedCount + Math.max(0, staleTracks.length - chunk.length),
              currentPath: track.original_path,
              message: `Đang chuẩn hóa thông số kỹ thuật metadata (${checkedCount})...`,
            });

            const probe = await inspectFile(track.original_path);
            if (probe.kind !== 'ok' || !probe.stat) {
              errorCount += 1;
              return null;
            }

            try {
              const meta = await readTrackMetadata(track.original_path);
              return {
                original_path: track.original_path,
                normalized_path: track.normalized_path,
                title: track.original_title ?? track.title ?? meta.title,
                artist: track.original_artist ?? track.artist ?? meta.artist,
                album:
                  track.original_album !== undefined ? track.original_album : meta.album,
                genre:
                  track.original_genre !== undefined
                    ? track.original_genre
                    : (meta.genre ?? null),
                year:
                  track.original_year !== undefined ? track.original_year : (meta.year ?? null),
                album_artist:
                  track.original_album_artist !== undefined
                    ? track.original_album_artist
                    : (meta.album_artist ?? null),
                track_number:
                  track.original_track_number !== undefined
                    ? track.original_track_number
                    : (meta.track_number ?? null),
                track_total:
                  track.original_track_total !== undefined
                    ? track.original_track_total
                    : (meta.track_total ?? null),
                disc_number:
                  track.original_disc_number !== undefined
                    ? track.original_disc_number
                    : (meta.disc_number ?? null),
                disc_total:
                  track.original_disc_total !== undefined
                    ? track.original_disc_total
                    : (meta.disc_total ?? null),
                composer:
                  track.original_composer !== undefined
                    ? track.original_composer
                    : (meta.composer ?? null),
                lyricist:
                  track.original_lyricist !== undefined
                    ? track.original_lyricist
                    : (meta.lyricist ?? null),
                comment:
                  track.original_comment !== undefined
                    ? track.original_comment
                    : (meta.comment ?? null),
                channels: meta.channels ?? track.channels ?? null,
                encoder: track.encoder ?? meta.encoder ?? null,
                file_name: track.file_name ?? meta.file_name ?? extractFileNameFromPath(track.original_path),
                duration_ms: meta.duration_ms ?? track.duration_ms,
                codec: meta.codec,
                container: meta.container,
                sample_rate_hz: meta.sample_rate_hz,
                bit_depth: meta.bit_depth,
                bitrate_bps: meta.bitrate_bps ?? track.bitrate_bps,
                file_size_bytes: meta.file_size_bytes,
                modified_at_ms: meta.modified_at_ms,
                replaygain_track_gain_db:
                  meta.replaygain_track_gain_db ?? track.replaygain_track_gain_db ?? null,
                replaygain_album_gain_db:
                  meta.replaygain_album_gain_db ?? track.replaygain_album_gain_db ?? null,
                replaygain_track_peak:
                  meta.replaygain_track_peak ?? track.replaygain_track_peak ?? null,
                replaygain_album_peak:
                  meta.replaygain_album_peak ?? track.replaygain_album_peak ?? null,
                status: 'available',
                availability_state: 'available',
                availability_reason: null,
                metadata_version: CURRENT_TRACK_METADATA_VERSION,
              };
            } catch {
              errorCount += 1;
              return null;
            }
          }),
        );

        for (const item of results) {
          if (item) {
            batchInputs.push(item);
          }
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      if (batchInputs.length > 0) {
        const res = this.trackRepo.upsertBatch(batchInputs);
        updatedCount += res.updatedCount + res.recoveredCount;
        skippedCount += res.skippedCount;
      }

      // Guard against infinite loop if every row in the fetched slice errored on disk
      if (batchInputs.length === 0) {
        break;
      }
    }

    return {
      checkedCount,
      updatedCount,
      skippedCount,
      errorCount,
      canceled: Boolean(signal?.aborted),
    };
  }
}

function createEmptySummary(canceled: boolean): ImportSummary {
  return {
    canceled,
    scannedCount: 0,
    addedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    missingMarkedCount: 0,
    recoveredCount: 0,
    excludedSkippedCount: 0,
    duplicateSkippedCount: 0,
    errors: [],
  };
}

async function inspectFile(filePath: string): Promise<StatResult> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return {
        stat: null,
        kind: 'not_file',
        reason: 'Đường dẫn không phải là một tập tin.',
      };
    }
    return { stat, kind: 'ok' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
      return {
        stat: null,
        kind: 'access_error',
        reason: 'Không có quyền truy cập file hoặc file đang bị khóa.',
      };
    }
    return {
      stat: null,
      kind: 'missing',
      reason: 'File không tồn tại trên ổ đĩa.',
    };
  }
}

async function inspectDirectory(dirPath: string): Promise<'ok' | 'missing' | 'access_error'> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory() ? 'ok' : 'missing';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
      return 'access_error';
    }
    return 'missing';
  }
}

async function isDriveOrParentSourceUnavailable(filePath: string): Promise<boolean> {
  const driveMatch = filePath.match(/^([A-Za-z]:\\)/);
  if (driveMatch) {
    const driveProbe = await inspectDirectory(driveMatch[1]);
    return driveProbe !== 'ok';
  }
  const normalizedKey = normalizeFolderKey(path.dirname(filePath));
  if (!normalizedKey) {
    return false;
  }
  const parentProbe = await inspectDirectory(path.dirname(filePath));
  return parentProbe === 'missing';
}
