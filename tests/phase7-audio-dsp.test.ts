import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openLibraryDatabase } from '../src/main/database/connection';
import { ProfileService } from '../src/main/services/profile-service';
import {
  AudioDspGraph,
  type AnalyserNodeLike,
  type AudioContextLike,
  type AudioNodeLike,
  type AudioParamLike,
  type BiquadFilterNodeLike,
  type GainNodeLike,
} from '../src/renderer/src/player/audio-dsp';
import {
  AudioEngine,
  type AudioElementLike,
  type MediaErrorLike,
} from '../src/renderer/src/player/audio-engine';
import {
  GRAPHIC_EQ_FREQUENCIES,
  type ParametricFilterType,
} from '../src/shared/types/audio-dsp';
import type { TrackRecord } from '../src/shared/types/track';
import {
  computeCompositeFrequencyResponse,
  computeHeadroomAnalysis,
  createDefaultAudioLabSettings,
  createDefaultParametricBands,
  dbToLinearGain,
  evaluateBiquadMagnitudeDb,
  SYSTEM_AUDIO_PRESETS,
} from '../src/shared/utils/audio-dsp';
import { computeReplayGainMultiplier } from '../src/shared/utils/replaygain';

class MockAudioParam implements AudioParamLike {
  value: number;
  readonly events: Array<{ op: string; value: number; time: number }> = [];

  constructor(initial: number) {
    this.value = initial;
  }

  setValueAtTime(value: number, startTime: number): AudioParamLike {
    this.value = value;
    this.events.push({ op: 'setValueAtTime', value, time: startTime });
    return this;
  }

  linearRampToValueAtTime(value: number, endTime: number): AudioParamLike {
    this.value = value;
    this.events.push({ op: 'linearRampToValueAtTime', value, time: endTime });
    return this;
  }

  setTargetAtTime(target: number, startTime: number): AudioParamLike {
    this.value = target;
    this.events.push({ op: 'setTargetAtTime', value: target, time: startTime });
    return this;
  }

  cancelScheduledValues(cancelTime: number): AudioParamLike {
    this.events.push({ op: 'cancelScheduledValues', value: this.value, time: cancelTime });
    return this;
  }
}

class MockAudioNode implements AudioNodeLike {
  readonly connected = new Set<AudioNodeLike>();

  connect(destination: AudioNodeLike): AudioNodeLike {
    this.connected.add(destination);
    return destination;
  }

  disconnect(destination?: AudioNodeLike): void {
    if (destination) {
      this.connected.delete(destination);
    } else {
      this.connected.clear();
    }
  }
}

class MockGainNode extends MockAudioNode implements GainNodeLike {
  readonly gain = new MockAudioParam(1);
}

class MockBiquadFilterNode extends MockAudioNode implements BiquadFilterNodeLike {
  type: BiquadFilterType = 'peaking';
  readonly frequency = new MockAudioParam(1000);
  readonly gain = new MockAudioParam(0);
  readonly Q = new MockAudioParam(1);
}

class MockAnalyserNode extends MockAudioNode implements AnalyserNodeLike {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  minDecibels = -90;
  maxDecibels = -10;
  get frequencyBinCount(): number {
    return this.fftSize / 2;
  }
  getByteFrequencyData(array: Uint8Array): void {
    array.fill(42);
  }
}

class MockAudioContext implements AudioContextLike {
  state: 'suspended' | 'running' | 'closed' = 'running';
  currentTime = 10;
  readonly sampleRate: number;
  readonly destination: AudioNodeLike = new MockAudioNode();
  createMediaElementSourceCalls = 0;
  failBiquadAfterBind = false;
  closeCalls = 0;

  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
  }

  createMediaElementSource(): AudioNodeLike {
    this.createMediaElementSourceCalls += 1;
    return new MockAudioNode();
  }

  createGain(): GainNodeLike {
    return new MockGainNode();
  }

  createBiquadFilter(): BiquadFilterNodeLike {
    if (this.failBiquadAfterBind) {
      throw new Error('Simulated biquad creation failure after source bind');
    }
    return new MockBiquadFilterNode();
  }

  createAnalyser(): AnalyserNodeLike {
    return new MockAnalyserNode();
  }

  async resume(): Promise<void> {
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.state = 'closed';
    this.closeCalls += 1;
  }
}

