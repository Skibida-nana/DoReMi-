import fsPromises from 'node:fs/promises';
import { closeTrack, decodeTrack, openTrack, type Track as AlacTrack } from '@mgz-dev/alac';
import { parseByteRangeHeader } from './audio-stream-handler';

export const MAX_ALAC_FILE_BYTES = 256 * 1024 * 1024; // 256 MB safety cap
const MAX_MOOV_SCAN_BYTES = 16 * 1024 * 1024; // 16 MB metadata box scan cap
const MAX_OPEN_ALAC_TRACKS = 2; // Bounded LRU cache (current + previous/next)
const IDLE_EVICTION_MS = 30_000; // 30s idle cleanup
export const WAV_HEADER_BYTES = 44;
const STREAM_CHUNK_SAMPLES = 16_384; // ~0.37s @ 44.1kHz (~64KB-96KB per pull)

export interface Mp4AudioCodecProbe {
  codec: 'alac' | 'aac' | 'unknown';
  sampleRateHz: number | null;
  bitDepth: number | null;
  channels: number | null;
}

const UNKNOWN_PROBE: Mp4AudioCodecProbe = {
  codec: 'unknown',
  sampleRateHz: null,
  bitDepth: null,
  channels: null,
};

export function readUint64Safe(buf: Buffer, offset: number): number {
  const high = buf.readUInt32BE(offset);
  const low = buf.readUInt32BE(offset + 4);
  return high * 0x1_0000_0000 + low;
}

const VALID_ALAC_BIT_DEPTHS = new Set([8, 16, 20, 24, 32]);

function parseAlacSpecificConfigFromSampleEntry(entryBuf: Buffer): Mp4AudioCodecProbe {
  // AudioSampleEntry header is 8 (box header) + 28 (version 0) bytes; QuickTime v1/v2 can be longer.
  // Scan inside the sample entry for the child 'alac' box containing the 24-byte ALACSpecificConfig.
  let offset = 36;
  const maxOffset = entryBuf.length - 8;

  // Handle QuickTime SoundDescription v1 (+16 bytes) or v2 (+36 bytes) gracefully by searching
  // both from offset 36 and scanning forward for valid child boxes.
  if (entryBuf.length >= 18) {
    const version = entryBuf.readUInt16BE(16);
    if (version === 1 && entryBuf.length >= 52) {
      offset = 52;
    } else if (version === 2 && entryBuf.length >= 72) {
      offset = 72;
    }
  }

  const scanRange = (startOffset: number): Mp4AudioCodecProbe | null => {
    let pos = startOffset;
    while (pos + 8 <= entryBuf.length) {
      const boxSize = entryBuf.readUInt32BE(pos);
      if (boxSize < 8 || pos + boxSize > entryBuf.length) {
        break;
      }
      const boxType = entryBuf.toString('ascii', pos + 4, pos + 8);
      if (boxType === 'alac' && boxSize >= 36) {
        // 8 bytes box header + 4 bytes version/flags + 24 bytes ALACSpecificConfig
        const cfg = pos + 12;
        if (cfg + 24 > pos + boxSize) {
          return null;
        }
        const frameLength = entryBuf.readUInt32BE(cfg);
        const bitDepth = entryBuf.readUInt8(cfg + 5);
        const channels = entryBuf.readUInt8(cfg + 9);
        const sampleRateHz = entryBuf.readUInt32BE(cfg + 20);
        // Reject clearly corrupted ALACSpecificConfig structs (frameLength === 0, invalid bitDepth/channels/rate)
        const configValid = frameLength > 0 && frameLength <= 65_536;
        return {
          codec: 'alac',
          sampleRateHz:
            configValid && Number.isInteger(sampleRateHz) && sampleRateHz > 0 && sampleRateHz <= 768_000
              ? sampleRateHz
              : null,
          bitDepth: configValid && VALID_ALAC_BIT_DEPTHS.has(bitDepth) ? bitDepth : null,
          channels: configValid && channels >= 1 && channels <= 8 ? channels : null,
        };
      }
      pos += boxSize;
    }
    return null;
  };

  const direct = scanRange(offset);
  if (direct) {
    return direct;
  }

  // Fallback scan in case of unusual sample entry padding
  for (let pos = 36; pos <= maxOffset; pos += 1) {
    if (
      entryBuf[pos + 4] === 0x61 && // 'a'
      entryBuf[pos + 5] === 0x6c && // 'l'
      entryBuf[pos + 6] === 0x61 && // 'a'
      entryBuf[pos + 7] === 0x63 // 'c'
    ) {
      const candidate = scanRange(pos);
      if (candidate) {
        return candidate;
      }
    }
  }

  return {
    codec: 'alac',
    sampleRateHz: null,
    bitDepth: null,
    channels: null,
  };
}

