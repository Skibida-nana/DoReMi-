import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  FileSearch,
  FolderOpen,
  FolderSearch,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import type { LibraryExclusionRecord, WatchedFolderSummary } from '../../../shared/types/library';
import type { RelinkApplySelection, RelinkScanResult } from '../../../shared/types/stage6';
import type { TrackRecord } from '../../../shared/types/track';
import { libraryStore, useLibraryState } from '../stores/library-store';
import { uiStore } from '../stores/ui-store';
import { OverlayPortal } from './OverlayLayer';

export type SourcesModalTab = 'folders' | 'missing' | 'exclusions';

export interface LibrarySourcesAndMissingModalProps {
  initialTab?: SourcesModalTab;
  onClose: () => void;
}

function availabilityLabel(track: TrackRecord): { text: string; tone: string } {
  const st = track.availability_state ?? track.status;
  if (st === 'source_unavailable') {
    return {
      text: 'Nguồn / Ổ đĩa không khả dụng',
      tone: 'border-amber-500/35 bg-amber-500/15 text-amber-600 dark:text-amber-200',
    };
  }
  if (st === 'access_error') {
    return {
      text: 'Lỗi quyền truy cập',
      tone: 'border-rose-500/35 bg-rose-500/15 text-rose-600 dark:text-rose-200',
    };
  }
  return {
    text: 'Thiếu file gốc',
    tone: 'border-amber-500/35 bg-amber-500/15 text-amber-600 dark:text-amber-200',
  };
}

