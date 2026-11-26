import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AudioConvertOptions,
  CodecId,
  ConversionJobInputItem,
  ConversionJobRecord,
  ConversionProgressEvent,
  ConversionQueueSnapshot,
  ConvertTargetFormat,
  EffectiveResourceLimits,
  OutputVerificationReport,
  PcmComparisonStatus,
  PlaybackPriorityState,
  ProcessTerminationReason,
  ResourceMode,
  SourceAudioSpec,
  StreamingTranscodePlan,
} from '../../../shared/types/codec-engine';
import {
  buildConversionCommandPlan,
  buildStreamingTranscodePlan,
  isPathStrictlyWithinDirectory,
  normalizeConvertOptions,
  sanitizeOutputBaseName,
} from '../../../shared/utils/codec-command-builder';
import {
  DEFAULT_RESOURCE_MODE,
  SERVER_TRANSCODING_PROFILES,
  TARGET_FORMAT_META,
} from '../../../shared/utils/codec-registry';
import { AudioAnalyzerService, runFfprobeJsonDetailed } from './audio-analyzer';
import type { CodecManager } from './codec-manager';
import { FfmpegCapabilityDetector } from './ffmpeg-capabilities';
import {
  type CodecProcessAdapter,
  defaultFsPathSafetyOps,
  defaultNativeProcessAdapter,
  type FsPathSafetyOps,
} from './process-execution';
import { ResourcePolicyManager } from './resource-policy';

interface InternalJobEntry {
  record: ConversionJobRecord;
  options: AudioConvertOptions;
  durationMs: number | null;
  sourceAudioSpec?: SourceAudioSpec;
  activeChildren: ChildProcess[];
  tempOutputPath: string | null;
  reservedOutputKey: string | null;
  inUseCodecs: CodecId[];
  canceled: boolean;
  cleaningUp: boolean;
  terminationReason: ProcessTerminationReason | null;
  cleanupPromise: Promise<void> | null;
}

export interface AudioProcessingServiceOptions {
  codecManager: CodecManager;
  resourcePolicy?: ResourcePolicyManager;
  audioAnalyzer?: AudioAnalyzerService;
  ffmpegCapabilities?: FfmpegCapabilityDetector;
  platform?: NodeJS.Platform;
  startupTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  processKillGraceMs?: number;
  onQueueUpdated?: (snapshot: ConversionQueueSnapshot) => void;
  onJobProgress?: (event: ConversionProgressEvent) => void;
  onFileConverted?: (outputPath: string, autoImport: boolean) => Promise<void>;
  /** Injectable process spawner for cross-platform mock CLI tests (`Phase 4.5B`). */
  processAdapter?: CodecProcessAdapter;
  /** Injectable canonical path operations for symlink/junction/hardlink tests (`Phase 4.5C`). */
  fsPathOps?: FsPathSafetyOps;
}

