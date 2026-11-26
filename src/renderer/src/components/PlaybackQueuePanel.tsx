import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  GripVertical,
  ListEnd,
  ListMusic,
  MoreVertical,
  Pause,
  Play,
  Shuffle,
  Trash2,
  X,
} from 'lucide-react';
import type { PlaybackQueueEntry } from '../../../shared/types/player';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import type { PrototypeTrack } from '../data/prototype-catalog';
import { useLibraryState } from '../stores/library-store';
import {
  usePlaybackQueueState,
  usePlaybackStatus,
} from '../stores/player-store';
import { uiStore, useUiState } from '../stores/ui-store';
import { formatDurationSeconds } from '../utils/formatters';
import {
  computeQueueWindowSlice,
  QUEUE_VIRTUALIZE_THRESHOLD,
  type QueueWindowSlice,
} from '../utils/queue-virtualization';
import { AnchoredPopover } from './OverlayLayer';

export { computeQueueWindowSlice, type QueueWindowSlice };

const VIRTUALIZE_THRESHOLD = QUEUE_VIRTUALIZE_THRESHOLD;
const INITIAL_HISTORY_RENDER_LIMIT = 40;

export interface PlaybackQueuePanelProps {
  /** Accent color aligned with host surface (userAccent in Drawer, palette.dominant in NowPlaying) */
  accentColor: string;
  /** True when the panel is currently visible to the user (triggers one-shot smart auto-scroll) */
  isVisible: boolean;
  /** Compact variant for NowPlaying right tab (zero outer glass card border) */
  variant?: 'drawer' | 'tab';
}

