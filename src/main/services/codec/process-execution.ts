import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CodecBinaryInspectionResult,
  CodecId,
  CodecManifestEntry,
  CodecRedistributionStatus,
} from '../../../shared/types/codec-engine';
import {
  DEFAULT_CODEC_MANIFEST,
  FOOBAR_PACK_SUPPORTING_FILES,
} from '../../../shared/utils/codec-registry';

export interface CodecSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  stdio?: StdioOptions;
  windowsHide?: boolean;
}

/**
 * Injectable process spawner contract (`Phase 4.5B`).
 * Production ALWAYS uses `defaultNativeProcessAdapter` (`shell: false`, direct native executable).
 * Automated tests inject their own cross-platform Node/Electron mock runner without relaxing production security.
 */
export interface CodecProcessAdapter {
  readonly kind: 'native' | 'test-harness';
  spawn(
    executablePath: string,
    args: readonly string[],
    options?: CodecSpawnOptions,
  ): ChildProcess;
}

export interface ExecutableInspectionInputOptions {
  hostArch?: string;
  expectDll?: boolean;
  allowPosixScripts?: boolean;
}

export type CodecExecutableInspector = (
  filePath: string,
  platform: NodeJS.Platform,
  options: ExecutableInspectionInputOptions,
) => Promise<CodecBinaryInspectionResult>;

/**
 * Injectable canonical path inspection operations for deterministic symlink/junction/hardlink testing (`Phase 4.5C`).
 * Defaults to real `node:fs/promises` in production.
 */
export interface FsPathSafetyOps {
  realpath(p: string): Promise<string>;
  lstat(p: string): Promise<{ isSymbolicLink(): boolean } | null>;
  stat(p: string): Promise<{ dev: number; ino: number; isFile(): boolean; isDirectory(): boolean } | null>;
}

export const defaultFsPathSafetyOps: FsPathSafetyOps = {
  realpath: (p) => fs.realpath(p),
  lstat: (p) => fs.lstat(p).catch(() => null),
  stat: (p) => fs.stat(p).catch(() => null),
};

/**
 * Validates that an executable path and argument vector contain no unsafe NUL bytes or empty executable names.
 */
export function validateProcessLaunchTarget(
  executablePath: string,
  args: readonly string[],
): void {
  if (typeof executablePath !== 'string' || executablePath.trim().length === 0) {
    throw new Error('Đường dẫn tệp thực thi codec không hợp lệ (rỗng).');
  }
  if (executablePath.includes('\0')) {
    throw new Error('Đường dẫn tệp thực thi codec chứa ký tự NUL không hợp lệ.');
  }
  for (let i = 0; i < args.length; i += 1) {
    if (typeof args[i] !== 'string' || args[i].includes('\0')) {
      throw new Error(`Tham số dòng lệnh thứ ${i} không hợp lệ.`);
    }
  }
}

/**
 * Strict production process adapter (`shell: false`, `windowsHide: true`, direct argv execution).
 */
export const defaultNativeProcessAdapter: CodecProcessAdapter = {
  kind: 'native',
  spawn(executablePath, args, options = {}) {
    validateProcessLaunchTarget(executablePath, args);
    return spawn(executablePath, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: options.detached,
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
      windowsHide: options.windowsHide ?? true,
      shell: false,
    });
  },
};

/**
 * Resolves bundled codecs directory reliably across Development, Unpacked Build,
 * Windows NSIS Installer, and Portable ZIP (`extraResources: resources/codecs -> codecs`).
 * Never hardcodes developer drive letters or source workspace paths.
 */
export function resolveDefaultBundledCodecsDir(params?: {
  platform?: NodeJS.Platform;
  arch?: string;
  resourcesPath?: string | null;
  execPath?: string | null;
  cwd?: string;
  existsSync?: (p: string) => boolean;
}): string {
  const platform = params?.platform ?? process.platform;
  const arch = params?.arch ?? process.arch;
  const exists = params?.existsSync ?? fsSync.existsSync;
  const platformSubdir = `${platform}-${arch}`;
  const legacyWinSubdir = platform === 'win32' && arch === 'x64' ? 'win-x64' : null;
  const resourcesPath =
    params?.resourcesPath !== undefined
      ? params.resourcesPath
      : typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === 'string'
        ? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath!
        : null;
  const cwd = params?.cwd ?? process.cwd();
  const execDir = params?.execPath ? path.dirname(params.execPath) : null;

  const candidateBases: string[] = [];
  if (resourcesPath) {
    // Packaged Electron (`<appRoot>/resources/codecs`)
    candidateBases.push(path.join(resourcesPath, 'codecs'));
  }
  if (execDir) {
    // Portable or sibling `resources/codecs` next to executable
    candidateBases.push(path.join(execDir, 'resources', 'codecs'));
  }
  // Development fallback relative to current working directory
  candidateBases.push(path.resolve(cwd, 'resources', 'codecs'));

  const resolvedCandidates: string[] = [];
  for (const base of candidateBases) {
    resolvedCandidates.push(path.join(base, platformSubdir));
    if (legacyWinSubdir && legacyWinSubdir !== platformSubdir) {
      resolvedCandidates.push(path.join(base, legacyWinSubdir));
    }
    resolvedCandidates.push(base);
  }

  for (const dir of resolvedCandidates) {
    if (exists(dir)) {
      return path.resolve(dir);
    }
  }

  return path.resolve(cwd, 'resources', 'codecs', platformSubdir);
}

