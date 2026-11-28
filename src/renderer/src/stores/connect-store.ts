import { useSyncExternalStore } from 'react';
import { isRemoteTrackId, parseRemoteTrackId } from '../../../shared/contracts/connect-api';
import { buildRemoteTrackMediaUrl } from '../../../shared/contracts/media-protocol';
import type { ExternalTrackResolver } from '../player/audio-engine';
import {
  ConnectStore,
  type ConnectStoreDependencies,
  type ConnectStoreState,
  type RemoteLibraryViewTab,
  type ServerPageTab,
} from './connect-store-core';
import { playbackQueueController, playerActions } from './player-store';

export {
  ConnectStore,
  type ConnectStoreDependencies,
  type ConnectStoreState,
  type RemoteLibraryViewTab,
  type ServerPageTab,
};

export const connectStore = new ConnectStore({
  queueController: playbackQueueController,
  playbackActions: playerActions,
});

export const remotePlaybackSourceAdapter: ExternalTrackResolver = {
  ownsTrackId: (trackId) => isRemoteTrackId(trackId),
  getTrack: (trackId) => connectStore.getRemoteTrackRecord(trackId),
  resolveMediaUrl: (trackId) => {
    const parsed = parseRemoteTrackId(trackId);
    if (!parsed) {
      throw new Error(`Invalid remote track identifier: ${trackId}`);
    }
    return buildRemoteTrackMediaUrl(parsed.hostId, parsed.trackId);
  },
  isTrackPlayable: (trackId) => connectStore.isRemoteTrackPlayable(trackId),
  resolveRemoteDiagnosticHint: (trackId) => connectStore.resolveRemoteFailureHintForTrack(trackId),
};

playerActions.setExternalTrackResolver(remotePlaybackSourceAdapter);

export function useConnectState(): ConnectStoreState {
  return useSyncExternalStore(connectStore.subscribe, connectStore.getSnapshot);
}
