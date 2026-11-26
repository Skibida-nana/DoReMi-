import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  AlertTriangle,
  CheckSquare,
  Disc3,
  FilePlus2,
  FolderPlus,
  Heart,
  Link2,
  ListPlus,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  compareTracksByFileName,
  compareTracksByFolder,
  compareTracksByTrackNumber,
} from '../../../shared/utils/folder-tree';
import { naturalCompare } from '../../../shared/utils/natural-sort';
import type { TrackMetadataOverrideInput } from '../../../shared/types/track';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import { AlbumCoverflow } from '../components/AlbumCoverflow';
import { LibraryBackToTopButton } from '../components/LibraryBackToTopButton';
import { LibraryFoldersTab } from '../components/LibraryFoldersTab';
import {
  LibrarySourcesAndMissingModal,
  type SourcesModalTab,
} from '../components/LibrarySourcesAndMissingModal';
import { OverlayPortal } from '../components/OverlayLayer';
import { PlaylistPickerModal } from '../components/PlaylistPickerModal';
import {
  TrackMetadataModal,
  buildMetadataEditTargetFromTrack,
  type TrackMetadataEditTarget,
} from '../components/TrackMetadataModal';
import type { PrototypeTrack } from '../data/prototype-catalog';
import { libraryStore, useLibraryState } from '../stores/library-store';
import { usePlaybackTrackId } from '../stores/player-store';
import { uiStore, useUiState } from '../stores/ui-store';
import { formatDurationSeconds } from '../utils/formatters';
import { useWindowedListSlice } from '../utils/use-windowed-slice';
import {
  matchesNormalizedVietnameseQuery,
  normalizeVietnameseText,
} from '../utils/vietnamese-search';

type SortMode =
  | 'recent'
  | 'title'
  | 'artist'
  | 'album'
  | 'folder'
  | 'filename'
  | 'track_number'
  | 'duration';

type StatusFilter = 'all' | 'available' | 'missing' | 'source_unavailable' | 'access_error';

function availabilityChipInfo(track: PrototypeTrack): { label: string; className: string } {
  const st = track.availabilityState ?? track.status;
  if (st === 'source_unavailable') {
    return {
      label: 'Nguồn không khả dụng',
      className:
        'border-amber-500/35 bg-amber-500/15 text-amber-700 dark:text-amber-200',
    };
  }
  if (st === 'access_error') {
    return {
      label: 'Lỗi truy cập',
      className: 'border-rose-500/35 bg-rose-500/15 text-rose-700 dark:text-rose-200',
    };
  }
  return {
    label: 'Thiếu file',
    className:
      'border-amber-500/35 bg-amber-500/15 text-amber-700 dark:text-amber-200',
  };
}

