import { useEffect, useState } from 'react';
import { RotateCcw, ShieldCheck, X } from 'lucide-react';
import type { TrackMetadataOverrideInput } from '../../../shared/types/track';

export interface TrackMetadataEditTarget {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  originalTitle: string;
  originalArtist: string;
  originalAlbum: string | null;
  hasOverride: boolean;
}

interface TrackMetadataModalProps {
  target: TrackMetadataEditTarget | null;
  isSaving?: boolean;
  onClose: () => void;
  onSave: (trackId: string, input: TrackMetadataOverrideInput) => Promise<void> | void;
  onRestoreOriginal: (trackId: string) => Promise<void> | void;
}

export function TrackMetadataModal({
  target,
  isSaving = false,
  onClose,
  onSave,
  onRestoreOriginal,
}: TrackMetadataModalProps) {
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [album, setAlbum] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!target) {
      return;
    }
    setTitle(target.title);
    setArtist(target.artist);
    setAlbum(target.album ?? '');
    setErrorMessage(null);
  }, [target]);

  if (!target) {
    return null;
  }

  const trimmedTitle = title.trim();
  const trimmedArtist = artist.trim();
  const trimmedAlbum = album.trim();

  const isTitleModified = trimmedTitle !== target.originalTitle;
  const isArtistModified = trimmedArtist !== target.originalArtist;
  const isAlbumModified = trimmedAlbum !== (target.originalAlbum ?? '');
  const hasAnyOverride =
    target.hasOverride || isTitleModified || isArtistModified || isAlbumModified;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmedTitle) {
      setErrorMessage('Tên bài hát không được để trống.');
      return;
    }
    if (!trimmedArtist) {
      setErrorMessage('Tên nghệ sĩ không được để trống.');
      return;
    }
    setErrorMessage(null);
    await onSave(target.id, {
      titleOverride: trimmedTitle !== target.originalTitle ? trimmedTitle : null,
      artistOverride: trimmedArtist !== target.originalArtist ? trimmedArtist : null,
      albumOverride: trimmedAlbum !== (target.originalAlbum ?? '') ? trimmedAlbum : null,
    });
    onClose();
  };

  const handleRestoreAll = async () => {
    await onRestoreOriginal(target.id);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
      <form
        onSubmit={(e) => void handleSubmit(e)}
        role="dialog"
        aria-modal="true"
        aria-label="Chỉnh sửa thông tin bài hát"
        data-testid="metadata-edit-modal"
        className="lp-glass-pill w-full max-w-[520px] rounded-[24px] p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-[18px] font-semibold text-[var(--text-primary)]">
              Chỉnh sửa thông tin bài hát
            </h2>
            <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
              Lưu trực tiếp trong cơ sở dữ liệu ứng dụng (SQLite).
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.08] px-3.5 py-2.5 text-[11.5px] leading-relaxed text-emerald-700 dark:text-emerald-100/90">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-300" />
          <span>
            File âm thanh gốc trên ổ đĩa hoàn toàn không bị chỉnh sửa hoặc ghi đè tag. Bạn luôn có thể khôi phục thông tin gốc bất kỳ lúc nào.
          </span>
        </div>

        <div className="mt-4 space-y-3.5">
          {/* Title */}
          <div>
            <div className="flex items-center justify-between">
              <label
                htmlFor="doremi-meta-title"
                className="text-[12px] font-medium text-[var(--text-primary)]"
              >
                Tên bài hát (Title)
              </label>
              {isTitleModified && (
                <button
                  type="button"
                  onClick={() => setTitle(target.originalTitle)}
                  className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  <RotateCcw className="h-3 w-3" />
                  Khôi phục gốc
                </button>
              )}
            </div>
            <input
              id="doremi-meta-title"
              data-testid="metadata-input-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="lp-surface-input mt-1.5 h-10 w-full rounded-xl px-3.5 text-[13.5px] focus:outline-none"
            />
            <p className="mt-1 truncate text-[11px] text-[var(--text-muted)]">
              Gốc: {target.originalTitle}
            </p>
          </div>

          {/* Artist */}
          <div>
            <div className="flex items-center justify-between">
              <label
                htmlFor="doremi-meta-artist"
                className="text-[12px] font-medium text-[var(--text-primary)]"
              >
                Nghệ sĩ (Artist)
              </label>
              {isArtistModified && (
                <button
                  type="button"
                  onClick={() => setArtist(target.originalArtist)}
                  className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  <RotateCcw className="h-3 w-3" />
                  Khôi phục gốc
                </button>
              )}
            </div>
            <input
              id="doremi-meta-artist"
              data-testid="metadata-input-artist"
              type="text"
              value={artist}
              onChange={(e) => setArtist(e.target.value)}
              className="lp-surface-input mt-1.5 h-10 w-full rounded-xl px-3.5 text-[13.5px] focus:outline-none"
            />
            <p className="mt-1 truncate text-[11px] text-[var(--text-muted)]">
              Gốc: {target.originalArtist}
            </p>
          </div>

          {/* Album */}
          <div>
            <div className="flex items-center justify-between">
              <label
                htmlFor="doremi-meta-album"
                className="text-[12px] font-medium text-[var(--text-primary)]"
              >
                Album
              </label>
              {isAlbumModified && (
                <button
                  type="button"
                  onClick={() => setAlbum(target.originalAlbum ?? '')}
                  className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  <RotateCcw className="h-3 w-3" />
                  Khôi phục gốc
                </button>
              )}
            </div>
            <input
              id="doremi-meta-album"
              data-testid="metadata-input-album"
              type="text"
              value={album}
              onChange={(e) => setAlbum(e.target.value)}
              placeholder="Để trống nếu không có album"
              className="lp-surface-input mt-1.5 h-10 w-full rounded-xl px-3.5 text-[13.5px] focus:outline-none"
            />
            <p className="mt-1 truncate text-[11px] text-[var(--text-muted)]">
              Gốc: {target.originalAlbum || 'Không có'}
            </p>
          </div>
        </div>

        {errorMessage && (
          <p className="mt-3 text-[12px] text-rose-500 dark:text-rose-300" role="alert">
            {errorMessage}
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2.5 border-t border-[var(--border-subtle)] pt-4">
          <button
            type="button"
            disabled={!hasAnyOverride || isSaving}
            onClick={() => void handleRestoreAll()}
            data-testid="metadata-restore-original"
            className="lp-btn-ghost flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[12px] font-medium disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Khôi phục tất cả gốc
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving}
              className="lp-btn-ghost rounded-full px-4 py-2 text-[12.5px] font-medium"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={isSaving}
              data-testid="metadata-save-btn"
              className="rounded-full bg-[var(--text-primary)] px-5 py-2 text-[12.5px] font-semibold text-[var(--bg-deep)] transition hover:opacity-90 disabled:opacity-50"
            >
              {isSaving ? 'Đang lưu...' : 'Lưu thay đổi'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
