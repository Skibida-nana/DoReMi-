import type { CustomEditorialFontRecord } from '../../../shared/types/stage5';

const loadedFamilyByKey = new Map<string, string>();
const failedFontKeys = new Set<string>();
const pendingLoads = new Map<string, Promise<string | null>>();

function getFontKey(font: CustomEditorialFontRecord): string {
  return `${font.id}:${font.hash}`;
}

export function getEditorialFontFamilyName(fontId: string): string {
  const safeId = fontId.replace(/[^a-zA-Z0-9_-]/g, '');
  return `DoReMiEditorialFont_${safeId}`;
}

/**
 * Loads a custom local editorial font once into `document.fonts` and caches it so
 * React re-renders never reload font binaries. Scoped strictly to Home Editorial
 * Background Typography — never replaces global app/lyrics/UI fonts.
 */
export async function ensureEditorialFontLoaded(
  font: CustomEditorialFontRecord | null | undefined,
): Promise<{ familyName: string | null; failed: boolean }> {
  if (!font || typeof window === 'undefined' || typeof FontFace === 'undefined') {
    return { familyName: null, failed: false };
  }

  const key = getFontKey(font);
  const cached = loadedFamilyByKey.get(key);
  if (cached) {
    return { familyName: cached, failed: false };
  }
  if (failedFontKeys.has(key)) {
    return { familyName: null, failed: true };
  }

  const existingPromise = pendingLoads.get(key);
  if (existingPromise) {
    const resolved = await existingPromise;
    return { familyName: resolved, failed: resolved === null };
  }

  const familyName = getEditorialFontFamilyName(font.id);
  const loadPromise = (async (): Promise<string | null> => {
    try {
      const face = new FontFace(familyName, `url("${font.url}")`, {
        style: 'normal',
        weight: '100 900',
        display: 'swap',
      });
      const loadedFace = await face.load();
      document.fonts.add(loadedFace);
      loadedFamilyByKey.set(key, familyName);
      return familyName;
    } catch {
      failedFontKeys.add(key);
      return null;
    } finally {
      pendingLoads.delete(key);
    }
  })();

  pendingLoads.set(key, loadPromise);
  const resolved = await loadPromise;
  return { familyName: resolved, failed: resolved === null };
}

/**
 * Unloads a deleted custom font from `document.fonts` and clears cache entries.
 */
export function unloadEditorialFont(fontId: string): void {
  const targetFamily = getEditorialFontFamilyName(fontId);
  for (const key of Array.from(loadedFamilyByKey.keys())) {
    if (key.startsWith(`${fontId}:`)) {
      loadedFamilyByKey.delete(key);
    }
  }
  for (const key of Array.from(failedFontKeys.values())) {
    if (key.startsWith(`${fontId}:`)) {
      failedFontKeys.delete(key);
    }
  }
  if (typeof document !== 'undefined' && document.fonts) {
    for (const face of Array.from(document.fonts)) {
      if (face.family === targetFamily || face.family === `"${targetFamily}"`) {
        document.fonts.delete(face);
      }
    }
  }
}

/**
 * Builds the CSS font-family stack for the Home Editorial Background Typography layer.
 * Always keeps var(--font-display) fallback so Vietnamese/CJK glyphs missing from a
 * custom display font gracefully fall back without tofu boxes.
 */
export function buildEditorialFontStack(loadedFamilyName: string | null): string {
  if (!loadedFamilyName) {
    return 'var(--font-display)';
  }
  return `"${loadedFamilyName}", var(--font-display)`;
}
