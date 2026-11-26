import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CustomEditorialFontRecord,
  EditorialTypographySettings,
  ThemeMode,
} from '../../../shared/types/stage5';
import { computeEditorialTypographyMetrics } from '../../../shared/utils/editorial-typography';
import {
  buildEditorialFontStack,
  ensureEditorialFontLoaded,
} from '../utils/editorial-font-loader';

interface HomeEditorialTypographyProps {
  settings: EditorialTypographySettings;
  fonts: CustomEditorialFontRecord[];
  themeMode: ThemeMode;
  hasCustomBackground: boolean;
  /** Compact preview mode rendered inside ProfilePage Live Preview card */
  isPreview?: boolean;
  onFontLoadError?: (fontName: string) => void;
}

/**
 * Dedicated Home / Playlist Gallery Editorial Background Typography Layer.
 *
 * Strict layering contract:
 * 1. Home Background
 * 2. Dynamic Glow / Custom Background
 * 3. THIS Editorial Typography Layer (pointer-events: none, z-index behind cards)
 * 4. Staggered Portrait Playlist Cards (partially overlapping the typography)
 * 5. Gallery Controls
 *
 * - Top line anchors behind the upper half of the Gallery.
 * - Bottom line anchors behind the lower half of the Gallery.
 * - Preserves exact user casing & full Unicode (Vietnamese / EN / ZH / JA / KO).
 * - Custom imported font applies STRICTLY here and never alters global UI/Lyrics fonts.
 */
export function HomeEditorialTypography({
  settings,
  fonts,
  themeMode,
  hasCustomBackground,
  isPreview = false,
  onFontLoadError,
}: HomeEditorialTypographyProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const notifiedErrorIdsRef = useRef<Set<string>>(new Set());

  const [size, setSize] = useState<{ width: number; height: number }>(() =>
    isPreview
      ? { width: 420, height: 220 }
      : {
          width: typeof window !== 'undefined' ? Math.max(820, window.innerWidth - 140) : 1280,
          height: typeof window !== 'undefined' ? Math.max(460, window.innerHeight - 200) : 680,
        },
  );

  const activeFont = useMemo(
    () =>
      settings.selectedFontId
        ? fonts.find((font) => font.id === settings.selectedFontId) ?? null
        : null,
    [fonts, settings.selectedFontId],
  );

  const [loadedFamilyName, setLoadedFamilyName] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      return;
    }
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setSize({ width: rect.width, height: rect.height });
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!activeFont) {
      setLoadedFamilyName(null);
      return;
    }
    void ensureEditorialFontLoaded(activeFont).then((result) => {
      if (cancelled) return;
      if (result.failed || !result.familyName) {
        setLoadedFamilyName(null);
        if (onFontLoadError && !notifiedErrorIdsRef.current.has(activeFont.id)) {
          notifiedErrorIdsRef.current.add(activeFont.id);
          onFontLoadError(activeFont.name);
        }
      } else {
        setLoadedFamilyName(result.familyName);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeFont, onFontLoadError]);

  if (!settings.enabled) {
    return null;
  }

  const topLine = settings.topText.trim();
  const bottomLine = settings.bottomText.trim();
  if (!topLine && !bottomLine) {
    return null;
  }

  const metrics = isPreview
    ? computeEditorialTypographyMetrics({
        topText: topLine,
        bottomText: bottomLine,
        containerWidth: size.width * 2.55,
        containerHeight: size.height * 2.55,
        fontSizeScale: settings.fontSizeScale,
      })
    : computeEditorialTypographyMetrics({
        topText: topLine,
        bottomText: bottomLine,
        containerWidth: size.width,
        containerHeight: size.height,
        fontSizeScale: settings.fontSizeScale,
      });

  const previewScale = isPreview ? 0.36 : 1;
  const topPx = Math.max(isPreview ? 22 : 42, Math.round(metrics.topFontSizePx * previewScale));
  const bottomPx = Math.max(
    isPreview ? 22 : 42,
    Math.round(metrics.bottomFontSizePx * previewScale),
  );

  // Adaptive theme-aware contrast (zero hardcoded violet, zero neon glow, zero heavy drop shadows)
  const isLight = themeMode === 'light';
  const baseOpacity = settings.opacity;
  const effectiveOpacity = isLight
    ? Math.min(0.26, Math.max(0.11, hasCustomBackground ? baseOpacity * 1.05 : baseOpacity * 0.92))
    : Math.min(0.28, Math.max(0.12, hasCustomBackground ? baseOpacity * 1.12 : baseOpacity));

  const textColor = isLight
    ? `rgba(22, 24, 30, ${effectiveOpacity.toFixed(3)})`
    : `rgba(245, 246, 248, ${effectiveOpacity.toFixed(3)})`;

  const fontStack = buildEditorialFontStack(loadedFamilyName);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      data-testid={isPreview ? 'editorial-typography-preview-layer' : 'home-editorial-typography'}
      data-custom-font={loadedFamilyName ?? 'default'}
      className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between overflow-hidden select-none"
      style={{
        paddingTop: isPreview ? '7%' : 'clamp(28px, 6.5vh, 66px)',
        paddingBottom: isPreview ? '7%' : 'clamp(36px, 7.5vh, 76px)',
        paddingLeft: isPreview ? '12px' : '16px',
        paddingRight: isPreview ? '12px' : '16px',
      }}
    >
      {/* Upper-half editorial display line */}
      <div className="flex w-full items-start justify-center overflow-x-hidden overflow-y-visible py-1">
        {topLine && (
          <span
            data-testid={isPreview ? 'editorial-preview-top' : 'home-editorial-top-text'}
            className="block max-w-full whitespace-nowrap text-center font-bold"
            style={{
              fontFamily: fontStack,
              fontSize: `${topPx}px`,
              lineHeight: metrics.lineHeight,
              letterSpacing: `${metrics.letterSpacingEm}em`,
              color: textColor,
            }}
          >
            {topLine}
          </span>
        )}
      </div>

      {/* Lower-half editorial display line */}
      <div className="flex w-full items-end justify-center overflow-x-hidden overflow-y-visible py-1">
        {bottomLine && (
          <span
            data-testid={isPreview ? 'editorial-preview-bottom' : 'home-editorial-bottom-text'}
            className="block max-w-full whitespace-nowrap text-center font-bold"
            style={{
              fontFamily: fontStack,
              fontSize: `${bottomPx}px`,
              lineHeight: metrics.lineHeight,
              letterSpacing: `${metrics.letterSpacingEm}em`,
              color: textColor,
            }}
          >
            {bottomLine}
          </span>
        )}
      </div>
    </div>
  );
}