export function LibrarySourcesAndMissingModal({
  initialTab = 'folders',
  onClose,
}: LibrarySourcesAndMissingModalProps) {
  const library = useLibraryState();
  const userAccent = uiStore.getUserAccentPalette();
  const [tab, setTab] = useState<SourcesModalTab>(initialTab);
  const [watchedFolders, setWatchedFolders] = useState<WatchedFolderSummary[]>([]);
  const [exclusions, setExclusions] = useState<LibraryExclusionRecord[]>([]);
  const [relinkScan, setRelinkScan] = useState<RelinkScanResult | null>(null);
  const [selectedRelinks, setSelectedRelinks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirmClearAll, setConfirmClearAll] = useState(false);

  const missingTracks = library.tracks.filter(
    (t) => t.status !== 'available' || (t.availability_state ?? t.status) !== 'available',
  );

  const loadAuxLists = async () => {
    const [folders, excl] = await Promise.all([
      libraryStore.listWatchedFolders(),
      libraryStore.listExcludedTracks(),
    ]);
    setWatchedFolders(folders);
    setExclusions(excl);
  };

  useEffect(() => {
    void loadAuxLists();
  }, [library.tracks.length, library.roots.length]);

  const handleSingleRelink = async (trackId: string) => {
    setBusy(true);
    try {
      const res = await libraryStore.relinkSingleTrackDialog(trackId);
      if (res.canceled) return;
      if (res.success && res.track) {
        uiStore.showToast(`Đã liên kết lại "${res.track.title}" (giữ nguyên Playlist & Lịch sử)`);
      } else {
        uiStore.showToast(res.error ?? 'Không thể liên kết lại bài hát.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleScanRelinkFolder = async () => {
    setBusy(true);
    try {
      const scan = await libraryStore.scanRelinkFolder();
      if (scan.canceled) return;
      if (scan.error) {
        uiStore.showToast(scan.error);
        return;
      }
      setRelinkScan(scan);
      const defaults: Record<string, string> = {};
      for (const prop of scan.proposals) {
        if (prop.matchStatus === 'matched' && prop.suggestedPath) {
          defaults[prop.trackId] = prop.suggestedPath;
        }
      }
      setSelectedRelinks(defaults);
    } finally {
      setBusy(false);
    }
  };

  const handleApplyBatchRelink = async () => {
    const selections: RelinkApplySelection[] = Object.entries(selectedRelinks)
      .filter(([, p]) => Boolean(p))
      .map(([trackId, newFilePath]) => ({ trackId, newFilePath }));
    if (selections.length === 0) return;

    setBusy(true);
    try {
      const result = await libraryStore.applyRelink(selections);
      uiStore.showToast(
        `Đã liên kết lại ${result.relinkedCount} bài${
          result.failedCount > 0 ? `, lỗi ${result.failedCount}` : ''
        }`,
      );
      setRelinkScan(null);
      setSelectedRelinks({});
    } finally {
      setBusy(false);
    }
  };

  return (
    <OverlayPortal layer="modal">
      <div className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Quản lý nguồn thư viện & File thiếu"
        data-testid="library-sources-modal"
        className="lp-glass-pill flex max-h-[90vh] w-full max-w-[820px] flex-col overflow-hidden rounded-[26px]"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-6 py-4">
          <div>
            <h2 className="font-display text-[18px] font-semibold text-[var(--text-primary)]">
              Nguồn nhạc, Bài thiếu file & Loại trừ
            </h2>
            <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
              Liên kết lại giữ nguyên Track ID, Playlist, Ảnh bìa tùy chỉnh, Yêu thích và Thống kê nghe.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Sub-Tabs */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-6 py-3">
          {(
            [
              { id: 'folders', label: 'Thư mục nguồn', count: watchedFolders.length },
              { id: 'missing', label: 'Thiếu file & Relink', count: missingTracks.length },
              { id: 'exclusions', label: 'Bài đã loại trừ', count: exclusions.length },
            ] as const
          ).map((item) => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                data-testid={`sources-tab-${item.id}`}
                onClick={() => setTab(item.id)}
                className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold transition ${
                  active ? 'shadow-sm' : 'lp-btn-ghost'
                }`}
                style={
                  active
                    ? { backgroundColor: userAccent.activeHex, color: userAccent.onAccentText }
                    : undefined
                }
              >
                <span>{item.label}</span>
                <span className="font-mono-tabular text-[11px] opacity-80">{item.count}</span>
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {tab === 'folders' && (
            <div className="space-y-4">
              <div className="flex items-start gap-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.08] px-3.5 py-2.5 text-[11.5px] text-emerald-700 dark:text-emerald-200">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Mọi thao tác thêm/gỡ nguồn chỉ thay đổi danh mục trong DoReMi — tuyệt đối không xóa hay di chuyển file nhạc gốc trên ổ cứng.
                </span>
              </div>

              {watchedFolders.length === 0 ? (
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-8 text-center text-[13px] text-[var(--text-muted)]">
                  Chưa có thư mục nguồn nào được gắn kết. Hãy nhấn &ldquo;Thêm thư mục&rdquo; ở thanh công cụ Thư viện.
                </div>
              ) : (
                <div className="space-y-3">
                  {watchedFolders.map((folder) => (
                    <div
                      key={folder.id}
                      className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <FolderOpen className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
                            <p className="truncate text-[13.5px] font-semibold text-[var(--text-primary)]">
                              {folder.original_path}
                            </p>
                            <span
                              className={`rounded-full px-2.5 py-0.5 text-[10.5px] font-medium ${
                                folder.exists
                                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
                                  : 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
                              }`}
                            >
                              {folder.exists ? 'Đang kết nối' : 'Nguồn không khả dụng'}
                            </span>
                          </div>
                          <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
                            {folder.trackCount} bài hát
                            {folder.missingCount ? ` (${folder.missingCount} thiếu file)` : ''}
                            {folder.last_successful_scan_at
                              ? ` · Quét gần nhất: ${new Date(
                                  folder.last_successful_scan_at,
                                ).toLocaleString('vi-VN')}`
                              : ''}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            disabled={library.isScanning || busy}
                            onClick={() => void libraryStore.rescanWatchedFolder(folder.id)}
                            className="lp-btn-ghost inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[11.5px] font-medium"
                          >
                            <RefreshCw className="h-3 w-3" />
                            Quét lại
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void libraryStore.removeWatchedFolder(folder.id, 'stop-watching')
                            }
                            className="lp-btn-ghost inline-flex h-8 items-center rounded-full px-3 text-[11.5px] font-medium"
                          >
                            Bỏ theo dõi
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void libraryStore.removeWatchedFolder(folder.id, 'remove-tracks')
                            }
                            className="inline-flex h-8 items-center rounded-full border border-rose-500/30 bg-rose-500/10 px-3 text-[11.5px] font-medium text-rose-500 hover:bg-rose-500/20"
                          >
                            Gỡ nguồn & bài hát
                          </button>
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-[var(--border-subtle)] pt-2.5 text-[11.5px] text-[var(--text-secondary)]">
                        <label className="flex cursor-pointer items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={folder.recursive !== false}
                            onChange={(e) =>
                              void libraryStore.updateRootSettings(folder.id, {
                                recursive: e.target.checked,
                              })
                            }
                            className="h-3.5 w-3.5 accent-[var(--user-accent)]"
                          />
                          <span>Quét thư mục con</span>
                        </label>
                        <label className="flex cursor-pointer items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={folder.enabled !== false}
                            onChange={(e) =>
                              void libraryStore.updateRootSettings(folder.id, {
                                enabled: e.target.checked,
                              })
                            }
                            className="h-3.5 w-3.5 accent-[var(--user-accent)]"
                          />
                          <span>Bao gồm khi Quét lại toàn bộ</span>
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {library.tracks.length > 0 && (
                <div className="border-t border-[var(--border-subtle)] pt-3">
                  {confirmClearAll ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-2.5 text-[12px]">
                      <span className="text-rose-500 dark:text-rose-300">
                        Xóa toàn bộ bài hát đã nhập khỏi thư viện DoReMi? (File nhạc trên ổ cứng vẫn còn nguyên.)
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setConfirmClearAll(false)}
                          className="lp-btn-ghost rounded-full px-3 py-1"
                        >
                          Hủy
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void libraryStore.clearAllImportedMusic().then(() => {
                              setConfirmClearAll(false);
                              uiStore.showToast('Đã làm sạch thư viện DoReMi');
                            });
                          }}
                          className="rounded-full bg-rose-600 px-3 py-1 font-semibold text-white"
                        >
                          Xác nhận xóa
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmClearAll(true)}
                      className="inline-flex items-center gap-1.5 text-[12px] font-medium text-rose-500 hover:underline"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Xóa toàn bộ dữ liệu thư viện đã nhập...
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {tab === 'missing' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-4">
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                    Liên kết lại hàng loạt theo thư mục mới
                  </p>
                  <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                    Dùng khi bạn đổi tên ổ đĩa (ví dụ D:\ sang E:\) hoặc chuyển cả thư mục nhạc sang vị trí mới.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy || missingTracks.length === 0}
                  data-testid="batch-relink-scan-btn"
                  onClick={() => void handleScanRelinkFolder()}
                  style={{
                    backgroundColor: userAccent.activeHex,
                    color: userAccent.onAccentText,
                  }}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[12px] font-semibold transition hover:brightness-110 disabled:opacity-45"
                >
                  <FolderSearch className="h-3.5 w-3.5" />
                  Chọn thư mục để tìm...
                </button>
              </div>

              {relinkScan && (
                <div className="space-y-3 rounded-2xl border border-[var(--border-glass)] bg-[var(--surface-glass-light)] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                      Kết quả đối chiếu tại: {relinkScan.folderPath}
                    </p>
                    <p className="text-[11.5px] text-[var(--text-secondary)]">
                      Khớp chắc chắn: {relinkScan.matchedCount} · Nghi ngờ: {relinkScan.ambiguousCount} · Trùng: {relinkScan.conflictCount ?? 0} · Chưa thấy: {relinkScan.unmatchedCount}
                    </p>
                  </div>

                  <div className="max-h-[240px] space-y-2 overflow-y-auto pr-1">
                    {relinkScan.proposals.map((prop) => {
                      const chosen = selectedRelinks[prop.trackId] ?? '';
                      return (
                        <div
                          key={prop.trackId}
                          className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                                {prop.title} — {prop.artist}
                              </p>
                              <p className="font-mono-tabular truncate text-[11px] text-[var(--text-muted)]">
                                Cũ: {prop.previousPath}
                              </p>
                            </div>
                            <span className="rounded-full bg-[var(--surface-hover)] px-2.5 py-0.5 text-[10.5px] font-semibold">
                              {prop.matchStatus === 'matched'
                                ? 'Khớp chắc chắn'
                                : prop.matchStatus === 'conflict'
                                  ? 'Trùng đường dẫn'
                                  : prop.matchStatus === 'ambiguous'
                                    ? 'Nhiều ứng viên'
                                    : 'Không tìm thấy'}
                            </span>
                          </div>

                          {prop.conflictReason && (
                            <p className="mt-1.5 text-[11px] text-rose-500">
                              {prop.conflictReason}
                            </p>
                          )}

                          {prop.candidates.length > 0 && (
                            <select
                              value={chosen}
                              onChange={(e) =>
                                setSelectedRelinks((prev) => ({
                                  ...prev,
                                  [prop.trackId]: e.target.value,
                                }))
                              }
                              className="lp-surface-input mt-2 h-8 w-full rounded-lg px-2.5 text-[11.5px] outline-none"
                            >
                              <option value="">-- Không áp dụng cho bài này --</option>
                              {prop.candidates.map((cand) => (
                                <option key={cand.filePath} value={cand.filePath}>
                                  [{cand.score}đ] {cand.relativePath}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setRelinkScan(null)}
                      className="lp-btn-ghost rounded-full px-3.5 py-1.5 text-[12px]"
                    >
                      Đóng xem trước
                    </button>
                    <button
                      type="button"
                      disabled={
                        busy || Object.values(selectedRelinks).filter(Boolean).length === 0
                      }
                      data-testid="batch-relink-apply-btn"
                      onClick={() => void handleApplyBatchRelink()}
                      style={{
                        backgroundColor: userAccent.activeHex,
                        color: userAccent.onAccentText,
                      }}
                      className="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-semibold disabled:opacity-45"
                    >
                      <Check className="h-3.5 w-3.5" />
                      Áp dụng liên kết ({Object.values(selectedRelinks).filter(Boolean).length})
                    </button>
                  </div>
                </div>
              )}

              {missingTracks.length === 0 ? (
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-8 text-center text-[13px] text-[var(--text-muted)]">
                  Tất cả bài hát trong thư viện hiện đều sẵn sàng phát.
                </div>
              ) : (
                <div className="space-y-2">
                  {missingTracks.map((track) => {
                    const badge = availabilityLabel(track);
                    return (
                      <div
                        key={track.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-3.5"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                            <p className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">
                              {track.title} — {track.artist}
                            </p>
                            <span className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${badge.tone}`}>
                              {badge.text}
                            </span>
                          </div>
                          <p className="font-mono-tabular mt-1 truncate text-[11px] text-[var(--text-muted)]">
                            {track.original_path}
                          </p>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleSingleRelink(track.id)}
                            className="lp-btn-ghost inline-flex h-8 items-center gap-1 rounded-full px-3 text-[11.5px] font-medium"
                          >
                            <FileSearch className="h-3.5 w-3.5" />
                            Chọn file...
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void libraryStore.removeTracks([track.id], { addExclusion: true })
                            }
                            className="inline-flex h-8 items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-3 text-[11.5px] font-medium text-rose-500 hover:bg-rose-500/20"
                          >
                            <Trash2 className="h-3 w-3" />
                            Xóa khỏi thư viện
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tab === 'exclusions' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[12.5px] text-[var(--text-secondary)]">
                  Các bài bạn đã chủ động xóa khỏi Thư viện sẽ nằm tại đây để Quét lại (Rescan) không tự động nhập lại.
                </p>
                {exclusions.length > 0 && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          const res = await libraryStore.reimportExcludedTracks();
                          await loadAuxLists();
                          uiStore.showToast(
                            `Đã nhập lại ${res?.reimportedCount ?? 0} bài hát`,
                          );
                        } finally {
                          setBusy(false);
                        }
                      }}
                      className="lp-btn-ghost rounded-full px-3 py-1.5 text-[11.5px] font-medium"
                    >
                      <RotateCcw className="mr-1 inline h-3 w-3" />
                      Nhập lại tất cả
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        await libraryStore.clearExclusions();
                        await loadAuxLists();
                      }}
                      className="lp-btn-ghost rounded-full px-3 py-1.5 text-[11.5px] font-medium"
                    >
                      Xóa danh sách loại trừ
                    </button>
                  </div>
                )}
              </div>

              {exclusions.length === 0 ? (
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-8 text-center text-[13px] text-[var(--text-muted)]">
                  Chưa có bài hát nào bị loại trừ khỏi thư viện.
                </div>
              ) : (
                <div className="space-y-2">
                  {exclusions.map((item) => (
                    <div
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-3.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                          {item.title || 'Không rõ tên'} — {item.artist || 'Unknown Artist'}
                        </p>
                        <p className="font-mono-tabular truncate text-[11px] text-[var(--text-muted)]">
                          {item.original_path}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={async () => {
                            await libraryStore.reimportExcludedTracks([item.id]);
                            await loadAuxLists();
                          }}
                          className="lp-btn-ghost rounded-full px-3 py-1 text-[11.5px] font-medium"
                        >
                          Nhập lại
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={async () => {
                            await libraryStore.clearExclusions([item.id]);
                            await loadAuxLists();
                          }}
                          className="lp-btn-ghost rounded-full px-2.5 py-1 text-[11.5px] text-[var(--text-muted)]"
                        >
                          Bỏ loại trừ
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
    </OverlayPortal>
  );
}
