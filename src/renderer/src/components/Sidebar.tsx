import {
  BarChart3,
  Disc3,
  Heart,
  Home,
  Library,
  Search,
  Settings,
} from 'lucide-react';
import { uiStore, useUiState, type AppRoute } from '../stores/ui-store';
import { ProfileAvatar } from './ProfileAvatar';

interface NavItem {
  id: string;
  label: string;
  icon: typeof Home;
  isActive: (route: AppRoute, libraryTab: string) => boolean;
  onClick: () => void;
}

export function Sidebar() {
  const ui = useUiState();
  const userAccent = uiStore.getUserAccentPalette();
  const isProfileActive = ui.route === 'profile';

  const primaryItems: NavItem[] = [
    {
      id: 'home',
      label: 'Trang chủ — Playlist Gallery',
      icon: Home,
      isActive: (route) => route === 'home' || route === 'playlist-detail',
      onClick: () => uiStore.navigate('home'),
    },
    {
      id: 'library',
      label: 'Thư viện nhạc',
      icon: Library,
      isActive: (route, tab) =>
        (route === 'library' && tab !== 'favorites') ||
        route === 'album-detail' ||
        route === 'artist-detail',
      onClick: () => uiStore.openLibraryTab('songs'),
    },
    {
      id: 'search',
      label: 'Tìm kiếm nhạc',
      icon: Search,
      isActive: (route) => route === 'search',
      onClick: () => uiStore.navigate('search'),
    },
    {
      id: 'favorites',
      label: 'Yêu thích',
      icon: Heart,
      isActive: (route, tab) => route === 'library' && tab === 'favorites',
      onClick: () => uiStore.openLibraryTab('favorites'),
    },
    {
      id: 'statistics',
      label: 'Thống kê nghe nhạc',
      icon: BarChart3,
      isActive: (route) => route === 'statistics',
      onClick: () => uiStore.navigate('statistics'),
    },
  ];

  const utilityItems: NavItem[] = [
    {
      id: 'now-playing',
      label: 'Màn hình đang phát',
      icon: Disc3,
      isActive: (route) => route === 'now-playing',
      onClick: () => uiStore.openNowPlaying(),
    },
    {
      id: 'settings',
      label: 'Cài đặt',
      icon: Settings,
      isActive: (route) => route === 'settings',
      onClick: () => uiStore.navigate('settings'),
    },
  ];

  return (
    <aside
      aria-label="Điều hướng chính"
      className="relative z-30 flex w-[76px] shrink-0 flex-col items-center border-r border-[var(--border-subtle)] bg-[var(--surface-glass-strong)] py-4 backdrop-blur-2xl"
    >
      {/* M5.2 Top-Left Circular User Profile Avatar (opens unified Profile & Personalization Hub) */}
      <button
        type="button"
        onClick={() => uiStore.openProfileHub()}
        title={`${ui.profile.displayName} — Hồ sơ & Cá nhân hóa`}
        aria-label={`Mở Hồ sơ & Cá nhân hóa (${ui.profile.displayName})`}
        aria-current={isProfileActive ? 'page' : undefined}
        data-testid="sidebar-profile-avatar-btn"
        style={
          isProfileActive
            ? {
                boxShadow: `0 0 0 2px var(--bg-base), 0 0 0 4px ${userAccent.activeHex}`,
              }
            : undefined
        }
        className="group relative mb-7 rounded-full transition-transform duration-200 hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <ProfileAvatar
          profile={ui.profile}
          sizePx={44}
          accentHex={userAccent.activeHex}
          pauseAnimatedGif={
            ui.preferences.reducedMotion && ui.preferences.reduceMotionStaticGif
          }
        />
      </button>

      {/* Primary Navigation Icons */}
      <nav className="flex flex-1 flex-col items-center gap-2.5">
        {primaryItems.map((item) => {
          const Icon = item.icon;
          const active = item.isActive(ui.route, ui.libraryTab);
          return (
            <button
              key={item.id}
              type="button"
              onClick={item.onClick}
              title={item.label}
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              data-testid={`sidebar-nav-${item.id}`}
              className={`group relative flex h-11 w-11 items-center justify-center rounded-2xl transition-all duration-200 ${
                active
                  ? 'border border-[var(--border-glass)] bg-[var(--surface-hover)] text-[var(--text-primary)] shadow-sm'
                  : 'border border-transparent text-[var(--text-muted)] hover:bg-[var(--surface-glass-light)] hover:text-[var(--text-primary)]'
              }`}
            >
              {active && (
                <span
                  className="absolute -left-[15px] h-5 w-1 rounded-r-full transition-colors duration-300"
                  style={{ backgroundColor: userAccent.activeHex }}
                />
              )}
              <Icon className="h-[19px] w-[19px]" strokeWidth={active ? 2.1 : 1.75} />
            </button>
          );
        })}
      </nav>

      {/* Utility Navigation (Now Playing & Settings — Storyboard removed) */}
      <div className="flex flex-col items-center gap-2 border-t border-[var(--border-subtle)] pt-4">
        {utilityItems.map((item) => {
          const Icon = item.icon;
          const active = item.isActive(ui.route, ui.libraryTab);
          return (
            <button
              key={item.id}
              type="button"
              onClick={item.onClick}
              title={item.label}
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              data-testid={`sidebar-nav-${item.id}`}
              className={`group relative flex h-11 w-11 items-center justify-center rounded-2xl transition-all duration-200 ${
                active
                  ? 'border border-[var(--border-glass)] bg-[var(--surface-hover)] text-[var(--text-primary)]'
                  : 'border border-transparent text-[var(--text-muted)] hover:bg-[var(--surface-glass-light)] hover:text-[var(--text-primary)]'
              }`}
            >
              {active && (
                <span
                  className="absolute -left-[15px] h-5 w-1 rounded-r-full transition-colors duration-300"
                  style={{ backgroundColor: userAccent.activeHex }}
                />
              )}
              <Icon className="h-[19px] w-[19px]" strokeWidth={active ? 2.1 : 1.75} />
            </button>
          );
        })}
      </div>
    </aside>
  );
}
