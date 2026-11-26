import { useEffect, useState, type RefObject } from 'react';
import { ArrowUp } from 'lucide-react';
import {
  findScrollParent,
  scrollContainerToTop,
  shouldShowBackToTop,
} from '../utils/scroll-helpers';

export interface LibraryBackToTopButtonProps {
  /** Ref to an element mounted inside the scrollable `<main>` container */
  anchorRef: RefObject<HTMLElement | null>;
  accentHex: string;
  onAccentText: string;
  reducedMotion: boolean;
  /** Re-evaluates scrollability when library tab/filter count changes */
  contentKey?: string | number;
}

/**
 * Floating bottom-right Back-to-Top button for Music Library:
 * - Passive rAF-throttled scroll listener on the actual `<main>` scroll container.
 * - Updates React state ONLY when boolean visibility flips (0 re-renders on scroll ticks).
 * - Positioned above MiniPlayer (`bottom-[114px]`) and below Modals/QueueDrawer (`z-[25]`).
 */
export function LibraryBackToTopButton({
  anchorRef,
  accentHex,
  onAccentText,
  reducedMotion,
  contentKey,
}: LibraryBackToTopButtonProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const anchorEl = anchorRef.current;
    const scrollParent = findScrollParent(anchorEl);
    let rafId: number | null = null;

    const evaluate = () => {
      rafId = null;
      const scrollTop = scrollParent ? scrollParent.scrollTop : window.scrollY;
      const viewportHeight = scrollParent ? scrollParent.clientHeight : window.innerHeight;
      const scrollHeight = scrollParent
        ? scrollParent.scrollHeight
        : document.documentElement.scrollHeight;
      const nextVisible = shouldShowBackToTop({
        scrollTop,
        viewportHeight,
        scrollHeight,
      });
      setVisible((prev) => (prev === nextVisible ? prev : nextVisible));
    };

    const scheduleEvaluate = () => {
      if (rafId !== null) {
        return;
      }
      rafId = window.requestAnimationFrame(evaluate);
    };

    evaluate();
    const target: EventTarget = scrollParent ?? window;
    target.addEventListener('scroll', scheduleEvaluate, { passive: true });
    window.addEventListener('resize', scheduleEvaluate, { passive: true });

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      target.removeEventListener('scroll', scheduleEvaluate);
      window.removeEventListener('resize', scheduleEvaluate);
    };
  }, [anchorRef, contentKey]);

  if (!visible) {
    return null;
  }

  const handleClick = () => {
    const scrollParent = findScrollParent(anchorRef.current);
    const osReduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scrollContainerToTop(scrollParent, reducedMotion || osReduced);
  };

  return (
    <button
      type="button"
      data-testid="library-back-to-top-btn"
      onClick={handleClick}
      title="Về đầu trang"
      aria-label="Về đầu trang"
      style={{
        borderColor: `color-mix(in srgb, ${accentHex} 45%, var(--border-glass))`,
        boxShadow: '0 10px 28px rgba(0, 0, 0, 0.28)',
      }}
      className="lp-glass-pill fixed right-6 bottom-[114px] z-[25] flex h-10 w-10 items-center justify-center rounded-full border text-[var(--text-primary)] transition-transform duration-150 hover:scale-105 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <span
        aria-hidden="true"
        className="flex h-7 w-7 items-center justify-center rounded-full transition-colors"
        style={{ backgroundColor: accentHex, color: onAccentText }}
      >
        <ArrowUp className="h-4 w-4" strokeWidth={2.25} />
      </span>
    </button>
  );
}
