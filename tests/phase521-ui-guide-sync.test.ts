import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { openLibraryDatabase } from '../src/main/database/connection';
import {
  resolveNextNowPlayingModePatch,
  resolveSidebarAutoHideMode,
  resolveSidebarRevealedOnTransition,
  STANDARD_ENTRY_IDLE_HIDE_MS,
} from '../src/renderer/src/utils/animation-policy';
import {
  MAX_PLAYLIST_NAME_LENGTH,
  validatePlaylistName,
} from '../src/renderer/src/utils/playlist-validation';
import {
  computeBackToTopThresholdPx,
  resolveScrollBehavior,
  scrollContainerToTop,
  shouldShowBackToTop,
} from '../src/renderer/src/utils/scroll-helpers';
import { USER_GUIDE_CHAPTERS } from '../src/shared/user-guide/guide-content';
import { renderUserGuideMarkdown } from '../src/shared/user-guide/guide-markdown';
import { searchUserGuideChapters } from '../src/shared/user-guide/guide-search';
import {
  DOREMI_DESIGN_SLOGAN,
  DOREMI_DEVELOPER_HANDLE,
  resolveReleaseChannel,
} from '../src/shared/utils/app-metadata';

test('Phase 5.2.1A: Library Back-to-Top threshold, visibility & reduced-motion scroll helpers', () => {
  assert.equal(computeBackToTopThresholdPx(0), 553);
  assert.equal(computeBackToTopThresholdPx(350), 420);
  assert.equal(computeBackToTopThresholdPx(720), 518);
  assert.equal(computeBackToTopThresholdPx(1400), 600);

  // Content fits in viewport -> always hidden
  assert.equal(
    shouldShowBackToTop({
      scrollTop: 500,
      scrollHeight: 700,
      viewportHeight: 700,
    }),
    false,
  );
  // Below threshold -> hidden; at/above threshold -> visible
  assert.equal(
    shouldShowBackToTop({
      scrollTop: 320,
      scrollHeight: 3000,
      viewportHeight: 720,
    }),
    false,
  );
  assert.equal(
    shouldShowBackToTop({
      scrollTop: 650,
      scrollHeight: 3000,
      viewportHeight: 720,
    }),
    true,
  );

  assert.equal(resolveScrollBehavior(true), 'auto');
  assert.equal(resolveScrollBehavior(false), 'smooth');

  let calledOptions: ScrollToOptions | undefined;
  scrollContainerToTop(
    {
      scrollTop: 900,
      scrollTo(options?: ScrollToOptions) {
        calledOptions = options;
      },
    } as unknown as HTMLElement,
    true,
  );
  assert.deepEqual(calledOptions, { top: 0, behavior: 'auto' });
});

test('Phase 5.2.1A: Playlist name validation blocks empty, oversized, and NFC/NFD case-insensitive duplicates', () => {
  assert.equal(validatePlaylistName('   ', ['Nhạc Khuya']).valid, false);
  assert.equal(
    validatePlaylistName('a'.repeat(MAX_PLAYLIST_NAME_LENGTH + 1), []).valid,
    false,
  );

  const dupNfd = validatePlaylistName('Nha\u0323c Khuya'.normalize('NFD'), ['NHẠC KHUYA']);
  assert.equal(dupNfd.valid, false);
  assert.ok(dupNfd.error && dupNfd.error.includes('trùng tên'));

  const ok = validatePlaylistName('  Tuyển Tập Lossless  ', ['Nhạc Khuya']);
  assert.equal(ok.valid, true);
  assert.equal(ok.normalizedName, 'Tuyển Tập Lossless');
  assert.equal(ok.error, null);
});

test('Phase 5.2.1A: LibraryPage toolbar Create Playlist & Back-to-Top remain integrated across tabs', async () => {
  const libSrc = await fs.readFile(
    path.resolve(process.cwd(), 'src/renderer/src/pages/LibraryPage.tsx'),
    'utf8',
  );
  assert.match(libSrc, /data-testid="library-toolbar-create-playlist-btn"/);
  assert.match(libSrc, /title="Tạo danh sách phát mới"/);
  assert.match(libSrc, /<LibraryBackToTopButton/);

  const backToTopSrc = await fs.readFile(
    path.resolve(process.cwd(), 'src/renderer/src/components/LibraryBackToTopButton.tsx'),
    'utf8',
  );
  assert.match(backToTopSrc, /title="Về đầu trang"/);
  assert.match(backToTopSrc, /passive:\s*true/);
});

