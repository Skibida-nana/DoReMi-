import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  assertValidTrackId,
  assertValidUuid,
  assertValidUuidList,
} from '../src/main/ipc/validators';
import {
  isAllowedMediaCorsOrigin,
  parseByteRangeHeader,
} from '../src/main/services/audio-stream-handler';
import {
  auditCodecDistributionMatrix,
  validateProcessLaunchTarget,
} from '../src/main/services/codec/process-execution';
import { extractAudioFilePathsFromArgv } from '../src/main/utils/cli-audio-args';
import {
  computeQueueWindowSlice,
  QUEUE_VIRTUALIZE_THRESHOLD,
} from '../src/renderer/src/utils/queue-virtualization';
import { normalizeVietnameseText } from '../src/renderer/src/utils/vietnamese-search';
import {
  parseArtworkRequestFromMediaUrl,
  parsePlaylistArtworkRequestFromMediaUrl,
  parseProfileMediaRequest,
  parseTrackIdFromMediaUrl,
} from '../src/shared/contracts/media-protocol';
import { naturalCompare } from '../src/shared/utils/natural-sort';

const VALID_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('Phase 5.2C: MainWindow & CSP hardened security posture stays intact', async () => {
  const mainWinSrc = await fs.readFile(
    path.resolve(process.cwd(), 'src/main/windows/main-window.ts'),
    'utf8',
  );
  assert.match(mainWinSrc, /nodeIntegration:\s*false/);
  assert.match(mainWinSrc, /contextIsolation:\s*true/);
  assert.match(mainWinSrc, /sandbox:\s*true/);
  assert.match(mainWinSrc, /webSecurity:\s*true/);
  assert.match(mainWinSrc, /allowRunningInsecureContent:\s*false/);
  assert.match(mainWinSrc, /setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)\)/);
  assert.match(mainWinSrc, /will-navigate/);

  const mainIndexSrc = await fs.readFile(
    path.resolve(process.cwd(), 'src/main/index.ts'),
    'utf8',
  );
  assert.match(mainIndexSrc, /Content-Security-Policy/);
  assert.match(mainIndexSrc, /connect-src 'self'/);
  assert.match(mainIndexSrc, /object-src 'none'/);

  const procExecSrc = await fs.readFile(
    path.resolve(process.cwd(), 'src/main/services/codec/process-execution.ts'),
    'utf8',
  );
  assert.match(procExecSrc, /shell:\s*false/);
});

test('Phase 5.2C: Custom media protocol, CORS origin, IPC validators, CLI argv & process target reject untrusted payloads', () => {
  // Media protocol traversal / injection blocking
  for (const hostUrl of [
    `lossless-media://track/../../etc/passwd`,
    `lossless-media://track/${VALID_UUID}%2fextra`,
    `lossless-media://track/${VALID_UUID}\\evil`,
    `lossless-media://track/${VALID_UUID}?q=1`,
    `https://track/${VALID_UUID}`,
  ]) {
    assert.equal(parseTrackIdFromMediaUrl(hostUrl), null);
    assert.equal(parseArtworkRequestFromMediaUrl(hostUrl), null);
    assert.equal(parsePlaylistArtworkRequestFromMediaUrl(hostUrl), null);
  }

  assert.equal(parseTrackIdFromMediaUrl(`lossless-media://track/${VALID_UUID}`), VALID_UUID);
  assert.deepEqual(parseArtworkRequestFromMediaUrl(`lossless-media://artwork/${VALID_UUID}?size=thumb`), {
    trackId: VALID_UUID,
    size: 'thumb',
    hasVersionToken: false,
  });
  assert.equal(parseArtworkRequestFromMediaUrl(`lossless-media://artwork/${VALID_UUID}?size=huge`), null);
  assert.equal(parseProfileMediaRequest('lossless-media://profile/font/../../bad'), null);

  // Local-only CORS policy
  assert.equal(isAllowedMediaCorsOrigin(null), true);
  assert.equal(isAllowedMediaCorsOrigin('file://'), true);
  assert.equal(isAllowedMediaCorsOrigin('http://localhost:5173'), true);
  assert.equal(isAllowedMediaCorsOrigin('https://evil.example.com'), false);

  // Byte range hardening
  assert.equal(parseByteRangeHeader('bytes=100-50', 1000).ok, false);
  assert.equal(parseByteRangeHeader('bytes=2000-2005', 1000).ok, false);
  assert.equal(parseByteRangeHeader('bytes=0-99', 1000).ok, true);

  // IPC UUID & batch validation
  assert.equal(assertValidTrackId(VALID_UUID.toUpperCase()), VALID_UUID);
  assert.throws(() => assertValidTrackId('../bad'));
  assert.throws(() => assertValidUuid('not-a-uuid'));
  assert.throws(() =>
    assertValidUuidList(
      Array.from({ length: 10_001 }, () => VALID_UUID),
      'trackIds',
    ),
  );

  // CLI argv filtering (Windows Explorer Open With)
  const argvRes = extractAudioFilePathsFromArgv(
    [
      'DoReMi.exe',
      '--allow-file-access-from-files',
      'https://remote.example/song.flac',
      'C:\\Windows\\System32\\cmd.exe',
      'relative\\song.flac',
      'D:\\Nhạc Việt\\Bài hát 01 (24-bit).flac\0evil',
      'D:\\Nhạc Việt\\Bài hát 01 (24-bit).flac',
      'd:\\nhạc việt\\bài hát 01 (24-bit).flac',
    ],
    { isPackaged: true, platform: 'win32' },
  );
  assert.deepEqual(argvRes, ['D:\\Nhạc Việt\\Bài hát 01 (24-bit).flac']);

  // Codec process execution safety & redistribution classification
  assert.throws(() => validateProcessLaunchTarget('', ['--help']));
  assert.throws(() => validateProcessLaunchTarget('flac.exe\0calc.exe', []));
  assert.throws(() => validateProcessLaunchTarget('flac.exe', ['bad\0arg']));
  const audit = auditCodecDistributionMatrix();
  assert.notEqual(audit.find((x) => x.id === 'qaac')?.distributionPolicy, 'BUNDLED_ALLOWED');
  assert.notEqual(audit.find((x) => x.id === 'fhgaacenc')?.distributionPolicy, 'BUNDLED_ALLOWED');
  assert.notEqual(audit.find((x) => x.id === 'ffmpeg')?.distributionPolicy, 'BUNDLED_ALLOWED');
  assert.equal(audit.find((x) => x.id === 'alac-wasm')?.distributionPolicy, 'BUNDLED_ALLOWED');
});

