import type { AlbumColorPalette } from '../data/prototype-catalog';

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface DynamicArtworkPalette extends AlbumColorPalette {
  isFallback: boolean;
}

export const FALLBACK_DOREMI_PALETTE: DynamicArtworkPalette = {
  dominant: '#9276D8',
  secondary: '#5B459E',
  glowRgb: '146, 118, 216',
  secondaryGlowRgb: '91, 69, 158',
  badgeBg: 'rgba(146, 118, 216, 0.18)',
  borderGlow: 'rgba(176, 152, 240, 0.45)',
  isFallback: true,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = clamp(r, 0, 255) / 255;
  const gn = clamp(g, 0, 255) / 255;
  const bn = clamp(b, 0, 255) / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l };
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  switch (max) {
    case rn:
      h = (gn - bn) / d + (gn < bn ? 6 : 0);
      break;
    case gn:
      h = (bn - rn) / d + 2;
      break;
    default:
      h = (rn - gn) / d + 4;
      break;
  }
  return { h: h / 6, s, l };
}

export function hslToRgb(h: number, s: number, l: number): RgbColor {
  const hn = ((h % 1) + 1) % 1;
  const sn = clamp(s, 0, 1);
  const ln = clamp(l, 0, 1);

  if (sn === 0) {
    const v = Math.round(ln * 255);
    return { r: v, g: v, b: v };
  }

  const hue2rgb = (p: number, q: number, t: number): number => {
    let tn = t;
    if (tn < 0) tn += 1;
    if (tn > 1) tn -= 1;
    if (tn < 1 / 6) return p + (q - p) * 6 * tn;
    if (tn < 1 / 2) return q;
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
    return p;
  };

  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  return {
    r: Math.round(hue2rgb(p, q, hn + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, hn) * 255),
    b: Math.round(hue2rgb(p, q, hn - 1 / 3) * 255),
  };
}

export function rgbToHex({ r, g, b }: RgbColor): string {
  const toHex = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

/**
 * Produces a contrast-safe dark-UI AlbumColorPalette from sampled primary and
 * secondary artwork RGB values. Guarantees readable accents against charcoal
 * surfaces without neon blowouts or dark unreadable hues.
 */
export function buildPaletteFromSampledRgb(
  primary: RgbColor,
  secondary?: RgbColor,
): DynamicArtworkPalette {
  const pHsl = rgbToHsl(primary.r, primary.g, primary.b);
  const safeAccent = hslToRgb(
    pHsl.h,
    pHsl.s < 0.1 ? clamp(pHsl.s, 0.08, 0.18) : clamp(pHsl.s, 0.34, 0.72),
    clamp(pHsl.l, 0.54, 0.72),
  );

  const sBase = secondary ? rgbToHsl(secondary.r, secondary.g, secondary.b) : pHsl;
  const safeSecondary = hslToRgb(
    secondary ? sBase.h : (pHsl.h + 0.06) % 1,
    sBase.s < 0.1 ? clamp(sBase.s, 0.08, 0.18) : clamp(sBase.s, 0.28, 0.62),
    clamp(sBase.l, 0.32, 0.48),
  );

  const glowRgb = `${safeAccent.r}, ${safeAccent.g}, ${safeAccent.b}`;
  const secondaryGlowRgb = `${safeSecondary.r}, ${safeSecondary.g}, ${safeSecondary.b}`;

  return {
    dominant: rgbToHex(safeAccent),
    secondary: rgbToHex(safeSecondary),
    glowRgb,
    secondaryGlowRgb,
    badgeBg: `rgba(${glowRgb}, 0.18)`,
    borderGlow: `rgba(${glowRgb}, 0.45)`,
    isFallback: false,
  };
}

/**
 * Deterministic pixel bucket sampler (works on any RGBA Uint8ClampedArray from a small 32x32 canvas).
 * Ignores near-black/near-white pixels unless the entire image is monochrome, picking the most
 * representative vibrant color and a complementary secondary color.
 */
export function extractPaletteFromRgbaPixels(pixels: Uint8ClampedArray): DynamicArtworkPalette {
  interface Bucket {
    rSum: number;
    gSum: number;
    bSum: number;
    weight: number;
    count: number;
  }

  const buckets = new Map<string, Bucket>();

  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (a < 180) {
      continue;
    }
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];

    const { s, l } = rgbToHsl(r, g, b);
    if (l < 0.09 || l > 0.92) {
      continue;
    }

    // Quantize to 32-level buckets for fast deterministic clustering
    const key = `${r >> 5}-${g >> 5}-${b >> 5}`;
    const vibrancyWeight = 0.5 + s * 2.4 + (1 - Math.abs(l - 0.52));
    const existing = buckets.get(key);
    if (existing) {
      existing.rSum += r * vibrancyWeight;
      existing.gSum += g * vibrancyWeight;
      existing.bSum += b * vibrancyWeight;
      existing.weight += vibrancyWeight;
      existing.count += 1;
    } else {
      buckets.set(key, {
        rSum: r * vibrancyWeight,
        gSum: g * vibrancyWeight,
        bSum: b * vibrancyWeight,
        weight: vibrancyWeight,
        count: 1,
      });
    }
  }

  if (buckets.size === 0) {
    return FALLBACK_DOREMI_PALETTE;
  }

  const ranked = Array.from(buckets.values()).sort((a, b) => b.weight - a.weight);
  const top = ranked[0];
  const primary: RgbColor = {
    r: top.rSum / top.weight,
    g: top.gSum / top.weight,
    b: top.bSum / top.weight,
  };

  let secondary: RgbColor | undefined;
  for (let i = 1; i < ranked.length; i += 1) {
    const candidate: RgbColor = {
      r: ranked[i].rSum / ranked[i].weight,
      g: ranked[i].gSum / ranked[i].weight,
      b: ranked[i].bSum / ranked[i].weight,
    };
    const distance = Math.hypot(
      candidate.r - primary.r,
      candidate.g - primary.g,
      candidate.b - primary.b,
    );
    if (distance >= 48) {
      secondary = candidate;
      break;
    }
  }

  return buildPaletteFromSampledRgb(primary, secondary);
}