/**
 * Resolves `resources/codecs/manifest.json` path across Dev & Packaged Electron builds.
 */
export function resolveBundledManifestFilePath(params?: {
  resourcesPath?: string | null;
  cwd?: string;
  existsSync?: (p: string) => boolean;
}): string {
  const exists = params?.existsSync ?? fsSync.existsSync;
  const resourcesPath =
    params?.resourcesPath !== undefined
      ? params.resourcesPath
      : typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === 'string'
        ? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath!
        : null;
  const cwd = params?.cwd ?? process.cwd();

  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, 'codecs', 'manifest.json')] : []),
    path.resolve(cwd, 'resources', 'codecs', 'manifest.json'),
  ];
  for (const p of candidates) {
    if (exists(p)) return p;
  }
  return candidates[0];
}

/**
 * Fixed, predictable official foobar2000 Free Encoder Pack / FFmpeg directories on Windows.
 * Strictly avoids whole-drive scanning or arbitrary personal directory traversal (`Phase 4.5D §23`).
 */
export function getStandardFoobarEncoderSearchDirs(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform !== 'win32') {
    return [];
  }
  const candidates: string[] = [];
  if (env.ProgramFiles) {
    candidates.push(path.join(env.ProgramFiles, 'foobar2000', 'encoders'));
  }
  if (env['ProgramFiles(x86)']) {
    candidates.push(path.join(env['ProgramFiles(x86)'], 'foobar2000', 'encoders'));
  }
  if (env.APPDATA) {
    candidates.push(path.join(env.APPDATA, 'foobar2000-v2', 'encoders'));
    candidates.push(path.join(env.APPDATA, 'foobar2000', 'encoders'));
  }
  if (env.LOCALAPPDATA) {
    candidates.push(path.join(env.LOCALAPPDATA, 'foobar2000', 'encoders'));
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const dir of candidates) {
    const norm = path.resolve(dir).toLowerCase();
    if (!seen.has(norm)) {
      seen.add(norm);
      unique.push(path.resolve(dir));
    }
  }
  return unique;
}

export type DistributionPolicyCategory =
  | 'BUNDLED_ALLOWED'
  | 'EXTERNAL_USER_PROVIDED'
  | 'REDISTRIBUTION_RESTRICTED'
  | 'LICENSE_UNVERIFIED';

export interface CodecDistributionAuditItem {
  id: CodecId;
  name: string;
  group: CodecManifestEntry['group'];
  includedInFoobarPack: boolean;
  license: string;
  redistributionStatus: CodecRedistributionStatus;
  distributionPolicy: DistributionPolicyCategory;
  licenseFile: string | null;
  requiredDependencies: string[];
}

/**
 * Audits every registry codec's legal distribution classification so restricted components
 * (`qaac` Apple CoreAudio, `fhgaacenc` Winamp Fraunhofer DLLs, `fdkaac`, proprietary `tak`)
 * are NEVER silently treated as bundled redistributables (`Phase 4.5F §32–33`).
 */
export function auditCodecDistributionMatrix(): CodecDistributionAuditItem[] {
  return DEFAULT_CODEC_MANIFEST.map((entry) => {
    let distributionPolicy: DistributionPolicyCategory;
    if (entry.redistributionStatus === 'builtin' || entry.redistributionStatus === 'redistributable') {
      distributionPolicy = 'BUNDLED_ALLOWED';
    } else if (entry.redistributionStatus === 'non-redistributable') {
      distributionPolicy = 'REDISTRIBUTION_RESTRICTED';
    } else if (entry.redistributionStatus === 'user-supplied-only') {
      distributionPolicy = 'EXTERNAL_USER_PROVIDED';
    } else {
      distributionPolicy = 'LICENSE_UNVERIFIED';
    }
    return {
      id: entry.id,
      name: entry.name,
      group: entry.group,
      includedInFoobarPack: entry.includedInFoobarPack,
      license: entry.license,
      redistributionStatus: entry.redistributionStatus,
      distributionPolicy,
      licenseFile: entry.licenseFile ?? null,
      requiredDependencies: entry.requiredDependencies.map((d) => d.name),
    };
  });
}

