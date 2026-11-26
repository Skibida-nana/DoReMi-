import fs from 'node:fs/promises';
import path from 'node:path';
import { isAudioExtensionSupported } from '../../shared/contracts/media-protocol';
import type { ImportErrorItem, ScanProgressEvent } from '../../shared/types/library';
import { extractFileExtension } from './path-utils';

export interface FolderDiscoveryResult {
  files: string[];
  errors: ImportErrorItem[];
  failedDirectories: string[];
  canceled: boolean;
}

export interface DiscoverOptions {
  recursive?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: ScanProgressEvent) => void;
}

/**
 * Asynchronously traverses a root directory (and optionally subdirectories) to find supported audio files.
 * - Never modifies or moves files.
 * - Prevents symlink loops via canonical realpath tracking.
 * - Supports cancellation via AbortSignal and isolates per-folder read/permission errors.
 */
export async function discoverAudioFilesInFolder(
  rootFolder: string,
  options: DiscoverOptions = {},
): Promise<FolderDiscoveryResult> {
  const discoveredFiles: string[] = [];
  const errors: ImportErrorItem[] = [];
  const failedDirectories: string[] = [];
  const visitedDirs = new Set<string>();
  const recursive = options.recursive !== false;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootFolder, depth: 0 }];

  while (queue.length > 0) {
    if (options.signal?.aborted) {
      return { files: discoveredFiles, errors, failedDirectories, canceled: true };
    }

    const current = queue.shift()!;
    const currentDir = current.dir;

    let canonicalDir: string;
    try {
      canonicalDir = await fs.realpath(currentDir);
    } catch (error) {
      failedDirectories.push(currentDir);
      errors.push({
        path: currentDir,
        reason: `Không thể truy cập thư mục: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    if (visitedDirs.has(canonicalDir)) {
      continue;
    }
    visitedDirs.add(canonicalDir);

    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      failedDirectories.push(currentDir);
      errors.push({
        path: currentDir,
        reason: `Không thể đọc danh sách thư mục: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    for (const entry of entries) {
      if (options.signal?.aborted) {
        return { files: discoveredFiles, errors, failedDirectories, canceled: true };
      }

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (recursive) {
          queue.push({ dir: fullPath, depth: current.depth + 1 });
        }
        continue;
      }

      if (entry.isSymbolicLink()) {
        try {
          const stat = await fs.stat(fullPath);
          if (stat.isDirectory()) {
            if (recursive) {
              queue.push({ dir: fullPath, depth: current.depth + 1 });
            }
          } else if (stat.isFile() && isAudioExtensionSupported(extractFileExtension(fullPath))) {
            discoveredFiles.push(fullPath);
          }
        } catch (error) {
          errors.push({
            path: fullPath,
            reason: `Liên kết không hợp lệ: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        continue;
      }

      if (entry.isFile() && isAudioExtensionSupported(extractFileExtension(fullPath))) {
        discoveredFiles.push(fullPath);
      }
    }

    options.onProgress?.({
      phase: 'discovering',
      current: discoveredFiles.length,
      total: 0,
      currentPath: currentDir,
      message: `Đang quét thư mục... đã tìm thấy ${discoveredFiles.length} file nhạc`,
    });

    // Yield back to the event loop so IPC and window rendering stay responsive on U-series laptops
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return {
    files: discoveredFiles,
    errors,
    failedDirectories,
    canceled: Boolean(options.signal?.aborted),
  };
}