export function PlaybackQueuePanel({
  accentColor,
  isVisible,
  variant = 'drawer',
}: PlaybackQueuePanelProps) {
  const queueState = usePlaybackQueueState();
  const localPlaybackStatus = usePlaybackStatus();
  const ui = useUiState();
  const library = useLibraryState();

  const rowHeightPx = variant === 'tab' ? 54 : 58;
  const [historyCollapsed, setHistoryCollapsed] = useState(true);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [menuState, setMenuState] = useState<{
    entry: PlaybackQueueEntry;
    idx: number;
  } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);

  const [scrollMetrics, setScrollMetrics] = useState({ top: 0, height: 520 });
  const scrollRafRef = useRef<number | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const sourceBeforeListRef = useRef<HTMLUListElement | null>(null);
  const upcomingListRef = useRef<HTMLUListElement | null>(null);
  const currentRowRef = useRef<HTMLDivElement | null>(null);
  const menuAnchorElRef = useRef<HTMLElement | null>(null);

  const userScrolledRecentlyRef = useRef(false);
  const didAutoScrollOnOpenRef = useRef(false);

  const isLocalSource = ui.activeSource === 'local';
  const effectiveStatus = isLocalSource
    ? localPlaybackStatus
    : ui.sampleIsPlaying
      ? 'playing'
      : 'paused';
  const isActivelyPlaying = effectiveStatus === 'playing';
  const isErrorState = isLocalSource && localPlaybackStatus === 'error';

  // O(1) lookup map across local + sample tracks (NEVER recomputed on timeupdate ticks)
  const trackMap = useMemo(() => {
    const unified = uiStore.getUnifiedTracks();
    const map = new Map<string, PrototypeTrack>();
    for (const track of unified) {
      map.set(track.id, track);
    }
    return map;
  }, [library.tracks, ui.metadataOverridesByTrackId, ui.customCoversByTrackId]);

  const { history, currentEntry, upcoming, controls, context } = queueState;
  const sourceContextBefore = queueState.sourceContextBefore ?? [];
  const prevShuffleRef = useRef<boolean>(controls.shuffleEnabled);
  const prevContextIdRef = useRef<string | undefined>(context?.contextId);

  const centerCurrentTrackInView = useCallback(
    (smooth: boolean) => {
      const container = scrollContainerRef.current;
      const row = currentRowRef.current;
      if (!container || !row) return;
      const containerRect = container.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const relativeTop = rowRect.top - containerRect.top + container.scrollTop;
      const targetTop = Math.max(0, relativeTop - container.clientHeight * 0.38);
      container.scrollTo({
        top: targetTop,
        behavior: smooth && !ui.preferences.reducedMotion ? 'smooth' : 'auto',
      });
    },
    [ui.preferences.reducedMotion],
  );

  // One-shot smart scroll on opening panel
  useEffect(() => {
    if (!isVisible) {
      didAutoScrollOnOpenRef.current = false;
      userScrolledRecentlyRef.current = false;
      setMenuState(null);
      setConfirmClear(false);
      return;
    }
    if (didAutoScrollOnOpenRef.current || userScrolledRecentlyRef.current) {
      return;
    }
    didAutoScrollOnOpenRef.current = true;
    const raf = requestAnimationFrame(() => centerCurrentTrackInView(false));
    return () => cancelAnimationFrame(raf);
  }, [isVisible, centerCurrentTrackInView]);

  // Explicit order / context switch auto-center (specifically when unshuffling back to original source order)
  useEffect(() => {
    const shuffleChanged = prevShuffleRef.current !== controls.shuffleEnabled;
    const contextChanged = prevContextIdRef.current !== context?.contextId;
    prevShuffleRef.current = controls.shuffleEnabled;
    prevContextIdRef.current = context?.contextId;

    if (!isVisible || (!shuffleChanged && !contextChanged)) {
      return;
    }
    userScrolledRecentlyRef.current = false;
    setMenuState(null);
    const raf = requestAnimationFrame(() => {
      centerCurrentTrackInView(true);
    });
    return () => cancelAnimationFrame(raf);
  }, [isVisible, controls.shuffleEnabled, context?.contextId, centerCurrentTrackInView]);

  // Clean up any pending scroll measurement rAF on unmount
  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

  const handleContainerScroll = () => {
    userScrolledRecentlyRef.current = true;
    const el = scrollContainerRef.current;
    if (!el) return;
    if (
      sourceContextBefore.length <= VIRTUALIZE_THRESHOLD &&
      upcoming.length <= VIRTUALIZE_THRESHOLD
    ) {
      return;
    }
    if (scrollRafRef.current !== null) {
      return;
    }
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (scrollContainerRef.current) {
        setScrollMetrics({
          top: scrollContainerRef.current.scrollTop,
          height: scrollContainerRef.current.clientHeight || 520,
        });
      }
    });
  };

  // Virtualization windows computed cleanly for large source-before & upcoming lists
  const beforeSectionScrollOffset = (() => {
    if (
      sourceContextBefore.length <= VIRTUALIZE_THRESHOLD ||
      !scrollContainerRef.current ||
      !sourceBeforeListRef.current
    ) {
      return 0;
    }
    const offsetTop = sourceBeforeListRef.current.offsetTop;
    return Math.max(0, scrollMetrics.top - offsetTop);
  })();

  const beforeWindow = useMemo(
    () =>
      computeQueueWindowSlice({
        totalItems: sourceContextBefore.length,
        itemHeightPx: rowHeightPx,
        scrollOffsetPx: beforeSectionScrollOffset,
        viewportHeightPx: scrollMetrics.height,
      }),
    [sourceContextBefore.length, rowHeightPx, beforeSectionScrollOffset, scrollMetrics.height],
  );

  const visibleSourceBefore = useMemo(
    () => sourceContextBefore.slice(beforeWindow.startIndex, beforeWindow.endIndex),
    [sourceContextBefore, beforeWindow.startIndex, beforeWindow.endIndex],
  );

  const upcomingSectionScrollOffset = (() => {
    if (
      upcoming.length <= VIRTUALIZE_THRESHOLD ||
      !scrollContainerRef.current ||
      !upcomingListRef.current
    ) {
      return 0;
    }
    const offsetTop = upcomingListRef.current.offsetTop;
    return Math.max(0, scrollMetrics.top - offsetTop);
  })();

  const upcomingWindow = useMemo(
    () =>
      computeQueueWindowSlice({
        totalItems: upcoming.length,
        itemHeightPx: rowHeightPx,
        scrollOffsetPx: upcomingSectionScrollOffset,
        viewportHeightPx: scrollMetrics.height,
      }),
    [upcoming.length, rowHeightPx, upcomingSectionScrollOffset, scrollMetrics.height],
  );

  const visibleUpcoming = useMemo(
    () => upcoming.slice(upcomingWindow.startIndex, upcomingWindow.endIndex),
    [upcoming, upcomingWindow.startIndex, upcomingWindow.endIndex],
  );

  const displayedHistory = useMemo(() => {
    if (showAllHistory || history.length <= INITIAL_HISTORY_RENDER_LIMIT) {
      return history;
    }
    return history.slice(history.length - INITIAL_HISTORY_RENDER_LIMIT);
  }, [history, showAllHistory]);

  const currentTrack = currentEntry ? trackMap.get(currentEntry.trackId) ?? null : null;

  const renderStatusHint = () => {
    if (controls.repeatMode === 'once' || controls.repeatMode === 'twice') {
      const rem = queueState.repeatRuntime.remainingReplays ?? 0;
      return (
        <p
          data-testid="queue-repeat-finite-hint"
          className="mt-1.5 text-[11px] font-medium"
          style={{ color: accentColor }}
        >
          {controls.repeatMode === 'once' ? 'Lặp 1 lần' : 'Lặp 2 lần'} đang bật
          {rem > 0 ? ` — còn ${rem} lượt lặp lại bài hiện tại` : ' — đang phát lượt cuối của bài hiện tại'}.
        </p>
      );
    }
    if (controls.repeatMode === 'one') {
      return (
        <p
          data-testid="queue-repeat-one-hint"
          className="mt-1.5 text-[11px] font-medium"
          style={{ color: accentColor }}
        >
          Lặp vô hạn 1 bài đang bật — bài hiện tại sẽ luôn phát lại.
        </p>
      );
    }
    if (!controls.autoNextEnabled) {
      return (
        <p
          data-testid="queue-autonext-off-hint"
          className="mt-1.5 text-[11px] text-[var(--text-muted)]"
        >
          Tự động chuyển bài đang tắt — các bài Kế tiếp được giữ nguyên để bạn tự chọn hoặc nhấn Next.
        </p>
      );
    }
    return null;
  };

  const handleClearUpcomingClick = () => {
    if (upcoming.length > 5 && !confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    uiStore.clearUpcomingQueue();
  };

  const renderEntryArtwork = (track: PrototypeTrack | null, compact = false) => {
    const sizeClass = compact ? 'h-9 w-9' : 'h-10 w-10';
    return (
      <img
        src={track?.coverUrl ?? DEFAULT_DOREMI_ARTWORK_URL}
        alt={track?.albumTitle ?? 'DoReMi'}
        decoding="async"
        onError={(e) => {
          const img = e.currentTarget;
          if (img.dataset.fallbackApplied !== '1') {
            img.dataset.fallbackApplied = '1';
            img.src = DEFAULT_DOREMI_ARTWORK_URL;
          }
        }}
        className={`${sizeClass} shrink-0 rounded-lg border border-[var(--border-subtle)] object-cover`}
      />
    );
  };

  return (
    <div
      data-testid="playback-queue-panel"
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* Top Toolbar: Context + Shuffle Status + Clear Upcoming */}
      <div
        className={`flex shrink-0 flex-wrap items-center justify-between gap-2 ${
          variant === 'tab'
            ? 'border-b border-[var(--np-divider)] pb-2.5 pt-2'
            : 'border-b border-[var(--border-subtle)] px-5 py-3'
        }`}
      >
        <div className="min-w-0">
          {context?.label && (
            <p className="truncate text-[11.5px] font-medium text-[var(--text-muted)]">
              Nguồn: <span className="text-[var(--text-secondary)]">{context.label}</span>
            </p>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-testid="queue-panel-shuffle-toggle"
            onClick={() => uiStore.toggleShuffle()}
            aria-pressed={controls.shuffleEnabled}
            title={
              controls.shuffleEnabled ? 'Phát ngẫu nhiên: Bật' : 'Phát ngẫu nhiên: Tắt (Thứ tự gốc)'
            }
            className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition ${
              controls.shuffleEnabled
                ? 'border-[var(--border-glass)] bg-[var(--surface-hover)]'
                : 'border-[var(--border-subtle)] bg-[var(--surface-glass-light)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
            style={controls.shuffleEnabled ? { color: accentColor } : undefined}
          >
            <Shuffle className="h-3 w-3" />
            <span>{controls.shuffleEnabled ? 'Đang trộn' : 'Tuần tự'}</span>
          </button>

          {upcoming.length > 0 &&
            (confirmClear ? (
              <div className="flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[11px]">
                <button
                  type="button"
                  data-testid="queue-confirm-clear-btn"
                  onClick={handleClearUpcomingClick}
                  className="font-semibold text-rose-500 hover:underline dark:text-rose-300"
                >
                  Xóa {upcoming.length} bài?
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClear(false)}
                  aria-label="Hủy xóa"
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                data-testid="queue-clear-upcoming-btn"
                onClick={handleClearUpcomingClick}
                title="Xóa toàn bộ các bài kế tiếp (giữ nguyên bài đang phát & lịch sử)"
                className="lp-btn-ghost inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium"
              >
                <Trash2 className="h-3 w-3" />
                <span>Xóa kế tiếp</span>
              </button>
            ))}
        </div>
      </div>

      {/* Scrollable Queue Content (Virtualizes cleanly at 80+ items) */}
      <div
        ref={scrollContainerRef}
        onScroll={handleContainerScroll}
        className={`flex-1 overflow-y-auto ${variant === 'tab' ? 'pr-1.5 pt-3' : 'px-4 py-3.5'}`}
      >
        {!currentEntry && history.length === 0 && upcoming.length === 0 ? (
          <div
            data-testid="queue-empty-state"
            className="flex h-48 flex-col items-center justify-center gap-2 px-4 text-center"
          >
            <ListMusic className="h-7 w-7 text-[var(--text-muted)]/60" />
            <p className="text-[13px] font-medium text-[var(--text-secondary)]">
              Hàng đợi đang trống.
            </p>
            <p className="text-[11.5px] text-[var(--text-muted)]">
              Chọn một bài hát, album hoặc playlist để bắt đầu nghe.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* ==================== 1A. LỊCH SỬ NGHE THỰC TẾ (HISTORY) ==================== */}
            {history.length > 0 && (
              <section data-testid="queue-history-section" aria-label="Đã phát">
                <button
                  type="button"
                  data-testid="queue-history-toggle"
                  onClick={() => setHistoryCollapsed((prev) => !prev)}
                  className="mb-1.5 flex w-full items-center justify-between text-left text-[11px] font-semibold tracking-[0.08em] text-[var(--text-muted)] uppercase transition hover:text-[var(--text-secondary)]"
                >
                  <span className="flex items-center gap-1.5">
                    {historyCollapsed ? (
                      <ChevronRight className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" />
                    )}
                    <span>Đã phát ({history.length})</span>
                  </span>
                  <span className="font-normal normal-case tracking-normal">
                    {historyCollapsed ? 'Mở rộng' : 'Thu gọn'}
                  </span>
                </button>

                {!historyCollapsed && (
                  <>
                    {!showAllHistory && history.length > INITIAL_HISTORY_RENDER_LIMIT && (
                      <button
                        type="button"
                        onClick={() => setShowAllHistory(true)}
                        className="lp-btn-ghost mb-1.5 w-full rounded-lg py-1 text-[11px]"
                      >
                        Xem thêm {history.length - INITIAL_HISTORY_RENDER_LIMIT} bài lịch sử cũ hơn
                      </button>
                    )}
                    <ul className="space-y-1">
                      {displayedHistory.map((entry) => {
                        const track = trackMap.get(entry.trackId) ?? null;
                        const statusNote =
                          entry.historyStatus === 'error'
                            ? 'Lỗi phát'
                            : entry.historyStatus === 'skipped'
                              ? 'Đã qua'
                              : null;
                        return (
                          <li
                            key={entry.queueEntryId}
                            data-testid="queue-history-item"
                            className={`group flex items-center gap-2.5 transition ${
                              variant === 'tab'
                                ? 'border-b border-[var(--border-subtle)]/55 px-1.5 py-2 opacity-75 hover:bg-[var(--surface-hover)] hover:opacity-100'
                                : 'rounded-xl px-2.5 py-1.5 opacity-72 hover:bg-[var(--surface-glass-light)] hover:opacity-100'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => uiStore.playQueueEntryNow(entry.queueEntryId)}
                              className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                              title={`${track?.title ?? 'Bài hát không còn trong thư viện'} — Phát lại từ lịch sử`}
                            >
                              {renderEntryArtwork(track, true)}
                              <div className="min-w-0 flex-1">
                                <p
                                  title={track?.title ?? undefined}
                                  className="truncate text-[13px] font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]"
                                >
                                  {track?.title ?? 'Bài hát không còn trong thư viện'}
                                </p>
                                <p
                                  title={track?.artist ?? undefined}
                                  className="truncate text-[11px] text-[var(--text-muted)]"
                                >
                                  {track?.artist ?? 'Chưa rõ nghệ sĩ'}
                                  {statusNote ? ` · ${statusNote}` : ''}
                                </p>
                              </div>
                            </button>
                            <span className="font-mono-tabular shrink-0 text-[11px] text-[var(--text-muted)]">
                              {track ? formatDurationSeconds(track.durationSec) : '--:--'}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </section>
            )}

            {/* ==================== 1B. DANH SÁCH GỐC · TRƯỚC BÀI HIỆN TẠI (SEQUENTIAL CONTEXT BEFORE) ==================== */}
            {!controls.shuffleEnabled && sourceContextBefore.length > 0 && (
              <section
                data-testid="queue-source-before-section"
                aria-label="Trong danh sách gốc (trước bài hiện tại)"
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold tracking-[0.08em] text-[var(--text-muted)] uppercase">
                    Danh sách gốc · Trước ({sourceContextBefore.length})
                  </p>
                </div>

                <ul
                  ref={sourceBeforeListRef}
                  className={beforeWindow.virtualized ? 'relative' : 'space-y-1'}
                >
                  {beforeWindow.topSpacerPx > 0 && (
                    <li
                      aria-hidden="true"
                      style={{ height: `${beforeWindow.topSpacerPx}px` }}
                    />
                  )}
                  {visibleSourceBefore.map((entry, localIdx) => {
                    const sourceOrderPos = beforeWindow.startIndex + localIdx;
                    const track = trackMap.get(entry.trackId) ?? null;
                    const wasActuallyPlayed = entry.historyStatus === 'completed';
                    return (
                      <li
                        key={entry.queueEntryId}
                        data-testid="queue-source-before-item"
                        style={beforeWindow.virtualized ? { height: `${rowHeightPx}px` } : undefined}
                        className={`group flex items-center gap-2.5 transition ${
                          variant === 'tab'
                            ? 'border-b border-[var(--border-subtle)]/55 px-1.5 py-2 opacity-80 hover:bg-[var(--surface-hover)] hover:opacity-100'
                            : 'rounded-xl px-2.5 py-1.5 opacity-80 hover:bg-[var(--surface-glass-light)] hover:opacity-100'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            uiStore.playContextIndex(entry.contextOrderIndex ?? sourceOrderPos)
                          }
                          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                          title={`${track?.title ?? 'Bài hát'} — Phát từ vị trí #${(entry.contextOrderIndex ?? sourceOrderPos) + 1}`}
                        >
                          <span className="font-mono-tabular w-5 shrink-0 text-right text-[10.5px] text-[var(--text-muted)]">
                            {(entry.contextOrderIndex ?? sourceOrderPos) + 1}
                          </span>
                          {renderEntryArtwork(track, true)}
                          <div className="min-w-0 flex-1">
                            <p
                              title={track?.title ?? undefined}
                              className="truncate text-[13px] font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]"
                            >
                              {track?.title ?? 'Bài hát không khả dụng'}
                            </p>
                            <p
                              title={track?.artist ?? undefined}
                              className="truncate text-[11px] text-[var(--text-muted)]"
                            >
                              {track?.artist ?? 'Chưa rõ nghệ sĩ'}
                              {wasActuallyPlayed ? ' · Đã nghe' : ''}
                            </p>
                          </div>
                        </button>
                        <span className="font-mono-tabular shrink-0 text-[11px] text-[var(--text-muted)]">
                          {track ? formatDurationSeconds(track.durationSec) : '--:--'}
                        </span>
                      </li>
                    );
                  })}
                  {beforeWindow.bottomSpacerPx > 0 && (
                    <li
                      aria-hidden="true"
                      style={{ height: `${beforeWindow.bottomSpacerPx}px` }}
                    />
                  )}
                </ul>
              </section>
            )}

            {/* ==================== 2. ĐANG PHÁT (CURRENT) ==================== */}
            {currentEntry && (
              <section data-testid="queue-current-section" aria-label="Đang phát">
                <p className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-[var(--text-muted)] uppercase">
                  Đang phát
                </p>

                <div
                  ref={currentRowRef}
                  data-testid="queue-item-current"
                  className={
                    variant === 'tab'
                      ? 'flex items-center gap-3 rounded-lg border-l-2 bg-[var(--surface-glass-light)] px-2.5 py-2.5 backdrop-blur-xs'
                      : 'flex items-center gap-3 rounded-xl border px-3 py-2.5'
                  }
                  style={
                    variant === 'tab'
                      ? { borderLeftColor: accentColor }
                      : {
                          borderColor: accentColor,
                          backgroundColor: 'var(--surface-hover)',
                        }
                  }
                >
                  <div className="relative shrink-0">
                    {renderEntryArtwork(currentTrack)}
                    <span
                      aria-hidden="true"
                      className="absolute -right-1 -bottom-1 flex h-4.5 w-4.5 items-center justify-center rounded-full shadow-md"
                      style={{
                        backgroundColor: accentColor,
                        color: '#FFFFFF',
                      }}
                    >
                      {isActivelyPlaying ? (
                        <Play className="ml-0.5 h-2.5 w-2.5 fill-current" />
                      ) : (
                        <Pause className="h-2.5 w-2.5 fill-current" />
                      )}
                    </span>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p
                        title={currentTrack?.title ?? undefined}
                        className="truncate text-[13.5px] font-semibold text-[var(--text-primary)]"
                      >
                        {currentTrack?.title ?? 'Đang tải...'}
                      </p>
                      <span
                        data-testid="queue-current-playback-badge"
                        className="shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold tracking-wide"
                        style={{
                          backgroundColor: 'var(--surface-glass-light)',
                          color: isErrorState ? '#f43f5e' : accentColor,
                        }}
                      >
                        {isErrorState
                          ? 'Lỗi phát'
                          : isActivelyPlaying
                            ? 'Đang phát'
                            : effectiveStatus === 'ended'
                              ? 'Đã hết'
                              : 'Tạm dừng'}
                      </span>
                    </div>
                    <p
                      title={currentTrack?.artist ?? undefined}
                      className="truncate text-[11.5px] text-[var(--text-secondary)]"
                    >
                      {currentTrack?.artist ?? 'Chưa rõ nghệ sĩ'} ·{' '}
                      {currentTrack ? formatDurationSeconds(currentTrack.durationSec) : '--:--'}
                    </p>
                  </div>
                </div>

                {renderStatusHint()}
              </section>
            )}

            {/* ==================== 3. KẾ TIẾP (UPCOMING — VIRTUALIZED FOR LARGE QUEUES) ==================== */}
            <section data-testid="queue-upcoming-section" aria-label="Kế tiếp">
              <div className="my-2 flex items-center gap-3">
                <div className="h-px flex-1 bg-[var(--border-subtle)]" />
                <span className="text-[11px] font-semibold tracking-[0.14em] text-[var(--text-secondary)] uppercase">
                  Kế tiếp
                </span>
                <div className="h-px flex-1 bg-[var(--border-subtle)]" />
              </div>

              {upcoming.length === 0 ? (
                <p
                  data-testid="queue-upcoming-empty"
                  className="py-6 text-center text-[12.5px] text-[var(--text-muted)]"
                >
                  Không còn bài hát kế tiếp.
                </p>
              ) : (
                <>
                  <p
                    data-testid="queue-upcoming-count"
                    className="mb-2 text-[11.5px] text-[var(--text-muted)]"
                  >
                    {upcoming.length} bài hát kế tiếp
                  </p>

                  <ul
                    ref={upcomingListRef}
                    className={upcomingWindow.virtualized ? 'relative' : 'space-y-1'}
                  >
                    {upcomingWindow.topSpacerPx > 0 && (
                      <li
                        aria-hidden="true"
                        style={{ height: `${upcomingWindow.topSpacerPx}px` }}
                      />
                    )}
                    {visibleUpcoming.map((entry: PlaybackQueueEntry, localIdx: number) => {
                      const idx = upcomingWindow.startIndex + localIdx;
                      const track = trackMap.get(entry.trackId) ?? null;
                      const isDragging = draggedIndex === idx;
                      const isDropTarget = dropTargetIndex === idx && draggedIndex !== idx;
                      const isMenuOpen = menuState?.entry.queueEntryId === entry.queueEntryId;

                      return (
                        <li
                          key={entry.queueEntryId}
                          data-testid="queue-upcoming-item"
                          data-entry-id={entry.queueEntryId}
                          style={
                            upcomingWindow.virtualized
                              ? {
                                  height: `${rowHeightPx}px`,
                                  ...(isDropTarget
                                    ? {
                                        borderTopColor: accentColor,
                                        borderTopWidth: '2px',
                                        backgroundColor: 'var(--surface-glass-light)',
                                      }
                                    : undefined),
                                }
                              : isDropTarget
                                ? {
                                    borderTopColor: accentColor,
                                    borderTopWidth: '2px',
                                    backgroundColor: 'var(--surface-glass-light)',
                                  }
                                : undefined
                          }
                          draggable
                          onDragStart={(e) => {
                            setDraggedIndex(idx);
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', entry.queueEntryId);
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            if (dropTargetIndex !== idx) {
                              setDropTargetIndex(idx);
                            }
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (draggedIndex !== null && draggedIndex !== idx) {
                              uiStore.reorderUpcomingQueue(draggedIndex, idx);
                            }
                            setDraggedIndex(null);
                            setDropTargetIndex(null);
                          }}
                          onDragEnd={() => {
                            setDraggedIndex(null);
                            setDropTargetIndex(null);
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            menuAnchorElRef.current = e.currentTarget as HTMLElement;
                            setMenuState(isMenuOpen ? null : { entry, idx });
                          }}
                          className={`group relative flex items-center gap-2 transition ${
                            variant === 'tab'
                              ? 'border-b border-[var(--border-subtle)]/55 px-1.5 py-2 hover:bg-[var(--surface-hover)]'
                              : 'rounded-xl border px-2 py-2 border-transparent hover:border-[var(--border-subtle)] hover:bg-[var(--surface-hover)]'
                          } ${isDragging ? 'opacity-45' : ''}`}
                        >
                          <span
                            title="Kéo thả để đổi thứ tự phát"
                            className={
                              variant === 'tab'
                                ? 'w-0 cursor-grab overflow-hidden text-[var(--text-muted)]/60 opacity-0 transition-all duration-150 group-hover:w-3.5 group-hover:text-[var(--text-secondary)] group-hover:opacity-100 active:cursor-grabbing'
                                : 'cursor-grab text-[var(--text-muted)]/60 group-hover:text-[var(--text-secondary)] active:cursor-grabbing'
                            }
                          >
                            <GripVertical className="h-3.5 w-3.5" />
                          </span>

                          <button
                            type="button"
                            onClick={() => uiStore.playQueueEntryNow(entry.queueEntryId)}
                            title={
                              track
                                ? `${track.title} — ${track.artist}`
                                : 'Bài hát không khả dụng'
                            }
                            className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                          >
                            {renderEntryArtwork(track, true)}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <p
                                  title={track?.title ?? undefined}
                                  className="truncate text-[13px] font-medium text-[var(--text-primary)]"
                                >
                                  {track?.title ?? 'Bài hát không khả dụng'}
                                </p>
                                {entry.origin === 'play-next' && (
                                  <span
                                    className="shrink-0 rounded px-1.5 py-0.2 text-[9.5px] font-semibold"
                                    style={{
                                      backgroundColor: 'var(--surface-glass-light)',
                                      color: accentColor,
                                    }}
                                  >
                                    Tiếp theo
                                  </span>
                                )}
                              </div>
                              <p
                                title={track?.artist ?? undefined}
                                className="truncate text-[11px] text-[var(--text-muted)]"
                              >
                                {track?.artist ?? 'Chưa rõ nghệ sĩ'} ·{' '}
                                {track ? formatDurationSeconds(track.durationSec) : '--:--'}
                              </p>
                            </div>
                          </button>

                          <div
                            className={`flex shrink-0 items-center gap-0.5 ${
                              variant === 'tab' && !isMenuOpen
                                ? 'max-w-0 overflow-hidden opacity-0 transition-all duration-150 group-hover:max-w-[64px] group-hover:opacity-100 group-focus-within:max-w-[64px] group-focus-within:opacity-100'
                                : ''
                            }`}
                          >
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                menuAnchorElRef.current = e.currentTarget;
                                setMenuState(isMenuOpen ? null : { entry, idx });
                              }}
                              aria-label={`Tùy chọn cho ${track?.title ?? 'bài hát'}`}
                              aria-expanded={isMenuOpen}
                              data-testid={`queue-entry-menu-btn-${idx}`}
                              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] opacity-75 transition hover:bg-[var(--surface-glass-light)] hover:text-[var(--text-primary)] group-hover:opacity-100"
                            >
                              <MoreVertical className="h-3.5 w-3.5" />
                            </button>

                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                uiStore.removeQueueEntry(entry.queueEntryId);
                              }}
                              title="Xóa khỏi hàng đợi"
                              aria-label={`Xóa ${track?.title ?? 'bài hát'} khỏi hàng đợi`}
                              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] opacity-75 transition hover:bg-rose-500/15 hover:text-rose-500 group-hover:opacity-100"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </li>
                      );
                    })}
                    {upcomingWindow.bottomSpacerPx > 0 && (
                      <li
                        aria-hidden="true"
                        style={{ height: `${upcomingWindow.bottomSpacerPx}px` }}
                      />
                    )}
                  </ul>
                </>
              )}
            </section>
          </div>
        )}
      </div>

      {/* Portaled Row Context Menu — never clipped by overflow-y-auto container */}
      <AnchoredPopover
        open={Boolean(menuState)}
        anchorRef={menuAnchorElRef}
        onClose={() => setMenuState(null)}
        placement="bottom"
        align="end"
        dismissOnScroll
        role="menu"
        ariaLabel="Thao tác bài hát trong hàng đợi"
        className="lp-glass-pill w-48 rounded-xl p-1 text-[12px] shadow-xl"
      >
        {menuState && (
          <>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const targetId = menuState.entry.queueEntryId;
                setMenuState(null);
                uiStore.playQueueEntryNow(targetId);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
            >
              <Play className="h-3.5 w-3.5" />
              <span>Phát ngay</span>
            </button>

            {menuState.idx > 0 && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const targetId = menuState.entry.queueEntryId;
                  setMenuState(null);
                  uiStore.promoteQueueEntryToPlayNext(targetId);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
              >
                <ListEnd className="h-3.5 w-3.5" />
                <span>Phát tiếp theo</span>
              </button>
            )}

            <button
              type="button"
              role="menuitem"
              disabled={menuState.idx === 0}
              onClick={() => {
                const targetId = menuState.entry.queueEntryId;
                setMenuState(null);
                uiStore.moveQueueEntry(targetId, -1);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-35"
            >
              <ArrowUp className="h-3.5 w-3.5" />
              <span>Di chuyển lên</span>
            </button>

            <button
              type="button"
              role="menuitem"
              disabled={menuState.idx >= upcoming.length - 1}
              onClick={() => {
                const targetId = menuState.entry.queueEntryId;
                setMenuState(null);
                uiStore.moveQueueEntry(targetId, 1);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-35"
            >
              <ArrowDown className="h-3.5 w-3.5" />
              <span>Di chuyển xuống</span>
            </button>

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const targetId = menuState.entry.queueEntryId;
                setMenuState(null);
                uiStore.removeQueueEntry(targetId);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-rose-500 hover:bg-rose-500/15 dark:text-rose-300"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Xóa khỏi hàng đợi</span>
            </button>
          </>
        )}
      </AnchoredPopover>
    </div>
  );
}
