import { useState } from 'react';
import { X } from 'lucide-react';
import { EditorialPlaylistGallery } from '../components/EditorialPlaylistGallery';
import { OverlayPortal } from '../components/OverlayLayer';
import { uiStore } from '../stores/ui-store';

/**
 * M5.3 Immersive Home & Editorial Playlist Gallery
 * Art-first near-fullscreen hero without cluttering the viewport with widget stacks.
 */
export function HomePage() {
  const userAccent = uiStore.getUserAccentPalette();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const handleCreatePlaylist = async () => {
    const trimmed = newName.trim();
    if (!trimmed) {
      return;
    }
    await uiStore.createPlaylist(trimmed, newDesc, []);
    setNewName('');
    setNewDesc('');
    setShowCreateModal(false);
  };

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col pb-36">
      <EditorialPlaylistGallery
        onRequestCreatePlaylist={() => setShowCreateModal(true)}
      />

      {showCreateModal && (
        <OverlayPortal layer="modal">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Tạo playlist mới"
            className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          >
          <div className="lp-glass-pill w-full max-w-md rounded-3xl p-6">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold text-[var(--text-primary)]">
                Tạo playlist mới
              </h2>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="lp-btn-ghost flex h-8 w-8 items-center justify-center rounded-full"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-3.5">
              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-[var(--text-secondary)]">
                  Tên playlist
                </label>
                <input
                  type="text"
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreatePlaylist();
                  }}
                  placeholder="Ví dụ: Đêm Mưa Lossless, City Pop Tokyo..."
                  data-testid="create-playlist-name-input"
                  className="lp-surface-input w-full rounded-xl px-3.5 py-2.5 text-[14px] outline-none"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-[var(--text-secondary)]">
                  Mô tả ngắn (không bắt buộc)
                </label>
                <input
                  type="text"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreatePlaylist();
                  }}
                  placeholder="Không gian âm nhạc cho những giờ tĩnh lặng..."
                  className="lp-surface-input w-full rounded-xl px-3.5 py-2.5 text-[13.5px] outline-none"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="lp-btn-ghost rounded-full px-4 py-2 text-[13px] font-medium"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={handleCreatePlaylist}
                disabled={!newName.trim()}
                data-testid="confirm-create-playlist-btn"
                style={{
                  backgroundColor: userAccent.activeHex,
                  color: userAccent.onAccentText,
                }}
                className="rounded-full px-5 py-2 text-[13px] font-semibold transition hover:brightness-110 disabled:opacity-45"
              >
                Tạo playlist
              </button>
            </div>
          </div>
        </div>
        </OverlayPortal>
      )}
    </div>
  );
}
