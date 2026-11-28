import { closeTrack, decodeTrack, openTrack } from '@mgz-dev/alac';
import {
  WAV_HEADER_BYTES,
  buildPcmWavHeader,
  readUint64Safe,
  scanMoovContainer,
  type Mp4AudioCodecProbe,
} from '../alac-decoder';
import { parseByteRangeHeader } from '../audio-stream-handler';

const MAX_MOOV_BYTES = 16 * 1024 * 1024;
const MAX_CACHED_INDEXES = 3;
const MAX_TOTAL_WINDOW_BYTES = 6 * 1024 * 1024; // 6 MB cap across decoded PCM windows
const WINDOW_IDLE_MS = 20_000;
const INDEX_IDLE_MS = 60_000;
const SWEEP_INTERVAL_MS = 10_000;
const INITIAL_PROBE_BYTES = 64 * 1024;
const WINDOW_PACKET_COUNT = 48; // ~4.5s @ 44.1kHz (4096 samples/packet)

export interface RemoteByteFetchResult {
  status: number;
  totalSize: number | null;
  buffer: Buffer;
}

export type RemoteByteRangeFetcher = (
  start: number,
  end: number,
  signal?: AbortSignal,
) => Promise<RemoteByteFetchResult>;

interface PacketLocation {
  offset: number;
  size: number;
  pcmStart: number;
  pcmSamples: number;
}

interface IndexedRemoteAlacTrack {
  cacheKey: string;
  codec: 'alac';
  fileSize: number;
  sampleRateHz: number;
  bitDepth: number;
  channels: number;
  blockAlign: number;
  totalPcmSamples: number;
  dataSize: number;
  totalWavBytes: number;
  wavHeader: Uint8Array;
  stsdBox: Buffer;
  packets: PacketLocation[];
  lastAccessMs: number;
  cachedWindow: {
    startPacket: number;
    endPacket: number;
    pcmStartSample: number;
    pcmBuffer: Buffer;
  } | null;
}

type ProbeEntry =
  | { kind: 'passthrough'; codec: 'aac' | 'unknown'; lastAccessMs: number }
  | IndexedRemoteAlacTrack;

function makeBox(type: string, ...parts: Buffer[]): Buffer {
  const payloadLen = parts.reduce((sum, p) => sum + p.length, 0);
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32BE(8 + payloadLen, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, ...parts]);
}

function makeFullBox(type: string, version: number, flags: number, ...parts: Buffer[]): Buffer {
  const vf = Buffer.allocUnsafe(4);
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0x00ff_ffff), 0);
  return makeBox(type, vf, ...parts);
}

function findChildBox(buf: Buffer, start: number, end: number, targetType: string): Buffer | null {
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
    if (type === targetType) {
      return buf.subarray(offset, offset + size);
    }
    offset += size;
  }
  return null;
}

function findAllChildBoxes(buf: Buffer, start: number, end: number, targetType: string): Buffer[] {
  const results: Buffer[] = [];
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
    if (type === targetType) {
      results.push(buf.subarray(offset, offset + size));
    }
    offset += size;
  }
  return results;
}

function extractBoxHeaderLength(box: Buffer): number {
  const size32 = box.readUInt32BE(0);
  return size32 === 1 ? 16 : 8;
}

interface ParsedStbl {
  stsdBox: Buffer;
  mdhdTimescale: number;
  probe: Mp4AudioCodecProbe;
  packets: PacketLocation[];
  totalPcmSamples: number;
}