test('Phase 5.2D: Library virtualization matrix (0..50,000 tracks) & rapid navigation scroll clamping invariants', () => {
  const scales = [0, 1, 24, 79, 80, 81, 100, 500, 1000, 5000, 50_000] as const;
  const rowHeight = 56;
  const viewportHeight = 720;

  for (const totalItems of scales) {
    const sliceTop = computeQueueWindowSlice({
      totalItems,
      itemHeightPx: rowHeight,
      scrollOffsetPx: 0,
      viewportHeightPx: viewportHeight,
      overscanCount: 12,
    });

    assert.ok(sliceTop.startIndex >= 0);
    assert.ok(sliceTop.startIndex <= sliceTop.endIndex);
    assert.ok(sliceTop.endIndex <= totalItems);

    if (totalItems <= QUEUE_VIRTUALIZE_THRESHOLD) {
      assert.equal(sliceTop.virtualized, false);
      assert.equal(sliceTop.startIndex, 0);
      assert.equal(sliceTop.endIndex, totalItems);
      assert.equal(sliceTop.topSpacerPx, 0);
      assert.equal(sliceTop.bottomSpacerPx, 0);
    } else {
      assert.equal(sliceTop.virtualized, true);
      const renderedCount = sliceTop.endIndex - sliceTop.startIndex;
      assert.ok(renderedCount > 0 && renderedCount <= 50, `Expected bounded window at ${totalItems}, got ${renderedCount}`);
      assert.equal(
        sliceTop.topSpacerPx + renderedCount * rowHeight + sliceTop.bottomSpacerPx,
        totalItems * rowHeight,
      );
    }

    // Stress simulated rapid switch/shrink with stale huge scroll offset (must clamp cleanly!)
    const staleScrollSlice = computeQueueWindowSlice({
      totalItems,
      itemHeightPx: rowHeight,
      scrollOffsetPx: 2_500_000,
      viewportHeightPx: viewportHeight,
      overscanCount: 12,
    });
    assert.ok(staleScrollSlice.startIndex <= staleScrollSlice.endIndex);
    assert.ok(staleScrollSlice.endIndex <= totalItems);
    if (totalItems > 0) {
      assert.ok(
        staleScrollSlice.endIndex - staleScrollSlice.startIndex > 0,
        `Non-empty list (${totalItems}) must never render 0 rows on oversized scroll offset`,
      );
    }
  }
});

test('Phase 5.2D: Vietnamese NFC/NFD normalization & natural numeric track sorting regression', () => {
  const nfc = 'Đường Xưa Lối Cũ'.normalize('NFC');
  const nfd = 'Đường Xưa Lối Cũ'.normalize('NFD');
  assert.equal(normalizeVietnameseText(nfc), normalizeVietnameseText(nfd));
  assert.equal(normalizeVietnameseText(nfc), 'duong xua loi cu');

  const sorted = ['Track 10.flac', 'Track 2.flac', 'Track 1.flac', 'Bài 2.flac', 'Bài 11.flac'].sort(
    naturalCompare,
  );
  assert.deepEqual(sorted, ['Bài 2.flac', 'Bài 11.flac', 'Track 1.flac', 'Track 2.flac', 'Track 10.flac']);
});
