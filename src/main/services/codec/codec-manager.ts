import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import type {
  CodecBinaryArchitecture,
  CodecBinaryInspectionResult,
  CodecDiscoveryPolicy,
  CodecId,
  CodecImportBinaryResult,
  CodecImportPackResult,
  CodecInventorySnapshot,
  CodecManifestEntry,
  CodecPackMetadata,
  CodecRuntimeEntry,
  CodecSourceTier,
  CodecTrustStatus,
  CodecUpdateCheckResult,
  CustomCodecConsentRecord,
} from '../../../shared/types/codec-engine';
import {
  isPathStrictlyWithinDirectory,
  isPrivateOrReservedIp,
  validateSafeUpdateManifestUrl,
} from '../../../shared/utils/codec-command-builder';
import {
  COMPATIBLE_FOOBAR_PACK_DATE,
  DEFAULT_CODEC_MANIFEST,
  DEFAULT_ENCODER_PACK_VERSION,
  getCodecManifestById,
  isRecognizedPackLicenseFile,
  matchFilenameToCodecId,
} from '../../../shared/utils/codec-registry';

const DEFAULT_PROBE_TIMEOUT_MS = 4500;
const DEFAULT_REMOTE_TIMEOUT_MS = 6000;
const MAX_BINARY_BYTES = 250 * 1024 * 1024; // 250 MB upper bound for ffmpeg/codec binaries
const MAX_MANIFEST_BYTES = 64 * 1024; // 64 KB hard upper bound for remote update manifest JSON
const STREAM_HASH_HIGH_WATER_MARK = 64 * 1024; // 64 KB streaming chunk buffer
const MAX_VERIFICATION_CACHE_ENTRIES = 128;

export const SUPPORTING_DLL_ALLOWLIST = new Set([
  'nsutil.dll',
  'libflac.dll',
  'libogg.dll',
  'libopus.dll',
  'libvorbis.dll',
  'libwavpack.dll',
  'wavpackdll.dll',
  'tak_deco_lib.dll',
  'macdll.dll',
  'libmp3lame.dll',
  'avcodec.dll',
  'avformat.dll',
  'avutil.dll',
  'swresample.dll',
]);

const VERSION_PATTERN = /^(?:\d{4}\.\d{2}\.\d{2}|\d+\.\d+\.\d+)(?:-[a-zA-Z0-9.]+)?$/;

interface StoredCustomBinaryRecord {
  fileName: string;
  importedAt: string;
  sha256?: string | null;
  version?: string | null;
  originNote?: string;
  userConfirmed?: boolean;
  consentedAt?: string | null;
}

interface StoredSystemConsentRecord {
  codecId: CodecId;
  sha256: string;
  originNote: string;
  consentedAt: string;
  userConfirmed: boolean;
}

interface StoredPackSnapshot {
  installedPackVersion: string | null;
  installedPackDate: string | null;
  installedPackSource: 'bundled' | 'user-pack' | 'none';
  installedSupportingDlls: string[];
  installedLicenseFiles: string[];
  packCodecChecksums: Partial<Record<CodecId, string>>;
  packCodecVersions: Partial<Record<CodecId, string | null>>;
  preferences: {
    allowSystemPathLookup: boolean;
  };
}

interface StoredCodecState extends StoredPackSnapshot {
  customBinaries: Partial<Record<CodecId, StoredCustomBinaryRecord>>;
  systemConsents: Record<string, StoredSystemConsentRecord>;
}

interface FileVerificationCacheEntry {
  canonicalPath: string;
  size: number;
  mtimeMs: number;
  ino: number;
  ctimeMs: number;
  inspection: CodecBinaryInspectionResult;
  sha256: string;
}

interface SingleCodecCacheEntry {
  entry: CodecRuntimeEntry;
  stateRevision: number;
  fileSignature: string | null;
}

export interface DnsLookupRecord {
  address: string;
  family: 4 | 6;
}

export type DnsResolverFn = (hostname: string) => Promise<DnsLookupRecord[]>;

export interface RemoteManifestHttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  bodyStream?: AsyncIterable<Buffer | string>;
  bodyText?: string;
}

export type RemoteManifestFetcherFn = (params: {
  url: URL;
  pinnedIp: string;
  family: 4 | 6;
  timeoutMs: number;
  maxBytes: number;
}) => Promise<RemoteManifestHttpResponse>;

export interface CodecManagerOptions {
  userDataDir: string;
  bundledResourcesDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Defaults to false (Music Player First & Security Before Execution). */
  allowSystemPathLookup?: boolean;
  /** Default 1 (Power Saving / bounded discovery). Hook for Phase 03B Resource Policy. */
  discoveryPolicy?: Partial<CodecDiscoveryPolicy>;
  /** Optional official SHA-256 reference checksums keyed by CodecId -> lowercase filename or '*'. */
  trustedChecksums?: Partial<Record<CodecId, Record<string, string>>>;
  /** Additional directories to inspect for system runtime DLL dependencies (e.g. tests or Apple Application Support). */
  dependencySearchDirs?: string[];
  /** Explicit test-only switch to permit POSIX `#!` mock scripts on non-Windows hosts. Defaults to false. */
  allowPosixTestScripts?: boolean;
  /** Optional callback to check if a codec binary is currently in active use by a conversion/probe job. */
  isCodecInUse?: (codecId: CodecId) => boolean;
  /** Optional allowlist of HTTPS hostnames trusted for remote update manifest checks. */
  trustedUpdateHosts?: readonly string[];
  /** Allow remote update checks when a manifestUrl is explicitly passed. Defaults to true (hardened). */
  allowRemoteUpdateChecks?: boolean;
  /** Override probe timeout in ms (default 4500). */
  probeTimeoutMs?: number;
  /** Override remote manifest timeout in ms (default 6000). */
  remoteTimeoutMs?: number;
  /** Injectable DNS resolver for deterministic offline testing. */
  dnsResolver?: DnsResolverFn;
  /** Injectable HTTPS fetcher for deterministic offline testing (redirect/size/schema). */
  remoteFetcher?: RemoteManifestFetcherFn;
}

export interface CustomBinaryImportOptions {
  userConfirmed?: boolean;
  originNote?: string;
  expectedSha256?: string;
}

export interface PackImportOptions {
  /** Only set when the pack version is explicitly verified (never fabricated). */
  verifiedPackVersion?: string | null;
  verifiedPackDate?: string | null;
}

export interface ValidatedRemoteManifest {
  schemaVersion: number;
  manifestVersion: string;
  packName?: string;
  notes: string[];
}

export interface ExecutableInspectionOptions {
  hostArch?: string;
  expectDll?: boolean;
  allowPosixScripts?: boolean;
}

function normalizeHostArch(arch: string): CodecBinaryArchitecture {
  const lower = arch.toLowerCase();
  if (lower === 'x64' || lower === 'amd64' || lower === 'x86_64') return 'x64';
  if (lower === 'ia32' || lower === 'x86' || lower === 'i386' || lower === 'i686') return 'x86';
  if (lower === 'arm64' || lower === 'aarch64') return 'arm64';
  return 'unknown';
}

/**
 * Determines whether a binary for `binaryPlatform`/`binaryArch` can execute on `hostPlatform`/`hostArch`.
 * Explicitly allows Windows x86 (WoW64) encoder binaries on Windows x64 hosts, and blocks running
 * Windows PE binaries inside Linux/macOS runtimes.
 */
export function isBinaryCompatibleWithHost(params: {
  binaryPlatform: 'win32' | 'linux' | 'darwin' | 'posix' | 'unknown';
  binaryArch: CodecBinaryArchitecture;
  hostPlatform: NodeJS.Platform;
  hostArch: string;
}): { compatibleWithHost: boolean; executableInCurrentRuntime: boolean; reason?: string } {
  const normHostArch = normalizeHostArch(params.hostArch);

  if (params.binaryPlatform === 'unknown') {
    return {
      compatibleWithHost: false,
      executableInCurrentRuntime: false,
      reason: 'Không xác định được nền tảng của tệp thực thi.',
    };
  }

  if (params.binaryPlatform === 'posix') {
    if (params.hostPlatform === 'win32') {
      return {
        compatibleWithHost: false,
        executableInCurrentRuntime: false,
        reason: 'Script POSIX không thể thực thi trực tiếp trên Windows.',
      };
    }
    return { compatibleWithHost: true, executableInCurrentRuntime: true };
  }

  if (params.binaryPlatform !== params.hostPlatform) {
    return {
      compatibleWithHost: false,
      executableInCurrentRuntime: false,
      reason: `Binary dành cho ${params.binaryPlatform} (${params.binaryArch}) không thể chạy trên ${params.hostPlatform} (${normHostArch}).`,
    };
  }

  if (params.hostPlatform === 'win32') {
    if (normHostArch === 'x64') {
      // Windows x64 supports both native x64 and WoW64 x86 encoders (e.g., foobar2000 pack x86 tools)
      if (params.binaryArch === 'x64' || params.binaryArch === 'x86') {
        return { compatibleWithHost: true, executableInCurrentRuntime: true };
      }
      return {
        compatibleWithHost: false,
        executableInCurrentRuntime: false,
        reason: `Kiến trúc PE ${params.binaryArch} không tương thích với Windows x64.`,
      };
    }
    if (normHostArch === 'x86') {
      if (params.binaryArch === 'x86') {
        return { compatibleWithHost: true, executableInCurrentRuntime: true };
      }
      return {
        compatibleWithHost: false,
        executableInCurrentRuntime: false,
        reason: `Binary ${params.binaryArch} không thể chạy trên Windows 32-bit (x86).`,
      };
    }
    if (normHostArch === 'arm64') {
      if (
        params.binaryArch === 'arm64' ||
        params.binaryArch === 'x64' ||
        params.binaryArch === 'x86'
      ) {
        return { compatibleWithHost: true, executableInCurrentRuntime: true };
      }
      return {
        compatibleWithHost: false,
        executableInCurrentRuntime: false,
        reason: `Kiến trúc PE ${params.binaryArch} không tương thích với Windows ARM64.`,
      };
    }
  }

  if (params.hostPlatform === 'linux') {
    if (params.binaryArch === normHostArch) {
      return { compatibleWithHost: true, executableInCurrentRuntime: true };
    }
    return {
      compatibleWithHost: false,
      executableInCurrentRuntime: false,
      reason: `Binary ELF kiến trúc ${params.binaryArch} không tương thích với Linux ${normHostArch}.`,
    };
  }

  if (params.hostPlatform === 'darwin') {
    if (
      params.binaryArch === 'universal' ||
      params.binaryArch === normHostArch ||
      (normHostArch === 'arm64' && params.binaryArch === 'x64')
    ) {
      return { compatibleWithHost: true, executableInCurrentRuntime: true };
    }
    return {
      compatibleWithHost: false,
      executableInCurrentRuntime: false,
      reason: `Binary Mach-O kiến trúc ${params.binaryArch} không tương thích với macOS ${normHostArch}.`,
    };
  }

  return {
    compatibleWithHost: false,
    executableInCurrentRuntime: false,
    reason: `Không hỗ trợ kiểm tra tương thích cho nền tảng ${params.hostPlatform}.`,
  };
}

/**
 * Inspects an executable or DLL binary thoroughly:
 * - Windows PE: validates DOS MZ header, e_lfanew bounds, PE\0\0 signature, COFF Machine (x86/x64/arm64),
 *   IMAGE_FILE_EXECUTABLE_IMAGE, and IMAGE_FILE_DLL distinction.
 * - Linux ELF: validates ELF magic, class, endianness, e_type (ET_EXEC/ET_DYN), and e_machine.
 * - macOS Mach-O: validates Mach-O / Fat Universal magic and CPU type.
 * - POSIX shebang (`#!`): rejected unless `allowPosixScripts: true` is explicitly passed (tests).
 * Never treats header validity alone as proof of binary trustworthiness.
 */