function parsePrimaryAlacTrak(moovBox: Buffer): ParsedStbl | null {
  const moovHdrLen = extractBoxHeaderLength(moovBox);
  const traks = findAllChildBoxes(moovBox, moovHdrLen, moovBox.length, 'trak');

  for (const trak of traks) {
    const trakHdr = extractBoxHeaderLength(trak);
    const mdia = findChildBox(trak, trakHdr, trak.length, 'mdia');
    if (!mdia) continue;
    const mdiaHdr = extractBoxHeaderLength(mdia);

    const hdlr = findChildBox(mdia, mdiaHdr, mdia.length, 'hdlr');
    if (hdlr && hdlr.length >= 20) {
      const handlerType = hdlr.toString('ascii', 16, 20);
      if (handlerType !== 'soun') {
        continue;
      }
    }

    let mdhdTimescale = 0;
    const mdhd = findChildBox(mdia, mdiaHdr, mdia.length, 'mdhd');
    if (mdhd && mdhd.length >= 24) {
      const version = mdhd.readUInt8(8);
      if (version === 1 && mdhd.length >= 32) {
        mdhdTimescale = mdhd.readUInt32BE(28);
      } else if (version === 0) {
        mdhdTimescale = mdhd.readUInt32BE(20);
      }
    }

    const minf = findChildBox(mdia, mdiaHdr, mdia.length, 'minf');
    if (!minf) continue;
    const stbl = findChildBox(minf, extractBoxHeaderLength(minf), minf.length, 'stbl');
    if (!stbl) continue;
    const stblHdr = extractBoxHeaderLength(stbl);

    const stsdBox = findChildBox(stbl, stblHdr, stbl.length, 'stsd');
    if (!stsdBox) continue;

    const probe = scanMoovContainer(stbl, stblHdr, stbl.length);
    if (!probe || probe.codec !== 'alac' || !probe.sampleRateHz || !probe.bitDepth || !probe.channels) {
      continue;
    }

    const timescale = mdhdTimescale > 0 ? mdhdTimescale : probe.sampleRateHz;

    // 1. Parse stsz (packet sizes)
    const stsz = findChildBox(stbl, stblHdr, stbl.length, 'stsz');
    if (!stsz || stsz.length < 20) continue;
    const constantSampleSize = stsz.readUInt32BE(12);
    const sampleCount = stsz.readUInt32BE(16);
    if (sampleCount === 0 || sampleCount > 5_000_000) continue;

    const sampleSizes = new Uint32Array(sampleCount);
    if (constantSampleSize > 0) {
      sampleSizes.fill(constantSampleSize);
    } else {
      if (stsz.length < 20 + sampleCount * 4) continue;
      for (let i = 0; i < sampleCount; i += 1) {
        sampleSizes[i] = stsz.readUInt32BE(20 + i * 4);
      }
    }

    // 2. Parse stts (packet sample durations)
    const stts = findChildBox(stbl, stblHdr, stbl.length, 'stts');
    const sttsDurations = new Uint32Array(sampleCount);
    if (stts && stts.length >= 16) {
      const entryCount = stts.readUInt32BE(12);
      let sIdx = 0;
      for (let e = 0; e < entryCount && sIdx < sampleCount && 16 + (e + 1) * 8 <= stts.length; e += 1) {
        const cnt = stts.readUInt32BE(16 + e * 8);
        const dur = stts.readUInt32BE(16 + e * 8 + 4);
        const scaledDur =
          timescale === probe.sampleRateHz
            ? dur
            : Math.max(1, Math.round((dur * probe.sampleRateHz) / timescale));
        for (let k = 0; k < cnt && sIdx < sampleCount; k += 1) {
          sttsDurations[sIdx] = scaledDur;
          sIdx += 1;
        }
      }
      while (sIdx < sampleCount) {
        sttsDurations[sIdx] = 4096;
        sIdx += 1;
      }
    } else {
      sttsDurations.fill(4096);
    }

    // 3. Parse stco / co64 (chunk offsets)
    const stco = findChildBox(stbl, stblHdr, stbl.length, 'stco');
    const co64 = !stco ? findChildBox(stbl, stblHdr, stbl.length, 'co64') : null;
    const chunkOffsets: number[] = [];
    if (stco && stco.length >= 16) {
      const cnt = stco.readUInt32BE(12);
      for (let i = 0; i < cnt && 16 + (i + 1) * 4 <= stco.length; i += 1) {
        chunkOffsets.push(stco.readUInt32BE(16 + i * 4));
      }
    } else if (co64 && co64.length >= 16) {
      const cnt = co64.readUInt32BE(12);
      for (let i = 0; i < cnt && 16 + (i + 1) * 8 <= co64.length; i += 1) {
        chunkOffsets.push(readUint64Safe(co64, 16 + i * 8));
      }
    } else {
      continue;
    }

    // 4. Parse stsc (sample-to-chunk mapping)
    const stsc = findChildBox(stbl, stblHdr, stbl.length, 'stsc');
    if (!stsc || stsc.length < 16) continue;
    const stscEntryCount = stsc.readUInt32BE(12);
    if (stscEntryCount === 0) continue;

    const runs: Array<{ firstChunk: number; samplesPerChunk: number }> = [];
    for (let i = 0; i < stscEntryCount && 16 + (i + 1) * 12 <= stsc.length; i += 1) {
      runs.push({
        firstChunk: stsc.readUInt32BE(16 + i * 12),
        samplesPerChunk: stsc.readUInt32BE(16 + i * 12 + 4),
      });
    }
    if (runs.length === 0) continue;

    const packets: PacketLocation[] = new Array(sampleCount);
    let packetIdx = 0;
    let pcmCursor = 0;
    let runIdx = 0;

    for (let chunkNum = 1; chunkNum <= chunkOffsets.length && packetIdx < sampleCount; chunkNum += 1) {
      while (runIdx + 1 < runs.length && runs[runIdx + 1].firstChunk <= chunkNum) {
        runIdx += 1;
      }
      const spc = runs[runIdx].samplesPerChunk;
      let fileOffset = chunkOffsets[chunkNum - 1];
      for (let j = 0; j < spc && packetIdx < sampleCount; j += 1) {
        const size = sampleSizes[packetIdx];
        const pcmSamples = sttsDurations[packetIdx];
        packets[packetIdx] = {
          offset: fileOffset,
          size,
          pcmStart: pcmCursor,
          pcmSamples,
        };
        fileOffset += size;
        pcmCursor += pcmSamples;
        packetIdx += 1;
      }
    }

    if (packetIdx !== sampleCount) {
      return null;
    }

    return {
      stsdBox: Buffer.from(stsdBox),
      mdhdTimescale: timescale,
      probe,
      packets,
      totalPcmSamples: pcmCursor,
    };
  }

  return null;
}

