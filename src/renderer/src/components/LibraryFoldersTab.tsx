import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Copy,
  Disc3,
  ExternalLink,
  Folder,
  FolderOpen,
  Heart,
  ListPlus,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import {
  buildFolderBreadcrumbs,
  buildFolderHierarchy,
  compareTracksByFileName,
  compareTracksByTrackNumber,
  isTrackInsideFolder,
  type LibraryFolderSummaryItem,
} from '../../../shared/utils/folder-tree';
import { naturalCompare } from '../../../shared/utils/natural-sort';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import type { PrototypeTrack } from '../data/prototype-catalog';
import { libraryStore, useLibraryState } from '../stores/library-store';
import { uiStore, useUiState } from '../stores/ui-store';
import { formatDurationSeconds } from '../utils/formatters';
import { matchesVietnameseQuery } from '../utils/vietnamese-search';

type FolderSortMode = 'track_number' | 'filename' | 'title';

export interface LibraryFoldersTabProps {
  query: string;
  activeTrackId: string;
  onEditMetadata: (track: PrototypeTrack) => void;
  onAddTracksToPlaylist: (trackIds: readonly string[], title?: string) => void;
  onCreatePlaylistWithTracks: (trackIds: readonly string[], title?: string) => void;
  onRequestRemoveTracks: (tracks: readonly PrototypeTrack[]) => void;
  onOpenRelinkForTrack?: () => void;
}

