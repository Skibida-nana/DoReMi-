import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveTrackMediaResponse } from '../src/main/services/audio-stream-handler';
import {
  clearFlacSanitizerCache,
  resolveFlacStreamPlan,
} from '../src/main/services/flac-stream-sanitizer';

function buildMinimalFlac(options: {
  prependId3v2?: boolean;
  pictures?: Array<{
    mime: string;
    jpegPayload?: boolean;
    corruptLength?: boolean;
  }>;
  vorbisText?: string;
  audioBytes?: Buffer;
}): Buffer {
  const parts: Buffer[] = [];
  if (options.prependId3v2) {
    // 10-byte ID3v2 header with 16 bytes of ID3 body (synchsafe = 16)
    const id3Hdr = Buffer.from([
      0x49, 0x44, 0x33, // 'ID3'
      0x03, 0x00, 0x00, // v2.3.0
      0x00, 0x00, 0x00, 0x10, // 16 bytes
    ]);
    parts.push(id3Hdr, Buffer.alloc(16, 0x41));
  }

  parts.push(Buffer.from('fLaC', 'ascii'));

  // Block 0: STREAMINFO (34 bytes, 16-bit 96kHz stereo, 96000 samples)
  const streamInfo = Buffer.alloc(34, 0);
  streamInfo.writeUInt16BE(4096, 0);
  streamInfo.writeUInt16BE(4096, 2);
  // sampleRate=96000 (0x17700), ch=2 (1), bps=16 (15), samples=96000
  const packed = (BigInt(96000) << 44n) | (1n << 41n) | (15n << 36n) | 96000n;
  streamInfo.writeBigUInt64BE(packed, 10);

  const blocks: Array<{ type: number; body: Buffer }> = [{ type: 0, body: streamInfo }];

  if (options.vorbisText) {
    const vendor = Buffer.from('DoReMi Test FLAC', 'utf8');
    const vb = Buffer.alloc(4 + vendor.length + 4);
    vb.writeUInt32LE(vendor.length, 0);
    vendor.copy(vb, 4);
    blocks.push({ type: 4, body: vb });
  }

  for (const pic of options.pictures ?? []) {
    const mimeBuf = Buffer.from(pic.mime, 'latin1');
    const imgPayload = pic.jpegPayload
      ? Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
      : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const body = Buffer.alloc(4 + 4 + mimeBuf.length + 4 + 16 + 4 + imgPayload.length, 0);
    let o = 0;
    body.writeUInt32BE(3, o); o += 4;
    body.writeUInt32BE(mimeBuf.length, o); o += 4;
    mimeBuf.copy(body, o); o += mimeBuf.length;
    body.writeUInt32BE(0, o); o += 4; // descLen = 0
    o += 16; // w, h, depth, colors
    body.writeUInt32BE(pic.corruptLength ? 999999 : imgPayload.length, o); o += 4;
    imgPayload.copy(body, o);
    blocks.push({ type: 6, body });
  }

  blocks.forEach((b, i) => {
    const hdr = Buffer.alloc(4);
    hdr[0] = (i === blocks.length - 1 ? 0x80 : 0x00) | (b.type & 0x7f);
    hdr[1] = (b.body.length >> 16) & 0xff;
    hdr[2] = (b.body.length >> 8) & 0xff;
    hdr[3] = b.body.length & 0xff;
    parts.push(hdr, b.body);
  });

  parts.push(options.audioBytes ?? Buffer.from([0xff, 0xf8, 0xcb, 0x18, 0x00, 0x11, 0x22, 0x33, 0x44]));
  return Buffer.concat(parts);
}

test('FLAC sanitizer passes healthy FLAC files through unchanged (zero-copy)', async (t) => {
  clearFlacSanitizerCache();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-flac-ok-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const healthyFile = path.join(dir, 'healthy.flac');
  const raw = buildMinimalFlac({
    vorbisText: 'normal',
    pictures: [{ mime: 'image/jpeg', jpegPayload: true }],
  });
  await fs.writeFile(healthyFile, raw);
  const stat = await fs.stat(healthyFile);

  const plan = await resolveFlacStreamPlan(healthyFile, stat.size, stat.mtimeMs);
  assert.equal(plan.normalized, false);
  assert.equal(plan.virtualFileSize, stat.size);
});