/**
 * Builds a minimal, self-contained `<512 KB` ISO-BMFF ALAC MP4 container around
 * `[startPacket..endPacket]` with compacted packet payload bytes so `@mgz-dev/alac`
 * decodes ONLY the requested window without buffering the full remote track.
 */
function buildSyntheticWindowMp4(params: {
  stsdBox: Buffer;
  sampleRateHz: number;
  packets: PacketLocation[];
  startPacket: number;
  endPacket: number;
  windowPayload: Buffer;
}): { mp4Bytes: Uint8Array; expectedPcmSamples: number } {
  const { stsdBox, sampleRateHz, packets, startPacket, endPacket, windowPayload } = params;
  const packetCount = endPacket - startPacket + 1;
  const baseFileOffset = packets[startPacket].offset;

  // Compact contiguous payload bytes (handles chunks even if spaced with gaps in original mdat)
  let totalPackedBytes = 0;
  for (let i = startPacket; i <= endPacket; i += 1) {
    totalPackedBytes += packets[i].size;
  }
  const mdatData = Buffer.allocUnsafe(totalPackedBytes);
  let writeCursor = 0;
  let expectedPcmSamples = 0;
  for (let i = startPacket; i <= endPacket; i += 1) {
    const pkt = packets[i];
    const rel = pkt.offset - baseFileOffset;
    windowPayload.copy(mdatData, writeCursor, rel, rel + pkt.size);
    writeCursor += pkt.size;
    expectedPcmSamples += pkt.pcmSamples;
  }

  // ftyp (24 bytes)
  const ftyp = makeBox(
    'ftyp',
    Buffer.from('M4A ', 'ascii'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('M4A mp42isom', 'ascii'),
  );

  // mvhd (version 0: 100 bytes payload)
  const mvhdBody = Buffer.alloc(96);
  mvhdBody.writeUInt32BE(sampleRateHz, 8);
  mvhdBody.writeUInt32BE(expectedPcmSamples, 12);
  mvhdBody.writeUInt32BE(0x0001_0000, 16); // rate = 1.0
  mvhdBody.writeUInt16BE(0x0100, 20); // volume = 1.0
  mvhdBody.writeUInt32BE(0x0001_0000, 32); // identity matrix
  mvhdBody.writeUInt32BE(0x0001_0000, 48);
  mvhdBody.writeUInt32BE(0x4000_0000, 64);
  mvhdBody.writeUInt32BE(2, 92); // next_track_ID
  const mvhd = makeFullBox('mvhd', 0, 0, mvhdBody);

  // tkhd (version 0: 84 bytes payload)
  const tkhdBody = Buffer.alloc(80);
  tkhdBody.writeUInt32BE(1, 8); // track_ID = 1
  tkhdBody.writeUInt32BE(expectedPcmSamples, 16);
  tkhdBody.writeUInt16BE(0x0100, 28); // volume = 1.0
  tkhdBody.writeUInt32BE(0x0001_0000, 32);
  tkhdBody.writeUInt32BE(0x0001_0000, 48);
  tkhdBody.writeUInt32BE(0x4000_0000, 64);
  const tkhd = makeFullBox('tkhd', 0, 3, tkhdBody);

  // mdhd
  const mdhdBody = Buffer.alloc(20);
  mdhdBody.writeUInt32BE(sampleRateHz, 8);
  mdhdBody.writeUInt32BE(expectedPcmSamples, 12);
  mdhdBody.writeUInt16BE(0x55c4, 16); // 'und'
  const mdhd = makeFullBox('mdhd', 0, 0, mdhdBody);

  // hdlr
  const hdlrBody = Buffer.alloc(21);
  hdlrBody.write('soun', 4, 4, 'ascii');
  hdlrBody.write('SoundHandler', 12, 12, 'ascii');
  const hdlr = makeFullBox('hdlr', 0, 0, hdlrBody);

  // smhd + dinf
  const smhd = makeFullBox('smhd', 0, 0, Buffer.alloc(4));
  const urlBox = makeFullBox('url ', 0, 1);
  const drefBody = Buffer.allocUnsafe(4);
  drefBody.writeUInt32BE(1, 0);
  const dref = makeFullBox('dref', 0, 0, drefBody, urlBox);
  const dinf = makeBox('dinf', dref);

  // stts
  const sttsBody = Buffer.allocUnsafe(4 + packetCount * 8);
  sttsBody.writeUInt32BE(packetCount, 0);
  for (let i = 0; i < packetCount; i += 1) {
    sttsBody.writeUInt32BE(1, 4 + i * 8);
    sttsBody.writeUInt32BE(packets[startPacket + i].pcmSamples, 4 + i * 8 + 4);
  }
  const stts = makeFullBox('stts', 0, 0, sttsBody);

  // stsc (1 chunk containing all packetCount samples)
  const stscBody = Buffer.allocUnsafe(16);
  stscBody.writeUInt32BE(1, 0);
  stscBody.writeUInt32BE(1, 4);
  stscBody.writeUInt32BE(packetCount, 8);
  stscBody.writeUInt32BE(1, 12);
  const stsc = makeFullBox('stsc', 0, 0, stscBody);

  // stsz
  const stszBody = Buffer.allocUnsafe(8 + packetCount * 4);
  stszBody.writeUInt32BE(0, 0);
  stszBody.writeUInt32BE(packetCount, 4);
  for (let i = 0; i < packetCount; i += 1) {
    stszBody.writeUInt32BE(packets[startPacket + i].size, 8 + i * 4);
  }
  const stsz = makeFullBox('stsz', 0, 0, stszBody);

  // stco placeholder -> compute moov length, then patch chunk offset to exact start of mdat data
  const stcoPlaceholder = makeFullBox('stco', 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]));
  const stbl = makeBox('stbl', stsdBox, stts, stsc, stsz, stcoPlaceholder);
  const minf = makeBox('minf', smhd, dinf, stbl);
  const mdia = makeBox('mdia', mdhd, hdlr, minf);
  const trak = makeBox('trak', tkhd, mdia);
  const moov = makeBox('moov', mvhd, trak);

  // Patch stco single chunk offset = ftyp.length + moov.length + 8 (mdat header)
  const stcoOffsetInsideMoov = moov.lastIndexOf(Buffer.from('stco', 'ascii'));
  const mdatDataOffset = ftyp.length + moov.length + 8;
  moov.writeUInt32BE(mdatDataOffset, stcoOffsetInsideMoov + 12);

  const mdat = makeBox('mdat', mdatData);
  const full = Buffer.concat([ftyp, moov, mdat]);
  return {
    mp4Bytes: new Uint8Array(full.buffer, full.byteOffset, full.byteLength),
    expectedPcmSamples,
  };
}

