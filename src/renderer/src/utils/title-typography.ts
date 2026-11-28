export interface DisplayTitleTypographyStyle {
  fontSize: string;
  lineHeight: number;
  maxLines: 2 | 3;
}

/**
 * Computes responsive display typography for Now Playing & Focus Player track titles.
 *
 * Ensures long multi-word titles and stacked Vietnamese diacritics / descenders
 * (e.g. `Ầ`, `Ố`, `đ`, `p`, `g`, `y`) wrap cleanly without vertical clipping or mid-glyph slicing.
 */
export function resolveNowPlayingTitleTypography(
  title: string,
  mode: 'standard' | 'focus',
): DisplayTitleTypographyStyle {
  const normalizedLen = Array.from((title ?? '').normalize('NFC').trim()).length;

  if (mode === 'standard') {
    if (normalizedLen <= 24) {
      return {
        fontSize: 'clamp(26px, 2.35vw, 40px)',
        lineHeight: 1.24,
        maxLines: 3,
      };
    }
    if (normalizedLen <= 46) {
      return {
        fontSize: 'clamp(22px, 1.9vw, 32px)',
        lineHeight: 1.26,
        maxLines: 3,
      };
    }
    return {
      fontSize: 'clamp(19px, 1.6vw, 26px)',
      lineHeight: 1.28,
      maxLines: 3,
    };
  }

  // Focus mode (large radial editorial typography next to spinning vinyl)
  if (normalizedLen <= 20) {
    return {
      fontSize: 'clamp(48px, 4.2vw, 80px)',
      lineHeight: 1.18,
      maxLines: 3,
    };
  }
  if (normalizedLen <= 34) {
    return {
      fontSize: 'clamp(36px, 3.1vw, 54px)',
      lineHeight: 1.2,
      maxLines: 3,
    };
  }
  if (normalizedLen <= 56) {
    return {
      fontSize: 'clamp(28px, 2.45vw, 42px)',
      lineHeight: 1.22,
      maxLines: 3,
    };
  }
  return {
    fontSize: 'clamp(24px, 2.05vw, 34px)',
    lineHeight: 1.25,
    maxLines: 3,
  };
}
