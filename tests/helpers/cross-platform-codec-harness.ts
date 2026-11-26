import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CodecManager,
  type CodecManagerOptions,
  validateExecutableFileHeader,
} from '../../src/main/services/codec/codec-manager';
import {
  type CodecExecutableInspector,
  type CodecProcessAdapter,
  defaultFsPathSafetyOps,
  defaultNativeProcessAdapter,
  type FsPathSafetyOps,
  validateProcessLaunchTarget,
} from '../../src/main/services/codec/process-execution';

export const MOCK_CLI_HEADER = '// @doremi-mock-codec-cli';

export interface VerifiedJsRuntime {
  command: string;
  extraEnv: Record<string, string>;
  runtimeKind: 'electron-node' | 'node';
}

let cachedVerifiedRuntime: VerifiedJsRuntime | null = null;

/**
 * Verifies the JavaScript CLI runtime explicitly (`electron.exe` with `ELECTRON_RUN_AS_NODE=1`
 * or standard `node.exe`) instead of assuming `process.execPath` is always plain Node.js.
 * Kept strictly in `tests/` so production builds carry zero mock runtime assumptions.
 */
export function resolveVerifiedJsRuntimeForTests(): VerifiedJsRuntime {
  if (cachedVerifiedRuntime) {
    return cachedVerifiedRuntime;
  }

  const isElectron = Boolean(process.versions.electron);
  const extraEnv: Record<string, string> = isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
  const probeEnv: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };

  execFileSync(process.execPath, ['-e', 'process.exit(0)'], {
    env: probeEnv,
    stdio: 'ignore',
    windowsHide: true,
    timeout: 5000,
  });

  cachedVerifiedRuntime = {
    command: process.execPath,
    extraEnv,
    runtimeKind: isElectron ? 'electron-node' : 'node',
  };
  return cachedVerifiedRuntime;
}

/**
 * Writes a pure JavaScript cross-platform mock CLI script runnable identically on Windows & Linux.
 * Never emits `#!/bin/sh` or relies on POSIX executable permissions.
 */
