import { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  RotateCcw,
  ShieldAlert,
  SlidersHorizontal,
} from 'lucide-react';
import type { ReplayGainMode } from '../../../shared/types/stage6';
import {
  computeHeadroomAnalysis,
  formatDbLabel,
  getActiveSlotConfig,
  getAllPresets,
  PREAMP_MAX_DB,
  PREAMP_MIN_DB,
} from '../../../shared/utils/audio-dsp';
import { AudioLabPresetManager } from '../components/AudioLabPresetManager';
import { FrequencyResponseGraph } from '../components/FrequencyResponseGraph';
import { GraphicEqPanel } from '../components/GraphicEqPanel';
import { ParametricEqPanel } from '../components/ParametricEqPanel';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { useAudioDspState, usePlaybackState } from '../stores/player-store';
import { uiStore, useUiState } from '../stores/ui-store';

const REPLAYGAIN_OPTIONS: Array<{ value: ReplayGainMode; label: string }> = [
  { value: 'off', label: 'Tắt' },
  { value: 'track', label: 'Theo bài (Track)' },
  { value: 'album', label: 'Theo album (Album)' },
];

export function AudioLabPage() {
  const ui = useUiState();
  const player = usePlaybackState();
  const dsp = useAudioDspState();
  const userAccent = uiStore.getUserAccentPalette();
  const [selectedParametricIndex, setSelectedParametricIndex] = useState<number | null>(0);

  const audioLab = uiStore.getAudioLabSettings();
  const replayGain = uiStore.getReplayGainSettings();
  const activeSlot = getActiveSlotConfig(audioLab);
  const allPresets = useMemo(() => getAllPresets(audioLab), [audioLab]);

  const activePreset = useMemo(
    () => allPresets.find((p) => p.id === activeSlot.activePresetId) ?? null,
    [allPresets, activeSlot.activePresetId],
  );

  const isElectronDesktop =
    typeof window !== 'undefined' && Boolean(window.losslessApi);

  const effectiveSampleRate = dsp.sampleRate || 48000;
  const activeReplayGainDb = dsp.activeReplayGain.applied ? dsp.activeReplayGain.gainDb : 0;

  const headroom = useMemo(
    () =>
      computeHeadroomAnalysis(
        activeSlot,
        audioLab.enabled,
        effectiveSampleRate,
        activeReplayGainDb,
      ),
    [activeSlot, audioLab.enabled, effectiveSampleRate, activeReplayGainDb],
  );

  const runtimeStatusText = (() => {
    if (!isElectronDesktop) {
      return 'Preview Mode · Desktop Playback Unavailable (cấu hình & biểu đồ đáp tuyến được lưu cục bộ)';
    }
    if (dsp.mode === 'error') {
      return `DSP Error Fallback · ${dsp.lastError || 'Đang phát trực tiếp không qua bộ lọc'}`;
    }
    if (dsp.mode === 'fallback-direct') {
      return 'Fallback Direct · Web Audio không khả dụng, phát nguyên bản không qua EQ';
    }
    if (dsp.mode === 'dsp' && dsp.contextState === 'running') {
      const srKhz = Number((effectiveSampleRate / 1000).toFixed(1));
      return audioLab.enabled
        ? `Web Audio DSP Active · ${srKhz} kHz · ${activeSlot.mode === 'parametric' ? 'Parametric 8-Band' : 'Graphic 10-Band'}`
        : `Web Audio DSP Bypass · ${srKhz} kHz · Tín hiệu đi thẳng 0 dB`;
    }
    if (player.status === 'playing' && ui.activeSource === 'local') {
      return audioLab.enabled
        ? 'DSP Sẵn Sàng · Đang đồng bộ với bài hát hiện tại'
        : 'Direct Playback · Bật EQ để kích hoạt chuỗi lọc Web Audio';
    }
    return audioLab.enabled
      ? 'DSP Sẵn Sàng · Sẽ lọc âm thanh thật ngay khi phát file nhạc cục bộ'
      : 'EQ Đang Tắt (Bypass) · Chọn bài nhạc cục bộ và bật EQ để xử lý âm thanh';
  })();

  const clippingMeta = (() => {
    if (headroom.clippingRisk === 'high') {
      return {
        label: 'Nguy cơ clipping cao — hãy giảm Preamp hoặc bật Auto Headroom',
        textClass: 'text-rose-600 dark:text-rose-300',
        Icon: ShieldAlert,
      };
    }
    if (headroom.clippingRisk === 'moderate') {
      return {
        label: 'Biên độ đỉnh vượt 0 dB — nên bật Auto Headroom khi nghe nhạc thu lớn',
        textClass: 'text-amber-600 dark:text-amber-300',
        Icon: AlertTriangle,
      };
    }
    return {
      label: 'Headroom an toàn (≤ +0.5 dB)',
      textClass: 'text-emerald-600 dark:text-emerald-300',
      Icon: CheckCircle2,
    };
  })();

  const ClippingIcon = clippingMeta.Icon;
  const spectrumLive =
    isElectronDesktop &&
    dsp.mode === 'dsp' &&
    dsp.contextState === 'running' &&
    dsp.analyserAvailable &&
    player.status === 'playing';

  return (
    <div
      data-testid="audio-lab-page"
      className="mx-auto w-full max-w-[1240px] space-y-5 pb-36 pt-2"
    >
      {/* Top Studio Header */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
            Audio DSP Instrument
          </p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
            <h1 className="font-display text-[30px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
              Audio Lab
            </h1>
            <span
              data-testid="audio-lab-active-preset-label"
              className="text-[13px] font-medium text-[var(--text-secondary)]"
            >
              Preset: <strong className="font-semibold text-[var(--text-primary)]">{activePreset ? activePreset.name : 'Tùy chỉnh'}</strong>
              {' · '}Slot {audioLab.activeSlot}
            </span>
          </div>
          <p
            data-testid="audio-lab-runtime-status"
            className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--text-secondary)]"
          >
            {runtimeStatusText}
          </p>
        </div>

        {/* Master EQ Enable Switch */}
        <div className="lp-glass-panel flex shrink-0 items-center gap-4 rounded-2xl px-4 py-3">
          <div className="text-right">
            <span className="block text-[13px] font-semibold text-[var(--text-primary)]">
              Equalizer DSP
            </span>
            <span
              data-testid="audio-lab-enabled-text"
              className="block text-[11.5px] font-medium"
              style={{
                color: audioLab.enabled ? userAccent.activeHex : 'var(--text-muted)',
              }}
            >
              {audioLab.enabled ? 'Đang bật (Active)' : 'Đang tắt (Bypass)'}
            </span>
          </div>
          <ToggleSwitch
            checked={audioLab.enabled}
            onChange={(next) => uiStore.setAudioLabEnabled(next)}
            ariaLabel="Bật hoặc tắt Equalizer DSP"
            accentHex={userAccent.activeHex}
            testId="audio-lab-master-toggle"
          />
        </div>
      </header>

      {/* Instrument Control Bar: Mode Switch, A/B Comparison, Bypass, Spectrum, Reset Flat */}
      <div className="lp-glass-panel flex flex-wrap items-center justify-between gap-3 rounded-[20px] px-4 py-3">
        {/* Left: EQ Mode Segmented Control */}
        <div
          role="tablist"
          aria-label="Chọn chế độ Equalizer"
          className="inline-flex items-center rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/70 p-1"
        >
          {(
            [
              { id: 'graphic', label: 'Graphic EQ (10-Band)' },
              { id: 'parametric', label: 'Parametric EQ (8-Band)' },
            ] as const
          ).map((modeOpt) => {
            const active = activeSlot.mode === modeOpt.id;
            return (
              <button
                key={modeOpt.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`audio-lab-mode-${modeOpt.id}`}
                onClick={() => uiStore.setEqMode(modeOpt.id)}
                style={
                  active
                    ? {
                        backgroundColor: userAccent.activeHex,
                        color: 'var(--user-accent-on)',
                      }
                    : undefined
                }
                className={`whitespace-nowrap rounded-lg px-3.5 py-1.5 text-[12.5px] font-semibold transition ${
                  active
                    ? 'shadow-sm'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {modeOpt.label}
              </button>
            );
          })}
        </div>

        {/* Center: A/B Comparison */}
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="So sánh cấu hình A/B"
            className="inline-flex items-center rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/70 p-1"
          >
            {(['A', 'B'] as const).map((slotId) => {
              const active = audioLab.activeSlot === slotId;
              return (
                <button
                  key={slotId}
                  type="button"
                  data-testid={`audio-lab-slot-${slotId}`}
                  aria-pressed={active}
                  onClick={() => uiStore.setActiveEqSlot(slotId)}
                  style={
                    active
                      ? {
                          backgroundColor: `rgba(${userAccent.glowRgb}, 0.24)`,
                          color: userAccent.activeHex,
                        }
                      : undefined
                  }
                  className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-[12px] font-semibold transition ${
                    active
                      ? ''
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  Slot {slotId}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            data-testid="audio-lab-copy-slot-btn"
            onClick={() => uiStore.copyActiveEqSlotToOther()}
            className="lp-btn-ghost inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl px-3 text-[12px] font-medium text-[var(--text-primary)]"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            <span>
              Chép {audioLab.activeSlot}→{audioLab.activeSlot === 'A' ? 'B' : 'A'}
            </span>
          </button>
        </div>

        {/* Right: Quick Bypass, Spectrum, Reset Flat */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="audio-lab-bypass-btn"
            aria-pressed={!audioLab.enabled}
            onClick={() => uiStore.setAudioLabEnabled(!audioLab.enabled)}
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border px-3 text-[12px] font-semibold transition ${
              !audioLab.enabled
                ? 'border-amber-500/45 bg-amber-500/15 text-amber-700 dark:text-amber-300'
                : 'border-[var(--border-subtle)] bg-[var(--bg-elevated)]/65 text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span>{audioLab.enabled ? 'Bypass tạm thời' : 'Đang Bypass'}</span>
          </button>

          <button
            type="button"
            data-testid="audio-lab-spectrum-btn"
            aria-pressed={audioLab.spectrumEnabled}
            onClick={() => uiStore.setSpectrumEnabled(!audioLab.spectrumEnabled)}
            title={
              isElectronDesktop
                ? 'Hiển thị lớp phổ tần FFT trực tiếp từ AnalyserNode khi phát nhạc'
                : 'Phổ FFT trực tiếp chỉ chạy trên ứng dụng Windows Desktop khi có âm thanh thật'
            }
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border px-3 text-[12px] font-medium transition ${
              audioLab.spectrumEnabled
                ? 'border-[var(--border-glass)] bg-[var(--surface-hover)] text-[var(--text-primary)]'
                : 'border-[var(--border-subtle)] bg-[var(--bg-elevated)]/65 text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Activity className="h-3.5 w-3.5" />
            <span>Spectrum</span>
          </button>

          <button
            type="button"
            data-testid="audio-lab-reset-flat-btn"
            onClick={() => uiStore.resetActiveEqSlotToFlat()}
            className="lp-btn-ghost inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl px-3 text-[12px] font-medium text-[var(--text-primary)]"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Reset Flat</span>
          </button>
        </div>
      </div>

      {/* Hero Interactive Frequency Response Graph */}
      <FrequencyResponseGraph
        slot={activeSlot}
        eqEnabled={audioLab.enabled}
        sampleRate={effectiveSampleRate}
        spectrumEnabled={audioLab.spectrumEnabled}
        spectrumActive={spectrumLive}
        reducedMotion={ui.preferences.reducedMotion}
        accentHex={userAccent.activeHex}
        accentGlowRgb={userAccent.glowRgb}
        selectedParametricIndex={selectedParametricIndex}
        onSelectParametricIndex={setSelectedParametricIndex}
        onGraphicBandChange={(idx, gainDb) => uiStore.setGraphicBandGain(idx, gainDb)}
        onGraphicBandReset={(idx) => uiStore.setGraphicBandGain(idx, 0)}
        onParametricBandChange={(idx, patch) => uiStore.updateParametricBand(idx, patch)}
        onParametricBandReset={(idx) => uiStore.resetParametricBand(idx)}
      />

      {/* Preamp, Auto Headroom, Clipping Guard & ReplayGain Control Deck */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.35fr_1fr]">
        {/* Preamp & Headroom Safety */}
        <section
          data-testid="audio-lab-preamp-section"
          className="rounded-[22px] border border-[var(--border-glass)] bg-[var(--surface-glass-light)] p-4 sm:p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-[14.5px] font-semibold text-[var(--text-primary)]">
                Preamp & Auto Headroom
              </h2>
              <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                Kiểm soát mức đầu vào trước chuỗi lọc EQ để hạn chế vỡ tiếng khi tăng nhiều băng tần
              </p>
            </div>
            <span
              data-testid="audio-lab-preamp-value"
              className="font-mono-tabular text-[14px] font-semibold"
              style={{ color: userAccent.activeHex }}
            >
              {formatDbLabel(activeSlot.preampDb, 1)}
            </span>
          </div>

          <div className="mt-3.5 flex items-center gap-3">
            <span className="font-mono-tabular w-11 text-[11px] text-[var(--text-muted)]">
              -12 dB
            </span>
            <input
              type="range"
              min={PREAMP_MIN_DB}
              max={PREAMP_MAX_DB}
              step={0.5}
              value={activeSlot.preampDb}
              data-testid="audio-lab-preamp-slider"
              aria-label="Điều chỉnh Preamp dB"
              onChange={(e) => uiStore.setEqPreampDb(Number(e.target.value))}
              onDoubleClick={() => uiStore.setEqPreampDb(0)}
              className="lp-slider h-4 flex-1 accent-[var(--user-accent)]"
            />
            <span className="font-mono-tabular w-11 text-right text-[11px] text-[var(--text-muted)]">
              +12 dB
            </span>
            <button
              type="button"
              data-testid="audio-lab-preamp-reset"
              onClick={() => uiStore.setEqPreampDb(0)}
              className="lp-btn-ghost h-7 shrink-0 whitespace-nowrap rounded-lg px-2.5 text-[11.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              0 dB
            </button>
          </div>

          <div className="mt-4 flex items-center justify-between gap-4 border-t border-[var(--border-subtle)] pt-3.5">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-[var(--text-primary)]">
                Tự động bù khoảng dự trữ (Auto Headroom)
              </p>
              <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                Tự động hạ nhẹ Preamp tương ứng đỉnh boost dương lớn nhất của EQ (hiện bù{' '}
                <span className="font-mono-tabular text-[var(--text-primary)]">
                  {formatDbLabel(headroom.autoHeadroomOffsetDb, 1)}
                </span>
                )
              </p>
            </div>
            <ToggleSwitch
              checked={activeSlot.autoHeadroom}
              onChange={(next) => uiStore.setEqAutoHeadroom(next)}
              ariaLabel="Bật hoặc tắt Auto Headroom"
              accentHex={userAccent.activeHex}
              testId="audio-lab-auto-headroom-toggle"
            />
          </div>

          {/* Numeric Headroom Telemetry + Non-Hue-Only Clipping Risk Readout */}
          <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] pt-3 text-[11.5px]">
            <div className="font-mono-tabular flex flex-wrap items-center gap-x-3 gap-y-1 text-[var(--text-secondary)]">
              <span>
                Max EQ Boost: <strong className="text-[var(--text-primary)]">{formatDbLabel(headroom.maxEqBoostDb, 1)}</strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Preamp thực tế: <strong className="text-[var(--text-primary)]">{formatDbLabel(headroom.effectivePreampDb, 1)}</strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Đỉnh tổng: <strong className="text-[var(--text-primary)]">{formatDbLabel(headroom.peakTotalResponseDb, 1)}</strong>
              </span>
            </div>
            <div
              data-testid="audio-lab-clipping-risk"
              data-risk={headroom.clippingRisk}
              className={`inline-flex items-center gap-1.5 font-medium ${clippingMeta.textClass}`}
            >
              <ClippingIcon className="h-3.5 w-3.5 shrink-0" />
              <span>{clippingMeta.label}</span>
            </div>
          </div>
        </section>

        {/* ReplayGain Controls (Synced 2-way with Settings > Playback & AudioEngine) */}
        <section
          data-testid="audio-lab-replaygain-section"
          className="rounded-[22px] border border-[var(--border-glass)] bg-[var(--surface-glass-light)] p-4 sm:p-5"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="font-display text-[14.5px] font-semibold text-[var(--text-primary)]">
                ReplayGain (Cân bằng âm lượng)
              </h2>
              <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                Chỉ đọc thẻ ReplayGain có sẵn trong file gốc — không tự đoán và không sửa file
              </p>
            </div>
            <span className="font-mono-tabular shrink-0 text-[12px] font-semibold text-[var(--text-secondary)]">
              {dsp.activeReplayGain.applied
                ? `${formatDbLabel(dsp.activeReplayGain.gainDb, 2)} (${dsp.activeReplayGain.source})`
                : '0.0 dB'}
            </span>
          </div>

          <div className="mt-3.5 grid grid-cols-3 gap-1.5">
            {REPLAYGAIN_OPTIONS.map((opt) => {
              const selected = replayGain.mode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  data-testid={`audio-lab-rg-${opt.value}`}
                  onClick={() => uiStore.updateReplayGainSettings({ mode: opt.value })}
                  style={
                    selected
                      ? {
                          backgroundColor: `rgba(${userAccent.glowRgb}, 0.2)`,
                          borderColor: userAccent.activeHex,
                          color: userAccent.activeHex,
                        }
                      : undefined
                  }
                  className={`rounded-xl border px-2.5 py-2 text-[12px] font-semibold transition ${
                    selected
                      ? ''
                      : 'border-[var(--border-subtle)] bg-[var(--bg-elevated)]/65 text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex items-center justify-between gap-4 border-t border-[var(--border-subtle)] pt-3.5">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-[var(--text-primary)]">
                Chống clipping theo đỉnh ReplayGain
              </p>
              <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                Giới hạn hệ số khuếch đại dưới 0 dBFS dựa trên thẻ peak của bản thu
              </p>
            </div>
            <ToggleSwitch
              checked={replayGain.preventClipping}
              onChange={(next) =>
                uiStore.updateReplayGainSettings({ preventClipping: next })
              }
              ariaLabel="Chống clipping ReplayGain"
              accentHex={userAccent.activeHex}
              testId="audio-lab-rg-clipping-toggle"
            />
          </div>
        </section>
      </div>

      {/* Active EQ Editor (Graphic 10-Band OR Parametric 8-Band) */}
      {activeSlot.mode === 'graphic' ? (
        <GraphicEqPanel
          gainsDb={activeSlot.graphicGainsDb}
          eqEnabled={audioLab.enabled}
          accentHex={userAccent.activeHex}
          accentGlowRgb={userAccent.glowRgb}
          onBandChange={(idx, gainDb) => uiStore.setGraphicBandGain(idx, gainDb)}
          onBandReset={(idx) => uiStore.setGraphicBandGain(idx, 0)}
          onResetAll={() => uiStore.resetGraphicBands()}
        />
      ) : (
        <ParametricEqPanel
          bands={activeSlot.parametricBands}
          sampleRate={effectiveSampleRate}
          eqEnabled={audioLab.enabled}
          accentHex={userAccent.activeHex}
          accentGlowRgb={userAccent.glowRgb}
          selectedIndex={selectedParametricIndex}
          onSelectIndex={setSelectedParametricIndex}
          onBandChange={(idx, patch) => uiStore.updateParametricBand(idx, patch)}
          onBandReset={(idx) => uiStore.resetParametricBand(idx)}
          onResetAll={() => uiStore.resetParametricBands()}
        />
      )}

      {/* System & Custom Preset Manager */}
      <AudioLabPresetManager
        activePresetId={activeSlot.activePresetId}
        customPresets={audioLab.customPresets}
        accentHex={userAccent.activeHex}
        accentGlowRgb={userAccent.glowRgb}
        onApplyPreset={(presetId) => uiStore.applyEqPreset(presetId)}
        onSaveNewPreset={(name) => uiStore.saveCustomEqPreset(name)}
        onRenamePreset={(id, nextName) => uiStore.renameCustomEqPreset(id, nextName)}
        onDuplicatePreset={(id) => uiStore.duplicateEqPreset(id)}
        onDeletePreset={(id) => uiStore.deleteCustomEqPreset(id)}
        onResetFlat={() => uiStore.resetActiveEqSlotToFlat()}
      />
    </div>
  );
}
