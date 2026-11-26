import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { Readable } from 'node:stream';

const FLAC_MAGIC = Buffer.from('fLaC', 'ascii');
const MAX_FLAC_METADATA_BLOCKS = 128;
const MAX_NORMALIZED_HEADER_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_CACHE_ENTRIES = 64;
const MAX_ID3_PADDING_SCAN_BYTES = 4096;

const CHROMIUM_SAFE_PICTURE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

interface ParsedFlacBlock {
  type: number;
  length: number;
  bodyDiskOffset: number;
  omitFromPlaybackStream: boolean;
}

export type FlacStreamPlan =
  | {
      normalized: false;
      virtualFileSize: number;
    }
  | {
      normalized: true;
      headerBuffer: Buffer;
      diskAudioOffset: number;
      virtualFileSize: number;
      strippedId3Header: boolean;
      strippedPictureBlocks: number;
    };

const headerPlanCache = new Map<string, FlacStreamPlan>();

function buildCacheKey(filePath: string, fileSize: number, mtimeMs: number): string {
  return `${filePath}::${fileSize}::${Math.round(mtimeMs)}`;
}

function getCachedPlan(key: string): FlacStreamPlan | undefined {
  const existing = headerPlanCache.get(key);
  if (!existing) {
    return undefined;
  }
  // Refresh insertion order for simple bounded LRU behavior
  headerPlanCache.delete(key);
  headerPlanCache.set(key, existing);
  return existing;
}

function setCachedPlan(key: string, plan: FlacStreamPlan): void {
  if (headerPlanCache.has(key)) {
    headerPlanCache.delete(key);
  }
  headerPlanCache.set(key, plan);
  if (headerPlanCache.size > MAX_HEADER_CACHE_ENTRIES) {
    const oldestKey = headerPlanCache.keys().next().value;
    if (oldestKey !== undefined) {
      headerPlanCache.delete(oldestKey);
    }
  }
}

export function clearFlacSanitizerCache(): void {
  headerPlanCache.clear();
}

async function readExactAt(
  handle: fsPromises.FileHandle,
  offset: number,
  length: number,
): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(length);
  let totalRead = 0;
  while (totalRead < length) {
    const { bytesRead } = await handle.read(buf, totalRead, length - totalRead, offset + totalRead);
    if (bytesRead <= 0) {
      return buf.subarray(0, totalRead);
    }
    totalRead += bytesRead;
  }
  return buf;
}

