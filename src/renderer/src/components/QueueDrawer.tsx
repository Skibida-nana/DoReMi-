import { ArrowDown, ArrowUp, ListMusic, Play, Trash2, X } from 'lucide-react';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import { uiStore, useUiState } from '../stores/ui-store';
import { formatDurationSeconds } from '../utils/formatters';

export function QueueDrawer() {
  const ui = useUiState();
  const palette = uiStore.getCurrentPalette();

  if (!ui.isQueueOpen) {
    return null;
  }

  const unified = uiStore.getUnifiedTracks();
  const queueTracks = ui.queueTrackIds
    .map((id) => unified.find((t) => t.id === id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/45 backdrop-blur-[2px]">
      <div
        className="flex-1"
        onClick={() => uiStore.toggleQueue(false)}
        aria-hidden="true"
      />
      <aside
        aria-label="Hàng đợi phát"
        className="lp-glass-pill flex h-full w-full max-w-[390px] flex-col border-l border-[var(--border-glass)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-6 py-5">
          <div className="flex items-center gap-2.5">
            <ListMusic className="h-4 w-4" style={{ color: palette.dominant }} />
            <div>
              <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Hàng đợi phát</h2>
              <p className="text-[12px] text-[var(--text-muted)]">
                {queueTracks.length} bài trong danh sách
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => uiStore.clearQueue()}
              className="lp-btn-ghost rounded-lg px-2.5 py-1.5 text-[11px] font-medium"
            >
              Dọn sạch
            </button>
            <button
              type="button"
              onClick={() => uiStore.toggleQueue(false)}
              aria-label="Đóng hàng đợi"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {queueTracks.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center text-center text-[13px] text-[var(--text-muted)]">
              Hàng đợi đang trống.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {queueTracks.map((track, idx) => {
                const isCurrent = track.id === ui.activeSampleTrackId;
                return (
                  <li
                    key={`${track.id}-${idx}`}
                    className={`group flex items-center gap-3 rounded-xl border px-3 py-2.5 transition ${
                      isCurrent
                        ? 'border-[var(--border-glass)] bg-[var(--surface-hover)]'
                        : 'border-transparent bg-[var(--surface-glass-light)] hover:border-[var(--border-subtle)] hover:bg-[var(--surface-hover)]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => uiStore.playSampleTrack(track.id)}
                      className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-[var(--border-subtle)]"
                    >
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
                      <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition group-hover:opacity-100">
                        <Play className="h-3.5 w-3.5 fill-white text-white" />
                      </span>
                    </button>

                    <div className="min-w-0 flex-1">
                      <p
                        className="truncate text-[13px] font-medium"
                        style={{ color: isCurrent ? palette.dominant : 'var(--text-primary)' }}
                      >
                        {track.title}
                      </p>
                      <p className="truncate text-[11px] text-[var(--text-muted)]">
                        {track.artist} · {formatDurationSeconds(track.durationSec)}
                      </p>
                    </div>

                    <div className="flex items-center gap-0.5 opacity-70 transition group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => uiStore.moveQueueItem(idx, -1)}
                        disabled={idx === 0}
                        title="Đưa lên"
                        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-25"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => uiStore.moveQueueItem(idx, 1)}
                        disabled={idx === queueTracks.length - 1}
                        title="Đưa xuống"
                        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-25"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                      {!isCurrent && (
                        <button
                          type="button"
                          onClick={() => uiStore.removeFromQueue(track.id)}
                          title="Xóa khỏi hàng đợi"
                          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-rose-500/15 hover:text-rose-500 dark:hover:text-rose-300"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