class MockAudioElement implements AudioElementLike {
  src = '';
  currentTime = 0;
  duration = 180;
  volume = 1;
  muted = false;
  preload = 'metadata';
  crossOrigin: string | null = null;
  paused = true;
  ended = false;
  error: MediaErrorLike | null = null;
  private listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }

  load(): void {
    this.currentTime = 0;
    this.ended = false;
    this.error = null;
  }

  async play(): Promise<void> {
    this.paused = false;
    this.ended = false;
    this.emit('loadedmetadata');
    this.emit('playing');
  }

  pause(): void {
    this.paused = true;
    this.emit('pause');
  }
}

function makeTrack(id: string, title: string, extra?: Partial<TrackRecord>): TrackRecord {
  const now = new Date().toISOString();
  return {
    id,
    original_path: `D:\\Music\\${title}.flac`,
    normalized_path: `d:\\music\\${title.toLowerCase()}.flac`,
    title,
    artist: 'Test Artist',
    album: 'Test Album',
    duration_ms: 180000,
    codec: 'FLAC',
    container: 'FLAC',
    sample_rate_hz: 48000,
    bit_depth: 24,
    bitrate_bps: 1500000,
    file_size_bytes: 30000000,
    modified_at_ms: 1700000000000,
    status: 'available',
    added_at: now,
    updated_at: now,
    replaygain_track_gain_db: -5.5,
    replaygain_album_gain_db: -4.0,
    replaygain_track_peak: 0.95,
    replaygain_album_peak: 0.98,
    ...extra,
  };
}