test('FLAC sanitizer strips empty-MIME PICTURE and ID3v2 prefix while preserving audio frames bit-for-bit', async (t) => {
  clearFlacSanitizerCache();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-flac-fix-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const trackId = '11111111-2222-4333-8444-555555555555';
  const brokenFlac = path.join(dir, 'broken-wham-like.flac');
  const fakeAudioFrames = Buffer.from([0xff, 0xf8, 0xcb, 0x18, 0xde, 0xad, 0xbe, 0xef, 0xaa, 0xbb]);
  const raw = buildMinimalFlac({
    prependId3v2: true,
    vorbisText: 'Careless Whisper',
    pictures: [
      { mime: '', jpegPayload: true }, // Exact Wham! empty-MIME picture anomaly
      { mime: '-->', jpegPayload: false }, // External URL picture anomaly
    ],
    audioBytes: fakeAudioFrames,
  });
  await fs.writeFile(brokenFlac, raw);
  const beforeDiskBytes = Buffer.from(await fs.readFile(brokenFlac));
  const stat = await fs.stat(brokenFlac);

  const plan = await resolveFlacStreamPlan(brokenFlac, stat.size, stat.mtimeMs);
  assert.equal(plan.normalized, true);
  assert.equal(plan.strippedId3Header, true);
  assert.equal(plan.strippedPictureBlocks, 2);

  const trackRepo = {
    findById: (id: string) =>
      id === trackId
        ? ({
            id: trackId,
            original_path: brokenFlac,
            file_name: 'broken-wham-like.flac',
            status: 'available',
            codec: 'FLAC',
            container: 'FLAC',
          } as never)
        : null,
    updateStatus: () => true,
  };

  // Full response must start with `fLaC`, exclude PICTURE blocks, and end with exact bit-for-bit audio frames
  const fullResp = await resolveTrackMediaResponse(
    new Request(`lossless-media://track/${trackId}`),
    { trackRepo },
  );
  assert.equal(fullResp.status, 200);
  const fullBytes = Buffer.from(await fullResp.arrayBuffer());
  assert.equal(fullBytes.subarray(0, 4).toString('ascii'), 'fLaC');
  assert.equal(fullBytes.length, plan.virtualFileSize);
  assert.deepEqual(
    fullBytes.subarray(plan.headerBuffer.length),
    fakeAudioFrames,
    'Audio payload frames must stay 100% bit-for-bit identical',
  );

  // Boundary-spanning Range request + audio-only Range request must match exact slices of fullBytes
  const spanResp = await resolveTrackMediaResponse(
    new Request(`lossless-media://track/${trackId}`, {
      headers: { range: `bytes=${plan.headerBuffer.length - 5}-${fullBytes.length - 2}` },
    }),
    { trackRepo },
  );
  assert.equal(spanResp.status, 206);
  const spanBytes = Buffer.from(await spanResp.arrayBuffer());
  assert.deepEqual(
    spanBytes,
    fullBytes.subarray(plan.headerBuffer.length - 5, fullBytes.length - 1),
  );

  const audioOnlyResp = await resolveTrackMediaResponse(
    new Request(`lossless-media://track/${trackId}`, {
      headers: { range: `bytes=${plan.headerBuffer.length}-` },
    }),
    { trackRepo },
  );
  assert.equal(audioOnlyResp.status, 206);
  const audioOnlyBytes = Buffer.from(await audioOnlyResp.arrayBuffer());
  assert.deepEqual(audioOnlyBytes, fakeAudioFrames);

  // Disk file must remain untouched
  assert.deepEqual(await fs.readFile(brokenFlac), beforeDiskBytes);
});