const MAX_RETAINED_JOBS = 200;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 120_000;
const DEFAULT_KILL_GRACE_MS = 350;
const VERIFY_FFPROBE_TIMEOUT_MS = 12_000;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function normalizeReservationKey(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = path.resolve(filePath).normalize('NFC');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function resolveCanonicalPathAllowingMissingLeaf(
  targetPath: string,
  fsOps: FsPathSafetyOps = defaultFsPathSafetyOps,
): Promise<string> {
  const resolved = path.resolve(targetPath);
  try {
    return await fsOps.realpath(resolved);
  } catch {
    const parent = path.dirname(resolved);
    const leaf = path.basename(resolved);
    try {
      const realParent = await fsOps.realpath(parent);
      return path.join(realParent, leaf);
    } catch {
      return resolved;
    }
  }
}

/**
 * Checks whether two file paths refer to the same physical file, accounting for:
 * - Windows case-insensitivity and NFC Unicode normalization
 * - Symlinks / NTFS junctions (`fs.realpath`)
 * - Hard links (`stat.dev === statB.dev && stat.ino === statB.ino`)
 */
export async function arePathsSamePhysicalFile(
  pathA: string,
  pathB: string,
  platform: NodeJS.Platform = process.platform,
  fsOps: FsPathSafetyOps = defaultFsPathSafetyOps,
): Promise<boolean> {
  const keyA = normalizeReservationKey(pathA, platform);
  const keyB = normalizeReservationKey(pathB, platform);
  if (keyA === keyB) {
    return true;
  }

  const [canonA, canonB] = await Promise.all([
    resolveCanonicalPathAllowingMissingLeaf(pathA, fsOps),
    resolveCanonicalPathAllowingMissingLeaf(pathB, fsOps),
  ]);
  if (normalizeReservationKey(canonA, platform) === normalizeReservationKey(canonB, platform)) {
    return true;
  }

  // Hard link & mount-alias detection via (dev, ino)
  const [statA, statB] = await Promise.all([
    fsOps.stat(pathA).catch(() => null),
    fsOps.stat(pathB).catch(() => null),
  ]);
  if (
    statA &&
    statB &&
    statA.ino !== 0 &&
    statB.ino !== 0 &&
    statA.dev === statB.dev &&
    statA.ino === statB.ino
  ) {
    return true;
  }

  return false;
}

/**
 * Verifies that `candidatePath` stays strictly inside `outputDir` after resolving symlinks/junctions
 * and never resolves to the same physical file as `sourcePath`.
 */
export async function validateOutputPathSafety(params: {
  sourcePath: string;
  candidatePath: string;
  outputDir: string;
  platform?: NodeJS.Platform;
  fsOps?: FsPathSafetyOps;
}): Promise<{ safe: boolean; reason?: string }> {
  const platform = params.platform ?? process.platform;
  const fsOps = params.fsOps ?? defaultFsPathSafetyOps;
  const sep: '/' | '\\' = platform === 'win32' ? '\\' : '/';

  const realOutputDir = await resolveCanonicalPathAllowingMissingLeaf(params.outputDir, fsOps);
  const realCandidate = await resolveCanonicalPathAllowingMissingLeaf(params.candidatePath, fsOps);

  if (!isPathStrictlyWithinDirectory(realCandidate, realOutputDir, sep)) {
    return {
      safe: false,
      reason: 'Đường dẫn đích vượt ra ngoài thư mục đầu ra cho phép (nghi vấn symlink/junction escape).',
    };
  }

  // Also check lstat in case candidate itself is a symlink pointing outside or to source
  const lstat = await fsOps.lstat(params.candidatePath).catch(() => null);
  if (lstat?.isSymbolicLink()) {
    return {
      safe: false,
      reason: 'Từ chối ghi đè trực tiếp lên symbolic link ở đường dẫn đích để bảo vệ tệp gốc.',
    };
  }

  if (await arePathsSamePhysicalFile(params.sourcePath, params.candidatePath, platform, fsOps)) {
    return {
      safe: false,
      reason: 'Đường dẫn đích trỏ đến cùng một tệp vật lý với tệp nguồn (trùng đường dẫn, symlink hoặc hard link).',
    };
  }

  return { safe: true };
}

/**
 * Verifies real container magic bytes for the target audio format so empty/corrupt/garbage files are rejected.
 */
export async function verifyAudioContainerHeader(
  filePath: string,
  targetFormat: ConvertTargetFormat,
): Promise<{ valid: boolean; detectedContainer: string | null; reason?: string }> {
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(32);
    const { bytesRead } = await fh.read(buf, 0, 32, 0);
    if (bytesRead < 4) {
      return { valid: false, detectedContainer: null, reason: 'Tệp đầu ra quá nhỏ (< 4 byte).' };
    }

    const ascii4 = buf.subarray(0, 4).toString('ascii');
    const ascii8to12 = bytesRead >= 12 ? buf.subarray(8, 12).toString('ascii') : '';
    const ftyp = bytesRead >= 8 ? buf.subarray(4, 8).toString('ascii') : '';

    switch (targetFormat) {
      case 'flac':
        if (ascii4 === 'fLaC') {
          return { valid: true, detectedContainer: 'FLAC' };
        }
        return { valid: false, detectedContainer: null, reason: 'Thiếu chữ ký header FLAC ("fLaC").' };

      case 'wav':
        if ((ascii4 === 'RIFF' || ascii4 === 'RF64') && ascii8to12 === 'WAVE') {
          return { valid: true, detectedContainer: ascii4 === 'RF64' ? 'RF64/WAVE' : 'RIFF/WAVE' };
        }
        return { valid: false, detectedContainer: null, reason: 'Thiếu chữ ký header WAV ("RIFF...WAVE").' };

      case 'alac':
      case 'aac':
        if (ftyp === 'ftyp') {
          return { valid: true, detectedContainer: 'ISO-BMFF/M4A' };
        }
        // Raw ADTS AAC frame sync (0xFFF0)
        if (targetFormat === 'aac' && buf[0] === 0xff && (buf[1] & 0xf0) === 0xf0) {
          return { valid: true, detectedContainer: 'ADTS/AAC' };
        }
        return {
          valid: false,
          detectedContainer: null,
          reason: `Thiếu chữ ký container M4A/MP4 ("ftyp") cho ${targetFormat.toUpperCase()}.`,
        };

      case 'mp3':
        if (buf.subarray(0, 3).toString('ascii') === 'ID3') {
          return { valid: true, detectedContainer: 'MP3/ID3' };
        }
        if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
          return { valid: true, detectedContainer: 'MP3/MPEG' };
        }
        return { valid: false, detectedContainer: null, reason: 'Thiếu header ID3 hoặc MPEG frame sync cho MP3.' };

      case 'opus':
      case 'ogg':
        if (ascii4 === 'OggS') {
          return { valid: true, detectedContainer: 'Ogg' };
        }
        return { valid: false, detectedContainer: null, reason: 'Thiếu chữ ký container Ogg ("OggS").' };

      case 'wv':
        if (ascii4 === 'wvpk') {
          return { valid: true, detectedContainer: 'WavPack' };
        }
        return { valid: false, detectedContainer: null, reason: 'Thiếu chữ ký header WavPack ("wvpk").' };

      case 'mpc':
        if (ascii4 === 'MPCK' || buf.subarray(0, 3).toString('ascii') === 'MP+') {
          return { valid: true, detectedContainer: 'Musepack' };
        }
        return { valid: false, detectedContainer: null, reason: 'Thiếu chữ ký header Musepack ("MPCK"/"MP+").' };

      default:
        return { valid: false, detectedContainer: null, reason: 'Định dạng đích không được hỗ trợ.' };
    }
  } catch (err) {
    return {
      valid: false,
      detectedContainer: null,
      reason: `Không thể đọc header tệp đầu ra: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await fh?.close().catch(() => {});
  }
}

function doesCodecMatchTargetFormat(codecName: string, targetFormat: ConvertTargetFormat): boolean {
  const lower = codecName.trim().toLowerCase();
  switch (targetFormat) {
    case 'flac':
      return lower === 'flac';
    case 'wav':
      return lower.startsWith('pcm_');
    case 'alac':
      return lower === 'alac';
    case 'mp3':
      return lower === 'mp3' || lower === 'mp3float';
    case 'opus':
      return lower === 'opus';
    case 'ogg':
      return lower === 'vorbis';
    case 'aac':
      return lower === 'aac';
    case 'wv':
      return lower === 'wavpack';
    case 'mpc':
      return lower === 'mpc8' || lower === 'mpc7' || lower === 'musepack';
  }
}

/**
 * Decodes an audio file via trusted FFmpeg to canonical raw PCM on stdout and computes SHA-256
 * without creating any temporary WAV file on disk.
 */
async function hashDecodedPcmStream(
  ffmpegPath: string,
  filePath: string,
  pcmFormat: 's16le' | 's24le' | 's32le' | 'f32le' | 'f64le',
  timeoutMs = 60_000,
  processAdapter: CodecProcessAdapter = defaultNativeProcessAdapter,
): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    let settled = false;
    let totalBytes = 0;
    let child: ChildProcess;
    try {
      child = processAdapter.spawn(
        ffmpegPath,
        [
          '-hide_banner',
          '-nostdin',
          '-loglevel',
          'error',
          '-threads',
          '1',
          '-i',
          filePath,
          '-map',
          '0:a:0',
          '-vn',
          '-c:a',
          `pcm_${pcmFormat}`,
          '-f',
          pcmFormat,
          'pipe:1',
        ],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
    } catch {
      resolve(null);
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
        resolve(null);
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      hash.update(chunk);
    });
    child.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code !== 0 || totalBytes === 0) {
          resolve(null);
          return;
        }
        resolve(hash.digest('hex'));
      }
    });
  });
}

/**
 * Compares decoded PCM streams of source and output files for lossless-to-lossless verification.
 */
export async function compareDecodedPcmStreams(params: {
  ffmpegPath: string;
  sourcePath: string;
  outputPath: string;
  sourceSpec?: SourceAudioSpec;
  processAdapter?: CodecProcessAdapter;
}): Promise<{ status: PcmComparisonStatus; note: string }> {
  const pcmFormat: 's16le' | 's24le' | 's32le' | 'f32le' | 'f64le' =
    params.sourceSpec?.sampleFormat === 'pcm-float'
      ? params.sourceSpec.bitDepth === 64
        ? 'f64le'
        : 'f32le'
      : params.sourceSpec?.bitDepth === 16
        ? 's16le'
        : params.sourceSpec?.bitDepth === 32
          ? 's32le'
          : 's24le';

  const runner = params.processAdapter ?? defaultNativeProcessAdapter;
  const [srcHash, outHash] = await Promise.all([
    hashDecodedPcmStream(params.ffmpegPath, params.sourcePath, pcmFormat, 60_000, runner),
    hashDecodedPcmStream(params.ffmpegPath, params.outputPath, pcmFormat, 60_000, runner),
  ]);

  if (!srcHash || !outHash) {
    return {
      status: 'failed',
      note: 'Không thể giải mã so sánh PCM qua FFmpeg.',
    };
  }
  if (srcHash === outHash) {
    return {
      status: 'matched',
      note: `Khớp 100% chuỗi PCM giải mã (${pcmFormat}, SHA-256: ${srcHash.slice(0, 12)}...).`,
    };
  }
  return {
    status: 'mismatch',
    note: `Sai khác dữ liệu PCM sau giải mã (src=${srcHash.slice(0, 12)} vs out=${outHash.slice(0, 12)}).`,
  };
}

/**
 * Terminates a child process and its descendant process tree reliably on Windows and POSIX.
 */
export async function terminateProcessTree(
  child: ChildProcess,
  options?: { platform?: NodeJS.Platform; graceMs?: number },
): Promise<void> {
  const platform = options?.platform ?? process.platform;
  const graceMs = options?.graceMs ?? DEFAULT_KILL_GRACE_MS;

  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const pid = child.pid;
  const waitForExit = (timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true);
        return;
      }
      let done = false;
      const onExit = () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(true);
        }
      };
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          child.off('exit', onExit);
          child.off('close', onExit);
          resolve(false);
        }
      }, timeoutMs);
      child.once('exit', onExit);
      child.once('close', onExit);
    });

  if (platform === 'win32' && pid) {
    // Windows process tree kill via taskkill /PID <pid> /T /F (Pending Desktop Verification on real Windows)
    await new Promise<void>((resolve) => {
      try {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => resolve());
        killer.on('close', () => resolve());
      } catch {
        resolve();
      }
    });
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
    await waitForExit(graceMs);
    return;
  }

  // POSIX: try process group SIGTERM first (if spawned detached), then child SIGTERM
  if (pid) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }

  const exitedGracefully = await waitForExit(graceMs);
  if (exitedGracefully) {
    return;
  }

  // Force kill remaining process group / child
  if (pid) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }

  await waitForExit(graceMs);
}

/**
 * Resolves a safe destination path inside outputDir according to ConflictPolicy (`rename` | `skip` | `overwrite`),
 * guaranteeing that conversion NEVER overwrites the source audio file (even via symlinks, junctions,
 * hard links, or Windows case-insensitivity) and respects active `reservedPaths` locks.
 */
export async function resolveConversionOutputPath(params: {
  sourcePath: string;
  outputDir: string;
  extension: string;
  conflictPolicy: AudioConvertOptions['conflictPolicy'];
  reservedPaths?: ReadonlySet<string>;
  platform?: NodeJS.Platform;
  fsOps?: FsPathSafetyOps;
}): Promise<{ outputPath: string; skipped: boolean; conflictWithReservation?: boolean }> {
  const platform = params.platform ?? process.platform;
  const fsOps = params.fsOps ?? defaultFsPathSafetyOps;
  const sourceResolved = path.resolve(params.sourcePath);
  const rawBase = path.basename(sourceResolved, path.extname(sourceResolved));
  const safeBase = sanitizeOutputBaseName(rawBase);
  const normalizedExt = params.extension.startsWith('.') ? params.extension : `.${params.extension}`;

  const normalizedReservedSet = new Set<string>();
  if (params.reservedPaths) {
    for (const p of params.reservedPaths) {
      normalizedReservedSet.add(normalizeReservationKey(p, platform));
    }
  }

  const isReserved = (p: string): boolean =>
    normalizedReservedSet.has(normalizeReservationKey(p, platform));

  const isOccupied = async (p: string): Promise<boolean> =>
    isReserved(p) || (await pathExists(p));

  let candidate = path.resolve(params.outputDir, `${safeBase}${normalizedExt}`);
  const isSameAsSource = await arePathsSamePhysicalFile(sourceResolved, candidate, platform, fsOps);

  if (isSameAsSource) {
    // NEVER mutate or overwrite the original source file even if overwrite policy is selected
    candidate = path.resolve(params.outputDir, `${safeBase} (Converted)${normalizedExt}`);
  }

  // Verify candidate doesn't escape outputDir via symlink/junction
  const safety = await validateOutputPathSafety({
    sourcePath: sourceResolved,
    candidatePath: candidate,
    outputDir: params.outputDir,
    platform,
    fsOps,
  });
  if (!safety.safe) {
    // Fall back to safe non-conflicting renamed filename inside outputDir
    candidate = path.resolve(params.outputDir, `${safeBase} (Converted)${normalizedExt}`);
  }

  const candidateReserved = isReserved(candidate);
  const candidateOnDisk = await pathExists(candidate);

  if (!candidateReserved && !candidateOnDisk) {
    return { outputPath: candidate, skipped: false };
  }

  if (params.conflictPolicy === 'skip') {
    return { outputPath: candidate, skipped: true };
  }

  if (params.conflictPolicy === 'overwrite') {
    // If another active job currently holds this exact destination lock, signal reservation conflict
    // so caller can serialize cleanly instead of clobbering mid-write
    if (candidateReserved) {
      return { outputPath: candidate, skipped: false, conflictWithReservation: true };
    }
    // Re-verify overwrite candidate is still safe & not same physical file as source
    const overwriteSafety = await validateOutputPathSafety({
      sourcePath: sourceResolved,
      candidatePath: candidate,
      outputDir: params.outputDir,
      platform,
      fsOps,
    });
    if (!overwriteSafety.safe) {
      throw new Error(overwriteSafety.reason ?? 'Từ chối ghi đè đường dẫn đích không an toàn.');
    }
    return { outputPath: candidate, skipped: false };
  }

  // Policy: 'rename'
  for (let suffix = 1; suffix <= 999; suffix += 1) {
    const numbered = path.resolve(params.outputDir, `${safeBase} (${suffix})${normalizedExt}`);
    if (
      !(await isOccupied(numbered)) &&
      !(await arePathsSamePhysicalFile(sourceResolved, numbered, platform, fsOps))
    ) {
      return { outputPath: numbered, skipped: false };
    }
  }

  const uniqueSuffix = crypto.randomUUID().slice(0, 8);
  return {
    outputPath: path.resolve(params.outputDir, `${safeBase}-${uniqueSuffix}${normalizedExt}`),
    skipped: false,
  };
}

/**
 * Unified Audio Processing Service (Phase 03B hardened):
 * - Power Saving default (`concurrency = 1`) + Resource Modes + Playback Priority Policy
 * - Comprehensive Source File Protection (realpath/symlink/junction/hardlink/Windows case)
 * - Output Path Collision Reservation/Lock across concurrent jobs, batches & retries
 * - Safe Process Lifecycle (startup timeout, sliding inactivity/stall timeout, process tree kill, zero orphans)
 * - Queue Pause/Resume & Cancel-vs-Retry Race Condition Protection
 * - Real Audio Output Verification (container header + FFprobe stream + optional lossless PCM comparison)
 * - Honest Progress Reporting (no fake 2% init, determinate vs indeterminate, throttled)
 */
export class AudioProcessingService {
  private readonly codecManager: CodecManager;
  private readonly resourcePolicy: ResourcePolicyManager;
  private readonly audioAnalyzer: AudioAnalyzerService;
  private readonly ffmpegCapabilities: FfmpegCapabilityDetector;
  private readonly platform: NodeJS.Platform;
  private readonly startupTimeoutMs: number;
  private readonly inactivityTimeoutMs: number;
  private readonly processKillGraceMs: number;
  private readonly onQueueUpdated?: (snapshot: ConversionQueueSnapshot) => void;
  private readonly onJobProgress?: (event: ConversionProgressEvent) => void;
  private readonly onFileConverted?: (outputPath: string, autoImport: boolean) => Promise<void>;
  private readonly processAdapter: CodecProcessAdapter;
  private readonly fsPathOps: FsPathSafetyOps;

  private readonly jobs = new Map<string, InternalJobEntry>();
  private readonly jobOrder: string[] = [];
  private readonly reservedOutputPaths = new Map<string, string>();
  private readonly terminalWaiters = new Map<string, Set<() => void>>();
  private readonly unsubscribePolicy: () => void;
  private readonly detachCodecManager: () => void;

  private activeWorkers = 0;
  private requestedConcurrency = 1;
  private isPaused = false;
  private disposed = false;

  constructor(options: AudioProcessingServiceOptions) {
    this.codecManager = options.codecManager;
    this.processAdapter =
      options.processAdapter ?? options.codecManager.getProcessAdapter?.() ?? defaultNativeProcessAdapter;
    this.fsPathOps = options.fsPathOps ?? defaultFsPathSafetyOps;
    this.resourcePolicy =
      options.resourcePolicy ?? new ResourcePolicyManager(DEFAULT_RESOURCE_MODE);
    this.audioAnalyzer =
      options.audioAnalyzer ??
      new AudioAnalyzerService(this.codecManager, {
        resourcePolicy: this.resourcePolicy,
        processAdapter: this.processAdapter,
      });
    this.ffmpegCapabilities =
      options.ffmpegCapabilities ??
      new FfmpegCapabilityDetector(this.codecManager, {
        processAdapter: this.processAdapter,
      });
    this.platform = options.platform ?? process.platform;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    this.processKillGraceMs = options.processKillGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.onQueueUpdated = options.onQueueUpdated;
    this.onJobProgress = options.onJobProgress;
    this.onFileConverted = options.onFileConverted;

    // Keep CodecManager discovery policy synchronized with Resource Mode & Playback Priority
    this.detachCodecManager = this.resourcePolicy.attachCodecManager(this.codecManager);
    this.unsubscribePolicy = this.resourcePolicy.subscribe(() => {
      this.emitQueueSnapshot();
      this.pumpQueue();
    });
  }

  getResourcePolicy(): ResourcePolicyManager {
    return this.resourcePolicy;
  }

  setResourceMode(mode: ResourceMode): EffectiveResourceLimits {
    return this.resourcePolicy.setMode(mode);
  }

  setPlaybackState(state: Partial<PlaybackPriorityState>): EffectiveResourceLimits {
    return this.resourcePolicy.setPlaybackState(state);
  }

  getEffectiveResourceLimits(): EffectiveResourceLimits {
    return this.resourcePolicy.getEffectiveLimits();
  }

  private getEffectiveConcurrency(): number {
    const limits = this.resourcePolicy.getEffectiveLimits();
    return Math.max(1, Math.min(this.requestedConcurrency, limits.conversionConcurrency));
  }

  getQueueSnapshot(): ConversionQueueSnapshot {
    const orderedRecords: ConversionJobRecord[] = [];
    let activeCount = 0;
    let queuedCount = 0;
    let completedCount = 0;
    let failedCount = 0;
    let canceledCount = 0;

    for (const id of this.jobOrder) {
      const entry = this.jobs.get(id);
      if (!entry) continue;
      orderedRecords.push({
        ...entry.record,
        warnings: entry.record.warnings ? [...entry.record.warnings] : undefined,
        verification: entry.record.verification ? { ...entry.record.verification } : null,
      });
      switch (entry.record.status) {
        case 'running':
          activeCount += 1;
          break;
        case 'queued':
          queuedCount += 1;
          break;
        case 'completed':
        case 'skipped':
          completedCount += 1;
          break;
        case 'failed':
          failedCount += 1;
          break;
        case 'canceled':
          canceledCount += 1;
          break;
      }
    }

    const limits = this.resourcePolicy.getEffectiveLimits();

    return {
      jobs: orderedRecords,
      activeCount,
      queuedCount,
      completedCount,
      failedCount,
      canceledCount,
      concurrency: this.requestedConcurrency,
      effectiveConcurrency: this.getEffectiveConcurrency(),
      resourceMode: limits.mode,
      playbackPriorityActive: limits.playbackPriorityActive,
      isPaused: this.isPaused,
      isProcessing: activeCount > 0 || (queuedCount > 0 && !this.isPaused && !limits.deferNewConversionJobs),
    };
  }

  private emitQueueSnapshot(): void {
    this.onQueueUpdated?.(this.getQueueSnapshot());
  }

  private emitJobProgress(record: ConversionJobRecord): void {
    this.onJobProgress?.({
      jobId: record.id,
      status: record.status,
      progressMode: record.progressMode,
      progressPercent: record.progressPercent,
      speedLabel: record.speedLabel,
      outputPath: record.outputPath,
      outputSizeBytes: record.outputSizeBytes,
      errorMessage: record.errorMessage,
      verificationStatus: record.verification?.status ?? null,
    });
  }

  private trimJobHistory(): void {
    while (this.jobOrder.length > MAX_RETAINED_JOBS) {
      const oldestId = this.jobOrder[0];
      const oldest = this.jobs.get(oldestId);
      if (
        oldest &&
        (oldest.record.status === 'running' ||
          oldest.record.status === 'queued' ||
          oldest.cleaningUp)
      ) {
        break;
      }
      this.jobOrder.shift();
      this.jobs.delete(oldestId);
    }
  }

  pauseQueue(): ConversionQueueSnapshot {
    if (!this.isPaused) {
      this.isPaused = true;
      this.emitQueueSnapshot();
    }
    return this.getQueueSnapshot();
  }

  resumeQueue(): ConversionQueueSnapshot {
    if (this.isPaused) {
      this.isPaused = false;
      this.emitQueueSnapshot();
      this.pumpQueue();
    }
    return this.getQueueSnapshot();
  }

  async enqueueConversion(
    items: readonly ConversionJobInputItem[],
    rawOptions: Partial<AudioConvertOptions>,
  ): Promise<ConversionQueueSnapshot> {
    if (this.disposed || items.length === 0) {
      return this.getQueueSnapshot();
    }

    if (rawOptions.resourceMode) {
      this.resourcePolicy.setMode(rawOptions.resourceMode);
    }

    const activeMode = this.resourcePolicy.getMode();
    const options = normalizeConvertOptions({
      ...rawOptions,
      resourceMode: activeMode,
    });

    const limits = this.resourcePolicy.getEffectiveLimits();
    this.requestedConcurrency = Math.max(
      1,
      Math.min(options.concurrency, this.resourcePolicy.getPolicy().maxConversionConcurrency),
    );

    const readySet = await this.codecManager.getReadyCodecSet();
    const ffmpegCaps = readySet.has('ffmpeg') ? await this.ffmpegCapabilities.detect(false) : null;
    const batchId = crypto.randomUUID();

    for (const item of items) {
      const sourcePath = path.resolve(item.sourcePath);
      const outputDir = options.outputDirectory
        ? path.resolve(options.outputDirectory)
        : path.dirname(sourcePath);
      const ext = TARGET_FORMAT_META[options.targetFormat].extension;
      const previewOut = path.join(
        outputDir,
        `${sanitizeOutputBaseName(path.basename(sourcePath, path.extname(sourcePath)))}${ext}`,
      );

      let encoderLabel = TARGET_FORMAT_META[options.targetFormat].label;
      let pipelineMode: 'direct' | 'piped' = 'direct';
      let commandPreview = '';
      let planWarnings: string[] = [];

      try {
        const plan = buildConversionCommandPlan({
          sourcePath,
          outputPath: previewOut,
          options,
          availableCodecs: readySet,
          sourceAudioSpec: item.sourceAudioSpec,
          ffmpegCapabilities: ffmpegCaps,
          effectiveMaxThreads: limits.encoderThreads,
        });
        encoderLabel = plan.encoderLabel;
        pipelineMode = plan.pipelineMode;
        commandPreview = plan.commandPreview;
        planWarnings = [...plan.warnings];
      } catch (err) {
        planWarnings = [err instanceof Error ? err.message : String(err)];
      }

      const jobId = crypto.randomUUID();
      const record: ConversionJobRecord = {
        id: jobId,
        batchId,
        trackId: item.trackId ?? null,
        title: item.title?.trim() || path.basename(sourcePath, path.extname(sourcePath)),
        artist: item.artist?.trim() || 'Unknown Artist',
        sourcePath,
        outputPath: null,
        targetFormat: options.targetFormat,
        encoderLabel,
        pipelineMode,
        commandPreview,
        status: 'queued',
        progressMode: 'indeterminate',
        progressPercent: 0,
        speedLabel: null,
        outputSizeBytes: null,
        startedAt: null,
        completedAt: null,
        errorMessage: null,
        warnings: planWarnings,
        verification: null,
        terminationReason: null,
      };

      this.jobs.set(jobId, {
        record,
        options,
        durationMs: item.durationMs ?? null,
        sourceAudioSpec: item.sourceAudioSpec,
        activeChildren: [],
        tempOutputPath: null,
        reservedOutputKey: null,
        inUseCodecs: [],
        canceled: false,
        cleaningUp: false,
        terminationReason: null,
        cleanupPromise: null,
      });
      this.jobOrder.push(jobId);
    }

    this.trimJobHistory();
    this.emitQueueSnapshot();
    this.pumpQueue();
    return this.getQueueSnapshot();
  }

  cancelJob(jobId: string): ConversionQueueSnapshot {
    const entry = this.jobs.get(jobId);
    if (!entry) {
      return this.getQueueSnapshot();
    }

    if (entry.record.status === 'queued') {
      entry.canceled = true;
      entry.terminationReason = 'canceled';
      entry.record.status = 'canceled';
      entry.record.terminationReason = 'canceled';
      entry.record.completedAt = new Date().toISOString();
      entry.record.errorMessage = 'Đã hủy bởi người dùng.';
      this.emitJobProgress(entry.record);
      this.emitQueueSnapshot();
      this.notifyJobTerminalIfSettled(entry);
      return this.getQueueSnapshot();
    }

    if (entry.record.status === 'running') {
      entry.canceled = true;
      entry.cleaningUp = true;
      entry.terminationReason = 'canceled';
      entry.record.status = 'canceled';
      entry.record.terminationReason = 'canceled';
      entry.record.completedAt = new Date().toISOString();
      entry.record.errorMessage = 'Đã hủy tiến trình chuyển đổi (đang dọn tiến trình con & file tạm).';
      this.emitJobProgress(entry.record);
      this.emitQueueSnapshot();

      const children = [...entry.activeChildren];
      const killPromise = Promise.all(
        children.map((child) =>
          terminateProcessTree(child, {
            platform: this.platform,
            graceMs: this.processKillGraceMs,
          }),
        ),
      ).then(() => undefined);

      const previousCleanup = entry.cleanupPromise;
      const chainedCleanup = (previousCleanup
        ? previousCleanup.then(() => killPromise, () => killPromise)
        : killPromise
      ).finally(() => {
        if (entry.cleanupPromise === chainedCleanup) {
          entry.cleanupPromise = null;
        }
        this.notifyJobTerminalIfSettled(entry);
      });
      entry.cleanupPromise = chainedCleanup;
    }

    return this.getQueueSnapshot();
  }

  cancelAllJobs(): ConversionQueueSnapshot {
    for (const id of this.jobOrder) {
      const entry = this.jobs.get(id);
      if (entry && (entry.record.status === 'queued' || entry.record.status === 'running')) {
        this.cancelJob(id);
      }
    }
    return this.getQueueSnapshot();
  }

  /**
   * Retries failed or canceled jobs ONLY when their previous process tree, temp files,
   * codec locks, and output path reservations have completely finished cleaning up.
   */
  retryFailedJobs(): ConversionQueueSnapshot {
    let retried = false;
    for (const id of this.jobOrder) {
      const entry = this.jobs.get(id);
      if (!entry) continue;
      if (entry.record.status !== 'failed' && entry.record.status !== 'canceled') continue;

      // Strict race-condition guard: NEVER restart a job while previous child/temp/lock cleanup is still running!
      if (
        entry.cleaningUp ||
        entry.activeChildren.length > 0 ||
        entry.tempOutputPath !== null ||
        entry.reservedOutputKey !== null ||
        entry.inUseCodecs.length > 0
      ) {
        continue;
      }

      entry.canceled = false;
      entry.terminationReason = null;
      entry.cleanupPromise = null;
      entry.record.status = 'queued';
      entry.record.progressMode = 'indeterminate';
      entry.record.progressPercent = 0;
      entry.record.speedLabel = null;
      entry.record.errorMessage = null;
      entry.record.startedAt = null;
      entry.record.completedAt = null;
      entry.record.verification = null;
      entry.record.terminationReason = null;
      retried = true;
    }
    if (retried) {
      this.emitQueueSnapshot();
      this.pumpQueue();
    }
    return this.getQueueSnapshot();
  }

  clearFinishedJobs(): ConversionQueueSnapshot {
    const keepIds: string[] = [];
    for (const id of this.jobOrder) {
      const entry = this.jobs.get(id);
      if (!entry) continue;
      if (
        entry.record.status === 'running' ||
        entry.record.status === 'queued' ||
        entry.cleaningUp
      ) {
        keepIds.push(id);
      } else {
        this.jobs.delete(id);
      }
    }
    this.jobOrder.length = 0;
    this.jobOrder.push(...keepIds);
    this.emitQueueSnapshot();
    return this.getQueueSnapshot();
  }

  private isTerminalStatus(status: ConversionJobRecord['status']): boolean {
    return status === 'completed' || status === 'skipped' || status === 'failed' || status === 'canceled';
  }

  private isEntrySettled(entry: InternalJobEntry): boolean {
    return (
      this.isTerminalStatus(entry.record.status) &&
      !entry.cleaningUp &&
      entry.cleanupPromise === null
    );
  }

  private cloneJobRecord(record: ConversionJobRecord): ConversionJobRecord {
    return {
      ...record,
      warnings: record.warnings ? [...record.warnings] : undefined,
      verification: record.verification ? { ...record.verification } : null,
    };
  }

  private notifyJobTerminalIfSettled(entry: InternalJobEntry): void {
    if (!this.isEntrySettled(entry)) {
      return;
    }
    const waiters = this.terminalWaiters.get(entry.record.id);
    if (!waiters || waiters.size === 0) {
      return;
    }
    this.terminalWaiters.delete(entry.record.id);
    for (const cb of [...waiters]) {
      cb();
    }
  }

  /**
   * Event-driven terminal wait for one specific job ID (zero polling).
   * Resolves only when the job reaches a terminal state AND temp/process cleanup has completed.
   */
  async waitForJob(
    jobId: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ConversionJobRecord> {
    const timeoutMs = Math.max(100, options?.timeoutMs ?? 60_000);
    const signal = options?.signal;
    const entry = this.jobs.get(jobId);
    if (!entry) {
      throw new Error(`Không tìm thấy job chuyển đổi "${jobId}" trong hàng đợi.`);
    }
    if (this.isEntrySettled(entry)) {
      return this.cloneJobRecord(entry.record);
    }
    if (signal?.aborted) {
      throw new Error(`Đã hủy chờ job "${jobId}".`);
    }

    await new Promise<void>((resolve, reject) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let waitersSet = this.terminalWaiters.get(jobId);
      if (!waitersSet) {
        waitersSet = new Set();
        this.terminalWaiters.set(jobId, waitersSet);
      }

      const cleanupListeners = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        waitersSet?.delete(onSettled);
        if (waitersSet && waitersSet.size === 0) {
          this.terminalWaiters.delete(jobId);
        }
        signal?.removeEventListener('abort', onAbort);
      };

      const onSettled = () => {
        if (finished) return;
        finished = true;
        cleanupListeners();
        resolve();
      };

      const onAbort = () => {
        if (finished) return;
        finished = true;
        cleanupListeners();
        reject(new Error(`Đã hủy chờ job "${jobId}" bởi AbortSignal.`));
      };

      waitersSet.add(onSettled);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        cleanupListeners();
        const snap = this.getQueueSnapshot();
        const current = this.jobs.get(jobId)?.record;
        reject(
          new Error(
            `Hết thời gian chờ job "${jobId}" (${timeoutMs} ms): status=${current?.status ?? 'missing'}, cleaningUp=${String(this.jobs.get(jobId)?.cleaningUp)}, queuePaused=${String(snap.isPaused)}, active=${snap.activeCount}, queued=${snap.queuedCount}.`,
          ),
        );
      }, timeoutMs);

      if (this.isEntrySettled(entry)) {
        onSettled();
      }
    });

    const finalEntry = this.jobs.get(jobId);
    if (!finalEntry) {
      throw new Error(`Job "${jobId}" đã bị xóa khỏi hàng đợi trước khi đọc kết quả.`);
    }
    return this.cloneJobRecord(finalEntry.record);
  }

  /**
   * Waits cleanly until every job belonging to `batchId` settles into a terminal state.
   */
  async waitForBatch(
    batchId: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ConversionQueueSnapshot> {
    const ids = this.jobOrder.filter((id) => this.jobs.get(id)?.record.batchId === batchId);
    for (const id of ids) {
      await this.waitForJob(id, options);
    }
    return this.getQueueSnapshot();
  }

  /**
   * Waits until all active/canceling jobs (including sequentially pumped queued jobs)
   * finish child process teardown and temp cleanup.
   */
  async waitForCleanup(): Promise<void> {
    const awaited = new Set<Promise<void>>();
    while (true) {
      const pending: Promise<void>[] = [];
      for (const entry of this.jobs.values()) {
        if (entry.cleanupPromise && !awaited.has(entry.cleanupPromise)) {
          awaited.add(entry.cleanupPromise);
          pending.push(entry.cleanupPromise.catch(() => {}));
        }
      }
      if (pending.length === 0) {
        break;
      }
      await Promise.all(pending);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribePolicy();
    this.detachCodecManager();
    this.cancelAllJobs();
  }

  async disposeAsync(): Promise<void> {
    this.dispose();
    await this.waitForCleanup();
  }

  private pumpQueue(): void {
    if (this.disposed || this.isPaused) {
      return;
    }

    const limits = this.resourcePolicy.getEffectiveLimits();
    if (limits.deferNewConversionJobs) {
      return;
    }

    const effectiveConcurrency = this.getEffectiveConcurrency();
    while (this.activeWorkers < effectiveConcurrency) {
      const nextEntry = this.findNextQueuedJob();
      if (!nextEntry) {
        break;
      }
      this.activeWorkers += 1;
      const runPromise = this.executeJob(nextEntry).finally(() => {
        if (nextEntry.cleanupPromise === runPromise) {
          nextEntry.cleanupPromise = null;
        }
        this.activeWorkers = Math.max(0, this.activeWorkers - 1);
        this.pumpQueue();
        this.notifyJobTerminalIfSettled(nextEntry);
      });
      nextEntry.cleanupPromise = runPromise;
    }
  }

  private findNextQueuedJob(): InternalJobEntry | null {
    for (const id of this.jobOrder) {
      const entry = this.jobs.get(id);
      if (entry && entry.record.status === 'queued' && !entry.canceled && !entry.cleaningUp) {
        return entry;
      }
    }
    return null;
  }

  private releaseJobCodecs(entry: InternalJobEntry): void {
    for (const codecId of entry.inUseCodecs) {
      this.codecManager.releaseCodecInUse(codecId);
    }
    entry.inUseCodecs = [];
  }

  private releaseOutputReservation(entry: InternalJobEntry): void {
    if (entry.reservedOutputKey) {
      if (this.reservedOutputPaths.get(entry.reservedOutputKey) === entry.record.id) {
        this.reservedOutputPaths.delete(entry.reservedOutputKey);
      }
      entry.reservedOutputKey = null;
    }
  }

  private async executeJob(entry: InternalJobEntry): Promise<void> {
    const { record, options } = entry;
    record.status = 'running';
    record.startedAt = new Date().toISOString();
    record.progressPercent = 0;
    record.progressMode = 'indeterminate';
    record.terminationReason = null;
    record.verification = null;
    this.emitJobProgress(record);
    this.emitQueueSnapshot();

    try {
      // 1. Validate source file exists & is a regular file
      const srcStat = await fs.stat(record.sourcePath).catch(() => null);
      if (!srcStat || !srcStat.isFile()) {
        throw new Error('File nguồn không tồn tại hoặc không thể truy cập.');
      }

      // 2. Probe source audio spec if not supplied (preserves exact source bit depth, float/int, channels & attached_pic)
      let sourceSpec = entry.sourceAudioSpec;
      if (!sourceSpec) {
        sourceSpec = await this.audioAnalyzer.probeSourceAudioSpec(record.sourcePath).catch(() => undefined);
        entry.sourceAudioSpec = sourceSpec;
        if (entry.durationMs === null && sourceSpec?.durationSec) {
          entry.durationMs = Math.round(sourceSpec.durationSec * 1000);
        }
      }

      if (entry.canceled) {
        return;
      }

      // 3. Resolve & atomically reserve destination output path (collision lock across concurrent jobs & batches)
      const outputDir = options.outputDirectory
        ? path.resolve(options.outputDirectory)
        : path.dirname(record.sourcePath);
      await fs.mkdir(outputDir, { recursive: true });

      const ext = TARGET_FORMAT_META[options.targetFormat].extension;
      const reservedKeys = new Set(this.reservedOutputPaths.keys());
      const destResolution = await resolveConversionOutputPath({
        sourcePath: record.sourcePath,
        outputDir,
        extension: ext,
        conflictPolicy: options.conflictPolicy,
        reservedPaths: reservedKeys,
        platform: this.platform,
        fsOps: this.fsPathOps,
      });

      if (destResolution.conflictWithReservation) {
        // Another active job is currently overwriting this exact destination — re-queue safely without failing
        record.status = 'queued';
        record.startedAt = null;
        this.emitQueueSnapshot();
        return;
      }

      if (destResolution.skipped) {
        record.status = 'skipped';
        record.outputPath = destResolution.outputPath;
        record.progressMode = 'determinate';
        record.progressPercent = 100;
        record.terminationReason = 'completed';
        record.completedAt = new Date().toISOString();
        this.emitJobProgress(record);
        this.emitQueueSnapshot();
        return;
      }

      const finalOutputPath = destResolution.outputPath;
      const outputKey = normalizeReservationKey(finalOutputPath, this.platform);
      this.reservedOutputPaths.set(outputKey, record.id);
      entry.reservedOutputKey = outputKey;

      const tempOutputPath = path.join(
        outputDir,
        `.doremi-tmp-${entry.record.id.slice(0, 8)}-${crypto.randomUUID().slice(0, 6)}${ext}`,
      );
      entry.tempOutputPath = tempOutputPath;

      // 4. Build command plan against currently ready codecs + FFmpeg capabilities + active Resource Mode threads
      const readyMap = await this.codecManager.getReadyCodecMap();
      const readySet = new Set(readyMap.keys());
      const ffmpegCaps = readySet.has('ffmpeg')
        ? await this.ffmpegCapabilities.detect(false)
        : null;
      const limits = this.resourcePolicy.getEffectiveLimits();

      const plan = buildConversionCommandPlan({
        sourcePath: record.sourcePath,
        outputPath: tempOutputPath,
        options: {
          ...options,
          resourceMode: limits.mode,
        },
        availableCodecs: readySet,
        sourceAudioSpec: sourceSpec,
        ffmpegCapabilities: ffmpegCaps,
        effectiveMaxThreads: limits.encoderThreads,
      });

      record.encoderLabel = plan.encoderLabel;
      record.pipelineMode = plan.pipelineMode;
      record.commandPreview = plan.commandPreview;
      record.warnings = [...plan.warnings];

      const missingRequired = plan.requiredCodecs.filter((id) => !readyMap.has(id));
      if (missingRequired.length > 0) {
        throw new Error(
          `Thiếu codec bắt buộc: ${missingRequired.join(', ')}. Hãy nhập Default Encoder Pack hoặc FFmpeg trong Codec Manager.`,
        );
      }

      const resolvedSteps = plan.steps.map((step) => {
        const runtime = readyMap.get(step.codecId);
        if (!runtime?.executablePath || runtime.sourceTier === 'builtin') {
          throw new Error(`Không tìm thấy file thực thi tin cậy cho codec "${step.codecId}".`);
        }
        return {
          ...step,
          executablePath: runtime.executablePath,
        };
      });

      // Mark required codecs as actively in use (prevents unsafe binary replacement/rollback mid-encode)
      const uniqueCodecs = Array.from(new Set(plan.requiredCodecs));
      for (const codecId of uniqueCodecs) {
        this.codecManager.markCodecInUse(codecId);
        entry.inUseCodecs.push(codecId);
      }

      // 5. Execute direct or piped pipeline with `shell: false`, startup & sliding inactivity timeouts
      await this.runPipelineSteps(entry, resolvedSteps);

      if (entry.canceled) {
        return;
      }

      // 6. Real Audio Output Verification BEFORE atomic commit
      const verification = await this.verifyOutputFile({
        sourcePath: record.sourcePath,
        tempOutputPath,
        targetFormat: options.targetFormat,
        options,
        sourceSpec,
        readyMap,
      });
      record.verification = verification;

      if (verification.status === 'failed') {
        throw new Error(
          verification.errorMessage ?? 'Tệp đầu ra không vượt qua bước xác minh tính hợp lệ.',
        );
      }
      if (verification.warnings.length > 0) {
        record.warnings = [...(record.warnings ?? []), ...verification.warnings];
      }

      if (entry.canceled) {
        return;
      }

      // 7. Final pre-commit Source File Protection & Symlink Escape Check
      const preCommitSafety = await validateOutputPathSafety({
        sourcePath: record.sourcePath,
        candidatePath: finalOutputPath,
        outputDir,
        platform: this.platform,
        fsOps: this.fsPathOps,
      });
      if (!preCommitSafety.safe) {
        throw new Error(
          preCommitSafety.reason ?? 'Từ chối ghi đè đích không an toàn trước khi hoàn tất.',
        );
      }

      if (entry.canceled) {
        return;
      }

      // 8. Atomic Commit with Backup-Before-Rename swap & recovery
      let backupOutputPath: string | null = null;
      if (options.conflictPolicy === 'overwrite' && (await pathExists(finalOutputPath))) {
        backupOutputPath = path.join(
          outputDir,
          `.doremi-bak-${entry.record.id.slice(0, 8)}-${crypto.randomUUID().slice(0, 6)}${ext}`,
        );
        await fs.rename(finalOutputPath, backupOutputPath);
      }

      try {
        await fs.rename(tempOutputPath, finalOutputPath);
      } catch (renameError) {
        if (backupOutputPath) {
          await fs.rename(backupOutputPath, finalOutputPath).catch(() => {});
        }
        throw renameError;
      }

      if (backupOutputPath) {
        await fs.rm(backupOutputPath, { force: true }).catch(() => {});
      }
      entry.tempOutputPath = null;

      record.outputPath = finalOutputPath;
      record.outputSizeBytes = verification.fileSizeBytes;
      record.progressMode = 'determinate';
      record.progressPercent = 100;
      record.status = 'completed';
      record.terminationReason = 'completed';
      record.completedAt = new Date().toISOString();
      this.emitJobProgress(record);
      this.emitQueueSnapshot();

      if (options.autoImportToLibrary && this.onFileConverted) {
        await this.onFileConverted(finalOutputPath, true).catch(() => {});
      }
    } catch (error) {
      if (!entry.canceled) {
        record.status = 'failed';
        record.terminationReason = entry.terminationReason ?? 'error';
        record.completedAt = new Date().toISOString();
        record.errorMessage = error instanceof Error ? error.message : String(error);
        this.emitJobProgress(record);
        this.emitQueueSnapshot();
      }
    } finally {
      entry.cleaningUp = true;
      // Guarantee all child processes are stopped, temp files deleted, codecs & output lock released
      if (entry.activeChildren.length > 0) {
        await Promise.all(
          entry.activeChildren.map((child) =>
            terminateProcessTree(child, {
              platform: this.platform,
              graceMs: this.processKillGraceMs,
            }),
          ),
        );
        entry.activeChildren = [];
      }
      if (entry.tempOutputPath) {
        await fs.rm(entry.tempOutputPath, { force: true }).catch(() => {});
        entry.tempOutputPath = null;
      }
      this.releaseJobCodecs(entry);
      this.releaseOutputReservation(entry);
      entry.cleaningUp = false;
      if (entry.canceled) {
        record.status = 'canceled';
        record.errorMessage = 'Đã hủy tiến trình chuyển đổi.';
        this.emitJobProgress(record);
        this.emitQueueSnapshot();
      }
    }
  }

  private async verifyOutputFile(params: {
    sourcePath: string;
    tempOutputPath: string;
    targetFormat: ConvertTargetFormat;
    options: AudioConvertOptions;
    sourceSpec?: SourceAudioSpec;
    readyMap: Map<CodecId, { executablePath: string | null; sourceTier: string }>;
  }): Promise<OutputVerificationReport> {
    const warnings: string[] = [];
    const outStat = await fs.stat(params.tempOutputPath).catch(() => null);
    if (!outStat || !outStat.isFile() || outStat.size <= 0) {
      return {
        status: 'failed',
        fileExists: Boolean(outStat?.isFile()),
        fileSizeBytes: outStat?.size ?? 0,
        containerHeaderValid: false,
        detectedContainer: null,
        audioStreamFound: false,
        codecName: null,
        durationSec: null,
        sampleRateHz: null,
        bitDepth: null,
        channels: null,
        pcmComparisonStatus: 'not-requested',
        warnings,
        errorMessage: 'File đầu ra không tồn tại hoặc rỗng sau khi mã hóa.',
      };
    }

    const headerCheck = await verifyAudioContainerHeader(
      params.tempOutputPath,
      params.targetFormat,
    );
    if (!headerCheck.valid) {
      return {
        status: 'failed',
        fileExists: true,
        fileSizeBytes: outStat.size,
        containerHeaderValid: false,
        detectedContainer: headerCheck.detectedContainer,
        audioStreamFound: false,
        codecName: null,
        durationSec: null,
        sampleRateHz: null,
        bitDepth: null,
        channels: null,
        pcmComparisonStatus: 'not-requested',
        warnings,
        errorMessage: headerCheck.reason ?? 'Header container của tệp đầu ra không hợp lệ.',
      };
    }

    let status: OutputVerificationReport['status'] = 'verified-container-only';
    let audioStreamFound: boolean | null = null;
    let codecName: string | null = null;
    let durationSec: number | null = null;
    let sampleRateHz: number | null = null;
    let bitDepth: number | null = null;
    let channels: number | null = null;

    const ffprobeRuntime = params.readyMap.get('ffprobe');
    if (ffprobeRuntime?.executablePath && ffprobeRuntime.sourceTier !== 'builtin') {
      this.codecManager.markCodecInUse('ffprobe');
      try {
        const probeRes = await runFfprobeJsonDetailed(
          ffprobeRuntime.executablePath,
          params.tempOutputPath,
          VERIFY_FFPROBE_TIMEOUT_MS,
          this.processAdapter,
        );
        if (probeRes.status !== 'ok' || !probeRes.data) {
          return {
            status: 'failed',
            fileExists: true,
            fileSizeBytes: outStat.size,
            containerHeaderValid: true,
            detectedContainer: headerCheck.detectedContainer,
            audioStreamFound: false,
            codecName: null,
            durationSec: null,
            sampleRateHz: null,
            bitDepth: null,
            channels: null,
            pcmComparisonStatus: 'not-requested',
            warnings,
            errorMessage: `Xác minh FFprobe thất bại (${probeRes.status}): ${probeRes.errorDetail ?? 'tệp đầu ra không chứa luồng âm thanh hợp lệ.'}`,
          };
        }

        const audioStream = (probeRes.data.streams ?? []).find((s) => s.codec_type === 'audio');
        audioStreamFound = Boolean(audioStream);
        codecName = audioStream?.codec_name ?? null;
        durationSec = audioStream?.duration
          ? Number(audioStream.duration)
          : probeRes.data.format?.duration
            ? Number(probeRes.data.format.duration)
            : null;
        sampleRateHz = audioStream?.sample_rate ? Number(audioStream.sample_rate) : null;
        channels = typeof audioStream?.channels === 'number' ? audioStream.channels : null;
        const rawBits = audioStream?.bits_per_raw_sample
          ? Number(audioStream.bits_per_raw_sample)
          : typeof audioStream?.bits_per_sample === 'number' && audioStream.bits_per_sample > 0
            ? audioStream.bits_per_sample
            : null;
        bitDepth = rawBits && Number.isFinite(rawBits) && rawBits > 0 ? rawBits : null;

        if (!audioStreamFound || !codecName) {
          return {
            status: 'failed',
            fileExists: true,
            fileSizeBytes: outStat.size,
            containerHeaderValid: true,
            detectedContainer: headerCheck.detectedContainer,
            audioStreamFound: false,
            codecName: null,
            durationSec,
            sampleRateHz,
            bitDepth,
            channels,
            pcmComparisonStatus: 'not-requested',
            warnings,
            errorMessage: 'Tệp đầu ra không chứa luồng âm thanh hợp lệ theo kiểm tra FFprobe.',
          };
        }

        if (!doesCodecMatchTargetFormat(codecName, params.targetFormat)) {
          return {
            status: 'failed',
            fileExists: true,
            fileSizeBytes: outStat.size,
            containerHeaderValid: true,
            detectedContainer: headerCheck.detectedContainer,
            audioStreamFound: true,
            codecName,
            durationSec,
            sampleRateHz,
            bitDepth,
            channels,
            pcmComparisonStatus: 'not-requested',
            warnings,
            errorMessage: `Codec thực tế trong tệp đầu ra ("${codecName}") không khớp định dạng đích "${params.targetFormat}".`,
          };
        }

        // Check duration sanity when source duration is known
        if (
          params.sourceSpec?.durationSec &&
          params.sourceSpec.durationSec > 1 &&
          durationSec !== null &&
          Number.isFinite(durationSec)
        ) {
          const diff = Math.abs(durationSec - params.sourceSpec.durationSec);
          const tolerance = Math.max(1.5, params.sourceSpec.durationSec * 0.05);
          if (diff > tolerance) {
            warnings.push(
              `Thời lượng tệp đầu ra (${durationSec.toFixed(2)}s) chênh lệch đáng kể so với nguồn (${params.sourceSpec.durationSec.toFixed(2)}s).`,
            );
          }
        }

        status = 'verified-full';
      } finally {
        this.codecManager.releaseCodecInUse('ffprobe');
      }
    } else {
      warnings.push(
        'Đã xác minh chữ ký container đầu ra nhưng chưa có FFprobe để kiểm tra sâu luồng âm thanh (verified-container-only).',
      );
    }

    // Optional Lossless-to-Lossless decoded PCM SHA-256 verification
    let pcmComparisonStatus: PcmComparisonStatus = 'not-requested';
    let pcmComparisonNote: string | undefined;

    if (params.options.verifyPcmOnLossless) {
      const targetIsLossless = TARGET_FORMAT_META[params.targetFormat].isLossless;
      const dspChanged =
        params.options.sampleRateHz !== 'source' ||
        params.options.bitDepth !== 'source' ||
        params.options.channels !== 'source';

      if (!targetIsLossless || params.sourceSpec?.isLosslessCodec === false) {
        pcmComparisonStatus = 'skipped-lossy';
        pcmComparisonNote = 'Bỏ qua so sánh PCM bit-for-bit vì có định dạng lossy.';
      } else if (dspChanged) {
        pcmComparisonStatus = 'skipped-dsp-changed';
        pcmComparisonNote = 'Bỏ qua so sánh PCM bit-for-bit vì người dùng đã thay đổi sample rate/bit depth/kênh.';
      } else {
        const ffmpegRuntime = params.readyMap.get('ffmpeg');
        if (!ffmpegRuntime?.executablePath || ffmpegRuntime.sourceTier === 'builtin') {
          pcmComparisonStatus = 'skipped-no-ffmpeg';
          pcmComparisonNote = 'Cần FFmpeg tin cậy để chạy so sánh luồng PCM giải mã.';
          if (status === 'verified-full') {
            status = 'verified-container-only';
          }
          warnings.push(
            'Đã yêu cầu verifyPcmOnLossless nhưng thiếu FFmpeg nên chỉ xác minh được mức header/metadata (không đánh dấu verified-full).',
          );
        } else {
          this.codecManager.markCodecInUse('ffmpeg');
          try {
            const cmp = await compareDecodedPcmStreams({
              ffmpegPath: ffmpegRuntime.executablePath,
              sourcePath: params.sourcePath,
              outputPath: params.tempOutputPath,
              sourceSpec: params.sourceSpec,
              processAdapter: this.processAdapter,
            });
            pcmComparisonStatus = cmp.status;
            pcmComparisonNote = cmp.note;
            if (cmp.status === 'mismatch' || cmp.status === 'failed') {
              return {
                status: 'failed',
                fileExists: true,
                fileSizeBytes: outStat.size,
                containerHeaderValid: true,
                detectedContainer: headerCheck.detectedContainer,
                audioStreamFound,
                codecName,
                durationSec,
                sampleRateHz,
                bitDepth,
                channels,
                pcmComparisonStatus,
                pcmComparisonNote,
                warnings,
                errorMessage: `Kiểm chứng lossless PCM thất bại: ${cmp.note}`,
              };
            }
          } finally {
            this.codecManager.releaseCodecInUse('ffmpeg');
          }
        }
      }
    }

    return {
      status,
      fileExists: true,
      fileSizeBytes: outStat.size,
      containerHeaderValid: true,
      detectedContainer: headerCheck.detectedContainer,
      audioStreamFound,
      codecName,
      durationSec,
      sampleRateHz,
      bitDepth,
      channels,
      pcmComparisonStatus,
      pcmComparisonNote,
      warnings,
    };
  }

  private parseNativeProgressFromStderr(entry: InternalJobEntry, chunkText: string): boolean {
    // Matches standard percentage output emitted by flac/lame/wavpack/opusenc (e.g. "45% complete" or "( 45%)")
    const match = /(\d{1,3})(?:\.\d+)?%/.exec(chunkText);
    if (!match) {
      return false;
    }
    const pct = Number.parseInt(match[1], 10);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return false;
    }
    entry.record.progressMode = 'determinate';
    // Never emit 100% before exit 0 + verification + atomic commit!
    entry.record.progressPercent = Math.min(99, Math.max(entry.record.progressPercent, pct));
    return true;
  }

  private async runPipelineSteps(
    entry: InternalJobEntry,
    steps: Array<{
      codecId: CodecId;
      executableName: string;
      executablePath: string;
      args: string[];
    }>,
  ): Promise<void> {
    const useDetachedGroup = this.platform !== 'win32';
    const throttleMs = () => this.resourcePolicy.getEffectiveLimits().progressThrottleMs;

    if (steps.length === 1) {
      const step = steps[0];
      await new Promise<void>((resolve, reject) => {
        const child = this.processAdapter.spawn(step.executablePath, step.args, {
          windowsHide: true,
          detached: useDetachedGroup,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        entry.activeChildren = [child];

        let stderrLog = '';
        let stdoutBuf = '';
        let lastEmitMs = 0;
        let hasActivity = false;
        let settled = false;

        let startupTimer: ReturnType<typeof setTimeout> | null = null;
        let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

        const clearTimers = () => {
          if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimer = null;
          }
          if (inactivityTimer) {
            clearTimeout(inactivityTimer);
            inactivityTimer = null;
          }
        };

        const triggerTimeout = (reason: 'startup-timeout' | 'inactivity-timeout', msg: string) => {
          if (settled) return;
          settled = true;
          clearTimers();
          entry.terminationReason = reason;
          void terminateProcessTree(child, {
            platform: this.platform,
            graceMs: this.processKillGraceMs,
          }).finally(() => {
            reject(new Error(msg));
          });
        };

        const armInactivityTimer = () => {
          if (inactivityTimer) clearTimeout(inactivityTimer);
          inactivityTimer = setTimeout(() => {
            triggerTimeout(
              'inactivity-timeout',
              `${step.executableName} bị treo (không có hoạt động trong ${this.inactivityTimeoutMs} ms).`,
            );
          }, this.inactivityTimeoutMs);
        };

        const markActivity = () => {
          if (!hasActivity) {
            hasActivity = true;
            if (startupTimer) {
              clearTimeout(startupTimer);
              startupTimer = null;
            }
          }
          armInactivityTimer();
        };

        startupTimer = setTimeout(() => {
          if (!hasActivity) {
            triggerTimeout(
              'startup-timeout',
              `${step.executableName} không phản hồi trong thời gian khởi động (${this.startupTimeoutMs} ms).`,
            );
          }
        }, this.startupTimeoutMs);

        child.on('spawn', () => {
          armInactivityTimer();
        });

        const maybeEmitProgress = () => {
          const now = Date.now();
          if (now - lastEmitMs >= throttleMs()) {
            lastEmitMs = now;
            this.emitJobProgress(entry.record);
          }
        };

        child.stdout?.on('data', (chunk: Buffer) => {
          markActivity();
          if (step.codecId === 'ffmpeg') {
            stdoutBuf += chunk.toString('utf8');
            const lines = stdoutBuf.split(/\r?\n/);
            stdoutBuf = lines.pop() ?? '';
            let updated = false;
            for (const line of lines) {
              if (line.startsWith('out_time_us=')) {
                const us = Number(line.slice('out_time_us='.length));
                if (Number.isFinite(us) && entry.durationMs && entry.durationMs > 0) {
                  const pct = Math.min(99, Math.max(0, Math.round((us / 1000 / entry.durationMs) * 100)));
                  entry.record.progressMode = 'determinate';
                  entry.record.progressPercent = pct;
                  updated = true;
                }
              } else if (line.startsWith('speed=')) {
                entry.record.speedLabel = line.slice('speed='.length).trim();
                updated = true;
              }
            }
            if (updated) {
              maybeEmitProgress();
            }
          }
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          markActivity();
          const text = chunk.toString('utf8');
          if (stderrLog.length < 4096) {
            stderrLog += text;
          }
          if (step.codecId !== 'ffmpeg' && this.parseNativeProgressFromStderr(entry, text)) {
            maybeEmitProgress();
          }
        });

        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimers();
          reject(err);
        });

        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimers();
          if (entry.canceled) {
            resolve();
            return;
          }
          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                `${step.executableName} kết thúc với mã lỗi ${String(code)}${stderrLog.trim() ? `: ${stderrLog.trim().slice(0, 260)}` : ''}`,
              ),
            );
          }
        });
      });
      return;
    }

    // Two-stage piped native encoding: step[0] stdout -> step[1] stdin
    const [decoderStep, encoderStep] = steps;
    await new Promise<void>((resolve, reject) => {
      const decChild = this.processAdapter.spawn(decoderStep.executablePath, decoderStep.args, {
        windowsHide: true,
        detached: useDetachedGroup,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const encChild = this.processAdapter.spawn(encoderStep.executablePath, encoderStep.args, {
        windowsHide: true,
        detached: useDetachedGroup,
        stdio: ['pipe', 'ignore', 'pipe'],
      });

      entry.activeChildren = [decChild, encChild];

      let decStderr = '';
      let encStderr = '';
      let settled = false;
      let decDone = false;
      let encDone = false;
      let decCode: number | null = null;
      let encCode: number | null = null;
      let hasActivity = false;
      let lastEmitMs = 0;

      let startupTimer: ReturnType<typeof setTimeout> | null = null;
      let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

      const clearTimers = () => {
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
        if (inactivityTimer) {
          clearTimeout(inactivityTimer);
          inactivityTimer = null;
        }
      };

      const failOnce = (err: Error, reason?: ProcessTerminationReason) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (reason) {
          entry.terminationReason = reason;
        }
        void Promise.all([
          terminateProcessTree(decChild, {
            platform: this.platform,
            graceMs: this.processKillGraceMs,
          }),
          terminateProcessTree(encChild, {
            platform: this.platform,
            graceMs: this.processKillGraceMs,
          }),
        ]).finally(() => {
          reject(err);
        });
      };

      const armInactivityTimer = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          failOnce(
            new Error(
              `Pipeline ${decoderStep.executableName} → ${encoderStep.executableName} bị treo (không có luồng dữ liệu trong ${this.inactivityTimeoutMs} ms).`,
            ),
            'inactivity-timeout',
          );
        }, this.inactivityTimeoutMs);
      };

      const markActivity = () => {
        if (!hasActivity) {
          hasActivity = true;
          if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimer = null;
          }
        }
        armInactivityTimer();
      };

      startupTimer = setTimeout(() => {
        if (!hasActivity) {
          failOnce(
            new Error(
              `Pipeline ${decoderStep.executableName} → ${encoderStep.executableName} không có dữ liệu trong thời gian khởi động (${this.startupTimeoutMs} ms).`,
            ),
            'startup-timeout',
          );
        }
      }, this.startupTimeoutMs);

      const checkFinished = () => {
        if (settled || !decDone || !encDone) return;
        settled = true;
        clearTimers();
        if (entry.canceled) {
          resolve();
          return;
        }
        if (decCode === 0 && encCode === 0) {
          resolve();
        } else {
          const detail = [decStderr.trim(), encStderr.trim()].filter(Boolean).join(' | ');
          reject(
            new Error(
              `Lỗi pipe ${decoderStep.executableName}(${String(decCode)}) → ${encoderStep.executableName}(${String(encCode)})${detail ? `: ${detail.slice(0, 260)}` : ''}`,
            ),
          );
        }
      };

      decChild.stderr?.on('data', (chunk: Buffer) => {
        markActivity();
        if (decStderr.length < 2048) decStderr += chunk.toString('utf8');
      });

      encChild.stderr?.on('data', (chunk: Buffer) => {
        markActivity();
        const text = chunk.toString('utf8');
        if (encStderr.length < 2048) encStderr += text;
        if (this.parseNativeProgressFromStderr(entry, text)) {
          const now = Date.now();
          if (now - lastEmitMs >= throttleMs()) {
            lastEmitMs = now;
            this.emitJobProgress(entry.record);
          }
        }
      });

      if (decChild.stdout && encChild.stdin) {
        decChild.stdout.on('data', () => {
          markActivity();
        });
        decChild.stdout.on('error', () => {
          try {
            encChild.stdin?.end();
          } catch {
            // ignore
          }
        });
        decChild.stdout.pipe(encChild.stdin);
        encChild.stdin.on('error', () => {
          // Unpipe immediately on early encoder exit/EPIPE to prevent decoder stall or uncaught stream error
          try {
            decChild.stdout?.unpipe(encChild.stdin!);
          } catch {
            // ignore
          }
        });
      }

      decChild.on('error', (err) => failOnce(err));
      encChild.on('error', (err) => failOnce(err));

      decChild.on('close', (code) => {
        decDone = true;
        decCode = code;
        if (code !== 0 && !encDone && !entry.canceled) {
          try {
            decChild.stdout?.unpipe(encChild.stdin!);
            encChild.stdin?.destroy();
          } catch {
            // ignore
          }
          void terminateProcessTree(encChild, {
            platform: this.platform,
            graceMs: this.processKillGraceMs,
          });
        }
        checkFinished();
      });
      encChild.on('close', (code) => {
        encDone = true;
        encCode = code;
        try {
          if (encChild.stdin) {
            decChild.stdout?.unpipe(encChild.stdin);
          }
        } catch {
          // ignore
        }
        // If encoder exited prematurely while decoder is still running, stop decoder cleanly
        if (!decDone && code !== 0 && !entry.canceled) {
          void terminateProcessTree(decChild, {
            platform: this.platform,
            graceMs: this.processKillGraceMs,
          });
        }
        checkFinished();
      });
    });
  }

  /**
   * Future-ready Server Transcoding planner: returns executable plans for every streaming profile.
   */
  async getStreamingTranscodingPlans(sampleSourcePath: string): Promise<StreamingTranscodePlan[]> {
    const readySet = await this.codecManager.getReadyCodecSet();
    const ffmpegCaps = readySet.has('ffmpeg') ? await this.ffmpegCapabilities.detect(false) : null;
    const limits = this.resourcePolicy.getEffectiveLimits();
    return SERVER_TRANSCODING_PROFILES.map((profile) =>
      buildStreamingTranscodePlan(sampleSourcePath, profile, readySet, {
        ffmpegCapabilities: ffmpegCaps,
        maxThreads: limits.encoderThreads,
      }),
    );
  }
}