export interface BundledManifestValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  schemaVersion: number | null;
  manifestVersion: string | null;
  bundledAllowedIds: CodecId[];
  restrictedOrExternalIds: CodecId[];
}

/**
 * Validates `resources/codecs/manifest.json` structure against `DEFAULT_CODEC_MANIFEST`
 * and ensures bundled checksums/license references contain zero fabricated hashes (`Phase 4.5F §31`).
 */
export function validateBundledCodecManifestSchema(
  raw: unknown,
): BundledManifestValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      valid: false,
      errors: ['manifest.json phải là một đối tượng JSON hợp lệ.'],
      warnings: [],
      schemaVersion: null,
      manifestVersion: null,
      bundledAllowedIds: [],
      restrictedOrExternalIds: [],
    };
  }

  const obj = raw as Record<string, unknown>;
  const schemaVersion = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : null;
  const manifestVersion =
    typeof obj.manifestVersion === 'string' && obj.manifestVersion.trim()
      ? obj.manifestVersion.trim()
      : null;

  if (schemaVersion !== 2) {
    errors.push(`schemaVersion không hợp lệ (${String(obj.schemaVersion)}); kỳ vọng 2.`);
  }
  if (!manifestVersion) {
    errors.push('Thiếu trường manifestVersion.');
  }

  const defaultPack = obj.defaultEncoderPack as Record<string, Record<string, unknown>> | undefined;
  const additionalDecoders = obj.additionalDecoders as Record<string, Record<string, unknown>> | undefined;
  const optionalEncoders = obj.optionalEncoders as Record<string, Record<string, unknown>> | undefined;
  const ffmpegSuite = obj.ffmpegSuite as Record<string, Record<string, unknown>> | undefined;
  const builtinDecoders = obj.builtinDecoders as Record<string, Record<string, unknown>> | undefined;

  if (!defaultPack || typeof defaultPack !== 'object') {
    errors.push('Thiếu mục defaultEncoderPack trong manifest.json.');
  }
  if (!ffmpegSuite || typeof ffmpegSuite !== 'object') {
    errors.push('Thiếu mục ffmpegSuite trong manifest.json.');
  }

  const allJsonEntries: Record<string, Record<string, unknown>> = {
    ...(defaultPack ?? {}),
    ...(additionalDecoders ?? {}),
    ...(optionalEncoders ?? {}),
    ...(ffmpegSuite ?? {}),
    ...(builtinDecoders ?? {}),
  };

  const bundledAllowedIds: CodecId[] = [];
  const restrictedOrExternalIds: CodecId[] = [];

  for (const regEntry of DEFAULT_CODEC_MANIFEST) {
    const manifestItem = allJsonEntries[regEntry.id];
    if (!manifestItem) {
      errors.push(`manifest.json thiếu khai báo cho codec "${regEntry.id}".`);
      continue;
    }

    if (regEntry.includedInFoobarPack && !defaultPack?.[regEntry.id]) {
      errors.push(`Codec "${regEntry.id}" thuộc Free Encoder Pack nhưng không nằm trong defaultEncoderPack.`);
    }

    if (manifestItem.expectedSha256 !== null && manifestItem.expectedSha256 !== undefined) {
      if (typeof manifestItem.expectedSha256 === 'object' && !Array.isArray(manifestItem.expectedSha256)) {
        for (const [k, v] of Object.entries(manifestItem.expectedSha256 as Record<string, unknown>)) {
          if (typeof v !== 'string' || !/^[a-f0-9]{64}$/i.test(v)) {
            errors.push(`SHA-256 không hợp lệ cho ${regEntry.id} (${k}).`);
          }
        }
      } else if (
        typeof manifestItem.expectedSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(manifestItem.expectedSha256)
      ) {
        errors.push(`Định dạng expectedSha256 không hợp lệ cho "${regEntry.id}".`);
      }
    }

    if (regEntry.redistributionStatus === 'redistributable' || regEntry.redistributionStatus === 'builtin') {
      bundledAllowedIds.push(regEntry.id);
    } else {
      restrictedOrExternalIds.push(regEntry.id);
    }
  }

  const declaredLicenses = Array.isArray(obj.licenseFiles)
    ? (obj.licenseFiles as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  for (const sup of FOOBAR_PACK_SUPPORTING_FILES) {
    if (sup.kind === 'license-file' && !declaredLicenses.includes(sup.fileName)) {
      warnings.push(`licenseFiles thiếu khai báo tệp bản quyền "${sup.fileName}".`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    schemaVersion,
    manifestVersion,
    bundledAllowedIds,
    restrictedOrExternalIds,
  };
}