export async function writeCrossPlatformMockCli(
  dirOrPath: string,
  fileNameOrJsBody: string,
  maybeJsBody?: string,
): Promise<string> {
  let targetPath: string;
  let jsBody: string;
  if (maybeJsBody !== undefined) {
    const baseName = fileNameOrJsBody.endsWith('.cjs') ? fileNameOrJsBody : `${fileNameOrJsBody}.cjs`;
    targetPath = path.join(dirOrPath, baseName);
    jsBody = maybeJsBody;
  } else {
    targetPath = dirOrPath.endsWith('.cjs') ? dirOrPath : `${dirOrPath}.cjs`;
    jsBody = fileNameOrJsBody;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const content = `${MOCK_CLI_HEADER}\n'use strict';\n${jsBody.trim()}\n`;
  await fs.writeFile(targetPath, content, 'utf8');
  return targetPath;
}

/**
 * Cross-platform test process adapter: spawns verified JS runtime (`node` or `electron --as-node`)
 * for `.cjs` mock files marked with `@doremi-mock-codec-cli` using `shell: false`,
 * and delegates real native executables cleanly to `defaultNativeProcessAdapter`.
 */
export function createCrossPlatformTestProcessAdapter(): CodecProcessAdapter {
  const runtime = resolveVerifiedJsRuntimeForTests();
  return {
    kind: 'test-harness',
    spawn(executablePath, args, options = {}) {
      validateProcessLaunchTarget(executablePath, args);
      if (executablePath.toLowerCase().endsWith('.cjs')) {
        return spawn(runtime.command, [executablePath, ...args], {
          cwd: options.cwd,
          env: { ...(options.env ?? process.env), ...runtime.extraEnv },
          detached: options.detached,
          stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
          windowsHide: options.windowsHide ?? true,
          shell: false,
        });
      }
      return defaultNativeProcessAdapter.spawn(executablePath, args, options);
    },
  };
}

/**
 * Test-only executable inspector permitting `@doremi-mock-codec-cli` `.cjs` mock scripts
 * while preserving real header validation (PE/ELF/Mach-O/DLL) for all non-mock files.
 */
export function createCrossPlatformTestInspector(): CodecExecutableInspector {
  return async (filePath, platform, options) => {
    if (!options.expectDll && filePath.toLowerCase().endsWith('.cjs')) {
      try {
        const stat = await fs.stat(filePath);
        if (stat.isFile() && stat.size >= MOCK_CLI_HEADER.length) {
          const head = (await fs.readFile(filePath, 'utf8')).slice(0, 64);
          if (head.startsWith(MOCK_CLI_HEADER)) {
            const targetPlatform: 'win32' | 'linux' | 'darwin' | 'posix' =
              platform === 'win32' || platform === 'linux' || platform === 'darwin'
                ? platform
                : 'posix';
            return {
              valid: true,
              format: 'script',
              architecture: 'script',
              targetPlatform,
              compatibleWithHost: true,
              executableInCurrentRuntime: true,
              sizeBytes: stat.size,
            };
          }
        }
      } catch {
        // Fall through to strict native validator
      }
    }
    return validateExecutableFileHeader(filePath, platform, options);
  };
}

/**
 * Creates strict cross-platform `CodecManager` options wired with test DI runner & inspector.
 */
export function createMockCodecManager(
  options: Omit<
    CodecManagerOptions,
    'processAdapter' | 'executableInspector' | 'mockCandidateExtensions'
  >,
): CodecManager {
  return new CodecManager({
    ...options,
    processAdapter: createCrossPlatformTestProcessAdapter(),
    executableInspector: createCrossPlatformTestInspector(),
    mockCandidateExtensions: ['.cjs'],
  });
}

export interface OsLinkCapabilityReport {
  fileSymlink: boolean;
  fileSymlinkErrorCode?: string;
  junction: boolean;
  junctionErrorCode?: string;
  hardLink: boolean;
  hardLinkErrorCode?: string;
}

/**
 * Detects real OS kernel permissions for file symlinks, NTFS directory junctions, and hard links
 * without silently assuming `EPERM` means sandbox vs missing privilege (`Phase 4.5C`).
 */
export async function probeOsLinkSupport(): Promise<OsLinkCapabilityReport> {
  const probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-link-probe-'));
  const targetDir = path.join(probeRoot, 'target-dir');
  const targetFile = path.join(targetDir, 'target.txt');
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(targetFile, 'probe', 'utf8');

  let fileSymlink = false;
  let fileSymlinkErrorCode: string | undefined;
  let junction = false;
  let junctionErrorCode: string | undefined;
  let hardLink = false;
  let hardLinkErrorCode: string | undefined;

  try {
    await fs.symlink(targetFile, path.join(probeRoot, 'sym-file.txt'), 'file');
    fileSymlink = true;
  } catch (err) {
    fileSymlinkErrorCode = (err as NodeJS.ErrnoException)?.code ?? 'ERR';
  }

  try {
    await fs.symlink(targetDir, path.join(probeRoot, 'junction-dir'), 'junction');
    junction = true;
  } catch (err) {
    junctionErrorCode = (err as NodeJS.ErrnoException)?.code ?? 'ERR';
  }

  try {
    await fs.link(targetFile, path.join(probeRoot, 'hardlink.txt'));
    hardLink = true;
  } catch (err) {
    hardLinkErrorCode = (err as NodeJS.ErrnoException)?.code ?? 'ERR';
  }

  await fs.rm(probeRoot, { recursive: true, force: true }).catch(() => {});
  return {
    fileSymlink,
    fileSymlinkErrorCode,
    junction,
    junctionErrorCode,
    hardLink,
    hardLinkErrorCode,
  };
}

/**
 * Creates a deterministic simulated `FsPathSafetyOps` layer for pure security logic testing
 * (simulating canonical symlink/junction targets & shared `(dev, ino)` hardlinks cleanly
 * even when kernel `EPERM` blocks OS symlink creation in restricted sandboxes).
 */
export function createSimulatedPathSafetyOps(config: {
  realpathOverrides?: Record<string, string>;
  symlinkPaths?: ReadonlySet<string>;
  sharedInodePaths?: ReadonlySet<string>;
}): FsPathSafetyOps {
  const norm = (p: string): string => path.resolve(p).toLowerCase();
  const realMap = new Map<string, string>();
  for (const [k, v] of Object.entries(config.realpathOverrides ?? {})) {
    realMap.set(norm(k), path.resolve(v));
  }
  const symSet = new Set(Array.from(config.symlinkPaths ?? []).map(norm));
  const inodeSet = new Set(Array.from(config.sharedInodePaths ?? []).map(norm));

  return {
    async realpath(p: string) {
      const override = realMap.get(norm(p));
      if (override) return override;
      return defaultFsPathSafetyOps.realpath(p);
    },
    async lstat(p: string) {
      if (symSet.has(norm(p))) {
        return { isSymbolicLink: () => true };
      }
      return defaultFsPathSafetyOps.lstat(p);
    },
    async stat(p: string) {
      const base = await defaultFsPathSafetyOps.stat(p);
      if (inodeSet.has(norm(p))) {
        return {
          dev: 99001,
          ino: 424242,
          isFile: () => base?.isFile() ?? true,
          isDirectory: () => base?.isDirectory() ?? false,
        };
      }
      return base;
    },
  };
}
