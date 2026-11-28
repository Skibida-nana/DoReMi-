import { compareAlbumTracksCanonical, parseAlbumOrdinal } from './album-sort';
import {
  extractFileNameFromPath,
  extractParentFolderPath,
  naturalCompare,
  normalizeFolderKey,
} from './natural-sort';

export interface FolderTrackSortable {
  id: string;
  original_path: string;
  normalized_path?: string;
  title: string;
  artist: string;
  albumTitle?: string | null;
  album?: string | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  track_number?: number | null;
  disc_number?: number | null;
  file_name?: string | null;
  status: string;
  availability_state?: string;
}

export interface LibraryFolderSummaryItem {
  folderKey: string;
  folderPath: string;
  folderName: string;
  parentFolderKey: string | null;
  directTrackCount: number;
  recursiveTrackCount: number;
  availableCount: number;
  missingCount: number;
  sourceUnavailableCount: number;
  childFolderKeys: string[];
  rootId: string | null;
  isWatchedRoot: boolean;
}

export interface FolderBreadcrumbItem {
  folderKey: string;
  label: string;
  folderPath: string;
}

export function getEffectiveFileName(track: FolderTrackSortable): string {
  return track.file_name || extractFileNameFromPath(track.original_path) || track.title;
}

export function compareTracksByTrackNumber(
  a: FolderTrackSortable,
  b: FolderTrackSortable,
): number {
  return compareAlbumTracksCanonical({
    id: a.id,
    title: a.title,
    disc_number: parseAlbumOrdinal(a.disc_number ?? a.discNumber),
    track_number: parseAlbumOrdinal(a.track_number ?? a.trackNumber),
    file_name: a.file_name,
    original_path: a.original_path,
  }, {
    id: b.id,
    title: b.title,
    disc_number: parseAlbumOrdinal(b.disc_number ?? b.discNumber),
    track_number: parseAlbumOrdinal(b.track_number ?? b.trackNumber),
    file_name: b.file_name,
    original_path: b.original_path,
  });
}

export function compareTracksByFileName(
  a: FolderTrackSortable,
  b: FolderTrackSortable,
): number {
  const fileCmp = naturalCompare(getEffectiveFileName(a), getEffectiveFileName(b));
  if (fileCmp !== 0) {
    return fileCmp;
  }
  return naturalCompare(a.original_path, b.original_path);
}

export function compareTracksByFolder(
  a: FolderTrackSortable,
  b: FolderTrackSortable,
): number {
  const folderA = extractParentFolderPath(a.original_path);
  const folderB = extractParentFolderPath(b.original_path);
  const folderCmp = naturalCompare(folderA, folderB);
  if (folderCmp !== 0) {
    return folderCmp;
  }
  return compareTracksByTrackNumber(a, b);
}

export function isTrackInsideFolder(
  trackPath: string,
  folderKey: string,
  includeSubfolders: boolean,
): boolean {
  const parentPath = extractParentFolderPath(trackPath);
  const parentKey = normalizeFolderKey(parentPath);
  if (!parentKey || !folderKey) {
    return false;
  }
  if (parentKey === folderKey) {
    return true;
  }
  if (!includeSubfolders) {
    return false;
  }
  const sep = folderKey.includes('\\') || /^[a-z]:/i.test(folderKey) ? '\\' : '/';
  const prefix = folderKey.endsWith(sep) ? folderKey : `${folderKey}${sep}`;
  return parentKey.startsWith(prefix);
}

export function extractFolderDisplayName(folderPath: string): string {
  if (!folderPath) {
    return 'Thư mục';
  }
  if (/^[A-Za-z]:\\?$/.test(folderPath)) {
    return folderPath.endsWith('\\') ? folderPath : `${folderPath}\\`;
  }
  if (folderPath === '/') {
    return '/';
  }
  const cleaned = folderPath.replace(/[\\/]+$/, '');
  const lastSep = Math.max(cleaned.lastIndexOf('\\'), cleaned.lastIndexOf('/'));
  return lastSep >= 0 ? cleaned.slice(lastSep + 1) || cleaned : cleaned;
}