test('Phase 5.2.1B: Unified Focus Player sidebar auto-hide prevents pop-out across Focus <-> Standard transitions', () => {
  // Preserve Phase 4 contract
  assert.equal(resolveSidebarAutoHideMode('home', 'standard'), 'none');
  assert.equal(resolveSidebarAutoHideMode('library', 'focus'), 'none');
  assert.equal(resolveSidebarAutoHideMode('now-playing', 'standard'), 'standard-idle');
  assert.equal(resolveSidebarAutoHideMode('now-playing', 'focus'), 'focus-immediate');

  // Entering Now Playing from outside shows briefly (3s orientation)
  assert.deepEqual(resolveSidebarRevealedOnTransition('none', 'standard-idle', true), {
    revealed: true,
    scheduleHideMs: STANDARD_ENTRY_IDLE_HIDE_MS,
  });

  // Entering Focus hides immediately
  assert.deepEqual(resolveSidebarRevealedOnTransition('standard-idle', 'focus-immediate', true), {
    revealed: false,
    scheduleHideMs: null,
  });

  // Returning Focus -> Standard/Lyrics keeps Sidebar hidden uniformly (ZERO pop-out / jump!)
  assert.deepEqual(resolveSidebarRevealedOnTransition('focus-immediate', 'standard-idle', false), {
    revealed: false,
    scheduleHideMs: null,
  });

  // Leaving player restores Sidebar cleanly
  assert.deepEqual(resolveSidebarRevealedOnTransition('focus-immediate', 'none', false), {
    revealed: true,
    scheduleHideMs: null,
  });
  assert.deepEqual(resolveSidebarRevealedOnTransition('standard-idle', 'none', false), {
    revealed: true,
    scheduleHideMs: null,
  });

  // Staying in now-playing keeps nowPlayingSidebarRevealed: false on focus <-> standard
  assert.equal(resolveNextNowPlayingModePatch('now-playing', 'focus', 'focus'), null);
  assert.deepEqual(resolveNextNowPlayingModePatch('now-playing', 'focus', 'standard'), {
    nowPlayingMode: 'standard',
    nowPlayingSidebarRevealed: false,
  });
  assert.deepEqual(resolveNextNowPlayingModePatch('now-playing', 'standard', 'focus'), {
    nowPlayingMode: 'focus',
    nowPlayingSidebarRevealed: false,
  });
  assert.deepEqual(resolveNextNowPlayingModePatch('library', 'focus', 'standard'), {
    nowPlayingMode: 'standard',
    nowPlayingSidebarRevealed: true,
  });
});

test('Phase 5.2.1C: About identity, dynamic release channel, SQLite version & Codec isolation', async () => {
  assert.equal(DOREMI_DEVELOPER_HANDLE, 'kamisamao');
  assert.equal(DOREMI_DESIGN_SLOGAN, 'Built with passion. Designed for music lovers.');
  assert.equal(resolveReleaseChannel('1.0.0-rc.2'), 'Release Candidate');
  assert.equal(resolveReleaseChannel('1.0.0'), 'Stable');
  assert.equal(resolveReleaseChannel('1.1.0-beta.1'), 'Beta');
  assert.equal(resolveReleaseChannel('0.2.0-alpha.1'), 'Development');

  const conn = openLibraryDatabase(':memory:');
  try {
    assert.match(conn.sqliteVersion, /^\d+\.\d+\.\d+/);
  } finally {
    conn.close();
  }

  const aboutSrc = await fs.readFile(
    path.resolve(process.cwd(), 'src/renderer/src/features/about/AboutSection.tsx'),
    'utf8',
  );
  assert.doesNotMatch(aboutSrc, /1\.0\.0-rc\.[0-9]+/);
  assert.match(aboutSrc, /getAppInfo/);
  assert.match(aboutSrc, /@mgz-dev\/alac/);

  // Codec Engine must NOT be statically imported anywhere in startup IPC / preload / renderer
  const registerIpcSrc = await fs.readFile(
    path.resolve(process.cwd(), 'src/main/ipc/register-ipc.ts'),
    'utf8',
  );
  assert.doesNotMatch(registerIpcSrc, /^import\s+.*CodecManager/m);
});

test('Phase 5.2.1D & E: Integrated 15-chapter Offline User Guide, Vietnamese search & docs/USER_GUIDE.md sync', async () => {
  assert.equal(USER_GUIDE_CHAPTERS.length, 15);
  USER_GUIDE_CHAPTERS.forEach((ch, idx) => {
    assert.equal(ch.number, String(idx + 1).padStart(2, '0'));
    assert.ok(ch.sections.length > 0);
  });

  // Unaccented & accented Vietnamese search
  const topBtnMatches = searchUserGuideChapters('ve dau trang');
  assert.ok(topBtnMatches.some((m) => m.chapter.id === 'ch-04-nhap-nhac-thu-vien'));

  const alacMatches = searchUserGuideChapters('ALAC');
  assert.ok(alacMatches.some((m) => m.chapter.id === 'ch-09-audio-engine-audio-lab'));

  const missingMatches = searchUserGuideChapters('Thiếu file');
  assert.ok(missingMatches.some((m) => m.chapter.id === 'ch-04-nhap-nhac-thu-vien'));
  assert.ok(missingMatches.some((m) => m.chapter.id === 'ch-15-xu-ly-su-co'));

  assert.equal(searchUserGuideChapters('zzznonexistentkeyword999').length, 0);

  // Verify docs/USER_GUIDE.md matches package.json version deterministically
  const pkgRaw = await fs.readFile(path.resolve(process.cwd(), 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgRaw) as { version: string };
  const docGuide = await fs.readFile(
    path.resolve(process.cwd(), 'docs/USER_GUIDE.md'),
    'utf8',
  );
  assert.equal(docGuide, renderUserGuideMarkdown(`v${pkg.version}`));
});
