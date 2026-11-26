import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Disc3, ListPlus, Plus, X } from 'lucide-react';
import { uiStore, useUiState } from '../stores/ui-store';
import { validatePlaylistName } from '../utils/playlist-validation';
import { OverlayPortal } from './OverlayLayer';

export interface PlaylistPickerModalProps {
  trackIds: readonly string[];
  title?: string;
  initialMode?: 'pick' | 'create';
  /** When true and trackIds is non-empty, lets the user confirm or uncheck attaching selected tracks. */
  allowToggleSelection?: boolean;
  onClose: () => void;
  onCompleted?: (info?: { includedTrackCount: number }) => void;
}

export function PlaylistPickerModal({
  trackIds,
  title,
  initialMode = 'pick',
  allowToggleSelection = false,
  onClose,
  onCompleted,
}: PlaylistPickerModalProps) {
  const ui = useUiState();
  const userAccent = uiStore.getUserAccentPalette();
  const [mode, setMode] = useState<'pick' | 'create'>(
    ui.playlists.length === 0 ? 'create' : initialMode,
  );
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [includeSelectedTracks, setIncludeSelectedTracks] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const submitLockRef = useRef(false);

  const uniqueIncoming = useMemo(
    () => Array.from(new Set(trackIds.filter(Boolean))),
    [trackIds],
  );
  const existingPlaylistNames = useMemo(
    () => ui.playlists.map((pl) => pl.name),
    [ui.playlists],
  );
  const effectiveTrackIds = useMemo(
    () => (allowToggleSelection && !includeSelectedTracks ? [] : uniqueIncoming),
    [allowToggleSelection, includeSelectedTracks, uniqueIncoming],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  const handlePickPlaylist = async (playlistId: string) => {
    if (submitLockRef.current || busy || uniqueIncoming.length === 0) return;
    submitLockRef.current = true;
    setBusy(true);
    setErrorMsg(null);
    try {
      await uiStore.addTracksToPlaylist(playlistId, uniqueIncoming, { allowDuplicates });
      onCompleted?.({ includedTrackCount: uniqueIncoming.length });
      onClose();
    } catch (err) {
      setErrorMsg(
        err instanceof Error && err.message
          ? err.message
          : 'Không thể thêm bài hát vào playlist. Vui lòng thử lại.',
      );
    } finally {
      submitLockRef.current = false;
      setBusy(false);
    }
  };

  const handleCreatePlaylist = async () => {
    if (submitLockRef.current || busy) return;
    const validation = validatePlaylistName(newName, existingPlaylistNames);
    if (!validation.valid) {
      setErrorMsg(validation.error);
      return;
    }

    submitLockRef.current = true;
    setBusy(true);
    setErrorMsg(null);
    try {
      const created = await uiStore.createPlaylist(
        validation.normalizedName,
        newDesc,
        effectiveTrackIds,
      );
      if (!created) {
        setErrorMsg('Không thể tạo playlist. Vui lòng kiểm tra lại tên playlist.');
        return;
      }
      onCompleted?.({ includedTrackCount: effectiveTrackIds.length });
      onClose();
    } catch (err) {
      setErrorMsg(
        err instanceof Error && err.message
          ? err.message
          : 'Lỗi khi lưu playlist vào cơ sở dữ liệu.',
      );
    } finally {
      submitLockRef.current = false;
      setBusy(false);
    }
  };

  return (
    <OverlayPortal layer="modal">
      <div className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'Thêm vào Playlist'}
        data-testid="playlist-picker-modal"
        className="lp-glass-pill w-full max-w-[460px] rounded-[24px] p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-[17px] font-semibold text-[var(--text-primary)]">
              {title ?? 'Thêm vào Playlist'}
            </h2>
            <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
              {effectiveTrackIds.length > 0
                ? `Sẽ thêm ${effectiveTrackIds.length} bài hát vào playlist`
                : 'Tạo playlist mới trống (0 bài hát)'}
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            aria-label="Đóng"
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-45"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 flex items-center gap-2">
          {ui.playlists.length > 0 && uniqueIncoming.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setErrorMsg(null);
                setMode('pick');
              }}
              className={`rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition ${
                mode === 'pick'
                  ? 'bg-[var(--text-primary)] text-[var(--bg-deep)]'
                  : 'lp-btn-ghost'
              }`}
            >
              <ListPlus className="mr-1 inline h-3.5 w-3.5" />
              Chọn playlist có sẵn ({ui.playlists.length})
            </button>
          )}
          <button
            type="button"
            data-testid="picker-switch-create-btn"
            onClick={() => {
              setErrorMsg(null);
              setMode('create');
            }}
            className={`rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition ${
              mode === 'create'
                ? 'bg-[var(--text-primary)] text-[var(--bg-deep)]'
                : 'lp-btn-ghost'
            }`}
          >
            <Plus className="mr-1 inline h-3.5 w-3.5" />
            Tạo playlist mới
          </button>
        </div>

        {errorMsg && (
          <div
            role="alert"
            data-testid="picker-error-banner"
            className="mt-3 rounded-xl border border-rose-500/35 bg-rose-500/10 px-3.5 py-2 text-[12px] font-medium text-rose-500 dark:text-rose-300"
          >
            {errorMsg}
          </div>
        )}

        {mode === 'pick' && ui.playlists.length > 0 ? (
          <div className="mt-4 space-y-3">
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={allowDuplicates}
                onChange={(e) => setAllowDuplicates(e.target.checked)}
                className="h-3.5 w-3.5 rounded accent-[var(--user-accent)]"
              />
              <span>Cho phép thêm bài đã tồn tại trong playlist (chế độ lặp bài trong list)</span>
            </label>

            <div className="max-h-[280px] space-y-1.5 overflow-y-auto pr-1">
              {ui.playlists.map((pl) => {
                const { primaryCover } = uiStore.getPlaylistCovers(pl);
                const existingSet = new Set(pl.trackIds);
                const alreadyInCount = uniqueIncoming.filter((id) => existingSet.has(id)).length;
                return (
                  <button
                    key={pl.id}
                    type="button"
                    disabled={busy}
                    data-testid={`picker-playlist-${pl.id}`}
                    onClick={() => void handlePickPlaylist(pl.id)}
                    className="flex w-full items-center justify-between gap-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-3.5 py-2.5 text-left transition hover:bg-[var(--surface-hover)]"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-black/20">
                        {primaryCover ? (
                          <img src={primaryCover} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <Disc3 className="h-4 w-4 text-[var(--text-muted)]" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-[13.5px] font-semibold text-[var(--text-primary)]">
                          {pl.name}
                        </p>
                        <p className="truncate text-[11.5px] text-[var(--text-muted)]">
                          {pl.trackIds.length} bài hát
                          {alreadyInCount > 0 ? ` · ${alreadyInCount} bài đã có sẵn` : ''}
                        </p>
                      </div>
                    </div>
                    <Check className="h-4 w-4 shrink-0 opacity-40" />
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-[var(--text-secondary)]">
                Tên playlist mới *
              </label>
              <input
                type="text"
                autoFocus
                data-testid="picker-create-name-input"
                maxLength={85}
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value);
                  if (errorMsg) setErrorMsg(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreatePlaylist();
                }}
                placeholder="Ví dụ: Album yêu thích, Khuya tĩnh..."
                className="lp-surface-input w-full rounded-xl px-3.5 py-2.5 text-[13.5px] outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block text-[12px] font-medium text-[var(--text-secondary)]">
                Mô tả ngắn (không bắt buộc)
              </label>
              <input
                type="text"
                maxLength={240}
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreatePlaylist();
                }}
                placeholder="Mô tả..."
                className="lp-surface-input w-full rounded-xl px-3.5 py-2 text-[13px] outline-none"
              />
            </div>

            {allowToggleSelection && uniqueIncoming.length > 0 && (
              <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-3 py-2 text-[12px] text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  data-testid="picker-include-selected-checkbox"
                  checked={includeSelectedTracks}
                  onChange={(e) => setIncludeSelectedTracks(e.target.checked)}
                  className="h-3.5 w-3.5 rounded accent-[var(--user-accent)]"
                />
                <span>
                  Thêm {uniqueIncoming.length} bài hát đang chọn vào playlist mới này
                </span>
              </label>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={busy}
                onClick={onClose}
                className="lp-btn-ghost rounded-full px-4 py-2 text-[12.5px] font-medium disabled:opacity-45"
              >
                Hủy
              </button>
              <button
                type="button"
                disabled={!newName.trim() || busy}
                data-testid="picker-create-confirm-btn"
                onClick={() => void handleCreatePlaylist()}
                style={{
                  backgroundColor: userAccent.activeHex,
                  color: userAccent.onAccentText,
                }}
                className="rounded-full px-5 py-2 text-[12.5px] font-semibold transition hover:brightness-110 disabled:opacity-45"
              >
                {busy
                  ? 'Đang lưu...'
                  : effectiveTrackIds.length > 0
                    ? `Tạo với ${effectiveTrackIds.length} bài`
                    : 'Tạo playlist trống'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
    </OverlayPortal>
  );
}