test('AudioDspGraph preserves single MediaElementSource invariant, click-free branch gain sum === 1.0, and 10-band / 8-band filters', async () => {
  const ctx = new MockAudioContext(48000);
  const audio = new MockAudioElement();
  const dsp = new AudioDspGraph(audio, () => ctx);

  // Start with EQ disabled -> stays in lazy direct mode until initialized
  const settings = createDefaultAudioLabSettings(48000);
  dsp.setSettings(settings);
  assert.equal(dsp.getRuntimeSnapshot().mode, 'direct');
  assert.equal(ctx.createMediaElementSourceCalls, 0);

  // Enable Graphic EQ -> binds MediaElementSource ONCE
  settings.enabled = true;
  settings.slots.A.mode = 'graphic';
  settings.slots.A.graphicGainsDb = [4, 2, 0, -1, 0, 1.5, 2.5, 3, 2, 1];
  settings.slots.A.preampDb = -2;
  dsp.setSettings(settings);
  await dsp.ensureInitialized();
  await dsp.ensureInitialized(); // Repeated calls must NEVER re-create MediaElementSource!

  assert.equal(ctx.createMediaElementSourceCalls, 1, 'MediaElementSource must be created exactly once');
  assert.equal(dsp.getRuntimeSnapshot().mode, 'dsp');

  const nodes = dsp.getDebugNodes();
  assert.equal(nodes.graphicFilters.length, 10);
  assert.equal(nodes.parametricFilters.length, 8);
  assert.ok(nodes.branchGains.bypass && nodes.branchGains.graphic && nodes.branchGains.parametric);

  // Verify constant-sum branch gain invariant in Graphic mode (0 + 1 + 0 = 1)
  assert.equal(nodes.branchGains.bypass.gain.value, 0);
  assert.equal(nodes.branchGains.graphic.gain.value, 1);
  assert.equal(nodes.branchGains.parametric.gain.value, 0);
  assert.equal(nodes.graphicFilters[0].type, 'lowshelf');
  assert.equal(nodes.graphicFilters[9].type, 'highshelf');
  assert.equal(nodes.graphicFilters[0].gain.value, 4);
  assert.equal(nodes.graphicFilters[5].frequency.value, GRAPHIC_EQ_FREQUENCIES[5]);

  // Switch to Parametric mode -> branch sum remains strictly 1.0 (0 + 0 + 1)
  settings.slots.A.mode = 'parametric';
  const allTypes: ParametricFilterType[] = [
    'peaking',
    'lowshelf',
    'highshelf',
    'lowpass',
    'highpass',
    'notch',
  ];
  settings.slots.A.parametricBands = createDefaultParametricBands(48000).map((b, i) => ({
    ...b,
    enabled: i < 6,
    type: allTypes[i % allTypes.length],
    frequencyHz: [60, 150, 8000, 12000, 45, 2500, 5000, 10000][i],
    gainDb: i < 3 ? 3.5 : 0,
    q: 2.0,
  }));
  dsp.setSettings(settings);

  assert.equal(nodes.branchGains.bypass.gain.value, 0);
  assert.equal(nodes.branchGains.graphic.gain.value, 0);
  assert.equal(nodes.branchGains.parametric.gain.value, 1);
  assert.equal(nodes.parametricFilters[0].type, 'peaking');
  assert.equal(nodes.parametricFilters[1].type, 'lowshelf');
  assert.equal(nodes.parametricFilters[2].type, 'highshelf');
  assert.equal(nodes.parametricFilters[3].type, 'lowpass');
  assert.equal(nodes.parametricFilters[4].type, 'highpass');
  assert.equal(nodes.parametricFilters[5].type, 'notch');
  // Disabled band 6/7 should be neutralized to peaking 0 dB
  assert.equal(nodes.parametricFilters[6].type, 'peaking');
  assert.equal(nodes.parametricFilters[6].gain.value, 0);

  // Bypass EQ -> branch sum strictly 1.0 (1 + 0 + 0), preamp unity
  settings.enabled = false;
  dsp.setSettings(settings);
  assert.equal(nodes.branchGains.bypass.gain.value, 1);
  assert.equal(nodes.branchGains.graphic.gain.value, 0);
  assert.equal(nodes.branchGains.parametric.gain.value, 0);
  assert.ok(Math.abs((nodes.preamp?.gain.value ?? 0) - 1) < 1e-4);

  // Volume & Mute isolation from EQ / Preamp / ReplayGain
  dsp.setUserVolume(0.65);
  assert.ok(Math.abs((nodes.userVolume?.gain.value ?? 0) - 0.65) < 1e-4);
  dsp.setMuted(true);
  assert.equal(nodes.muteGain?.gain.value, 0);
  assert.ok(Math.abs((nodes.userVolume?.gain.value ?? 0) - 0.65) < 1e-4, 'Mute must preserve user volume');
  dsp.setMuted(false);
  assert.equal(nodes.muteGain?.gain.value, 1);

  // Auto Headroom + ReplayGain
  settings.enabled = true;
  settings.slots.A.mode = 'graphic';
  settings.slots.A.graphicGainsDb = [6, 6, 0, 0, 0, 0, 0, 0, 0, 0];
  settings.slots.A.preampDb = 0;
  settings.slots.A.autoHeadroom = true;
  dsp.setSettings(settings);
  const snap = dsp.getRuntimeSnapshot();
  assert.ok(snap.headroom.autoHeadroomOffsetDb < -5, 'Auto headroom must attenuate positive EQ boost');
  assert.ok(snap.headroom.effectivePreampDb < -5);

  const rgSettings = { mode: 'track' as const, preventClipping: true };
  const computedRg = computeReplayGainMultiplier(rgSettings, {
    trackGainDb: -6,
    albumGainDb: -4,
    trackPeak: 0.95,
    albumPeak: 0.98,
  });
  dsp.setReplayGain(rgSettings, computedRg);
  const rgSnap = dsp.getRuntimeSnapshot();
  assert.equal(rgSnap.activeReplayGain.applied, true);
  assert.equal(rgSnap.activeReplayGain.source, 'track');
  assert.ok(Math.abs((nodes.replayGain?.gain.value ?? 0) - dbToLinearGain(-6)) < 0.01);

  dsp.dispose();
  assert.equal(ctx.closeCalls, 1);
});

