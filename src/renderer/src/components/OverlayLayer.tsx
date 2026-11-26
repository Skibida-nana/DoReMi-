import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * Disciplined global stacking order for DoReMi UI (`Phase 4.4H`).
 * Prevents popovers, help cards, tooltips, context menus & modals from ever being
 * trapped behind `.lp-glass-panel` (`backdrop-filter`) or `overflow-hidden` ancestors.
 */
export const OVERLAY_Z_INDEX = {
  popover: 60,
  tooltip: 70,
  modal: 80,
  toast: 90,
} as const;

export type OverlayLayerKind = keyof typeof OVERLAY_Z_INDEX;

const OverlayHostContext = createContext<HTMLElement | null>(null);

export function OverlayHostProvider({ children }: { children: ReactNode }) {
  const [hostNode, setHostNode] = useState<HTMLDivElement | null>(null);

  return (
    <OverlayHostContext.Provider value={hostNode}>
      {children}
      <div
        ref={setHostNode}
        data-testid="doremi-overlay-host"
        className="pointer-events-none fixed inset-0"
        style={{ zIndex: OVERLAY_Z_INDEX.popover }}
      />
    </OverlayHostContext.Provider>
  );
}

/**
 * Renders floating overlay UI directly into the global OverlayHost layer inside App's theme context,
 * breaking free of intermediate `backdrop-filter`, `transform`, or `overflow-hidden` clipping parents.
 */
export function OverlayPortal({
  children,
  layer = 'popover',
}: {
  children: ReactNode;
  layer?: OverlayLayerKind;
}) {
  const ctxHost = useContext(OverlayHostContext);
  const fallbackTarget =
    typeof document !== 'undefined' ? document.body : null;
  const target = ctxHost ?? fallbackTarget;

  if (!target) {
    return <>{children}</>;
  }

  return createPortal(
    <div
      className="pointer-events-none fixed inset-0"
      style={{ zIndex: OVERLAY_Z_INDEX[layer] }}
    >
      {children}
    </div>,
    target,
  );
}

export interface RectLike {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface AnchoredPopoverPosition {
  top: number;
  left: number;
  actualPlacement: 'top' | 'bottom';
}

/**
 * Pure viewport-safe floating position resolver (`Phase 4.4H`):
 * - Supports preferred placement (`'top' | 'bottom'`) & alignment (`'start' | 'end' | 'center'`).
 * - Automatically flips vertically if clipped off-screen and clamps horizontal edges cleanly (`12px` pad).
 */
export function computeAnchoredPopoverPosition(input: {
  anchor: RectLike;
  panelWidth: number;
  panelHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  placement?: 'top' | 'bottom';
  align?: 'start' | 'end' | 'center';
  offsetPx?: number;
  edgePaddingPx?: number;
}): AnchoredPopoverPosition {
  const {
    anchor,
    panelWidth,
    panelHeight,
    viewportWidth,
    viewportHeight,
    placement = 'bottom',
    align = 'end',
    offsetPx = 8,
    edgePaddingPx = 12,
  } = input;

  const vw = Math.max(320, viewportWidth);
  const vh = Math.max(240, viewportHeight);
  const w = Math.min(Math.max(40, panelWidth), vw - edgePaddingPx * 2);
  const h = Math.min(Math.max(32, panelHeight), vh - edgePaddingPx * 2);

  let rawLeft: number;
  if (align === 'start') {
    rawLeft = anchor.left;
  } else if (align === 'center') {
    rawLeft = anchor.left + anchor.width * 0.5 - w * 0.5;
  } else {
    rawLeft = anchor.right - w;
  }
  const left = Math.round(Math.max(edgePaddingPx, Math.min(vw - w - edgePaddingPx, rawLeft)));

  const spaceBelow = vh - anchor.bottom - offsetPx - edgePaddingPx;
  const spaceAbove = anchor.top - offsetPx - edgePaddingPx;
  let actualPlacement: 'top' | 'bottom' = placement;
  if (placement === 'bottom' && spaceBelow < h && spaceAbove > spaceBelow) {
    actualPlacement = 'top';
  } else if (placement === 'top' && spaceAbove < h && spaceBelow > spaceAbove) {
    actualPlacement = 'bottom';
  }

  const rawTop =
    actualPlacement === 'top' ? anchor.top - h - offsetPx : anchor.bottom + offsetPx;
  const top = Math.round(Math.max(edgePaddingPx, Math.min(vh - h - edgePaddingPx, rawTop)));

  return { top, left, actualPlacement };
}

export interface AnchoredPopoverProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  placement?: 'top' | 'bottom';
  align?: 'start' | 'end' | 'center';
  offsetPx?: number;
  layer?: OverlayLayerKind;
  role?: 'menu' | 'dialog' | 'tooltip';
  ariaLabel?: string;
  id?: string;
  testId?: string;
  className?: string;
  dismissOnScroll?: boolean;
  children: ReactNode;
}

export function AnchoredPopover({
  open,
  anchorRef,
  onClose,
  placement = 'bottom',
  align = 'end',
  offsetPx = 8,
  layer = 'popover',
  role = 'dialog',
  ariaLabel,
  id,
  testId,
  className = '',
  dismissOnScroll = false,
  children,
}: AnchoredPopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number; ready: boolean }>({
    top: -9999,
    left: -9999,
    ready: false,
  });

  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') {
      setCoords({ top: -9999, left: -9999, ready: false });
      return;
    }

    const updatePosition = () => {
      const anchorEl = anchorRef.current;
      const panelEl = panelRef.current;
      if (!anchorEl || !panelEl) return;
      const aRect = anchorEl.getBoundingClientRect();
      const pRect = panelEl.getBoundingClientRect();
      const pos = computeAnchoredPopoverPosition({
        anchor: {
          top: aRect.top,
          left: aRect.left,
          right: aRect.right,
          bottom: aRect.bottom,
          width: aRect.width,
          height: aRect.height,
        },
        panelWidth: Math.max(pRect.width, panelEl.offsetWidth || 240),
        panelHeight: Math.max(pRect.height, panelEl.offsetHeight || 160),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        placement,
        align,
        offsetPx,
      });
      setCoords({ top: pos.top, left: pos.left, ready: true });
    };

    updatePosition();

    const handleScrollOrResize = () => {
      if (dismissOnScroll) {
        onClose();
        return;
      }
      updatePosition();
    };
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', handleScrollOrResize, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', handleScrollOrResize, true);
    };
  }, [open, anchorRef, placement, align, offsetPx, dismissOnScroll, onClose]);

  useEffect(() => {
    if (!open || typeof window === 'undefined') {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return;
      }
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, anchorRef, onClose]);

  if (!open) {
    return null;
  }

  return (
    <OverlayPortal layer={layer}>
      <div
        ref={panelRef}
        id={id}
        role={role}
        aria-label={ariaLabel}
        data-testid={testId}
        style={{
          position: 'fixed',
          top: `${coords.top}px`,
          left: `${coords.left}px`,
          visibility: coords.ready ? 'visible' : 'hidden',
        }}
        className={`pointer-events-auto ${className}`}
      >
        {children}
      </div>
    </OverlayPortal>
  );
}
