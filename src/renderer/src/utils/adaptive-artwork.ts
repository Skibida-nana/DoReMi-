import type { ThemeMode, UiQualityPreset } from '../../../shared/types/stage5';
import {
  buildPaletteFromSampledRgb,
  FALLBACK_DOREMI_PALETTE,
  hslToRgb,
  rgbToHex,
  rgbToHsl,
  type DynamicArtworkPalette,
  type RgbColor,
} from './dynamic-color';

export interface AdaptiveArtworkTheme {
  /** Cache identity & source URL (embeds revision/hash query params when custom cover changes) */
  artworkKey: string;
  /** Standard accent palette compatible with controls/progress rings */
  palette: DynamicArtworkPalette;
  /** Surface-specific contrast-safe accent hexes (>= 3:1 over host surface) */
  darkZoneAccentHex: string;
  lightZoneAccentHex: string;
  focusAccentHex: string;
  /** Authentic artwork-derived dark zone base & gradient (Now Playing Left Zone) */
  darkToneHex: string;
  darkToneRgb: RgbColor;
  darkSurfaceGradient: string;
  /** Authentic artwork-derived light zone base & gradient (Now Playing Right Zone) */
  lightToneHex: string;
  lightToneRgb: RgbColor;
  lightSurfaceGradient: string;
  /** Luminous artwork-tinted divider & bottom transport bar tokens */
  diagonalGlowCss: string;
  standardBarSurfaceCss: string;
  standardBarBorderCss: string;
  standardBarTextPrimary: string;
  standardBarTextSecondary: string;
  standardBarTextMuted: string;
  /** Mid transition color used for Focus Vinyl base continuity */
  midToneHex: string;
  midToneRgb: RgbColor;
  /** Preprocessed soft artwork data URL (moderate blur `5–7px` at `480/680px` preserving real detail, null in power-saver/fallback) */
  blurredArtworkUrl: string | null;
  /** Direct Now Playing right-zone blurred/softened artwork URL (less blurred `3–4px` on `560px` canvas) */
  nowPlayingArtworkUrl: string | null;
  /** Sampled natural dimensions */
  naturalWidth: number;
  naturalHeight: number;
  /** Sampled perimeter border averages for Seamless Edge Continuation in Focus Vinyl */
  edgeLeftHex: string;
  edgeRightHex: string;
  edgeTopHex: string;
  edgeBottomHex: string;
  /** Phase 4.3H: Multi-point 12-band perimeter edge color samples (top→bottom / left→right) */
  edgeLeftSamples: string[];
  edgeRightSamples: string[];
  edgeTopSamples: string[];
  edgeBottomSamples: string[];
  /** Phase 4.3H: Low-res offscreen edge-extruded color field canvas URL for Focus backdrop continuity */
  focusSeamlessBackdropUrl: string | null;
  /** WCAG-safe foreground & button tokens explicitly computed for Left Dark Zone */
  darkZoneTextPrimary: string;
  darkZoneTextSecondary: string;
  darkZoneTextMuted: string;
  darkZoneDivider: string;
  darkZoneContrastRatio: number;
  /** WCAG-safe foreground & button tokens explicitly computed for Right Light Zone */
  lightZoneTextPrimary: string;
  lightZoneTextSecondary: string;
  lightZoneTextMuted: string;
  lightZoneDivider: string;
  lightZoneOverlayCss: string;
  lightZonePrimaryBtnBg: string;
  lightZonePrimaryBtnFg: string;
  lightZoneGhostBtnBg: string;
  lightZoneGhostBtnFg: string;
  lightZoneGhostBtnBorder: string;
  lightZoneContrastRatio: number;
  /** Focus Vinyl canvas surface, seamless edge continuation gradients & contrast tokens */
  focusBaseColor: string;
  focusDiffusionGradient: string;
  focusEdgeContinuationCss: string;
  focusContrastScrimCss: string;
  focusTextPrimary: string;
  focusTextSecondary: string;
  focusTextMuted: string;
  focusPrimaryBtnBg: string;
  focusPrimaryBtnFg: string;
  focusContrastRatio: number;
  /** True when grayscale / near-monochrome / B&W cover detected */
  isMonochrome: boolean;
  /** True when fallback theme was used instead of decoded image pixels */
  isFallback: boolean;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function toLinearChannel(channel255: number): number {
  const s = clamp(channel255, 0, 255) / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function computeRelativeLuminance(rgb: RgbColor): number {
  return (
    0.2126 * toLinearChannel(rgb.r) +
    0.7152 * toLinearChannel(rgb.g) +
    0.0722 * toLinearChannel(rgb.b)
  );
}

export function computeContrastRatio(a: RgbColor, b: RgbColor): number {
  const la = computeRelativeLuminance(a);
  const lb = computeRelativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function rgbCss(rgb: RgbColor, alpha = 1): string {
  const r = Math.round(clamp(rgb.r, 0, 255));
  const g = Math.round(clamp(rgb.g, 0, 255));
  const b = Math.round(clamp(rgb.b, 0, 255));
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hexToRgbFallback(hex: string): RgbColor {
  const cleaned = hex.replace('#', '').trim();
  if (cleaned.length === 6) {
    const r = Number.parseInt(cleaned.slice(0, 2), 16);
    const g = Number.parseInt(cleaned.slice(2, 4), 16);
    const b = Number.parseInt(cleaned.slice(4, 6), 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return { r, g, b };
    }
  }
  return { r: 146, g: 118, b: 216 };
}

/**
 * Ensures an accent color achieves at least `minRatio` contrast against a given surface RGB
 * by nudging HSL lightness thoughtfully while preserving hue & saturation character.
 */
export function adaptAccentContrastForSurface(
  accentRgb: RgbColor,
  surfaceRgb: RgbColor,
  minRatio = 3.2,
): RgbColor {
  if (computeContrastRatio(accentRgb, surfaceRgb) >= minRatio) {
    return accentRgb;
  }
  const hsl = rgbToHsl(accentRgb.r, accentRgb.g, accentRgb.b);
  const surfaceLum = computeRelativeLuminance(surfaceRgb);
  const step = surfaceLum < 0.35 ? 0.055 : -0.055;
  let candidateL = hsl.l;
  for (let i = 0; i < 14; i += 1) {
    candidateL = clamp(candidateL + step, 0.14, 0.88);
    const candidate = hslToRgb(hsl.h, clamp(hsl.s, 0.18, 0.92), candidateL);
    if (computeContrastRatio(candidate, surfaceRgb) >= minRatio) {
      return candidate;
    }
  }
  return surfaceLum < 0.35 ? { r: 224, g: 226, b: 234 } : { r: 34, g: 38, b: 52 };
}

/**
 * Tunes a border/quadrant color cleanly to the target theme atmosphere luminance
 * without crushing its natural hue or turning vivid blues/greens into brown-gray mud.
 */
function adaptColorFieldForBackdrop(
  srcRgb: RgbColor,
  isDarkTheme: boolean,
  saturationScale: number,
  targetLumLight: number,
  targetLumDark: number,
): RgbColor {
  const { h, s } = rgbToHsl(srcRgb.r, srcRgb.g, srcRgb.b);
  const effectiveS = s < 0.09 ? s : clamp(s * saturationScale, 0.14, 0.72);
  const effectiveL = isDarkTheme
    ? clamp(targetLumDark, 0.09, 0.38)
    : clamp(targetLumLight, 0.66, 0.92);
  return hslToRgb(h, effectiveS, effectiveL);
}

interface RegionAccumulator {
  rSum: number;
  gSum: number;
  bSum: number;
  weightSum: number;
}

function createAcc(): RegionAccumulator {
  return { rSum: 0, gSum: 0, bSum: 0, weightSum: 0 };
}

function resolveAcc(acc: RegionAccumulator, fallback: RgbColor): RgbColor {
  if (acc.weightSum <= 0) {
    return fallback;
  }
  return {
    r: clamp(acc.rSum / acc.weightSum, 0, 255),
    g: clamp(acc.gSum / acc.weightSum, 0, 255),
    b: clamp(acc.bSum / acc.weightSum, 0, 255),
  };
}

/**
 * Smooths adjacent multi-point edge samples with a gentle 3-tap kernel `[0.22, 0.56, 0.22]`
 * so high-frequency pixel noise along the border blends cleanly without color stripes.
 */
function resolveAndSmoothEdgeBands(
  bands: RegionAccumulator[],
  fallback: RgbColor,
): RgbColor[] {
  const raw = bands.map((b) => resolveAcc(b, fallback));
  if (raw.length <= 2) {
    return raw;
  }
  return raw.map((curr, idx) => {
    const prev = raw[Math.max(0, idx - 1)];
    const next = raw[Math.min(raw.length - 1, idx + 1)];
    return {
      r: clamp(prev.r * 0.22 + curr.r * 0.56 + next.r * 0.22, 0, 255),
      g: clamp(prev.g * 0.22 + curr.g * 0.56 + next.g * 0.22, 0, 255),
      b: clamp(prev.b * 0.22 + curr.b * 0.56 + next.b * 0.22, 0, 255),
    };
  });
}

/**
 * Adapts a multi-point perimeter sample gently toward theme atmosphere WITHOUT crushing bright/dark
 * regional contrast into a uniform shade, preserving hue/lightness continuity right across the edge!
 */
function adaptEdgePointForSeamlessContinuation(
  srcRgb: RgbColor,
  isDarkTheme: boolean,
): RgbColor {
  const { h, s, l } = rgbToHsl(srcRgb.r, srcRgb.g, srcRgb.b);
  const adaptedS = s < 0.08 ? s : clamp(s * 0.92, 0.1, 0.88);
  const adaptedL = isDarkTheme
    ? clamp(l * 0.84 + 0.04, 0.09, 0.72)
    : clamp(l * 0.65 + 0.3, 0.44, 0.94);
  return hslToRgb(h, adaptedS, adaptedL);
}

/**
 * Phase 4.2 + 4.3H Multi-Region + 12-Point Perimeter Edge Adaptive Artwork Extractor:
 * - Samples 4 spatial quadrants + 4 global perimeter strips + 12-segment multi-point strips along ALL 4 edges
 * - Builds continuous multi-stop Focus edge continuation fields (right edge matches upper/mid/lower artwork colors)
 * - Calibrates translucent Now Playing overlays so real album artwork breathes clearly
 * - Enforces WCAG AA/AAA foreground & button contrast tokens across BOTH modes
 */
export function extractAdaptiveArtworkThemeFromRgbaPixels(
  pixels: Uint8ClampedArray,
  options: {
    artworkKey: string;
    themeMode: ThemeMode;
    dynamicAlbumColors: boolean;
    sampleWidth?: number;
    sampleHeight?: number;
    blurredArtworkUrl?: string | null;
    nowPlayingArtworkUrl?: string | null;
    focusSeamlessBackdropUrl?: string | null;
    naturalWidth?: number;
    naturalHeight?: number;
    userAccentFallback?: DynamicArtworkPalette;
  },
): AdaptiveArtworkTheme {
  const themeMode = options.themeMode;
  const isDarkTheme = themeMode === 'dark';
  const fallbackPalette = options.userAccentFallback ?? FALLBACK_DOREMI_PALETTE;

  if (!options.dynamicAlbumColors || pixels.length < 4) {
    return buildFallbackAdaptiveTheme({
      artworkKey: options.artworkKey,
      themeMode,
      palette: fallbackPalette,
      blurredArtworkUrl: options.dynamicAlbumColors ? options.blurredArtworkUrl ?? null : null,
      nowPlayingArtworkUrl: options.dynamicAlbumColors ? options.nowPlayingArtworkUrl ?? null : null,
      naturalWidth: options.naturalWidth ?? 0,
      naturalHeight: options.naturalHeight ?? 0,
    });
  }

  interface SampleBucket {
    rSum: number;
    gSum: number;
    bSum: number;
    weight: number;
    chromaWeight: number;
    lumWeight: number;
    count: number;
  }

  const totalPixels = Math.floor(pixels.length / 4);
  const inferredSide = Math.max(1, Math.round(Math.sqrt(totalPixels)));
  const gridWidth = options.sampleWidth && options.sampleWidth > 0 ? options.sampleWidth : inferredSide;
  const gridHeight =
    options.sampleHeight && options.sampleHeight > 0
      ? options.sampleHeight
      : Math.max(1, Math.ceil(totalPixels / gridWidth));

  const EDGE_SAMPLE_BANDS = 12;
  const allBuckets = new Map<string, SampleBucket>();
  const quadrants = [createAcc(), createAcc(), createAcc(), createAcc()];
  const edges = {
    left: createAcc(),
    right: createAcc(),
    top: createAcc(),
    bottom: createAcc(),
  };
  const edgeStripBands = {
    left: Array.from({ length: EDGE_SAMPLE_BANDS }, createAcc),
    right: Array.from({ length: EDGE_SAMPLE_BANDS }, createAcc),
    top: Array.from({ length: EDGE_SAMPLE_BANDS }, createAcc),
    bottom: Array.from({ length: EDGE_SAMPLE_BANDS }, createAcc),
  };

  let opaqueCount = 0;
  let monochromePixels = 0;
  let lumWeightedSum = 0;
  let rTotal = 0;
  let gTotal = 0;
  let bTotal = 0;

  let deepShadowWeight = 0;
  let deepShadowR = 0;
  let deepShadowG = 0;
  let deepShadowB = 0;

  let highlightWeight = 0;
  let highlightR = 0;
  let highlightG = 0;
  let highlightB = 0;

  const edgeXBand = Math.max(1, Math.round(gridWidth * 0.14));
  const edgeYBand = Math.max(1, Math.round(gridHeight * 0.14));

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (a < 128) {
      continue;
    }
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    opaqueCount += 1;
    rTotal += r;
    gTotal += g;
    bTotal += b;

    const { s, l } = rgbToHsl(r, g, b);
    lumWeightedSum += l;
    if (s < 0.095) {
      monochromePixels += 1;
    }

    const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
    const midLumFactor = 1 - Math.abs(l - 0.5) * 0.58;
    const chromaBoost = 0.44 + s * 2.15;
    const weight = chromaBoost * midLumFactor;
    const existing = allBuckets.get(key);
    if (existing) {
      existing.rSum += r * weight;
      existing.gSum += g * weight;
      existing.bSum += b * weight;
      existing.weight += weight;
      existing.chromaWeight += s;
      existing.lumWeight += l;
      existing.count += 1;
    } else {
      allBuckets.set(key, {
        rSum: r * weight,
        gSum: g * weight,
        bSum: b * weight,
        weight,
        chromaWeight: s,
        lumWeight: l,
        count: 1,
      });
    }

    const pixelIdx = i >> 2;
    const px = pixelIdx % gridWidth;
    const py = Math.floor(pixelIdx / gridWidth);
    const qIdx = (py >= gridHeight * 0.5 ? 2 : 0) + (px >= gridWidth * 0.5 ? 1 : 0);
    const qW = 0.65 + s * 1.45;
    quadrants[qIdx].rSum += r * qW;
    quadrants[qIdx].gSum += g * qW;
    quadrants[qIdx].bSum += b * qW;
    quadrants[qIdx].weightSum += qW;

    // Sample perimeter edge strips directly (4 global + 12 spatial multi-point bands per edge!)
    const eW = 0.8 + s * 0.85;
    const bandY = Math.min(EDGE_SAMPLE_BANDS - 1, Math.floor((py / Math.max(1, gridHeight)) * EDGE_SAMPLE_BANDS));
    const bandX = Math.min(EDGE_SAMPLE_BANDS - 1, Math.floor((px / Math.max(1, gridWidth)) * EDGE_SAMPLE_BANDS));
    if (px < edgeXBand) {
      const distW = eW * (1.25 - px / Math.max(1, edgeXBand));
      edges.left.rSum += r * distW;
      edges.left.gSum += g * distW;
      edges.left.bSum += b * distW;
      edges.left.weightSum += distW;
      edgeStripBands.left[bandY].rSum += r * distW;
      edgeStripBands.left[bandY].gSum += g * distW;
      edgeStripBands.left[bandY].bSum += b * distW;
      edgeStripBands.left[bandY].weightSum += distW;
    }
    if (px >= gridWidth - edgeXBand) {
      const distFromEdge = Math.max(0, gridWidth - 1 - px);
      const distW = eW * (1.25 - distFromEdge / Math.max(1, edgeXBand));
      edges.right.rSum += r * distW;
      edges.right.gSum += g * distW;
      edges.right.bSum += b * distW;
      edges.right.weightSum += distW;
      edgeStripBands.right[bandY].rSum += r * distW;
      edgeStripBands.right[bandY].gSum += g * distW;
      edgeStripBands.right[bandY].bSum += b * distW;
      edgeStripBands.right[bandY].weightSum += distW;
    }
    if (py < edgeYBand) {
      const distW = eW * (1.25 - py / Math.max(1, edgeYBand));
      edges.top.rSum += r * distW;
      edges.top.gSum += g * distW;
      edges.top.bSum += b * distW;
      edges.top.weightSum += distW;
      edgeStripBands.top[bandX].rSum += r * distW;
      edgeStripBands.top[bandX].gSum += g * distW;
      edgeStripBands.top[bandX].bSum += b * distW;
      edgeStripBands.top[bandX].weightSum += distW;
    }
    if (py >= gridHeight - edgeYBand) {
      const distFromEdge = Math.max(0, gridHeight - 1 - py);
      const distW = eW * (1.25 - distFromEdge / Math.max(1, edgeYBand));
      edges.bottom.rSum += r * distW;
      edges.bottom.gSum += g * distW;
      edges.bottom.bSum += b * distW;
      edges.bottom.weightSum += distW;
      edgeStripBands.bottom[bandX].rSum += r * distW;
      edgeStripBands.bottom[bandX].gSum += g * distW;
      edgeStripBands.bottom[bandX].bSum += b * distW;
      edgeStripBands.bottom[bandX].weightSum += distW;
    }

    if (l < 0.48) {
      const shW = (0.52 - l) * (0.55 + s * 1.6);
      deepShadowR += r * shW;
      deepShadowG += g * shW;
      deepShadowB += b * shW;
      deepShadowWeight += shW;
    }
    if (l > 0.4) {
      const hiW = (l - 0.34) * (0.55 + s * 1.3);
      highlightR += r * hiW;
      highlightG += g * hiW;
      highlightB += b * hiW;
      highlightWeight += hiW;
    }
  }

  if (opaqueCount === 0 || allBuckets.size === 0) {
    return buildFallbackAdaptiveTheme({
      artworkKey: options.artworkKey,
      themeMode,
      palette: fallbackPalette,
      blurredArtworkUrl: options.blurredArtworkUrl ?? null,
      nowPlayingArtworkUrl: options.nowPlayingArtworkUrl ?? null,
      naturalWidth: options.naturalWidth ?? 0,
      naturalHeight: options.naturalHeight ?? 0,
    });
  }

  const avgLum = lumWeightedSum / opaqueCount;
  const monochromeFraction = monochromePixels / opaqueCount;
  const isMonochrome = monochromeFraction >= 0.86;
  const ranked = Array.from(allBuckets.values()).sort((a, b) => b.weight - a.weight);

  const avgRgb: RgbColor = {
    r: rTotal / opaqueCount,
    g: gTotal / opaqueCount,
    b: bTotal / opaqueCount,
  };
  let primaryRgb: RgbColor = avgRgb;
  let secondaryRgb: RgbColor | undefined;

  if (!isMonochrome) {
    const vibrant =
      ranked.find((bucket) => {
        const avgS = bucket.chromaWeight / bucket.count;
        const avgL = bucket.lumWeight / bucket.count;
        return avgS >= 0.13 && avgL >= 0.1 && avgL <= 0.9;
      }) ?? ranked[0];

    primaryRgb = {
      r: vibrant.rSum / vibrant.weight,
      g: vibrant.gSum / vibrant.weight,
      b: vibrant.bSum / vibrant.weight,
    };

    for (const candidateBucket of ranked) {
      const cand: RgbColor = {
        r: candidateBucket.rSum / candidateBucket.weight,
        g: candidateBucket.gSum / candidateBucket.weight,
        b: candidateBucket.bSum / candidateBucket.weight,
      };
      const dist = Math.hypot(
        cand.r - primaryRgb.r,
        cand.g - primaryRgb.g,
        cand.b - primaryRgb.b,
      );
      if (dist >= 34) {
        secondaryRgb = cand;
        break;
      }
    }
  }

  const qTopLeft = resolveAcc(quadrants[0], primaryRgb);
  const qTopRight = resolveAcc(quadrants[1], secondaryRgb ?? primaryRgb);
  const qBottomLeft = resolveAcc(quadrants[2], avgRgb);
  const qBottomRight = resolveAcc(quadrants[3], secondaryRgb ?? avgRgb);

  const rawEdgeLeft = resolveAcc(edges.left, qTopLeft);
  const rawEdgeRight = resolveAcc(edges.right, qTopRight);
  const rawEdgeTop = resolveAcc(edges.top, qTopRight);
  const rawEdgeBottom = resolveAcc(edges.bottom, qBottomRight);

  // Phase 4.3H: Multi-point smoothed 12-band edge sampling along ALL 4 perimeters
  const rawEdgeLeftBands = resolveAndSmoothEdgeBands(edgeStripBands.left, rawEdgeLeft);
  const rawEdgeRightBands = resolveAndSmoothEdgeBands(edgeStripBands.right, rawEdgeRight);
  const rawEdgeTopBands = resolveAndSmoothEdgeBands(edgeStripBands.top, rawEdgeTop);
  const rawEdgeBottomBands = resolveAndSmoothEdgeBands(edgeStripBands.bottom, rawEdgeBottom);

  const shadowSource =
    deepShadowWeight > 0
      ? {
          r: deepShadowR / deepShadowWeight,
          g: deepShadowG / deepShadowWeight,
          b: deepShadowB / deepShadowWeight,
        }
      : primaryRgb;
  const highlightSource =
    highlightWeight > 0
      ? {
          r: highlightR / highlightWeight,
          g: highlightG / highlightWeight,
          b: highlightB / highlightWeight,
        }
      : (secondaryRgb ?? primaryRgb);

  const pHsl = rgbToHsl(primaryRgb.r, primaryRgb.g, primaryRgb.b);
  const sHsl = secondaryRgb ? rgbToHsl(secondaryRgb.r, secondaryRgb.g, secondaryRgb.b) : pHsl;
  const shadowHsl = rgbToHsl(shadowSource.r, shadowSource.g, shadowSource.b);
  const hiHsl = rgbToHsl(highlightSource.r, highlightSource.g, highlightSource.b);

  const palette: DynamicArtworkPalette = isMonochrome
    ? {
        dominant: avgLum < 0.45 ? '#C8CDD8' : '#4B515F',
        secondary: '#7B8291',
        glowRgb: avgLum < 0.45 ? '200, 205, 216' : '75, 81, 95',
        secondaryGlowRgb: '123, 130, 145',
        badgeBg: 'rgba(160, 166, 178, 0.18)',
        borderGlow: 'rgba(160, 166, 178, 0.42)',
        isFallback: false,
      }
    : buildPaletteFromSampledRgb(primaryRgb, secondaryRgb);

  // 1) Left Dark Zone (clean, natural artwork shadow mood — preserves authentic chroma without muddy gray!)
  const darkToneH = shadowHsl.s > 0.12 && !isMonochrome ? shadowHsl.h : pHsl.h;
  const darkToneS = isMonochrome ? 0.03 : clamp(Math.max(pHsl.s, shadowHsl.s) * 0.62, 0.18, 0.56);
  const darkToneL = isDarkTheme ? 0.115 : 0.145;
  const darkToneRgb = hslToRgb(darkToneH, darkToneS, darkToneL);
  const darkToneAltRgb = hslToRgb(
    secondaryRgb ? sHsl.h : (darkToneH + 0.04) % 1,
    isMonochrome ? 0.03 : clamp(sHsl.s * 0.52, 0.14, 0.44),
    clamp(darkToneL + 0.055, 0.12, 0.24),
  );

  // 2) Right Light Zone (genuinely lighter pastel-tinted paper glaze over crisp real artwork!)
  const lightHue = !isMonochrome ? (hiHsl.s > 0.12 ? hiHsl.h : (secondaryRgb ? sHsl.h : pHsl.h)) : pHsl.h;
  const lightToneS = isMonochrome
    ? 0.04
    : isDarkTheme
      ? clamp(pHsl.s * 0.36, 0.12, 0.38)
      : clamp(pHsl.s * 0.42, 0.14, 0.42);
  const lightToneL = isDarkTheme
    ? clamp(0.76 + (avgLum - 0.5) * 0.05, 0.72, 0.83)
    : clamp(0.86 + (avgLum - 0.5) * 0.04, 0.82, 0.91);
  const lightToneRgb = hslToRgb(lightHue, lightToneS, lightToneL);
  const lightToneSoftRgb = hslToRgb(
    secondaryRgb ? sHsl.h : lightHue,
    lightToneS * 0.9,
    clamp(lightToneL + 0.05, 0.75, 0.94),
  );

  // 3) Focus Mid Canvas Tone & Adapted Spatial Perimeter Edge Colors
  const midToneS = isMonochrome ? 0.04 : clamp(pHsl.s * 0.54, 0.16, 0.54);
  const midToneL = isDarkTheme
    ? clamp(0.16 + (avgLum - 0.5) * 0.05, 0.125, 0.235)
    : clamp(0.83 + (avgLum - 0.5) * 0.05, 0.78, 0.89);
  const midToneRgb = hslToRgb(pHsl.h, midToneS, midToneL);

  const edgeLeftRgb = adaptColorFieldForBackdrop(rawEdgeLeft, isDarkTheme, 0.72, 0.82, 0.16);
  const edgeRightRgb = adaptColorFieldForBackdrop(rawEdgeRight, isDarkTheme, 0.76, 0.83, 0.18);
  const edgeTopRgb = adaptColorFieldForBackdrop(rawEdgeTop, isDarkTheme, 0.74, 0.86, 0.19);
  const edgeBottomRgb = adaptColorFieldForBackdrop(rawEdgeBottom, isDarkTheme, 0.72, 0.81, 0.15);

  // Adapt multi-point perimeter strips gently so bright/colorful upper-mid-lower artwork zones continue seamlessly
  const edgeLeftSamplesRgb = rawEdgeLeftBands.map((c) => adaptEdgePointForSeamlessContinuation(c, isDarkTheme));
  const edgeRightSamplesRgb = rawEdgeRightBands.map((c) => adaptEdgePointForSeamlessContinuation(c, isDarkTheme));
  const edgeTopSamplesRgb = rawEdgeTopBands.map((c) => adaptEdgePointForSeamlessContinuation(c, isDarkTheme));
  const edgeBottomSamplesRgb = rawEdgeBottomBands.map((c) => adaptEdgePointForSeamlessContinuation(c, isDarkTheme));

  const edgeLeftSamples = edgeLeftSamplesRgb.map(rgbToHex);
  const edgeRightSamples = edgeRightSamplesRgb.map(rgbToHex);
  const edgeTopSamples = edgeTopSamplesRgb.map(rgbToHex);
  const edgeBottomSamples = edgeBottomSamplesRgb.map(rgbToHex);

  const edgeTlRgb = adaptColorFieldForBackdrop(qTopLeft, isDarkTheme, 0.76, 0.85, 0.2);
  const edgeTrRgb = adaptColorFieldForBackdrop(qTopRight, isDarkTheme, 0.78, 0.84, 0.21);
  const edgeBlRgb = adaptColorFieldForBackdrop(qBottomLeft, isDarkTheme, 0.72, 0.82, 0.15);
  const edgeBrRgb = adaptColorFieldForBackdrop(qBottomRight, isDarkTheme, 0.74, 0.8, 0.16);

  const glowRgb = palette.glowRgb;
  const secGlowRgb = palette.secondaryGlowRgb;

  // Contrast-verified accents & inks across ALL surfaces
  const rawDomRgb = hexToRgbFallback(palette.dominant);
  const darkZoneAccentRgb = adaptAccentContrastForSurface(rawDomRgb, darkToneRgb, 3.6);
  const lightZoneAccentRgb = adaptAccentContrastForSurface(rawDomRgb, lightToneRgb, 3.8);
  const focusSurfaceRgb = midToneRgb;
  const focusAccentRgb = adaptAccentContrastForSurface(rawDomRgb, focusSurfaceRgb, 3.6);

  const darkTextPrimaryRgb: RgbColor = { r: 245, g: 246, b: 250 };
  const darkZoneContrastRatio = computeContrastRatio(darkTextPrimaryRgb, darkToneRgb);

  const lightInkCandidate: RgbColor = hslToRgb(
    lightHue,
    isMonochrome ? 0.04 : clamp(pHsl.s * 0.32, 0.06, 0.22),
    0.095,
  );
  const lightZoneContrastRatio = computeContrastRatio(lightInkCandidate, lightToneRgb);
  const lightPrimaryHex =
    lightZoneContrastRatio >= 7.0 ? rgbToHex(lightInkCandidate) : '#101218';

  // Phase 4.2H Lighter, cleaner Right Veil: reduces washed-out haze so real cover art reads clearly
  // while gently protecting typography columns near left/center-right
  const lightScrimBaseAlpha = isDarkTheme ? (avgLum < 0.35 ? 0.38 : 0.44) : avgLum < 0.35 ? 0.42 : 0.48;
  const lightOverlayCss = `
    radial-gradient(ellipse 68% 76% at 72% 48%, ${rgbCss(edgeTrRgb, isDarkTheme ? 0.22 : 0.28)} 0%, rgba(255,255,255,0) 70%),
    linear-gradient(148deg, ${rgbCss(lightToneSoftRgb, lightScrimBaseAlpha)} 0%, ${rgbCss(lightToneRgb, lightScrimBaseAlpha + 0.07)} 52%, ${rgbCss(lightToneSoftRgb, lightScrimBaseAlpha + 0.11)} 100%)
  `;

  const focusTextRgb: RgbColor = isDarkTheme
    ? { r: 245, g: 246, b: 250 }
    : { r: 16, g: 18, b: 25 };
  const focusContrastRatio = computeContrastRatio(focusTextRgb, focusSurfaceRgb);
  const focusTextPrimary = isDarkTheme
    ? focusContrastRatio >= 7.0
      ? '#F5F6FA'
      : '#FFFFFF'
    : focusContrastRatio >= 7.0
      ? '#101219'
      : '#090A0E';

  const focusBaseColor = rgbToHex(edgeLeftRgb);

  // Phase 4.3H Multi-Point Seamless Edge Continuation:
  // Builds directional multi-stop right & vertical continuations matching upper/mid/lower border samples!
  const rightTopSample = edgeRightSamplesRgb[1] ?? edgeTrRgb;
  const rightMidSample = edgeRightSamplesRgb[Math.floor(edgeRightSamplesRgb.length / 2)] ?? edgeRightRgb;
  const rightBotSample = edgeRightSamplesRgb[edgeRightSamplesRgb.length - 2] ?? edgeBrRgb;
  const topMidSample = edgeTopSamplesRgb[Math.floor(edgeTopSamplesRgb.length / 2)] ?? edgeTopRgb;
  const botMidSample = edgeBottomSamplesRgb[Math.floor(edgeBottomSamplesRgb.length / 2)] ?? edgeBottomRgb;

  const rightEdgeVerticalStops = edgeRightSamplesRgb
    .map((rgb, idx) => {
      const pct = Math.round((idx / Math.max(1, edgeRightSamplesRgb.length - 1)) * 100);
      return `${rgbCss(rgb, 0.88)} ${pct}%`;
    })
    .join(', ');

  const topEdgeHorizontalStops = edgeTopSamplesRgb
    .map((rgb, idx) => {
      const pct = Math.round((idx / Math.max(1, edgeTopSamplesRgb.length - 1)) * 100);
      return `${rgbCss(rgb, 0.72)} ${pct}%`;
    })
    .join(', ');

  const focusDiffusionGradient = `
    radial-gradient(ellipse 68% 64% at 88% 18%, ${rgbCss(rightTopSample, 0.92)} 0%, ${rgbCss(topMidSample, 0.42)} 52%, rgba(0,0,0,0) 82%),
    radial-gradient(ellipse 64% 66% at 92% 50%, ${rgbCss(rightMidSample, 0.90)} 0%, rgba(0,0,0,0) 78%),
    radial-gradient(ellipse 68% 66% at 86% 84%, ${rgbCss(rightBotSample, 0.90)} 0%, ${rgbCss(botMidSample, 0.44)} 52%, rgba(0,0,0,0) 82%),
    radial-gradient(ellipse 56% 64% at 14% 14%, ${rgbCss(edgeTlRgb, 0.76)} 0%, rgba(0,0,0,0) 74%),
    radial-gradient(ellipse 66% 74% at 22% 48%, ${rgbCss(edgeLeftRgb, 0.95)} 0%, ${rgbCss(edgeBlRgb, 0.54)} 48%, rgba(0,0,0,0) 80%),
    linear-gradient(180deg, ${rightEdgeVerticalStops})
  `;

  // Feathered multi-point perimeter continuation (soft corner/outer melt — ZERO hard vertical band at 82%!)
  const focusEdgeContinuationCss = `
    radial-gradient(ellipse 52% 96% at 98% 50%, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 64%, rgba(0,0,0,0.06) 100%),
    linear-gradient(90deg, ${rgbCss(edgeLeftRgb, 0.86)} 0%, ${rgbCss(edgeLeftRgb, 0.28)} 24%, rgba(0,0,0,0) 50%, rgba(0,0,0,0) 100%),
    linear-gradient(180deg, ${rgbCss(topMidSample, 0.48)} 0%, rgba(0,0,0,0) 18%, rgba(0,0,0,0) 82%, ${rgbCss(botMidSample, 0.52)} 100%),
    linear-gradient(90deg, ${topEdgeHorizontalStops})
  `;

  // Check brightness of right-edge samples so Focus typography stays crystal clear over vivid full-cover artwork
  const rightAvgLum =
    edgeRightSamplesRgb.reduce((sum, rgb) => sum + computeRelativeLuminance(rgb), 0) /
    Math.max(1, edgeRightSamplesRgb.length);
  const darkScrimEdgeAlpha = rightAvgLum > 0.45 ? 0.54 : rightAvgLum > 0.25 ? 0.44 : 0.36;
  const focusContrastScrimCss = isDarkTheme
    ? `
      radial-gradient(ellipse 68% 92% at 22% 50%, ${rgbCss(darkToneRgb, 0.26)} 0%, rgba(0,0,0,0) 68%),
      linear-gradient(90deg, ${rgbCss(darkToneRgb, 0.14)} 0%, ${rgbCss(darkToneRgb, 0.22)} 42%, ${rgbCss(darkToneRgb, darkScrimEdgeAlpha)} 100%)
    `
    : `
      radial-gradient(ellipse 68% 92% at 22% 50%, ${rgbCss(lightToneSoftRgb, 0.22)} 0%, rgba(255,255,255,0) 68%),
      linear-gradient(90deg, ${rgbCss(lightToneSoftRgb, 0.20)} 0%, ${rgbCss(lightToneSoftRgb, 0.34)} 48%, ${rgbCss(lightToneSoftRgb, 0.56)} 100%)
    `;

  const darkSurfaceGradient = `
    radial-gradient(circle at 20% 80%, ${rgbCss(edgeBlRgb, 0.52)} 0%, rgba(0,0,0,0) 64%),
    radial-gradient(circle at 76% 18%, rgba(${glowRgb}, 0.18) 0%, rgba(0,0,0,0) 58%),
    linear-gradient(165deg, ${rgbCss(darkToneAltRgb)} 0%, ${rgbCss(darkToneRgb)} 62%, ${rgbCss({
      r: Math.max(8, darkToneRgb.r - 4),
      g: Math.max(8, darkToneRgb.g - 4),
      b: Math.max(10, darkToneRgb.b - 4),
    })} 100%)
  `;

  const standardBarSurfaceCss = isDarkTheme
    ? `linear-gradient(90deg, ${rgbCss(darkToneRgb, 0.96)} 0%, ${rgbCss(darkToneAltRgb, 0.92)} 50%, ${rgbCss(darkToneRgb, 0.95)} 100%)`
    : `linear-gradient(90deg, ${rgbCss(lightToneSoftRgb, 0.94)} 0%, ${rgbCss(lightToneRgb, 0.92)} 50%, ${rgbCss(lightToneSoftRgb, 0.95)} 100%)`;

  return {
    artworkKey: options.artworkKey,
    palette,
    darkZoneAccentHex: rgbToHex(darkZoneAccentRgb),
    lightZoneAccentHex: rgbToHex(lightZoneAccentRgb),
    focusAccentHex: rgbToHex(focusAccentRgb),
    darkToneHex: rgbToHex(darkToneRgb),
    darkToneRgb,
    darkSurfaceGradient,
    lightToneHex: rgbToHex(lightToneRgb),
    lightToneRgb,
    lightSurfaceGradient: `linear-gradient(145deg, ${rgbCss(lightToneSoftRgb)} 0%, ${rgbCss(lightToneRgb)} 100%)`,
    diagonalGlowCss: `linear-gradient(90deg, rgba(${glowRgb}, 0.26) 0%, rgba(${secGlowRgb}, 0.16) 50%, rgba(255,255,255,0) 100%)`,
    standardBarSurfaceCss,
    standardBarBorderCss: isDarkTheme ? `rgba(${glowRgb}, 0.24)` : 'rgba(18, 20, 27, 0.15)',
    standardBarTextPrimary: isDarkTheme ? '#F4F5F8' : '#12141B',
    standardBarTextSecondary: isDarkTheme ? 'rgba(244, 245, 248, 0.84)' : 'rgba(18, 20, 27, 0.80)',
    standardBarTextMuted: isDarkTheme ? 'rgba(244, 245, 248, 0.62)' : 'rgba(18, 20, 27, 0.60)',
    midToneHex: rgbToHex(midToneRgb),
    midToneRgb,
    blurredArtworkUrl: options.blurredArtworkUrl ?? null,
    nowPlayingArtworkUrl: options.nowPlayingArtworkUrl ?? options.blurredArtworkUrl ?? null,
    focusSeamlessBackdropUrl: options.focusSeamlessBackdropUrl ?? null,
    naturalWidth: options.naturalWidth ?? 0,
    naturalHeight: options.naturalHeight ?? 0,
    edgeLeftHex: rgbToHex(edgeLeftRgb),
    edgeRightHex: rgbToHex(edgeRightRgb),
    edgeTopHex: rgbToHex(edgeTopRgb),
    edgeBottomHex: rgbToHex(edgeBottomRgb),
    edgeLeftSamples,
    edgeRightSamples,
    edgeTopSamples,
    edgeBottomSamples,
    darkZoneTextPrimary: '#F5F6FA',
    darkZoneTextSecondary: 'rgba(245, 246, 250, 0.82)',
    darkZoneTextMuted: 'rgba(245, 246, 250, 0.60)',
    darkZoneDivider: 'rgba(255, 255, 255, 0.13)',
    darkZoneContrastRatio,
    lightZoneTextPrimary: lightPrimaryHex,
    lightZoneTextSecondary: 'rgba(16, 18, 25, 0.82)',
    lightZoneTextMuted: 'rgba(16, 18, 25, 0.64)',
    lightZoneDivider: 'rgba(16, 18, 25, 0.14)',
    lightZoneOverlayCss: lightOverlayCss,
    lightZonePrimaryBtnBg: lightPrimaryHex,
    lightZonePrimaryBtnFg: rgbToHex(lightToneSoftRgb),
    lightZoneGhostBtnBg: 'rgba(16, 18, 25, 0.085)',
    lightZoneGhostBtnFg: lightPrimaryHex,
    lightZoneGhostBtnBorder: 'rgba(16, 18, 25, 0.20)',
    lightZoneContrastRatio: Math.max(
      lightZoneContrastRatio,
      computeContrastRatio({ r: 16, g: 18, b: 25 }, lightToneRgb),
    ),
    focusBaseColor,
    focusDiffusionGradient,
    focusEdgeContinuationCss,
    focusContrastScrimCss,
    focusTextPrimary,
    focusTextSecondary: isDarkTheme ? 'rgba(245, 246, 250, 0.82)' : 'rgba(16, 18, 25, 0.82)',
    focusTextMuted: isDarkTheme ? 'rgba(245, 246, 250, 0.62)' : 'rgba(16, 18, 25, 0.62)',
    focusPrimaryBtnBg: focusTextPrimary,
    focusPrimaryBtnFg: focusBaseColor,
    focusContrastRatio,
    isMonochrome,
    isFallback: false,
  };
}

export function buildFallbackAdaptiveTheme(options: {
  artworkKey: string;
  themeMode: ThemeMode;
  palette?: DynamicArtworkPalette;
  blurredArtworkUrl?: string | null;
  nowPlayingArtworkUrl?: string | null;
  focusSeamlessBackdropUrl?: string | null;
  naturalWidth?: number;
  naturalHeight?: number;
}): AdaptiveArtworkTheme {
  const themeMode = options.themeMode;
  const isLight = themeMode === 'light';
  const palette = options.palette ?? FALLBACK_DOREMI_PALETTE;
  const darkToneRgb: RgbColor = { r: 22, g: 25, b: 36 };
  const lightToneRgb: RgbColor = isLight ? { r: 236, g: 237, b: 242 } : { r: 214, g: 216, b: 226 };
  const midToneRgb: RgbColor = isLight ? { r: 232, g: 234, b: 242 } : { r: 24, g: 27, b: 38 };
  const rawAccRgb = hexToRgbFallback(palette.dominant);
  const darkAccent = rgbToHex(adaptAccentContrastForSurface(rawAccRgb, darkToneRgb, 3.6));
  const lightAccent = rgbToHex(adaptAccentContrastForSurface(rawAccRgb, lightToneRgb, 3.8));
  const focusAccent = rgbToHex(adaptAccentContrastForSurface(rawAccRgb, midToneRgb, 3.6));
  const midHex = rgbToHex(midToneRgb);
  const fallbackSamples = Array.from({ length: 12 }, () => midHex);

  return {
    artworkKey: options.artworkKey,
    palette,
    darkZoneAccentHex: darkAccent,
    lightZoneAccentHex: lightAccent,
    focusAccentHex: focusAccent,
    darkToneHex: '#161924',
    darkToneRgb,
    darkSurfaceGradient: `radial-gradient(circle at 20% 80%, rgba(${palette.glowRgb}, 0.22) 0%, transparent 64%), linear-gradient(165deg, rgba(${palette.secondaryGlowRgb}, 0.22) 0%, #161924 58%, #0E1018 100%)`,
    lightToneHex: rgbToHex(lightToneRgb),
    lightToneRgb,
    lightSurfaceGradient: isLight
      ? `linear-gradient(150deg, #F4F5F8 0%, #E7E9F0 100%)`
      : `linear-gradient(150deg, #DFE1E9 0%, #CCD0DC 100%)`,
    diagonalGlowCss: `linear-gradient(90deg, rgba(${palette.glowRgb}, 0.22) 0%, transparent 100%)`,
    standardBarSurfaceCss: isLight
      ? 'rgba(244, 245, 248, 0.94)'
      : `linear-gradient(90deg, rgba(20, 22, 32, 0.96) 0%, rgba(28, 30, 44, 0.92) 100%)`,
    standardBarBorderCss: isLight ? 'rgba(18, 20, 27, 0.14)' : `rgba(${palette.glowRgb}, 0.24)`,
    standardBarTextPrimary: isLight ? '#12141B' : '#F4F5F8',
    standardBarTextSecondary: isLight ? 'rgba(18, 20, 27, 0.80)' : 'rgba(244, 245, 248, 0.82)',
    standardBarTextMuted: isLight ? 'rgba(18, 20, 27, 0.60)' : 'rgba(244, 245, 248, 0.60)',
    midToneHex: midHex,
    midToneRgb,
    blurredArtworkUrl: options.blurredArtworkUrl ?? null,
    nowPlayingArtworkUrl: options.nowPlayingArtworkUrl ?? options.blurredArtworkUrl ?? null,
    focusSeamlessBackdropUrl: options.focusSeamlessBackdropUrl ?? null,
    naturalWidth: options.naturalWidth ?? 0,
    naturalHeight: options.naturalHeight ?? 0,
    edgeLeftHex: midHex,
    edgeRightHex: midHex,
    edgeTopHex: midHex,
    edgeBottomHex: midHex,
    edgeLeftSamples: fallbackSamples,
    edgeRightSamples: fallbackSamples,
    edgeTopSamples: fallbackSamples,
    edgeBottomSamples: fallbackSamples,
    darkZoneTextPrimary: '#F5F6FA',
    darkZoneTextSecondary: 'rgba(245, 246, 250, 0.82)',
    darkZoneTextMuted: 'rgba(245, 246, 250, 0.60)',
    darkZoneDivider: 'rgba(255, 255, 255, 0.13)',
    darkZoneContrastRatio: computeContrastRatio({ r: 245, g: 246, b: 250 }, darkToneRgb),
    lightZoneTextPrimary: '#13151D',
    lightZoneTextSecondary: 'rgba(19, 21, 29, 0.82)',
    lightZoneTextMuted: 'rgba(19, 21, 29, 0.62)',
    lightZoneDivider: 'rgba(19, 21, 29, 0.14)',
    lightZoneOverlayCss: isLight
      ? 'linear-gradient(160deg, rgba(244,245,248,0.48) 0%, rgba(232,235,242,0.56) 100%)'
      : 'linear-gradient(160deg, rgba(223,225,233,0.44) 0%, rgba(204,208,220,0.54) 100%)',
    lightZonePrimaryBtnBg: '#13151D',
    lightZonePrimaryBtnFg: '#F4F5F8',
    lightZoneGhostBtnBg: 'rgba(19, 21, 29, 0.085)',
    lightZoneGhostBtnFg: '#13151D',
    lightZoneGhostBtnBorder: 'rgba(19, 21, 29, 0.20)',
    lightZoneContrastRatio: computeContrastRatio({ r: 19, g: 21, b: 29 }, lightToneRgb),
    focusBaseColor: rgbToHex(midToneRgb),
    focusDiffusionGradient: isLight
      ? `radial-gradient(ellipse 64% 70% at 24% 50%, rgba(${palette.glowRgb}, 0.22) 0%, rgba(232,234,242,0) 74%), linear-gradient(135deg, #F4F5F9 0%, #E5E8F1 100%)`
      : `radial-gradient(ellipse 64% 70% at 24% 50%, rgba(${palette.glowRgb}, 0.26) 0%, rgba(16,18,26,0) 74%), linear-gradient(135deg, #181B26 0%, #0E1018 100%)`,
    focusEdgeContinuationCss: 'none',
    focusContrastScrimCss: isLight
      ? 'linear-gradient(90deg, rgba(244,245,249,0.06) 0%, rgba(244,245,249,0.42) 100%)'
      : 'linear-gradient(90deg, rgba(16,18,26,0.08) 0%, rgba(16,18,26,0.44) 100%)',
    focusTextPrimary: isLight ? '#12141B' : '#F5F6FA',
    focusTextSecondary: isLight ? 'rgba(18, 20, 27, 0.80)' : 'rgba(245, 246, 250, 0.82)',
    focusTextMuted: isLight ? 'rgba(18, 20, 27, 0.60)' : 'rgba(245, 246, 250, 0.60)',
    focusPrimaryBtnBg: isLight ? '#12141B' : '#F5F6FA',
    focusPrimaryBtnFg: rgbToHex(midToneRgb),
    focusContrastRatio: computeContrastRatio(
      isLight ? { r: 18, g: 20, b: 27 } : { r: 245, g: 246, b: 250 },
      midToneRgb,
    ),
    isMonochrome: true,
    isFallback: true,
  };
}

// ============================================================================
// Bounded Shared LRU Cache & Reusable Offscreen Canvases (Low-RAM Discipline)
// ============================================================================

const MAX_ADAPTIVE_CACHE_ENTRIES = 48;
const adaptiveThemeCache = new Map<string, AdaptiveArtworkTheme>();
const inflightAdaptiveResolutions = new Map<string, Promise<AdaptiveArtworkTheme>>();

let sharedSampleCanvas64: HTMLCanvasElement | null = null;
let sharedSampleCtx64: CanvasRenderingContext2D | null = null;
let sharedBlurCanvas: HTMLCanvasElement | null = null;
let sharedBlurCtx: CanvasRenderingContext2D | null = null;

function getSharedSampleCtx64(): CanvasRenderingContext2D | null {
  if (sharedSampleCtx64) return sharedSampleCtx64;
  if (typeof document === 'undefined') return null;
  sharedSampleCanvas64 = document.createElement('canvas');
  sharedSampleCanvas64.width = 64;
  sharedSampleCanvas64.height = 64;
  sharedSampleCtx64 = sharedSampleCanvas64.getContext('2d', { willReadFrequently: true });
  return sharedSampleCtx64;
}

function getSharedBlurSurface(): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} | null {
  if (sharedBlurCanvas && sharedBlurCtx) {
    return { canvas: sharedBlurCanvas, ctx: sharedBlurCtx };
  }
  if (typeof document === 'undefined') return null;
  sharedBlurCanvas = document.createElement('canvas');
  sharedBlurCanvas.width = 480;
  sharedBlurCanvas.height = 480;
  sharedBlurCtx = sharedBlurCanvas.getContext('2d');
  if (!sharedBlurCtx) return null;
  return { canvas: sharedBlurCanvas, ctx: sharedBlurCtx };
}

function resolveBlurDimForPreset(qualityPreset: UiQualityPreset): number {
  if (qualityPreset === 'power-saver') return 0;
  if (qualityPreset === 'high') return 680;
  return 480;
}

function buildCacheKey(
  artworkUrl: string,
  themeMode: ThemeMode,
  dynamicAlbumColors: boolean,
  blurDim: number,
): string {
  return `${themeMode}|dyn=${dynamicAlbumColors ? 1 : 0}|blur4=${blurDim}|${artworkUrl}`;
}

function setCachedTheme(cacheKey: string, value: AdaptiveArtworkTheme): void {
  if (adaptiveThemeCache.has(cacheKey)) {
    adaptiveThemeCache.delete(cacheKey);
  }
  adaptiveThemeCache.set(cacheKey, value);
  if (adaptiveThemeCache.size > MAX_ADAPTIVE_CACHE_ENTRIES) {
    const oldest = adaptiveThemeCache.keys().next().value;
    if (oldest !== undefined) {
      adaptiveThemeCache.delete(oldest);
    }
  }
}

export function getCachedAdaptiveArtworkTheme(options: {
  artworkUrl: string;
  themeMode: ThemeMode;
  dynamicAlbumColors: boolean;
  qualityPreset: UiQualityPreset;
}): AdaptiveArtworkTheme | null {
  const blurDim = resolveBlurDimForPreset(options.qualityPreset);
  const cacheKey = buildCacheKey(
    options.artworkUrl,
    options.themeMode,
    options.dynamicAlbumColors,
    blurDim,
  );
  const hit = adaptiveThemeCache.get(cacheKey);
  if (!hit) {
    return null;
  }
  adaptiveThemeCache.delete(cacheKey);
  adaptiveThemeCache.set(cacheKey, hit);
  return hit;
}

export function getAdaptiveArtworkCacheSize(): number {
  return adaptiveThemeCache.size;
}

export function clearAdaptiveArtworkCache(): void {
  adaptiveThemeCache.clear();
  inflightAdaptiveResolutions.clear();
}

/**
 * Generates moderate-blur, vibrant artwork snapshots ONCE onto a single reused offscreen canvas
 * without dulling shapes (`blur(4–7px)` instead of washed-out `blur(20px)`).
 */
function renderSoftArtworkSnapshot(
  img: HTMLImageElement,
  targetDim: number,
  blurPx: number,
): string | null {
  if (targetDim <= 0) return null;
  const blurSurface = getSharedBlurSurface();
  if (!blurSurface) return null;
  const { canvas, ctx } = blurSurface;
  const natW = Math.max(1, img.naturalWidth || targetDim);
  const natH = Math.max(1, img.naturalHeight || targetDim);
  const scale = targetDim / Math.max(natW, natH);
  const drawW = Math.max(48, Math.round(natW * scale));
  const drawH = Math.max(48, Math.round(natH * scale));
  canvas.width = drawW;
  canvas.height = drawH;
  ctx.clearRect(0, 0, drawW, drawH);

  const overscan = Math.round(blurPx * 2.4);
  if (typeof ctx.filter === 'string' && blurPx > 0) {
    ctx.save();
    ctx.filter = `blur(${blurPx}px) saturate(1.06)`;
    ctx.drawImage(img, -overscan, -overscan, drawW + overscan * 2, drawH + overscan * 2);
    ctx.restore();
  } else {
    ctx.drawImage(img, 0, 0, drawW, drawH);
  }
  try {
    return canvas.toDataURL('image/webp', 0.84);
  } catch {
    try {
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  }
}

function loadCorsImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load error'));
    img.src = src;
  });
}