const MAX_PALETTE_CACHE_ENTRIES = 160;
const paletteCache = new Map<string, DynamicArtworkPalette>();
const inflightExtractions = new Map<string, Promise<DynamicArtworkPalette>>();
let sharedSampleCanvas: HTMLCanvasElement | null = null;
let sharedSampleCtx: CanvasRenderingContext2D | null = null;

function getSharedSampleContext(): CanvasRenderingContext2D | null {
  if (sharedSampleCtx) {
    return sharedSampleCtx;
  }
  if (typeof document === 'undefined') {
    return null;
  }
  sharedSampleCanvas = document.createElement('canvas');
  sharedSampleCanvas.width = 32;
  sharedSampleCanvas.height = 32;
  sharedSampleCtx = sharedSampleCanvas.getContext('2d', { willReadFrequently: true });
  return sharedSampleCtx;
}

function setCachedPalette(imageUrl: string, palette: DynamicArtworkPalette): void {
  if (paletteCache.has(imageUrl)) {
    paletteCache.delete(imageUrl);
  }
  paletteCache.set(imageUrl, palette);
  if (paletteCache.size > MAX_PALETTE_CACHE_ENTRIES) {
    const oldestKey = paletteCache.keys().next().value;
    if (oldestKey !== undefined) {
      paletteCache.delete(oldestKey);
    }
  }
}

export function getCachedPaletteForImageUrl(imageUrl: string): DynamicArtworkPalette | null {
  const hit = paletteCache.get(imageUrl);
  if (!hit) {
    return null;
  }
  // Refresh LRU order on read
  paletteCache.delete(imageUrl);
  paletteCache.set(imageUrl, hit);
  return hit;
}

export function getPaletteCacheSize(): number {
  return paletteCache.size;
}

/**
 * Extracts a deterministic DynamicArtworkPalette from an image URL using a reused
 * offscreen 32x32 canvas, caching results with a bounded LRU map so re-renders do
 * zero image decoding and memory stays bounded on low-RAM laptops.
 */
export function extractPaletteFromImageUrl(
  imageUrl: string,
  fallback: DynamicArtworkPalette = FALLBACK_DOREMI_PALETTE,
): Promise<DynamicArtworkPalette> {
  if (!imageUrl || typeof document === 'undefined' || typeof Image === 'undefined') {
    return Promise.resolve(fallback);
  }

  const cached = getCachedPaletteForImageUrl(imageUrl);
  if (cached) {
    return Promise.resolve(cached);
  }

  const inflight = inflightExtractions.get(imageUrl);
  if (inflight) {
    return inflight;
  }

  const promise = new Promise<DynamicArtworkPalette>((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      try {
        const ctx = getSharedSampleContext();
        if (!ctx) {
          resolve(fallback);
          return;
        }
        ctx.clearRect(0, 0, 32, 32);
        ctx.drawImage(img, 0, 0, 32, 32);
        const data = ctx.getImageData(0, 0, 32, 32).data;
        const palette = extractPaletteFromRgbaPixels(data);
        setCachedPalette(imageUrl, palette);
        resolve(palette);
      } catch {
        resolve(fallback);
      }
    };

    img.onerror = () => {
      resolve(fallback);
    };

    img.src = imageUrl;
  }).finally(() => {
    inflightExtractions.delete(imageUrl);
  });

  inflightExtractions.set(imageUrl, promise);
  return promise;
}
