import { useEffect, type CSSProperties } from 'react';
import { MiniPlayer } from '../components/MiniPlayer';
import { QueueDrawer } from '../components/QueueDrawer';
import { Sidebar } from '../components/Sidebar';
import { TopHeader } from '../components/TopHeader';
import { AlbumDetailPage } from '../pages/AlbumDetailPage';
import { ArtistDetailPage } from '../pages/ArtistDetailPage';
import { HomePage } from '../pages/HomePage';
import { LibraryPage } from '../pages/LibraryPage';
import { NowPlayingPage } from '../pages/NowPlayingPage';
import { PlaylistDetailPage } from '../pages/PlaylistDetailPage';
import { ProfilePage } from '../pages/ProfilePage';
import { SearchPage } from '../pages/SearchPage';
import { SettingsPage } from '../pages/SettingsPage';
import { StatisticsPage } from '../pages/StatisticsPage';
import { libraryStore } from '../stores/library-store';
import { uiStore, useUiState } from '../stores/ui-store';

export function App() {
  const ui = useUiState();
  const palette = uiStore.getCurrentPalette();
  const userAccent = uiStore.getUserAccentPalette();
  const {
    themeMode,
    homeBackgroundMode,
    customBackgroundUrl,
    backgroundEffects,
    reducedMotion,
    uiQualityPreset,
  } = ui.preferences;
  const isPowerSaver = uiQualityPreset === 'power-saver';

  useEffect(() => {
    void libraryStore.initialize();
    void uiStore.hydrateFromDesktop();
    return () => {
      libraryStore.dispose();
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const root = document.documentElement;
    root.dataset.theme = themeMode;
    root.dataset.quality = uiQualityPreset ?? 'balanced';
    root.classList.toggle('dark', themeMode === 'dark');
  }, [themeMode, uiQualityPreset]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const syncVisibility = () => {
      document.documentElement.dataset.appHidden = document.hidden ? 'true' : 'false';
    };
    syncVisibility();
    document.addEventListener('visibilitychange', syncVisibility);
    return () => document.removeEventListener('visibilitychange', syncVisibility);
  }, []);

  const dynamicCssVars = {
    '--accent-primary': palette.dominant,
    '--accent-glow-rgb': palette.glowRgb,
    '--accent-secondary-rgb': palette.secondaryGlowRgb,
    '--user-accent': userAccent.activeHex,
    '--user-accent-rgb': userAccent.glowRgb,
    '--user-accent-on': userAccent.onAccentText,
  } as CSSProperties;

  const isNowPlaying = ui.route === 'now-playing';
  const isHome = ui.route === 'home';
  const isLight = themeMode === 'light';
  const showCustomHomeBg =
    isHome && homeBackgroundMode === 'custom' && Boolean(customBackgroundUrl);

  const renderActivePage = () => {
    switch (ui.route) {
      case 'home':
        return <HomePage />;
      case 'library':
        return <LibraryPage />;
      case 'album-detail':
        return <AlbumDetailPage />;
      case 'playlist-detail':
        return <PlaylistDetailPage />;
      case 'artist-detail':
        return <ArtistDetailPage />;
      case 'now-playing':
        return <NowPlayingPage />;
      case 'search':
        return <SearchPage />;
      case 'statistics':
        return <StatisticsPage />;
      case 'settings':
        return <SettingsPage />;
      case 'profile':
        return <ProfilePage />;
      default:
        return <HomePage />;
    }
  };

  const ambientBackground = (() => {
    if (isNowPlaying) {
      return isLight
        ? 'linear-gradient(180deg, #F6F6F4 0%, #F1F1EE 100%)'
        : 'linear-gradient(180deg, #111216 0%, #0C0D10 100%)';
    }

    if (
      !backgroundEffects ||
      isPowerSaver ||
      (isHome && homeBackgroundMode === 'default')
    ) {
      return isLight
        ? 'linear-gradient(180deg, #F7F8FC 0%, #ECEEF5 100%)'
        : 'linear-gradient(180deg, #101114 0%, #090A0D 100%)';
    }

    const glowRgb = isHome ? palette.glowRgb : userAccent.glowRgb;
    const secondaryRgb = isHome ? palette.secondaryGlowRgb : userAccent.secondaryGlowRgb;

    return isLight
      ? `
          radial-gradient(ellipse 58% 48% at 52% 18%, rgba(${glowRgb}, 0.16) 0%, rgba(${secondaryRgb}, 0.06) 46%, rgba(236,238,245,0) 78%),
          radial-gradient(ellipse 42% 36% at 86% 88%, rgba(${secondaryRgb}, 0.09) 0%, rgba(236,238,245,0) 72%),
          linear-gradient(180deg, #F7F8FC 0%, #ECEEF5 100%)
        `
      : `
          radial-gradient(ellipse 58% 48% at 52% 18%, rgba(${glowRgb}, 0.20) 0%, rgba(${secondaryRgb}, 0.08) 46%, rgba(9,10,13,0) 78%),
          radial-gradient(ellipse 42% 36% at 86% 88%, rgba(${secondaryRgb}, 0.10) 0%, rgba(9,10,13,0) 72%),
          linear-gradient(180deg, #101114 0%, #090A0D 100%)
        `;
  })();

  return (
    <div
      style={dynamicCssVars}
      className={`relative flex h-screen w-screen overflow-hidden bg-[var(--bg-deep)] text-[var(--text-primary)] ${
        reducedMotion ? 'reduced-motion' : ''
      }`}
    >
      {/* Dynamic / Theme Default Atmospheric Backdrop */}
      <div
        aria-hidden="true"
        className="lp-ambient-layer pointer-events-none fixed inset-0 z-0"
        style={{ background: ambientBackground }}
      />

      {/* Optional Custom Home Background with Contrast-Safe Scrim */}
      {showCustomHomeBg && customBackgroundUrl && (
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
          <img
            src={customBackgroundUrl}
            alt=""
            decoding="async"
            className={`h-full w-full object-cover object-center ${
              isPowerSaver ? '' : 'scale-105 blur-[2px]'
            }`}
          />
          <div
            className="absolute inset-0"
            style={{
              background: isLight
                ? 'linear-gradient(180deg, rgba(246,247,251,0.72) 0%, rgba(236,238,245,0.82) 100%)'
                : 'linear-gradient(180deg, rgba(9,10,13,0.62) 0%, rgba(9,10,13,0.78) 100%)',
            }}
          />
        </div>
      )}

      {/* Fixed 76px Theme-Aware Glass Sidebar */}
      <Sidebar />

      {/* Main Content Shell */}
      <div className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden">
        {!isNowPlaying && <TopHeader />}

        <main
          className={
            isNowPlaying
              ? 'flex-1 overflow-hidden'
              : isHome
                ? 'flex-1 overflow-y-auto px-6 pt-1 sm:px-9'
                : 'flex-1 overflow-y-auto px-6 pt-2 sm:px-9'
          }
        >
          {renderActivePage()}
        </main>
      </div>

      {/* Floating Pill Mini Player (Hidden in Now Playing fullscreen) */}
      <MiniPlayer />

      {/* Slide-over Frosted Queue Drawer */}
      <QueueDrawer />

      {/* Subtle Toast Notification — bottom-center in Now Playing so it never overlaps Info/Lyrics controls */}
      {ui.toastMessage && (
        <div
          role="status"
          data-testid="app-toast"
          className={`lp-glass-pill fixed z-50 max-w-[420px] rounded-2xl px-4 py-3 text-[13px] font-medium text-[var(--text-primary)] ${
            isNowPlaying ? 'bottom-[96px] left-1/2 -translate-x-1/2' : 'top-20 right-8'
          }`}
        >
          {ui.toastMessage}
        </div>
      )}
    </div>
  );
}