/**
 * Range-backed, low-RAM Remote ALAC -> WAV WASM decoder for Electron Main.
 * Downloads ONLY `moov` metadata via TLS Range, then fetches ~200-400KB `mdat` packet
 * windows on demand via authenticated Range requests and decodes them with `@mgz-dev/alac`.
 * Guarantees: zero full-file buffering, instant seeking, 100% original sample rate/bit depth.
 */
export class RemoteAlacStreamManager {
  private readonly cache = new Map<string, ProbeEntry>();
  private readonly inflightProbe = new Map<string, Promise<ProbeEntry>>();
  private readonly inflightWindow = new Map<string, Promise<Buffer>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly windowIdleMs: number;
  private readonly indexIdleMs: number;

  constructor(options?: { windowIdleMs?: number; indexIdleMs?: number }) {
    this.windowIdleMs = Math.max(1_000, options?.windowIdleMs ?? WINDOW_IDLE_MS);
    this.indexIdleMs = Math.max(2_000, options?.indexIdleMs ?? INDEX_IDLE_MS);
  }

  private ensureSweepTimer(): void {
    if (this.sweepTimer || this.cache.size === 0) {
      return;
    }
    const interval = Math.min(
      SWEEP_INTERVAL_MS,
      Math.max(500, Math.floor(this.windowIdleMs / 2)),
    );
    this.sweepTimer = setInterval(() => {
      this.sweepIdleState();
    }, interval);
    this.sweepTimer.unref?.();
  }