function scanStsdBox(stsdBuf: Buffer): Mp4AudioCodecProbe | null {
  // stsd FullBox: 8 (header) + 4 (version/flags) + 4 (entry_count) = 16 bytes
  if (stsdBuf.length < 16) {
    return null;
  }
  const entryCount = stsdBuf.readUInt32BE(12);
  let offset = 16;
  let foundAac = false;

  for (let i = 0; i < entryCount && offset + 8 <= stsdBuf.length; i += 1) {
    const entrySize = stsdBuf.readUInt32BE(offset);
    if (entrySize < 8 || offset + entrySize > stsdBuf.length) {
      break;
    }
    const format = stsdBuf.toString('ascii', offset + 4, offset + 8);
    if (format === 'alac') {
      return parseAlacSpecificConfigFromSampleEntry(stsdBuf.subarray(offset, offset + entrySize));
    }
    if (format === 'mp4a') {
      foundAac = true;
    }
    offset += entrySize;
  }

  if (foundAac) {
    return {
      codec: 'aac',
      sampleRateHz: null,
      bitDepth: null,
      channels: null,
    };
  }
  return null;
}

const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

function readMediaHandlerType(buf: Buffer, start: number, end: number): string | null {
  let offset = start;
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    let headerLen = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = readUint64Safe(buf, offset + 8);
      headerLen = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerLen || offset + size > end) {
      break;
    }
    if (type === 'hdlr' && offset + headerLen + 12 <= offset + size) {
      // FullBox (4 bytes version/flags) + pre_defined (4 bytes) + handler_type (4 ASCII chars)
      return buf.toString('ascii', offset + headerLen + 8, offset + headerLen + 12);
    }
    offset += size;
  }
  return null;
}

export function scanMoovContainer(buf: Buffer, start: number, end: number): Mp4AudioCodecProbe | null {
  let offset = start;
  let firstAudioTrackHit: Mp4AudioCodecProbe | null = null;

  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    let headerLen = 8;

    if (size === 1) {
      if (offset + 16 > end) {
        break;
      }
      size = readUint64Safe(buf, offset + 8);
      headerLen = 16;
    } else if (size === 0) {
      size = end - offset;
    }

    if (size < headerLen || offset + size > end) {
      break;
    }

    if (type === 'mdia') {
      // Strictly skip non-audio tracks (e.g. 'vide' video or attached artwork tracks)
      const handler = readMediaHandlerType(buf, offset + headerLen, offset + size);
      if (handler !== null && handler !== 'soun') {
        offset += size;
        continue;
      }
    }

    if (type === 'stsd') {
      const hit = scanStsdBox(buf.subarray(offset, offset + size));
      if (hit && !firstAudioTrackHit) {
        firstAudioTrackHit = hit;
        if (hit.codec === 'alac') {
          return hit;
        }
      }
    } else if (CONTAINER_BOXES.has(type)) {
      const nested = scanMoovContainer(buf, offset + headerLen, offset + size);
      if (nested) {
        // Respect primary audio track order (`trak` #1 = `0:a:0`) instead of letting a secondary track override
        if (!firstAudioTrackHit) {
          firstAudioTrackHit = nested;
          if (type === 'trak') {
            return nested;
          }
        }
        if (type !== 'moov' && nested.codec === 'alac') {
          return nested;
        }
      }
    }

    offset += size;
  }

  return firstAudioTrackHit;
}

/**
 * Lightweight ISO-BMFF (MP4/M4A) box header scanner that inspects ONLY the `moov`
 * metadata atom (never reading `mdat` audio payloads) to distinguish ALAC vs AAC
 * and read true 32-bit sample rate / bit depth from `ALACSpecificConfig`.
 * 100% read-only and offline.
 */
