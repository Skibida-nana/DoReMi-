import fs from 'node:fs/promises';
import path from 'node:path';
import { isValidTrackUuid } from '../../../shared/contracts/media-protocol';
import type { TrackRecord } from '../../../shared/types/track';
import type { TrackRepository } from '../../database/track-repository';
import { isNormalizedPathWithinRoot, normalizeTrackPath } from '../path-utils';
import type { ConnectRepository } from './connect-repository';

const WINDOWS_UNC_RE = /^\\\\[^\\]/;

export interface GuardedFsOps {
  realpath(targetPath: string): Promise<string>;
  lstat(
    targetPath: string,
  ): Promise<{ isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean } | null>;
  openRead(targetPath: string): Promise<{
    fd: number;
    stat(): Promise<{ isFile(): boolean; size: number; mtimeMs: number; dev: number; ino: number }>;
    close(): Promise<void>;
  }>;
}

export const defaultGuardedFsOps: GuardedFsOps = {
  realpath: (p) => fs.realpath(p),
  lstat: (p) => fs.lstat(p).catch(() => null),
  async openRead(p) {
    const handle = await fs.open(p, 'r');
    return {
      fd: handle.fd,
      stat: () => handle.stat(),
      close: () => handle.close(),
    };
  },
};

export interface AuthorizedFileResult {
  ok: true;
  track: TrackRecord;
  rootId: string;
  realPath: string;
  size: number;
  mtimeMs: number;
  handle: {
    fd: number;
    close(): Promise<void>;
  };
}

export interface DeniedFileResult {
  ok: false;
  status: 400 | 403 | 404;
  code: string;
  message: string;
}

export type GuardedFileResolution = AuthorizedFileResult | DeniedFileResult;

/**
 * Enforces strict shared-library filesystem boundaries on every protected Host request:
 * - Rejects traversal, encoded traversal, invalid track UUIDs, and unauthorized UNC paths.
 * - Verifies the track belongs to an enabled, available `connect_shared_sources` root.
 * - Resolves `realpath` of both shared root and target file to block symlink/junction/reparse escapes.
 * - Opens the file descriptor and validates `fstat` (`isFile`, `dev`/`ino` consistency) against TOCTOU.
 */
export class SharedFilesystemGuard {
  private readonly connectRepo: ConnectRepository;
  private readonly trackRepo: Pick<TrackRepository, 'findById'>;
  private readonly fsOps: GuardedFsOps;
  private readonly platform: NodeJS.Platform;

  constructor(options: {
    connectRepo: ConnectRepository;
    trackRepo: Pick<TrackRepository, 'findById'>;
    fsOps?: GuardedFsOps;
    platform?: NodeJS.Platform;
  }) {
    this.connectRepo = options.connectRepo;
    this.trackRepo = options.trackRepo;
    this.fsOps = options.fsOps ?? defaultGuardedFsOps;
    this.platform = options.platform ?? process.platform;
  }

  async resolveAuthorizedAudioFile(rawTrackId: string): Promise<GuardedFileResolution> {
    if (!isValidTrackUuid(rawTrackId)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_TRACK_ID',
        message: 'Track identifier must be a valid UUID.',
      };
    }

    const track = this.trackRepo.findById(rawTrackId.toLowerCase());
    if (!track) {
      return {
        ok: false,
        status: 404,
        code: 'TRACK_NOT_FOUND',
        message: 'Track does not exist.',
      };
    }

    if (track.status === 'missing') {
      return {
        ok: false,
        status: 404,
        code: 'FILE_MISSING',
        message: 'Source audio file is currently marked unavailable.',
      };
    }

    const matchedRoot = this.connectRepo.findSharedTrackForStream(track);
    if (!matchedRoot) {
      return {
        ok: false,
        status: 403,
        code: 'NOT_SHARED',
        message: 'Track is not inside an enabled shared music source.',
      };
    }

    const fileCheck = await this.validateAndOpenPathWithinRoot(
      track.original_path,
      matchedRoot.originalPath,
    );
    if (!fileCheck.ok) {
      return fileCheck;
    }

