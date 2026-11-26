import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import { parsePlaylistArtworkRequestFromMediaUrl } from '../../shared/contracts/media-protocol';
import type {
  AddTracksToPlaylistOptions,
  AddTracksToPlaylistResult,
  CreatePlaylistInput,
  LegacyCollectionsMigrationInput,
  PlaylistArtworkActionResult,
  PlaylistRecord,
  PlaylistSnapshot,
  UpdatePlaylistInput,
} from '../../shared/types/playlist';
import type { PlaylistRepository } from '../database/playlist-repository';
import { validateImageBuffer } from './artwork-service';
import { buildMediaCorsHeaders, isAllowedMediaCorsOrigin } from './audio-stream-handler';

export interface PlaylistServiceOptions {
  playlistRepo: PlaylistRepository;
  userDataDir: string;
}

export class PlaylistService {
  private readonly playlistRepo: PlaylistRepository;
  private readonly mediaDir: string;

  constructor(options: PlaylistServiceOptions) {
    this.playlistRepo = options.playlistRepo;
    this.mediaDir = path.join(options.userDataDir, 'playlist-media');
  }

  getSnapshot(): PlaylistSnapshot {
    return this.playlistRepo.getSnapshot();
  }

  createPlaylist(input: CreatePlaylistInput): PlaylistRecord {
    return this.playlistRepo.createPlaylist(input);
  }

  updatePlaylist(playlistId: string, input: UpdatePlaylistInput): PlaylistRecord {
    return this.playlistRepo.updatePlaylist(playlistId, input);
  }

  async deletePlaylist(playlistId: string): Promise<{ deleted: boolean }> {
    const res = this.playlistRepo.deletePlaylist(playlistId);
    if (res.deleted && res.oldArtworkFile) {
      await fs.unlink(path.join(this.mediaDir, res.oldArtworkFile)).catch(() => {});
    }
    return { deleted: res.deleted };
  }

  addTracksToPlaylist(
    playlistId: string,
    trackIds: readonly string[],
    options?: AddTracksToPlaylistOptions,
  ): AddTracksToPlaylistResult {
    return this.playlistRepo.addTracksToPlaylist(playlistId, trackIds, options);
  }

  removeEntriesFromPlaylist(
    playlistId: string,
    entryIds: readonly string[],
  ): PlaylistRecord {
    return this.playlistRepo.removeEntriesFromPlaylist(playlistId, entryIds);
  }

  reorderPlaylistEntries(
    playlistId: string,
    orderedEntryIds: readonly string[],
  ): PlaylistRecord {
    return this.playlistRepo.reorderPlaylistEntries(playlistId, orderedEntryIds);
  }

  toggleFavorite(trackId: string): { isFavorite: boolean; favoriteTrackIds: string[] } {
    return this.playlistRepo.toggleFavorite(trackId);
  }

  setFavorites(trackIds: readonly string[], favorite: boolean): { favoriteTrackIds: string[] } {
    return {
      favoriteTrackIds: this.playlistRepo.setFavorites(trackIds, favorite),
    };
  }

  migrateLegacyCollections(legacy: LegacyCollectionsMigrationInput): PlaylistSnapshot {
    return this.playlistRepo.migrateLegacyCollections(legacy);
  }

  async importArtworkFromDialog(
    playlistId: string,
    parentWindow?: BrowserWindow | null,
  ): Promise<PlaylistArtworkActionResult> {
    const dialogOpts: Electron.OpenDialogOptions = {
      title: 'Chọn ảnh bìa cho Playlist',
      properties: ['openFile'],
      filters: [{ name: 'Ảnh (JPG, PNG, WEBP)', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    };

    const selection = parentWindow
      ? await dialog.showOpenDialog(parentWindow, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);

    if (selection.canceled || selection.filePaths.length === 0) {
      return { canceled: true, playlist: null };
    }

    const filePath = selection.filePaths[0];
    try {
      const playlist = await this.setCustomArtworkFromFile(playlistId, filePath);
      return { canceled: false, playlist };
    } catch (error) {
      return {
        canceled: false,
        playlist: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async setCustomArtworkFromFile(
    playlistId: string,
    imageFilePath: string,
  ): Promise<PlaylistRecord> {
    const existingRow = this.playlistRepo.getArtworkRow(playlistId);
    if (!existingRow) {
      throw new Error('Không tìm thấy playlist trong cơ sở dữ liệu.');
    }

    const rawBytes = await fs.readFile(imageFilePath);
    const validated = validateImageBuffer(rawBytes);
    if (!validated) {
      throw new Error(
        'Ảnh bìa playlist không hợp lệ. Chỉ hỗ trợ JPG, PNG hoặc WEBP dung lượng tối đa 15 MB.',
      );
    }

    const hash = crypto.createHash('sha256').update(rawBytes).digest('hex');
    const fileName = `${playlistId}-${hash.slice(0, 12)}${validated.ext}`;

    fsSync.mkdirSync(this.mediaDir, { recursive: true });
    await fs.writeFile(path.join(this.mediaDir, fileName), rawBytes);

    const updated = this.playlistRepo.setCustomArtwork(
      playlistId,
      fileName,
      validated.mime,
      hash,
    );

    if (existingRow.custom_artwork_file && existingRow.custom_artwork_file !== fileName) {
      await fs
        .unlink(path.join(this.mediaDir, existingRow.custom_artwork_file))
        .catch(() => {});
    }

    return updated;
  }

  async removeCustomArtwork(playlistId: string): Promise<PlaylistRecord> {
    const { playlist, oldArtworkFile } = this.playlistRepo.clearCustomArtwork(playlistId);
    if (oldArtworkFile) {
      await fs.unlink(path.join(this.mediaDir, oldArtworkFile)).catch(() => {});
    }
    return playlist;
  }

  async resolvePlaylistMediaHttpResponse(request: Request): Promise<Response> {
    const originHeader = request.headers.get('origin');
    if (!isAllowedMediaCorsOrigin(originHeader)) {
      return new Response('Forbidden: Disallowed CORS origin.', { status: 403 });
    }
    const corsHeaders = buildMediaCorsHeaders(originHeader);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const parsed = parsePlaylistArtworkRequestFromMediaUrl(request.url);
    if (!parsed) {
      return new Response('Invalid playlist artwork URL.', { status: 400, headers: corsHeaders });
    }

    const row = this.playlistRepo.getArtworkRow(parsed.playlistId);
    if (!row || !row.custom_artwork_file) {
      return new Response('Playlist artwork not found.', { status: 404, headers: corsHeaders });
    }

    const filePath = path.join(this.mediaDir, path.basename(row.custom_artwork_file));
    try {
      const data = await fs.readFile(filePath);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': row.custom_artwork_mime ?? 'image/jpeg',
          'Content-Length': String(data.length),
          'Cache-Control': parsed.hasVersionToken
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        },
      });
    } catch {
      return new Response('Playlist artwork unreadable.', { status: 404, headers: corsHeaders });
    }
  }
}
