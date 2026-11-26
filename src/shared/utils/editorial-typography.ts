import type {
  EditorialFontFormat,
  EditorialTypographySettings,
} from '../types/stage5';

export const DEFAULT_EDITORIAL_TOP_TEXT = 'YOUR MUSIC';
export const DEFAULT_EDITORIAL_BOTTOM_TEXT = 'YOUR WORLD';
export const MAX_EDITORIAL_TEXT_LENGTH = 48;
export const RECOMMENDED_EDITORIAL_TEXT_LENGTH = 18;
export const MAX_EDITORIAL_FONT_BYTES = 15 * 1024 * 1024; // 15 MB

export const DEFAULT_EDITORIAL_TYPOGRAPHY: EditorialTypographySettings = {
  enabled: true,
  topText: DEFAULT_EDITORIAL_TOP_TEXT,
  bottomText: DEFAULT_EDITORIAL_BOTTOM_TEXT,
  selectedFontId: null,
  fontSizeScale: 1,
  opacity: 0.18,
};

export interface ValidatedEditorialFont {
  format: EditorialFontFormat;
  extension: `.${EditorialFontFormat}`;
  mimeType: string;
  displayName: string;
}

const FONT_MIME_BY_FORMAT: Record<EditorialFontFormat, string> = {
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

const VALID_FONT_EXTENSIONS = new Set<string>(['.ttf', '.otf', '.woff', '.woff2']);

/**
 * Cleans user-entered editorial background typography WITHOUT forcing uppercase
 * and WITHOUT stripping Vietnamese, Chinese, Japanese, Korean, or other valid Unicode.
 * Only strips control characters / line breaks and normalizes NFC.
 */
export function sanitizeEditorialTextLine(raw: unknown, fallback = ''): string {
  if (typeof raw !== 'string') {
    return fallback;
  }
  const cleaned = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return Array.from(cleaned).slice(0, MAX_EDITORIAL_TEXT_LENGTH).join('');
}

export function clampEditorialFontSizeScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_EDITORIAL_TYPOGRAPHY.fontSizeScale;
  }
  return Math.round(Math.max(0.75, Math.min(1.25, value)) * 100) / 100;
}

export function clampEditorialOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_EDITORIAL_TYPOGRAPHY.opacity;
  }
  return Math.round(Math.max(0.08, Math.min(0.32, value)) * 100) / 100;
}

export function normalizeEditorialTypographySettings(
  raw: Partial<EditorialTypographySettings> | null | undefined,
  validFontIds?: Set<string>,
): EditorialTypographySettings {
  const input = raw ?? {};
  const topText =
    typeof input.topText === 'string'
      ? sanitizeEditorialTextLine(input.topText, '')
      : DEFAULT_EDITORIAL_TOP_TEXT;
  const bottomText =
    typeof input.bottomText === 'string'
      ? sanitizeEditorialTextLine(input.bottomText, '')
      : DEFAULT_EDITORIAL_BOTTOM_TEXT;

  let selectedFontId =
    typeof input.selectedFontId === 'string' && input.selectedFontId.trim().length > 0
      ? input.selectedFontId.trim()
      : null;

  if (selectedFontId && validFontIds && !validFontIds.has(selectedFontId)) {
    selectedFontId = null;
  }

  return {
    enabled:
      typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_EDITORIAL_TYPOGRAPHY.enabled,
    topText,
    bottomText,
    selectedFontId,
    fontSizeScale: clampEditorialFontSizeScale(input.fontSizeScale),
    opacity: clampEditorialOpacity(input.opacity),
  };
}

/**
 * Derives a clean human-readable display name from a font filename.
 */
export function deriveEditorialFontName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const spaced = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!spaced) {
    return 'Custom Editorial Font';
  }
  return Array.from(spaced.normalize('NFC')).slice(0, 48).join('');
}

/**
 * Strictly validates local font bytes (.ttf, .otf, .woff, .woff2) using both
 * file extension and binary magic header bytes. Rejects corrupt, renamed, or
 * oversized files safely before persisting or loading.
 */
