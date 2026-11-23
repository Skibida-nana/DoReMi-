import type { TrackRecord, TrackStatus } from './track';

export type LibraryRootStatus = 'available' | 'missing';

export interface LibraryRootRecord {
  id: string;
  original_path: string;
  normalized_path: string;
  added_at: string;
  last_scanned_at: string | null;
  status: LibraryRootStatus;
}

export interface ImportErrorItem {
  path: string;
  reason: string;
}

export interface ImportSummary {
  canceled: boolean;
  scannedCount: number;
  addedCount: number;
  updatedCount: number;
  skippedCount: number;
  missingMarkedCount: number;
  recoveredCount: number;
  errors: ImportErrorItem[];
}

export type ScanPhase = 'discovering' | 'importing' | 'verifying' | 'completed';

export interface ScanProgressEvent {
  phase: ScanPhase;
  current: number;
  total: number;
  currentPath: string | null;
  message: string;
}

export interface LibrarySnapshot {
  tracks: TrackRecord[];
  roots: LibraryRootRecord[];
  databasePath: string;
}

export interface VerifyTrackResult {
  trackId: string;
  exists: boolean;
  status: TrackStatus;
  reason?: string;
}

export interface TrackStatusChangedEvent {
  trackId: string;
  status: TrackStatus;
  reason?: string;
}

export interface AppRuntimeInfo {
  appName: string;
  appVersion: string;
  electronVersion: string;
  platform: string;
  databasePath: string;
}
