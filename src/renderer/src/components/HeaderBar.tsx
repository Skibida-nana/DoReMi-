import { FolderPlus, FileAudio, RefreshCw, Search, X } from 'lucide-react';
import { libraryStore, useLibraryState } from '../stores/library-store';

export function HeaderBar() {
  const { isElectronAvailable, isScanning, searchQuery } = useLibraryState();
  const actionsDisabled = !isElectronAvailable || isScanning;

  return (
    <header className="flex items-center justify-between gap-6 border-b border-zinc-800/90 bg-zinc-950 px-5 py-3.5 shrink-0">
      <div className="flex items-center gap-6 min-w-0">
        <h1 className="text-base font-semibold tracking-tight text-zinc-100 whitespace-nowrap shrink-0">
          DoReMi
        </h1>

        <div className="relative w-80 max-w-full">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => libraryStore.setSearchQuery(event.target.value)}
            placeholder="Tìm bài hát, nghệ sĩ, album..."
            aria-label="Tìm kiếm trong thư viện"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900/80 py-1.5 pl-9 pr-8 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-sky-500/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => libraryStore.setSearchQuery('')}
              aria-label="Xóa từ khóa tìm kiếm"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:text-zinc-100"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2.5 shrink-0">
        <button
          type="button"
          onClick={() => void libraryStore.importFiles()}
          disabled={actionsDisabled}
          className="inline-flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-xs font-medium text-zinc-100 transition-colors hover:border-zinc-600 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-45 whitespace-nowrap shrink-0"
        >
          <FileAudio className="h-3.5 w-3.5 text-zinc-300" aria-hidden="true" />
          Import Files
        </button>

        <button
          type="button"
          onClick={() => void libraryStore.importFolder()}
          disabled={actionsDisabled}
          className="inline-flex items-center gap-2 rounded-md bg-sky-500 px-3.5 py-2 text-xs font-semibold text-zinc-950 transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-45 whitespace-nowrap shrink-0"
        >
          <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
          Import Folder
        </button>

        <button
          type="button"
          onClick={() => void libraryStore.rescanLibrary()}
          disabled={actionsDisabled}
          className="inline-flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3.5 py-2 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-700 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-45 whitespace-nowrap shrink-0"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${isScanning ? 'animate-spin text-sky-400' : 'text-zinc-400'}`}
            aria-hidden="true"
          />
          Rescan
        </button>
      </div>
    </header>
  );
}
