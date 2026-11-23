import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  BarChart3,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  Disc3,
  Headphones,
  HelpCircle,
  Library,
  Music2,
  Play,
  TrendingUp,
} from 'lucide-react';
import type {
  StatisticsDashboardData,
  StatisticsQuery,
  StatisticsTimeRange,
} from '../../../shared/types/stage5';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import { useLibraryState } from '../stores/library-store';
import { uiStore, useUiState } from '../stores/ui-store';

const TIME_RANGES: Array<{ id: StatisticsTimeRange; label: string }> = [
  { id: 'today', label: 'Hôm nay' },
  { id: 'week', label: 'Tuần này' },
  { id: 'month', label: 'Tháng này' },
  { id: 'year', label: 'Năm nay' },
  { id: 'all', label: 'Toàn thời gian' },
  { id: 'custom', label: 'Tùy chọn' },
];

function formatDurationMs(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) {
    return `${hours}g ${mins}p`;
  }
  if (mins > 0) {
    return `${mins} phút`;
  }
  return `${secs} giây`;
}

function formatCompactMinutes(ms: number): string {
  const mins = ms / 60_000;
  if (mins === 0) return '0p';
  if (mins < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (mins < 60) return `${Math.round(mins)}p`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m > 0 ? `${h}g ${m}p` : `${h}g`;
}

function getTodayIsoDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getDaysAgoIsoDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function StatisticsPage() {
  const ui = useUiState();
  const library = useLibraryState();
  const accent = uiStore.getUserAccentPalette();

  const [range, setRange] = useState<StatisticsTimeRange>('week');
  const [periodOffset, setPeriodOffset] = useState(0);
  const [customStartDate, setCustomStartDate] = useState(() => getDaysAgoIsoDate(6));
  const [customEndDate, setCustomEndDate] = useState(() => getTodayIsoDate());
  const [dashboard, setDashboard] = useState<StatisticsDashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showRuleHint, setShowRuleHint] = useState(false);
  const [hoveredDayIndex, setHoveredDayIndex] = useState<number | null>(null);
  const [hoveredHourIndex, setHoveredHourIndex] = useState<number | null>(null);

  const query = useMemo<StatisticsQuery>(
    () => ({
      range,
      periodOffset,
      customStartDate: range === 'custom' ? customStartDate : undefined,
      customEndDate: range === 'custom' ? customEndDate : undefined,
    }),
    [range, periodOffset, customStartDate, customEndDate],
  );

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void uiStore
      .getListeningStatistics(query)
      .then((res) => {
        if (!cancelled) {
          setDashboard(res);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [query, ui.statsVersion]);

  const handleSelectRange = (nextRange: StatisticsTimeRange) => {
    setRange(nextRange);
    setPeriodOffset(0);
    setHoveredDayIndex(null);
    setHoveredHourIndex(null);
  };

  const handlePlayTopTrack = (trackId: string, isDeleted: boolean) => {
    if (isDeleted) {
      uiStore.showToast('Bài hát này đã bị xóa khỏi thư viện hiện tại.');
      return;
    }
    const local = library.tracks.find((t) => t.id === trackId);
    if (local) {
      void uiStore.playLocalElectronTrack(local);
      return;
    }
    uiStore.playSampleTrack(trackId);
  };

  const maxDayMs = useMemo(() => {
    if (!dashboard || dashboard.byDay.length === 0) return 1;
    return Math.max(...dashboard.byDay.map((d) => d.listenedMs), 1);
  }, [dashboard]);

  const maxHourMs = useMemo(() => {
    if (!dashboard || dashboard.byHour.length === 0) return 1;
    return Math.max(...dashboard.byHour.map((h) => h.listenedMs), 1);
  }, [dashboard]);

  const peakHour = useMemo(() => {
    if (!dashboard) return null;
    const best = dashboard.byHour.reduce(
      (acc, cur) => (cur.listenedMs > acc.listenedMs ? cur : acc),
      dashboard.byHour[0],
    );
    return best && best.listenedMs > 0 ? best : null;
  }, [dashboard]);

  const canNavigatePeriod = range !== 'all' && range !== 'custom';

  return (
    <div
      data-testid="statistics-page"
      className="mx-auto w-full max-w-[1360px] space-y-6 pb-36"
    >
      {/* Header + Time Range Bar */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.16em] text-[var(--text-muted)] uppercase">
            Lịch sử nghe cục bộ
          </p>
          <h1 className="font-display mt-1 text-[30px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
            Thống kê nghe nhạc
          </h1>
        </div>

        {/* 6 Time Range Tabs */}
        <div
          role="tablist"
          aria-label="Khoảng thời gian thống kê"
          className="lp-glass-subtle flex flex-wrap items-center gap-1 rounded-full p-1"
        >
          {TIME_RANGES.map((item) => {
            const active = range === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                data-testid={`stats-range-${item.id}`}
                aria-selected={active}
                onClick={() => handleSelectRange(item.id)}
                className={`rounded-full px-3.5 py-1.5 text-[12px] font-medium transition ${
                  active
                    ? 'shadow-sm'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
                style={
                  active
                    ? { backgroundColor: accent.activeHex, color: accent.onAccentText }
                    : undefined
                }
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Period Navigation & Custom Range Controls */}
      <div className="lp-glass-panel flex flex-wrap items-center justify-between gap-3 rounded-[20px] px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Calendar className="h-4 w-4 text-[var(--text-muted)]" />
          <span
            data-testid="stats-period-label"
            className="text-[13.5px] font-semibold text-[var(--text-primary)]"
          >
            {dashboard?.periodLabel ?? 'Đang tải...'}
          </span>
        </div>

        {range === 'custom' ? (
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <label className="flex items-center gap-1.5 text-[var(--text-secondary)]">
              <span>Từ</span>
              <input
                type="date"
                data-testid="stats-custom-start"
                value={customStartDate}
                max={customEndDate}
                onChange={(e) => setCustomStartDate(e.target.value)}
                className="lp-surface-input h-8 rounded-lg px-2.5 text-[12px] focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[var(--text-secondary)]">
              <span>Đến</span>
              <input
                type="date"
                data-testid="stats-custom-end"
                value={customEndDate}
                min={customStartDate}
                max={getTodayIsoDate()}
                onChange={(e) => setCustomEndDate(e.target.value)}
                className="lp-surface-input h-8 rounded-lg px-2.5 text-[12px] focus:outline-none"
              />
            </label>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            {canNavigatePeriod && (
              <>
                <button
                  type="button"
                  data-testid="stats-prev-period"
                  onClick={() => setPeriodOffset((o) => o - 1)}
                  aria-label="Kỳ trước"
                  className="lp-btn-ghost flex h-8 items-center gap-1 rounded-full px-3 text-[12px] font-medium"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  <span>Trước</span>
                </button>
                {periodOffset < 0 && (
                  <button
                    type="button"
                    onClick={() => setPeriodOffset(0)}
                    className="lp-btn-ghost flex h-8 items-center rounded-full px-3 text-[11.5px] font-medium"
                  >
                    Hiện tại
                  </button>
                )}
                <button
                  type="button"
                  data-testid="stats-next-period"
                  disabled={!dashboard?.canStepForward}
                  onClick={() => setPeriodOffset((o) => Math.min(0, o + 1))}
                  aria-label="Kỳ sau"
                  className="lp-btn-ghost flex h-8 items-center gap-1 rounded-full px-3 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span>Sau</span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </>
            )}

            <div className="relative ml-1">
              <button
                type="button"
                onClick={() => setShowRuleHint((v) => !v)}
                aria-label="Quy tắc tính lượt nghe hợp lệ"
                className="lp-btn-ghost flex h-8 w-8 items-center justify-center rounded-full"
              >
                <HelpCircle className="h-3.5 w-3.5" />
              </button>
              {showRuleHint && (
                <div className="lp-glass-pill absolute top-10 right-0 z-20 w-[300px] rounded-2xl p-3.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                  <p className="font-semibold text-[var(--text-primary)]">
                    Quy tắc tính lượt nghe hợp lệ
                  </p>
                  <p className="mt-1">
                    Bài từ 60 giây trở lên cần nghe thực tế ít nhất 30 giây. Bài dưới 60 giây cần
                    nghe ít nhất 50% thời lượng. Thời gian tạm dừng, đang tải hoặc tua không được
                    cộng vào thống kê.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 4 Real KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="lp-glass-panel rounded-[22px] p-5">
          <div className="flex items-center justify-between text-[var(--text-muted)]">
            <span className="text-[12px] font-medium">Tổng thời gian nghe</span>
            <Clock className="h-4 w-4" style={{ color: accent.activeHex }} />
          </div>
          <p
            data-testid="stats-kpi-time"
            className="font-display tabular-nums mt-3 text-[28px] font-semibold text-[var(--text-primary)]"
          >
            {dashboard ? formatDurationMs(dashboard.totalListenedMs) : '—'}
          </p>
          <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
            Thời gian phát thực tế, không tính tạm dừng
          </p>
        </div>

        <div className="lp-glass-panel rounded-[22px] p-5">
          <div className="flex items-center justify-between text-[var(--text-muted)]">
            <span className="text-[12px] font-medium">Lượt nghe hợp lệ</span>
            <Headphones className="h-4 w-4" style={{ color: accent.activeHex }} />
          </div>
          <p
            data-testid="stats-kpi-plays"
            className="font-display tabular-nums mt-3 text-[28px] font-semibold text-[var(--text-primary)]"
          >
            {dashboard ? dashboard.qualifiedPlays.toLocaleString('vi-VN') : '—'}
          </p>
          <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
            Tối đa 1 lượt hợp lệ mỗi phiên phát
          </p>
        </div>

        <div className="lp-glass-panel rounded-[22px] p-5">
          <div className="flex items-center justify-between text-[var(--text-muted)]">
            <span className="text-[12px] font-medium">Số bài đã nghe</span>
            <Music2 className="h-4 w-4" style={{ color: accent.activeHex }} />
          </div>
          <p
            data-testid="stats-kpi-unique"
            className="font-display tabular-nums mt-3 text-[28px] font-semibold text-[var(--text-primary)]"
          >
            {dashboard ? dashboard.uniqueTracksPlayed.toLocaleString('vi-VN') : '—'}
          </p>
          <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
            Số bài hát khác nhau trong kỳ chọn
          </p>
        </div>

        <div className="lp-glass-panel rounded-[22px] p-5">
          <div className="flex items-center justify-between text-[var(--text-muted)]">
            <span className="text-[12px] font-medium">Trung bình mỗi ngày</span>
            <TrendingUp className="h-4 w-4" style={{ color: accent.activeHex }} />
          </div>
          <p
            data-testid="stats-kpi-avg"
            className="font-display tabular-nums mt-3 text-[28px] font-semibold text-[var(--text-primary)]"
          >
            {dashboard ? formatDurationMs(dashboard.averageDailyMs) : '—'}
          </p>
          <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
            Tính theo múi giờ cục bộ trên máy
          </p>
        </div>
      </div>

      {/* Empty State when no real listening history exists in this window */}
      {!isLoading && dashboard && !dashboard.hasAnyData ? (
        <section
          data-testid="stats-empty-state"
          className="lp-glass-panel flex flex-col items-center justify-center rounded-[26px] px-6 py-16 text-center"
        >
          <div
            className="flex h-14 w-14 items-center justify-center rounded-2xl"
            style={{
              backgroundColor: `rgba(${accent.glowRgb}, 0.14)`,
              color: accent.activeHex,
            }}
          >
            <BarChart3 className="h-7 w-7" />
          </div>
          <h2 className="font-display mt-4 text-[20px] font-semibold text-[var(--text-primary)]">
            Chưa có dữ liệu nghe trong khoảng thời gian này
          </h2>
          <p className="mt-1.5 max-w-[460px] text-[13px] leading-relaxed text-[var(--text-secondary)]">
            Thống kê của DoReMi được ghi nhận hoàn toàn từ lịch sử phát nhạc thực tế trên thiết bị
            của bạn. Hãy phát một bài hát từ thư viện để bắt đầu ghi nhận.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
            <button
              type="button"
              onClick={() => uiStore.openLibraryTab('songs')}
              className="flex h-10 items-center gap-2 rounded-full px-5 text-[13px] font-semibold shadow-sm transition hover:opacity-90"
              style={{ backgroundColor: accent.activeHex, color: accent.onAccentText }}
            >
              <Library className="h-4 w-4" />
              Mở Thư viện nhạc
            </button>
            {range !== 'all' && (
              <button
                type="button"
                onClick={() => handleSelectRange('all')}
                className="lp-btn-ghost flex h-10 items-center gap-2 rounded-full px-5 text-[13px] font-medium"
              >
                Xem toàn thời gian
              </button>
            )}
          </div>
        </section>
      ) : dashboard ? (
        <>
          {/* Charts Row: Listening by Day & by Hour */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Listening by Day */}
            <section className="lp-glass-panel rounded-[24px] p-6">
              <div className="mb-5 flex items-baseline justify-between gap-2">
                <div>
                  <h2 className="font-display text-[17px] font-semibold text-[var(--text-primary)]">
                    Thời lượng nghe theo ngày
                  </h2>
                  <p className="text-[12px] text-[var(--text-muted)]">
                    {hoveredDayIndex !== null && dashboard.byDay[hoveredDayIndex]
                      ? `${dashboard.byDay[hoveredDayIndex].label} · ${formatDurationMs(dashboard.byDay[hoveredDayIndex].listenedMs)} · ${dashboard.byDay[hoveredDayIndex].qualifiedPlays} lượt hợp lệ`
                      : 'Di chuột lên cột để xem chi tiết từng ngày'}
                  </p>
                </div>
              </div>

              <div className="flex h-[196px] items-end gap-1.5 pt-4">
                {dashboard.byDay.map((entry, idx) => {
                  const ratio = entry.listenedMs / maxDayMs;
                  const heightPct = entry.listenedMs > 0 ? Math.max(8, Math.round(ratio * 100)) : 2;
                  const showLabel =
                    dashboard.byDay.length <= 12 ||
                    idx === 0 ||
                    idx === dashboard.byDay.length - 1 ||
                    idx % Math.ceil(dashboard.byDay.length / 7) === 0;
                  return (
                    <div
                      key={entry.dateKey}
                      onMouseEnter={() => setHoveredDayIndex(idx)}
                      onMouseLeave={() => setHoveredDayIndex(null)}
                      title={`${entry.label}: ${formatDurationMs(entry.listenedMs)} (${entry.qualifiedPlays} lượt)`}
                      className="group flex flex-1 flex-col items-center gap-2"
                    >
                      <span className="font-mono-tabular h-4 text-[10.5px] text-[var(--text-secondary)]">
                        {entry.listenedMs > 0 && dashboard.byDay.length <= 10
                          ? formatCompactMinutes(entry.listenedMs)
                          : ''}
                      </span>
                      <div className="flex h-[136px] w-full items-end justify-center">
                        <div
                          className="w-full max-w-[34px] rounded-t-lg transition-all duration-300 group-hover:brightness-110"
                          style={{
                            height: `${heightPct}%`,
                            background:
                              entry.listenedMs > 0
                                ? `linear-gradient(180deg, ${accent.activeHex} 0%, rgba(${accent.glowRgb}, 0.30) 100%)`
                                : 'var(--border-subtle)',
                          }}
                        />
                      </div>
                      <span className="h-4 truncate text-[10.5px] font-medium text-[var(--text-muted)]">
                        {showLabel ? entry.label : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Listening by Hour (0h - 23h) */}
            <section className="lp-glass-panel rounded-[24px] p-6">
              <div className="mb-5 flex items-baseline justify-between gap-2">
                <div>
                  <h2 className="font-display text-[17px] font-semibold text-[var(--text-primary)]">
                    Phân bố theo khung giờ (0h–23h)
                  </h2>
                  <p className="text-[12px] text-[var(--text-muted)]">
                    {hoveredHourIndex !== null && dashboard.byHour[hoveredHourIndex]
                      ? `${dashboard.byHour[hoveredHourIndex].label} · ${formatDurationMs(dashboard.byHour[hoveredHourIndex].listenedMs)}`
                      : peakHour
                        ? `Cao điểm lúc ${peakHour.label} (${formatDurationMs(peakHour.listenedMs)})`
                        : 'Ghi nhận theo giờ địa phương'}
                  </p>
                </div>
              </div>

              <div className="flex h-[196px] items-end gap-1 pt-4">
                {dashboard.byHour.map((entry, idx) => {
                  const ratio = entry.listenedMs / maxHourMs;
                  const heightPct = entry.listenedMs > 0 ? Math.max(8, Math.round(ratio * 100)) : 2;
                  const showLabel = idx % 3 === 0 || idx === 23;
                  return (
                    <div
                      key={entry.hour}
                      onMouseEnter={() => setHoveredHourIndex(idx)}
                      onMouseLeave={() => setHoveredHourIndex(null)}
                      title={`${entry.label}: ${formatDurationMs(entry.listenedMs)}`}
                      className="group flex flex-1 flex-col items-center gap-2"
                    >
                      <div className="flex h-[152px] w-full items-end justify-center">
                        <div
                          className="w-full rounded-t-md transition-all duration-300 group-hover:brightness-110"
                          style={{
                            height: `${heightPct}%`,
                            background:
                              entry.listenedMs > 0
                                ? `linear-gradient(180deg, ${accent.activeHex} 0%, rgba(${accent.glowRgb}, 0.28) 100%)`
                                : 'var(--border-subtle)',
                          }}
                        />
                      </div>
                      <span className="font-mono-tabular h-4 text-[10px] text-[var(--text-muted)]">
                        {showLabel ? entry.label : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          {/* Top 5 Tracks + Top Artists & Deleted Group */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.25fr_1fr]">
            <section className="lp-glass-panel rounded-[24px] p-6">
              <h2 className="font-display mb-4 text-[17px] font-semibold text-[var(--text-primary)]">
                Top 5 bài hát nghe nhiều nhất
              </h2>
              {dashboard.topTracks.length === 0 ? (
                <p className="py-8 text-center text-[13px] text-[var(--text-muted)]">
                  Chưa có bài hát nào trong kỳ này.
                </p>
              ) : (
                <div className="space-y-2">
                  {dashboard.topTracks.map((song, index) => {
                    const coverUrl = song.isDeleted
                      ? DEFAULT_DOREMI_ARTWORK_URL
                      : uiStore.getCoverForTrack(song.trackId, 'thumb');
                    return (
                      <button
                        key={song.trackId}
                        type="button"
                        onClick={() => handlePlayTopTrack(song.trackId, song.isDeleted)}
                        className="group flex w-full items-center gap-3.5 rounded-2xl border border-transparent bg-[var(--surface-glass-light)] px-3.5 py-2.5 text-left transition hover:border-[var(--border-glass)] hover:bg-[var(--surface-hover)]"
                      >
                        <span className="font-mono-tabular w-5 text-center text-[13px] font-semibold text-[var(--text-muted)]">
                          0{index + 1}
                        </span>
                        <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[#101218]">
                          <img
                            src={coverUrl}
                            alt={song.title}
                            onError={(e) => {
                              const img = e.currentTarget;
                              if (img.dataset.fallbackApplied !== '1') {
                                img.dataset.fallbackApplied = '1';
                                img.src = DEFAULT_DOREMI_ARTWORK_URL;
                              }
                            }}
                            className="h-full w-full object-cover"
                          />
                          {!song.isDeleted && (
                            <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition group-hover:opacity-100">
                              <Play className="h-3.5 w-3.5 fill-white text-white" />
                            </span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-[14px] font-medium text-[var(--text-primary)]">
                              {song.title}
                            </p>
                            {song.isDeleted && (
                              <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/12 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-200">
                                Bài đã xóa
                              </span>
                            )}
                          </div>
                          <p className="truncate text-[12px] text-[var(--text-muted)]">
                            {song.artist}
                            {song.album ? ` · ${song.album}` : ''}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="font-mono-tabular text-[13px] font-semibold text-[var(--text-primary)]">
                            {song.qualifiedPlays} lượt
                          </p>
                          <p className="font-mono-tabular text-[11px] text-[var(--text-muted)]">
                            {formatDurationMs(song.listenedMs)}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <div className="space-y-6">
              {/* Top Artists */}
              <section className="lp-glass-panel rounded-[24px] p-6">
                <h2 className="font-display mb-4 text-[17px] font-semibold text-[var(--text-primary)]">
                  Top Nghệ sĩ
                </h2>
                {dashboard.topArtists.length === 0 ? (
                  <p className="py-6 text-center text-[13px] text-[var(--text-muted)]">
                    Chưa có dữ liệu nghệ sĩ.
                  </p>
                ) : (
                  <div className="space-y-3.5">
                    {dashboard.topArtists.map((artist) => (
                      <div key={artist.artist} className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2 text-[13px]">
                          <button
                            type="button"
                            onClick={() => uiStore.openArtistDetail(artist.artist)}
                            className="truncate font-medium text-[var(--text-primary)] hover:underline"
                          >
                            {artist.artist}
                          </button>
                          <span className="font-mono-tabular shrink-0 text-[12px] text-[var(--text-secondary)]">
                            {formatDurationMs(artist.listenedMs)} ({artist.sharePct}%)
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--slider-track)]">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${Math.max(4, Math.min(100, artist.sharePct))}%`,
                              backgroundColor: accent.activeHex,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Deleted Songs Summary ("Bài đã xóa") */}
              <section
                data-testid="stats-deleted-group"
                className="lp-glass-panel rounded-[24px] p-5"
              >
                <div className="flex items-start gap-3.5">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] text-[var(--text-secondary)]">
                    <Archive className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
                        Bài đã xóa
                      </h3>
                      <span className="font-mono-tabular text-[12px] text-[var(--text-secondary)]">
                        {dashboard.deletedGroup.uniqueTrackCount} bài ·{' '}
                        {dashboard.deletedGroup.qualifiedPlays} lượt ·{' '}
                        {formatDurationMs(dashboard.deletedGroup.listenedMs)}
                      </span>
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                      {dashboard.deletedGroup.uniqueTrackCount > 0
                        ? 'Các bài hát đã xóa khỏi ổ đĩa hoặc thư viện vẫn được giữ lại tổng thời lượng và lượt nghe để bảo toàn lịch sử.'
                        : 'Chưa có bài hát nào bị xóa trong lịch sử kỳ này.'}
                    </p>
                  </div>
                </div>
              </section>
            </div>
          </div>

          {/* Top Albums */}
          {dashboard.topAlbums.length > 0 && (
            <section className="space-y-3.5">
              <div className="flex items-center gap-2">
                <Disc3 className="h-4 w-4 text-[var(--text-muted)]" />
                <h2 className="font-display text-[18px] font-semibold text-[var(--text-primary)]">
                  Top Album trong kỳ
                </h2>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
                {dashboard.topAlbums.map((album) => {
                  const coverUrl = album.artworkUrl ?? DEFAULT_DOREMI_ARTWORK_URL;
                  return (
                    <div
                      key={`${album.album}-${album.artist}`}
                      className="lp-glass-panel flex items-center gap-3.5 rounded-[20px] p-3.5"
                    >
                      <img
                        src={coverUrl}
                        alt={album.album}
                        onError={(e) => {
                          const img = e.currentTarget;
                          if (img.dataset.fallbackApplied !== '1') {
                            img.dataset.fallbackApplied = '1';
                            img.src = DEFAULT_DOREMI_ARTWORK_URL;
                          }
                        }}
                        className="h-14 w-14 shrink-0 rounded-xl border border-[var(--border-subtle)] object-cover"
                      />
                      <div className="min-w-0">
                        <p className="truncate text-[14px] font-semibold text-[var(--text-primary)]">
                          {album.album}
                        </p>
                        <p className="truncate text-[12px] text-[var(--text-muted)]">
                          {album.artist}
                        </p>
                        <p className="font-mono-tabular mt-0.5 text-[11px] text-[var(--text-secondary)]">
                          {album.qualifiedPlays} lượt · {formatDurationMs(album.listenedMs)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}
