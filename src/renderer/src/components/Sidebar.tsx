import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BarChart3,
  Disc3,
  Heart,
  Home,
  Library,
  Search,
  Server,
  Settings,
  SlidersHorizontal,
} from 'lucide-react';
import {
  uiStore,
  useUiState,
  type AppRoute,
} from '../stores/ui-store';
import {
  OVERLAY_LEAVE_HIDE_DELAY_MS,
  STANDARD_ENTRY_IDLE_HIDE_MS,
  resolveSidebarAutoHideMode,
  resolveSidebarRevealedOnTransition,
  useUiAnimationPolicy,
  type SidebarAutoHideMode,
} from '../utils/animation-policy';
import { ProfileAvatar } from './ProfileAvatar';

export {
  OVERLAY_LEAVE_HIDE_DELAY_MS,
  STANDARD_ENTRY_IDLE_HIDE_MS,
  resolveSidebarAutoHideMode,
  type SidebarAutoHideMode,
};

interface NavItem {
  id: string;
  label: string;
  icon: typeof Home;
  isActive: (route: AppRoute, libraryTab: string) => boolean;
  onClick: () => void;
}

export function Sidebar() {
  const ui = useUiState();
  const policy = useUiAnimationPolicy(ui.preferences);
  const userAccent = uiStore.getUserAccentPalette();
  const isProfileActive = ui.route === 'profile';

  const autoHideMode = resolveSidebarAutoHideMode(ui.route, ui.nowPlayingMode);
  const isOverlayAutoHide = autoHideMode !== 'none';

  const [overlayRevealed, setOverlayRevealed] = useState<boolean>(!isOverlayAutoHide);
  const prevAutoHideModeRef = useRef<SidebarAutoHideMode>(autoHideMode);
  const overlayRevealedRef = useRef<boolean>(overlayRevealed);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPointerInsideRef = useRef(false);
  const wasPointerInDockedSidebarRef = useRef(false);
  const suppressInitialEdgeHoverRef = useRef(false);
  const hasFocusWithinRef = useRef(false);
  const asideRef = useRef<HTMLElement | null>(null);

  const setRevealedSynced = useCallback((next: boolean) => {
    overlayRevealedRef.current = next;
    setOverlayRevealed(next);
    uiStore.setNowPlayingSidebarRevealed(next);
  }, []);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(
    (delayMs: number) => {
      clearHideTimer();
      hideTimerRef.current = setTimeout(() => {
        if (!isPointerInsideRef.current && !hasFocusWithinRef.current) {
          setRevealedSynced(false);
        }
      }, delayMs);
    },
    [clearHideTimer, setRevealedSynced],
  );

  // Clear edge-hover suppression once pointer moves outside the left edge hotspot (> 20px)
  useEffect(() => {
    if (!isOverlayAutoHide) {
      suppressInitialEdgeHoverRef.current = false;
      return;
    }
    const handlePointerMove = (event: PointerEvent) => {
      if (suppressInitialEdgeHoverRef.current && event.clientX > 20) {
        suppressInitialEdgeHoverRef.current = false;
      }
    };
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', handlePointerMove);
  }, [isOverlayAutoHide]);

  // Mode transition lifecycle (Phase 6.1.1 IMP-05):
  // - Leaving Now Playing: restore static docked sidebar.
  // - Entering Standard Now Playing, Lyrics, or Focus Vinyl: hide IMMEDIATELY with zero flash/timer!
  // - If pointer was already inside Sidebar on entry, keep Sidebar hidden until pointer leaves edge & re-enters.
  // - Switching between Focus Vinyl & Now Playing / Lyrics: keep Sidebar hidden uniformly.
  useEffect(() => {
    clearHideTimer();
    isPointerInsideRef.current = false;
    hasFocusWithinRef.current = false;

    const prevMode = prevAutoHideModeRef.current;
    prevAutoHideModeRef.current = autoHideMode;

    if (prevMode === 'none' && autoHideMode !== 'none' && wasPointerInDockedSidebarRef.current) {
      suppressInitialEdgeHoverRef.current = true;
    }
    wasPointerInDockedSidebarRef.current = false;

    const transition = resolveSidebarRevealedOnTransition(
      prevMode,
      autoHideMode,
      overlayRevealedRef.current,
    );

    setRevealedSynced(transition.revealed);
    if (transition.scheduleHideMs !== null) {
      scheduleHide(transition.scheduleHideMs);
    }

    return () => {
      clearHideTimer();
    };
  }, [autoHideMode, clearHideTimer, scheduleHide, setRevealedSynced]);

  // Ensure timers never leak on window unmount
  useEffect(() => {
    return () => {
      clearHideTimer();
    };
  }, [clearHideTimer]);

  // Keyboard toggle support (Alt+M) in BOTH Now Playing & Focus Vinyl
  useEffect(() => {
    if (!isOverlayAutoHide) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && (event.key === 'm' || event.key === 'M')) {
        event.preventDefault();
        clearHideTimer();
        setOverlayRevealed((prev) => {
          const next = !prev;
          uiStore.setNowPlayingSidebarRevealed(next);
          if (next) {
            setTimeout(() => {
              const firstBtn = asideRef.current?.querySelector('button');
              if (firstBtn instanceof HTMLElement) {
                firstBtn.focus();
              }
            }, 20);
          }
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOverlayAutoHide, clearHideTimer]);

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
    {
      id: 'audio-lab',
      label: 'Audio Lab — Equalizer & DSP',
      icon: SlidersHorizontal,
      isActive: (route) => route === 'audio-lab',
      onClick: () => uiStore.navigate('audio-lab'),
    },
    {
      id: 'server',
      label: 'DoReMi Connect — Máy chủ cá nhân & LAN',
      icon: Server,
      isActive: (route) => route === 'server',
      onClick: () => uiStore.navigate('server'),
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

  const isVisible = !isOverlayAutoHide || overlayRevealed;
  const sidebarTransitionCss =
    isOverlayAutoHide && policy.sidebarTransitionMs > 0
      ? `transform ${policy.sidebarTransitionMs}ms cubic-bezier(0.22, 1, 0.36, 1), opacity ${policy.sidebarTransitionMs}ms ease`
      : 'none';

  return (
    <>
      {/* Narrow left-edge hover hotspot strictly in Now Playing / Focus Vinyl */}
      {isOverlayAutoHide && !overlayRevealed && (
        <div
          data-testid="focus-sidebar-edge-trigger"
          aria-hidden="true"
          onMouseEnter={() => {
            if (suppressInitialEdgeHoverRef.current) {
              return;
            }
            clearHideTimer();
            setRevealedSynced(true);
          }}
          onMouseLeave={() => {
            suppressInitialEdgeHoverRef.current = false;
          }}
          className="fixed inset-y-0 left-0 z-35 w-[10px] bg-transparent"
        />
      )}

      {/* Accessible keyboard reveal skip control when Sidebar overlay is hidden */}
      {isOverlayAutoHide && !overlayRevealed && (
        <button
          type="button"
          data-testid="focus-sidebar-kbd-reveal"
          onClick={() => {
            clearHideTimer();
            setRevealedSynced(true);
            setTimeout(() => {
              const firstBtn = asideRef.current?.querySelector('button');
              if (firstBtn instanceof HTMLElement) {
                firstBtn.focus();
              }
            }, 20);
          }}
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-full focus:border focus:border-[var(--border-glass)] focus:bg-[var(--bg-elevated)] focus:px-3.5 focus:py-1.5 focus:text-[12px] focus:font-semibold focus:text-[var(--text-primary)] focus:shadow-lg"
        >
          Mở thanh điều hướng (Alt+M)
        </button>
      )}

      <aside
        ref={asideRef}
        aria-label="Điều hướng chính"
        data-testid="app-sidebar"
        data-autohide-mode={autoHideMode}
        data-focus-autohide={autoHideMode === 'focus-immediate' ? 'true' : 'false'}
        data-revealed={isVisible ? 'true' : 'false'}
        onMouseEnter={() => {
          wasPointerInDockedSidebarRef.current = true;
          if (!isOverlayAutoHide) return;
          isPointerInsideRef.current = true;
          clearHideTimer();
          setRevealedSynced(true);
        }}
        onPointerDownCapture={() => {
          wasPointerInDockedSidebarRef.current = true;
          if (!isOverlayAutoHide) return;
          isPointerInsideRef.current = true;
          clearHideTimer();
        }}
        onMouseLeave={() => {
          wasPointerInDockedSidebarRef.current = false;
          if (!isOverlayAutoHide) return;
          isPointerInsideRef.current = false;
          scheduleHide(OVERLAY_LEAVE_HIDE_DELAY_MS);
        }}
        onFocusCapture={() => {
          if (!isOverlayAutoHide) return;
          hasFocusWithinRef.current = true;
          clearHideTimer();
          setRevealedSynced(true);
        }}
        onBlurCapture={(event) => {
          if (!isOverlayAutoHide) return;
          const nextTarget = event.relatedTarget as Node | null;
          if (nextTarget && asideRef.current?.contains(nextTarget)) {
            return;
          }
          hasFocusWithinRef.current = false;
          scheduleHide(OVERLAY_LEAVE_HIDE_DELAY_MS);
        }}
        style={{
          transform: isVisible ? 'translate3d(0, 0, 0)' : 'translate3d(-100%, 0, 0)',
          opacity: isVisible ? 1 : 0,
          transition: sidebarTransitionCss,
          pointerEvents: isVisible ? 'auto' : 'none',
        }}
        className={`${
          isOverlayAutoHide ? 'fixed inset-y-0 left-0 z-40 shadow-2xl' : 'relative z-30 shrink-0'
        } flex w-[76px] flex-col items-center border-r border-[var(--border-subtle)] bg-[var(--surface-glass-strong)] py-4 backdrop-blur-2xl`}
      >
        {/* Top-Left Circular User Profile Avatar */}
        <button
          type="button"
          onClick={() => uiStore.openProfileHub()}
          title={`${ui.profile.displayName} — Hồ sơ & Cá nhân hóa`}
          aria-label={`Mở Hồ sơ & Cá nhân hóa (${ui.profile.displayName})`}
          aria-current={isProfileActive ? 'page' : undefined}
          tabIndex={isVisible ? 0 : -1}
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
                tabIndex={isVisible ? 0 : -1}
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

        {/* Utility Navigation (Now Playing & Settings) */}
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
                tabIndex={isVisible ? 0 : -1}
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
    </>
  );
}
