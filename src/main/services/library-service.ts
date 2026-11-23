import fs from 'node:fs/promises';
import { isAudioExtensionSupported } from '../../shared/contracts/media-protocol';
import type {
  ImportErrorItem,
  ImportSummary,
  LibrarySnapshot,
  ScanProgressEvent,
  VerifyTrackResult,
} from '../../shared/types/library';
import type {
  TrackMetadataOverrideInput,
  TrackRecord,
  TrackStatus,
} from '../../shared/types/track';
import type { LibraryRootRepository } from '../database/library-root-repository';
import type { LyricsRepository } from '../database/lyrics-repository';
import type { MetadataOverrideRepository } from '../database/metadata-override-repository';
import type { TrackRepository, UpsertTrackInput } from '../database/track-repository';
import type { ArtworkService } from './artwork-service';
import { MetadataReadError, readTrackMetadata } from './metadata-service';
import {
  cleanOriginalPath,
  extractFallbackTitle,
  extractFileExtension,
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
}

interface PreparedTrackPayload {
  input: UpsertTrackInput;
  embeddedLyrics?: string | null;
  shouldSyncArtwork: boolean;
}

export class LibraryService {
  private readonly trackRepo: TrackRepository;
  private readonly rootRepo: LibraryRootRepository;
  private readonly databasePath: string;
  private readonly platform: NodeJS.Platform;
  private readonly artworkService?: ArtworkService;
  private readonly lyricsRepo?: LyricsRepository;
  private readonly metadataOverrideRepo?: MetadataOverrideRepository;

  constructor(options: LibraryServiceOptions) {
    this.trackRepo = options.trackRepo;
    this.rootRepo = options.rootRepo;
    this.databasePath = options.databasePath;
    this.platform = options.platform ?? process.platform;
    this.artworkService = options.artworkService;
    this.lyricsRepo = options.lyricsRepo;
    this.metadataOverrideRepo = options.metadataOverrideRepo;
  }

  /**
   * Returns saved library state directly from SQLite without scanning the disk.
   */
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

  /**
   * Removes a watched root folder from library_roots WITHOUT deleting already-imported tracks,
   * playlists, favorites, history, or overrides.
   */
  removeLibraryRoot(rootId: string): boolean {
    return this.rootRepo.deleteRoot(rootId);
  }

  /**
   * Marks tracks whose original_path matches any deleted/moved file as "missing" without deleting records.
   */
  markPathsMissing(filePaths: readonly string[]): number {
    const updates: Array<{ id: string; status: TrackStatus }> = [];
    for (const rawPath of filePaths) {
      let normalized: string;
      try {
        normalized = normalizeTrackPath(cleanOriginalPath(rawPath, this.platform), this.platform);
      } catch {
        continue;
      }
      const existing = this.trackRepo.findByNormalizedPath(normalized);
      if (existing && existing.status !== 'missing') {
        updates.push({ id: existing.id, status: 'missing' });
      }
    }
    if (updates.length === 0) {
      return 0;
    }
    return this.trackRepo.updateStatusesBatch(updates);
  }