async function findFlacStreamOffset(
  handle: fsPromises.FileHandle,
  fileSize: number,
): Promise<{ flacOffset: number; hasPrependedId3: boolean } | null> {
  if (fileSize < 42) {
    return null;
  }

  const head = await readExactAt(handle, 0, 10);
  if (head.length < 10) {
    return null;
  }

  if (head.subarray(0, 4).equals(FLAC_MAGIC)) {
    return { flacOffset: 0, hasPrependedId3: false };
  }

  // Some taggers prepend an ID3v2 header before `fLaC`, which can break strict demuxers.
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    const majorVer = head[3];
    const minorVer = head[4];
    const flags = head[5];
    const s0 = head[6];
    const s1 = head[7];
    const s2 = head[8];
    const s3 = head[9];

    if (majorVer <= 4 && minorVer < 0xff && (s0 | s1 | s2 | s3) < 0x80) {
      const id3BodySize = (s0 << 21) | (s1 << 14) | (s2 << 7) | s3;
      const footerBytes = (flags & 0x10) !== 0 ? 10 : 0;
      const id3End = 10 + id3BodySize + footerBytes;

      if (id3End + 42 <= fileSize) {
        const scanLen = Math.min(MAX_ID3_PADDING_SCAN_BYTES, fileSize - id3End);
        const probeBuf = await readExactAt(handle, id3End, scanLen);
        const relIndex = probeBuf.indexOf(FLAC_MAGIC);
        if (relIndex >= 0) {
          const candidateOffset = id3End + relIndex;
          if (candidateOffset + 42 <= fileSize) {
            const siHeader = await readExactAt(handle, candidateOffset + 4, 4);
            if (siHeader.length === 4) {
              const blockType = siHeader[0] & 0x7f;
              const blockLen = (siHeader[1] << 16) | (siHeader[2] << 8) | siHeader[3];
              if (blockType === 0 && blockLen === 34) {
                return { flacOffset: candidateOffset, hasPrependedId3: true };
              }
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * Validates whether a FLAC METADATA_BLOCK_PICTURE block (`type === 6`) has a valid,
 * Chromium FFmpegDemuxer-compatible MIME string and internal byte boundaries.
 * Real-world FLAC releases (such as `libFLAC 1.3.3` rips with `mimeLen = 0`) can leave
 * the picture MIME field empty, causing Chromium's FFmpegDemuxer to abort with
 * `DEMUXER_ERROR_COULD_NOT_OPEN` even though all lossless FLAC audio frames are valid.
 */
async function isPictureBlockDemuxerSafe(
  handle: fsPromises.FileHandle,
  bodyOffset: number,
  blockLength: number,
): Promise<boolean> {
  if (blockLength < 32) {
    return false;
  }

  // Read MIME length first
  const headerSlice = await readExactAt(handle, bodyOffset, Math.min(blockLength, 128));
  if (headerSlice.length < 32) {
    return false;
  }

  const mimeLength = headerSlice.readUInt32BE(4);
  if (mimeLength === 0 || mimeLength > 96 || 8 + mimeLength + 24 > blockLength) {
    return false;
  }

  const mimeString = headerSlice
    .subarray(8, 8 + mimeLength)
    .toString('latin1')
    .trim()
    .toLowerCase();

  if (!CHROMIUM_SAFE_PICTURE_MIMES.has(mimeString)) {
    return false;
  }

  // Ensure description + dimensions + picture payload length fit strictly inside blockLength
  const descOffset = 8 + mimeLength;
  const descSlice =
    descOffset + 4 <= headerSlice.length
      ? headerSlice
      : await readExactAt(handle, bodyOffset + descOffset, 4);
  if (descSlice.length < 4) {
    return false;
  }

  const descLength =
    descOffset + 4 <= headerSlice.length
      ? headerSlice.readUInt32BE(descOffset)
      : descSlice.readUInt32BE(0);
  const dataLenOffset = descOffset + 4 + descLength + 16;
  if (dataLenOffset + 4 > blockLength) {
    return false;
  }

  const dataLenBuf = await readExactAt(handle, bodyOffset + dataLenOffset, 4);
  if (dataLenBuf.length < 4) {
    return false;
  }

  const pictureDataLen = dataLenBuf.readUInt32BE(0);
  if (pictureDataLen === 0 || dataLenOffset + 4 + pictureDataLen > blockLength) {
    return false;
  }

  return true;
}

/**
 * Inspects a FLAC file header (read-only) and produces a virtual sanitized header
 * plan ONLY when container metadata contains known Chromium FFmpegDemuxer breakers
 * (empty/unsupported PICTURE MIME blocks or prepended ID3v2 tags).
 *
 * Guarantees:
 * - Source file on disk is NEVER modified.
 * - Healthy FLAC files return `{ normalized: false }` for zero-copy raw file streaming.
 * - All lossless audio frames (`STREAMINFO`, `SEEKTABLE`, `VORBIS_COMMENT`, and every frame
 *   from `diskAudioOffset` to EOF) remain 100% bit-for-bit untouched.
 */
export async function resolveFlacStreamPlan(
  filePath: string,
  fileSize: number,
  mtimeMs: number,
): Promise<FlacStreamPlan> {
  const cacheKey = buildCacheKey(filePath, fileSize, mtimeMs);
  const cached = getCachedPlan(cacheKey);
  if (cached) {
    return cached;
  }

  const passthrough: FlacStreamPlan = {
    normalized: false,
    virtualFileSize: fileSize,
  };

  let handle: fsPromises.FileHandle | null = null;
  try {
    handle = await fsPromises.open(filePath, 'r');
    const located = await findFlacStreamOffset(handle, fileSize);
    if (!located) {
      setCachedPlan(cacheKey, passthrough);
      return passthrough;
    }

    const { flacOffset, hasPrependedId3 } = located;
    let pos = flacOffset + 4;
    let isLast = false;
    const blocks: ParsedFlacBlock[] = [];
    let strippedPictureBlocks = 0;

    while (!isLast && blocks.length < MAX_FLAC_METADATA_BLOCKS) {
      if (pos + 4 > fileSize) {
        setCachedPlan(cacheKey, passthrough);
        return passthrough;
      }

      const hdr = await readExactAt(handle, pos, 4);
      if (hdr.length < 4) {
        setCachedPlan(cacheKey, passthrough);
        return passthrough;
      }

      isLast = (hdr[0] & 0x80) !== 0;
      const blockType = hdr[0] & 0x7f;
      const blockLength = (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
      const bodyDiskOffset = pos + 4;

      if (bodyDiskOffset + blockLength > fileSize) {
        setCachedPlan(cacheKey, passthrough);
        return passthrough;
      }

      // FLAC spec requires first metadata block to be STREAMINFO (type 0, length 34)
      if (blocks.length === 0 && (blockType !== 0 || blockLength !== 34)) {
        setCachedPlan(cacheKey, passthrough);
        return passthrough;
      }

      let omitFromPlaybackStream = false;
      if (blockType === 6) {
        const pictureSafe = await isPictureBlockDemuxerSafe(
          handle,
          bodyDiskOffset,
          blockLength,
        );
        if (!pictureSafe) {
          omitFromPlaybackStream = true;
          strippedPictureBlocks += 1;
        }
      }

      blocks.push({
        type: blockType,
        length: blockLength,
        bodyDiskOffset,
        omitFromPlaybackStream,
      });

      pos = bodyDiskOffset + blockLength;
    }

    if (!isLast || blocks.length === 0) {
      setCachedPlan(cacheKey, passthrough);
      return passthrough;
    }

    if (!hasPrependedId3 && strippedPictureBlocks === 0) {
      setCachedPlan(cacheKey, passthrough);
      return passthrough;
    }

    const keptBlocks = blocks.filter((b) => !b.omitFromPlaybackStream);
    if (keptBlocks.length === 0 || keptBlocks[0].type !== 0) {
      setCachedPlan(cacheKey, passthrough);
      return passthrough;
    }

    const normalizedHeaderBytes =
      4 + keptBlocks.reduce((sum, block) => sum + 4 + block.length, 0);
    if (normalizedHeaderBytes > MAX_NORMALIZED_HEADER_BYTES) {
      setCachedPlan(cacheKey, passthrough);
      return passthrough;
    }

    const headerParts: Buffer[] = [FLAC_MAGIC];
    for (let i = 0; i < keptBlocks.length; i += 1) {
      const block = keptBlocks[i];
      const blockHdr = Buffer.allocUnsafe(4);
      const isFinalKept = i === keptBlocks.length - 1;
      blockHdr[0] = (isFinalKept ? 0x80 : 0x00) | (block.type & 0x7f);
      blockHdr[1] = (block.length >> 16) & 0xff;
      blockHdr[2] = (block.length >> 8) & 0xff;
      blockHdr[3] = block.length & 0xff;
      headerParts.push(blockHdr);

      if (block.length > 0) {
        const bodyBuf = await readExactAt(handle, block.bodyDiskOffset, block.length);
        if (bodyBuf.length !== block.length) {
          setCachedPlan(cacheKey, passthrough);
          return passthrough;
        }
        headerParts.push(bodyBuf);
      }
    }

    const headerBuffer = Buffer.concat(headerParts);
    const diskAudioOffset = pos;
    const audioPayloadBytes = Math.max(0, fileSize - diskAudioOffset);

    const plan: FlacStreamPlan = {
      normalized: true,
      headerBuffer,
      diskAudioOffset,
      virtualFileSize: headerBuffer.length + audioPayloadBytes,
      strippedId3Header: hasPrependedId3,
      strippedPictureBlocks,
    };

    setCachedPlan(cacheKey, plan);
    return plan;
  } catch {
    return passthrough;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

async function* iterateVirtualFlacRange(
  headerSlice: Buffer,
  filePath: string,
  diskStart: number,
  diskEnd: number,
): AsyncGenerator<Uint8Array, void, void> {
  if (headerSlice.byteLength > 0) {
    yield new Uint8Array(headerSlice);
  }
  const fileStream = fs.createReadStream(filePath, { start: diskStart, end: diskEnd });
  try {
    for await (const chunk of fileStream) {
      yield chunk as Uint8Array;
    }
  } finally {
    fileStream.destroy();
  }
}

/**
 * Streams any valid byte range `[start, end]` of a normalized FLAC virtual view
 * without touching audio frames or buffering the file in memory.
 */
export function createNormalizedFlacByteStream(
  filePath: string,
  plan: Extract<FlacStreamPlan, { normalized: true }>,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  const headerLen = plan.headerBuffer.length;

  // Entirely within normalized metadata header
  if (end < headerLen) {
    const slice = Buffer.from(plan.headerBuffer.subarray(start, end + 1));
    return Readable.toWeb(Readable.from([slice])) as ReadableStream<Uint8Array>;
  }

  // Entirely within raw audio payload on disk (direct pass-through with offset translation)
  if (start >= headerLen) {
    const diskStart = plan.diskAudioOffset + (start - headerLen);
    const diskEnd = plan.diskAudioOffset + (end - headerLen);
    const nodeStream = fs.createReadStream(filePath, { start: diskStart, end: diskEnd });
    return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  }

  // Spans header boundary into raw disk audio frames
  const headerSlice = Buffer.from(plan.headerBuffer.subarray(start, headerLen));
  const diskStart = plan.diskAudioOffset;
  const diskEnd = plan.diskAudioOffset + (end - headerLen);
  const nodeStream = Readable.from(
    iterateVirtualFlacRange(headerSlice, filePath, diskStart, diskEnd),
  );
  return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
}
