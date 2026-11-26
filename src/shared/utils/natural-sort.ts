const NATURAL_COLLATOR = new Intl.Collator('vi', {
  numeric: true,
  sensitivity: 'base',
});

export function naturalCompare(a: string | null | undefined, b: string | null | undefined): number {
  const left = (a ?? '').normalize('NFC');
  const right = (b ?? '').normalize('NFC');
  if (left === right) {
    return 0;
  }
  const cmp = NATURAL_COLLATOR.compare(left, right);
  if (cmp !== 0) {
    return cmp;
  }
  return left.localeCompare(right, 'vi', { numeric: true });
}

export function extractFileNameFromPath(filePath: string): string {
  if (!filePath) {
    return '';
  }
  const normalized = filePath.replace(/\//g, '\\');
  const lastSep = normalized.lastIndexOf('\\');
  return lastSep >= 0 ? normalized.slice(lastSep + 1) : normalized;
}

export function extractParentFolderPath(filePath: string): string {
  if (!filePath) {
    return '';
  }
  const useBackslash = filePath.includes('\\') && !filePath.startsWith('/');
  const sep = useBackslash ? '\\' : '/';
  const unified = useBackslash ? filePath.replace(/\//g, '\\') : filePath;
  const idx = unified.lastIndexOf(sep);
  if (idx < 0) {
    return '';
  }
  if (idx === 0) {
    return sep;
  }
  // Keep Windows drive root trailing slash e.g. C:\
  if (idx === 2 && /^[A-Za-z]:$/.test(unified.slice(0, 2))) {
    return unified.slice(0, 3);
  }
  return unified.slice(0, idx);
}

export function normalizeFolderKey(folderPath: string): string {
  const trimmed = folderPath.trim().normalize('NFC');
  if (!trimmed) {
    return '';
  }
  const isWin = /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith('\\\\') || trimmed.includes('\\');
  if (isWin) {
    let out = trimmed.replace(/\//g, '\\');
    if (out.length > 3 && out.endsWith('\\')) {
      out = out.replace(/\\+$/, '');
    }
    return out.toLocaleLowerCase('en-US');
  }
  let out = trimmed;
  if (out.length > 1 && out.endsWith('/')) {
    out = out.replace(/\/+$/, '');
  }
  return out;
}
