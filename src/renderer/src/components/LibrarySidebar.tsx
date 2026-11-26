import { AlertTriangle, Folder, HardDrive } from 'lucide-react';
import {
  libraryStore,
  useLibraryState,
  type TrackFilterMode,
} from '../stores/library-store';

export function LibrarySidebar() {
  const { tracks, roots, filterMode, databasePath } = useLibraryState();

  const totalCount = tracks.length;
  const availableCount = tracks.filter((t) => t.status === 'available').length;
  const missingCount = tracks.filter((t) => t.status !== 'available').length;

  const filters: Array<{ id: TrackFilterMode; label: string; count: number }> = [
    { id: 'all', label: 'Tất cả bài hát', count: totalCount },
    { id: 'available', label: 'Sẵn sàng phát', count: availableCount },
    { id: 'missing', label: 'Thiếu file / Lỗi', count: missingCount },
  ];

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800/90 bg-zinc-950/90">
      <div className="p-4">
        <p className="mb-2.5 text-xs font-medium text-zinc-400">Thư viện cục bộ</p>
        <nav aria-label="Bộ lọc trạng thái bài hát" className="flex flex-col gap-1">
          {filters.map((item) => {
            const active = filterMode === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => libraryStore.setFilterMode(item.id)}
                className={`flex items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  active
                    ? 'bg-zinc-800/90 font-medium text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                }`}
              >
                <span className="truncate">{item.label}</span>
                <span
                  className={`font-mono-tabular text-xs ${
                    item.id === 'missing' && item.count > 0
                      ? 'text-amber-400'
                      : active
                        ? 'text-zinc-200'
                        : 'text-zinc-500'
                  }`}
                >
                  {item.count}
                </span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="mx-4 border-t border-zinc-800/80" />

      <div className="flex-1 overflow-y-auto p-4">
        <div className="mb-2.5 flex items-center justify-between">
          <p className="text-xs font-medium text-zinc-400">Thư mục nguồn</p>
          <span className="font-mono-tabular text-xs text-zinc-500">{roots.length}</span>
        </div>

        {roots.length === 0 ? (
          <p className="text-xs leading-relaxed text-zinc-500">
            Chưa có thư mục nào được thêm. Nhấn &ldquo;Import Folder&rdquo; để quét nhạc từ ổ đĩa.
          </p>
        ) : (
          <ul className="space-y-2" aria-label="Danh sách thư mục nguồn">
            {roots.map((root) => (
              <li
                key={root.id}
                className="rounded-md border border-zinc-800/80 bg-zinc-900/50 px-2.5 py-2"
                title={root.original_path}
              >
                <div className="flex items-start gap-2">
                  {root.status === 'missing' ? (
                    <AlertTriangle
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400"
                      aria-hidden="true"
                    />
                  ) : (
                    <Folder
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400"
                      aria-hidden="true"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-zinc-200">
                      {extractFolderLabel(root.original_path)}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-zinc-500">
                      {root.original_path}
                    </p>
                    {root.status === 'missing' && (
                      <p className="mt-1 text-[11px] text-amber-400">Thư mục không tồn tại</p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-zinc-800/80 p-4">
        <div className="flex items-start gap-2 text-zinc-500">
          <HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium text-zinc-400">Thư viện cục bộ</p>
            <p
              className="mt-0.5 truncate text-[11px] text-zinc-500"
              title={databasePath || 'Chưa kết nối ứng dụng desktop'}
            >
              {databasePath ? 'Đã sẵn sàng (Offline)' : 'Chạy trên Windows Desktop'}
            </p>
          </div>
        </div>
      </div>
    </aside>
  );
}

function extractFolderLabel(folderPath: string): string {
  const cleaned = folderPath.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? folderPath;
}