export function LibraryFoldersTab({
  query,
  activeTrackId,
  onEditMetadata,
  onAddTracksToPlaylist,
  onCreatePlaylistWithTracks,
  onRequestRemoveTracks,
}: LibraryFoldersTabProps) {
  const ui = useUiState();
  const library = useLibraryState();
  const palette = uiStore.getCurrentPalette();

  const [currentFolderKey, setCurrentFolderKey] = useState<string | null>(null);
  const [includeSubfolders, setIncludeSubfolders] = useState(false);
  const [folderSort, setFolderSort] = useState<FolderSortMode>('track_number');

  const allTracks = uiStore.getUnifiedTracks();

  const { foldersByKey, topLevelKeys } = useMemo(() => {
    const sortable = allTracks.map((t) => ({
      id: t.id,
      original_path: t.filePathDisplay,
      title: t.title,
      artist: t.artist,
      albumTitle: t.albumTitle,
      trackNumber: t.trackNumber,
      discNumber: t.discNumber,
      file_name: t.fileName,
      status: t.status,
      availability_state: t.availabilityState,
    }));
    return buildFolderHierarchy(sortable, library.roots);
  }, [allTracks, library.roots]);

  const currentNode: LibraryFolderSummaryItem | null = currentFolderKey
    ? foldersByKey.get(currentFolderKey) ?? null
    : null;

  const breadcrumbs = useMemo(
    () => buildFolderBreadcrumbs(currentNode?.folderKey ?? null, foldersByKey),
    [currentNode?.folderKey, foldersByKey],
  );

  const visibleFolders = useMemo(() => {
    const keys = currentNode ? currentNode.childFolderKeys : topLevelKeys;
    return keys
      .map((k) => foldersByKey.get(k))
      .filter((f): f is LibraryFolderSummaryItem => Boolean(f))
      .filter(
        (f) =>
          !query.trim() ||
          matchesVietnameseQuery(f.folderName, query) ||
          matchesVietnameseQuery(f.folderPath, query),
      );
  }, [currentNode, topLevelKeys, foldersByKey, query]);

  const tracksInCurrentScope = useMemo(() => {
    if (!currentNode) {
      return [];
    }
    const matching = allTracks.filter((t) =>
      isTrackInsideFolder(t.filePathDisplay, currentNode.folderKey, includeSubfolders),
    );
    const searched = !query.trim()
      ? matching
      : matching.filter(
          (t) =>
            matchesVietnameseQuery(t.title, query) ||
            matchesVietnameseQuery(t.artist, query) ||
            matchesVietnameseQuery(t.albumTitle, query) ||
            matchesVietnameseQuery(t.fileName ?? '', query),
        );

    return [...searched].sort((a, b) => {
      if (folderSort === 'filename') {
        return compareTracksByFileName(
          { id: a.id, original_path: a.filePathDisplay, title: a.title, artist: a.artist, file_name: a.fileName, status: a.status },
          { id: b.id, original_path: b.filePathDisplay, title: b.title, artist: b.artist, file_name: b.fileName, status: b.status },
        );
      }
      if (folderSort === 'title') {
        return naturalCompare(a.title, b.title);
      }
      return compareTracksByTrackNumber(
        { id: a.id, original_path: a.filePathDisplay, title: a.title, artist: a.artist, trackNumber: a.trackNumber, discNumber: a.discNumber, file_name: a.fileName, status: a.status },
        { id: b.id, original_path: b.filePathDisplay, title: b.title, artist: b.artist, trackNumber: b.trackNumber, discNumber: b.discNumber, file_name: b.fileName, status: b.status },
      );
    });
  }, [currentNode, allTracks, includeSubfolders, query, folderSort]);

  const getFolderTrackIds = (folderKey: string, recursive: boolean): string[] => {
    return allTracks
      .filter((t) => isTrackInsideFolder(t.filePathDisplay, folderKey, recursive))
      .sort((a, b) =>
        compareTracksByTrackNumber(
          { id: a.id, original_path: a.filePathDisplay, title: a.title, artist: a.artist, trackNumber: a.trackNumber, discNumber: a.discNumber, status: a.status },
          { id: b.id, original_path: b.filePathDisplay, title: b.title, artist: b.artist, trackNumber: b.trackNumber, discNumber: b.discNumber, status: b.status },
        ),
      )
      .map((t) => t.id);
  };

  const playFolder = (node: LibraryFolderSummaryItem, recursive: boolean, startTrackId?: string) => {
    const playableIds = allTracks
      .filter(
        (t) =>
          t.status === 'available' &&
          isTrackInsideFolder(t.filePathDisplay, node.folderKey, recursive),
      )
      .sort((a, b) =>
        compareTracksByTrackNumber(
          { id: a.id, original_path: a.filePathDisplay, title: a.title, artist: a.artist, trackNumber: a.trackNumber, discNumber: a.discNumber, status: a.status },
          { id: b.id, original_path: b.filePathDisplay, title: b.title, artist: b.artist, trackNumber: b.trackNumber, discNumber: b.discNumber, status: b.status },
        ),
      )
      .map((t) => t.id);

    if (playableIds.length === 0) {
      uiStore.showToast('Không có bài hát khả dụng trong thư mục này.');
      return;
    }

    uiStore.playFromContext(
      {
        contextId: `folder-${node.folderKey}-${recursive ? 'rec' : 'direct'}`,
        label: `Thư mục: ${node.folderName}`,
        kind: 'folder',
        trackIds: playableIds,
      },
      startTrackId,
    );
  };

  const copyPath = (text: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
      uiStore.showToast('Đã sao chép đường dẫn thư mục');
    }
  };

  if (allTracks.length === 0 && library.roots.length === 0) {
    return (
      <div className="lp-glass-panel flex flex-col items-center justify-center rounded-[24px] py-16 text-center">
        <FolderOpen className="h-10 w-10 text-[var(--text-muted)]/60" />
        <p className="mt-3 text-[15px] font-medium text-[var(--text-primary)]">
          Chưa có thư mục nhạc nào trong thư viện
        </p>
        <p className="mt-1 text-[13px] text-[var(--text-muted)]">
          Chọn &ldquo;Thêm thư mục&rdquo; để giữ nguyên cấu trúc phân tầng từ ổ cứng.
        </p>
      </div>
    );
  }

  return (
    <div data-testid="library-folders-view" className="space-y-4">
      {/* Breadcrumb + Scope Toolbar */}
      <div className="lp-glass-panel flex flex-wrap items-center justify-between gap-3 rounded-[22px] px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
          {currentNode && (
            <button
              type="button"
              onClick={() => setCurrentFolderKey(currentNode.parentFolderKey)}
              className="lp-btn-ghost mr-1 inline-flex h-8 items-center gap-1 rounded-full px-3 text-[12px] font-medium"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Lên
            </button>
          )}
          <button
            type="button"
            onClick={() => setCurrentFolderKey(null)}
            className={`rounded-full px-2.5 py-1 transition ${
              !currentNode
                ? 'bg-[var(--surface-hover)] font-semibold text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
          >
            Thư mục gốc
          </button>
          {breadcrumbs.map((crumb) => {
            const active = crumb.folderKey === currentNode?.folderKey;
            return (
              <div key={crumb.folderKey} className="flex items-center gap-1">
                <ChevronRight className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                <button
                  type="button"
                  onClick={() => setCurrentFolderKey(crumb.folderKey)}
                  title={crumb.folderPath}
                  className={`max-w-[200px] truncate rounded-full px-2.5 py-1 transition ${
                    active
                      ? 'bg-[var(--surface-hover)] font-semibold text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {crumb.label}
                </button>
              </div>
            );
          })}
        </div>

        {currentNode && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={includeSubfolders}
                onChange={(e) => setIncludeSubfolders(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--user-accent)]"
              />
              <span>Bao gồm thư mục con</span>
            </label>

            <select
              value={folderSort}
              onChange={(e) => setFolderSort(e.target.value as FolderSortMode)}
              aria-label="Sắp xếp trong thư mục"
              className="lp-surface-input h-8 rounded-full px-3 text-[11.5px] outline-none"
            >
              <option value="track_number">Theo Track # (Tự nhiên)</option>
              <option value="filename">Theo tên file (Tự nhiên)</option>
              <option value="title">Theo tên bài</option>
            </select>

            <button
              type="button"
              onClick={() => playFolder(currentNode, includeSubfolders)}
              className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--text-primary)] px-3.5 text-[12px] font-semibold text-[var(--bg-deep)]"
            >
              <Play className="h-3 w-3 fill-current" />
              Phát thư mục
            </button>

            <button
              type="button"
              onClick={() =>
                onCreatePlaylistWithTracks(
                  getFolderTrackIds(currentNode.folderKey, true),
                  `Tạo Playlist từ "${currentNode.folderName}"`,
                )
              }
              className="lp-btn-ghost inline-flex h-8 items-center gap-1 rounded-full px-3 text-[11.5px] font-medium"
            >
              <Plus className="h-3.5 w-3.5" />
              Tạo Playlist
            </button>

            <button
              type="button"
              onClick={() =>
                onAddTracksToPlaylist(
                  getFolderTrackIds(currentNode.folderKey, true),
                  `Thêm từ "${currentNode.folderName}" vào Playlist`,
                )
              }
              className="lp-btn-ghost inline-flex h-8 items-center gap-1 rounded-full px-3 text-[11.5px] font-medium"
            >
              <ListPlus className="h-3.5 w-3.5" />
              Vào Playlist
            </button>

            <button
              type="button"
              onClick={() => copyPath(currentNode.folderPath)}
              title="Sao chép đường dẫn"
              className="lp-btn-ghost flex h-8 w-8 items-center justify-center rounded-full"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Subfolder Cards */}
      {visibleFolders.length > 0 && (
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 lg:grid-cols-3">
          {visibleFolders.map((folder) => {
            const folderAllTrackIds = getFolderTrackIds(folder.folderKey, true);
            const hasIssues = folder.missingCount > 0 || folder.sourceUnavailableCount > 0;
            return (
              <div
                key={folder.folderKey}
                onClick={() => setCurrentFolderKey(folder.folderKey)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setCurrentFolderKey(folder.folderKey);
                  }
                }}
                className="lp-glass-panel group flex cursor-pointer flex-col justify-between rounded-[22px] p-4 transition hover:-translate-y-0.5"
              >
                <div>
                  <div className="flex items-start justify-between gap-2.5">
                    <div className="flex min-w-0 items-center gap-3">
                      <div
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--surface-glass-light)]"
                        style={{ color: palette.dominant }}
                      >
                        <Folder className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <p
                          title={folder.folderName}
                          className="truncate text-[15px] font-semibold text-[var(--text-primary)]"
                        >
                          {folder.folderName}
                        </p>
                        <p
                          className="font-mono-tabular truncate text-[11px] text-[var(--text-muted)]"
                          title={folder.folderPath}
                        >
                          {folder.folderPath}
                        </p>
                      </div>
                    </div>

                    {hasIssues && (
                      <span className="shrink-0 rounded-full border border-amber-500/35 bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-200">
                        {folder.sourceUnavailableCount > 0
                          ? 'Nguồn ẩn'
                          : `${folder.missingCount} thiếu`}
                      </span>
                    )}
                  </div>

                  <p className="mt-2.5 text-[12px] text-[var(--text-secondary)]">
                    {folder.directTrackCount > 0
                      ? `${folder.directTrackCount} bài trực tiếp · `
                      : ''}
                    Tổng {folder.recursiveTrackCount} bài
                    {folder.childFolderKeys.length > 0
                      ? ` · ${folder.childFolderKeys.length} thư mục con`
                      : ''}
                  </p>
                </div>

                <div
                  className="mt-3.5 flex flex-wrap items-center gap-1.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    disabled={folder.availableCount === 0}
                    onClick={() => playFolder(folder, true)}
                    className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--text-primary)] px-3 text-[11.5px] font-semibold text-[var(--bg-deep)] disabled:opacity-40"
                  >
                    <Play className="h-3 w-3 fill-current" />
                    Phát
                  </button>
                  <button
                    type="button"
                    disabled={folderAllTrackIds.length === 0}
                    onClick={() =>
                      onAddTracksToPlaylist(
                        folderAllTrackIds,
                        `Thêm thư mục "${folder.folderName}" vào Playlist`,
                      )
                    }
                    className="lp-btn-ghost inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[11.5px] font-medium disabled:opacity-40"
                  >
                    <ListPlus className="h-3 w-3" />
                    Vào Playlist
                  </button>
                  {folder.rootId && (
                    <button
                      type="button"
                      disabled={library.isScanning}
                      onClick={() => void libraryStore.rescanWatchedFolder(folder.rootId!)}
                      title="Quét lại thư mục nguồn"
                      className="lp-btn-ghost flex h-8 w-8 items-center justify-center rounded-full"
                    >
                      <RefreshCw className="h-3 w-3" />
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={folderAllTrackIds.length === 0}
                    onClick={() => {
                      const set = new Set(folderAllTrackIds);
                      onRequestRemoveTracks(allTracks.filter((t) => set.has(t.id)));
                    }}
                    title="Xóa các bài trong thư mục khỏi Thư viện (giữ file gốc)"
                    className="lp-btn-ghost ml-auto flex h-8 w-8 items-center justify-center rounded-full text-rose-500"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Tracks in Current Folder */}
      {currentNode && tracksInCurrentScope.length > 0 && (
        <div className="lp-glass-panel overflow-hidden rounded-[24px]">
          <div className="divide-y divide-[var(--border-subtle)]">
            {tracksInCurrentScope.map((track, idx) => {
              const isCurrent = activeTrackId === track.id;
              const isMissing = track.status !== 'available';
              const isFav = ui.favoriteIds.includes(track.id);
              return (
                <div
                  key={track.id}
                  onClick={() => {
                    if (!isMissing) playFolder(currentNode, includeSubfolders, track.id);
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === ' ') && !isMissing) {
                      e.preventDefault();
                      playFolder(currentNode, includeSubfolders, track.id);
                    }
                  }}
                  className={`group flex h-[60px] cursor-pointer items-center gap-3.5 px-4 transition ${
                    isMissing
                      ? 'bg-amber-500/[0.05] opacity-75'
                      : isCurrent
                        ? 'bg-[var(--surface-hover)]'
                        : 'hover:bg-[var(--surface-glass-light)]'
                  }`}
                >
                  <span className="font-mono-tabular w-7 text-center text-[12px] text-[var(--text-muted)]">
                    {track.trackNumber || idx + 1}
                  </span>

                  <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-black/20">
                    <img
                      src={track.coverUrl || DEFAULT_DOREMI_ARTWORK_URL}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                    {isMissing && (
                      <span className="absolute inset-0 flex items-center justify-center bg-black/65 text-amber-300">
                        <AlertTriangle className="h-4 w-4" />
                      </span>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p
                      title={track.title}
                      className="truncate text-[13.5px] font-medium"
                      style={{ color: isCurrent ? palette.dominant : 'var(--text-primary)' }}
                    >
                      {track.title}
                    </p>
                    <p
                      title={`${track.fileName || track.artist} · ${track.formatBadge}`}
                      className="truncate text-[11.5px] text-[var(--text-muted)]"
                    >
                      {track.fileName || track.artist} · {track.formatBadge}
                    </p>
                  </div>

                  <span className="font-mono-tabular text-[12px] text-[var(--text-muted)]">
                    {formatDurationSeconds(track.durationSec)}
                  </span>

                  <div
                    className="flex items-center gap-0.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() => onEditMetadata(track)}
                      title="Sửa thông tin"
                      className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void uiStore.toggleFavorite(track.id)}
                      title={isFav ? 'Bỏ yêu thích' : 'Yêu thích'}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"
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
                      onClick={() => onAddTracksToPlaylist([track.id])}
                      title="Thêm vào Playlist"
                      className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                    >
                      <ListPlus className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void libraryStore.showTrackInFolder(track.id)}
                      title="Mở trong File Explorer"
                      className="hidden h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] sm:flex"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRequestRemoveTracks([track])}
                      title="Xóa khỏi Thư viện"
                      className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-rose-500/15 hover:text-rose-500"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {currentNode && visibleFolders.length === 0 && tracksInCurrentScope.length === 0 && (
        <div className="lp-glass-panel rounded-[24px] py-12 text-center text-[13.5px] text-[var(--text-muted)]">
          Không có bài hát hay thư mục con phù hợp trong &ldquo;{currentNode.folderName}&rdquo;.
        </div>
      )}

      {!currentNode && visibleFolders.length === 0 && (
        <div className="lp-glass-panel rounded-[24px] py-12 text-center text-[13.5px] text-[var(--text-muted)]">
          <Disc3 className="mx-auto mb-2 h-8 w-8 opacity-50" />
          Không tìm thấy thư mục nào khớp với từ khóa &ldquo;{query}&rdquo;.
        </div>
      )}
    </div>
  );
}
