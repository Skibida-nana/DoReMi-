import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Disc3,
  GripVertical,
  ImagePlus,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Shuffle,
  Trash2,
  X,
} from 'lucide-react';
import { libraryStore } from '../stores/library-store';
import { uiStore, useUiState } from '../stores/ui-store';
import { formatDurationSeconds } from '../utils/formatters';
import { naturalCompare } from '../../../shared/utils/natural-sort';
import { matchesVietnameseQuery } from '../utils/vietnamese-search';

type PlaylistViewSort = 'custom' | 'title' | 'artist' | 'album' | 'duration';

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Không thể đọc ảnh.'));
    reader.readAsDataURL(file);
  });
}

export function PlaylistDetailPage() {
  const ui = useUiState();
  const userAccent = uiStore.getUserAccentPalette();
  const playlist = ui.selectedPlaylistId
    ? ui.playlists.find((p) => p.id === ui.selectedPlaylistId) ?? null
    : null;

  const [isEditing, setIsEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(playlist?.name ?? '');
  const [descDraft, setDescDraft] = useState(playlist?.description ?? '');
  const [showAddTracks, setShowAddTracks] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [addAlbumFilter, setAddAlbumFilter] = useState('all');
  const [allowDuplicateAdd, setAllowDuplicateAdd] = useState(false);
  const [selectedAddIds, setSelectedAddIds] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [viewSort, setViewSort] = useState<PlaylistViewSort>('custom');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (playlist) {
      setNameDraft(playlist.name);
      setDescDraft(playlist.description);
    }
    setConfirmDelete(false);
    setSelectedEntryIds(new Set());
    setSelectedAddIds(new Set());
  }, [playlist?.id]);

  if (!playlist) {
    return (
      <div data-testid="playlist-missing-page" className="mx-auto max-w-2xl py-20 text-center">
        <p className="text-[15px] text-[var(--text-secondary)]">
          Playlist này không còn tồn tại hoặc đã được xóa.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2.5">
          <button
            type="button"
            onClick={() => uiStore.openLibraryTab('playlists')}
            className="lp-btn-ghost rounded-full px-5 py-2 text-[13px] font-medium"
          >
            Xem danh sách Playlist
          </button>
          <button
            type="button"
            onClick={() => uiStore.navigate('home')}
            className="lp-btn-ghost rounded-full px-5 py-2 text-[13px] font-medium"
          >
            Quay lại Trang chủ
          </button>
        </div>
      </div>
    );
  }

  const allTracks = uiStore.getUnifiedTracks();
  const trackMap = new Map(allTracks.map((t) => [t.id, t]));

  const canonicalItems = (
    playlist.entries && playlist.entries.length > 0
      ? playlist.entries.map((e, i) => ({
          entryId: e.entryId,
          trackId: e.trackId,
          position: i,
          track: trackMap.get(e.trackId) ?? null,
        }))
      : playlist.trackIds.map((trackId, i) => ({
          entryId: `legacy-${i}-${trackId}`,
          trackId,
          position: i,
          track: trackMap.get(trackId) ?? null,
        }))
  ).filter((item): item is typeof item & { track: NonNullable<typeof item.track> } =>
    Boolean(item.track),
  );

  const displayedItems =
    viewSort === 'custom'
      ? canonicalItems
      : [...canonicalItems].sort((a, b) => {
          if (viewSort === 'title') {
            return naturalCompare(a.track.title, b.track.title);
          }
          if (viewSort === 'artist') {
            return naturalCompare(a.track.artist, b.track.artist);
          }
          if (viewSort === 'album') {
            return naturalCompare(a.track.albumTitle, b.track.albumTitle);
          }
          return b.track.durationSec - a.track.durationSec;
        });

  const existingIdSet = new Set(playlist.trackIds);
  const albumOptions = Array.from(new Set(allTracks.map((t) => t.albumTitle))).sort(naturalCompare);
  const addableTracks = allTracks.filter((t) => {
    if (!allowDuplicateAdd && existingIdSet.has(t.id)) {
      return false;
    }
    if (addAlbumFilter !== 'all' && t.albumTitle !== addAlbumFilter) {
      return false;
    }
    if (!addSearch.trim()) {
      return true;
    }
    return (
      matchesVietnameseQuery(t.title, addSearch) ||
      matchesVietnameseQuery(t.artist, addSearch) ||
      matchesVietnameseQuery(t.albumTitle, addSearch)
    );
  });

  const totalSec = canonicalItems.reduce((sum, item) => sum + item.track.durationSec, 0);
  const { primaryCover, collageCovers } = uiStore.getPlaylistCovers(playlist);

  const handlePlayTrack = (trackId: string, status: string) => {
    if (status !== 'available') {
      uiStore.showToast('Bài hát này hiện đang thiếu file gốc hoặc nguồn không khả dụng.');
      return;
    }
    const context = {
      contextId: `playlist-${playlist.id}`,
      label: playlist.name,
      kind: 'playlist' as const,
      trackIds: canonicalItems
        .filter((item) => item.track.status === 'available')
        .map((item) => item.track.id),
    };
    const localRecord = libraryStore.getSnapshot().tracks.find((r) => r.id === trackId);
    if (localRecord) {
      void uiStore.playLocalElectronTrack(localRecord, context);
    }
  };

  const handleCoverClick = () => {
    if (typeof window !== 'undefined' && window.losslessApi?.importPlaylistArtwork) {
      void uiStore.importPlaylistCustomCover(playlist.id);
      return;
    }
    coverInputRef.current?.click();
  };

  const handleCoverSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      uiStore.showToast('Ảnh bìa playlist chỉ hỗ trợ JPG, PNG hoặc WEBP.');
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      uiStore.setPlaylistCustomCover(playlist.id, dataUrl);
    } catch {
      uiStore.showToast('Không thể đọc file ảnh đã chọn.');
    }
  };

  const handleConfirmAddSelected = async () => {
    const ids = Array.from(selectedAddIds);
    if (ids.length === 0) return;
    await uiStore.addTracksToPlaylist(playlist.id, ids, { allowDuplicates: allowDuplicateAdd });
    setSelectedAddIds(new Set());
  };

  const moveEntry = (fromIndex: number, toIndex: number) => {
    if (
      viewSort !== 'custom' ||
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= canonicalItems.length ||
      toIndex >= canonicalItems.length
    ) {
      return;
    }
    const ordered = canonicalItems.map((c) => c.entryId);
    const [moved] = ordered.splice(fromIndex, 1);
    ordered.splice(toIndex, 0, moved);
    void uiStore.reorderPlaylistEntries(playlist.id, ordered);
  };

  const handleBatchRemoveEntries = async () => {
    const ids = Array.from(selectedEntryIds);
    if (ids.length === 0) return;
    await uiStore.removeEntriesFromPlaylist(playlist.id, ids);
    setSelectedEntryIds(new Set());
    setSelectMode(false);
  };

  return (
    <div
      data-testid="playlist-detail-page"
      className="mx-auto max-w-[1160px] space-y-6 pb-36 pt-2"
    >
      <input
        ref={coverInputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
        onChange={handleCoverSelected}
        className="hidden"
      />

      <button
        type="button"
        onClick={() =>
          ui.previousRoute === 'library'
            ? uiStore.openLibraryTab('playlists')
            : uiStore.navigate('home')
        }
        className="lp-btn-ghost inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium"
      >
        <ArrowLeft className="h-4 w-4" />
        {ui.previousRoute === 'library' ? 'Quay lại Thư viện Playlist' : 'Quay lại Trang chủ'}
      </button>

      {/* Hero Header */}
      <section className="lp-glass-panel flex flex-col gap-6 rounded-[28px] p-6 sm:flex-row sm:items-end">
        <div className="group relative h-[210px] w-[172px] shrink-0 overflow-hidden rounded-2xl border border-[var(--border-glass)] shadow-2xl">
          {collageCovers.length === 4 && !playlist.coverUrl ? (
            <div className="grid h-full w-full grid-cols-2 grid-rows-2 gap-[1px] bg-black/30">
              {collageCovers.map((url, idx) => (
                <img key={idx} src={url} alt="" className="h-full w-full object-cover" />
              ))}
            </div>
          ) : primaryCover ? (
            <img src={primaryCover} alt={playlist.name} className="h-full w-full object-cover" />
          ) : (
            <div
              style={{ backgroundColor: userAccent.activeHex }}
              className="flex h-full w-full items-center justify-center text-white/85"
            >
              <Disc3 className="h-12 w-12" />
            </div>
          )}

          <div className="absolute inset-x-2 bottom-2 flex flex-col gap-1 opacity-0 transition group-hover:opacity-100">
            <button
              type="button"
              onClick={handleCoverClick}
              className="flex items-center justify-center gap-1.5 rounded-xl bg-black/75 px-2.5 py-1.5 text-[11.5px] font-medium text-white backdrop-blur-md"
            >
              <ImagePlus className="h-3.5 w-3.5" />
              {playlist.coverUrl ? 'Thay ảnh bìa' : 'Đổi ảnh bìa'}
            </button>
            {playlist.coverUrl && (
              <button
                type="button"
                onClick={() => void uiStore.removePlaylistCustomCover(playlist.id)}
                className="flex items-center justify-center gap-1 rounded-xl bg-black/75 px-2 py-1 text-[10.5px] text-amber-300 backdrop-blur-md"
              >
                <RotateCcw className="h-3 w-3" />
                Gỡ ảnh tùy chỉnh
              </button>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--text-muted)]">
            Playlist cục bộ
          </p>

          {isEditing ? (
            <div className="space-y-2.5">
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                className="lp-surface-input w-full max-w-md rounded-xl px-3.5 py-2 font-display text-xl font-bold outline-none"
                placeholder="Tên playlist"
              />
              <input
                type="text"
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                className="lp-surface-input w-full max-w-lg rounded-xl px-3.5 py-1.5 text-[13px] outline-none"
                placeholder="Mô tả ngắn"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void uiStore.renamePlaylist(playlist.id, nameDraft, descDraft);
                    setIsEditing(false);
                  }}
                  style={{
                    backgroundColor: userAccent.activeHex,
                    color: userAccent.onAccentText,
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[12.5px] font-semibold"
                >
                  <Check className="h-3.5 w-3.5" />
                  Lưu thay đổi
                </button>
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className="lp-btn-ghost rounded-full px-3.5 py-1.5 text-[12.5px]"
                >
                  Hủy
                </button>
              </div>
            </div>
          ) : (
            <>
              <h1 className="font-display text-3xl font-bold tracking-tight text-[var(--text-primary)]">
                {playlist.name}
              </h1>
              {playlist.description && (
                <p className="max-w-2xl text-[13.5px] text-[var(--text-secondary)]">
                  {playlist.description}
                </p>
              )}
              <p className="text-[12.5px] text-[var(--text-muted)]">
                {canonicalItems.length} bài hát · {formatDurationSeconds(totalSec)}
              </p>
            </>
          )}

          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={() => uiStore.playPlaylist(playlist.id, false)}
              disabled={canonicalItems.length === 0}
              style={{
                backgroundColor: userAccent.activeHex,
                color: userAccent.onAccentText,
              }}
              className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-[13px] font-semibold shadow-lg transition hover:brightness-110 disabled:opacity-45"
            >
              <Play className="h-4 w-4 fill-current" />
              Phát tất cả
            </button>

            <button
              type="button"
              onClick={() => uiStore.playPlaylist(playlist.id, true)}
              disabled={canonicalItems.length === 0}
              className="lp-btn-ghost inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-[13px] font-medium disabled:opacity-45"
            >
              <Shuffle className="h-4 w-4" />
              Trộn bài
            </button>

            <button
              type="button"
              data-testid="playlist-add-tracks-btn"
              onClick={() => setShowAddTracks((prev) => !prev)}
              className="lp-btn-ghost inline-flex items-center gap-1.5 rounded-full px-4 py-2.5 text-[13px] font-medium"
            >
              <Plus className="h-4 w-4" />
              Thêm bài hát
            </button>

            <button
              type="button"
              onClick={() => {
                setNameDraft(playlist.name);
                setDescDraft(playlist.description);
                setIsEditing(true);
              }}
              className="lp-btn-ghost inline-flex items-center gap-1.5 rounded-full px-3.5 py-2.5 text-[13px] font-medium"
            >
              <Pencil className="h-3.5 w-3.5" />
              Sửa thông tin
            </button>

            {confirmDelete ? (
              <div className="flex items-center gap-1.5 rounded-full border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-[12px]">
                <span className="text-rose-400">Chỉ xóa playlist, giữ file nhạc?</span>
                <button
                  type="button"
                  data-testid="playlist-confirm-delete-btn"
                  onClick={() => void uiStore.deletePlaylist(playlist.id)}
                  className="rounded-full bg-rose-600 px-2.5 py-0.5 font-semibold text-white"
                >
                  Xóa
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-full px-2 py-0.5 text-[var(--text-secondary)]"
                >
                  Hủy
                </button>
              </div>
            ) : (
              <button
                type="button"
                data-testid="playlist-delete-btn"
                onClick={() => setConfirmDelete(true)}
                className="lp-btn-ghost inline-flex items-center gap-1.5 rounded-full px-3.5 py-2.5 text-[13px] font-medium text-rose-400 hover:text-rose-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Xóa playlist
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Rich Multi-Select Add Tracks Drawer */}
      {showAddTracks && (
        <section data-testid="playlist-add-tracks-panel" className="lp-glass-panel space-y-3 rounded-3xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-base font-semibold text-[var(--text-primary)]">
              Thêm bài hát từ Thư viện ({addableTracks.length})
            </h2>
            <div className="flex items-center gap-2">
              {selectedAddIds.size > 0 && (
                <button
                  type="button"
                  onClick={() => void handleConfirmAddSelected()}
                  style={{
                    backgroundColor: userAccent.activeHex,
                    color: userAccent.onAccentText,
                  }}
                  className="rounded-full px-4 py-1.5 text-[12px] font-semibold"
                >
                  Thêm {selectedAddIds.size} bài đã chọn
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowAddTracks(false)}
                className="lp-btn-ghost flex h-8 w-8 items-center justify-center rounded-full"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                type="text"
                value={addSearch}
                onChange={(e) => setAddSearch(e.target.value)}
                placeholder="Tìm tên bài, nghệ sĩ, album..."
                className="lp-surface-input h-9 w-full rounded-full pr-3 pl-8 text-[12.5px] outline-none"
              />
            </div>

            <select
              value={addAlbumFilter}
              onChange={(e) => setAddAlbumFilter(e.target.value)}
              className="lp-surface-input h-9 max-w-[210px] rounded-full px-3 text-[12px] outline-none"
            >
              <option value="all">Tất cả Album</option>
              {albumOptions.map((alb) => (
                <option key={alb} value={alb}>
                  {alb}
                </option>
              ))}
            </select>

            <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={allowDuplicateAdd}
                onChange={(e) => setAllowDuplicateAdd(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--user-accent)]"
              />
              <span>Hiện cả bài đã có</span>
            </label>

            {addableTracks.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (selectedAddIds.size === addableTracks.length) {
                    setSelectedAddIds(new Set());
                  } else {
                    setSelectedAddIds(new Set(addableTracks.map((t) => t.id)));
                  }
                }}
                className="lp-btn-ghost rounded-full px-3 py-1.5 text-[11.5px] font-medium"
              >
                {selectedAddIds.size === addableTracks.length ? 'Bỏ chọn' : 'Chọn tất cả'}
              </button>
            )}
          </div>

          {addableTracks.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-[var(--text-muted)]">
              {allTracks.length === 0
                ? 'Thư viện chưa có bài hát nào. Hãy import nhạc trước.'
                : 'Không có bài hát phù hợp hoặc tất cả đã nằm trong playlist.'}
            </p>
          ) : (
            <div className="grid max-h-[260px] gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2">
              {addableTracks.map((track) => {
                const checked = selectedAddIds.has(track.id);
                return (
                  <div
                    key={track.id}
                    className={`flex items-center justify-between gap-2.5 rounded-xl border px-3 py-2 transition ${
                      checked
                        ? 'border-[var(--user-accent)] bg-[var(--surface-hover)]'
                        : 'border-[var(--border-subtle)] bg-[var(--surface-glass-light)]'
                    }`}
                  >
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setSelectedAddIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(track.id)) next.delete(track.id);
                            else next.add(track.id);
                            return next;
                          });
                        }}
                        className="h-3.5 w-3.5 shrink-0 accent-[var(--user-accent)]"
                      />
                      <img
                        src={track.coverUrl}
                        alt=""
                        className="h-9 w-9 shrink-0 rounded-lg object-cover"
                      />
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                          {track.title}
                        </p>
                        <p className="truncate text-[11.5px] text-[var(--text-muted)]">
                          {track.artist} · {track.albumTitle}
                        </p>
                      </div>
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        void uiStore.addTracksToPlaylist(playlist.id, [track.id], {
                          allowDuplicates: allowDuplicateAdd,
                        })
                      }
                      className="lp-btn-ghost shrink-0 rounded-full px-3 py-1 text-[11.5px] font-semibold"
                    >
                      + Thêm
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Sort & Batch Removal Bar */}
      {canonicalItems.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={viewSort}
              onChange={(e) => setViewSort(e.target.value as PlaylistViewSort)}
              aria-label="Kiểu hiển thị thứ tự playlist"
              className="lp-surface-input h-9 rounded-full px-3.5 text-[12px] outline-none"
            >
              <option value="custom">Thứ tự Playlist (kéo thả để sắp xếp)</option>
              <option value="title">Xem theo Tên bài A–Z</option>
              <option value="artist">Xem theo Nghệ sĩ A–Z</option>
              <option value="album">Xem theo Album</option>
              <option value="duration">Xem theo Thời lượng</option>
            </select>
            {viewSort !== 'custom' && (
              <span className="text-[11.5px] text-[var(--text-muted)]">
                Chế độ xem tạm — thứ tự gốc của playlist vẫn được giữ nguyên
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {selectMode && selectedEntryIds.size > 0 && (
              <button
                type="button"
                onClick={() => void handleBatchRemoveEntries()}
                className="rounded-full bg-rose-600 px-3.5 py-1.5 text-[12px] font-semibold text-white"
              >
                Gỡ {selectedEntryIds.size} bài khỏi playlist
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setSelectMode((v) => !v);
                setSelectedEntryIds(new Set());
              }}
              className="lp-btn-ghost rounded-full px-3.5 py-1.5 text-[12px] font-medium"
            >
              {selectMode ? 'Xong' : 'Chọn nhiều để gỡ'}
            </button>
          </div>
        </div>
      )}

      {/* Playlist Track List */}
      <section className="lp-glass-panel overflow-hidden rounded-[26px]">
        {canonicalItems.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-[14px] text-[var(--text-secondary)]">
              Playlist này chưa có bài hát nào.
            </p>
            <button
              type="button"
              onClick={() => setShowAddTracks(true)}
              style={{
                backgroundColor: userAccent.activeHex,
                color: userAccent.onAccentText,
              }}
              className="mt-4 inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-semibold"
            >
              <Plus className="h-4 w-4" />
              Thêm bài hát đầu tiên
            </button>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border-subtle)]">
            {displayedItems.map((item, idx) => {
              const { entryId, track } = item;
              const isMissing = track.status !== 'available';
              const isSelected = selectedEntryIds.has(entryId);
              return (
                <div
                  key={entryId}
                  draggable={viewSort === 'custom' && !selectMode}
                  onDragStart={() => setDragIdx(idx)}
                  onDragOver={(e) => {
                    if (viewSort === 'custom' && dragIdx !== null) e.preventDefault();
                  }}
                  onDrop={() => {
                    if (dragIdx !== null) {
                      moveEntry(dragIdx, idx);
                    }
                    setDragIdx(null);
                  }}
                  onDragEnd={() => setDragIdx(null)}
                  className={`group flex items-center gap-3 px-4 py-3 transition hover:bg-[var(--surface-hover)] ${
                    isMissing ? 'bg-amber-500/[0.05] opacity-75' : ''
                  }`}
                >
                  {selectMode ? (
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {
                        setSelectedEntryIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(entryId)) next.delete(entryId);
                          else next.add(entryId);
                          return next;
                        });
                      }}
                      className="h-4 w-4 shrink-0 accent-[var(--user-accent)]"
                    />
                  ) : (
                    viewSort === 'custom' && (
                      <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-[var(--text-muted)] opacity-50 group-hover:opacity-100" />
                    )
                  )}

                  <span className="font-mono-tabular w-6 text-right text-[12px] text-[var(--text-muted)]">
                    {idx + 1}
                  </span>

                  <button
                    type="button"
                    onClick={() => handlePlayTrack(track.id, track.status)}
                    className="relative h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-black/20"
                  >
                    <img
                      src={track.coverUrl}
                      alt={track.title}
                      className="h-full w-full object-cover"
                    />
                    {isMissing ? (
                      <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-amber-300">
                        <AlertTriangle className="h-4 w-4" />
                      </span>
                    ) : (
                      <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition group-hover:opacity-100">
                        <Play className="ml-0.5 h-4 w-4 fill-white text-white" />
                      </span>
                    )}
                  </button>

                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => handlePlayTrack(track.id, track.status)}
                      className="block max-w-full truncate text-left text-[14px] font-medium text-[var(--text-primary)] hover:underline"
                    >
                      {track.title}
                    </button>
                    <button
                      type="button"
                      onClick={() => uiStore.openArtistDetail(track.artist)}
                      className="block max-w-full truncate text-left text-[12px] text-[var(--text-secondary)] hover:underline"
                    >
                      {track.artist} · {track.albumTitle}
                    </button>
                  </div>

                  {isMissing ? (
                    <span className="rounded-full border border-amber-500/35 bg-amber-500/15 px-2.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-200">
                      Thiếu file
                    </span>
                  ) : (
                    <span className="hidden text-[11px] font-medium text-[var(--text-muted)] md:inline">
                      {track.formatBadge}
                    </span>
                  )}

                  <span className="font-mono-tabular text-[12.5px] text-[var(--text-muted)]">
                    {formatDurationSeconds(track.durationSec)}
                  </span>

                  {viewSort === 'custom' && !selectMode && (
                    <div className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => moveEntry(idx, idx - 1)}
                        title="Di chuyển lên"
                        className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-glass-light)] hover:text-[var(--text-primary)] disabled:opacity-30"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={idx === canonicalItems.length - 1}
                        onClick={() => moveEntry(idx, idx + 1)}
                        title="Di chuyển xuống"
                        className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-glass-light)] hover:text-[var(--text-primary)] disabled:opacity-30"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => void uiStore.removeEntriesFromPlaylist(playlist.id, [entryId])}
                    aria-label={`Gỡ ${track.title} khỏi playlist`}
                    title="Gỡ khỏi playlist (không xóa khỏi thư viện)"
                    className="lp-btn-ghost flex h-8 w-8 items-center justify-center rounded-full opacity-60 transition group-hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