async function decodeArtworkImageCorsSafe(artworkUrl: string): Promise<{
  img: HTMLImageElement;
  cleanup?: () => void;
}> {
  try {
    const img = await loadCorsImageElement(artworkUrl);
    return { img };
  } catch {
    if (
      typeof fetch === 'function' &&
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function' &&
      !artworkUrl.startsWith('data:') &&
      !artworkUrl.startsWith('blob:')
    ) {
      const response = await fetch(artworkUrl);
      if (!response.ok) {
        throw new Error(`Fetch artwork failed: ${response.status}`);
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      try {
        const img = await loadCorsImageElement(objectUrl);
        return {
          img,
          cleanup: () => URL.revokeObjectURL(objectUrl),
        };
      } catch (err) {
        URL.revokeObjectURL(objectUrl);
        throw err;
      }
    }
    throw new Error('Artwork decode unavailable');
  }
}

/**
 * Shared Adaptive Artwork Pipeline for BOTH Now Playing and Focus Vinyl.
 */
export function resolveAdaptiveArtworkTheme(options: {
  artworkUrl: string;
  themeMode: ThemeMode;
  dynamicAlbumColors: boolean;
  qualityPreset: UiQualityPreset;
  userAccentFallback?: DynamicArtworkPalette;
}): Promise<AdaptiveArtworkTheme> {
  const blurDim = resolveBlurDimForPreset(options.qualityPreset);
  const cacheKey = buildCacheKey(
    options.artworkUrl,
    options.themeMode,
    options.dynamicAlbumColors,
    blurDim,
  );

  const cached = getCachedAdaptiveArtworkTheme(options);
  if (cached) {
    return Promise.resolve(cached);
  }

  const fallbackResult = buildFallbackAdaptiveTheme({
    artworkKey: options.artworkUrl,
    themeMode: options.themeMode,
    palette: options.userAccentFallback,
  });

  if (
    !options.artworkUrl ||
    typeof document === 'undefined' ||
    typeof Image === 'undefined'
  ) {
    return Promise.resolve(fallbackResult);
  }

  const inflight = inflightAdaptiveResolutions.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const promise = (async (): Promise<AdaptiveArtworkTheme> => {
    let cleanup: (() => void) | undefined;
    try {
      const decoded = await decodeArtworkImageCorsSafe(options.artworkUrl);
      cleanup = decoded.cleanup;
      const { img } = decoded;
      const ctx = getSharedSampleCtx64();
      if (!ctx) {
        return fallbackResult;
      }
      ctx.clearRect(0, 0, 64, 64);
      ctx.drawImage(img, 0, 0, 64, 64);
      const pixelData = ctx.getImageData(0, 0, 64, 64).data;

      // Focus uses light artistic blur (7px balanced / 5px high) preserving spatial features;
      // Now Playing Right Zone renders sharper soft artwork (3.5px / 2px) so album details show cleanly.
      const focusBlurPx = blurDim >= 600 ? 5 : 7;
      const npBlurPx = blurDim >= 600 ? 2 : 3.5;
      const blurredArtworkUrl =
        blurDim > 0 ? renderSoftArtworkSnapshot(img, blurDim, focusBlurPx) : null;
      const nowPlayingArtworkUrl =
        blurDim > 0 ? renderSoftArtworkSnapshot(img, blurDim, npBlurPx) : null;
      const focusSeamlessBackdropUrl = null;

      const theme = extractAdaptiveArtworkThemeFromRgbaPixels(pixelData, {
        artworkKey: options.artworkUrl,
        themeMode: options.themeMode,
        dynamicAlbumColors: options.dynamicAlbumColors,
        sampleWidth: 64,
        sampleHeight: 64,
        blurredArtworkUrl,
        nowPlayingArtworkUrl,
        focusSeamlessBackdropUrl,
        naturalWidth: img.naturalWidth || 0,
        naturalHeight: img.naturalHeight || 0,
        userAccentFallback: options.userAccentFallback,
      });
      setCachedTheme(cacheKey, theme);
      return theme;
    } catch {
      return fallbackResult;
    } finally {
      cleanup?.();
      inflightAdaptiveResolutions.delete(cacheKey);
    }
  })();

  inflightAdaptiveResolutions.set(cacheKey, promise);
  return promise;
}