test('AudioDspGraph recovers gracefully on both pre-bind and post-bind DSP errors without silencing audio', async () => {
  // 1) Pre-bind failure (Web Audio unavailable) -> stays unbound direct mode
  const audio1 = new MockAudioElement();
  const dspPreFail = new AudioDspGraph(audio1, null);
  const ok1 = await dspPreFail.ensureInitialized();
  assert.equal(ok1, false);
  assert.equal(dspPreFail.isSourceBound(), false);

  // 2) Post-bind failure (biquad throws AFTER createMediaElementSource) -> emergency volume bypass to destination
  const ctx2 = new MockAudioContext(48000);
  ctx2.failBiquadAfterBind = true;
  const audio2 = new MockAudioElement();
  const dspPostFail = new AudioDspGraph(audio2, () => ctx2);
  dspPostFail.setUserVolume(0.5);
  const ok2 = await dspPostFail.ensureInitialized();
  assert.equal(ok2, false);
  assert.equal(dspPostFail.getRuntimeSnapshot().mode, 'error');
  assert.equal(dspPostFail.isSourceBound(), true);
  const emergency = dspPostFail.getDebugNodes().emergencyVolume;
  assert.ok(emergency, 'Post-bind fallback must route through emergency volume node');
  assert.ok(Math.abs(emergency.gain.value - 0.5) < 1e-4);
  dspPostFail.setMuted(true);
  assert.equal(emergency.gain.value, 0, 'Mute must still work in post-bind fallback mode');
  dspPostFail.setMuted(false);
  dspPostFail.setUserVolume(0.8);
  assert.ok(Math.abs(emergency.gain.value - 0.8) < 1e-4);
});

test('AudioEngine cancels active Fade Promises cleanly on rapid Next / Previous / Pause without stalling or sticking at 0 gain', async () => {
  const fakeAudio = new MockAudioElement();
  const ctx = new MockAudioContext(48000);
  const t1 = makeTrack('11111111-1111-4111-8111-111111111111', 'Track One');
  const t2 = makeTrack('22222222-2222-4222-8222-222222222222', 'Track Two');
  const t3 = makeTrack('33333333-3333-4333-8333-333333333333', 'Track Three');

  const engine = new AudioEngine({
    createAudioElement: () => fakeAudio,
    createAudioContext: () => ctx,
    verifyTrack: async (id) => ({ trackId: id, exists: true, status: 'available' }),
  });

  engine.setQueue([t1, t2, t3]);
  engine.setVolume(0.75);
  engine.setTransitionConfig({ enabled: true, durationSec: 2 });
  const eqOn = createDefaultAudioLabSettings(48000);
  eqOn.enabled = true;
  engine.setAudioLabSettings(eqOn);

  // Rapid fire play -> next -> next; all Promises MUST settle quickly!
  const p1 = engine.play(t1.id);
  const p2 = engine.next();
  const p3 = engine.next();

  const settled = await Promise.race([
    Promise.all([p1, p2, p3]).then(() => 'settled'),
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 1500)),
  ]);

  assert.equal(settled, 'settled', 'Rapid fade transitions must never hang awaiting canceled fade promises');
  assert.equal(engine.getPlaybackState().currentTrackId, t3.id);
  assert.equal(engine.getPlaybackState().status, 'playing');
  assert.equal(engine.getPlaybackState().volume, 0.75, 'User volume must remain untouched by fade transitions');

  engine.pause();
  assert.equal(engine.getPlaybackState().status, 'paused');
  engine.dispose();
});