export function buildFolderHierarchy(
  tracks: readonly FolderTrackSortable[],
  roots: ReadonlyArray<{ id: string; original_path: string; normalized_path: string }> = [],
): {
  foldersByKey: Map<string, LibraryFolderSummaryItem>;
  topLevelKeys: string[];
} {
  const foldersByKey = new Map<string, LibraryFolderSummaryItem>();
  const rootByNormalized = new Map<string, string>();
  for (const root of roots) {
    const key = normalizeFolderKey(root.original_path || root.normalized_path);
    if (key) {
      rootByNormalized.set(key, root.id);
    }
  }

  const ensureNode = (folderPath: string): LibraryFolderSummaryItem | null => {
    const key = normalizeFolderKey(folderPath);
    if (!key) {
      return null;
    }
    const existing = foldersByKey.get(key);
    if (existing) {
      return existing;
    }
    const parentRaw = extractParentFolderPath(folderPath);
    const parentKeyCandidate = parentRaw ? normalizeFolderKey(parentRaw) : '';
    const parentKey = parentKeyCandidate && parentKeyCandidate !== key ? parentKeyCandidate : null;

    const created: LibraryFolderSummaryItem = {
      folderKey: key,
      folderPath,
      folderName: extractFolderDisplayName(folderPath),
      parentFolderKey: parentKey,
      directTrackCount: 0,
      recursiveTrackCount: 0,
      availableCount: 0,
      missingCount: 0,
      sourceUnavailableCount: 0,
      childFolderKeys: [],
      rootId: rootByNormalized.get(key) ?? null,
      isWatchedRoot: rootByNormalized.has(key),
    };
    foldersByKey.set(key, created);
    return created;
  };

  for (const root of roots) {
    ensureNode(root.original_path);
  }

  // Track intermediate directories between each file's directory and either its watched root
  // or filesystem drive root so multi-level navigation mirrors disk organization cleanly.
  for (const track of tracks) {
    const folderPath = extractParentFolderPath(track.original_path);
    const leafNode = ensureNode(folderPath);
    if (!leafNode) {
      continue;
    }

    leafNode.directTrackCount += 1;

    const availability = track.availability_state ?? track.status;
    const isAvailable = track.status === 'available' && availability === 'available';
    const isSourceUnavailable = availability === 'source_unavailable';

    // Walk ancestors up until matching a watched root (if any) or drive root
    const visitedKeys = new Set<string>();
    let current: LibraryFolderSummaryItem | null = leafNode;
    let guard = 0;

    while (current && !visitedKeys.has(current.folderKey) && guard < 40) {
      guard += 1;
      visitedKeys.add(current.folderKey);
      current.recursiveTrackCount += 1;
      if (isAvailable) {
        current.availableCount += 1;
      } else if (isSourceUnavailable) {
        current.sourceUnavailableCount += 1;
      } else {
        current.missingCount += 1;
      }

      if (current.isWatchedRoot || !current.parentFolderKey) {
        if (current.isWatchedRoot) {
          current.parentFolderKey = null;
        }
        break;
      }

      const parentPathRaw = extractParentFolderPath(current.folderPath);
      const nextParentKey = normalizeFolderKey(parentPathRaw);
      if (!nextParentKey || nextParentKey === current.folderKey) {
        current.parentFolderKey = null;
        break;
      }

      // Stop climbing if parent is just the filesystem root while current is a direct drive subfolder unless parent is a root
      const isDriveRootParent =
        /^[a-z]:\\?$/i.test(parentPathRaw) || parentPathRaw === '/';
      if (isDriveRootParent && !rootByNormalized.has(nextParentKey)) {
        current.parentFolderKey = null;
        break;
      }

      const parentNode = ensureNode(parentPathRaw);
      if (!parentNode) {
        current.parentFolderKey = null;
        break;
      }
      if (!parentNode.childFolderKeys.includes(current.folderKey)) {
        parentNode.childFolderKeys.push(current.folderKey);
      }
      current.parentFolderKey = parentNode.folderKey;
      current = parentNode;
    }
  }

  for (const node of foldersByKey.values()) {
    node.childFolderKeys.sort((ka, kb) => {
      const a = foldersByKey.get(ka);
      const b = foldersByKey.get(kb);
      return naturalCompare(a?.folderName ?? ka, b?.folderName ?? kb);
    });
  }

  const topLevelKeys = Array.from(foldersByKey.values())
    .filter((node) => node.parentFolderKey === null)
    .sort((a, b) => naturalCompare(a.folderName, b.folderName))
    .map((n) => n.folderKey);

  return { foldersByKey, topLevelKeys };
}

export function buildFolderBreadcrumbs(
  folderKey: string | null,
  foldersByKey: Map<string, LibraryFolderSummaryItem>,
): FolderBreadcrumbItem[] {
  if (!folderKey) {
    return [];
  }
  const crumbs: FolderBreadcrumbItem[] = [];
  let cursorKey: string | null = folderKey;
  const seen = new Set<string>();
  while (cursorKey && !seen.has(cursorKey)) {
    seen.add(cursorKey);
    const node = foldersByKey.get(cursorKey);
    if (!node) {
      break;
    }
    crumbs.unshift({
      folderKey: node.folderKey,
      label: node.folderName,
      folderPath: node.folderPath,
    });
    cursorKey = node.parentFolderKey;
  }
  return crumbs;
}