  /**
   * Saves in-app metadata overrides (Title, Artist, Album) strictly inside SQLite.
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

    const origTitle = existing.original_title ?? existing.title;
    const origArtist = existing.original_artist ?? existing.artist;
    const origAlbum =
      existing.original_album !== undefined ? existing.original_album : existing.album;

    const cleanOrNull = (val: string | null | undefined): string | null => {
      if (typeof val !== 'string') return null;
      const trimmed = val.normalize('NFC').trim();
      return trimmed.length > 0 ? trimmed : null;
    };

    const nextTitle = cleanOrNull(input.titleOverride);
    const nextArtist = cleanOrNull(input.artistOverride);
    const nextAlbum = cleanOrNull(input.albumOverride);

    this.metadataOverrideRepo.upsertOverride(trackId, {
      titleOverride: nextTitle && nextTitle !== origTitle ? nextTitle : null,
      artistOverride: nextArtist && nextArtist !== origArtist ? nextArtist : null,
      albumOverride: nextAlbum && nextAlbum !== (origAlbum ?? '') ? nextAlbum : null,
    });

    const refreshed = this.trackRepo.findById(trackId) ?? existing;
    return this.artworkService ? this.artworkService.enrichTrack(refreshed) : refreshed;
  }

  /**
   * Clears all in-app metadata overrides for a track and restores original file metadata.
   */
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
   * Imports a list of individual audio files selected by the user.
   * Source files are read in-place and are never copied, moved, edited, or deleted.
   */
  async importFiles(
    filePaths: readonly string[],
    onProgress?: (event: ScanProgressEvent) => void,
  ): Promise<ImportSummary> {
    if (filePaths.length === 0) {
      return createEmptySummary(true);
    }

    const errors: ImportErrorItem[] = [];
    const payloads: PreparedTrackPayload[] = [];
    const seenNormalized = new Set<string>();
    const total = filePaths.length;

    for (let index = 0; index < total; index += 1) {
      const rawPath = filePaths[index];
      const cleanedPath = cleanOriginalPath(rawPath, this.platform);
      const ext = extractFileExtension(cleanedPath);

      onProgress?.({
        phase: 'importing',
        current: index + 1,
        total,
        currentPath: cleanedPath,
        message: `Đang đọc metadata (${index + 1}/${total})...`,
      });

      if (!isAudioExtensionSupported(ext)) {
        errors.push({
          path: cleanedPath,
          reason: `Định dạng "${ext || 'không xác định'}" chưa được hỗ trợ trong DoReMi.`,
        });
        continue;
      }

      let normalizedPath: string;
      try {
        normalizedPath = normalizeTrackPath(cleanedPath, this.platform);
      } catch (error) {
        errors.push({
          path: cleanedPath,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (seenNormalized.has(normalizedPath)) {
        continue;
      }
      seenNormalized.add(normalizedPath);

      const prepared = await this.prepareTrackInput(cleanedPath, normalizedPath, errors);
      if (prepared) {
        payloads.push(prepared);
      }

      // Yield occasionally for responsiveness during large imports
      if (index % 10 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    const batchSummary = this.trackRepo.upsertBatch(payloads.map((item) => item.input));

    // Sync embedded lyrics & auto artwork (embedded/folder) for newly added or changed tracks
    if (this.artworkService || this.lyricsRepo) {
      for (let i = 0; i < payloads.length; i += 1) {
        const item = payloads[i];
        const persisted = this.trackRepo.findByNormalizedPath(item.input.normalized_path);
        if (!persisted) {
          continue;
        }

        if (this.lyricsRepo && item.embeddedLyrics !== undefined) {
          this.lyricsRepo.setEmbeddedLyrics(persisted.id, item.embeddedLyrics);
        }

        if (this.artworkService && item.shouldSyncArtwork && persisted.status === 'available') {
          await this.artworkService.syncAutoArtworkForTrack(persisted);
        }

        if (i % 10 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    }

    onProgress?.({
      phase: 'completed',
      current: total,
      total,
      currentPath: null,
      message: `Hoàn tất import: thêm ${batchSummary.addedCount}, cập nhật ${batchSummary.updatedCount}, lỗi ${errors.length}.`,
    });

    return {
      canceled: false,
      scannedCount: total,
      addedCount: batchSummary.addedCount,
      updatedCount: batchSummary.updatedCount,
      skippedCount: batchSummary.skippedCount,
      missingMarkedCount: 0,
      recoveredCount: batchSummary.recoveredCount,
      errors,
    };
  }

  /**
   * Registers a source root folder, recursively scans all subdirectories asynchronously,
   * reads metadata, and saves/updates tracks in SQLite.
   */
  async importFolder(
    folderPath: string,
    onProgress?: (event: ScanProgressEvent) => void,
  ): Promise<ImportSummary> {
    const cleanedFolder = cleanOriginalPath(folderPath, this.platform);
    const normalizedFolder = normalizeTrackPath(cleanedFolder, this.platform);

    let folderStat;
    try {
      folderStat = await fs.stat(cleanedFolder);
    } catch (error) {
      return {
        ...createEmptySummary(false),
        errors: [
          {
            path: cleanedFolder,
            reason: `Không thể mở thư mục: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }

    if (!folderStat.isDirectory()) {
      return {
        ...createEmptySummary(false),
        errors: [
          {
            path: cleanedFolder,
            reason: 'Đường dẫn đã chọn không phải là một thư mục.',
          },
        ],
      };
    }

    this.rootRepo.upsertRoot(cleanedFolder, normalizedFolder);

    const discovery = await discoverAudioFilesInFolder(cleanedFolder, { onProgress });
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

    const fileSummary = await this.importFiles(discovery.files, onProgress);
    return {
      ...fileSummary,
      errors: [...discovery.errors, ...fileSummary.errors],
    };
  }

  /**
   * Re-verifies existing tracks on disk (marking deleted/moved files as "missing" without deleting
   * their database records) and rescans all registered library_roots for new or recovered files.
   */
  async rescanLibrary(
    onProgress?: (event: ScanProgressEvent) => void,
  ): Promise<ImportSummary> {
    const errors: ImportErrorItem[] = [];
    const existingTracks = this.trackRepo.findAll();
    const statusUpdates: Array<{ id: string; status: TrackStatus }> = [];
    const pathsToReimport: string[] = [];
    let missingMarkedCount = 0;

    for (let i = 0; i < existingTracks.length; i += 1) {
      const track = existingTracks[i];
      onProgress?.({
        phase: 'verifying',
        current: i + 1,
        total: existingTracks.length,
        currentPath: track.original_path,
        message: `Đang kiểm tra file tồn tại (${i + 1}/${existingTracks.length})...`,
      });

      const fileStat = await safeStatFile(track.original_path);
      if (!fileStat) {
        if (track.status !== 'missing') {
          statusUpdates.push({ id: track.id, status: 'missing' });
          missingMarkedCount += 1;
        }
      } else {
        const modifiedMs = Math.round(fileStat.mtimeMs);
        const changedOnDisk =
          track.status === 'missing' ||
          track.status === 'error' ||
          track.modified_at_ms !== modifiedMs ||
          track.file_size_bytes !== fileStat.size;

        if (changedOnDisk) {
          pathsToReimport.push(track.original_path);
        } else if (this.artworkService) {
          // Ensure artwork cache stays up to date for existing tracks (e.g. cover.jpg added later)
          const enriched = this.artworkService.enrichTrack(track);
          if (enriched.artwork_source === 'default') {
            await this.artworkService.syncAutoArtworkForTrack(track);
          }
        }
      }

      if (i % 20 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    if (statusUpdates.length > 0) {
      this.trackRepo.updateStatusesBatch(statusUpdates);
    }

    const roots = this.rootRepo.findAll();
    const discoveredFiles = new Set<string>(pathsToReimport);

    for (const root of roots) {
      const rootStat = await safeStatDirectory(root.original_path);
      if (!rootStat) {
        this.rootRepo.markScanState(root.id, root.original_path, 'missing');
        errors.push({
          path: root.original_path,
          reason: 'Thư mục nguồn không còn tồn tại hoặc ổ đĩa chưa được gắn.',
        });
        continue;
      }

      this.rootRepo.markScanState(root.id, root.original_path, 'available');
      const discovery = await discoverAudioFilesInFolder(root.original_path, { onProgress });
      errors.push(...discovery.errors);
      for (const file of discovery.files) {
        discoveredFiles.add(file);
      }
    }

    const filesToProcess = Array.from(discoveredFiles);
    let importResult = createEmptySummary(false);

    if (filesToProcess.length > 0) {
      importResult = await this.importFiles(filesToProcess, onProgress);
    } else {
      onProgress?.({
        phase: 'completed',
        current: existingTracks.length,
        total: existingTracks.length,
        currentPath: null,
        message: `Hoàn tất quét lại thư viện.`,
      });
    }

    return {
      canceled: false,
      scannedCount: Math.max(existingTracks.length, importResult.scannedCount),
      addedCount: importResult.addedCount,
      updatedCount: importResult.updatedCount,
      skippedCount: importResult.skippedCount,
      missingMarkedCount,
      recoveredCount: importResult.recoveredCount,
      errors: [...errors, ...importResult.errors],
    };
  }

  /**
   * Checks a single track's source file on disk before playback and updates its status in SQLite if needed.
   */
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

    const stat = await safeStatFile(track.original_path);
    if (!stat) {
      if (track.status !== 'missing') {
        this.trackRepo.updateStatus(track.id, 'missing');
      }
      return {
        trackId: track.id,
        exists: false,
        status: 'missing',
        reason: `File gốc không còn tồn tại tại: ${track.original_path}`,
      };
    }

    if (track.status === 'missing') {
      this.trackRepo.updateStatus(track.id, 'available');
    }

    return {
      trackId: track.id,
      exists: true,
      status: 'available',
    };
  }

  private async prepareTrackInput(
    cleanedPath: string,
    normalizedPath: string,
    errors: ImportErrorItem[],
  ): Promise<PreparedTrackPayload | null> {
    const existing = this.trackRepo.findByNormalizedPath(normalizedPath);
    const stat = await safeStatFile(cleanedPath);

    if (!stat) {
      if (existing && existing.status !== 'missing') {
        this.trackRepo.updateStatus(existing.id, 'missing');
      }
      errors.push({
        path: cleanedPath,
        reason: 'File không tồn tại hoặc không thể truy cập.',
      });
      return null;
    }

    const modifiedMs = Math.round(stat.mtimeMs);

    // Fast path: unchanged available file already in SQLite — avoid redundant metadata reads
    if (
      existing &&
      existing.status === 'available' &&
      existing.modified_at_ms === modifiedMs &&
      existing.file_size_bytes === stat.size
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
          year: existing.year ?? null,
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
          year: meta.year ?? null,
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
            year: existing.year ?? null,
            duration_ms: null,
            codec: null,
            container: null,
            sample_rate_hz: null,
            bit_depth: null,
            bitrate_bps: null,
            file_size_bytes: stat.size,
            modified_at_ms: modifiedMs,
            status: 'error',
          },
          shouldSyncArtwork: false,
        };
      }

      return null;
    }
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
    errors: [],
  };
}

async function safeStatFile(filePath: string) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

async function safeStatDirectory(dirPath: string) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory() ? stat : null;
  } catch {
    return null;
  }
}
