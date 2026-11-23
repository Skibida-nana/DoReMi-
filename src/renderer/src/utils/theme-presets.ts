import type {
  PersonalizationPreferences,
  ThemeAccentPreset,
  ThemeMode,
} from '../../../shared/types/stage5';
import type { AlbumColorPalette } from '../data/prototype-catalog';

export const THEME_ACCENT_PRESETS: ThemeAccentPreset[] = [
  {
    id: 'violet',
    name: 'Tím Khói',
    hex: '#8B5CF6',
    glowRgb: '139, 92, 246',
    secondaryHex: '#6D28D9',
    secondaryGlowRgb: '109, 40, 217',
  },
  {
    id: 'rose',
    name: 'Hồng Mận',
    hex: '#F43F5E',
    glowRgb: '244, 63, 94',
    secondaryHex: '#BE123C',
    secondaryGlowRgb: '190, 18, 60',
  },
  {
    id: 'amber',
    name: 'Hổ Phách',
    hex: '#F59E0B',
    glowRgb: '245, 158, 11',
    secondaryHex: '#B45309',
    secondaryGlowRgb: '180, 83, 9',
  },
  {
    id: 'emerald',
    name: 'Ngọc Lục',
    hex: '#10B981',
    glowRgb: '16, 185, 129',
    secondaryHex: '#047857',
    secondaryGlowRgb: '4, 120, 87',
  },
  {
    id: 'sky',
    name: 'Thanh Thiên',
    hex: '#38BDF8',
    glowRgb: '56, 189, 248',
    secondaryHex: '#0284C7',
    secondaryGlowRgb: '2, 132, 199',
  },
  {
    id: 'indigo',
    name: 'Xanh Chàm',
    hex: '#6366F1',
    glowRgb: '99, 102, 241',
    secondaryHex: '#4338CA',
    secondaryGlowRgb: '67, 56, 202',
  },
];

export interface ResolvedAccentPalette {
  id: string;
  name: string;
  /** Vibrant accent suitable for dark backgrounds and highlights */
  hex: string;
  /** Deeper accent with stronger contrast on light surfaces */
  lightSafeHex: string;
  /** Effective accent matching current themeMode */
  activeHex: string;
  glowRgb: string;
  secondaryHex: string;
  secondaryGlowRgb: string;
  /** Guaranteed legible foreground text color on top of activeHex */
  onAccentText: '#FFFFFF' | '#0F1117';
}

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

export function normalizeHexColor(hex: string | null | undefined): string | null {
  if (!hex || typeof hex !== 'string') {
    return null;
  }
  const trimmed = hex.trim();
  if (HEX_COLOR_RE.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return null;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return {
    r: Number.isFinite(r) ? r : 139,
    g: Number.isFinite(g) ? g : 92,
    b: Number.isFinite(b) ? b : 246,
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toByte = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`.toUpperCase();
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * Darkens overly bright custom accents when rendered on Light Mode surfaces
 * so icons, filled sliders, and badges always retain WCAG AA contrast.
 */
export function darkenHex(hex: string, factor: number): string {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(r * (1 - factor), g * (1 - factor), b * (1 - factor));
}

export function resolveUserAccentPalette(
  prefs: Pick<PersonalizationPreferences, 'accentPresetId' | 'customAccentHex' | 'themeMode'>,
): ResolvedAccentPalette {
  const customHex = normalizeHexColor(prefs.customAccentHex);
  const preset =
    THEME_ACCENT_PRESETS.find((item) => item.id === prefs.accentPresetId) ??
    THEME_ACCENT_PRESETS[0];

  const baseHex = customHex ?? preset.hex;
  const { r, g, b } = hexToRgb(baseHex);
  const lum = relativeLuminance(baseHex);

  const lightSafeHex = customHex
    ? lum > 0.32
      ? darkenHex(customHex, 0.34)
      : customHex
    : preset.secondaryHex;

  const secondaryHex = customHex ? darkenHex(customHex, 0.28) : preset.secondaryHex;
  const secRgb = hexToRgb(secondaryHex);
  const activeHex = prefs.themeMode === 'light' ? lightSafeHex : baseHex;
  const activeLum = relativeLuminance(activeHex);

  return {
    id: customHex ? 'custom' : preset.id,
    name: customHex ? 'Tùy chỉnh' : preset.name,
    hex: baseHex,
    lightSafeHex,
    activeHex,
    glowRgb: `${r}, ${g}, ${b}`,
    secondaryHex,
    secondaryGlowRgb: `${secRgb.r}, ${secRgb.g}, ${secRgb.b}`,
    onAccentText: activeLum > 0.45 ? '#0F1117' : '#FFFFFF',
  };
}

export function accentToAlbumPalette(
  accent: ResolvedAccentPalette,
  themeMode: ThemeMode,
): AlbumColorPalette {
  return {
    dominant: accent.activeHex,
    secondary: accent.secondaryHex,
    glowRgb: accent.glowRgb,
    secondaryGlowRgb: accent.secondaryGlowRgb,
    badgeBg:
      themeMode === 'light'
        ? `rgba(${accent.glowRgb}, 0.14)`
        : `rgba(${accent.glowRgb}, 0.20)`,
    borderGlow: `rgba(${accent.glowRgb}, 0.42)`,
  };
}