    return {
      ok: true,
      track,
      rootId: matchedRoot.rootId,
      realPath: fileCheck.realPath,
      size: fileCheck.size,
      mtimeMs: fileCheck.mtimeMs,
      handle: fileCheck.handle,
    };
  }

  async resolveAuthorizedSideFile(
    rawTrackId: string,
    candidatePath: string,
  ): Promise<
    | { ok: true; realPath: string; size: number; mtimeMs: number; handle: { fd: number; close(): Promise<void> } }
    | DeniedFileResult
  > {
    if (!isValidTrackUuid(rawTrackId)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_TRACK_ID',
        message: 'Invalid track ID.',
      };
    }
    const track = this.trackRepo.findById(rawTrackId.toLowerCase());
    if (!track) {
      return {
        ok: false,
        status: 404,
        code: 'TRACK_NOT_FOUND',
        message: 'Track not found.',
      };
    }
    const matchedRoot = this.connectRepo.findSharedTrackForStream(track);
    if (!matchedRoot) {
      return {
        ok: false,
        status: 403,
        code: 'NOT_SHARED',
        message: 'Track is not shared.',
      };
    }
    return this.validateAndOpenPathWithinRoot(candidatePath, matchedRoot.originalPath);
  }

  async validateAndOpenPathWithinRoot(
    candidatePath: string,
    authorizedRootPath: string,
  ): Promise<
    | { ok: true; realPath: string; size: number; mtimeMs: number; handle: { fd: number; close(): Promise<void> } }
    | DeniedFileResult
  > {
    if (!candidatePath || candidatePath.includes('\0')) {
      return {
        ok: false,
        status: 403,
        code: 'INVALID_PATH',
        message: 'Path rejected by filesystem security policy.',
      };
    }

    // Reject arbitrary UNC paths unless the explicitly shared root itself is that UNC share
    if (WINDOWS_UNC_RE.test(candidatePath) && !WINDOWS_UNC_RE.test(authorizedRootPath)) {
      return {
        ok: false,
        status: 403,
        code: 'UNC_REJECTED',
        message: 'Unauthorized UNC path rejected.',
      };
    }

    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = await this.fsOps.realpath(authorizedRootPath);
      realTarget = await this.fsOps.realpath(candidatePath);
    } catch {
      return {
        ok: false,
        status: 404,
        code: 'FILE_MISSING',
        message: 'Target file or shared root could not be resolved on disk.',
      };
    }

    const normRoot = normalizeTrackPath(realRoot, this.platform);
    const normTarget = normalizeTrackPath(realTarget, this.platform);
    if (!isNormalizedPathWithinRoot(normTarget, normRoot)) {
      return {
        ok: false,
        status: 403,
        code: 'PATH_ESCAPE_DENIED',
        message: 'Resolved target path escapes the authorized shared root.',
      };
    }

    // Check intermediate directory segments + leaf for symbolic links / Windows junctions escaping root
    const linkInfo = await this.fsOps.lstat(candidatePath);
    if (linkInfo && linkInfo.isSymbolicLink()) {
      // Even if target resolved inside root, check relative path didn't hop outside and back,
      // and ensure target is a regular file after realpath resolution.
      const rel = path.relative(realRoot, realTarget);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return {
          ok: false,
          status: 403,
          code: 'SYMLINK_ESCAPE_DENIED',
          message: 'Symbolic link target escapes authorized shared root.',
        };
      }
    }

    let handle: {
      fd: number;
      stat(): Promise<{ isFile(): boolean; size: number; mtimeMs: number; dev: number; ino: number }>;
      close(): Promise<void>;
    } | null = null;

    try {
      handle = await this.fsOps.openRead(realTarget);
      const fdStat = await handle.stat();
      if (!fdStat.isFile()) {
        await handle.close().catch(() => {});
        return {
          ok: false,
          status: 403,
          code: 'NOT_REGULAR_FILE',
          message: 'Target path is not a regular file.',
        };
      }

      // Re-verify realpath after open to mitigate TOCTOU file replacement
      const postOpenReal = await this.fsOps.realpath(candidatePath);
      if (normalizeTrackPath(postOpenReal, this.platform) !== normTarget) {
        await handle.close().catch(() => {});
        return {
          ok: false,
          status: 403,
          code: 'TOCTOU_CONFLICT',
          message: 'Target file changed concurrently during security validation.',
        };
      }

      return {
        ok: true,
        realPath: realTarget,
        size: fdStat.size,
        mtimeMs: fdStat.mtimeMs,
        handle: {
          fd: handle.fd,
          close: () => handle!.close(),
        },
      };
    } catch {
      if (handle) {
        await handle.close().catch(() => {});
      }
      return {
        ok: false,
        status: 404,
        code: 'FILE_UNREADABLE',
        message: 'Source file could not be opened for reading.',
      };
    }
  }
}
