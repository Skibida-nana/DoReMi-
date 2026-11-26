import { useSyncExternalStore } from 'react';
import type {
  AppRuntimeInfo,
  ClearLibraryResult,
  ImportSummary,
  LibraryExclusionRecord,
  LibraryRootRecord,
  ReimportExcludedResult,
  RelinkSingleFileResult,
  RemoveTracksResult,
  RemoveWatchedFolderMode,
  RemoveWatchedFolderResult,
  ScanProgressEvent,
  WatchedFolderSummary,
} from '../../../shared/types/library';
import type {
  RelinkApplyResult,
  RelinkApplySelection,
  RelinkScanResult,
} from '../../../shared/types/stage6';
import type {
  TrackAvailabilityState,
  TrackMetadataOverrideInput,
  TrackRecord,
  TrackStatus,
} from '../../../shared/types/track';
import { playbackQueueController, syncEngineQueue } from './player-store';

export type TrackFilterMode =
  | 'all'
  | 'available'
  | 'missing'
  | 'source_unavailable'
  | 'access_error';

export interface LibraryStoreState {
  isElectronAvailable: boolean;
  isLoadingInitial: boolean;
  isScanning: boolean;
  tracks: TrackRecord[];
  roots: LibraryRootRecord[];
  databasePath: string;
  appInfo: AppRuntimeInfo | null;
  scanProgress: ScanProgressEvent | null;
  lastSummary: ImportSummary | null;
  runtimeError: string | null;
  searchQuery: string;
  filterMode: TrackFilterMode;
}

class LibraryStore {
  private state: LibraryStoreState = {
    isElectronAvailable: typeof window !== 'undefined' && Boolean(window.losslessApi),
    isLoadingInitial: true,
    isScanning: false,
    tracks: [],
    roots: [],
    databasePath: '',
    appInfo: null,
    scanProgress: null,
    lastSummary: null,
    runtimeError: null,
    searchQuery: '',
    filterMode: 'all',
  };

  private readonly listeners = new Set<() => void>();
  private trackMap = new Map<string, TrackRecord>();
  private initialized = false;
  private cleanups: Array<() => void> = [];

  getSnapshot = (): LibraryStoreState => {
    return this.state;
  };

