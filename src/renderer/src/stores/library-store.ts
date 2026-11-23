import { useSyncExternalStore } from 'react';
import type {
  AppRuntimeInfo,
  ImportSummary,
  LibraryRootRecord,
  ScanProgressEvent,
} from '../../../shared/types/library';
import type {
  TrackMetadataOverrideInput,
  TrackRecord,
  TrackStatus,
} from '../../../shared/types/track';
import { syncEngineQueue } from './player-store';

export type TrackFilterMode = 'all' | 'available' | 'missing';

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
  private initialized = false;
  private cleanups: Array<() => void> = [];

  getSnapshot = (): LibraryStoreState => {
    return this.state;
  };

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
        isScanning: event.phase !== 'completed',
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

  async rescanLibrary(): Promise<void> {
    const api = window.losslessApi;
    if (!api || this.state.isScanning) {
      return;
    }
    this.setState({ isScanning: true, runtimeError: null, scanProgress: null });
    try {
      const summary = await api.rescanLibrary();
      this.setState({ lastSummary: summary });
      await this.refreshSnapshot();
    } catch (error) {
      this.setState({
        runtimeError: `Lỗi khi quét lại thư viện: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      this.setState({ isScanning: false });
    }
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
    const nextTracks = this.state.tracks.map((track) =>
      track.id === trackId ? { ...track, status } : track,
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
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const libraryStore = new LibraryStore();

export function useLibraryState(): LibraryStoreState {
  return useSyncExternalStore(libraryStore.subscribe, libraryStore.getSnapshot);
}
