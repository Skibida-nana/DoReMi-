import {
  Disc3,
  ListMusic,
  Minus,
  Search,
  Settings,
  Square,
  X,
} from 'lucide-react';
import { uiStore, useUiState } from '../stores/ui-store';

export function TopHeader() {
  const ui = useUiState();
  const userAccent = uiStore.getUserAccentPalette();

  return (
    <header className="relative z-20 flex h-16 shrink-0 items-center justify-between px-6 sm:px-9">
      {/* Left: Brand Identity */}
      <div className="flex items-center gap-3.5">
        <button
          type="button"
          onClick={() => uiStore.navigate('home')}
          className="flex items-center gap-2.5 text-left transition hover:opacity-90"
        >
          <Disc3
            className="h-5 w-5 transition-colors duration-500"
            style={{ color: userAccent.activeHex }}
            strokeWidth={1.85}
          />
          <span className="font-display text-[15px] font-semibold tracking-[0.12em] text-[var(--text-primary)]">
            DoReMi
          </span>
        </button>

        <span className="hidden h-3.5 w-px bg-[var(--border-glass)] sm:inline-block" />

        <span className="hidden text-[11px] font-medium tracking-[0.06em] text-[var(--text-muted)] sm:inline-block">
          Offline Windows Hi-Res Audio
        </span>
      </div>

      {/* Right: Utility Controls (Vinyl Storyboard removed) */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => uiStore.navigate('search')}
          title="Tìm kiếm nhạc"
          aria-label="Tìm kiếm nhạc"
          className={`flex h-9 items-center gap-2 rounded-full border px-3.5 text-[12px] font-medium transition ${
            ui.route === 'search'
              ? 'border-[var(--border-glass)] bg-[var(--surface-hover)] text-[var(--text-primary)]'
              : 'border-[var(--border-subtle)] bg-[var(--surface-glass-light)] text-[var(--text-secondary)] hover:border-[var(--border-glass)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
          }`}
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden md:inline">Tìm kiếm</span>
        </button>

        <button
          type="button"
          onClick={() => uiStore.toggleQueue()}
          title="Hàng đợi phát"
          aria-label="Mở hàng đợi phát"
          className={`relative flex h-9 w-9 items-center justify-center rounded-full border transition ${
            ui.isQueueOpen
              ? 'border-[var(--border-glass)] bg-[var(--surface-hover)] text-[var(--text-primary)]'
              : 'border-[var(--border-subtle)] bg-[var(--surface-glass-light)] text-[var(--text-secondary)] hover:border-[var(--border-glass)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
          }`}
        >
          <ListMusic className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={() => uiStore.navigate('settings')}
          title="Cài đặt"
          aria-label="Cài đặt"
          className={`flex h-9 w-9 items-center justify-center rounded-full border transition ${
            ui.route === 'settings'
              ? 'border-[var(--border-glass)] bg-[var(--surface-hover)] text-[var(--text-primary)]'
              : 'border-[var(--border-subtle)] bg-[var(--surface-glass-light)] text-[var(--text-secondary)] hover:border-[var(--border-glass)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
          }`}
        >
          <Settings className="h-4 w-4" />
        </button>

        {/* Subtle Windows Desktop Window Controls */}
        <div
          aria-hidden="true"
          className="ml-2 hidden items-center gap-0.5 border-l border-[var(--border-subtle)] pl-3 text-[var(--text-muted)] md:flex"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]">
            <Minus className="h-3.5 w-3.5" />
          </span>
          <span className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]">
            <Square className="h-2.5 w-2.5" />
          </span>
          <span className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-rose-500/20 hover:text-rose-400">
            <X className="h-3.5 w-3.5" />
          </span>
        </div>
      </div>
    </header>
  );
}