export async function validateExecutableFileHeader(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
  options: ExecutableInspectionOptions = {},
): Promise<CodecBinaryInspectionResult> {
  const hostArch = options.hostArch ?? process.arch;
  const expectDll = options.expectDll ?? false;
  const allowPosixScripts = options.allowPosixScripts ?? false;

  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return {
        valid: false,
        format: 'unknown',
        architecture: 'unknown',
        targetPlatform: 'unknown',
        compatibleWithHost: false,
        executableInCurrentRuntime: false,
        sizeBytes: 0,
        reason: 'Đường dẫn không phải là tệp tin hợp lệ.',
      };
    }

    if (stat.size < 4 || stat.size > MAX_BINARY_BYTES) {
      return {
        valid: false,
        format: 'unknown',
        architecture: 'unknown',
        targetPlatform: 'unknown',
        compatibleWithHost: false,
        executableInCurrentRuntime: false,
        sizeBytes: stat.size,
        reason: 'Kích thước tệp binary không hợp lệ (rỗng hoặc vượt ngưỡng 250 MB).',
      };
    }

    const header = Buffer.alloc(Math.min(64, stat.size));
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 4) {
      return {
        valid: false,
        format: 'unknown',
        architecture: 'unknown',
        targetPlatform: 'unknown',
        compatibleWithHost: false,
        executableInCurrentRuntime: false,
        sizeBytes: stat.size,
        reason: 'Tệp binary quá ngắn để chứa header hợp lệ.',
      };
    }

    // 1. Windows PE (MZ + e_lfanew + PE\0\0 + COFF Header)
    if (header[0] === 0x4d && header[1] === 0x5a) {
      if (stat.size < 64 || bytesRead < 64) {
        return {
          valid: false,
          format: 'pe',
          architecture: 'unknown',
          targetPlatform: 'win32',
          compatibleWithHost: false,
          executableInCurrentRuntime: false,
          sizeBytes: stat.size,
          reason: 'File chỉ có 2 byte MZ nhưng thiếu DOS header (nhỏ hơn 64 byte).',
        };
      }

      const peOffset = header.readUInt32LE(0x3c);
      if (peOffset < 64 || peOffset + 24 > stat.size) {
        return {
          valid: false,
          format: 'pe',
          architecture: 'unknown',
          targetPlatform: 'win32',
          compatibleWithHost: false,
          executableInCurrentRuntime: false,
          sizeBytes: stat.size,
          reason: `Con trỏ PE Header (e_lfanew=0x${peOffset.toString(16)}) nằm ngoài phạm vi tệp.`,
        };
      }

      const peHead = Buffer.alloc(24);
      const peRead = await handle.read(peHead, 0, 24, peOffset);
      if (peRead.bytesRead < 24) {
        return {
          valid: false,
          format: 'pe',
          architecture: 'unknown',
          targetPlatform: 'win32',
          compatibleWithHost: false,
          executableInCurrentRuntime: false,
          sizeBytes: stat.size,
          reason: 'Không thể đọc đầy đủ cấu trúc PE Header.',
        };
      }

      const hasPeSig =
        peHead[0] === 0x50 && peHead[1] === 0x45 && peHead[2] === 0x00 && peHead[3] === 0x00;
      if (!hasPeSig) {
        return {
          valid: false,
          format: 'pe',
          architecture: 'unknown',
          targetPlatform: 'win32',
          compatibleWithHost: false,
          executableInCurrentRuntime: false,
          sizeBytes: stat.size,
          reason: 'Thiếu chữ ký PE\\0\\0 hợp lệ sau DOS header.',
        };
      }

      const machine = peHead.readUInt16LE(4);
      const characteristics = peHead.readUInt16LE(22);
      const isExecutableImage = (characteristics & 0x0002) !== 0;
      const isPeDll = (characteristics & 0x2000) !== 0;
      const peMachineHex = `0x${machine.toString(16).padStart(4, '0')}`;

      let architecture: CodecBinaryArchitecture = 'unknown';
      if (machine === 0x8664) architecture = 'x64';
      else if (machine === 0x014c) architecture = 'x86';
      else if (machine === 0xaa64) architecture = 'arm64';

      if (architecture === 'unknown') {
        return {
          valid: false,
          format: 'pe',
          architecture: 'unknown',
          targetPlatform: 'win32',
          compatibleWithHost: false,
          executableInCurrentRuntime: false,
          sizeBytes: stat.size,
          peMachineHex,
          isPeDll,
          reason: `Kiến trúc CPU PE không được hỗ trợ (${peMachineHex}).`,
        };
      }

      if (!isExecutableImage) {
        return {
          valid: false,
          format: 'pe',
          architecture,
          targetPlatform: 'win32',
          compatibleWithHost: false,
          executableInCurrentRuntime: false,
          sizeBytes: stat.size,
          peMachineHex,
          isPeDll,
          reason: 'Tệp PE không có cờ IMAGE_FILE_EXECUTABLE_IMAGE.',
        };
      }

      if (expectDll && !isPeDll) {
        return {
          valid: false,
          format: 'pe',
          architecture,
          targetPlatform: 'win32',
          compatibleWithHost: false,
          executableInCurrentRuntime: false,
          sizeBytes: stat.size,
          peMachineHex,
          isPeDll,
          reason: 'Tệp không có cờ IMAGE_FILE_DLL như yêu cầu đối với thư viện DLL.',
        };
      }

      if (!expectDll && isPeDll) {
        return {
          valid: false,
          format: 'pe',
          architecture,
          targetPlatform: 'win32',
          compatibleWithHost: false,
          executableInCurrentRuntime: false,
          sizeBytes: stat.size,
          peMachineHex,
          isPeDll,
          reason: 'Tệp là thư viện DLL, không phải chương trình thực thi độc lập (.exe).',
        };
      }

      const compat = isBinaryCompatibleWithHost({
        binaryPlatform: 'win32',
        binaryArch: architecture,
        hostPlatform: platform,
        hostArch,
      });

      return {
        valid: true,
        format: 'pe',
        architecture,
        targetPlatform: 'win32',
        compatibleWithHost: compat.compatibleWithHost,
        executableInCurrentRuntime: compat.executableInCurrentRuntime && !isPeDll,
        sizeBytes: stat.size,
        peMachineHex,
        isPeDll,
        reason: compat.reason,
      };
    }

    // 2. Linux ELF
    if (
      header[0] === 0x7f &&
      header[1] === 0x45 &&
      header[2] === 0x4c &&
      header[3] === 0x46
    ) {
      if (bytesRead < 20) {
        return {
          valid: false,
          format: 'elf',
          architecture: 'unknown',
          targetPlatform: 'linux',
          compatibleWithHost: false,
          executableInCurrentRuntime: false,
          sizeBytes: stat.size,
          reason: 'ELF header quá ngắn.',
        };
      }
      const elfClass = header[4]; // 1 = 32-bit, 2 = 64-bit
      const endian = header[5]; // 1 = LE, 2 = BE
      if ((elfClass !== 1 && elfClass !== 2) || (endian !== 1 && endian !== 2)) {
        return {
          valid: false,
          format: 'elf',
          architecture: 'unknown',
          targetPlatform: 'linux',
          compatibleWithHost: false,
          executableInCurrentRuntime: false,
          sizeBytes: stat.size,
          reason: 'ELF class hoặc endianness không hợp lệ.',
        };
      }
      const eType = endian === 1 ? header.readUInt16LE(16) : header.readUInt16BE(16);
      const eMachine = endian === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18);
      if (eType !== 2 && eType !== 3) {
        return {
          valid: false,
          format: 'elf',
          architecture: 'unknown',
          targetPlatform: 'linux',
          compatibleWithHost: false,
          executableInCurrentRuntime: false,
          sizeBytes: stat.size,
          reason: 'ELF không phải tệp thực thi (ET_EXEC/ET_DYN).',
        };
      }

      let architecture: CodecBinaryArchitecture = 'unknown';
      if (eMachine === 0x3e) architecture = 'x64';
      else if (eMachine === 0x03) architecture = 'x86';
      else if (eMachine === 0xb7) architecture = 'arm64';

      const compat = isBinaryCompatibleWithHost({
        binaryPlatform: 'linux',
        binaryArch: architecture,
        hostPlatform: platform,
        hostArch,
      });

      return {
        valid: architecture !== 'unknown',
        format: 'elf',
        architecture,
        targetPlatform: 'linux',
        compatibleWithHost: compat.compatibleWithHost,
        executableInCurrentRuntime: compat.executableInCurrentRuntime,
        sizeBytes: stat.size,
        reason: architecture === 'unknown' ? 'Kiến trúc CPU ELF không được hỗ trợ.' : compat.reason,
      };
    }

    // 3. macOS Mach-O / Universal Fat Binary
    const magicBE = header.readUInt32BE(0);
    const isMachO =
      magicBE === 0xcffaedfe ||
      magicBE === 0xfeedfacf ||
      magicBE === 0xcefaedfe ||
      magicBE === 0xfeedface ||
      magicBE === 0xcafebabe;
    if (isMachO) {
      let architecture: CodecBinaryArchitecture = 'unknown';
      if (magicBE === 0xcafebabe) {
        architecture = 'universal';
      } else if (bytesRead >= 8) {
        const isLe = magicBE === 0xcffaedfe || magicBE === 0xcefaedfe;
        const cpuType = isLe ? header.readUInt32LE(4) : header.readUInt32BE(4);
        if (cpuType === 0x01000007) architecture = 'x64';
        else if (cpuType === 0x0100000c) architecture = 'arm64';
        else if (cpuType === 0x00000007) architecture = 'x86';
      }

      const compat = isBinaryCompatibleWithHost({
        binaryPlatform: 'darwin',
        binaryArch: architecture,
        hostPlatform: platform,
        hostArch,
      });

      return {
        valid: architecture !== 'unknown',
        format: 'macho',
        architecture,
        targetPlatform: 'darwin',
        compatibleWithHost: compat.compatibleWithHost,
        executableInCurrentRuntime: compat.executableInCurrentRuntime,
        sizeBytes: stat.size,
        reason: architecture === 'unknown' ? 'Kiến trúc Mach-O không xác định.' : compat.reason,
      };
    }

    // 4. POSIX shebang script — only permitted when explicitly enabled (e.g. unit test harness)
    if (header[0] === 0x23 && header[1] === 0x21) {
      if (platform !== 'win32' && allowPosixScripts && !expectDll) {
        return {
          valid: true,
          format: 'script',
          architecture: 'script',
          targetPlatform: 'posix',
          compatibleWithHost: true,
          executableInCurrentRuntime: true,
          sizeBytes: stat.size,
        };
      }
      return {
        valid: false,
        format: 'script',
        architecture: 'script',
        targetPlatform: 'posix',
        compatibleWithHost: false,
        executableInCurrentRuntime: false,
        sizeBytes: stat.size,
        reason: 'Từ chối tệp script (#!) không phải binary biên dịch native.',
      };
    }

    return {
      valid: false,
      format: 'unknown',
      architecture: 'unknown',
      targetPlatform: 'unknown',
      compatibleWithHost: false,
      executableInCurrentRuntime: false,
      sizeBytes: stat.size,
      reason: 'Tệp không có cấu trúc header thực thi hợp lệ (PE/ELF/Mach-O).',
    };
  } catch (error) {
    return {
      valid: false,
      format: 'unknown',
      architecture: 'unknown',
      targetPlatform: 'unknown',
      compatibleWithHost: false,
      executableInCurrentRuntime: false,
      sizeBytes: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Computes SHA-256 checksum via bounded-memory chunk streaming (never loads full binary into RAM).
 */
export async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath, { highWaterMark: STREAM_HASH_HIGH_WATER_MARK });
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.on('error', (error) => {
      reject(error);
    });
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

/**
 * Strictly validates remote update manifest JSON schema & version format without executing any content.
 */
export function validateRemoteManifestSchema(
  raw: unknown,
): { valid: true; manifest: ValidatedRemoteManifest } | { valid: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, reason: 'Manifest từ xa phải là một đối tượng JSON hợp lệ.' };
  }

  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.includes('__proto__') ||
    keys.includes('constructor') ||
    keys.includes('prototype')
  ) {
    return { valid: false, reason: 'Manifest JSON chứa khóa không an toàn.' };
  }

  const schemaVersion = record.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 2) {
    return { valid: false, reason: 'Trường schemaVersion của manifest không hợp lệ hoặc không được hỗ trợ.' };
  }

  const manifestVersion = record.manifestVersion;
  if (
    typeof manifestVersion !== 'string' ||
    !VERSION_PATTERN.test(manifestVersion.trim())
  ) {
    return {
      valid: false,
      reason: 'Định dạng manifestVersion không hợp lệ (yêu cầu YYYY.MM.DD hoặc SemVer).',
    };
  }

  let packName: string | undefined;
  if (record.packName !== undefined) {
    if (
      typeof record.packName !== 'string' ||
      record.packName.trim().length === 0 ||
      record.packName.length > 120
    ) {
      return { valid: false, reason: 'Trường packName trong manifest không hợp lệ.' };
    }
    packName = record.packName.trim();
  }

  const notes: string[] = [];
  if (record.notes !== undefined) {
    if (!Array.isArray(record.notes) || record.notes.length > 20) {
      return { valid: false, reason: 'Trường notes phải là mảng tối đa 20 dòng văn bản.' };
    }
    for (const item of record.notes) {
      if (typeof item !== 'string' || item.length > 300) {
        return { valid: false, reason: 'Mỗi phần tử trong notes phải là chuỗi tối đa 300 ký tự.' };
      }
      const trimmed = item.trim();
      if (trimmed) {
        notes.push(trimmed);
      }
    }
  }

  return {
    valid: true,
    manifest: {
      schemaVersion,
      manifestVersion: manifestVersion.trim(),
      packName,
      notes,
    },
  };
}