export function validateEditorialFontBytes(
  bytes: Uint8Array,
  fileName: string,
  maxBytes = MAX_EDITORIAL_FONT_BYTES,
): ValidatedEditorialFont {
  if (!bytes || bytes.length < 16) {
    throw new Error('File font trống hoặc bị hỏng.');
  }
  if (bytes.length > maxBytes) {
    const mb = Math.round(maxBytes / (1024 * 1024));
    throw new Error(`Dung lượng file font vượt quá giới hạn ${mb}MB.`);
  }

  const lowerName = (fileName || '').toLowerCase();
  const extMatch = /\.[a-z0-9]+$/.exec(lowerName);
  const ext = extMatch ? extMatch[0] : '';
  if (!VALID_FONT_EXTENSIONS.has(ext)) {
    throw new Error('Định dạng font không được hỗ trợ. Chỉ chấp nhận .ttf, .otf, .woff hoặc .woff2.');
  }

  const b0 = bytes[0];
  const b1 = bytes[1];
  const b2 = bytes[2];
  const b3 = bytes[3];
  const ascii4 = String.fromCharCode(b0, b1, b2, b3);

  let detected: EditorialFontFormat | null = null;
  if (ascii4 === 'wOF2') {
    detected = 'woff2';
  } else if (ascii4 === 'wOFF') {
    detected = 'woff';
  } else if (ascii4 === 'OTTO') {
    detected = 'otf';
  } else if (
    (b0 === 0x00 && b1 === 0x01 && b2 === 0x00 && b3 === 0x00) ||
    ascii4 === 'true' ||
    ascii4 === 'typ1'
  ) {
    detected = 'ttf';
  }

  if (!detected) {
    throw new Error('Header file font không hợp lệ hoặc file bị hỏng.');
  }

  // Allow OpenType-flavoured .ttf/.otf interchange safely while rejecting mismatched woff containers
  const extFormat = ext.slice(1) as EditorialFontFormat;
  if (
    (extFormat === 'woff2' && detected !== 'woff2') ||
    (extFormat === 'woff' && detected !== 'woff') ||
    ((extFormat === 'ttf' || extFormat === 'otf') && detected !== 'ttf' && detected !== 'otf')
  ) {
    throw new Error('Nội dung file font không khớp với phần mở rộng.');
  }

  return {
    format: detected,
    extension: `.${detected}`,
    mimeType: FONT_MIME_BY_FORMAT[detected],
    displayName: deriveEditorialFontName(fileName),
  };
}

export interface EditorialTypographyLayoutMetrics {
  topFontSizePx: number;
  bottomFontSizePx: number;
  letterSpacingEm: number;
  lineHeight: number;
  topLineLongWarning: boolean;
  bottomLineLongWarning: boolean;
}

/**
 * Estimates visual character width units (CJK/wide glyphs count higher than Latin).
 */
function estimateVisualUnits(text: string): number {
  let units = 0;
  for (const ch of Array.from(text)) {
    const cp = ch.codePointAt(0) ?? 0;
    const isWide =
      (cp >= 0x3000 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xff00 && cp <= 0xffef);
    units += isWide ? 1.55 : ch === ' ' ? 0.55 : 0.92;
  }
  return Math.max(4, units);
}

/**
 * Computes responsive editorial display font sizes anchored to the Gallery container
 * so default copy ("YOUR MUSIC" / "YOUR WORLD") lands squarely in 110–160px on 1440×900,
 * scales gracefully on 1920×1080 / 1366×768 / 1024×768, and safely shrinks long custom
 * text without horizontal clipping or collapsing to tiny heading sizes.
 */
export function computeEditorialTypographyMetrics(options: {
  topText: string;
  bottomText: string;
  containerWidth: number;
  containerHeight: number;
  fontSizeScale?: number;
}): EditorialTypographyLayoutMetrics {
  const width = Math.max(320, options.containerWidth || 1280);
  const height = Math.max(260, options.containerHeight || 680);
  const scale = clampEditorialFontSizeScale(options.fontSizeScale ?? 1);

  // Baseline display size driven by gallery width and height
  // At 1440×900 (~1290×700 gallery): baseTarget ≈ 140px (comfortably within 110–160px)
  const widthDriven = width * 0.112;
  const heightDriven = height * 0.215;
  const basePx = Math.max(54, Math.min(168, Math.min(widthDriven, heightDriven))) * scale;

  const computeLineSize = (text: string): number => {
    const trimmed = text.trim();
    if (!trimmed) {
      return Math.round(basePx);
    }
    const visualUnits = estimateVisualUnits(trimmed);
    // Target occupying up to ~90% of gallery width cleanly with editorial presence
    const fitWidthPx = (width * 0.91) / (visualUnits * 0.66);
    const clamped = Math.max(42, Math.min(basePx, fitWidthPx));
    return Math.round(clamped);
  };

  const topFontSizePx = computeLineSize(options.topText);
  const bottomFontSizePx = computeLineSize(options.bottomText);

  const longest = Math.max(
    Array.from(options.topText.trim()).length,
    Array.from(options.bottomText.trim()).length,
  );
  const combined = `${options.topText} ${options.bottomText}`.normalize('NFC');
  const hasExtendedMarks = /[^\u0000-\u007F]/.test(combined);
  const letterSpacingEm = longest > 18 ? 0.01 : longest > 12 ? 0.022 : 0.036;

  return {
    topFontSizePx,
    bottomFontSizePx,
    letterSpacingEm,
    lineHeight: hasExtendedMarks ? 1.12 : 1.02,
    topLineLongWarning: Array.from(options.topText.trim()).length > RECOMMENDED_EDITORIAL_TEXT_LENGTH,
    bottomLineLongWarning:
      Array.from(options.bottomText.trim()).length > RECOMMENDED_EDITORIAL_TEXT_LENGTH,
  };
}