test('RBJ Frequency Response calculator and Headroom analysis match filter math accurately', () => {
  // Peaking filter +6 dB at 1000 Hz should evaluate ~+6 dB at 1000 Hz and ~0 dB far away
  const atCenter = evaluateBiquadMagnitudeDb('peaking', 1000, 6, 1.4, 1000, 48000);
  const farLow = evaluateBiquadMagnitudeDb('peaking', 1000, 6, 1.4, 30, 48000);
  assert.ok(Math.abs(atCenter - 6) < 0.05, `Expected ~+6 dB at center, got ${atCenter}`);
  assert.ok(Math.abs(farLow) < 0.2, `Expected ~0 dB far from center, got ${farLow}`);

  // Notch filter at 1000 Hz must strongly attenuate at 1000 Hz
  const atNotch = evaluateBiquadMagnitudeDb('notch', 1000, 0, 4, 1000, 48000);
  assert.ok(atNotch < -30, `Expected deep notch attenuation, got ${atNotch}`);

  // Lowpass at 1000 Hz must pass 100 Hz (~0 dB) and attenuate 10000 Hz (<-30 dB)
  const lpfPass = evaluateBiquadMagnitudeDb('lowpass', 1000, 0, 0.707, 100, 48000);
  const lpfStop = evaluateBiquadMagnitudeDb('lowpass', 1000, 0, 0.707, 10000, 48000);
  assert.ok(Math.abs(lpfPass) < 0.2);
  assert.ok(lpfStop < -30);

  // Composite response & headroom
  const settings = createDefaultAudioLabSettings(48000);
  settings.slots.A.graphicGainsDb = [6, 5, 0, 0, 0, 0, 0, 0, 0, 0];
  settings.slots.A.autoHeadroom = false;
  const riskHigh = computeHeadroomAnalysis(settings.slots.A, true, 48000, 0);
  assert.equal(riskHigh.clippingRisk, 'high');

  settings.slots.A.autoHeadroom = true;
  const riskSafe = computeCompositeFrequencyResponse(settings.slots.A, true, 48000);
  assert.equal(riskSafe.headroom.clippingRisk, 'none');
  assert.equal(SYSTEM_AUDIO_PRESETS.length, 7);
});

test('ProfileService persists AudioLabSettings (including custom presets & A/B slots) and ReplayGain in SQLite across restart', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-phase7-profile-'));
  const dbPath = path.join(tempDir, 'library.db');
  try {
    const conn1 = openLibraryDatabase(dbPath);
    const service1 = new ProfileService({ db: conn1.db, userDataDir: tempDir });

    const audioLab = createDefaultAudioLabSettings(48000);
    audioLab.enabled = true;
    audioLab.activeSlot = 'B';
    audioLab.slots.B.mode = 'parametric';
    audioLab.slots.B.preampDb = -2.5;
    audioLab.slots.B.autoHeadroom = true;
    audioLab.slots.B.parametricBands[0].gainDb = 4.5;
    audioLab.customPresets.push({
      id: 'custom-night-iem',
      name: 'Night IEM',
      description: 'Warm night curve',
      isSystem: false,
      mode: 'parametric',
      graphicGainsDb: [2, 1, 0, 0, 0, -1, -1, 0, 0, 0],
      parametricBands: audioLab.slots.B.parametricBands,
      preampDb: -2.5,
      autoHeadroom: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    service1.updatePreferences({
      audioLab,
      replayGain: { mode: 'album', preventClipping: true },
    });
    conn1.close();

    // Reopen fresh SQLite connection to verify offline restart persistence
    const conn2 = openLibraryDatabase(dbPath);
    const service2 = new ProfileService({ db: conn2.db, userDataDir: tempDir });
    const loaded = service2.getPreferences();

    assert.equal(loaded.audioLab?.enabled, true);
    assert.equal(loaded.audioLab?.activeSlot, 'B');
    assert.equal(loaded.audioLab?.slots.B.mode, 'parametric');
    assert.equal(loaded.audioLab?.slots.B.preampDb, -2.5);
    assert.equal(loaded.audioLab?.slots.B.autoHeadroom, true);
    assert.equal(loaded.audioLab?.slots.B.parametricBands[0].gainDb, 4.5);
    assert.equal(loaded.audioLab?.customPresets.length, 1);
    assert.equal(loaded.audioLab?.customPresets[0].name, 'Night IEM');
    assert.equal(loaded.replayGain?.mode, 'album');
    assert.equal(loaded.replayGain?.preventClipping, true);

    conn2.close();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