function parseVersionFromOutput(rawOutput: string): string | null {
  const lines = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }
  const firstLine = lines[0];
  return firstLine.length > 96 ? `${firstLine.slice(0, 93)}...` : firstLine;
}

function buildSanitizedProbeEnv(platform: NodeJS.Platform): NodeJS.ProcessEnv {
  if (platform === 'win32') {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec']) {
      if (process.env[key]) {
        env[key] = process.env[key];
      }
    }
    return env;
  }
  return {
    LANG: 'C.UTF-8',
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin',
  };
}

/**
 * Safely probes a verified/trusted executable with `shell: false`, strict timeout,
 * exit-code allowlist, and expected executable identity verification.
 * Passing version probe confirms CLI responsiveness only — NOT full encode/decode functionality.
 */
async function probeBinaryVersion(params: {
  executablePath: string;
  entry: CodecManifestEntry;
  platform: NodeJS.Platform;
  timeoutMs: number;
}): Promise<{ ok: boolean; version: string | null; exitCode: number | null; error?: string }> {
  const { executablePath, entry, platform, timeoutMs } = params;
  if (entry.versionArgs.length === 0) {
    return { ok: true, version: 'Built-in', exitCode: 0 };
  }

  const acceptedExitCodes = new Set(entry.acceptedVersionExitCodes ?? [0]);
  const identityPatterns = (entry.versionIdentityPatterns ?? []).map((p) => p.toLowerCase());

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executablePath, [...entry.versionArgs], {
        shell: false,
        windowsHide: true,
        cwd: path.dirname(executablePath),
        env: buildSanitizedProbeEnv(platform),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        ok: false,
        version: null,
        exitCode: null,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve({
          ok: false,
          version: null,
          exitCode: null,
          error: 'Hết thời gian kiểm tra phiên bản binary (timeout).',
        });
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 4096) {
        stdout += chunk.toString('utf8');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString('utf8');
      }
    });

    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, version: null, exitCode: null, error: error.message });
      }
    });

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        const combined = `${stdout}\n${stderr}`.trim();
        const parsed = parseVersionFromOutput(combined);

        if (code === null || !acceptedExitCodes.has(code)) {
          resolve({
            ok: false,
            version: null,
            exitCode: code,
            error: `Binary trả về mã thoát không hợp lệ (${String(code)}).`,
          });
          return;
        }

        if (!parsed) {
          resolve({
            ok: false,
            version: null,
            exitCode: code,
            error: 'Binary không trả về chuỗi nhận diện phiên bản hợp lệ.',
          });
          return;
        }

        if (identityPatterns.length > 0) {
          const lowerCombined = combined.toLowerCase();
          const matchedIdentity = identityPatterns.some((pat) => lowerCombined.includes(pat));
          if (!matchedIdentity) {
            resolve({
              ok: false,
              version: null,
              exitCode: code,
              error: `Đầu ra phiên bản không khớp nhận diện của ${entry.id} ("${parsed.slice(0, 64)}").`,
            });
            return;
          }
        }

        resolve({ ok: true, version: parsed, exitCode: code });
      }
    });
  });
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function dirExists(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Verifies canonical/real path confinement using `fs.realpath` so symlinks and junctions
 * cannot escape `baseDir`.
 */
export async function isRealPathStrictlyWithinDirectory(
  candidatePath: string,
  baseDir: string,
): Promise<{ safe: boolean; realCandidate?: string; realBase?: string; reason?: string }> {
  try {
    const realBase = await fs.realpath(baseDir);
    const realCandidate = await fs.realpath(candidatePath);
    const sep = path.sep === '\\' ? '\\' : '/';
    if (!isPathStrictlyWithinDirectory(realCandidate, realBase, sep)) {
      return {
        safe: false,
        realCandidate,
        realBase,
        reason: 'Phát hiện đường dẫn vượt khỏi phạm vi thư mục cho phép (symlink/junction traversal).',
      };
    }
    return { safe: true, realCandidate, realBase };
  } catch (error) {
    return {
      safe: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function copyDirectoryContents(sourceDir: string, destDir: string): Promise<string[]> {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  const copied: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(destDir, entry.name);
    await fs.copyFile(src, dst);
    copied.push(entry.name);
  }
  return copied;
}

async function runWithConcurrencyLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const idx = nextIndex;
      nextIndex += 1;
      results[idx] = await worker(items[idx]);
    }
  };

  const workerCount = Math.min(limit, items.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(runWorker());
  }
  await Promise.all(workers);
  return results;
}

function defaultDnsResolver(hostname: string): Promise<DnsLookupRecord[]> {
  return dns.lookup(hostname, { all: true, verbatim: true }).then((records) =>
    records.map((r) => ({
      address: r.address,
      family: (r.family === 6 ? 6 : 4) as 4 | 6,
    })),
  );
}

/**
 * Default pinned-IP HTTPS requester that prevents DNS rebinding at socket connect time,
 * blocks HTTP redirects outright, enforces strict timeouts, and caps streamed body bytes.
 */
function defaultPinnedHttpsFetcher(params: {
  url: URL;
  pinnedIp: string;
  family: 4 | 6;
  timeoutMs: number;
  maxBytes: number;
}): Promise<RemoteManifestHttpResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(totalTimer);
        fn();
      }
    };

    const req = https.request(
      {
        protocol: 'https:',
        hostname: params.url.hostname,
        port: params.url.port ? Number(params.url.port) : 443,
        path: `${params.url.pathname}${params.url.search}`,
        method: 'GET',
        servername: params.url.hostname, // Proper TLS SNI & certificate verification
        rejectUnauthorized: true,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'DoReMi-CodecManager/1.0',
        },
        // Pin DNS resolution strictly to the already-verified public IP address
        lookup: (_hostname, _options, callback) => {
          callback(null, params.pinnedIp, params.family);
        },
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        const headers: Record<string, string | string[] | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          headers[k.toLowerCase()] = v;
        }

        // Reject redirects without reading body
        if (statusCode >= 300 && statusCode < 400) {
          res.resume();
          done(() => resolve({ statusCode, headers }));
          return;
        }

        const contentLengthRaw = headers['content-length'];
        const contentLength =
          typeof contentLengthRaw === 'string' ? Number(contentLengthRaw) : Number.NaN;
        if (Number.isFinite(contentLength) && contentLength > params.maxBytes) {
          res.destroy();
          done(() =>
            reject(
              new Error(`Kích thước manifest từ xa vượt quá giới hạn ${params.maxBytes} bytes.`),
            ),
          );
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;

        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > params.maxBytes) {
            res.destroy();
            done(() =>
              reject(
                new Error(`Phản hồi manifest vượt quá giới hạn ${params.maxBytes} bytes.`),
              ),
            );
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          done(() =>
            resolve({
              statusCode,
              headers,
              bodyText: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        });

        res.on('error', (error) => {
          done(() => reject(error));
        });
      },
    );

    const totalTimer = setTimeout(() => {
      req.destroy(new Error('Hết thời gian đọc manifest từ xa (timeout).'));
    }, params.timeoutMs);

    req.on('error', (error) => {
      done(() => reject(error));
    });

    req.end();
  });
}

export class CodecManager {
  private readonly userDataDir: string;
  private readonly codecsRootDir: string;
  private readonly userPackDir: string;
  private readonly userPackBackupDir: string;
  private readonly userPackBackupStateFile: string;
  private readonly customCodecsDir: string;
  private readonly stateFilePath: string;
  private readonly bundledDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly trustedChecksums: Partial<Record<CodecId, Record<string, string>>>;
  private readonly dependencySearchDirs: string[];
  private readonly allowPosixTestScripts: boolean;
  private readonly externalIsCodecInUse?: (codecId: CodecId) => boolean;
  private readonly trustedUpdateHosts: Set<string>;
  private readonly allowRemoteUpdateChecks: boolean;
  private readonly probeTimeoutMs: number;
  private readonly remoteTimeoutMs: number;
  private readonly dnsResolver: DnsResolverFn;
  private readonly remoteFetcher: RemoteManifestFetcherFn;