export function LibraryPage() {
  const ui = useUiState();
  const library = useLibraryState();
  const activeTrackId = usePlaybackTrackId() ?? '';
  const palette = uiStore.getCurrentPalette();
  const userAccent = uiStore.getUserAccentPalette();

  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [showPlaylistCreator, setShowPlaylistCreator] = useState(false);

  const [editTargetTrackId, setEditTargetTrackId] = useState<string | null>(null);
  const [isSavingMeta, setIsSavingMeta] = useState(false);

  // Playlist picker modal state
  const [pickerState, setPickerState] = useState<{
    trackIds: string[];
    title?: string;
    initialMode?: 'pick' | 'create';
    allowToggleSelection?: boolean;
  } | null>(null);

  // Multi-selection mode state (ID-based)
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastClickedIndexRef = useRef<number | null>(null);

  // Delete from Library confirmation modal state
  const [pendingDeleteTracks, setPendingDeleteTracks] = useState<PrototypeTrack[] | null>(null);
  const [excludeOnDelete, setExcludeOnDelete] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);

  // Sources & Missing management modal
  const [sourcesModalTab, setSourcesModalTab] = useState<SourcesModalTab | null>(null);
  const [confirmDeletePlaylistId, setConfirmDeletePlaylistId] = useState<string | null>(null);

  const pageRootRef = useRef<HTMLDivElement | null>(null);
  const trackListContainerRef = useRef<HTMLDivElement | null>(null);

  const allTracks = useMemo(() => uiStore.getUnifiedTracks(), [library.tracks]);
  const allAlbums = useMemo(() => uiStore.getDerivedAlbums(), [library.tracks]);
  const favoriteSet = useMemo(() => uiStore.getFavoriteIdSet(), [ui.favoriteIds]);

  const issueTracksCount = useMemo(
    () => allTracks.filter((t) => t.status !== 'available').length,
    [allTracks],
  );

  // Recompute Metadata Modal target cleanly whenever library tracks/artwork update
  const editTarget: TrackMetadataEditTarget | null = useMemo(() => {
    if (!editTargetTrackId) return null;
    const real = libraryStore.getTrackById(editTargetTrackId);
    return real ? buildMetadataEditTargetFromTrack(real) : null;
  }, [editTargetTrackId, library.tracks]);

  const filteredTracks = useMemo(() => {
    const base =
      ui.libraryTab === 'favorites'
        ? allTracks.filter((t) => favoriteSet.has(t.id))
        : allTracks;

    const normalizedQuery = normalizeVietnameseText(query);
    const searched = base.filter((t) => {
      if (statusFilter !== 'all') {
        const effState = t.availabilityState ?? t.status;
        if (statusFilter === 'missing') {
          if (t.status === 'available') return false;
        } else if (effState !== statusFilter) {
          return false;
        }
      }
      if (!normalizedQuery) {
        return true;
      }
      return (
        matchesNormalizedVietnameseQuery(t.title, normalizedQuery) ||
        matchesNormalizedVietnameseQuery(t.artist, normalizedQuery) ||
        matchesNormalizedVietnameseQuery(t.albumTitle, normalizedQuery) ||
        matchesNormalizedVietnameseQuery(t.formatBadge, normalizedQuery) ||
        matchesNormalizedVietnameseQuery(t.fileName ?? '', normalizedQuery)
      );
    });

    return [...searched].sort((a, b) => {
      if (sortMode === 'title') {
        return naturalCompare(a.title, b.title);
      }
      if (sortMode === 'artist') {
        return naturalCompare(a.artist, b.artist);
      }
      if (sortMode === 'album') {
        const albCmp = naturalCompare(a.albumTitle, b.albumTitle);
        if (albCmp !== 0) return albCmp;
        return compareTracksByTrackNumber(
          { id: a.id, original_path: a.filePathDisplay, title: a.title, artist: a.artist, trackNumber: a.trackNumber, discNumber: a.discNumber, file_name: a.fileName, status: a.status },
          { id: b.id, original_path: b.filePathDisplay, title: b.title, artist: b.artist, trackNumber: b.trackNumber, discNumber: b.discNumber, file_name: b.fileName, status: b.status },
        );
      }
      if (sortMode === 'folder') {
        return compareTracksByFolder(
          { id: a.id, original_path: a.filePathDisplay, title: a.title, artist: a.artist, trackNumber: a.trackNumber, discNumber: a.discNumber, file_name: a.fileName, status: a.status },
          { id: b.id, original_path: b.filePathDisplay, title: b.title, artist: b.artist, trackNumber: b.trackNumber, discNumber: b.discNumber, file_name: b.fileName, status: b.status },
        );
      }
      if (sortMode === 'filename') {
        return compareTracksByFileName(
          { id: a.id, original_path: a.filePathDisplay, title: a.title, artist: a.artist, file_name: a.fileName, status: a.status },
          { id: b.id, original_path: b.filePathDisplay, title: b.title, artist: b.artist, file_name: b.fileName, status: b.status },
        );
      }
      if (sortMode === 'track_number') {
        return compareTracksByTrackNumber(
          { id: a.id, original_path: a.filePathDisplay, title: a.title, artist: a.artist, trackNumber: a.trackNumber, discNumber: a.discNumber, file_name: a.fileName, status: a.status },
          { id: b.id, original_path: b.filePathDisplay, title: b.title, artist: b.artist, trackNumber: b.trackNumber, discNumber: b.discNumber, file_name: b.fileName, status: b.status },
        );
      }
      if (sortMode === 'duration') {
        return b.durationSec - a.durationSec;
      }
      return b.addedOrder - a.addedOrder;
    });
  }, [allTracks, ui.libraryTab, favoriteSet, statusFilter, query, sortMode]);

  const trackWindowSlice = useWindowedListSlice({
    containerRef: trackListContainerRef,
    totalItems: filteredTracks.length,
    itemHeightPx: 62,
  });
  const visibleTracks = useMemo(
    () => filteredTracks.slice(trackWindowSlice.startIndex, trackWindowSlice.endIndex),
    [filteredTracks, trackWindowSlice.startIndex, trackWindowSlice.endIndex],
  );

  // Reconcile selectedIds if tracks were deleted outside selection action
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const valid = new Set(allTracks.map((t) => t.id));
    let dirty = false;
    for (const id of selectedIds) {
      if (!valid.has(id)) {
        dirty = true;
        break;
      }
    }
    if (dirty) {
      setSelectedIds((prev) => new Set(Array.from(prev).filter((id) => valid.has(id))));
    }
  }, [allTracks, selectedIds]);

  // Keyboard shortcuts for Multi-Selection (Ctrl+A select visible, Escape exit)
  useEffect(() => {
    if (!multiSelectMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelectedIds(new Set(filteredTracks.map((t) => t.id)));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setMultiSelectMode(false);
        setSelectedIds(new Set());
        lastClickedIndexRef.current = null;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [multiSelectMode, filteredTracks]);

  const visibleSelectedCount = useMemo(
    () => filteredTracks.filter((t) => selectedIds.has(t.id)).length,
    [filteredTracks, selectedIds],
  );
  const hiddenSelectedCount = Math.max(0, selectedIds.size - visibleSelectedCount);

  const artists = useMemo(() => {
    const map = new Map<
      string,
      { name: string; coverUrl: string; trackCount: number; albumSet: Set<string> }
    >();
    for (const track of allTracks) {
      const existing = map.get(track.artist);
      if (existing) {
        existing.trackCount += 1;
        existing.albumSet.add(track.albumTitle);
        if (
          existing.coverUrl === DEFAULT_DOREMI_ARTWORK_URL &&
          track.coverUrl &&
          track.coverUrl !== DEFAULT_DOREMI_ARTWORK_URL
        ) {
          existing.coverUrl = track.coverUrl;
        }
      } else {
        map.set(track.artist, {
          name: track.artist,
          coverUrl: track.coverUrl || DEFAULT_DOREMI_ARTWORK_URL,
          trackCount: 1,
          albumSet: new Set([track.albumTitle]),
        });
      }
    }
    return Array.from(map.values())
      .map((entry) => ({
        name: entry.name,
        coverUrl: entry.coverUrl,
        trackCount: entry.trackCount,
        albumCount: entry.albumSet.size,
      }))
      .filter((a) => matchesNormalizedVietnameseQuery(a.name, normalizeVietnameseText(query)))
      .sort((a, b) => naturalCompare(a.name, b.name));
  }, [allTracks, query]);

  const filteredAlbums = useMemo(() => {
    const normalizedQuery = normalizeVietnameseText(query);
    if (!normalizedQuery) return allAlbums;
    return allAlbums.filter(
      (a) =>
        matchesNormalizedVietnameseQuery(a.title, normalizedQuery) ||
        matchesNormalizedVietnameseQuery(a.artist, normalizedQuery) ||
        matchesNormalizedVietnameseQuery(a.genre, normalizedQuery),
    );
  }, [allAlbums, query]);

  const openMetadataEditor = (track: PrototypeTrack) => {
    setEditTargetTrackId(track.id);
  };

  const handleSaveMetadata = async (trackId: string, input: TrackMetadataOverrideInput) => {
    setIsSavingMeta(true);
    try {
      if (window.losslessApi) {
        await libraryStore.updateTrackMetadataOverride(trackId, input);
        uiStore.showToast('Đã lưu thông tin bài hát (file gốc không thay đổi)');
      }
    } finally {
      setIsSavingMeta(false);
    }
  };

  const handleRestoreMetadata = async (trackId: string) => {
    setIsSavingMeta(true);
    try {
      if (window.losslessApi) {
        await libraryStore.restoreTrackMetadataOriginal(trackId);
        uiStore.showToast('Đã khôi phục thông tin gốc của bài hát');
      }
    } finally {
      setIsSavingMeta(false);
    }
  };

  const handlePlayTrack = (track: PrototypeTrack) => {
    if (track.status !== 'available') {
      uiStore.showToast('File nhạc hiện không khả dụng — hãy nhấn Liên kết lại hoặc kiểm tra ổ đĩa.');
      return;
    }
    const context = {
      contextId: `library-${ui.libraryTab}-${sortMode}-${statusFilter}`,
      label: ui.libraryTab === 'favorites' ? 'Bài hát yêu thích' : 'Thư viện nhạc',
      kind: 'library' as const,
      trackIds: filteredTracks.filter((t) => t.status === 'available').map((t) => t.id),
    };
    const realTrack = library.tracks.find((t) => t.id === track.id);
    if (realTrack) {
      void uiStore.playLocalElectronTrack(realTrack, context);
    }
  };

  const handleRowInteraction = (
    event: MouseEvent<HTMLDivElement>,
    track: PrototypeTrack,
    rowIndex: number,
  ) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      if (!multiSelectMode) {
        setMultiSelectMode(true);
      }
      if (event.shiftKey && lastClickedIndexRef.current !== null) {
        const start = Math.min(lastClickedIndexRef.current, rowIndex);
        const end = Math.max(lastClickedIndexRef.current, rowIndex);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (let i = start; i <= end; i += 1) {
            if (filteredTracks[i]) {
              next.add(filteredTracks[i].id);
            }
          }
          return next;
        });
      } else {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(track.id)) next.delete(track.id);
          else next.add(track.id);
          return next;
        });
        lastClickedIndexRef.current = rowIndex;
      }
      return;
    }

    if (multiSelectMode) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(track.id)) next.delete(track.id);
        else next.add(track.id);
        return next;
      });
      lastClickedIndexRef.current = rowIndex;
      return;
    }

    handlePlayTrack(track);
  };

  const handleConfirmDeleteFromLibrary = async () => {
    if (!pendingDeleteTracks || pendingDeleteTracks.length === 0 || isDeleting) return;
    setIsDeleting(true);
    try {
      const targetIds = pendingDeleteTracks.map((t) => t.id);
      const res = await libraryStore.removeTracks(targetIds, {
        addExclusion: excludeOnDelete,
      });
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of res.removedTrackIds) {
          next.delete(id);
        }
        return next;
      });
      setPendingDeleteTracks(null);
      uiStore.showToast(
        `Đã xóa ${res.removedTrackIds.length} bài khỏi thư viện (file gốc trên ổ đĩa vẫn còn nguyên)`,
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const handleElectronAction = async (action: 'files' | 'folder' | 'rescan') => {
    if (!library.isElectronAvailable) {
      uiStore.showToast(
        'Đang ở chế độ xem trước UI. Mở ứng dụng desktop Electron trên Windows để quét & lưu SQLite thật.',
      );
      return;
    }
    if (action === 'files') {
      await libraryStore.importFiles();
    } else if (action === 'folder') {
      await libraryStore.importFolder();
    } else {
      await libraryStore.rescanLibrary();
    }
  };

  const tabs: Array<{ id: typeof ui.libraryTab; label: string; count: number }> = [
    { id: 'songs', label: 'Bài hát', count: allTracks.length },
    { id: 'albums', label: 'Album', count: allAlbums.length },
    { id: 'artists', label: 'Nghệ sĩ', count: artists.length },
    { id: 'folders', label: 'Thư mục', count: library.roots.length || allTracks.length },
    { id: 'playlists', label: 'Playlist', count: ui.playlists.length },
    {
      id: 'favorites',
      label: 'Yêu thích',
      count: allTracks.filter((t) => ui.favoriteIds.includes(t.id)).length,
    },
  ];

  const isTrackTableTab = ui.libraryTab === 'songs' || ui.libraryTab === 'favorites';

  return (
    <div ref={pageRootRef} className="mx-auto w-full max-w-[1360px] space-y-5 pb-36">
      {/* Header + Local Import Toolbar */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.16em] text-[var(--text-muted)] uppercase">
            Thư viện âm nhạc cục bộ
          </p>
          <h1 className="font-display mt-1 text-[30px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
            Thư viện nhạc
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="library-import-files-btn"
            onClick={() => void handleElectronAction('files')}
            disabled={library.isScanning}
            className="flex h-10 items-center gap-2 rounded-full bg-[var(--text-primary)] px-4 text-[12.5px] font-semibold text-[var(--bg-deep)] transition hover:opacity-90 disabled:opacity-50"
          >
            <FilePlus2 className="h-4 w-4" />
            Thêm file nhạc
          </button>
          <button
            type="button"
            data-testid="library-import-folder-btn"
            onClick={() => void handleElectronAction('folder')}
            disabled={library.isScanning}
            className="lp-btn-ghost flex h-10 items-center gap-2 rounded-full px-4 text-[12.5px] font-medium text-[var(--text-primary)] disabled:opacity-50"
          >
            <FolderPlus className="h-4 w-4" />
            Thêm thư mục
          </button>
          {library.isScanning ? (
            <button
              type="button"
              data-testid="library-cancel-scan-btn"
              onClick={() => void libraryStore.cancelRescan()}
              className="flex h-10 items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/15 px-4 text-[12.5px] font-semibold text-amber-600 dark:text-amber-200"
            >
              <X className="h-3.5 w-3.5" />
              Hủy quét
            </button>
          ) : (
            <button
              type="button"
              data-testid="library-rescan-btn"
              onClick={() => void handleElectronAction('rescan')}
              className="lp-btn-ghost flex h-10 items-center gap-2 rounded-full px-4 text-[12.5px] font-medium"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Quét lại
            </button>
          )}
          <button
            type="button"
            data-testid="library-manage-sources-btn"
            onClick={() => setSourcesModalTab(issueTracksCount > 0 ? 'missing' : 'folders')}
            className="lp-btn-ghost flex h-10 items-center gap-2 rounded-full px-4 text-[12.5px] font-medium"
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span>Nguồn & File lỗi</span>
            {issueTracksCount > 0 && (
              <span className="font-mono-tabular rounded-full bg-amber-500/20 px-2 py-0.5 text-[10.5px] font-semibold text-amber-600 dark:text-amber-300">
                {issueTracksCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Live Scan Progress / Scan Report Banner */}
      {library.isScanning && library.scanProgress && (
        <div className="lp-glass-panel flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3 text-[12.5px]">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-[var(--text-primary)]">{library.scanProgress.message}</p>
            {library.scanProgress.currentPath && (
              <p className="font-mono-tabular truncate text-[11px] text-[var(--text-muted)]">
                {library.scanProgress.currentPath}
              </p>
            )}
          </div>
          {library.scanProgress.total > 0 && (
            <span className="font-mono-tabular text-[12px] font-semibold text-[var(--text-secondary)]">
              {library.scanProgress.current}/{library.scanProgress.total}
            </span>
          )}
        </div>
      )}

      {!library.isScanning && library.lastSummary && (
        <div
          data-testid="library-scan-summary-banner"
          className="lp-glass-panel flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3 text-[12.5px]"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span>
              {library.lastSummary.canceled ? 'Đã hủy quét:' : 'Kết quả quét:'} thêm{' '}
              <strong>{library.lastSummary.addedCount}</strong> · cập nhật{' '}
              <strong>{library.lastSummary.updatedCount}</strong> · khôi phục{' '}
              <strong>{library.lastSummary.recoveredCount}</strong>
              {library.lastSummary.excludedSkippedCount ? (
                <> · bỏ qua đã loại trừ <strong>{library.lastSummary.excludedSkippedCount}</strong></>
              ) : null}
            </span>
            {issueTracksCount > 0 && (
              <span className="font-medium text-amber-600 dark:text-amber-300">
                · Có {issueTracksCount} bài hát cần xử lý
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {issueTracksCount > 0 && (
              <button
                type="button"
                onClick={() => setSourcesModalTab('missing')}
                className="rounded-full bg-amber-500/20 px-3 py-1 text-[11.5px] font-semibold text-amber-700 dark:text-amber-200"
              >
                Kiểm tra & Liên kết lại
              </button>
            )}
            <button
              type="button"
              onClick={() => libraryStore.dismissSummary()}
              aria-label="Đóng báo cáo quét"
              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Tabs + Search / Sort / Filter Controls */}
      <div className="lp-glass-panel flex flex-wrap items-center justify-between gap-4 rounded-[22px] px-4 py-3">
        <div className="flex flex-wrap items-center gap-1">
          {tabs.map((tab) => {
            const active = ui.libraryTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                data-testid={`library-tab-${tab.id}`}
                onClick={() => uiStore.openLibraryTab(tab.id)}
                className={`flex items-center gap-2 rounded-full px-3.5 py-2 text-[13px] font-medium transition ${
                  active
                    ? 'bg-[var(--surface-hover)] text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--surface-glass-light)] hover:text-[var(--text-primary)]'
                }`}
              >
                <span>{tab.label}</span>
                <span className="font-mono-tabular text-[11px] opacity-70">{tab.count}</span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Lọc nhanh (Việt, CJK, FLAC)..."
              className="lp-surface-input h-9 w-[210px] rounded-full pr-3.5 pl-9 text-[12.5px] focus:outline-none"
            />
          </div>

          {isTrackTableTab && (
            <>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                aria-label="Lọc trạng thái file"
                className="lp-surface-input h-9 rounded-full px-3 text-[12px] focus:outline-none"
              >
                <option value="all">Tất cả trạng thái</option>
                <option value="available">Sẵn sàng phát</option>
                <option value="missing">Tất cả bài lỗi / thiếu</option>
                <option value="source_unavailable">Nguồn không khả dụng</option>
                <option value="access_error">Lỗi truy cập</option>
              </select>

              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                aria-label="Sắp xếp bài hát"
                className="lp-surface-input h-9 rounded-full px-3 text-[12px] focus:outline-none"
              >
                <option value="recent">Mới thêm gần đây</option>
                <option value="title">Tên bài A–Z</option>
                <option value="artist">Nghệ sĩ A–Z</option>
                <option value="album">Theo Album</option>
                <option value="folder">Theo thư mục</option>
                <option value="filename">Theo tên file</option>
                <option value="track_number">Theo Track #</option>
                <option value="duration">Thời lượng dài nhất</option>
              </select>

              {filteredTracks.length > 0 && (
                <button
                  type="button"
                  data-testid="library-multiselect-toggle-btn"
                  onClick={() => {
                    setMultiSelectMode((prev) => {
                      if (prev) {
                        setSelectedIds(new Set());
                        lastClickedIndexRef.current = null;
                      }
                      return !prev;
                    });
                  }}
                  style={
                    multiSelectMode
                      ? { backgroundColor: userAccent.activeHex, color: userAccent.onAccentText }
                      : undefined
                  }
                  className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-semibold transition ${
                    multiSelectMode ? '' : 'lp-btn-ghost'
                  }`}
                >
                  <CheckSquare className="h-3.5 w-3.5" />
                  <span>{multiSelectMode ? 'Thoát chọn' : 'Chọn nhiều'}</span>
                </button>
              )}
            </>
          )}

          <button
            type="button"
            data-testid="library-toolbar-create-playlist-btn"
            title="Tạo danh sách phát mới"
            onClick={() => {
              const hasSelection = multiSelectMode && selectedIds.size > 0;
              setPickerState({
                trackIds: hasSelection ? Array.from(selectedIds) : [],
                title: hasSelection
                  ? 'Tạo playlist mới từ các bài đã chọn'
                  : 'Tạo playlist mới',
                initialMode: 'create',
                allowToggleSelection: hasSelection,
              });
            }}
            className="lp-btn-ghost inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-semibold whitespace-nowrap transition hover:brightness-110"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Tạo playlist</span>
          </button>
        </div>
      </div>

      {/* Multi-Select Batch Action Toolbar */}
      {isTrackTableTab && multiSelectMode && (
        <div
          data-testid="library-batch-toolbar"
          className="lp-glass-panel flex flex-wrap items-center justify-between gap-3 rounded-[20px] border border-[var(--user-accent)]/40 px-4 py-3"
        >
          <div className="flex flex-wrap items-center gap-2.5 text-[12.5px]">
            <span className="font-semibold text-[var(--text-primary)]">
              Đã chọn {selectedIds.size} bài hát
            </span>
            {hiddenSelectedCount > 0 && (
              <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-200">
                ({hiddenSelectedCount} bài đang ẩn bởi bộ lọc)
              </span>
            )}
            <button
              type="button"
              data-testid="library-select-all-filtered-btn"
              onClick={() => setSelectedIds(new Set(filteredTracks.map((t) => t.id)))}
              className="lp-btn-ghost rounded-full px-3 py-1 text-[11.5px] font-medium"
            >
              Chọn tất cả ({filteredTracks.length})
            </button>
            {selectedIds.size > 0 && (
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="lp-btn-ghost rounded-full px-3 py-1 text-[11.5px] font-medium"
              >
                Bỏ chọn
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={selectedIds.size === 0}
              data-testid="library-batch-create-playlist-btn"
              onClick={() =>
                setPickerState({
                  trackIds: Array.from(selectedIds),
                  title: 'Tạo Playlist từ các bài đã chọn',
                  initialMode: 'create',
                })
              }
              className="lp-btn-ghost inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-semibold disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
              Tạo Playlist mới
            </button>
            <button
              type="button"
              disabled={selectedIds.size === 0}
              data-testid="library-batch-add-to-playlist-btn"
              onClick={() =>
                setPickerState({
                  trackIds: Array.from(selectedIds),
                  title: 'Thêm các bài đã chọn vào Playlist',
                  initialMode: 'pick',
                })
              }
              className="lp-btn-ghost inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-semibold disabled:opacity-40"
            >
              <ListPlus className="h-3.5 w-3.5" />
              Thêm vào Playlist
            </button>
            <button
              type="button"
              disabled={selectedIds.size === 0}
              onClick={() => void uiStore.setFavoriteMany(Array.from(selectedIds), true)}
              className="lp-btn-ghost inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium disabled:opacity-40"
            >
              <Heart className="h-3.5 w-3.5" />
              Yêu thích
            </button>
            <button
              type="button"
              disabled={selectedIds.size === 0}
              data-testid="library-batch-remove-btn"
              onClick={() => {
                setExcludeOnDelete(true);
                setPendingDeleteTracks(allTracks.filter((t) => selectedIds.has(t.id)));
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-rose-500/35 bg-rose-500/12 px-3.5 text-[12px] font-semibold text-rose-500 hover:bg-rose-500/20 disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Xóa khỏi thư viện
            </button>
          </div>
        </div>
      )}

      {/* Tab Content: Songs & Favorites */}
      {isTrackTableTab && (
        <div className="lp-glass-panel overflow-hidden rounded-[24px]">
          <div className="grid grid-cols-[44px_minmax(0,1.7fr)_minmax(0,1fr)_175px_72px_144px] items-center gap-4 border-b border-[var(--border-subtle)] px-5 py-3 text-[11px] font-semibold tracking-[0.08em] text-[var(--text-muted)] uppercase">
            <span>{multiSelectMode ? 'Chọn' : '#'}</span>
            <span>Bài hát</span>
            <span className="hidden md:block">Album</span>
            <span className="hidden lg:block">Định dạng</span>
            <span className="text-right">Thời lượng</span>
            <span className="text-right">Thao tác</span>
          </div>

          {filteredTracks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Disc3 className="h-10 w-10 text-[var(--text-muted)]/60" />
              <p className="mt-3 text-[15px] font-medium text-[var(--text-primary)]">
                {allTracks.length === 0
                  ? 'Thư viện nhạc đang trống'
                  : ui.libraryTab === 'favorites'
                    ? 'Chưa có bài hát yêu thích nào'
                    : 'Không tìm thấy bài hát phù hợp'}
              </p>
              <p className="mt-1 text-[12.5px] text-[var(--text-muted)]">
                {allTracks.length === 0
                  ? 'Nhấn "Thêm file nhạc" hoặc "Thêm thư mục" ở góc trên để thêm nhạc từ máy tính.'
                  : 'Thử đổi bộ lọc hoặc xóa từ khóa tìm kiếm hiện tại.'}
              </p>
            </div>
          ) : (
            <div ref={trackListContainerRef} className="divide-y divide-[var(--border-subtle)]">
              {trackWindowSlice.topSpacerPx > 0 && (
                <div aria-hidden="true" style={{ height: `${trackWindowSlice.topSpacerPx}px` }} />
              )}
              {visibleTracks.map((track, localIdx) => {
                const idx = trackWindowSlice.startIndex + localIdx;
                const isCurrent = activeTrackId === track.id;
                const isMissing = track.status !== 'available';
                const isFav = favoriteSet.has(track.id);
                const isSelected = selectedIds.has(track.id);
                const issueBadge = isMissing ? availabilityChipInfo(track) : null;

                return (
                  <div
                    key={track.id}
                    data-testid={`library-track-row-${track.id}`}
                    onClick={(e) => handleRowInteraction(e, track, idx)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        if (multiSelectMode) {
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(track.id)) next.delete(track.id);
                            else next.add(track.id);
                            return next;
                          });
                        } else {
                          handlePlayTrack(track);
                        }
                      }
                    }}
                    className={`group grid h-[62px] cursor-pointer grid-cols-[44px_minmax(0,1.7fr)_minmax(0,1fr)_175px_72px_144px] items-center gap-4 px-5 transition ${
                      isSelected
                        ? 'bg-[var(--surface-hover)] ring-1 ring-inset ring-[var(--user-accent)]/40'
                        : isMissing
                          ? 'bg-amber-500/[0.06] opacity-80 hover:bg-amber-500/[0.12]'
                          : isCurrent
                            ? 'bg-[var(--surface-hover)]'
                            : 'hover:bg-[var(--surface-glass-light)]'
                    }`}
                  >
                    <div className="flex items-center">
                      {multiSelectMode ? (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}}
                          aria-label={`Chọn ${track.title}`}
                          className="h-4 w-4 accent-[var(--user-accent)]"
                        />
                      ) : (
                        <span className="font-mono-tabular text-[12px] text-[var(--text-muted)]">
                          {idx + 1}
                        </span>
                      )}
                    </div>

                    <div className="flex min-w-0 items-center gap-3.5">
                      <div className="relative h-[42px] w-[42px] shrink-0 overflow-hidden rounded-[10px] border border-white/10 bg-[#101218]">
                        <img
                          src={track.coverUrl}
                          alt={track.albumTitle}
                          onError={(e) => {
                            const img = e.currentTarget;
                            if (img.dataset.fallbackApplied !== '1') {
                              img.dataset.fallbackApplied = '1';
                              img.src = DEFAULT_DOREMI_ARTWORK_URL;
                            }
                          }}
                          className="h-full w-full object-cover"
                        />
                        {isMissing && (
                          <span className="absolute inset-0 flex items-center justify-center bg-black/65 text-amber-300">
                            <AlertTriangle className="h-4 w-4" />
                          </span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <p
                          title={track.title}
                          className="truncate text-[13.5px] font-medium"
                          style={{ color: isCurrent ? palette.dominant : 'var(--text-primary)' }}
                        >
                          {track.title}
                        </p>
                        <button
                          type="button"
                          title={track.artist}
                          onClick={(e) => {
                            e.stopPropagation();
                            uiStore.openArtistDetail(track.artist);
                          }}
                          className="max-w-full truncate text-left text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                        >
                          {track.artist}
                        </button>
                      </div>
                    </div>

                    <button
                      type="button"
                      title={track.albumTitle}
                      onClick={(e) => {
                        e.stopPropagation();
                        uiStore.openAlbumDetail(track.albumId);
                      }}
                      className="hidden truncate text-left text-[12.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] md:block"
                    >
                      {track.albumTitle}
                    </button>

                    <div className="hidden items-center gap-1.5 lg:flex">
                      {issueBadge ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void libraryStore.relinkSingleTrackDialog(track.id);
                          }}
                          title={track.availabilityReason ?? 'Nhấn để liên kết lại file'}
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${issueBadge.className}`}
                        >
                          <Link2 className="h-3 w-3" />
                          <span>{issueBadge.label}</span>
                        </button>
                      ) : (
                        <span
                          title={track.formatBadge}
                          className="truncate rounded-full border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-2.5 py-0.5 text-[11px] text-[var(--text-secondary)]"
                        >
                          {track.formatBadge}
                        </span>
                      )}
                    </div>

                    <span className="font-mono-tabular text-right text-[12px] text-[var(--text-muted)]">
                      {formatDurationSeconds(track.durationSec)}
                    </span>

                    {/* Strictly 4 Library actions: Edit Metadata, Favorite, Add to Playlist, Remove from Library (ZERO Queue buttons!) */}
                    <div
                      className="flex items-center justify-end gap-0.5"
                      data-testid={`library-row-actions-${track.id}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() => openMetadataEditor(track)}
                        title="Chỉnh sửa thông tin bài hát"
                        aria-label={`Chỉnh sửa thông tin ${track.title}`}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] opacity-75 transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] group-hover:opacity-100"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>

                      <button
                        type="button"
                        onClick={() => void uiStore.toggleFavorite(track.id)}
                        title={isFav ? 'Bỏ yêu thích' : 'Yêu thích'}
                        aria-label={`Yêu thích ${track.title}`}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                      >
                        <Heart
                          className="h-3.5 w-3.5"
                          style={
                            isFav
                              ? { color: palette.dominant, fill: palette.dominant }
                              : undefined
                          }
                        />
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          setPickerState({
                            trackIds: [track.id],
                            title: `Thêm "${track.title}" vào Playlist`,
                            initialMode: 'pick',
                          })
                        }
                        title="Thêm vào Playlist"
                        aria-label={`Thêm ${track.title} vào Playlist`}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                      >
                        <ListPlus className="h-3.5 w-3.5" />
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setExcludeOnDelete(true);
                          setPendingDeleteTracks([track]);
                        }}
                        title="Xóa khỏi thư viện (giữ file gốc)"
                        aria-label={`Xóa ${track.title} khỏi thư viện`}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-rose-500/15 hover:text-rose-500"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
              {trackWindowSlice.bottomSpacerPx > 0 && (
                <div aria-hidden="true" style={{ height: `${trackWindowSlice.bottomSpacerPx}px` }} />
              )}
            </div>
          )}
        </div>
      )}

      {ui.libraryTab === 'albums' && (
        <div className="space-y-8">
          <AlbumCoverflow albums={filteredAlbums} />

          {filteredAlbums.length > 0 && (
            <div className="grid grid-cols-2 gap-5 md:grid-cols-3 lg:grid-cols-4">
              {filteredAlbums.map((album) => (
                <div
                  key={album.id}
                  onClick={() => uiStore.openAlbumDetail(album.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      uiStore.openAlbumDetail(album.id);
                    }
                  }}
                  className="lp-glass-panel group cursor-pointer rounded-[22px] p-4 transition duration-200 hover:-translate-y-0.5"
                >
                  <div className="relative aspect-square w-full overflow-hidden rounded-[16px] border border-[var(--border-subtle)]">
                    <img
                      src={album.coverUrl}
                      alt={album.title}
                      className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                    />
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        uiStore.playAlbum(album.id);
                      }}
                      aria-label={`Phát album ${album.title}`}
                      className="absolute right-3 bottom-3 flex h-10 w-10 translate-y-1 items-center justify-center rounded-full bg-white text-[#090A0D] opacity-0 shadow-xl transition group-hover:translate-y-0 group-hover:opacity-100"
                    >
                      <Play className="ml-0.5 h-4 w-4 fill-current" />
                    </button>
                  </div>
                  <p
                    title={album.title}
                    className="mt-3.5 truncate text-[15px] font-semibold text-[var(--text-primary)]"
                  >
                    {album.title}
                  </p>
                  <p
                    title={album.artist}
                    className="mt-0.5 truncate text-[12.5px] text-[var(--text-secondary)]"
                  >
                    {album.artist}
                  </p>
                  <p
                    title={album.formatLabel}
                    className="mt-1.5 truncate text-[11px] text-[var(--text-muted)]"
                  >
                    {album.year ? `${album.year} · ` : ''}
                    {album.trackCount ?? 0} bài · {album.formatLabel}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {ui.libraryTab === 'artists' && (
        artists.length === 0 ? (
          <div className="lp-glass-panel rounded-[24px] py-16 text-center text-[14px] text-[var(--text-muted)]">
            Chưa có nghệ sĩ nào trong thư viện.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-5 md:grid-cols-3 lg:grid-cols-4">
            {artists.map((artist) => (
              <button
                key={artist.name}
                type="button"
                onClick={() => uiStore.openArtistDetail(artist.name)}
                className="lp-glass-panel group flex flex-col items-center rounded-[24px] p-6 text-center transition hover:-translate-y-0.5"
              >
                <div className="h-32 w-32 overflow-hidden rounded-full border border-[var(--border-glass)] shadow-xl">
                  <img
                    src={artist.coverUrl}
                    alt={artist.name}
                    className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                  />
                </div>
                <p className="mt-4 text-[15px] font-semibold text-[var(--text-primary)]">
                  {artist.name}
                </p>
                <p className="mt-1 text-[12px] text-[var(--text-muted)]">
                  {artist.albumCount} album · {artist.trackCount} bài trong thư viện
                </p>
              </button>
            ))}
          </div>
        )
      )}

      {ui.libraryTab === 'folders' && (
        <LibraryFoldersTab
          query={query}
          activeTrackId={activeTrackId}
          onEditMetadata={openMetadataEditor}
          onAddTracksToPlaylist={(trackIds, title) =>
            setPickerState({ trackIds: [...trackIds], title, initialMode: 'pick' })
          }
          onCreatePlaylistWithTracks={(trackIds, title) =>
            setPickerState({ trackIds: [...trackIds], title, initialMode: 'create' })
          }
          onRequestRemoveTracks={(tracks) => {
            setExcludeOnDelete(true);
            setPendingDeleteTracks([...tracks]);
          }}
        />
      )}

      {ui.libraryTab === 'playlists' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-[13px] text-[var(--text-secondary)]">
              Playlist được lưu trực tiếp trên máy tính của bạn — hoạt động hoàn toàn offline.
            </p>
            <button
              type="button"
              data-testid="library-new-playlist-btn"
              onClick={() => setShowPlaylistCreator(!showPlaylistCreator)}
              className="flex h-9 items-center gap-1.5 rounded-full bg-[var(--text-primary)] px-4 text-[12.5px] font-semibold text-[var(--bg-deep)]"
            >
              <Plus className="h-4 w-4" />
              Tạo Playlist mới
            </button>
          </div>

          {showPlaylistCreator && (
            <div className="lp-glass-panel flex flex-wrap items-center gap-3 rounded-[20px] p-4">
              <input
                type="text"
                data-testid="library-create-playlist-input"
                value={newPlaylistName}
                onChange={(e) => setNewPlaylistName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newPlaylistName.trim()) {
                    void uiStore.createPlaylist(newPlaylistName, '', []);
                    setNewPlaylistName('');
                    setShowPlaylistCreator(false);
                  }
                }}
                placeholder="Nhập tên playlist mới (mặc định 0 bài hát)..."
                className="lp-surface-input h-10 min-w-[240px] flex-1 rounded-full px-4 text-[13px] focus:outline-none"
              />
              <button
                type="button"
                disabled={!newPlaylistName.trim()}
                data-testid="library-create-playlist-save-btn"
                onClick={() => {
                  void uiStore.createPlaylist(newPlaylistName, '', []);
                  setNewPlaylistName('');
                  setShowPlaylistCreator(false);
                }}
                className="h-10 rounded-full bg-[var(--text-primary)] px-5 text-[12.5px] font-semibold text-[var(--bg-deep)] disabled:opacity-45"
              >
                Lưu playlist
              </button>
            </div>
          )}

          {ui.playlists.length === 0 ? (
            <div className="lp-glass-panel flex flex-col items-center justify-center rounded-[24px] py-16 text-center">
              <Disc3 className="h-10 w-10 text-[var(--text-muted)]/60" />
              <p className="mt-3 text-[15px] font-medium text-[var(--text-primary)]">
                Chưa có playlist nào
              </p>
              <p className="mt-1 text-[12.5px] text-[var(--text-muted)]">
                Nhấn &ldquo;Tạo Playlist mới&rdquo; để bắt đầu sắp xếp bộ sưu tập theo tâm trạng hoặc album.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {ui.playlists.map((playlist) => {
                const { primaryCover } = uiStore.getPlaylistCovers(playlist);
                const coverSrc = primaryCover ?? DEFAULT_DOREMI_ARTWORK_URL;
                const isConfirmingDel = confirmDeletePlaylistId === playlist.id;
                return (
                  <div
                    key={playlist.id}
                    data-testid={`library-playlist-card-${playlist.id}`}
                    onClick={() => uiStore.openPlaylistDetail(playlist.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        uiStore.openPlaylistDetail(playlist.id);
                      }
                    }}
                    className="lp-glass-panel flex cursor-pointer flex-col justify-between rounded-[22px] p-5 transition hover:-translate-y-0.5"
                  >
                    <div className="flex items-center gap-4">
                      <img
                        src={coverSrc}
                        alt={playlist.name}
                        className="h-16 w-16 rounded-2xl border border-[var(--border-subtle)] object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-[16px] font-semibold text-[var(--text-primary)]">
                          {playlist.name}
                        </h3>
                        <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                          {playlist.trackIds.length} bài hát
                        </p>
                      </div>
                    </div>
                    {playlist.description && (
                      <p className="mt-3 line-clamp-2 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                        {playlist.description}
                      </p>
                    )}
                    <div
                      className="mt-4 flex flex-wrap items-center justify-between gap-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        disabled={playlist.trackIds.length === 0}
                        onClick={() => uiStore.playPlaylist(playlist.id)}
                        className="flex h-9 items-center gap-1.5 rounded-full bg-[var(--text-primary)] px-4 text-[12px] font-semibold text-[var(--bg-deep)] disabled:opacity-45"
                      >
                        <Play className="h-3.5 w-3.5 fill-current" />
                        Phát ngay
                      </button>

                      {isConfirmingDel ? (
                        <div className="flex items-center gap-1.5 text-[11.5px]">
                          <button
                            type="button"
                            onClick={() => {
                              void uiStore.deletePlaylist(playlist.id);
                              setConfirmDeletePlaylistId(null);
                            }}
                            className="rounded-full bg-rose-600 px-3 py-1 font-semibold text-white"
                          >
                            Xác nhận xóa
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeletePlaylistId(null)}
                            className="lp-btn-ghost rounded-full px-2.5 py-1"
                          >
                            Hủy
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeletePlaylistId(playlist.id)}
                          aria-label={`Xóa playlist ${playlist.name}`}
                          className="lp-btn-ghost flex h-8 w-8 items-center justify-center rounded-full text-rose-500 hover:bg-rose-500/15"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {!library.isElectronAvailable && (
        <div className="lp-glass-subtle flex items-center gap-2.5 rounded-2xl px-4 py-3 text-[12px] text-[var(--text-muted)]">
          <Sparkles className="h-4 w-4 shrink-0" style={{ color: palette.dominant }} />
          <span>
            Chế độ trình duyệt web. Mở ứng dụng desktop Windows Electron để thêm file nhạc trực tiếp từ ổ đĩa và lưu vào SQLite.
          </span>
        </div>
      )}

      {/* Enhanced 4-Group Metadata + Artwork Modal */}
      <TrackMetadataModal
        target={editTarget}
        isSaving={isSavingMeta}
        onClose={() => setEditTargetTrackId(null)}
        onSave={handleSaveMetadata}
        onRestoreOriginal={handleRestoreMetadata}
        onImportCustomArtwork={async (id) => {
          const res = await libraryStore.importCustomArtwork(id);
          if (!res.canceled && res.error) {
            uiStore.showToast(res.error);
          } else if (!res.canceled) {
            uiStore.showToast('Đã cập nhật ảnh bìa bài hát');
          }
        }}
        onRemoveCustomArtwork={async (id) => {
          const res = await libraryStore.removeCustomArtwork(id);
          if (res.error) {
            uiStore.showToast(res.error);
          } else {
            uiStore.showToast('Đã khôi phục ảnh bìa gốc');
          }
        }}
      />

      {/* Shared Add-to-Playlist / Create-from-Selection Modal */}
      {pickerState && (
        <PlaylistPickerModal
          trackIds={pickerState.trackIds}
          title={pickerState.title}
          initialMode={pickerState.initialMode}
          allowToggleSelection={pickerState.allowToggleSelection}
          onClose={() => setPickerState(null)}
          onCompleted={(info) => {
            if (multiSelectMode && (info?.includedTrackCount ?? 0) > 0) {
              setMultiSelectMode(false);
              setSelectedIds(new Set());
              lastClickedIndexRef.current = null;
            }
          }}
        />
      )}

      {/* Remove from Library Confirmation Dialog */}
      {pendingDeleteTracks && pendingDeleteTracks.length > 0 && (
        <OverlayPortal layer="modal">
          <div className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Xác nhận xóa khỏi Thư viện"
            data-testid="remove-from-library-dialog"
            className="lp-glass-pill w-full max-w-[460px] rounded-[24px] p-6"
          >
            <h2 className="font-display text-[18px] font-semibold text-[var(--text-primary)]">
              Xóa {pendingDeleteTracks.length} bài hát khỏi Thư viện?
            </h2>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
              File nhạc gốc trên máy tính vẫn được giữ nguyên. Bài hát sẽ được gỡ khỏi Thư viện và các Playlist liên quan trong DoReMi (thống kê lịch sử nghe vẫn được giữ).
            </p>

            <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-3 text-[12px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={excludeOnDelete}
                onChange={(e) => setExcludeOnDelete(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--user-accent)]"
              />
              <span>
                Không tự động thêm lại khi Quét lại thư mục (ghi vào danh sách loại trừ)
              </span>
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={isDeleting}
                onClick={() => setPendingDeleteTracks(null)}
                className="lp-btn-ghost rounded-full px-4 py-2 text-[12.5px] font-medium"
              >
                Hủy
              </button>
              <button
                type="button"
                disabled={isDeleting}
                data-testid="confirm-remove-from-library-btn"
                onClick={() => void handleConfirmDeleteFromLibrary()}
                className="rounded-full bg-rose-600 px-5 py-2 text-[12.5px] font-semibold text-white transition hover:bg-rose-500 disabled:opacity-50"
              >
                {isDeleting ? 'Đang xóa...' : 'Xóa khỏi thư viện'}
              </button>
            </div>
          </div>
        </div>
        </OverlayPortal>
      )}

      {/* Library Sources, Missing Files & Exclusions Management Modal */}
      {sourcesModalTab && (
        <LibrarySourcesAndMissingModal
          initialTab={sourcesModalTab}
          onClose={() => setSourcesModalTab(null)}
        />
      )}

      {/* Floating Back to Top Button (Phase 5.2.1A) */}
      <LibraryBackToTopButton
        anchorRef={pageRootRef}
        accentHex={userAccent.activeHex}
        onAccentText={userAccent.onAccentText}
        reducedMotion={Boolean(ui.preferences.reducedMotion)}
        contentKey={`${ui.libraryTab}:${filteredTracks.length}:${query}`}
      />
    </div>
  );
}
