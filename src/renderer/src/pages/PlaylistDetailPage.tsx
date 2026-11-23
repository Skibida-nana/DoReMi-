import { useRef, useState, type ChangeEvent } from 'react';
import {
  ArrowLeft,
  Check,
  Disc3,
  ImagePlus,
  Pencil,
  Play,
  Plus,
  Shuffle,
  Trash2,
  X,
} from 'lucide-react';
import { libraryStore } from '../stores/library-store';
import { uiStore, useUiState } from '../stores/ui-store';
import { formatDurationSeconds } from '../utils/formatters';

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Không thể đọc ảnh.'));
    reader.readAsDataURL(file);
  });
}

/**
 * M5.4 Playlist Detail Screen
 * Reached when clicking the centered playlist card on Home or any playlist in Library.
 */
export function PlaylistDetailPage() {
  const ui = useUiState();
  const userAccent = uiStore.getUserAccentPalette();
  const playlist =
    ui.playlists.find((p) => p.id === ui.selectedPlaylistId) ?? ui.playlists[0] ?? null;

  const [isEditing, setIsEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(playlist?.name ?? '');
  const [descDraft, setDescDraft] = useState(playlist?.description ?? '');
  const [showAddTracks, setShowAddTracks] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const coverInputRef = useRef<HTMLInputElement | null>(null);

  if (!playlist) {
    return (
      <div className="mx-auto max-w-2xl py-20 text-center">
        <p className="text-[15px] text-[var(--text-secondary)]">
          Playlist này không còn tồn tại.
        </p>
        <button
          type="button"
          onClick={() => uiStore.navigate('home')}
          className="lp-btn-ghost mt-4 rounded-full px-5 py-2 text-[13px] font-medium"
        >
          Quay lại Trang chủ
        </button>
      </div>
    );
  }

  const allTracks = uiStore.getUnifiedTracks();
  const playlistTracks = playlist.trackIds
    .map((id) => allTracks.find((t) => t.id === id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));

  const addableTracks = allTracks.filter((t) => !playlist.trackIds.includes(t.id));
  const totalSec = playlistTracks.reduce((sum, t) => sum + t.durationSec, 0);
  const { primaryCover, collageCovers } = uiStore.getPlaylistCovers(playlist);

  const handlePlayTrack = (track: (typeof playlistTracks)[number]) => {
    if (track.source === 'local') {
      const localRecord = libraryStore.getSnapshot().tracks.find((r) => r.id === track.id);
      if (localRecord) {
        void uiStore.playLocalElectronTrack(localRecord);
        return;
      }
    }
    uiStore.playSampleTrack(track.id);
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

  return (
    <div
      data-testid="playlist-detail-page"
      className="mx-auto max-w-[1160px] space-y-6 pb-32 pt-2"
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
        onClick={() => uiStore.navigate('home')}
        className="lp-btn-ghost inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium"
      >
        <ArrowLeft className="h-4 w-4" />
        Quay lại
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

          <button
            type="button"
            onClick={() => coverInputRef.current?.click()}
            className="absolute inset-x-2 bottom-2 flex items-center justify-center gap-1.5 rounded-xl bg-black/72 px-2.5 py-1.5 text-[11.5px] font-medium text-white opacity-0 backdrop-blur-md transition group-hover:opacity-100"
          >
            <ImagePlus className="h-3.5 w-3.5" />
            Đổi bìa
          </button>
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
                    uiStore.renamePlaylist(playlist.id, nameDraft, descDraft);
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
              <p className="max-w-2xl text-[13.5px] text-[var(--text-secondary)]">
                {playlist.description}
              </p>
              <p className="text-[12.5px] text-[var(--text-muted)]">
                {playlistTracks.length} bài hát · {Math.max(1, Math.round(totalSec / 60))} phút
              </p>
            </>
          )}

          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={() => uiStore.playPlaylist(playlist.id, false)}
              disabled={playlistTracks.length === 0}
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
              disabled={playlistTracks.length === 0}
              className="lp-btn-ghost inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-[13px] font-medium disabled:opacity-45"
            >
              <Shuffle className="h-4 w-4" />
              Trộn bài
            </button>

            <button
              type="button"
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
              Đổi tên
            </button>

            {confirmDelete ? (
              <div className="flex items-center gap-1.5 rounded-full border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-[12px]">
                <span className="text-rose-400">Xác nhận xóa?</span>
                <button
                  type="button"
                  onClick={() => uiStore.deletePlaylist(playlist.id)}
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

      {/* Quick Add Tracks Picker */}
      {showAddTracks && (
        <section className="lp-glass-panel rounded-3xl p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-base font-semibold text-[var(--text-primary)]">
              Thêm bài hát từ thư viện ({addableTracks.length})
            </h2>
            <button
              type="button"
              onClick={() => setShowAddTracks(false)}
              className="lp-btn-ghost flex h-8 w-8 items-center justify-center rounded-full"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {addableTracks.length === 0 ? (
            <p className="text-[13px] text-[var(--text-muted)]">
              Tất cả bài hát hiện có trong thư viện đã nằm trong playlist này.
            </p>
          ) : (
            <div className="grid max-h-[240px] gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2">
              {addableTracks.map((track) => (
                <div
                  key={track.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
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
                        {track.artist}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => uiStore.addTrackToPlaylist(playlist.id, track.id)}
                    className="lp-btn-ghost shrink-0 rounded-full px-3 py-1 text-[11.5px] font-semibold"
                  >
                    + Thêm
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Playlist Track List */}
      <section className="lp-glass-panel overflow-hidden rounded-[26px]">
        {playlistTracks.length === 0 ? (
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
            {playlistTracks.map((track, idx) => (
              <div
                key={track.id}
                className="group flex items-center gap-4 px-5 py-3 transition hover:bg-[var(--surface-hover)]"
              >
                <span className="font-mono-tabular w-6 text-right text-[12px] text-[var(--text-muted)]">
                  {idx + 1}
                </span>
                <button
                  type="button"
                  onClick={() => handlePlayTrack(track)}
                  className="relative h-11 w-11 shrink-0 overflow-hidden rounded-xl"
                >
                  <img
                    src={track.coverUrl}
                    alt={track.title}
                    className="h-full w-full object-cover"
                  />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition group-hover:opacity-100">
                    <Play className="ml-0.5 h-4 w-4 fill-white text-white" />
                  </span>
                </button>
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => handlePlayTrack(track)}
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
                <span className="hidden text-[11px] font-medium text-[var(--text-muted)] md:inline">
                  {track.formatBadge}
                </span>
                <span className="font-mono-tabular text-[12.5px] text-[var(--text-muted)]">
                  {formatDurationSeconds(track.durationSec)}
                </span>
                <button
                  type="button"
                  onClick={() => uiStore.removeTrackFromPlaylist(playlist.id, track.id)}
                  aria-label={`Gỡ ${track.title} khỏi playlist`}
                  className="lp-btn-ghost flex h-8 w-8 items-center justify-center rounded-full opacity-0 transition group-hover:opacity-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