  getTrackById(trackId: string): TrackRecord | undefined {
    return this.trackMap.get(trackId);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    const api = typeof window !== 'undefined' ? window.losslessApi : undefined;
    if (!api) {
      this.setState({
        isElectronAvailable: false,
        isLoadingInitial: false,
      });
      return;
    }

    this.setState({ isElectronAvailable: true, isLoadingInitial: true, runtimeError: null });

    const unsubProgress = api.onScanProgress((event) => {
      this.setState({
        scanProgress: event,
        isScanning: event.phase !== 'completed' && event.phase !== 'canceled',
      });
    });

    const unsubTrackStatus = api.onTrackStatusChanged((event) => {
      this.applyTrackStatusLocally(event.trackId, event.status);
    });

    this.cleanups.push(unsubProgress, unsubTrackStatus);

    try {
      const [snapshot, appInfo] = await Promise.all([
        api.getLibrarySnapshot(),
        api.getAppInfo(),
      ]);

      this.setState({
        tracks: snapshot.tracks,
        roots: snapshot.roots,
        databasePath: snapshot.databasePath,
        appInfo,
        isLoadingInitial: false,
      });
      syncEngineQueue(snapshot.tracks);
    } catch (error) {
      this.setState({
        isLoadingInitial: false,
        runtimeError: `Không thể tải thư viện từ SQLite: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async refreshSnapshot(): Promise<void> {
    const api = window.losslessApi;
    if (!api) {
      return;
    }
    try {
      const snapshot = await api.getLibrarySnapshot();
      this.setState({
        tracks: snapshot.tracks,
        roots: snapshot.roots,
        databasePath: snapshot.databasePath,
      });
      syncEngineQueue(snapshot.tracks);
    } catch (error) {
      this.setState({
        runtimeError: `Lỗi tải lại thư viện: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async importFiles(): Promise<void> {
    const api = window.losslessApi;
    if (!api || this.state.isScanning) {
      return;
    }
    this.setState({ isScanning: true, runtimeError: null, scanProgress: null });
    try {
      const summary = await api.importFiles();
      if (!summary.canceled) {
        this.setState({ lastSummary: summary });
        await this.refreshSnapshot();
      }
    } catch (error) {
      this.setState({
        runtimeError: `Lỗi khi import file: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      this.setState({ isScanning: false });
    }
  }

  async importFolder(): Promise<void> {
    const api = window.losslessApi;
    if (!api || this.state.isScanning) {
      return;
    }
    this.setState({ isScanning: true, runtimeError: null, scanProgress: null });
    try {
      const summary = await api.importFolder();
      if (!summary.canceled) {
        this.setState({ lastSummary: summary });
        await this.refreshSnapshot();
      }
    } catch (error) {
      this.setState({
        runtimeError: `Lỗi khi quét thư mục: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      this.setState({ isScanning: false });
    }
  }

  async rescanLibrary(): Promise<ImportSummary | null> {
    const api = window.losslessApi;
    if (!api || this.state.isScanning) {
      return null;
    }
    this.setState({ isScanning: true, runtimeError: null, scanProgress: null });
    try {
      const summary = await api.rescanLibrary();
      this.setState({ lastSummary: summary });
      await this.refreshSnapshot();
      return summary;
    } catch (error) {
      this.setState({
        runtimeError: `Lỗi khi quét lại thư viện: ${error instanceof Error ? error.message : String(error)}`,
      });
      return null;
    } finally {
      this.setState({ isScanning: false });
    }
  }

  async cancelRescan(): Promise<boolean> {
    const api = window.losslessApi;
    if (!api?.cancelRescan) {
      return false;
    }
    const res = await api.cancelRescan();
    return Boolean(res.canceled);
  }

  async removeTracks(
    trackIds: readonly string[],
    options?: { addExclusion?: boolean },
  ): Promise<RemoveTracksResult> {
    const api = window.losslessApi;
    if (!api?.removeTracksFromLibrary) {
      return { removedTrackIds: [], excludedCount: 0, notFoundIds: [...trackIds] };
    }
    const res = await api.removeTracksFromLibrary(trackIds, options);
    if (res.removedTrackIds.length > 0) {
      playbackQueueController.removeTracksFromQueue(res.removedTrackIds);
      await this.refreshSnapshot();
    }
    return res;
  }

  async showTrackInFolder(trackId: string): Promise<{ shown: boolean; error?: string }> {
    const api = window.losslessApi;
    if (!api?.showTrackInFolder) {
      return { shown: false, error: 'Chức năng mở trong File Explorer yêu cầu bản desktop Electron.' };
    }
    return api.showTrackInFolder(trackId);
  }

  async listWatchedFolders(): Promise<WatchedFolderSummary[]> {
    const api = window.losslessApi;
    if (!api?.listWatchedFolders) {
      return [];
    }
    return api.listWatchedFolders();
  }

  async updateRootSettings(
    rootId: string,
    patch: { recursive?: boolean; enabled?: boolean; auto_watch?: boolean },
  ): Promise<LibraryRootRecord | null> {
    const api = window.losslessApi;
    if (!api?.updateLibraryRootSettings) {
      return null;
    }
    const updated = await api.updateLibraryRootSettings(rootId, patch);
    await this.refreshSnapshot();
    return updated;
  }

  async rescanWatchedFolder(rootId: string): Promise<ImportSummary | null> {
    const api = window.losslessApi;
    if (!api?.rescanWatchedFolder || this.state.isScanning) {
      return null;
    }
    this.setState({ isScanning: true, runtimeError: null, scanProgress: null });
    try {
      const summary = await api.rescanWatchedFolder(rootId);
      this.setState({ lastSummary: summary });
      await this.refreshSnapshot();
      return summary;
    } catch (error) {
      this.setState({
        runtimeError: `Lỗi khi quét thư mục: ${error instanceof Error ? error.message : String(error)}`,
      });
      return null;
    } finally {
      this.setState({ isScanning: false });
    }
  }

  async removeWatchedFolder(
    rootId: string,
    mode: RemoveWatchedFolderMode,
  ): Promise<RemoveWatchedFolderResult | null> {
    const api = window.losslessApi;
    if (!api?.removeWatchedFolder) {
      return null;
    }
    const res = await api.removeWatchedFolder(rootId, mode);
    if (res.removedTrackIds.length > 0) {
      playbackQueueController.removeTracksFromQueue(res.removedTrackIds);
    }
    await this.refreshSnapshot();
    return res;
  }

  async clearAllImportedMusic(): Promise<ClearLibraryResult | null> {
    const api = window.losslessApi;
    if (!api?.clearAllImportedMusic) {
      return null;
    }
    const currentIds = this.state.tracks.map((t) => t.id);
    const res = await api.clearAllImportedMusic();
    if (currentIds.length > 0) {
      playbackQueueController.removeTracksFromQueue(currentIds);
    }
    await this.refreshSnapshot();
    return res;
  }

  async listExcludedTracks(): Promise<LibraryExclusionRecord[]> {
    const api = window.losslessApi;
    if (!api?.listExcludedTracks) {
      return [];
    }
    return api.listExcludedTracks();
  }

  async reimportExcludedTracks(exclusionIds?: readonly string[]): Promise<ReimportExcludedResult | null> {
    const api = window.losslessApi;
    if (!api?.reimportExcludedTracks) {
      return null;
    }
    const res = await api.reimportExcludedTracks(exclusionIds);
    this.setState({ lastSummary: res.summary });
    await this.refreshSnapshot();
    return res;
  }

  async clearExclusions(exclusionIds?: readonly string[]): Promise<number> {
    const api = window.losslessApi;
    if (!api?.clearExclusions) {
      return 0;
    }
    const res = await api.clearExclusions(exclusionIds);
    return res.clearedCount;
  }

  async relinkSingleTrackDialog(trackId: string): Promise<RelinkSingleFileResult> {
    const api = window.losslessApi;
    if (!api?.relinkSingleTrackDialog) {
      return {
        canceled: false,
        success: false,
        track: null,
        error: 'Chức năng liên kết lại file yêu cầu chạy trong ứng dụng Electron.',
      };
    }
    const res = await api.relinkSingleTrackDialog(trackId);
    if (res.success && res.track) {
      this.updateTrackInPlace(res.track);
    }
    return res;
  }

  async scanRelinkFolder(): Promise<RelinkScanResult> {
    const api = window.losslessApi;
    if (!api?.scanRelinkFolder) {
      return {
        canceled: false,
        totalMissingTracks: 0,
        matchedCount: 0,
        ambiguousCount: 0,
        unmatchedCount: 0,
        conflictCount: 0,
        proposals: [],
        error: 'Chức năng quét liên kết lại thư mục yêu cầu chạy trong ứng dụng Electron.',
      };
    }
    return api.scanRelinkFolder();
  }

  async applyRelink(selections: readonly RelinkApplySelection[]): Promise<RelinkApplyResult> {
    const api = window.losslessApi;
    if (!api?.applyRelink) {
      return { relinkedCount: 0, failedCount: selections.length, errors: [] };
    }
    const res = await api.applyRelink(selections);
    if (res.relinkedCount > 0) {
      await this.refreshSnapshot();
    }
    return res;
  }

  /**
   * Updates a single TrackRecord in place (metadata or artwork) without restarting AudioEngine playback.
   */
  updateTrackInPlace(updatedTrack: TrackRecord): void {
    const exists = this.state.tracks.some((t) => t.id === updatedTrack.id);
    if (!exists) {
      return;
    }
    const nextTracks = this.state.tracks.map((track) =>
      track.id === updatedTrack.id ? updatedTrack : track,
    );
    this.setState({ tracks: nextTracks });
    syncEngineQueue(nextTracks);
  }

  async importCustomArtwork(
    trackId: string,
  ): Promise<{ canceled: boolean; track: TrackRecord | null; error?: string }> {
    const api = window.losslessApi;
    if (!api) {
      return { canceled: true, track: null };
    }
    const result = await api.importCustomArtwork(trackId);
    if (!result.canceled && result.track) {
      this.updateTrackInPlace(result.track);
    }
    return result;
  }

  async removeCustomArtwork(
    trackId: string,
  ): Promise<{ canceled: boolean; track: TrackRecord | null; error?: string }> {
    const api = window.losslessApi;
    if (!api) {
      return { canceled: true, track: null };
    }
    const result = await api.removeCustomArtwork(trackId);
    if (!result.canceled && result.track) {
      this.updateTrackInPlace(result.track);
    }
    return result;
  }

  async updateTrackMetadataOverride(
    trackId: string,
    input: TrackMetadataOverrideInput,
  ): Promise<TrackRecord | null> {
    const api = window.losslessApi;
    if (!api) {
      return null;
    }
    const updated = await api.updateTrackMetadataOverride(trackId, input);
    this.updateTrackInPlace(updated);
    return updated;
  }

  async restoreTrackMetadataOriginal(trackId: string): Promise<TrackRecord | null> {
    const api = window.losslessApi;
    if (!api) {
      return null;
    }
    const updated = await api.restoreTrackMetadataOriginal(trackId);
    this.updateTrackInPlace(updated);
    return updated;
  }

  applyTrackStatusLocally(trackId: string, status: TrackStatus): void {
    const availState: TrackAvailabilityState =
      status === 'available'
        ? 'available'
        : status === 'error'
          ? 'access_error'
          : 'missing';
    const nextTracks = this.state.tracks.map((track) =>
      track.id === trackId
        ? {
            ...track,
            status,
            availability_state: availState,
          }
        : track,
    );
    this.setState({ tracks: nextTracks });
    syncEngineQueue(nextTracks);
  }

  setSearchQuery(query: string): void {
    this.setState({ searchQuery: query });
  }

  setFilterMode(mode: TrackFilterMode): void {
    this.setState({ filterMode: mode });
  }

  dismissSummary(): void {
    this.setState({ lastSummary: null, scanProgress: null, runtimeError: null });
  }

  dispose(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups = [];
  }

  private setState(partial: Partial<LibraryStoreState>): void {
    this.state = { ...this.state, ...partial };
    if (partial.tracks !== undefined) {
      this.trackMap = new Map(partial.tracks.map((t) => [t.id, t]));
    }
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const libraryStore = new LibraryStore();

export function useLibraryState(): LibraryStoreState {
  return useSyncExternalStore(libraryStore.subscribe, libraryStore.getSnapshot);
}
