import { ListMusic, X } from 'lucide-react';
import { usePlaybackQueueState } from '../stores/player-store';
import { uiStore, useUiState } from '../stores/ui-store';
import { PlaybackQueuePanel } from './PlaybackQueuePanel';

export function QueueDrawer() {
  const ui = useUiState();
  const queueState = usePlaybackQueueState();
  const userAccent = uiStore.getUserAccentPalette();

  if (!ui.isQueueOpen) {
    return null;
  }

  const totalPendingCount = queueState.upcoming.length;

  return (
    <div
      data-testid="queue-drawer-backdrop"
      className="fixed inset-0 z-[45] flex justify-end bg-black/45 backdrop-blur-[2px]"
    >
      <div
        className="flex-1"
        onClick={() => uiStore.toggleQueue(false)}
        aria-hidden="true"
      />
      <aside
        data-testid="queue-drawer"
        aria-label="Hàng đợi phát"
        className="lp-glass-pill flex h-full w-full max-w-[410px] flex-col border-l border-[var(--border-glass)]"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <ListMusic className="h-4.5 w-4.5" style={{ color: userAccent.activeHex }} />
            <div>
              <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
                Hàng đợi phát
              </h2>
              <p className="text-[11.5px] text-[var(--text-muted)]">
                {queueState.currentEntry
                  ? `${totalPendingCount} bài kế tiếp`
                  : 'Chưa có bài đang phát'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => uiStore.toggleQueue(false)}
            aria-label="Đóng hàng đợi"
            data-testid="queue-drawer-close-btn"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <PlaybackQueuePanel
          accentColor={userAccent.activeHex}
          isVisible={ui.isQueueOpen}
          variant="drawer"
        />
      </aside>
    </div>
  );
}