  private stopSweepTimerIfEmpty(): void {
    if (this.cache.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  sweepIdleState(now = Date.now()): void {
    for (const [k, entry] of [...this.cache.entries()]) {
      const idleMs = now - entry.lastAccessMs;
      if (idleMs >= this.indexIdleMs) {
        if ('codec' in entry && entry.codec === 'alac') {
          entry.cachedWindow = null;
        }
        this.cache.delete(k);
      } else if ('codec' in entry && entry.codec === 'alac' && entry.cachedWindow && idleMs >= this.windowIdleMs) {
        entry.cachedWindow = null;
      }
    }
    this.stopSweepTimerIfEmpty();
  }

  private enforceWindowByteBudget(preserveKey?: string): void {
    let totalBytes = 0;
    const alacEntries: IndexedRemoteAlacTrack[] = [];
    for (const entry of this.cache.values()) {
      if ('codec' in entry && entry.codec === 'alac' && entry.cachedWindow) {
        totalBytes += entry.cachedWindow.pcmBuffer.length;
        alacEntries.push(entry);
      }
    }
    if (totalBytes <= MAX_TOTAL_WINDOW_BYTES) {
      return;
    }
    alacEntries.sort((a, b) => a.lastAccessMs - b.lastAccessMs);
    for (const entry of alacEntries) {
      if (totalBytes <= MAX_TOTAL_WINDOW_BYTES) break;
      if (entry.cacheKey === preserveKey) continue;
      if (entry.cachedWindow) {
        totalBytes -= entry.cachedWindow.pcmBuffer.length;
        entry.cachedWindow = null;
      }
    }
  }

  getStats(): {
    cachedIndexes: number;
    activeWindows: number;
    windowBytes: number;
    sweepTimerActive: boolean;
  } {
    let activeWindows = 0;
    let windowBytes = 0;
    for (const entry of this.cache.values()) {
      if ('codec' in entry && entry.codec === 'alac' && entry.cachedWindow) {
        activeWindows += 1;
        windowBytes += entry.cachedWindow.pcmBuffer.length;
      }
    }
    return {
      cachedIndexes: this.cache.size,
      activeWindows,
      windowBytes,
      sweepTimerActive: this.sweepTimer !== null,
    };
  }

  clear(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const entry of this.cache.values()) {
      if ('codec' in entry && entry.codec === 'alac') {
        entry.cachedWindow = null;
      }
    }
    this.cache.clear();
    this.inflightProbe.clear();
    this.inflightWindow.clear();
  }

  invalidateForHost(hostId: string): void {
    const prefix = `${hostId.toLowerCase()}::`;
    for (const [k, entry] of this.cache.entries()) {
      if (k.startsWith(prefix)) {
        if ('codec' in entry && entry.codec === 'alac') {
          entry.cachedWindow = null;
        }
        this.cache.delete(k);
      }
    }
    this.stopSweepTimerIfEmpty();
  }

  invalidateTrack(hostId: string, trackId: string): void {
    const prefix = `${hostId.toLowerCase()}::${trackId.toLowerCase()}`;
    for (const [k, entry] of this.cache.entries()) {
      if (k === prefix || k.startsWith(`${prefix}::`)) {
        if ('codec' in entry && entry.codec === 'alac') {
          entry.cachedWindow = null;
        }
        this.cache.delete(k);
      }
    }
    this.stopSweepTimerIfEmpty();
  }

  private evictIfNeeded(): void {
    this.sweepIdleState();
    while (this.cache.size >= MAX_CACHED_INDEXES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      const oldEntry = this.cache.get(oldest);
      if (oldEntry && 'codec' in oldEntry && oldEntry.codec === 'alac') {
        oldEntry.cachedWindow = null;
      }
      this.cache.delete(oldest);
    }
  }

  async resolveEntry(
    cacheKey: string,
    fetcher: RemoteByteRangeFetcher,
    signal?: AbortSignal,
  ): Promise<ProbeEntry> {
    const cached = this.cache.get(cacheKey);
    if (cached) {
      cached.lastAccessMs = Date.now();
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      this.ensureSweepTimer();
      return cached;
    }

    const pending = this.inflightProbe.get(cacheKey);
    if (pending) {
      return pending;
    }

    const work = this.probeAndIndex(cacheKey, fetcher, signal)
      .then((entry) => {
        this.evictIfNeeded();
        this.cache.set(cacheKey, entry);
        this.ensureSweepTimer();
        return entry;
      })
      .finally(() => {
        this.inflightProbe.delete(cacheKey);
      });

    this.inflightProbe.set(cacheKey, work);
    return work;
  }

  private async probeAndIndex(
    cacheKey: string,
    fetcher: RemoteByteRangeFetcher,
    signal?: AbortSignal,
  ): Promise<ProbeEntry> {
    const headResp = await fetcher(0, INITIAL_PROBE_BYTES - 1, signal);
    const headBuf = headResp.buffer;
    const fileSize = headResp.totalSize ?? headBuf.length;

    if (headBuf.length < 16 || fileSize < 16) {
      return { kind: 'passthrough', codec: 'unknown', lastAccessMs: Date.now() };
    }

    // Walk top-level ISO-BMFF boxes jumping directly over mdat if moov is at EOF
    let offset = 0;
    let moovBuf: Buffer | null = null;

    while (offset + 8 <= fileSize) {
      let hdr: Buffer;
      if (offset + 16 <= headBuf.length) {
        hdr = headBuf.subarray(offset, offset + 16);
      } else {
        const hdrResp = await fetcher(offset, Math.min(fileSize - 1, offset + 15), signal);
        hdr = hdrResp.buffer;
      }
      if (hdr.length < 8) {
        break;
      }

      let boxSize = hdr.readUInt32BE(0);
      const boxType = hdr.toString('ascii', 4, 8);
      let headerLen = 8;

      if (boxSize === 1) {
        if (hdr.length < 16) break;
        boxSize = readUint64Safe(hdr, 8);
        headerLen = 16;
      } else if (boxSize === 0) {
        boxSize = fileSize - offset;
      }

      if (boxSize < headerLen || offset + boxSize > fileSize) {
        break;
      }

      if (boxType === 'moov') {
        if (boxSize > MAX_MOOV_BYTES) {
          return { kind: 'passthrough', codec: 'unknown', lastAccessMs: Date.now() };
        }
        if (offset + boxSize <= headBuf.length) {
          moovBuf = headBuf.subarray(offset, offset + boxSize);
        } else {
          const moovResp = await fetcher(offset, offset + boxSize - 1, signal);
          if (moovResp.buffer.length < headerLen) {
            break;
          }
          moovBuf = moovResp.buffer;
        }
        break;
      }

      offset += boxSize;
    }

    if (!moovBuf) {
      return { kind: 'passthrough', codec: 'unknown', lastAccessMs: Date.now() };
    }

    const moovHdr = extractBoxHeaderLength(moovBuf);
    const quickProbe = scanMoovContainer(moovBuf, moovHdr, moovBuf.length);
    if (!quickProbe || quickProbe.codec !== 'alac') {
      return {
        kind: 'passthrough',
        codec: quickProbe?.codec === 'aac' ? 'aac' : 'unknown',
        lastAccessMs: Date.now(),
      };
    }

    const parsed = parsePrimaryAlacTrak(moovBuf);
    if (!parsed || !parsed.probe.sampleRateHz || !parsed.probe.bitDepth || !parsed.probe.channels) {
      return { kind: 'passthrough', codec: 'unknown', lastAccessMs: Date.now() };
    }

    const { sampleRateHz, bitDepth, channels } = parsed.probe;
    const blockAlign = channels * (bitDepth / 8);
    const dataSize = parsed.totalPcmSamples * blockAlign;
    const totalWavBytes = WAV_HEADER_BYTES + dataSize;
    const wavHeader = buildPcmWavHeader({
      sampleRate: sampleRateHz,
      channels,
      bitsPerSample: bitDepth,
      dataSize,
    });

    return {
      cacheKey,
      codec: 'alac',
      fileSize,
      sampleRateHz,
      bitDepth,
      channels,
      blockAlign,
      totalPcmSamples: parsed.totalPcmSamples,
      dataSize,
      totalWavBytes,
      wavHeader,
      stsdBox: parsed.stsdBox,
      packets: parsed.packets,
      lastAccessMs: Date.now(),
      cachedWindow: null,
    };
  }

  private findPacketForSample(packets: PacketLocation[], targetSample: number): number {
    let lo = 0;
    let hi = packets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (packets[mid].pcmStart <= targetSample) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  private async decodePacketWindow(
    entry: IndexedRemoteAlacTrack,
    startPacket: number,
    fetcher: RemoteByteRangeFetcher,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const endPacket = Math.min(entry.packets.length - 1, startPacket + WINDOW_PACKET_COUNT - 1);
    const windowKey = `${entry.cacheKey}::${startPacket}-${endPacket}`;

    if (
      entry.cachedWindow &&
      entry.cachedWindow.startPacket === startPacket &&
      entry.cachedWindow.endPacket === endPacket
    ) {
      return entry.cachedWindow.pcmBuffer;
    }

    const pending = this.inflightWindow.get(windowKey);
    if (pending) {
      return pending;
    }

    const work = (async () => {
      const firstPkt = entry.packets[startPacket];
      const lastPkt = entry.packets[endPacket];
      const rangeStart = firstPkt.offset;
      const rangeEnd = lastPkt.offset + lastPkt.size - 1;

      const resp = await fetcher(rangeStart, rangeEnd, signal);
      const { mp4Bytes, expectedPcmSamples } = buildSyntheticWindowMp4({
        stsdBox: entry.stsdBox,
        sampleRateHz: entry.sampleRateHz,
        packets: entry.packets,
        startPacket,
        endPacket,
        windowPayload: resp.buffer,
      });

      const track = openTrack(mp4Bytes);
      if (!track) {
        throw new Error('ALAC WASM decoder failed to open remote M4A packet window');
      }
      let decodedChunks: Uint8Array[] = [];
      let totalDecodedBytes = 0;
      try {
        const samplesToDecode = Math.min(expectedPcmSamples, track.samples || expectedPcmSamples);
        const pcmChunk = decodeTrack(track, 0, samplesToDecode);
        if (pcmChunk.byteLength > 0) {
          decodedChunks = [pcmChunk];
          totalDecodedBytes = pcmChunk.byteLength;
        }
      } finally {
        try {
          closeTrack(track);
        } catch {
          // ignore close errors
        }
      }

      // Copy ONLY the decoded window bytes so any underlying WASM linear memory buffer can be released immediately
      const pcmBuffer =
        decodedChunks.length === 1
          ? Buffer.from(decodedChunks[0])
          : Buffer.alloc(totalDecodedBytes);

      entry.cachedWindow = {
        startPacket,
        endPacket,
        pcmStartSample: firstPkt.pcmStart,
        pcmBuffer,
      };
      entry.lastAccessMs = Date.now();
      this.enforceWindowByteBudget(entry.cacheKey);
      this.ensureSweepTimer();
      return pcmBuffer;
    })().finally(() => {
      this.inflightWindow.delete(windowKey);
    });

    this.inflightWindow.set(windowKey, work);
    return work;
  }

  /**
   * Builds a `200 OK`, `206 Partial Content`, `416 Range Not Satisfiable`, or `HEAD`
   * WAV PCM HTTP response backed lazily by authenticated Range fetches.
   */
  async createWavMediaResponse(params: {
    entry: IndexedRemoteAlacTrack;
    method: string;
    rangeHeader: string | null;
    corsHeaders: Record<string, string>;
    fetcher: RemoteByteRangeFetcher;
    signal?: AbortSignal;
    onChunkDelivered?: (bytes: number) => void;
    onCompleted?: (bytes: number, errorCode: string | null) => void;
  }): Promise<Response> {
    const {
      entry,
      method,
      rangeHeader,
      corsHeaders,
      fetcher,
      signal,
      onChunkDelivered,
      onCompleted,
    } = params;
    entry.lastAccessMs = Date.now();

    const parsedRange = parseByteRangeHeader(rangeHeader, entry.totalWavBytes);
    if (!parsedRange.ok) {
      return new Response(null, {
        status: 416,
        headers: {
          ...corsHeaders,
          'Content-Range': `bytes */${entry.totalWavBytes}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }

    const { start, end, isPartial } = parsedRange;
    const contentLength = end - start + 1;

    const headers: Record<string, string> = {
      ...corsHeaders,
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(contentLength),
      'Cache-Control': 'no-store',
      'X-DoReMi-Transfer-Mode': 'remote-alac-range-wasm',
    };
    if (isPartial) {
      headers['Content-Range'] = `bytes ${start}-${end}/${entry.totalWavBytes}`;
    }

    if (method === 'HEAD') {
      onCompleted?.(0, null);
      return new Response(null, {
        status: isPartial ? 206 : 200,
        headers,
      });
    }

    let cursor = start;
    let totalSent = 0;
    let finished = false;
    const streamControllerAbort = new AbortController();
    const forwardAbort = () => streamControllerAbort.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });

    const finishStream = (errorCode: string | null) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', forwardAbort);
      onCompleted?.(totalSent, errorCode);
    };

    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          if (streamControllerAbort.signal.aborted || cursor > end) {
            finishStream(streamControllerAbort.signal.aborted ? 'ABORTED' : null);
            controller.close();
            return;
          }

          // Emit WAV header prefix if cursor < 44
          if (cursor < WAV_HEADER_BYTES) {
            const headerEnd = Math.min(WAV_HEADER_BYTES - 1, end);
            const slice = entry.wavHeader.subarray(cursor, headerEnd + 1);
            const copy = new Uint8Array(slice);
            cursor = headerEnd + 1;
            totalSent += copy.byteLength;
            onChunkDelivered?.(copy.byteLength);
            controller.enqueue(copy);
            if (cursor > end) {
              finishStream(null);
              controller.close();
            }
            return;
          }

          const pcmByteOffset = cursor - WAV_HEADER_BYTES;
          const pcmEndByteOffset = end - WAV_HEADER_BYTES;
          const targetSample = Math.floor(pcmByteOffset / entry.blockAlign);
          const packetIdx = this.findPacketForSample(entry.packets, targetSample);

          // Align packet window to cached window start if target falls inside it, otherwise align cleanly
          let startPacket = packetIdx;
          if (
            entry.cachedWindow &&
            packetIdx >= entry.cachedWindow.startPacket &&
            packetIdx <= entry.cachedWindow.endPacket
          ) {
            startPacket = entry.cachedWindow.startPacket;
          } else {
            startPacket = Math.floor(packetIdx / WINDOW_PACKET_COUNT) * WINDOW_PACKET_COUNT;
          }

          const pcmBuffer = await this.decodePacketWindow(
            entry,
            startPacket,
            fetcher,
            streamControllerAbort.signal,
          );
          const windowStartByte = entry.packets[startPacket].pcmStart * entry.blockAlign;
          const windowEndByte = windowStartByte + pcmBuffer.length - 1;

          const sliceStartInWindow = Math.max(0, pcmByteOffset - windowStartByte);
          const sliceEndInWindow = Math.min(pcmBuffer.length - 1, pcmEndByteOffset - windowStartByte);

          if (sliceEndInWindow >= sliceStartInWindow && pcmBuffer.length > 0) {
            const out = Uint8Array.from(pcmBuffer.subarray(sliceStartInWindow, sliceEndInWindow + 1));
            cursor += out.byteLength;
            totalSent += out.byteLength;
            onChunkDelivered?.(out.byteLength);
            controller.enqueue(out);
            if (cursor > end) {
              finishStream(null);
              controller.close();
            }
            return;
          }

          // Edge case: requested tail beyond decoded PCM (pad or finish cleanly at EOF)
          if (pcmByteOffset > windowEndByte) {
            const remaining = Math.min(65_536, end - cursor + 1);
            if (remaining > 0) {
              const pad = new Uint8Array(remaining);
              cursor += remaining;
              totalSent += remaining;
              onChunkDelivered?.(remaining);
              controller.enqueue(pad);
            }
            if (cursor > end) {
              finishStream(null);
              controller.close();
            }
            return;
          }

          finishStream(null);
          controller.close();
        } catch (err) {
          const code =
            streamControllerAbort.signal.aborted
              ? 'ABORTED'
              : err instanceof Error && err.message.includes('ALAC')
                ? 'ERR_DECODER_ALAC_FAILED'
                : 'ERR_REMOTE_STREAM_INTERRUPTED';
          finishStream(code);
          controller.error(err);
        }
      },
      cancel: () => {
        streamControllerAbort.abort();
        finishStream('CANCELLED');
      },
    });

    return new Response(body, {
      status: isPartial ? 206 : 200,
      headers,
    });
  }
}