  private discoveryPolicy: CodecDiscoveryPolicy;
  private cachedInventory: CodecInventorySnapshot | null = null;
  private inFlightInventory: Promise<CodecInventorySnapshot> | null = null;
  private readonly inFlightSingleResolutions = new Map<CodecId, Promise<CodecRuntimeEntry>>();
  private readonly singleCodecCache = new Map<CodecId, SingleCodecCacheEntry>();
  private readonly fileVerificationCache = new Map<string, FileVerificationCacheEntry>();
  private readonly activeCodecs = new Set<CodecId>();
  private stateRevision = 0;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: CodecManagerOptions) {
    this.userDataDir = path.resolve(options.userDataDir);
    this.codecsRootDir = path.join(this.userDataDir, 'codecs');
    this.userPackDir = path.join(this.codecsRootDir, 'pack');
    this.userPackBackupDir = path.join(this.codecsRootDir, 'pack-backup');
    this.userPackBackupStateFile = path.join(this.codecsRootDir, 'pack-backup-state.json');
    this.customCodecsDir = path.join(this.codecsRootDir, 'custom');
    this.stateFilePath = path.join(this.codecsRootDir, 'codec-state.json');
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.trustedChecksums = options.trustedChecksums ?? {};
    this.dependencySearchDirs = (options.dependencySearchDirs ?? []).map((d) => path.resolve(d));
    this.allowPosixTestScripts = options.allowPosixTestScripts ?? false;
    this.externalIsCodecInUse = options.isCodecInUse;
    this.trustedUpdateHosts = new Set(
      (options.trustedUpdateHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean),
    );
    this.allowRemoteUpdateChecks = options.allowRemoteUpdateChecks ?? true;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.remoteTimeoutMs = options.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
    this.dnsResolver = options.dnsResolver ?? defaultDnsResolver;
    this.remoteFetcher = options.remoteFetcher ?? defaultPinnedHttpsFetcher;

    // Security default: allowSystemPathLookup = false; Power Saving default: maxProbeConcurrency = 1
    this.discoveryPolicy = {
      maxProbeConcurrency: Math.max(
        1,
        Math.min(4, Math.floor(options.discoveryPolicy?.maxProbeConcurrency ?? 1)),
      ),
      allowSystemPathLookup:
        options.allowSystemPathLookup ?? options.discoveryPolicy?.allowSystemPathLookup ?? false,
      deferProbeWhenPlaybackActive: options.discoveryPolicy?.deferProbeWhenPlaybackActive ?? false,
    };

    const platformSubdir = `${this.platform}-${this.arch}`;
    this.bundledDir = options.bundledResourcesDir
      ? path.resolve(options.bundledResourcesDir)
      : path.resolve(process.cwd(), 'resources', 'codecs', platformSubdir);
  }

  getCodecsRootDirectory(): string {
    return this.codecsRootDir;
  }

  getDiscoveryPolicy(): CodecDiscoveryPolicy {
    return { ...this.discoveryPolicy };
  }

  /**
   * Hook for Phase 03B Resource Policy & user settings (e.g. toggling System PATH or concurrency limit).
   */
  setDiscoveryPolicy(partial: Partial<CodecDiscoveryPolicy>): CodecDiscoveryPolicy {
    if (partial.maxProbeConcurrency !== undefined) {
      this.discoveryPolicy.maxProbeConcurrency = Math.max(
        1,
        Math.min(4, Math.floor(partial.maxProbeConcurrency)),
      );
    }
    if (partial.allowSystemPathLookup !== undefined) {
      this.discoveryPolicy.allowSystemPathLookup = Boolean(partial.allowSystemPathLookup);
      this.invalidateCaches();
    }
    if (partial.deferProbeWhenPlaybackActive !== undefined) {
      this.discoveryPolicy.deferProbeWhenPlaybackActive = Boolean(
        partial.deferProbeWhenPlaybackActive,
      );
    }
    return this.getDiscoveryPolicy();
  }

  markCodecInUse(codecId: CodecId): void {
    this.activeCodecs.add(codecId);
  }

  releaseCodecInUse(codecId: CodecId): void {
    this.activeCodecs.delete(codecId);
  }

  private checkCodecInUse(codecId: CodecId): boolean {
    return this.activeCodecs.has(codecId) || Boolean(this.externalIsCodecInUse?.(codecId));
  }

  private checkAnyPackCodecInUse(): CodecId | null {
    for (const entry of DEFAULT_CODEC_MANIFEST) {
      if (entry.id !== 'alac-wasm' && this.checkCodecInUse(entry.id)) {
        return entry.id;
      }
    }
    return null;
  }

  invalidateCaches(codecId?: CodecId): void {
    this.cachedInventory = null;
    this.stateRevision += 1;
    if (codecId) {
      this.singleCodecCache.delete(codecId);
    } else {
      this.singleCodecCache.clear();
    }
  }

  private withMutationLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    return previous.then(async () => {
      try {
        return await task();
      } finally {
        release();
      }
    });
  }

  private async ensureDirectories(): Promise<void> {
    await fs.mkdir(this.codecsRootDir, { recursive: true });
    await fs.mkdir(this.userPackDir, { recursive: true });
    await fs.mkdir(this.customCodecsDir, { recursive: true });
  }

  private createEmptyState(): StoredCodecState {
    return {
      installedPackVersion: null,
      installedPackDate: null,
      installedPackSource: 'none',
      installedSupportingDlls: [],
      installedLicenseFiles: [],
      packCodecChecksums: {},
      packCodecVersions: {},
      preferences: {
        allowSystemPathLookup: this.discoveryPolicy.allowSystemPathLookup,
      },
      customBinaries: {},
      systemConsents: {},
    };
  }

  private async readState(): Promise<StoredCodecState> {
    try {
      const raw = await fs.readFile(this.stateFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredCodecState>;
      const empty = this.createEmptyState();
      return {
        installedPackVersion:
          typeof parsed.installedPackVersion === 'string' ? parsed.installedPackVersion : null,
        installedPackDate:
          typeof parsed.installedPackDate === 'string' ? parsed.installedPackDate : null,
        installedPackSource:
          parsed.installedPackSource === 'bundled' || parsed.installedPackSource === 'user-pack'
            ? parsed.installedPackSource
            : 'none',
        installedSupportingDlls: Array.isArray(parsed.installedSupportingDlls)
          ? parsed.installedSupportingDlls.filter((x): x is string => typeof x === 'string')
          : [],
        installedLicenseFiles: Array.isArray(parsed.installedLicenseFiles)
          ? parsed.installedLicenseFiles.filter((x): x is string => typeof x === 'string')
          : [],
        packCodecChecksums:
          parsed.packCodecChecksums && typeof parsed.packCodecChecksums === 'object'
            ? parsed.packCodecChecksums
            : {},
        packCodecVersions:
          parsed.packCodecVersions && typeof parsed.packCodecVersions === 'object'
            ? parsed.packCodecVersions
            : {},
        preferences: {
          allowSystemPathLookup:
            typeof parsed.preferences?.allowSystemPathLookup === 'boolean'
              ? parsed.preferences.allowSystemPathLookup
              : empty.preferences.allowSystemPathLookup,
        },
        customBinaries:
          parsed.customBinaries && typeof parsed.customBinaries === 'object'
            ? parsed.customBinaries
            : {},
        systemConsents:
          parsed.systemConsents && typeof parsed.systemConsents === 'object'
            ? parsed.systemConsents
            : {},
      };
    } catch {
      return this.createEmptyState();
    }
  }

  private async writeState(state: StoredCodecState): Promise<void> {
    await this.ensureDirectories();
    const tmpPath = `${this.stateFilePath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmpPath, this.stateFilePath);
  }

  private getCandidateNames(entry: CodecManifestEntry): string[] {
    return this.platform === 'win32'
      ? [...entry.winExecutableNames]
      : [...entry.posixExecutableNames, ...entry.winExecutableNames];
  }

  private async findInDirectory(dir: string, names: readonly string[]): Promise<string | null> {
    if (!(await dirExists(dir))) {
      return null;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const lowerMap = new Map<string, string>();
    for (const item of entries) {
      if (item.isFile()) {
        lowerMap.set(item.name.toLowerCase(), path.join(dir, item.name));
      }
    }
    for (const name of names) {
      const match = lowerMap.get(name.toLowerCase());
      if (match) {
        const confined = await isRealPathStrictlyWithinDirectory(match, dir);
        if (confined.safe) {
          return match;
        }
      }
    }
    return null;
  }

  private async findInSystemPath(names: readonly string[]): Promise<string | null> {
    if (!this.discoveryPolicy.allowSystemPathLookup) {
      return null;
    }
    const pathEnv = process.env.PATH ?? '';
    const segments = pathEnv
      .split(path.delimiter)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const segment of segments) {
      for (const name of names) {
        const candidate = path.join(segment, name);
        if (await fileExists(candidate)) {
          return candidate;
        }
      }
    }
    return null;
  }

  private getExpectedSha256(entry: CodecManifestEntry, fileName: string): string | null {
    const lower = fileName.toLowerCase();
    const fromOption = this.trustedChecksums[entry.id];
    if (fromOption) {
      const exact = fromOption[lower] ?? fromOption['*'];
      if (typeof exact === 'string' && /^[a-f0-9]{64}$/i.test(exact.trim())) {
        return exact.trim().toLowerCase();
      }
    }
    if (entry.expectedSha256) {
      const exact = entry.expectedSha256[lower] ?? entry.expectedSha256['*'];
      if (typeof exact === 'string' && /^[a-f0-9]{64}$/i.test(exact.trim())) {
        return exact.trim().toLowerCase();
      }
    }
    return null;
  }

  /**
   * Computes & caches binary header inspection + streaming SHA-256 keyed by canonical path,
   * file size, mtime, ctime, and inode. Cache automatically invalidates whenever the file changes.
   * Note: Cache NEVER replaces trust policy or user consent evaluation.
   */
  private async inspectAndHashBinary(
    filePath: string,
  ): Promise<{ inspection: CodecBinaryInspectionResult; sha256: string | null; fileSignature: string | null }> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      const inspection = await validateExecutableFileHeader(filePath, this.platform, {
        hostArch: this.arch,
        allowPosixScripts: this.allowPosixTestScripts,
      });
      return { inspection, sha256: null, fileSignature: null };
    }

    const canonicalPath = await fs.realpath(filePath).catch(() => path.resolve(filePath));
    const fileSignature = `${canonicalPath}|${stat.size}|${stat.mtimeMs}|${stat.ctimeMs}|${stat.ino}`;

    const cached = this.fileVerificationCache.get(canonicalPath);
    if (
      cached &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.ctimeMs === stat.ctimeMs &&
      cached.ino === stat.ino
    ) {
      return {
        inspection: cached.inspection,
        sha256: cached.sha256,
        fileSignature,
      };
    }

    const inspection = await validateExecutableFileHeader(canonicalPath, this.platform, {
      hostArch: this.arch,
      allowPosixScripts: this.allowPosixTestScripts,
    });
    const sha256 = await computeFileSha256(canonicalPath).catch(() => null);

    if (sha256) {
      if (this.fileVerificationCache.size >= MAX_VERIFICATION_CACHE_ENTRIES) {
        const oldestKey = this.fileVerificationCache.keys().next().value;
        if (oldestKey) {
          this.fileVerificationCache.delete(oldestKey);
        }
      }
      this.fileVerificationCache.set(canonicalPath, {
        canonicalPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        ino: stat.ino,
        inspection,
        sha256,
      });
    }

    return { inspection, sha256, fileSignature };
  }

  /**
   * Verifies required supporting DLLs and runtime dependencies for a candidate executable.
   * Never marks QAAC or Fraunhofer AAC as ready when required DLLs are missing.
   */
  private async checkRequiredDependencies(
    entry: CodecManifestEntry,
    executablePath: string,
  ): Promise<string[]> {
    if (entry.requiredDependencies.length === 0) {
      return [];
    }

    const execDir = path.dirname(executablePath);
    const searchDirs: string[] = [execDir, ...this.dependencySearchDirs];

    if (this.platform === 'win32') {
      const programFiles = process.env.ProgramFiles;
      const programFilesX86 = process.env['ProgramFiles(x86)'];
      const systemRoot = process.env.SystemRoot;
      if (programFiles) {
        searchDirs.push(path.join(programFiles, 'Common Files', 'Apple', 'Apple Application Support'));
      }
      if (programFilesX86) {
        searchDirs.push(
          path.join(programFilesX86, 'Common Files', 'Apple', 'Apple Application Support'),
        );
      }
      if (systemRoot) {
        searchDirs.push(path.join(systemRoot, 'System32'), path.join(systemRoot, 'SysWOW64'));
      }
    }

    const missing: string[] = [];
    for (const dep of entry.requiredDependencies) {
      if (!dep.required) continue;

      const dirsToCheck = dep.kind === 'supporting-dll' ? [execDir, ...this.dependencySearchDirs] : searchDirs;
      let foundValid = false;

      for (const dir of dirsToCheck) {
        const candidate = await this.findInDirectory(dir, [dep.name]);
        if (!candidate) continue;

        if (dep.name.toLowerCase().endsWith('.dll')) {
          const dllCheck = await validateExecutableFileHeader(candidate, this.platform, {
            hostArch: this.arch,
            expectDll: true,
          });
          if (dllCheck.valid && dllCheck.isPeDll) {
            foundValid = true;
            break;
          }
        } else {
          foundValid = true;
          break;
        }
      }

      if (!foundValid) {
        missing.push(dep.name);
      }
    }

    return missing;
  }

  private async collectCandidateTiers(
    entry: CodecManifestEntry,
    state: StoredCodecState,
  ): Promise<Array<{ tier: CodecSourceTier; path: string }>> {
    const candidates: Array<{ tier: CodecSourceTier; path: string }> = [];
    const candidateNames = this.getCandidateNames(entry);

    // Tier 1: Custom Codec (only if user configured or placed in custom/<codecId>/)
    const customDir = path.join(this.customCodecsDir, entry.id);
    const customRecord = state.customBinaries[entry.id];
    let customPath: string | null = null;
    if (customRecord?.fileName) {
      const customCandidate = path.resolve(customDir, path.basename(customRecord.fileName));
      if (
        (await fileExists(customCandidate)) &&
        (await isRealPathStrictlyWithinDirectory(customCandidate, customDir)).safe
      ) {
        customPath = customCandidate;
      }
    }
    if (!customPath) {
      customPath = await this.findInDirectory(customDir, candidateNames);
    }
    if (customPath) {
      candidates.push({ tier: 'custom', path: customPath });
    }

    // Tier 2: User-imported Encoder Pack (<userData>/codecs/pack/)
    const fromUserPack = await this.findInDirectory(this.userPackDir, candidateNames);
    if (fromUserPack) {
      candidates.push({ tier: 'user-pack', path: fromUserPack });
    }

    // Tier 3: Bundled App Resources (<resourcesPath>/codecs/<platform>-<arch>/)
    const fromBundled = await this.findInDirectory(this.bundledDir, candidateNames);
    if (fromBundled) {
      candidates.push({ tier: 'bundled', path: fromBundled });
    }

    // Tier 4: System PATH (disabled by default; strictly opt-in)
    if (this.discoveryPolicy.allowSystemPathLookup) {
      const fromSystem = await this.findInSystemPath(candidateNames);
      if (fromSystem) {
        candidates.push({ tier: 'system', path: fromSystem });
      }
    }

    return candidates;
  }

  private buildBaseRuntimeEntry(entry: CodecManifestEntry, nowIso: string): CodecRuntimeEntry {
    return {
      id: entry.id,
      name: entry.name,
      displayFormat: entry.displayFormat,
      category: entry.category,
      group: entry.group,
      capabilities: [...entry.capabilities],
      extensions: [...entry.extensions],
      license: entry.license,
      licenseFile: entry.licenseFile ?? null,
      redistributionStatus: entry.redistributionStatus,
      includedInFoobarPack: entry.includedInFoobarPack,
      optional: entry.optional,
      description: entry.description,
      status: 'missing',
      trustStatus: 'missing',
      sourceTier: 'missing',
      executablePath: null,
      version: null,
      sha256: null,
      fileSizeBytes: null,
      binaryFormat: null,
      architecture: null,
      checksumVerified: false,
      userConsentGranted: false,
      missingDependencies: [],
      lastCheckedAt: nowIso,
    };
  }

  /**
   * Evaluates a single candidate binary through the strict security pipeline:
   * 1. Executable header & architecture inspection (PE/ELF/Mach-O).
   * 2. Streaming SHA-256 checksum computation & official checksum verification (if defined).
   * 3. Required dependency verification (DLLs & runtimes).
   * 4. Binary Trust Policy & explicit user consent check (NEVER executes untrusted/unverified binaries).
   * 5. Platform runtime compatibility check (NEVER executes Windows PE on Linux/macOS).
   * 6. Version & executable identity health probe (`shell: false`).
   */
  private async evaluateCandidateBinary(
    entry: CodecManifestEntry,
    candidatePath: string,
    sourceTier: CodecSourceTier,
    state: StoredCodecState,
    nowIso: string,
  ): Promise<{ runtime: CodecRuntimeEntry; usable: boolean; fileSignature: string | null }> {
    const base = this.buildBaseRuntimeEntry(entry, nowIso);
    base.sourceTier = sourceTier;
    base.executablePath = candidatePath;

    const { inspection, sha256, fileSignature } = await this.inspectAndHashBinary(candidatePath);
    base.fileSizeBytes = inspection.sizeBytes;
    base.binaryFormat = inspection.format;
    base.architecture = inspection.architecture;
    base.sha256 = sha256;

    // 1. Header validity
    if (!inspection.valid) {
      base.status = 'invalid';
      base.trustStatus = 'invalid';
      base.errorMessage = inspection.reason ?? 'Header binary không hợp lệ.';
      return { runtime: base, usable: false, fileSignature };
    }

    // 2. Official checksum verification (if reference checksum is configured)
    const fileName = path.basename(candidatePath);
    const expectedSha256 = this.getExpectedSha256(entry, fileName);
    if (expectedSha256) {
      if (!sha256 || sha256.toLowerCase() !== expectedSha256) {
        base.status = 'invalid';
        base.trustStatus = 'invalid';
        base.checksumVerified = false;
        base.errorMessage = 'Checksum SHA-256 không khớp với nguồn tham chiếu đáng tin cậy.';
        return { runtime: base, usable: false, fileSignature };
      }
      base.checksumVerified = true;
    }

    // 3. Required dependency verification
    const missingDeps = await this.checkRequiredDependencies(entry, candidatePath);
    base.missingDependencies = missingDeps;
    if (missingDeps.length > 0) {
      base.status = 'missing-dependency';
      base.trustStatus = 'missing-dependency';
      base.errorMessage = `Thiếu thành phần phụ thuộc bắt buộc: ${missingDeps.join(', ')}.`;
      return { runtime: base, usable: false, fileSignature };
    }

    // 4. Trust policy & explicit user consent check
    let trustStatus: CodecTrustStatus = 'unverified';
    let userConsentGranted = false;

    if (sourceTier === 'bundled' || sourceTier === 'user-pack') {
      trustStatus = base.checksumVerified ? 'verified' : 'trusted';
    } else if (sourceTier === 'custom') {
      const record = state.customBinaries[entry.id];
      const consentMatchesHash =
        Boolean(record?.userConfirmed) &&
        Boolean(record?.sha256) &&
        Boolean(sha256) &&
        record!.sha256!.toLowerCase() === sha256!.toLowerCase();
      userConsentGranted = consentMatchesHash;

      if (base.checksumVerified) {
        trustStatus = 'verified';
      } else if (consentMatchesHash) {
        trustStatus = 'trusted';
      } else {
        trustStatus = 'unverified';
      }
    } else if (sourceTier === 'system') {
      const canonical = await fs.realpath(candidatePath).catch(() => path.resolve(candidatePath));
      const sysConsent = state.systemConsents[canonical];
      const consentMatchesHash =
        Boolean(sysConsent?.userConfirmed) &&
        sysConsent?.codecId === entry.id &&
        Boolean(sha256) &&
        sysConsent.sha256.toLowerCase() === sha256!.toLowerCase();
      userConsentGranted = consentMatchesHash;

      if (base.checksumVerified) {
        trustStatus = 'verified';
      } else if (consentMatchesHash) {
        trustStatus = 'trusted';
      } else {
        trustStatus = 'unverified';
      }
    }

    base.trustStatus = trustStatus;
    base.userConsentGranted = userConsentGranted;

    if (trustStatus === 'unverified') {
      base.status = 'unverified';
      base.errorMessage =
        'Binary chưa có checksum tham chiếu và chưa được người dùng xác nhận nguồn gốc. Từ chối thực thi tự động.';
      return { runtime: base, usable: false, fileSignature };
    }

    // 5. Host compatibility & cross-platform protection (NEVER run Windows PE on Linux/macOS)
    if (!inspection.compatibleWithHost || !inspection.executableInCurrentRuntime) {
      if (inspection.format === 'pe' && this.platform !== 'win32') {
        base.status = 'pending-desktop-verification';
        base.trustStatus = 'pending-desktop-verification';
        base.errorMessage =
          'Binary Windows PE hợp lệ — chờ xác minh thực thi trên Windows Desktop (không thực thi trong môi trường Linux/Web Preview).';
        return { runtime: base, usable: false, fileSignature };
      }
      base.status = 'incompatible';
      base.trustStatus = 'incompatible';
      base.errorMessage =
        inspection.reason ?? 'Binary không tương thích với hệ điều hành hoặc kiến trúc CPU hiện tại.';
      return { runtime: base, usable: false, fileSignature };
    }

    // 6. Health & identity probe (ONLY reached after full security, trust, and dependency checks pass)
    const probe = await probeBinaryVersion({
      executablePath: candidatePath,
      entry,
      platform: this.platform,
      timeoutMs: this.probeTimeoutMs,
    });

    if (!probe.ok) {
      base.status = 'invalid';
      base.trustStatus = 'invalid';
      base.version = null;
      base.errorMessage = probe.error ?? 'Kiểm tra phiên bản binary thất bại.';
      return { runtime: base, usable: false, fileSignature };
    }

    base.status = 'ready';
    base.version = probe.version;
    return { runtime: base, usable: true, fileSignature };
  }

  private async resolveSingleCodecInternal(
    entry: CodecManifestEntry,
    state: StoredCodecState,
  ): Promise<{ runtime: CodecRuntimeEntry; fileSignature: string | null }> {
    const nowIso = new Date().toISOString();

    if (entry.id === 'alac-wasm') {
      const base = this.buildBaseRuntimeEntry(entry, nowIso);
      base.status = 'ready';
      base.trustStatus = 'verified';
      base.sourceTier = 'builtin';
      base.executablePath = 'builtin://@mgz-dev/alac';
      base.version = 'Built-in @mgz-dev/alac (WASM)';
      base.binaryFormat = null;
      base.architecture = 'universal';
      base.checksumVerified = true;
      return { runtime: base, fileSignature: 'builtin://alac-wasm' };
    }

    const candidates = await this.collectCandidateTiers(entry, state);
    if (candidates.length === 0) {
      return { runtime: this.buildBaseRuntimeEntry(entry, nowIso), fileSignature: null };
    }

    const fallbackWarnings: string[] = [];
    let firstFailure: { runtime: CodecRuntimeEntry; fileSignature: string | null } | null = null;

    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const evaluated = await this.evaluateCandidateBinary(
        entry,
        candidate.path,
        candidate.tier,
        state,
        nowIso,
      );

      if (evaluated.usable) {
        if (i > 0 && fallbackWarnings.length > 0) {
          evaluated.runtime.fallbackUsed = true;
          evaluated.runtime.fallbackWarnings = [...fallbackWarnings];
        }
        return evaluated;
      }

      if (!firstFailure) {
        firstFailure = evaluated;
      }
      fallbackWarnings.push(
        `[${candidate.tier}] ${path.basename(candidate.path)}: ${evaluated.runtime.errorMessage ?? evaluated.runtime.status}`,
      );
    }

    // All candidates failed or are pending desktop verification; return highest-priority diagnostic
    if (firstFailure) {
      if (fallbackWarnings.length > 1) {
        firstFailure.runtime.fallbackWarnings = fallbackWarnings;
      }
      return firstFailure;
    }

    return { runtime: this.buildBaseRuntimeEntry(entry, nowIso), fileSignature: null };
  }

  private async computeQuickFileSignature(filePath: string | null): Promise<string | null> {
    if (!filePath || filePath.startsWith('builtin://')) {
      return filePath ? 'builtin://alac-wasm' : null;
    }
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) return null;
    const canonical = await fs.realpath(filePath).catch(() => path.resolve(filePath));
    return `${canonical}|${stat.size}|${stat.mtimeMs}|${stat.ctimeMs}|${stat.ino}`;
  }

  /**
   * Lazy, on-demand single-codec resolution with stat-based cache invalidation and in-flight deduplication.
   * Does NOT scan the entire inventory.
   */
  async resolveCodec(codecId: CodecId, forceRescan = false): Promise<CodecRuntimeEntry> {
    const entry = getCodecManifestById(codecId);
    if (!entry) {
      throw new Error(`Không tìm thấy codec "${codecId}" trong Codec Registry.`);
    }

    if (!forceRescan) {
      const cached = this.singleCodecCache.get(codecId);
      if (cached && cached.stateRevision === this.stateRevision) {
        const currentSig = await this.computeQuickFileSignature(cached.entry.executablePath);
        if (currentSig === cached.fileSignature) {
          return cached.entry;
        }
        // Underlying binary changed or disappeared -> invalidate stale entry
        this.singleCodecCache.delete(codecId);
        this.cachedInventory = null;
      }
    }

    const inFlight = this.inFlightSingleResolutions.get(codecId);
    if (inFlight && !forceRescan) {
      return inFlight;
    }

    const promise = (async () => {
      await this.ensureDirectories();
      const state = await this.readState();
      const { runtime, fileSignature } = await this.resolveSingleCodecInternal(entry, state);
      this.singleCodecCache.set(codecId, {
        entry: runtime,
        stateRevision: this.stateRevision,
        fileSignature,
      });
      return runtime;
    })();

    this.inFlightSingleResolutions.set(codecId, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlightSingleResolutions.get(codecId) === promise) {
        this.inFlightSingleResolutions.delete(codecId);
      }
    }
  }

  /**
   * Resolves the first compatible & ready provider from an ordered candidate list
   * (e.g. ['refalac', 'qaac', 'ffmpeg']) lazily without scanning unrelated codecs.
   */
  async resolveCompatibleProvider(
    codecIds: readonly CodecId[],
  ): Promise<CodecRuntimeEntry | null> {
    for (const codecId of codecIds) {
      const entry = await this.resolveCodec(codecId, false);
      if (entry.status === 'ready') {
        return entry;
      }
    }
    return null;
  }

  /**
   * Resolves the executable path for ONE codec lazily without triggering full inventory scan.
   */
  async resolveExecutablePath(codecId: CodecId): Promise<string | null> {
    const entry = await this.resolveCodec(codecId, false);
    if (entry.status !== 'ready' || !entry.executablePath || entry.sourceTier === 'builtin') {
      return null;
    }
    return entry.executablePath;
  }

  /**
   * Full inventory discovery with bounded concurrency (default 1) and in-flight deduplication.
   * Never invoked automatically at startup.
   */
  async getInventory(forceRescan = false): Promise<CodecInventorySnapshot> {
    if (this.cachedInventory && !forceRescan) {
      return this.cachedInventory;
    }

    if (this.inFlightInventory && !forceRescan) {
      return this.inFlightInventory;
    }

    const promise = (async (): Promise<CodecInventorySnapshot> => {
      await this.ensureDirectories();
      const state = await this.readState();

      const codecs = await runWithConcurrencyLimit(
        DEFAULT_CODEC_MANIFEST,
        this.discoveryPolicy.maxProbeConcurrency,
        async (manifestEntry) => {
          const { runtime, fileSignature } = await this.resolveSingleCodecInternal(
            manifestEntry,
            state,
          );
          this.singleCodecCache.set(manifestEntry.id, {
            entry: runtime,
            stateRevision: this.stateRevision,
            fileSignature,
          });
          return runtime;
        },
      );

      const readyCodecs = codecs.filter((c) => c.status === 'ready');
      const hasBundledPack = codecs.some(
        (c) =>
          c.sourceTier === 'bundled' &&
          (c.status === 'ready' || c.status === 'pending-desktop-verification'),
      );
      const hasUserPack = codecs.some(
        (c) =>
          c.sourceTier === 'user-pack' &&
          (c.status === 'ready' || c.status === 'pending-desktop-verification'),
      );
      const hasRollbackSnapshot =
        (await dirExists(this.userPackBackupDir)) &&
        (await fs.readdir(this.userPackBackupDir).catch(() => [])).length > 0;

      const pack: CodecPackMetadata = {
        packName: 'DoReMi Default Encoder Pack',
        manifestVersion: DEFAULT_ENCODER_PACK_VERSION,
        compatiblePackDate: COMPATIBLE_FOOBAR_PACK_DATE,
        installedPackVersion: state.installedPackVersion,
        installedPackDate: state.installedPackDate,
        installedPackSource: hasUserPack
          ? 'user-pack'
          : hasBundledPack
            ? 'bundled'
            : state.installedPackSource,
        installedLicenseFiles: [...state.installedLicenseFiles],
        installedSupportingDlls: [...state.installedSupportingDlls],
        hasRollbackSnapshot,
        codecsDirectory: this.codecsRootDir,
      };

      const snapshot: CodecInventorySnapshot = {
        platform: this.platform,
        arch: this.arch,
        generatedAt: new Date().toISOString(),
        pack,
        codecs,
        summary: {
          total: codecs.length,
          ready: readyCodecs.length,
          pendingDesktopVerification: codecs.filter(
            (c) => c.status === 'pending-desktop-verification',
          ).length,
          unverified: codecs.filter((c) => c.status === 'unverified').length,
          missingDependency: codecs.filter((c) => c.status === 'missing-dependency').length,
          encodersReady: readyCodecs.filter((c) => c.capabilities.includes('encode')).length,
          decodersReady: readyCodecs.filter((c) => c.capabilities.includes('decode')).length,
          ffmpegReady: readyCodecs.some((c) => c.id === 'ffmpeg'),
          ffprobeReady: readyCodecs.some((c) => c.id === 'ffprobe'),
        },
      };

      this.cachedInventory = snapshot;
      return snapshot;
    })();

    this.inFlightInventory = promise;
    try {
      return await promise;
    } finally {
      if (this.inFlightInventory === promise) {
        this.inFlightInventory = null;
      }
    }
  }

  async getReadyCodecMap(): Promise<Map<CodecId, CodecRuntimeEntry>> {
    const inventory = await this.getInventory(false);
    const map = new Map<CodecId, CodecRuntimeEntry>();
    for (const codec of inventory.codecs) {
      if (codec.status === 'ready') {
        map.set(codec.id, codec);
      }
    }
    return map;
  }

  async getReadyCodecSet(): Promise<Set<CodecId>> {
    const map = await this.getReadyCodecMap();
    return new Set(map.keys());
  }

  /**
   * Backend API for explicit user consent on an unverified Custom Codec binary.
   * Consent is bound strictly to the current file's SHA-256 hash; if the file changes, consent expires.
   */
  async grantCustomCodecConsent(
    codecId: CodecId,
    params: { originNote: string; userConfirmed: boolean },
  ): Promise<CustomCodecConsentRecord | null> {
    return this.withMutationLock(async () => {
      await this.ensureDirectories();
      const entry = getCodecManifestById(codecId);
      if (!entry || codecId === 'alac-wasm') {
        throw new Error('Codec ID không hỗ trợ xác nhận Custom Codec.');
      }
      if (!params.userConfirmed) {
        throw new Error('Yêu cầu xác nhận đồng ý rõ ràng từ người dùng (userConfirmed = true).');
      }

      const state = await this.readState();
      const customDir = path.join(this.customCodecsDir, codecId);
      const customRecord = state.customBinaries[codecId];
      let targetPath: string | null = null;
      if (customRecord?.fileName) {
        const candidate = path.resolve(customDir, path.basename(customRecord.fileName));
        if (
          (await fileExists(candidate)) &&
          (await isRealPathStrictlyWithinDirectory(candidate, customDir)).safe
        ) {
          targetPath = candidate;
        }
      }
      if (!targetPath) {
        targetPath = await this.findInDirectory(customDir, this.getCandidateNames(entry));
      }
      if (!targetPath) {
        return null;
      }

      const { inspection, sha256 } = await this.inspectAndHashBinary(targetPath);
      if (!inspection.valid || !sha256) {
        throw new Error(inspection.reason ?? 'Binary không hợp lệ, không thể cấp quyền tin cậy.');
      }

      const consentedAt = new Date().toISOString();
      const originNote = params.originNote.trim() || 'Người dùng tự cung cấp';
      state.customBinaries[codecId] = {
        fileName: path.basename(targetPath),
        importedAt: customRecord?.importedAt ?? consentedAt,
        sha256,
        originNote,
        userConfirmed: true,
        consentedAt,
      };
      await this.writeState(state);
      this.invalidateCaches(codecId);

      return {
        codecId,
        fileName: path.basename(targetPath),
        sha256,
        originNote,
        consentedAt,
        userConfirmed: true,
      };
    });
  }

  async revokeCustomCodecConsent(codecId: CodecId): Promise<void> {
    await this.withMutationLock(async () => {
      await this.ensureDirectories();
      const state = await this.readState();
      const existing = state.customBinaries[codecId];
      if (existing) {
        existing.userConfirmed = false;
        existing.consentedAt = null;
        await this.writeState(state);
        this.invalidateCaches(codecId);
      }
    });
  }

  async grantSystemCodecConsent(
    executablePath: string,
    params: { codecId: CodecId; originNote: string; userConfirmed: boolean },
  ): Promise<void> {
    await this.withMutationLock(async () => {
      if (!params.userConfirmed) {
        throw new Error('Yêu cầu xác nhận đồng ý rõ ràng từ người dùng.');
      }
      const canonical = await fs.realpath(executablePath);
      const { inspection, sha256 } = await this.inspectAndHashBinary(canonical);
      if (!inspection.valid || !sha256) {
        throw new Error(inspection.reason ?? 'System binary không hợp lệ.');
      }
      const state = await this.readState();
      state.systemConsents[canonical] = {
        codecId: params.codecId,
        sha256,
        originNote: params.originNote.trim() || 'System PATH verified by user',
        consentedAt: new Date().toISOString(),
        userConfirmed: true,
      };
      await this.writeState(state);
      this.invalidateCaches(params.codecId);
    });
  }

  /**
   * Safe atomic Encoder Pack import using staging directory, canonical path/symlink checks,
   * binary header + checksum verification, license preservation, backup snapshot + state persistence,
   * and failure recovery. Serialized via mutation lock.
   */
  async importEncoderPackFromFolder(
    sourceFolder: string,
    options: PackImportOptions = {},
  ): Promise<CodecImportPackResult> {
    return this.withMutationLock(async () => {
      await this.ensureDirectories();

      const activeCodec = this.checkAnyPackCodecInUse();
      if (activeCodec) {
        const inventory = await this.getInventory(false);
        return {
          canceled: false,
          importedCount: 0,
          skippedCount: 0,
          importedCodecs: [],
          errors: [
            `Không thể thay thế Encoder Pack khi codec "${activeCodec}" đang được sử dụng.`,
          ],
          inventory,
        };
      }

      const resolvedSource = path.resolve(sourceFolder);
      const stat = await fs.stat(resolvedSource).catch(() => null);
      if (!stat || !stat.isDirectory()) {
        const inventory = await this.getInventory(false);
        return {
          canceled: false,
          importedCount: 0,
          skippedCount: 0,
          importedCodecs: [],
          errors: ['Thư mục Encoder Pack không tồn tại hoặc không thể đọc.'],
          inventory,
        };
      }

      const realSourceDir = await fs.realpath(resolvedSource);

      // Scan candidate files (depth <= 2), rejecting symlinks escaping realSourceDir
      const discoveredFiles: Array<{ fullPath: string; fileName: string }> = [];
      const errors: string[] = [];

      const scanDir = async (dir: string, depth: number): Promise<void> => {
        if (depth > 2) return;
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          const confined = await isRealPathStrictlyWithinDirectory(full, realSourceDir);
          if (!confined.safe) {
            errors.push(`Bỏ qua đường dẫn vượt phạm vi thư mục nguồn: ${entry.name}`);
            continue;
          }
          const lstat = await fs.stat(full).catch(() => null);
          if (!lstat) continue;
          if (lstat.isFile()) {
            discoveredFiles.push({ fullPath: full, fileName: entry.name });
          } else if (lstat.isDirectory()) {
            await scanDir(full, depth + 1);
          }
        }
      };
      await scanDir(realSourceDir, 0);

      const matchedBinaries: Array<{ codecId: CodecId; fullPath: string; fileName: string }> = [];
      const matchedDlls: Array<{ fullPath: string; fileName: string }> = [];
      const matchedLicenses: Array<{ fullPath: string; fileName: string }> = [];
      const seenCodecIds = new Set<CodecId>();
      const seenDllNames = new Set<string>();
      const seenLicenseNames = new Set<string>();
      let skippedCount = 0;

      for (const item of discoveredFiles) {
        const lower = item.fileName.toLowerCase();

        if (isRecognizedPackLicenseFile(item.fileName)) {
          if (!seenLicenseNames.has(lower)) {
            seenLicenseNames.add(lower);
            matchedLicenses.push(item);
          }
          continue;
        }

        if (lower.endsWith('.dll') && SUPPORTING_DLL_ALLOWLIST.has(lower)) {
          if (!seenDllNames.has(lower)) {
            const dllCheck = await validateExecutableFileHeader(item.fullPath, this.platform, {
              hostArch: this.arch,
              expectDll: true,
            });
            if (!dllCheck.valid) {
              errors.push(`${item.fileName}: ${dllCheck.reason ?? 'File DLL không hợp lệ.'}`);
              continue;
            }
            seenDllNames.add(lower);
            matchedDlls.push(item);
          }
          continue;
        }

        const codecId = matchFilenameToCodecId(item.fileName);
        if (!codecId) {
          skippedCount += 1;
          continue;
        }
        if (seenCodecIds.has(codecId)) {
          continue;
        }

        const manifestEntry = getCodecManifestById(codecId);
        if (!manifestEntry) {
          skippedCount += 1;
          continue;
        }

        const { inspection, sha256 } = await this.inspectAndHashBinary(item.fullPath);
        if (!inspection.valid) {
          errors.push(`${item.fileName}: ${inspection.reason ?? 'File binary không hợp lệ.'}`);
          continue;
        }
        if (inspection.targetPlatform === this.platform && !inspection.compatibleWithHost) {
          errors.push(
            `${item.fileName}: ${inspection.reason ?? 'Kiến trúc CPU không tương thích với hệ điều hành hiện tại.'}`,
          );
          continue;
        }

        const expectedSha = this.getExpectedSha256(manifestEntry, item.fileName);
        if (expectedSha && (!sha256 || sha256.toLowerCase() !== expectedSha)) {
          errors.push(`${item.fileName}: Checksum SHA-256 không khớp với nguồn tham chiếu.`);
          continue;
        }

        seenCodecIds.add(codecId);
        matchedBinaries.push({ codecId, fullPath: item.fullPath, fileName: item.fileName });
      }

      if (matchedBinaries.length === 0) {
        const inventory = await this.getInventory(false);
        return {
          canceled: false,
          importedCount: 0,
          skippedCount,
          importedCodecs: [],
          importedSupportingDlls: [],
          importedLicenseFiles: [],
          errors: [
            ...errors,
            'Không tìm thấy binary codec hợp lệ nào (flac.exe, lame.exe, opusenc.exe, oggenc2.exe, wavpack.exe, refalac64.exe, qaac64.exe, fhgaacenc.exe, mpcenc.exe, ffmpeg.exe, ffprobe.exe...) trong thư mục đã chọn.',
          ],
          inventory,
        };
      }

      // Stage all verified files into isolated staging directory first
      const stagingDir = path.join(this.codecsRootDir, `.staging-pack-${crypto.randomUUID().slice(0, 8)}`);
      const previousPackTempDir = path.join(
        this.codecsRootDir,
        `.prev-pack-${crypto.randomUUID().slice(0, 8)}`,
      );
      const previousState = await this.readState();
      const packCodecChecksums: Partial<Record<CodecId, string>> = {};
      const packCodecVersions: Partial<Record<CodecId, string | null>> = {};

      try {
        await fs.mkdir(stagingDir, { recursive: true });

        for (const bin of matchedBinaries) {
          const safeName = path.basename(bin.fileName);
          const stagedPath = path.resolve(stagingDir, safeName);
          if (!isPathStrictlyWithinDirectory(stagedPath, stagingDir, path.sep as '/' | '\\')) {
            throw new Error(`Từ chối ghi ngoài thư mục staging: ${safeName}`);
          }
          await fs.copyFile(bin.fullPath, stagedPath);
          if (this.platform !== 'win32') {
            await fs.chmod(stagedPath, 0o755).catch(() => {});
          }
          const stagedHash = await computeFileSha256(stagedPath);
          packCodecChecksums[bin.codecId] = stagedHash;
        }

        for (const dll of matchedDlls) {
          const safeName = path.basename(dll.fileName);
          const stagedPath = path.resolve(stagingDir, safeName);
          if (isPathStrictlyWithinDirectory(stagedPath, stagingDir, path.sep as '/' | '\\')) {
            await fs.copyFile(dll.fullPath, stagedPath);
          }
        }

        for (const lic of matchedLicenses) {
          const safeName = path.basename(lic.fileName);
          const stagedPath = path.resolve(stagingDir, safeName);
          if (isPathStrictlyWithinDirectory(stagedPath, stagingDir, path.sep as '/' | '\\')) {
            await fs.copyFile(lic.fullPath, stagedPath);
          }
        }

        // Verify staged binaries (re-check in staging with staged DLLs present)
        for (const bin of matchedBinaries) {
          const manifestEntry = getCodecManifestById(bin.codecId)!;
          const stagedPath = path.resolve(stagingDir, path.basename(bin.fileName));
          const { inspection } = await this.inspectAndHashBinary(stagedPath);
          if (!inspection.valid) {
            throw new Error(`Xác minh staging thất bại cho ${bin.fileName}.`);
          }
          if (inspection.executableInCurrentRuntime) {
            const missingDeps = await this.checkRequiredDependencies(manifestEntry, stagedPath);
            if (missingDeps.length === 0) {
              const probe = await probeBinaryVersion({
                executablePath: stagedPath,
                entry: manifestEntry,
                platform: this.platform,
                timeoutMs: this.probeTimeoutMs,
              });
              packCodecVersions[bin.codecId] = probe.ok ? probe.version : null;
            }
          }
        }

        // Backup existing userPackDir + full state snapshot atomically if it currently has files
        const existingPackFiles = await fs.readdir(this.userPackDir).catch(() => []);
        if (existingPackFiles.length > 0) {
          const stagingBackupDir = path.join(
            this.codecsRootDir,
            `.staging-backup-${crypto.randomUUID().slice(0, 8)}`,
          );
          try {
            await copyDirectoryContents(this.userPackDir, stagingBackupDir);
            const backupSnapshot: StoredPackSnapshot = {
              installedPackVersion: previousState.installedPackVersion,
              installedPackDate: previousState.installedPackDate,
              installedPackSource: previousState.installedPackSource,
              installedSupportingDlls: [...previousState.installedSupportingDlls],
              installedLicenseFiles: [...previousState.installedLicenseFiles],
              packCodecChecksums: { ...previousState.packCodecChecksums },
              packCodecVersions: { ...previousState.packCodecVersions },
              preferences: { ...previousState.preferences },
            };
            const tmpBackupState = `${this.userPackBackupStateFile}.tmp`;
            await fs.writeFile(tmpBackupState, JSON.stringify(backupSnapshot, null, 2), 'utf8');

            // Swap stagingBackupDir -> userPackBackupDir safely
            const oldBackupDir = path.join(
              this.codecsRootDir,
              `.old-backup-${crypto.randomUUID().slice(0, 8)}`,
            );
            const hadOldBackup = await dirExists(this.userPackBackupDir);
            if (hadOldBackup) {
              await fs.rename(this.userPackBackupDir, oldBackupDir);
            }
            try {
              await fs.rename(stagingBackupDir, this.userPackBackupDir);
              await fs.rename(tmpBackupState, this.userPackBackupStateFile);
              if (hadOldBackup) {
                await fs.rm(oldBackupDir, { recursive: true, force: true }).catch(() => {});
              }
            } catch (backupSwapErr) {
              if (hadOldBackup) {
                await fs.rename(oldBackupDir, this.userPackBackupDir).catch(() => {});
              }
              await fs.rm(tmpBackupState, { force: true }).catch(() => {});
              throw backupSwapErr;
            }
          } finally {
            await fs.rm(stagingBackupDir, { recursive: true, force: true }).catch(() => {});
          }
        }

        // Safe swap: move current userPackDir -> previousPackTempDir, move stagingDir -> userPackDir
        const hadCurrentPack = await dirExists(this.userPackDir);
        if (hadCurrentPack) {
          await fs.rename(this.userPackDir, previousPackTempDir);
        }

        try {
          await fs.rename(stagingDir, this.userPackDir);

          // Update codec-state.json without fabricating an unverified pack version
          const nextState: StoredCodecState = {
            ...previousState,
            installedPackVersion: options.verifiedPackVersion ?? null,
            installedPackDate: options.verifiedPackDate ?? new Date().toISOString().slice(0, 10),
            installedPackSource: 'user-pack',
            installedSupportingDlls: matchedDlls.map((d) => path.basename(d.fileName)),
            installedLicenseFiles: matchedLicenses.map((l) => path.basename(l.fileName)),
            packCodecChecksums,
            packCodecVersions,
          };
          await this.writeState(nextState);
        } catch (swapError) {
          // Restore previous userPackDir and previous codec-state.json on any failure
          await fs.rm(this.userPackDir, { recursive: true, force: true }).catch(() => {});
          if (hadCurrentPack) {
            await fs.rename(previousPackTempDir, this.userPackDir).catch(() => {});
          }
          await this.writeState(previousState).catch(() => {});
          throw swapError;
        }

        await fs.rm(previousPackTempDir, { recursive: true, force: true }).catch(() => {});
        this.invalidateCaches();

        const inventory = await this.getInventory(true);
        return {
          canceled: false,
          importedCount: matchedBinaries.length,
          skippedCount,
          importedCodecs: matchedBinaries.map((m) => m.codecId),
          importedSupportingDlls: matchedDlls.map((d) => path.basename(d.fileName)),
          importedLicenseFiles: matchedLicenses.map((l) => path.basename(l.fileName)),
          errors,
          inventory,
        };
      } catch (error) {
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(previousPackTempDir, { recursive: true, force: true }).catch(() => {});
        const inventory = await this.getInventory(false);
        return {
          canceled: false,
          importedCount: 0,
          skippedCount,
          importedCodecs: [],
          importedSupportingDlls: [],
          importedLicenseFiles: [],
          errors: [
            ...errors,
            error instanceof Error ? error.message : String(error),
          ],
          inventory,
        };
      }
    });
  }

  /**
   * Safe atomic Custom Codec import:
   * Never deletes the existing custom binary before the new binary is staged, validated,
   * dependency-checked, checksum-checked, and health-probed (when runnable & consented).
   * Restores previous version automatically on failure.
   */
  async importCustomBinary(
    codecId: CodecId,
    sourceFilePath: string,
    options: CustomBinaryImportOptions = {},
  ): Promise<CodecImportBinaryResult> {
    return this.withMutationLock(async () => {
      await this.ensureDirectories();
      const manifestEntry = getCodecManifestById(codecId);
      if (!manifestEntry || codecId === 'alac-wasm') {
        const inventory = await this.getInventory(false);
        return {
          canceled: false,
          codecId,
          imported: false,
          entry: null,
          error: 'Codec ID không hợp lệ hoặc không hỗ trợ thay thế binary.',
          inventory,
        };
      }

      if (this.checkCodecInUse(codecId)) {
        const inventory = await this.getInventory(false);
        return {
          canceled: false,
          codecId,
          imported: false,
          entry: null,
          error: `Không thể thay thế binary "${codecId}" khi codec đang được sử dụng.`,
          inventory,
        };
      }

      const resolvedSource = path.resolve(sourceFilePath);
      if (!(await fileExists(resolvedSource))) {
        const inventory = await this.getInventory(false);
        return {
          canceled: false,
          codecId,
          imported: false,
          entry: null,
          error: 'Tệp binary nguồn không tồn tại.',
          inventory,
        };
      }

      const safeFileName = path.basename(resolvedSource);
      const targetDir = path.resolve(this.customCodecsDir, codecId);
      if (!isPathStrictlyWithinDirectory(targetDir, this.customCodecsDir, path.sep as '/' | '\\')) {
        const inventory = await this.getInventory(false);
        return {
          canceled: false,
          codecId,
          imported: false,
          entry: null,
          error: 'Đường dẫn đích codec không hợp lệ.',
          inventory,
        };
      }

      const stagingDir = path.join(
        this.codecsRootDir,
        `.staging-custom-${codecId}-${crypto.randomUUID().slice(0, 8)}`,
      );
      const backupDir = path.join(
        this.codecsRootDir,
        `.backup-custom-${codecId}-${crypto.randomUUID().slice(0, 8)}`,
      );

      const previousState = await this.readState();

      try {
        await fs.mkdir(stagingDir, { recursive: true });
        const stagedPath = path.resolve(stagingDir, safeFileName);
        if (!isPathStrictlyWithinDirectory(stagedPath, stagingDir, path.sep as '/' | '\\')) {
          throw new Error('Tên file binary không hợp lệ.');
        }

        await fs.copyFile(resolvedSource, stagedPath);
        if (this.platform !== 'win32') {
          await fs.chmod(stagedPath, 0o755).catch(() => {});
        }

        // Verify staged binary before touching existing custom binary
        const { inspection, sha256 } = await this.inspectAndHashBinary(stagedPath);
        if (!inspection.valid || !sha256) {
          throw new Error(inspection.reason ?? 'File binary không hợp lệ.');
        }

        const expectedSha =
          options.expectedSha256?.trim().toLowerCase() ||
          this.getExpectedSha256(manifestEntry, safeFileName);
        if (expectedSha && sha256.toLowerCase() !== expectedSha) {
          throw new Error('Checksum SHA-256 của Custom Codec không khớp với giá trị mong đợi.');
        }

        const checksumVerified = Boolean(expectedSha && sha256.toLowerCase() === expectedSha);
        const userConfirmed = Boolean(options.userConfirmed);

        // Enforce host compatibility before replacing existing valid custom binary
        if (!inspection.compatibleWithHost && !(inspection.format === 'pe' && this.platform !== 'win32')) {
          throw new Error(
            inspection.reason ?? 'Binary không tương thích với kiến trúc/hệ điều hành hiện tại.',
          );
        }

        const missingDeps = await this.checkRequiredDependencies(manifestEntry, stagedPath);
        if (missingDeps.length > 0) {
          throw new Error(`Thiếu thành phần phụ thuộc bắt buộc: ${missingDeps.join(', ')}.`);
        }

        // Only execute version probe in staging if binary is trusted/consented AND runnable in current runtime
        let probedVersion: string | null = null;
        if (inspection.executableInCurrentRuntime && (checksumVerified || userConfirmed)) {
          const probe = await probeBinaryVersion({
            executablePath: stagedPath,
            entry: manifestEntry,
            platform: this.platform,
            timeoutMs: this.probeTimeoutMs,
          });
          if (!probe.ok) {
            throw new Error(probe.error ?? 'Kiểm tra sức khỏe Custom Codec trong staging thất bại.');
          }
          probedVersion = probe.version;
        }

        // Backup existing custom codec dir (never delete before swap succeeds!)
        const hadExisting = await dirExists(targetDir);
        if (hadExisting) {
          await fs.rename(targetDir, backupDir);
        }

        try {
          await fs.rename(stagingDir, targetDir);

          const nowIso = new Date().toISOString();
          const nextState: StoredCodecState = {
            ...previousState,
            customBinaries: {
              ...previousState.customBinaries,
              [codecId]: {
                fileName: safeFileName,
                importedAt: nowIso,
                sha256,
                version: probedVersion,
                originNote: options.originNote?.trim() || 'Người dùng nhập thủ công',
                userConfirmed,
                consentedAt: userConfirmed ? nowIso : null,
              },
            },
          };
          await this.writeState(nextState);
        } catch (swapError) {
          await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
          if (hadExisting) {
            await fs.rename(backupDir, targetDir).catch(() => {});
          }
          await this.writeState(previousState).catch(() => {});
          throw swapError;
        }

        if (hadExisting) {
          await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
        }
        this.invalidateCaches(codecId);

        const resolvedEntry = await this.resolveCodec(codecId, true);
        const inventory = await this.getInventory(true);
        const importedOk =
          resolvedEntry.status === 'ready' ||
          resolvedEntry.status === 'pending-desktop-verification' ||
          resolvedEntry.status === 'unverified';

        return {
          canceled: false,
          codecId,
          imported: importedOk,
          entry: resolvedEntry,
          error:
            resolvedEntry.status === 'ready' || resolvedEntry.status === 'pending-desktop-verification'
              ? undefined
              : resolvedEntry.errorMessage,
          inventory,
        };
      } catch (error) {
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
        const inventory = await this.getInventory(false);
        const currentEntry = inventory.codecs.find((c) => c.id === codecId) ?? null;
        return {
          canceled: false,
          codecId,
          imported: false,
          entry: currentEntry,
          error: error instanceof Error ? error.message : String(error),
          inventory,
        };
      }
    });
  }

  /**
   * Removes a custom override binary for a codec so DoReMi falls back to Default Pack / Bundled.
   * Blocked if the codec is currently in active use.
   */
  async removeCustomBinary(codecId: CodecId): Promise<CodecInventorySnapshot> {
    return this.withMutationLock(async () => {
      if (this.checkCodecInUse(codecId)) {
        throw new Error(`Không thể gỡ bỏ Custom Codec "${codecId}" khi đang được sử dụng.`);
      }

      await this.ensureDirectories();
      const targetDir = path.resolve(this.customCodecsDir, codecId);
      if (isPathStrictlyWithinDirectory(targetDir, this.customCodecsDir, path.sep as '/' | '\\')) {
        await fs.rm(targetDir, { recursive: true, force: true });
      }

      const state = await this.readState();
      delete state.customBinaries[codecId];
      await this.writeState(state);
      this.invalidateCaches(codecId);

      return this.getInventory(true);
    });
  }

  /**
   * Synchronized Rollback: restores binaries, supporting DLLs, license files, AND codec-state.json
   * metadata (pack version, installed date, source, checksums, codec versions, preferences).
   * Preserves valid backup intact if rollback fails.
   */
  async rollbackPack(): Promise<{
    rolledBack: boolean;
    message: string;
    inventory: CodecInventorySnapshot;
  }> {
    return this.withMutationLock(async () => {
      const activeCodec = this.checkAnyPackCodecInUse();
      if (activeCodec) {
        const inventory = await this.getInventory(false);
        return {
          rolledBack: false,
          message: `Không thể khôi phục Encoder Pack khi codec "${activeCodec}" đang được sử dụng.`,
          inventory,
        };
      }

      if (!(await dirExists(this.userPackBackupDir))) {
        const inventory = await this.getInventory(false);
        return {
          rolledBack: false,
          message: 'Chưa có bản sao lưu Encoder Pack trước đó để khôi phục.',
          inventory,
        };
      }

      const backupFiles = await fs.readdir(this.userPackBackupDir).catch(() => []);
      if (backupFiles.length === 0) {
        const inventory = await this.getInventory(false);
        return {
          rolledBack: false,
          message: 'Thư mục sao lưu Encoder Pack đang trống.',
          inventory,
        };
      }

      const stagingRestoreDir = path.join(
        this.codecsRootDir,
        `.staging-rollback-${crypto.randomUUID().slice(0, 8)}`,
      );
      const currentTempDir = path.join(
        this.codecsRootDir,
        `.pre-rollback-${crypto.randomUUID().slice(0, 8)}`,
      );
      const previousState = await this.readState();

      try {
        // Read saved pack backup state snapshot if present
        let backupSnapshot: StoredPackSnapshot | null = null;
        try {
          const rawBackupState = await fs.readFile(this.userPackBackupStateFile, 'utf8');
          backupSnapshot = JSON.parse(rawBackupState) as StoredPackSnapshot;
        } catch {
          backupSnapshot = null;
        }

        // Copy backup into staging first (keeps userPackBackupDir untouched if anything fails!)
        const restoredFiles = await copyDirectoryContents(this.userPackBackupDir, stagingRestoreDir);
        if (restoredFiles.length === 0) {
          throw new Error('Không có tệp hợp lệ nào trong bản sao lưu để khôi phục.');
        }

        if (this.platform !== 'win32') {
          for (const fileName of restoredFiles) {
            if (matchFilenameToCodecId(fileName)) {
              await fs.chmod(path.join(stagingRestoreDir, fileName), 0o755).catch(() => {});
            }
          }
        }

        const hadCurrentPack = await dirExists(this.userPackDir);
        if (hadCurrentPack) {
          await fs.rename(this.userPackDir, currentTempDir);
        }

        try {
          await fs.rename(stagingRestoreDir, this.userPackDir);

          // Synchronize codec-state.json with restored files & snapshot metadata
          const restoredDlls = restoredFiles.filter(
            (f) => f.toLowerCase().endsWith('.dll') && SUPPORTING_DLL_ALLOWLIST.has(f.toLowerCase()),
          );
          const restoredLicenses = restoredFiles.filter((f) => isRecognizedPackLicenseFile(f));
          const restoredChecksums: Partial<Record<CodecId, string>> = {};
          for (const fileName of restoredFiles) {
            const codecId = matchFilenameToCodecId(fileName);
            if (codecId) {
              restoredChecksums[codecId] = await computeFileSha256(
                path.join(this.userPackDir, fileName),
              );
            }
          }

          const nextState: StoredCodecState = {
            ...previousState,
            installedPackVersion: backupSnapshot?.installedPackVersion ?? null,
            installedPackDate: backupSnapshot?.installedPackDate ?? null,
            installedPackSource: backupSnapshot?.installedPackSource ?? 'user-pack',
            installedSupportingDlls:
              backupSnapshot?.installedSupportingDlls ?? restoredDlls,
            installedLicenseFiles:
              backupSnapshot?.installedLicenseFiles ?? restoredLicenses,
            packCodecChecksums:
              backupSnapshot?.packCodecChecksums &&
              Object.keys(backupSnapshot.packCodecChecksums).length > 0
                ? backupSnapshot.packCodecChecksums
                : restoredChecksums,
            packCodecVersions: backupSnapshot?.packCodecVersions ?? {},
            preferences: backupSnapshot?.preferences ?? previousState.preferences,
          };

          if (backupSnapshot?.preferences) {
            this.discoveryPolicy.allowSystemPathLookup =
              backupSnapshot.preferences.allowSystemPathLookup;
          }

          await this.writeState(nextState);
        } catch (swapError) {
          await fs.rm(this.userPackDir, { recursive: true, force: true }).catch(() => {});
          if (hadCurrentPack) {
            await fs.rename(currentTempDir, this.userPackDir).catch(() => {});
          }
          await this.writeState(previousState).catch(() => {});
          throw swapError;
        }

        await fs.rm(currentTempDir, { recursive: true, force: true }).catch(() => {});
        this.invalidateCaches();

        const inventory = await this.getInventory(true);
        return {
          rolledBack: true,
          message: `Đã khôi phục đồng bộ ${restoredFiles.length} tệp và trạng thái codec-state.json từ bản sao lưu trước đó.`,
          inventory,
        };
      } catch (error) {
        await fs.rm(stagingRestoreDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(currentTempDir, { recursive: true, force: true }).catch(() => {});
        const inventory = await this.getInventory(false);
        return {
          rolledBack: false,
          message: `Khôi phục thất bại (bản sao lưu vẫn được bảo toàn): ${error instanceof Error ? error.message : String(error)}`,
          inventory,
        };
      }
    });
  }

  /**
   * Secure remote manifest fetcher with:
   * - Strict HTTPS + no credentials + port 443 + hostname syntax validation
   * - Optional trusted host allowlist
   * - DNS resolution check blocking ALL loopback/private/link-local/reserved IPv4 & IPv6 addresses
   * - Pinned-IP TLS socket connection (prevents DNS rebinding at connect time)
   * - Strict redirect rejection (blocks unsafe redirect hops)
   * - 64 KB response byte limit & read timeout
   * - Strict JSON schema & version format validation (never executes manifest content)
   */
  async fetchAndValidateRemoteManifest(
    rawUrl: string,
  ): Promise<{ ok: true; manifest: ValidatedRemoteManifest } | { ok: false; reason: string }> {
    if (!this.allowRemoteUpdateChecks) {
      return {
        ok: false,
        reason: 'Kiểm tra cập nhật từ xa đang bị vô hiệu hóa theo chính sách bảo mật offline.',
      };
    }

    const urlCheck = validateSafeUpdateManifestUrl(rawUrl);
    if (!urlCheck.valid) {
      return { ok: false, reason: urlCheck.reason ?? 'URL manifest không hợp lệ.' };
    }

    const parsedUrl = new URL(rawUrl.trim());
    const hostname = parsedUrl.hostname.toLowerCase().replace(/\.$/, '');

    if (this.trustedUpdateHosts.size > 0 && !this.trustedUpdateHosts.has(hostname)) {
      return {
        ok: false,
        reason: `Tên miền "${hostname}" không nằm trong danh sách nguồn cập nhật tin cậy.`,
      };
    }

    let records: DnsLookupRecord[];
    try {
      records = await this.dnsResolver(hostname);
    } catch (error) {
      return {
        ok: false,
        reason: `Không thể phân giải DNS cho "${hostname}": ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (!Array.isArray(records) || records.length === 0) {
      return { ok: false, reason: `Không tìm thấy bản ghi DNS cho "${hostname}".` };
    }

    // Reject if ANY resolved record points to private/loopback/link-local/reserved IPv4 or IPv6
    for (const rec of records) {
      if (isPrivateOrReservedIp(rec.address)) {
        return {
          ok: false,
          reason: `Từ chối kết nối: DNS phân giải "${hostname}" tới địa chỉ nội bộ/dành riêng (${rec.address}).`,
        };
      }
    }

    const pinned = records[0];
    let response: RemoteManifestHttpResponse;
    try {
      response = await this.remoteFetcher({
        url: parsedUrl,
        pinnedIp: pinned.address,
        family: pinned.family,
        timeoutMs: this.remoteTimeoutMs,
        maxBytes: MAX_MANIFEST_BYTES,
      });
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    // Reject HTTP redirects outright to eliminate redirect-based SSRF
    if (response.statusCode >= 300 && response.statusCode < 400) {
      return {
        ok: false,
        reason: `Từ chối chuyển hướng HTTP (${response.statusCode}) khi tải manifest từ xa.`,
      };
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      return { ok: false, reason: `Máy chủ manifest trả về mã lỗi HTTP ${response.statusCode}.` };
    }

    const contentLengthHeader = response.headers['content-length'];
    const declaredLength =
      typeof contentLengthHeader === 'string' ? Number(contentLengthHeader) : Number.NaN;
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) {
      return {
        ok: false,
        reason: `Kích thước manifest (${declaredLength} bytes) vượt giới hạn tối đa ${MAX_MANIFEST_BYTES} bytes.`,
      };
    }

    let bodyText = '';
    if (typeof response.bodyText === 'string') {
      if (Buffer.byteLength(response.bodyText, 'utf8') > MAX_MANIFEST_BYTES) {
        return {
          ok: false,
          reason: `Kích thước phản hồi manifest vượt giới hạn tối đa ${MAX_MANIFEST_BYTES} bytes.`,
        };
      }
      bodyText = response.bodyText;
    } else if (response.bodyStream) {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for await (const chunk of response.bodyStream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
        totalBytes += buf.length;
        if (totalBytes > MAX_MANIFEST_BYTES) {
          return {
            ok: false,
            reason: `Phản hồi manifest vượt giới hạn tối đa ${MAX_MANIFEST_BYTES} bytes.`,
          };
        }
        chunks.push(buf);
      }
      bodyText = Buffer.concat(chunks).toString('utf8');
    } else {
      return { ok: false, reason: 'Phản hồi manifest rỗng.' };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(bodyText);
    } catch {
      return { ok: false, reason: 'Nội dung manifest không phải JSON hợp lệ.' };
    }

    const schemaResult = validateRemoteManifestSchema(parsedJson);
    if (!schemaResult.valid) {
      return { ok: false, reason: schemaResult.reason };
    }

    return { ok: true, manifest: schemaResult.manifest };
  }

  /**
   * Codec Update Manager:
   * - Default: 100% offline audit comparing installed binaries against DoReMi's manifest.
   * - Optional: hardened remote HTTPS manifest metadata check (never downloads or executes updates).
   */
  async checkUpdates(manifestUrl?: string): Promise<CodecUpdateCheckResult> {
    const inventory = await this.getInventory(true);
    const checkedAt = new Date().toISOString();
    const recommendedIds: CodecId[] = [
      'flac',
      'lame',
      'opusenc',
      'oggenc',
      'wavpack',
      'ffmpeg',
      'ffprobe',
    ];
    const missingRecommended = recommendedIds.filter(
      (id) => !inventory.codecs.some((c) => c.id === id && c.status === 'ready'),
    );

    const currentVersion = inventory.pack.installedPackVersion ?? 'Chưa xác định / Chưa cài đặt';

    if (manifestUrl && manifestUrl.trim().length > 0) {
      const remoteResult = await this.fetchAndValidateRemoteManifest(manifestUrl);
      if (!remoteResult.ok) {
        return {
          checkedAt,
          mode: 'offline-manifest',
          currentVersion,
          latestVersion: DEFAULT_ENCODER_PACK_VERSION,
          updateAvailable: missingRecommended.length > 0,
          missingRecommendedCodecs: missingRecommended,
          message: `Từ chối/không thể kiểm tra manifest từ xa (${remoteResult.reason}). Đã giữ chế độ kiểm tra cục bộ an toàn.`,
          releaseNotes: [],
        };
      }

      const latestVersion = remoteResult.manifest.manifestVersion;
      const updateAvailable = currentVersion !== latestVersion || missingRecommended.length > 0;
      return {
        checkedAt,
        mode: 'remote-manifest',
        currentVersion,
        latestVersion,
        updateAvailable,
        missingRecommendedCodecs: missingRecommended,
        message: updateAvailable
          ? `Phát hiện phiên bản manifest ${latestVersion} hoặc còn thiếu ${missingRecommended.length} codec khuyến nghị.`
          : `Bộ Codec Pack đang khớp phiên bản manifest ${latestVersion}.`,
        releaseNotes: remoteResult.manifest.notes.slice(0, 8),
      };
    }

    const updateAvailable = missingRecommended.length > 0;
    return {
      checkedAt,
      mode: 'offline-manifest',
      currentVersion,
      latestVersion: DEFAULT_ENCODER_PACK_VERSION,
      updateAvailable,
      missingRecommendedCodecs: missingRecommended,
      message: updateAvailable
        ? `Kiểm tra offline hoàn tất: còn thiếu ${missingRecommended.length} codec khuyến nghị (${missingRecommended.join(', ')}).`
        : `Tất cả ${recommendedIds.length} codec cốt lõi đã sẵn sàng và tương thích với Default Encoder Pack ${DEFAULT_ENCODER_PACK_VERSION}.`,
      releaseNotes: [
        `Tương thích foobar2000 Free Encoder Pack phiên bản ${COMPATIBLE_FOOBAR_PACK_DATE}.`,
        'Hỗ trợ nhập thư mục gói mã hóa offline không cần Internet.',
        'Tự động sao lưu cả tệp và trạng thái codec-state.json trước khi cập nhật.',
      ],
    };
  }
}
