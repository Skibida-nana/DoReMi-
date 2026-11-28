import { protocol } from 'electron';
import {
  MEDIA_ARTWORK_HOST,
  MEDIA_PLAYLIST_HOST,
  MEDIA_PROFILE_HOST,
  MEDIA_PROTOCOL_SCHEME,
  MEDIA_REMOTE_ARTWORK_HOST,
  MEDIA_REMOTE_TRACK_HOST,
} from '../../shared/contracts/media-protocol';
import type { ArtworkService } from './artwork-service';
import {
  resolveTrackMediaResponse,
  type AudioProtocolDeps,
} from './audio-stream-handler';
import type { ConnectClientService } from './connect/connect-client';
import type { PlaylistService } from './playlist-service';
import type { ProfileService } from './profile-service';

export { parseByteRangeHeader, resolveTrackMediaResponse } from './audio-stream-handler';
export type { AudioProtocolDeps, ByteRangeParseResult } from './audio-stream-handler';

export interface MediaProtocolDeps extends AudioProtocolDeps {
  artworkService?: ArtworkService;
  playlistService?: PlaylistService;
  profileService?: ProfileService;
  connectClientService?: ConnectClientService;
}

/**
 * Registers the privileged custom protocol scheme before Electron app.whenReady().
 */
export function registerPrivilegedAudioScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

/**
 * Binds the protocol handler after app.whenReady().
 * Routes `lossless-media://track/<uuid>` to audio streaming (unchanged),
 * `lossless-media://artwork/<uuid>` to offline cached artwork delivery,
 * and `lossless-media://profile/<avatar|background>` to local profile media.
 */
export function registerAudioProtocolHandler(deps: MediaProtocolDeps): void {
  protocol.handle(MEDIA_PROTOCOL_SCHEME, (request) => {
    try {
      const parsed = new URL(request.url);
      if (parsed.hostname === MEDIA_ARTWORK_HOST && deps.artworkService) {
        return deps.artworkService.resolveArtworkHttpResponse(request);
      }
      if (parsed.hostname === MEDIA_PLAYLIST_HOST && deps.playlistService) {
        return deps.playlistService.resolvePlaylistMediaHttpResponse(request);
      }
      if (parsed.hostname === MEDIA_PROFILE_HOST && deps.profileService) {
        return deps.profileService.resolveProfileMediaHttpResponse(request);
      }
      if (parsed.hostname === MEDIA_REMOTE_TRACK_HOST && deps.connectClientService) {
        return deps.connectClientService.resolveRemoteTrackMediaResponse(request);
      }
      if (parsed.hostname === MEDIA_REMOTE_ARTWORK_HOST && deps.connectClientService) {
        return deps.connectClientService.resolveRemoteArtworkMediaResponse(request);
      }
    } catch {
      // Fall through to strict validator in resolveTrackMediaResponse
    }
    return resolveTrackMediaResponse(request, deps);
  });
}
