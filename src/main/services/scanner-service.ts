import fs from 'node:fs/promises';
import path from 'node:path';
import { isAudioExtensionSupported } from '../../shared/contracts/media-protocol';
import type { ImportErrorItem, ScanProgressEvent } from '../../shared/types/library';
import { extractFileExtension } from './path-utils';

export interface FolderDiscoveryResult {
  files: string[];
  errors: ImportErrorItem[];
}

export interface DiscoverOptions {
  onProgress?: (event: ScanProgressEvent) => void;
}

/**
 * Asynchronously traverses a root directory and all subdirectories to find supported audio files.
 * - Never modifies or moves files.
 * - Prevents symlink loops via canonical realpath tracking.
 * - Isolates per-folder read/permission errors so scanning continues smoothly.
 */
export async function discoverAudioFilesInFolder(
  rootFolder: string,
  options: DiscoverOptions = {},
): Promise<FolderDiscoveryResult> {
  const discoveredFiles: string[] = [];
  const errors: ImportErrorItem[] = [];
  const visitedDirs = new Set<string>();
  const queue: string[] = [rootFolder];

  while (queue.length > 0) {
    const currentDir = queue.shift()!;

    let canonicalDir: string;
    try {
      canonicalDir = await fs.realpath(currentDir);
    } catch (error) {
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
      errors.push({
        path: currentDir,
        reason: `Không thể đọc danh sách thư mục: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (entry.isSymbolicLink()) {
        try {
          const stat = await fs.stat(fullPath);
          if (stat.isDirectory()) {
            queue.push(fullPath);
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

    // Yield back to the event loop so IPC and window rendering stay responsive
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { files: discoveredFiles, errors };
}
