import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type { FfmpegCapabilities } from '../../../shared/types/codec-engine';
import type { CodecManager } from './codec-manager';

const DEFAULT_CAPABILITY_TIMEOUT_MS = 5000;
const MAX_CAPABILITY_OUTPUT_BYTES = 512 * 1024;
const MAX_CAPABILITY_CACHE_ENTRIES = 8;

interface CachedFfmpegCapabilities {
  signature: string;
  capabilities: FfmpegCapabilities;
}

/**
 * Parses `ffmpeg -hide_banner -encoders` stdout into a sorted deduplicated list of encoder names.
 */
export function parseFfmpegEncodersOutput(raw: string): string[] {
  const encoders = new Set<string>();
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    // Format: " A....D flac                 FLAC (Free Lossless Audio Codec)"
    const match = /^\s*[VASFXBD.]{6}\s+([a-zA-Z0-9_+-]+)\s+/.exec(line);
    if (match && match[1] && match[1] !== '=') {
      encoders.add(match[1].toLowerCase());
    }
  }
  return Array.from(encoders).sort();
}

/**
 * Parses `ffmpeg -hide_banner -decoders` stdout into a sorted deduplicated list of decoder names.
 */
export function parseFfmpegDecodersOutput(raw: string): string[] {
  const decoders = new Set<string>();
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*[VASFXBD.]{6}\s+([a-zA-Z0-9_+-]+)\s+/.exec(line);
    if (match && match[1] && match[1] !== '=') {
      decoders.add(match[1].toLowerCase());
    }
  }
  return Array.from(decoders).sort();
}

/**
 * Parses `ffmpeg -hide_banner -formats` stdout into a sorted deduplicated list of format/muxer names.
 */
export function parseFfmpegFormatsOutput(raw: string): string[] {
  const formats = new Set<string>();
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    // Format: " DE flac            raw FLAC"
    const match = /^\s*(?:D\s|E\s|\sE|DE)\s+([a-zA-Z0-9_,+-]+)\s+/.exec(line);
    if (match && match[1]) {
      for (const token of match[1].split(',')) {
        const trimmed = token.trim().toLowerCase();
        if (trimmed && trimmed !== '--') {
          formats.add(trimmed);
        }
      }
    }
  }
  return Array.from(formats).sort();
}

/**
 * Parses `ffmpeg -hide_banner -sample_fmts` stdout into a sorted list of sample format names.
 */
export function parseFfmpegSampleFormatsOutput(raw: string): string[] {
  const sampleFormats = new Set<string>();
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    // Format: "s16          16" or "fltp         32"
    const match = /^\s*([a-z0-9]+)\s+(\d+)\s*$/.exec(line);
    if (match && match[1] && match[1].toLowerCase() !== 'name') {
      sampleFormats.add(match[1].toLowerCase());
    }
  }
  return Array.from(sampleFormats).sort();
}

async function runBoundedFfmpegQuery(
  executablePath: string,
  args: string[],
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    let child: ReturnType<typeof spawn>;

    try {
      child = spawn(executablePath, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
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
      if (stdout.length < MAX_CAPABILITY_OUTPUT_BYTES) {
        const remaining = MAX_CAPABILITY_OUTPUT_BYTES - stdout.length;
        stdout += chunk.toString('utf8', 0, Math.min(chunk.length, remaining));
      }
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
        if (code !== 0) {
          resolve(null);
          return;
        }
        resolve(stdout);
      }
    });
  });
}

/**
 * Lazy, trust-gated, stat-cached FFmpeg Capability Detector.
 * - Never executes FFmpeg unless `CodecManager.resolveCodec('ffmpeg')` reports `status === 'ready'`.
 * - Caches capabilities by `(canonicalPath, size, mtimeMs, ino)` so repeated jobs do not re-spawn `ffmpeg`.
 * - Never runs automatically at application startup.
 */
export class FfmpegCapabilityDetector {
  private readonly cache = new Map<string, CachedFfmpegCapabilities>();
  private readonly inFlight = new Map<string, Promise<FfmpegCapabilities | null>>();
  private readonly timeoutMs: number;

  constructor(
    private readonly codecManager: CodecManager,
    options?: { timeoutMs?: number },
  ) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_CAPABILITY_TIMEOUT_MS;
  }

  clearCache(): void {
    this.cache.clear();
  }

  async detect(forceRefresh = false): Promise<FfmpegCapabilities | null> {
    const entry = await this.codecManager.resolveCodec('ffmpeg', false);
    if (entry.status !== 'ready' || !entry.executablePath || entry.sourceTier === 'builtin') {
      return null;
    }

    const execPath = entry.executablePath;
    let canonicalPath = execPath;
    let statSignature: string;
    try {
      canonicalPath = await fs.realpath(execPath);
      const st = await fs.stat(canonicalPath);
      statSignature = `${canonicalPath}|${st.size}|${Math.trunc(st.mtimeMs)}|${st.ino}`;
    } catch {
      return null;
    }

    if (!forceRefresh) {
      const cached = this.cache.get(canonicalPath);
      if (cached && cached.signature === statSignature) {
        return cached.capabilities;
      }
      const pending = this.inFlight.get(statSignature);
      if (pending) {
        return pending;
      }
    }

    const task = (async (): Promise<FfmpegCapabilities | null> => {
      this.codecManager.markCodecInUse('ffmpeg');
      try {
        // Sequential queries respect low-CPU / Power Saving friendliness (never spawn 4 processes at once)
        const encodersRaw = await runBoundedFfmpegQuery(
          canonicalPath,
          ['-hide_banner', '-encoders'],
          this.timeoutMs,
        );
        if (encodersRaw === null) {
          return null;
        }

        const decodersRaw = await runBoundedFfmpegQuery(
          canonicalPath,
          ['-hide_banner', '-decoders'],
          this.timeoutMs,
        );
        const formatsRaw = await runBoundedFfmpegQuery(
          canonicalPath,
          ['-hide_banner', '-formats'],
          this.timeoutMs,
        );
        const sampleFmtsRaw = await runBoundedFfmpegQuery(
          canonicalPath,
          ['-hide_banner', '-sample_fmts'],
          this.timeoutMs,
        );

        const capabilities: FfmpegCapabilities = {
          executablePath: canonicalPath,
          detectedAt: new Date().toISOString(),
          encoders: parseFfmpegEncodersOutput(encodersRaw),
          decoders: decodersRaw ? parseFfmpegDecodersOutput(decodersRaw) : [],
          formats: formatsRaw ? parseFfmpegFormatsOutput(formatsRaw) : [],
          sampleFormats: sampleFmtsRaw ? parseFfmpegSampleFormatsOutput(sampleFmtsRaw) : [],
        };

        if (this.cache.size >= MAX_CAPABILITY_CACHE_ENTRIES) {
          const oldestKey = this.cache.keys().next().value;
          if (oldestKey) {
            this.cache.delete(oldestKey);
          }
        }
        this.cache.set(canonicalPath, {
          signature: statSignature,
          capabilities,
        });

        return capabilities;
      } finally {
        this.codecManager.releaseCodecInUse('ffmpeg');
      }
    })();

    this.inFlight.set(statSignature, task);
    try {
      return await task;
    } finally {
      if (this.inFlight.get(statSignature) === task) {
        this.inFlight.delete(statSignature);
      }
    }
  }
}
