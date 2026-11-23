import fs from 'node:fs';
import path from 'node:path';

export interface WavFixtureOptions {
  sampleRate?: number;
  bitsPerSample?: number;
  channels?: number;
  durationSeconds?: number;
}

/**
 * Generates a valid uncompressed PCM WAV binary buffer parseable by music-metadata
 * and playable by HTMLAudioElement.
 */
export function createWavBuffer(options: WavFixtureOptions = {}): Buffer {
  const sampleRate = options.sampleRate ?? 44100;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const channels = options.channels ?? 2;
  const durationSeconds = options.durationSeconds ?? 1;

  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const totalSamples = Math.round(sampleRate * durationSeconds);
  const dataSize = totalSamples * blockAlign;

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

export interface FlacFixtureOptions {
  sampleRate?: number;
  bitsPerSample?: number;
  channels?: number;
  durationSeconds?: number;
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  lyrics?: string;
  picture?: {
    mime: string;
    data: Buffer;
    description?: string;
  };
}

function buildFlacMetadataBlock(
  type: number,
  payload: Buffer,
  isLast: boolean,
): Buffer {
  const header = Buffer.alloc(4);
  header[0] = (isLast ? 0x80 : 0x00) | (type & 0x7f);
  header[1] = (payload.length >> 16) & 0xff;
  header[2] = (payload.length >> 8) & 0xff;
  header[3] = payload.length & 0xff;
  return Buffer.concat([header, payload]);
}

function buildFlacPicturePayload(mime: string, data: Buffer, description = 'Cover'): Buffer {
  const mimeBuf = Buffer.from(mime, 'ascii');
  const descBuf = Buffer.from(description, 'utf8');

  const part1 = Buffer.alloc(8);
  part1.writeUInt32BE(3, 0); // Picture type 3 = Cover (front)
  part1.writeUInt32BE(mimeBuf.length, 4);

  const part2 = Buffer.alloc(4);
  part2.writeUInt32BE(descBuf.length, 0);

  const part3 = Buffer.alloc(20);
  part3.writeUInt32BE(1, 0); // width
  part3.writeUInt32BE(1, 4); // height
  part3.writeUInt32BE(24, 8); // color depth
  part3.writeUInt32BE(0, 12); // indexed colors
  part3.writeUInt32BE(data.length, 16);

  return Buffer.concat([part1, mimeBuf, part2, descBuf, part3, data]);
}

/**
 * Generates a valid FLAC header binary buffer with STREAMINFO + optional VORBIS_COMMENT + optional PICTURE blocks
 * so music-metadata extracts real lossless specs, tags, lyrics, and embedded cover art.
 */
export function createFlacMetadataBuffer(options: FlacFixtureOptions = {}): Buffer {
  const sampleRate = options.sampleRate ?? 96000;
  const bitsPerSample = options.bitsPerSample ?? 24;
  const channels = options.channels ?? 2;
  const durationSeconds = options.durationSeconds ?? 2;
  const totalSamples = BigInt(Math.round(sampleRate * durationSeconds));

  const comments: string[] = [];
  if (options.title) comments.push(`TITLE=${options.title}`);
  if (options.artist) comments.push(`ARTIST=${options.artist}`);
  if (options.album) comments.push(`ALBUM=${options.album}`);
  if (options.year) comments.push(`DATE=${options.year}`);
  if (options.lyrics) comments.push(`LYRICS=${options.lyrics}`);

  const blocks: Array<{ type: number; payload: Buffer }> = [];

  // STREAMINFO block (type 0, 34 bytes)
  const streamInfo = Buffer.alloc(34);
  streamInfo.writeUInt16BE(4096, 0);
  streamInfo.writeUInt16BE(4096, 2);

  const packed =
    (BigInt(sampleRate) << 44n) |
    (BigInt(channels - 1) << 41n) |
    (BigInt(bitsPerSample - 1) << 36n) |
    (totalSamples & 0xfffffffffn);

  streamInfo.writeBigUInt64BE(packed, 10);
  blocks.push({ type: 0, payload: streamInfo });

  if (comments.length > 0) {
    const vendorBuf = Buffer.from('DoReMiTestFixture', 'utf8');
    const commentBuffers = comments.map((entry) => {
      const encoded = Buffer.from(entry, 'utf8');
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32LE(encoded.length, 0);
      return Buffer.concat([lenBuf, encoded]);
    });

    const vendorLen = Buffer.alloc(4);
    vendorLen.writeUInt32LE(vendorBuf.length, 0);

    const listLen = Buffer.alloc(4);
    listLen.writeUInt32LE(commentBuffers.length, 0);

    const vorbisPayload = Buffer.concat([vendorLen, vendorBuf, listLen, ...commentBuffers]);
    blocks.push({ type: 4, payload: vorbisPayload });
  }

  if (options.picture) {
    blocks.push({
      type: 6,
      payload: buildFlacPicturePayload(
        options.picture.mime,
        options.picture.data,
        options.picture.description,
      ),
    });
  }

  const encodedBlocks = blocks.map((block, index) =>
    buildFlacMetadataBlock(block.type, block.payload, index === blocks.length - 1),
  );

  return Buffer.concat([Buffer.from('fLaC', 'ascii'), ...encodedBlocks]);
}

/** Minimal valid 1x1 PNG binary buffer (real PNG signature + IHDR/IDAT/IEND). */
export function createValidPngBuffer(seedByte = 0x01): Buffer {
  // Standard 1x1 PNG + harmless trailing comment byte inside tEXt or distinct byte before end
  const base = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082',
    'hex',
  );
  return Buffer.concat([base, Buffer.from([seedByte])]);
}

/** Minimal JPEG binary buffer with valid FF D8 FF E0 SOI/JFIF magic header. */
export function createValidJpegBuffer(seedByte = 0x10): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, seedByte, 0xff, 0xd9,
  ]);
}

/** Minimal WEBP binary buffer with valid RIFF....WEBP magic header. */
export function createValidWebpBuffer(seedByte = 0x20): Buffer {
  const buf = Buffer.alloc(24);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(16, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  buf.writeUInt32LE(4, 16);
  buf[20] = seedByte;
  return buf;
}

export function writeFixtureFile(targetPath: string, content: Buffer): string {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content);
  return targetPath;
}