export async function detectMp4AudioCodec(filePath: string): Promise<Mp4AudioCodecProbe> {
  let handle: fsPromises.FileHandle | null = null;
  try {
    handle = await fsPromises.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 16) {
      return UNKNOWN_PROBE;
    }

    const headerBuf = Buffer.allocUnsafe(16);
    let offset = 0;

    while (offset + 8 <= stat.size) {
      const toRead = Math.min(16, stat.size - offset);
      const { bytesRead } = await handle.read(headerBuf, 0, toRead, offset);
      if (bytesRead < 8) {
        break;
      }

      let boxSize = headerBuf.readUInt32BE(0);
      const boxType = headerBuf.toString('ascii', 4, 8);
      let headerLen = 8;

      if (boxSize === 1) {
        if (bytesRead < 16) {
          break;
        }
        boxSize = readUint64Safe(headerBuf, 8);
        headerLen = 16;
      } else if (boxSize === 0) {
        boxSize = stat.size - offset;
      }

      if (boxSize < headerLen || offset + boxSize > stat.size) {
        break;
      }

      if (boxType === 'moov') {
        if (boxSize > MAX_MOOV_SCAN_BYTES) {
          return UNKNOWN_PROBE;
        }
        const moovBuf = Buffer.allocUnsafe(boxSize);
        let loaded = 0;
        while (loaded < boxSize) {
          const readRes = await handle.read(moovBuf, loaded, boxSize - loaded, offset + loaded);
          if (readRes.bytesRead <= 0) {
            break;
          }
          loaded += readRes.bytesRead;
        }
        if (loaded < headerLen) {
          return UNKNOWN_PROBE;
        }
        return scanMoovContainer(moovBuf, headerLen, loaded) ?? UNKNOWN_PROBE;
      }

      offset += boxSize;
    }

    return UNKNOWN_PROBE;
  } catch {
    return UNKNOWN_PROBE;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Builds a standard 44-byte RIFF/WAVE PCM header (format 1 = linear little-endian signed PCM),
 * matching the native output format of `@mgz-dev/alac` (`s16le` / `s24le` / `s32le`).
 */
export function buildPcmWavHeader(params: {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataSize: number;
}): Uint8Array {
  const { sampleRate, channels, bitsPerSample, dataSize } = params;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const buf = Buffer.alloc(WAV_HEADER_BYTES);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

interface CachedAlacEntry {
  cacheKey: string;
  filePath: string;
  mtimeMs: number;
  fileSize: number;
  track: AlacTrack;
  wavHeader: Uint8Array;
  dataSize: number;
  totalWavBytes: number;
  lastAccessMs: number;
  refCount: number;
  evicted: boolean;
}

/**
 * 100% offline, zero-temp-file ALAC decoder & random-access WAV HTTP stream provider.
 * Uses `@mgz-dev/alac` (MIT Rust->WASM bundled locally) to decode ALAC frames on demand
 * for any HTTP byte range (`200 OK` / `206 Partial Content`), allowing Electron's single
 * `HTMLAudioElement` -> `AudioDspGraph` to play and seek ALAC M4A files natively through EQ.
 */
export class AlacStreamManager {
  private readonly cache = new Map<string, CachedAlacEntry>();
  private readonly maxOpenTracks: number;
  private readonly idleEvictionMs: number;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(options?: { maxOpenTracks?: number; idleEvictionMs?: number }) {
    this.maxOpenTracks = Math.max(1, options?.maxOpenTracks ?? MAX_OPEN_ALAC_TRACKS);
    this.idleEvictionMs = Math.max(1000, options?.idleEvictionMs ?? IDLE_EVICTION_MS);
  }

  private ensureIdleTimer(): void {
    if (this.idleTimer || this.disposed) {
      return;
    }
    const intervalMs = Math.min(10_000, Math.max(1000, Math.floor(this.idleEvictionMs / 2)));
    this.idleTimer = setInterval(() => {
      this.evictIdleEntries();
    }, intervalMs);
    if (typeof this.idleTimer.unref === 'function') {
      this.idleTimer.unref();
    }
  }

  private stopIdleTimerIfEmpty(): void {
    if (this.cache.size === 0 && this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private finalizeEntryClose(entry: CachedAlacEntry): void {
    if (entry.refCount <= 0 && entry.evicted) {
      try {
        closeTrack(entry.track);
      } catch {
        // closeTrack is idempotent; ignore double-close edge cases
      }
    }
  }

  private evictEntry(entry: CachedAlacEntry): void {
    if (this.cache.get(entry.cacheKey) === entry) {
      this.cache.delete(entry.cacheKey);
    }
    entry.evicted = true;
    this.finalizeEntryClose(entry);
    this.stopIdleTimerIfEmpty();
  }

  private evictIdleEntries(nowMs = Date.now()): void {
    for (const entry of [...this.cache.values()]) {
      if (entry.refCount === 0 && nowMs - entry.lastAccessMs >= this.idleEvictionMs) {
        this.evictEntry(entry);
      }
    }
  }

  private enforceCacheCapacity(): void {
    while (this.cache.size > this.maxOpenTracks) {
      let oldest: CachedAlacEntry | null = null;
      for (const entry of this.cache.values()) {
        if (!oldest || entry.lastAccessMs < oldest.lastAccessMs) {
          oldest = entry;
        }
      }
      if (!oldest) {
        break;
      }
      this.evictEntry(oldest);
    }
  }

  getActiveTrackCount(): number {
    return this.cache.size;
  }

  evictTrack(filePath: string): void {
    for (const entry of [...this.cache.values()]) {
      if (entry.filePath === filePath) {
        this.evictEntry(entry);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    for (const entry of [...this.cache.values()]) {
      this.evictEntry(entry);
    }
    this.cache.clear();
  }

  private async openOrGetEntry(filePath: string): Promise<CachedAlacEntry | null> {
    if (this.disposed) {
      return null;
    }

    const stat = await fsPromises.stat(filePath);
    if (!stat.isFile() || stat.size <= 0) {
      return null;
    }
    if (stat.size > MAX_ALAC_FILE_BYTES) {
      throw new Error(
        `File ALAC vượt giới hạn giải mã an toàn (${Math.round(MAX_ALAC_FILE_BYTES / (1024 * 1024))} MB).`,
      );
    }

    const mtimeMs = Math.round(stat.mtimeMs);
    const cacheKey = `${filePath}::${stat.size}::${mtimeMs}`;
    const cached = this.cache.get(cacheKey);
    if (cached && !cached.evicted) {
      cached.lastAccessMs = Date.now();
      return cached;
    }

    // Evict any stale version of the same filePath before opening new bytes
    this.evictTrack(filePath);

    const fileBuffer = await fsPromises.readFile(filePath);
    const bytes = new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength);
    const track = openTrack(bytes);
    if (!track) {
      return null;
    }

    const dataSize = track.samples * track.bytesPerSample;
    const totalWavBytes = WAV_HEADER_BYTES + dataSize;
    if (
      !Number.isFinite(dataSize) ||
      dataSize <= 0 ||
      totalWavBytes > 0xffff_ff00 ||
      track.channels <= 0 ||
      track.sampleRate <= 0 ||
      track.bits <= 0
    ) {
      closeTrack(track);
      return null;
    }

    const wavHeader = buildPcmWavHeader({
      sampleRate: track.sampleRate,
      channels: track.channels,
      bitsPerSample: track.bits,
      dataSize,
    });

    const entry: CachedAlacEntry = {
      cacheKey,
      filePath,
      mtimeMs,
      fileSize: stat.size,
      track,
      wavHeader,
      dataSize,
      totalWavBytes,
      lastAccessMs: Date.now(),
      refCount: 0,
      evicted: false,
    };

    this.cache.set(cacheKey, entry);
    this.enforceCacheCapacity();
    this.ensureIdleTimer();
    return entry;
  }

  /**
   * Resolves a `GET` or `HEAD` media request for an ALAC M4A track into a seekable
   * virtual `audio/wav` HTTP response (`200` / `206` / `416`) without writing temp files.
   * Returns `null` if the file is not an ALAC track (allowing caller to fall back to native streaming).
   */
  async resolveAlacWavResponse(
    request: Request,
    filePath: string,
    corsHeaders: Record<string, string>,
  ): Promise<Response | null> {
    let entry: CachedAlacEntry | null;
    try {
      entry = await this.openOrGetEntry(filePath);
    } catch (error) {
      return new Response(
        error instanceof Error ? error.message : 'Không thể giải mã file ALAC cục bộ.',
        {
          status: 422,
          headers: corsHeaders,
        },
      );
    }

    if (!entry) {
      return null;
    }

    const rangeResult = parseByteRangeHeader(request.headers.get('range'), entry.totalWavBytes);
    if (!rangeResult.ok) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: {
          ...corsHeaders,
          'Content-Range': `bytes */${entry.totalWavBytes}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }

    const { start, end, isPartial } = rangeResult;
    const contentLength = end - start + 1;

    const headers = new Headers({
      ...corsHeaders,
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(contentLength),
      'Cache-Control': 'no-store',
      'X-DoReMi-Decoder': 'alac-wasm-pcm',
    });

    if (isPartial) {
      headers.set('Content-Range', `bytes ${start}-${end}/${entry.totalWavBytes}`);
    }

    if (request.method === 'HEAD') {
      return new Response(null, {
        status: isPartial ? 206 : 200,
        headers,
      });
    }

    const activeEntry = entry;
    activeEntry.refCount += 1;
    let released = false;
    const releaseRef = (): void => {
      if (released) {
        return;
      }
      released = true;
      activeEntry.refCount = Math.max(0, activeEntry.refCount - 1);
      this.finalizeEntryClose(activeEntry);
    };

    let cursor = start;
    const bytesPerSample = activeEntry.track.bytesPerSample;

    const stream = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        try {
          if (cursor > end) {
            releaseRef();
            controller.close();
            return;
          }

          activeEntry.lastAccessMs = Date.now();

          // Phase 1: Virtual 44-byte RIFF/WAVE header slice
          if (cursor < WAV_HEADER_BYTES) {
            const headerEndExclusive = Math.min(WAV_HEADER_BYTES, end + 1);
            const slice = activeEntry.wavHeader.slice(cursor, headerEndExclusive);
            cursor = headerEndExclusive;
            controller.enqueue(slice);
            if (cursor > end) {
              releaseRef();
              controller.close();
            }
            return;
          }

          // Phase 2: Random-access decoded PCM frames sliced to exact byte boundaries
          const pcmByteOffset = cursor - WAV_HEADER_BYTES;
          const remainingBytes = end - cursor + 1;
          const startSample = Math.floor(pcmByteOffset / bytesPerSample);
          const leadingTrimBytes = pcmByteOffset - startSample * bytesPerSample;

          const samplesNeededForRemaining = Math.ceil(
            (leadingTrimBytes + remainingBytes) / bytesPerSample,
          );
          const maxSamplesLeftInTrack = Math.max(0, activeEntry.track.samples - startSample);
          const samplesToDecode = Math.min(
            STREAM_CHUNK_SAMPLES,
            samplesNeededForRemaining,
            maxSamplesLeftInTrack,
          );

          if (samplesToDecode <= 0) {
            releaseRef();
            controller.close();
            return;
          }

          const decoded = decodeTrack(activeEntry.track, startSample, samplesToDecode);
          const availableAfterTrim = Math.max(0, decoded.byteLength - leadingTrimBytes);
          const takeBytes = Math.min(remainingBytes, availableAfterTrim);

          if (takeBytes <= 0) {
            releaseRef();
            controller.close();
            return;
          }

          const chunk = decoded.subarray(leadingTrimBytes, leadingTrimBytes + takeBytes);
          cursor += takeBytes;
          controller.enqueue(chunk);

          if (cursor > end) {
            releaseRef();
            controller.close();
          }
        } catch (err) {
          releaseRef();
          controller.error(err);
        }
      },
      cancel: () => {
        releaseRef();
      },
    });

    return new Response(stream, {
      status: isPartial ? 206 : 200,
      headers,
    });
  }
}

let sharedAlacManager: AlacStreamManager | null = null;

export function getAlacStreamManager(): AlacStreamManager {
  if (!sharedAlacManager) {
    sharedAlacManager = new AlacStreamManager();
  }
  return sharedAlacManager;
}

export function disposeSharedAlacStreamManager(): void {
  if (sharedAlacManager) {
    sharedAlacManager.dispose();
    sharedAlacManager = null;
  }
}
