import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AudioProcessingService } from '../src/main/services/codec/audio-processing-service';
import { CodecManager } from '../src/main/services/codec/codec-manager';
import { ResourcePolicyManager } from '../src/main/services/codec/resource-policy';

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeMockExecutable(dir: string, fileName: string, scriptBody: string): Promise<string> {
  const fullPath = path.join(dir, fileName);
  await fs.writeFile(fullPath, `#!/usr/bin/env node\n${scriptBody}\n`, 'utf8');
  await fs.chmod(fullPath, 0o755);
  return fullPath;
}

test('Phase 03B Resource Policy: Power Saving default (concurrency=1), Balanced & Performance bounds', () => {
  const policy = new ResourcePolicyManager();
  assert.equal(policy.getMode(), 'power-saving');

  const psIdle = policy.getEffectiveLimits();
  assert.equal(psIdle.conversionConcurrency, 1);
  assert.equal(psIdle.encoderThreads, 1);
  assert.equal(psIdle.probeConcurrency, 1);
  assert.equal(psIdle.analyzerConcurrency, 1);
  assert.equal(psIdle.playbackPriorityActive, false);
  assert.equal(psIdle.deferNewConversionJobs, false);

  const balancedIdle = policy.setMode('balanced');
  assert.equal(balancedIdle.conversionConcurrency, 2);
  assert.equal(balancedIdle.encoderThreads, 2);
  assert.equal(balancedIdle.probeConcurrency, 1);

  const perfIdle = policy.setMode('performance');
  assert.equal(perfIdle.conversionConcurrency, 3);
  assert.equal(perfIdle.encoderThreads, 4);
  assert.equal(perfIdle.probeConcurrency, 2);
});

test('Phase 03B Resource Policy: Playback Priority throttles concurrency/threads and syncs CodecManager discovery policy', async () => {
  const tmp = await createTempDir('doremi-respol-');
  try {
    const codecManager = new CodecManager({
      userDataDir: path.join(tmp, 'userdata'),
      platform: process.platform,
      arch: process.arch,
    });
    const policy = new ResourcePolicyManager('power-saving');
    const detach = policy.attachCodecManager(codecManager);

    // Initially idle in Power Saving
    assert.equal(codecManager.getDiscoveryPolicy().maxProbeConcurrency, 1);
    assert.equal(codecManager.getDiscoveryPolicy().deferProbeWhenPlaybackActive, false);

    // Playback starts -> Power Saving defers new conversion jobs & codec scanning
    const psPlaying = policy.setPlaybackState({ isPlaying: true, activeTrackFormat: 'FLAC 24/96' });
    assert.equal(psPlaying.playbackPriorityActive, true);
    assert.equal(psPlaying.deferNewConversionJobs, true);
    assert.equal(psPlaying.deferCodecScanning, true);
    assert.equal(psPlaying.deferHeavyAnalysis, true);
    assert.equal(codecManager.getDiscoveryPolicy().deferProbeWhenPlaybackActive, true);
    assert.equal(codecManager.getDiscoveryPolicy().maxProbeConcurrency, 1);

    // Switching to Balanced while playing caps conversion concurrency to 1 & threads to 1
    const balPlaying = policy.setMode('balanced');
    assert.equal(balPlaying.conversionConcurrency, 1);
    assert.equal(balPlaying.encoderThreads, 1);
    assert.equal(balPlaying.deferNewConversionJobs, false);
    assert.equal(balPlaying.deferCodecScanning, true);

    // Switching to Performance while playing still caps conversion concurrency to 1 & threads to 2
    const perfPlaying = policy.setMode('performance');
    assert.equal(perfPlaying.conversionConcurrency, 1);
    assert.equal(perfPlaying.encoderThreads, 2);

    // Playback stops -> limits restore cleanly
    const perfIdle = policy.setPlaybackState({ isPlaying: false });
    assert.equal(perfIdle.playbackPriorityActive, false);
    assert.equal(perfIdle.conversionConcurrency, 3);
    assert.equal(codecManager.getDiscoveryPolicy().maxProbeConcurrency, 2);

    detach();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('Phase 03B Resource Policy: Power Saving defers queued conversion during playback and resumes automatically on pause/stop', async () => {
  const tmp = await createTempDir('doremi-playback-defer-');
  const userData = path.join(tmp, 'userdata');
  const binDir = path.join(tmp, 'bins');
  const outDir = path.join(tmp, 'out');
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  const wavSource = path.join(tmp, 'demo.wav');
  const wavBuf = Buffer.alloc(44, 0);
  wavBuf.write('RIFF', 0, 'ascii');
  wavBuf.write('WAVE', 8, 'ascii');
  await fs.writeFile(wavSource, wavBuf);

  const mockFlac = await writeMockExecutable(
    binDir,
    'flac',
    `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args.includes('--version')) {
      console.log('flac 1.4.3-mock');
      process.exit(0);
    }
    const outIdx = args.indexOf('-o');
    fs.writeFileSync(args[outIdx + 1], Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(32, 3)]));
    process.exit(0);
    `,
  );

  const codecManager = new CodecManager({
    userDataDir: userData,
    platform: process.platform,
    arch: process.arch,
    allowPosixTestScripts: true,
  });
  await codecManager.importCustomBinary('flac', mockFlac, {
    userConfirmed: true,
    originNote: 'unit-test-defer',
  });

  const policy = new ResourcePolicyManager('power-saving', { isPlaying: true });
  const service = new AudioProcessingService({
    codecManager,
    resourcePolicy: policy,
  });

  try {
    // Enqueue while playing in Power Saving -> stays queued (deferred) without running encoder
    const snapPlaying = await service.enqueueConversion(
      [{ sourcePath: wavSource, title: 'DeferredTrack' }],
      { targetFormat: 'flac', outputDirectory: outDir },
    );
    assert.equal(snapPlaying.playbackPriorityActive, true);
    assert.equal(snapPlaying.queuedCount, 1);
    assert.equal(snapPlaying.activeCount, 0);
    assert.equal(snapPlaying.isProcessing, false);

    // Playback stops -> queue automatically starts & completes without any manual trigger or background polling!
    service.setPlaybackState({ isPlaying: false });
    await service.waitForCleanup();

    const snapDone = service.getQueueSnapshot();
    assert.equal(snapDone.completedCount, 1);
    assert.equal(snapDone.jobs[0].status, 'completed');
    assert.equal(snapDone.isProcessing, false);
  } finally {
    await service.disposeAsync();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
