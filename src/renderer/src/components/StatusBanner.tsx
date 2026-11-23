import { useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Info, Loader2, X } from 'lucide-react';
import { libraryStore, useLibraryState } from '../stores/library-store';

export function StatusBanner() {
  const { isElectronAvailable, isScanning, scanProgress, lastSummary, runtimeError } =
    useLibraryState();
  const [errorsExpanded, setErrorsExpanded] = useState(false);

  return (
    <div className="space-y-2.5 px-5 pt-4 empty:hidden">
      {!isElectronAvailable && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-md border border-amber-500/35 bg-amber-950/30 px-4 py-3 text-sm text-amber-100"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-medium text-amber-200">
              Đang mở giao diện Renderer ngoài môi trường Electron Desktop
            </p>
            <p className="text-xs leading-relaxed text-amber-200/80">
              Các tính năng đọc ổ đĩa cục bộ, cơ sở dữ liệu SQLite (better-sqlite3) và phát file
              FLAC/MP3/WAV trực tiếp chỉ hoạt động khi chạy ứng dụng bằng lệnh{' '}
              <code className="font-mono-tabular text-amber-100">npm run dev</code> hoặc mở file EXE
              trên Windows.
            </p>
          </div>
        </div>
      )}

      {runtimeError && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-md border border-rose-500/40 bg-rose-950/35 px-4 py-3 text-sm text-rose-100"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
            <p className="text-xs leading-relaxed">{runtimeError}</p>
          </div>
          <button
            type="button"
            onClick={() => libraryStore.dismissSummary()}
            aria-label="Đóng thông báo lỗi"
            className="rounded p-1 text-rose-300 hover:bg-rose-900/40 hover:text-rose-100"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {isScanning && scanProgress && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-zinc-800 bg-zinc-900/80 px-4 py-3"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5 min-w-0">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-sky-400" aria-hidden="true" />
              <p className="truncate text-xs font-medium text-zinc-100">{scanProgress.message}</p>
            </div>
            {scanProgress.total > 0 && (
              <span className="font-mono-tabular text-xs text-zinc-400 shrink-0">
                {scanProgress.current} / {scanProgress.total}
              </span>
            )}
          </div>
          {scanProgress.total > 0 && (
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full bg-sky-400 transition-[width] duration-150"
                style={{
                  width: `${Math.min(100, Math.round((scanProgress.current / scanProgress.total) * 100))}%`,
                }}
              />
            </div>
          )}
          {scanProgress.currentPath && (
            <p className="mt-1.5 truncate text-[11px] text-zinc-500">{scanProgress.currentPath}</p>
          )}
        </div>
      )}

      {!isScanning && lastSummary && (
        <div
          role="status"
          className="rounded-md border border-zinc-800 bg-zinc-900/70 px-4 py-3 text-xs text-zinc-200"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
              <span className="font-medium text-zinc-100">Kết quả quét thư viện:</span>
              <span className="text-zinc-300">
                Thêm mới <span className="font-mono-tabular font-medium">{lastSummary.addedCount}</span>
              </span>
              <span aria-hidden="true" className="text-zinc-600">
                ·
              </span>
              <span className="text-zinc-300">
                Cập nhật <span className="font-mono-tabular font-medium">{lastSummary.updatedCount}</span>
              </span>
              <span aria-hidden="true" className="text-zinc-600">
                ·
              </span>
              <span className="text-zinc-400">
                Không đổi <span className="font-mono-tabular">{lastSummary.skippedCount}</span>
              </span>
              {lastSummary.recoveredCount > 0 && (
                <>
                  <span aria-hidden="true" className="text-zinc-600">
                    ·
                  </span>
                  <span className="text-emerald-400">
                    Khôi phục <span className="font-mono-tabular font-medium">{lastSummary.recoveredCount}</span>
                  </span>
                </>
              )}
              {lastSummary.missingMarkedCount > 0 && (
                <>
                  <span aria-hidden="true" className="text-zinc-600">
                    ·
                  </span>
                  <span className="text-amber-400">
                    Đánh dấu thiếu <span className="font-mono-tabular font-medium">{lastSummary.missingMarkedCount}</span>
                  </span>
                </>
              )}
              {lastSummary.errors.length > 0 && (
                <>
                  <span aria-hidden="true" className="text-zinc-600">
                    ·
                  </span>
                  <span className="text-rose-400">
                    Lỗi <span className="font-mono-tabular font-medium">{lastSummary.errors.length}</span>
                  </span>
                </>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {lastSummary.errors.length > 0 && (
                <button
                  type="button"
                  onClick={() => setErrorsExpanded((prev) => !prev)}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-rose-300 hover:bg-zinc-800"
                >
                  {errorsExpanded ? 'Ẩn chi tiết lỗi' : 'Xem chi tiết lỗi'}
                  {errorsExpanded ? (
                    <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => libraryStore.dismissSummary()}
                aria-label="Đóng tóm tắt quét"
                className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>

          {errorsExpanded && lastSummary.errors.length > 0 && (
            <ul className="mt-3 max-h-40 space-y-1.5 overflow-y-auto border-t border-zinc-800 pt-2.5 text-[11px]">
              {lastSummary.errors.map((err, idx) => (
                <li key={`${err.path}-${idx}`} className="flex flex-col gap-0.5 text-rose-200/90">
                  {err.path && (
                    <span className="truncate font-mono-tabular text-zinc-400">{err.path}</span>
                  )}
                  <span>{err.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
