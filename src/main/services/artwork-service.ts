import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildTrackArtworkUrl,
  parseArtworkRequestFromMediaUrl,
} from '../../shared/contracts/media-protocol';
import type { TrackArtworkSource, TrackRecord } from '../../shared/types/track';
import type { ArtworkRepository, TrackArtworkRow } from '../database/artwork-repository';
import type { TrackRepository } from '../database/track-repository';
import { buildMediaCorsHeaders, isAllowedMediaCorsOrigin } from './audio-stream-handler';
import { readEmbeddedArtwork } from './metadata-service';

const MAX_CUSTOM_ARTWORK_BYTES = 15 * 1024 * 1024; // 15 MB
const THUMB_MAX_DIMENSION = 256;

const FOLDER_ARTWORK_CANDIDATES = [
  'cover.jpg',
  'cover.jpeg',
  'cover.png',
  'cover.webp',
  'folder.jpg',
  'folder.jpeg',
  'folder.png',
  'folder.webp',
] as const;

export interface ValidatedImageInfo {
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  ext: '.jpg' | '.png' | '.webp';
}

export interface ResolvedArtworkFields {
  artwork_url: string | null;
  artwork_thumb_url: string | null;
  artwork_source: TrackArtworkSource;
  has_custom_artwork: boolean;
}

export interface ArtworkServiceOptions {
  trackRepo: TrackRepository;
  artworkRepo: ArtworkRepository;
  userDataDir: string;
}

/**
 * Validates raw image bytes using magic numbers (JPEG, PNG, WEBP) + max size.
 * Rejects invalid, empty, or non-image files even if renamed with an image extension.
 */
export function validateImageBuffer(buffer: Buffer): ValidatedImageInfo | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > MAX_CUSTOM_ARTWORK_BYTES) {
    return null;
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: '.png' };
  }

  // WEBP: RIFF .... WEBP
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: '.webp' };
  }

  return null;
}

/**
 * Scans the track's immediate directory (case-insensitively) for cover.jpg / folder.jpg artwork.
 */
export async function findFolderArtworkFile(audioFilePath: string): Promise<string | null> {
  const dir = path.dirname(audioFilePath);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  const lowerToActual = new Map<string, string>();
  for (const name of entries) {
    const lower = name.toLowerCase();
    if (!lowerToActual.has(lower)) {
      lowerToActual.set(lower, name);
    }
  }

  for (const candidate of FOLDER_ARTWORK_CANDIDATES) {
    const matched = lowerToActual.get(candidate);
    if (!matched) {
      continue;
    }
    const fullPath = path.join(dir, matched);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isFile() && stat.size > 0 && stat.size <= MAX_CUSTOM_ARTWORK_BYTES) {
        return fullPath;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function createThumbnailBufferIfPossible(
  sourceBuffer: Buffer,
  fallbackMime: string,
): { buffer: Buffer; mime: string; ext: string } | null {
  // Only attempt nativeImage resizing inside Electron runtime (never fails in Node test runner)
  if (!process.versions.electron) {
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronModule = require('electron') as {
      nativeImage?: {
        createFromBuffer(buf: Buffer): {
          isEmpty(): boolean;
          getSize(): { width: number; height: number };
          resize(opts: { width: number; quality?: 'good' | 'better' | 'best' }): {
            toJPEG(quality: number): Buffer;
            toPNG(): Buffer;
          };
        };
      };
    };

    const nativeImage = electronModule?.nativeImage;
    if (!nativeImage) {
      return null;
    }

    const img = nativeImage.createFromBuffer(sourceBuffer);
    if (img.isEmpty()) {
      return null;
    }

    const size = img.getSize();
    if (size.width <= THUMB_MAX_DIMENSION && size.height <= THUMB_MAX_DIMENSION) {
      return null;
    }

    const resized = img.resize({ width: THUMB_MAX_DIMENSION, quality: 'good' });
    if (fallbackMime === 'image/png') {
      return { buffer: resized.toPNG(), mime: 'image/png', ext: '.png' };
    }
    return { buffer: resized.toJPEG(84), mime: 'image/jpeg', ext: '.jpg' };
  } catch {
    return null;
  }
}

export class ArtworkService {
  private readonly trackRepo: TrackRepository;
  private readonly artworkRepo: ArtworkRepository;
  private readonly cacheDir: string;
  private readonly customDir: string;
  private readonly thumbDir: string;

  constructor(options: ArtworkServiceOptions) {
    this.trackRepo = options.trackRepo;
    this.artworkRepo = options.artworkRepo;
    this.cacheDir = path.join(options.userDataDir, 'artwork-cache');
    this.customDir = path.join(options.userDataDir, 'artwork-custom');
    this.thumbDir = path.join(options.userDataDir, 'artwork-thumbs');
  }

  private ensureDirectoriesSync(): void {
    fsSync.mkdirSync(this.cacheDir, { recursive: true });
    fsSync.mkdirSync(this.customDir, { recursive: true });
    fsSync.mkdirSync(this.thumbDir, { recursive: true });
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.cacheDir, { recursive: true }),
      fs.mkdir(this.customDir, { recursive: true }),
      fs.mkdir(this.thumbDir, { recursive: true }),
    ]);
  }

  private readDirFileSetSync(dirPath: string): Set<string> | null {
    try {
      return new Set(fsSync.readdirSync(dirPath));
    } catch {
      return null;
    }
  }

  getArtworkDirSets(): { customFiles: Set<string> | null; cacheFiles: Set<string> | null } {
    return {
      customFiles: this.readDirFileSetSync(this.customDir),
      cacheFiles: this.readDirFileSetSync(this.cacheDir),
    };
  }

  getAllRowsMap(): Map<string, TrackArtworkRow> {
    return this.artworkRepo.findAllMap();
  }

  /**
   * Resolves artwork URLs and source strictly following M3.1 priority:
   * 1. Custom cover (userData/artwork-custom)
   * 2. Embedded metadata artwork (userData/artwork-cache)
   * 3. Folder cover.jpg / folder.jpg (userData/artwork-cache)
   * 4. Default offline DoReMi artwork (null URL -> renderer uses SVG fallback)
   */
  resolveArtworkFieldsFromRow(
    trackId: string,
    row: TrackArtworkRow | null | undefined,
    dirSets?: { customFiles: Set<string> | null; cacheFiles: Set<string> | null },
  ): ResolvedArtworkFields {
    if (row?.custom_file && row.custom_hash) {
      const customExists = dirSets
        ? Boolean(dirSets.customFiles?.has(row.custom_file))
        : fsSync.existsSync(path.join(this.customDir, row.custom_file));
      if (customExists) {
        return {
          artwork_url: buildTrackArtworkUrl(trackId, 'full', row.custom_hash),
          artwork_thumb_url: buildTrackArtworkUrl(trackId, 'thumb', row.custom_hash),
          artwork_source: 'custom',
          has_custom_artwork: true,
        };
      }
    }

    if (row?.embedded_cache_file && row.embedded_hash) {
      const embeddedExists = dirSets
        ? Boolean(dirSets.cacheFiles?.has(row.embedded_cache_file))
        : fsSync.existsSync(path.join(this.cacheDir, row.embedded_cache_file));
      if (embeddedExists) {
        return {
          artwork_url: buildTrackArtworkUrl(trackId, 'full', row.embedded_hash),
          artwork_thumb_url: buildTrackArtworkUrl(trackId, 'thumb', row.embedded_hash),
          artwork_source: 'embedded',
          has_custom_artwork: false,
        };
      }
    }

    if (row?.folder_cache_file && row.folder_hash) {
      const folderExists = dirSets
        ? Boolean(dirSets.cacheFiles?.has(row.folder_cache_file))
        : fsSync.existsSync(path.join(this.cacheDir, row.folder_cache_file));
      if (folderExists) {
        return {
          artwork_url: buildTrackArtworkUrl(trackId, 'full', row.folder_hash),
          artwork_thumb_url: buildTrackArtworkUrl(trackId, 'thumb', row.folder_hash),
          artwork_source: 'folder',
          has_custom_artwork: false,
        };
      }
    }

    return {
      artwork_url: null,
      artwork_thumb_url: null,
      artwork_source: 'default',
      has_custom_artwork: false,
    };
  }

  enrichTrack(track: TrackRecord): TrackRecord {
    const row = this.artworkRepo.findByTrackId(track.id);
    const resolved = this.resolveArtworkFieldsFromRow(track.id, row);
    return {
      ...track,
      ...resolved,
    };
  }

  enrichTracks(tracks: readonly TrackRecord[]): TrackRecord[] {
    if (tracks.length === 0) {
      return [];
    }
    const rowMap = this.artworkRepo.findAllMap();
    const dirSets = this.getArtworkDirSets();
    return tracks.map((track) => {
      const resolved = this.resolveArtworkFieldsFromRow(track.id, rowMap.get(track.id), dirSets);
      return {
        ...track,
        ...resolved,
      };
    });
  }

  /**
   * Synchronizes embedded + folder artwork cache for a track in read-only mode.
   * Never modifies the source audio file or overwrites any existing custom cover.
   */
  async syncAutoArtworkForTrack(
    track: TrackRecord,
    options?: {
      existingRow?: TrackArtworkRow | null;
      folderCoverCache?: Map<string, string | null>;
    },
  ): Promise<ResolvedArtworkFields> {
    await this.ensureDirectories();
    const existingRow =
      options?.existingRow !== undefined
        ? options.existingRow
        : this.artworkRepo.findByTrackId(track.id);

    const modifiedMatches =
      existingRow !== null &&
      existingRow.source_mtime_ms !== null &&
      track.modified_at_ms !== null &&
      existingRow.source_mtime_ms === track.modified_at_ms;

    let embeddedCacheFile: string | null = modifiedMatches ? existingRow.embedded_cache_file : null;
    let embeddedMime: string | null = modifiedMatches ? existingRow.embedded_mime : null;
    let embeddedHash: string | null = modifiedMatches ? existingRow.embedded_hash : null;

    let folderSourcePath: string | null = null;
    let folderCacheFile: string | null = null;
    let folderMime: string | null = null;
    let folderHash: string | null = null;

    // 1. Embedded artwork (read-only) — skip re-parsing audio tag if mtime unchanged since last auto-sync
    if (!modifiedMatches) {
      const embedded = await readEmbeddedArtwork(track.original_path);
      if (embedded) {
        const validated = validateImageBuffer(embedded.data);
        if (validated) {
          embeddedHash = sha256Hex(embedded.data);
          embeddedMime = validated.mime;
          embeddedCacheFile = `${embeddedHash}${validated.ext}`;
          await this.writeContentAddressedCache(embeddedCacheFile, embedded.data, validated.mime);
        }
      }
    }

    // 2. Folder artwork (cover.jpg / folder.jpg ...) with per-scan directory cache
    const parentDir = path.dirname(track.original_path);
    let folderImgPath: string | null;
    if (options?.folderCoverCache?.has(parentDir)) {
      folderImgPath = options.folderCoverCache.get(parentDir) ?? null;
    } else {
      folderImgPath = await findFolderArtworkFile(track.original_path);
      options?.folderCoverCache?.set(parentDir, folderImgPath);
    }

    if (folderImgPath) {
      try {
        const folderBytes = await fs.readFile(folderImgPath);
        const validated = validateImageBuffer(folderBytes);
        if (validated) {
          folderSourcePath = folderImgPath;
          folderHash = sha256Hex(folderBytes);
          folderMime = validated.mime;
          folderCacheFile = `${folderHash}${validated.ext}`;
          await this.writeContentAddressedCache(folderCacheFile, folderBytes, validated.mime);
        }
      } catch {
        // Ignore unreadable folder artwork
      }
    }

    // Keep cached embedded artwork if track is currently missing on disk
    if (track.status === 'missing' && existingRow) {
      return this.resolveArtworkFieldsFromRow(track.id, existingRow);
    }

    this.artworkRepo.upsertAutoArtwork({
      track_id: track.id,
      embedded_cache_file: embeddedCacheFile,
      embedded_mime: embeddedMime,
      embedded_hash: embeddedHash,
      folder_source_path: folderSourcePath,
      folder_cache_file: folderCacheFile,
      folder_mime: folderMime,
      folder_hash: folderHash,
      source_mtime_ms: track.modified_at_ms,
    });

    const updatedRow = this.artworkRepo.findByTrackId(track.id);
    return this.resolveArtworkFieldsFromRow(track.id, updatedRow);
  }

  /**
   * Imports or replaces a custom cover image for a track.
   * Copies image bytes into userData/artwork-custom linked to Stable Track ID.
   * Never writes or modifies the original audio file.
   */
  async importCustomArtworkFromPath(
    trackId: string,
    sourceImagePath: string,
  ): Promise<TrackRecord> {
    const track = this.trackRepo.findById(trackId);
    if (!track) {
      throw new Error('Không tìm thấy bài hát trong cơ sở dữ liệu.');
    }

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(sourceImagePath);
    } catch (error) {
      throw new Error(
        `Không thể đọc file ảnh đã chọn: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const validated = validateImageBuffer(bytes);
    if (!validated) {
      throw new Error(
        'File ảnh không hợp lệ hoặc vượt quá 15MB. Chỉ hỗ trợ ảnh JPG, PNG hoặc WEBP hợp lệ.',
      );
    }

    await this.ensureDirectories();
    const existingRow = this.artworkRepo.findByTrackId(trackId);
    const hash = sha256Hex(bytes);
    const customFilename = `${trackId}-${hash.slice(0, 12)}${validated.ext}`;
    const targetPath = path.join(this.customDir, customFilename);

    await fs.writeFile(targetPath, bytes);
    await this.ensureThumbFile(hash, bytes, validated.mime);

    this.artworkRepo.setCustomArtwork({
      track_id: trackId,
      custom_file: customFilename,
      custom_mime: validated.mime,
      custom_hash: hash,
    });

    // Clean up old custom image file if replaced by a different file
    if (existingRow?.custom_file && existingRow.custom_file !== customFilename) {
      const oldPath = path.join(this.customDir, existingRow.custom_file);
      await fs.unlink(oldPath).catch(() => {});
    }

    const refreshedTrack = this.trackRepo.findById(trackId) ?? track;
    return this.enrichTrack(refreshedTrack);
  }

  /**
   * Removes custom cover and automatically restores original priority (Embedded -> Folder -> Default).
   */
  async removeCustomArtwork(trackId: string): Promise<TrackRecord> {
    const track = this.trackRepo.findById(trackId);
    if (!track) {
      throw new Error('Không tìm thấy bài hát trong cơ sở dữ liệu.');
    }

    const existingRow = this.artworkRepo.findByTrackId(trackId);
    this.artworkRepo.clearCustomArtwork(trackId);

    if (existingRow?.custom_file) {
      const oldPath = path.join(this.customDir, existingRow.custom_file);
      await fs.unlink(oldPath).catch(() => {});
    }

    // If auto artwork wasn't cached yet (for legacy tracks), sync lazily now
    if (!existingRow?.embedded_cache_file && !existingRow?.folder_cache_file) {
      await this.syncAutoArtworkForTrack(track);
    }

    const refreshedTrack = this.trackRepo.findById(trackId) ?? track;
    return this.enrichTrack(refreshedTrack);
  }

  /**
   * Handles lossless-media://artwork/<uuid>?size=full|thumb&v=<hash> securely.
   */
  async resolveArtworkHttpResponse(request: Request): Promise<Response> {
    const originHeader = request.headers.get('origin');
    if (!isAllowedMediaCorsOrigin(originHeader)) {
      return new Response('Forbidden: Disallowed CORS origin.', { status: 403 });
    }
    const corsHeaders = buildMediaCorsHeaders(originHeader);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const parsed = parseArtworkRequestFromMediaUrl(request.url);
    if (!parsed) {
      return new Response('Invalid artwork media URL.', { status: 400, headers: corsHeaders });
    }

    const track = this.trackRepo.findById(parsed.trackId);
    if (!track) {
      return new Response('Track not found.', { status: 404, headers: corsHeaders });
    }

    let row = this.artworkRepo.findByTrackId(track.id);
    if (!row) {
      await this.syncAutoArtworkForTrack(track);
      row = this.artworkRepo.findByTrackId(track.id);
    }

    const target = this.pickEffectiveFileOnDisk(row);
    if (!target) {
      return new Response('No artwork available for track.', { status: 404, headers: corsHeaders });
    }

    let filePathToServe = target.filePath;
    let mimeToServe = target.mime;

    if (parsed.size === 'thumb' && target.hash) {
      const thumbMatch = this.findExistingThumbFile(target.hash);
      if (thumbMatch) {
        filePathToServe = thumbMatch.filePath;
        mimeToServe = thumbMatch.mime;
      }
    }

    try {
      const data = await fs.readFile(filePathToServe);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': mimeToServe,
          'Content-Length': String(data.length),
          'Cache-Control': parsed.hasVersionToken
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        },
      });
    } catch {
      return new Response('Artwork file unreadable.', { status: 404, headers: corsHeaders });
    }
  }

  private pickEffectiveFileOnDisk(
    row: TrackArtworkRow | null,
  ): { filePath: string; mime: string; hash: string | null } | null {
    if (!row) {
      return null;
    }

    if (row.custom_file) {
      const p = path.join(this.customDir, row.custom_file);
      if (fsSync.existsSync(p)) {
        return { filePath: p, mime: row.custom_mime ?? 'image/jpeg', hash: row.custom_hash };
      }
    }

    if (row.embedded_cache_file) {
      const p = path.join(this.cacheDir, row.embedded_cache_file);
      if (fsSync.existsSync(p)) {
        return {
          filePath: p,
          mime: row.embedded_mime ?? 'image/jpeg',
          hash: row.embedded_hash,
        };
      }
    }

    if (row.folder_cache_file) {
      const p = path.join(this.cacheDir, row.folder_cache_file);
      if (fsSync.existsSync(p)) {
        return { filePath: p, mime: row.folder_mime ?? 'image/jpeg', hash: row.folder_hash };
      }
    }

    return null;
  }

  private async writeContentAddressedCache(
    filename: string,
    bytes: Buffer,
    mime: string,
  ): Promise<void> {
    this.ensureDirectoriesSync();
    const targetPath = path.join(this.cacheDir, filename);
    if (!fsSync.existsSync(targetPath)) {
      await fs.writeFile(targetPath, bytes);
    }
    const hash = path.basename(filename, path.extname(filename));
    await this.ensureThumbFile(hash, bytes, mime);
  }

  private async ensureThumbFile(hash: string, bytes: Buffer, mime: string): Promise<void> {
    if (this.findExistingThumbFile(hash)) {
      return;
    }
    const thumb = createThumbnailBufferIfPossible(bytes, mime);
    if (!thumb) {
      return;
    }
    const thumbPath = path.join(this.thumbDir, `${hash}${thumb.ext}`);
    await fs.writeFile(thumbPath, thumb.buffer).catch(() => {});
  }

  private findExistingThumbFile(hash: string): { filePath: string; mime: string } | null {
    const jpgPath = path.join(this.thumbDir, `${hash}.jpg`);
    if (fsSync.existsSync(jpgPath)) {
      return { filePath: jpgPath, mime: 'image/jpeg' };
    }
    const pngPath = path.join(this.thumbDir, `${hash}.png`);
    if (fsSync.existsSync(pngPath)) {
      return { filePath: pngPath, mime: 'image/png' };
    }
    return null;
  }

  /**
   * Removes unreferenced cached/custom/thumbnail files left behind after track deletions
   * or library clears while preserving shared content-addressed album artwork used by other tracks.
   */
  async pruneOrphanedMediaFiles(): Promise<{ removedCount: number }> {
    const rows = this.artworkRepo.findAllMap();
    const activeCustom = new Set<string>();
    const activeCache = new Set<string>();
    const activeHashes = new Set<string>();

    for (const row of rows.values()) {
      if (row.custom_file) {
        activeCustom.add(path.basename(row.custom_file));
      }
      if (row.custom_hash) {
        activeHashes.add(row.custom_hash);
      }
      if (row.embedded_cache_file) {
        activeCache.add(path.basename(row.embedded_cache_file));
      }
      if (row.embedded_hash) {
        activeHashes.add(row.embedded_hash);
      }
      if (row.folder_cache_file) {
        activeCache.add(path.basename(row.folder_cache_file));
      }
      if (row.folder_hash) {
        activeHashes.add(row.folder_hash);
      }
    }

    let removedCount = 0;

    const cleanDir = async (dirPath: string, isKeep: (fileName: string) => boolean): Promise<void> => {
      let entries: string[];
      try {
        entries = await fs.readdir(dirPath);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!isKeep(entry)) {
          await fs
            .unlink(path.join(dirPath, entry))
            .then(() => {
              removedCount += 1;
            })
            .catch(() => {});
        }
      }
    };

    await Promise.all([
      cleanDir(this.customDir, (name) => activeCustom.has(name)),
      cleanDir(this.cacheDir, (name) => activeCache.has(name)),
      cleanDir(this.thumbDir, (name) => {
        const hash = path.basename(name, path.extname(name));
        return activeHashes.has(hash);
      }),
    ]);

    return { removedCount };
  }
}
