import { lazy, Suspense, useState } from 'react';
import {
  ArrowUpRight,
  AudioWaveform,
  BookOpen,
  Check,
  Database,
  FolderOpen,
  Info,
  PlayCircle,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import type { FadeDurationSec } from '../../../shared/types/stage5';
import type { ReplayGainMode } from '../../../shared/types/stage6';
import { getActiveSlotConfig, getAllPresets } from '../../../shared/utils/audio-dsp';
import { REPEAT_MODE_LABELS } from '../../../shared/utils/playback-controls';
import { SettingToggleRow } from '../components/ToggleSwitch';
import { useLibraryState } from '../stores/library-store';
import { useAudioDspState } from '../stores/player-store';
import { uiStore, useUiState } from '../stores/ui-store';

const AboutSection = lazy(() =>
  import('../features/about/AboutSection').then((m) => ({ default: m.AboutSection })),
);
const UserGuideSection = lazy(() =>
  import('../features/user-guide/UserGuideSection').then((m) => ({
    default: m.UserGuideSection,
  })),
);

type SettingsSection = 'playback' | 'library' | 'backup' | 'guide' | 'about';

const FADE_OPTIONS: FadeDurationSec[] = [0.5, 1, 2, 3];

/**
 * M5.2 & M5.5 Settings Page
 * - "Cá nhân hóa" links directly to the unified Profile & Personalization Hub (zero duplicate Appearance UI)
 * - "Phát nhạc" holds real Chuyển bài mượt (Fade In/Out) settings synced two-way with Now Playing
 */
export function SettingsPage() {
  const ui = useUiState();
  const library = useLibraryState();
  const dsp = useAudioDspState();
  const userAccent = uiStore.getUserAccentPalette();
  const [section, setSection] = useState<SettingsSection>('playback');

  const { enabled: fadeEnabled, durationSec: fadeDurationSec } = ui.preferences.transition;
  const audioLab = uiStore.getAudioLabSettings();
  const replayGain = uiStore.getReplayGainSettings();
  const activeEqSlot = getActiveSlotConfig(audioLab);
  const activeEqPreset =
    getAllPresets(audioLab).find((p) => p.id === activeEqSlot.activePresetId) ?? null;
  const isElectronDesktop =
    typeof window !== 'undefined' && Boolean(window.losslessApi);

  const navItems: Array<{ id: SettingsSection; label: string; icon: typeof PlayCircle }> = [
    { id: 'playback', label: 'Phát nhạc', icon: PlayCircle },
    { id: 'library', label: 'Thư viện nhạc', icon: FolderOpen },
    { id: 'backup', label: 'Dữ liệu & Sao lưu', icon: Database },
    { id: 'guide', label: 'Hướng dẫn sử dụng', icon: BookOpen },
    { id: 'about', label: 'Giới thiệu', icon: Info },
  ];

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-6 pb-36 pt-2">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
          Desktop Preferences
        </p>
        <h1 className="font-display mt-1 text-[30px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
          Cài đặt
        </h1>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[268px_1fr]">
        {/* Left Settings Sidebar */}
        <nav className="lp-glass-panel h-fit space-y-1.5 rounded-[24px] p-3">
          {/* Direct link to unified Profile & Personalization Hub (M5.2) */}
          <button
            type="button"
            onClick={() => uiStore.openProfileHub()}
            data-testid="settings-open-personalization-btn"
            style={{
              backgroundColor: `rgba(${userAccent.glowRgb}, 0.12)`,
              borderColor: `rgba(${userAccent.glowRgb}, 0.30)`,
            }}
            className="mb-2 flex w-full items-center justify-between gap-2 rounded-2xl border px-4 py-3 text-left text-[13.5px] font-semibold text-[var(--text-primary)] transition hover:brightness-110"
          >
            <span className="flex items-center gap-3">
              <Sparkles className="h-4 w-4 shrink-0" style={{ color: userAccent.activeHex }} />
              <span>Cá nhân hóa</span>
            </span>
            <ArrowUpRight className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
          </button>

          {navItems.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                data-testid={`settings-nav-${item.id}`}
                onClick={() => setSection(item.id)}
                className={`flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left text-[13.5px] font-medium transition ${
                  active
                    ? 'bg-[var(--surface-hover)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-glass-light)] hover:text-[var(--text-primary)]'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Right Content Panel */}
        <div className="lp-glass-panel rounded-[26px] p-7">
          {section === 'playback' && (
            <div className="space-y-6">
              <div>
                <h2 className="font-display text-[20px] font-semibold text-[var(--text-primary)]">
                  Phát nhạc
                </h2>
                <p className="mt-1 text-[13px] text-[var(--text-muted)]">
                  Cấu hình bộ máy phát âm thanh lossless cục bộ và hiệu ứng chuyển bài mượt.
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-4 text-[13px]">
                <p className="font-medium text-[var(--text-primary)]">
                  AudioEngine Lossless Cục Bộ (HTMLAudioElement + Custom Stream Protocol)
                </p>
                <p className="mt-1 text-[12.5px] text-[var(--text-secondary)]">
                  Phát trực tiếp file FLAC, WAV, ALAC, MP3, OGG, M4A trên máy Windows mà không sửa file nhạc gốc và không cần Internet.
                </p>
              </div>

              {/* Real Fade In/Out Transition Control — Two-Way Synced with Now Playing */}
              <div
                data-testid="settings-fade-section"
                className="rounded-2xl border border-[var(--border-glass)] bg-[var(--surface-glass-light)] p-5"
              >
                <SettingToggleRow
                  variant="compact"
                  label="Chuyển bài mượt (Fade In / Fade Out)"
                  description="Hạ nhẹ âm lượng bài đang phát và tăng mượt khi sang bài mới mà không làm đổi mức âm lượng bạn đã chọn. Đồng bộ hai chiều với nút Fade trên màn hình Đang phát."
                  checked={fadeEnabled}
                  onChange={(next) => uiStore.updateTransitionSettings({ enabled: next })}
                  accentHex={userAccent.activeHex}
                  testId="settings-fade-toggle"
                  leadingIcon={
                    <div
                      className="flex h-9 w-9 items-center justify-center rounded-xl"
                      style={{
                        backgroundColor: `rgba(${userAccent.glowRgb}, 0.16)`,
                        color: userAccent.activeHex,
                      }}
                    >
                      <AudioWaveform className="h-4.5 w-4.5" />
                    </div>
                  }
                />

                <div className="mt-4 border-t border-[var(--border-subtle)] pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-[12.5px] font-medium text-[var(--text-secondary)]">
                      Thời lượng chuyển mượt
                    </span>
                    <span
                      data-testid="settings-fade-status"
                      className="text-[12px] font-semibold"
                      style={{
                        color: fadeEnabled ? userAccent.activeHex : 'var(--text-muted)',
                      }}
                    >
                      {fadeEnabled ? `Đang bật · ${fadeDurationSec}s` : 'Đang tắt'}
                    </span>
                  </div>

                  <div className="mt-2.5 grid grid-cols-4 gap-2">
                    {FADE_OPTIONS.map((sec) => {
                      const selected = fadeDurationSec === sec;
                      return (
                        <button
                          key={sec}
                          type="button"
                          data-testid={`settings-fade-duration-${sec}`}
                          onClick={() =>
                            uiStore.updateTransitionSettings({
                              enabled: true,
                              durationSec: sec,
                            })
                          }
                          style={
                            selected
                              ? {
                                  backgroundColor: `rgba(${userAccent.glowRgb}, 0.2)`,
                                  borderColor: userAccent.activeHex,
                                  color: userAccent.activeHex,
                                }
                              : undefined
                          }
                          className={`flex items-center justify-center gap-1 rounded-xl border py-2 text-[13px] font-semibold transition ${
                            selected
                              ? ''
                              : 'border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
                          }`}
                        >
                          {selected && <Check className="h-3.5 w-3.5" />}
                          {sec}s
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Phase 7: Audio Lab / Equalizer & ReplayGain Section (Two-Way Synced) */}
              <div
                data-testid="settings-audio-lab-section"
                className="space-y-4 rounded-2xl border border-[var(--border-glass)] bg-[var(--surface-glass-light)] p-5"
              >
                <SettingToggleRow
                  variant="compact"
                  label="Audio Lab / Equalizer DSP"
                  description="Chuỗi lọc Web Audio Graphic 10-band & Parametric 8-band chạy hoàn toàn offline mà không thay đổi file nhạc gốc."
                  checked={audioLab.enabled}
                  onChange={(next) => uiStore.setAudioLabEnabled(next)}
                  accentHex={userAccent.activeHex}
                  testId="settings-eq-toggle"
                  leadingIcon={
                    <div
                      className="flex h-9 w-9 items-center justify-center rounded-xl"
                      style={{
                        backgroundColor: `rgba(${userAccent.glowRgb}, 0.16)`,
                        color: userAccent.activeHex,
                      }}
                    >
                      <SlidersHorizontal className="h-4.5 w-4.5" />
                    </div>
                  }
                />

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-3.5 text-[12.5px]">
                  <div className="space-y-0.5">
                    <p
                      data-testid="settings-eq-preset-summary"
                      className="font-medium text-[var(--text-primary)]"
                    >
                      Preset hiện tại:{' '}
                      <span style={{ color: userAccent.activeHex }}>
                        {activeEqPreset ? activeEqPreset.name : 'Tùy chỉnh'}
                      </span>{' '}
                      · Slot {audioLab.activeSlot} ·{' '}
                      {activeEqSlot.mode === 'parametric' ? 'Parametric 8-Band' : 'Graphic 10-Band'}
                    </p>
                    <p className="text-[11.5px] text-[var(--text-muted)]">
                      {!isElectronDesktop
                        ? 'Preview Mode · Desktop Playback Unavailable (lưu cấu hình cục bộ)'
                        : dsp.mode === 'dsp' && dsp.contextState === 'running'
                          ? `Web Audio DSP Active · ${Number((dsp.sampleRate / 1000).toFixed(1))} kHz`
                          : dsp.mode === 'error'
                            ? `DSP Error Fallback: ${dsp.lastError || 'Phát trực tiếp'}`
                            : 'DSP sẵn sàng khi phát file nhạc cục bộ'}
                    </p>
                  </div>

                  <button
                    type="button"
                    data-testid="settings-open-audio-lab-btn"
                    onClick={() => uiStore.navigate('audio-lab')}
                    style={{
                      backgroundColor: `rgba(${userAccent.glowRgb}, 0.14)`,
                      borderColor: `rgba(${userAccent.glowRgb}, 0.35)`,
                    }}
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border px-3.5 text-[12.5px] font-semibold text-[var(--text-primary)] transition hover:brightness-110"
                  >
                    <span>Mở Audio Lab</span>
                    <ArrowUpRight className="h-3.5 w-3.5" style={{ color: userAccent.activeHex }} />
                  </button>
                </div>

                <div className="border-t border-[var(--border-subtle)] pt-3.5">
                  <SettingToggleRow
                    variant="compact"
                    label="Auto Headroom (Bù khoảng dự trữ EQ)"
                    description="Tự động hạ nhẹ Preamp tương ứng mức tăng dương lớn nhất của EQ nhằm giảm nguy cơ clipping."
                    checked={activeEqSlot.autoHeadroom}
                    onChange={(next) => uiStore.setEqAutoHeadroom(next)}
                    accentHex={userAccent.activeHex}
                    testId="settings-auto-headroom-toggle"
                  />
                </div>

                <div className="border-t border-[var(--border-subtle)] pt-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[12.5px] font-medium text-[var(--text-secondary)]">
                      ReplayGain (Cân bằng âm lượng từ tag file gốc)
                    </span>
                    <span className="font-mono-tabular text-[11.5px] text-[var(--text-muted)]">
                      {replayGain.mode === 'off'
                        ? 'Đang tắt'
                        : replayGain.mode === 'album'
                          ? 'Chế độ Album'
                          : 'Chế độ Track'}
                    </span>
                  </div>
                  <div className="mt-2.5 grid grid-cols-3 gap-2">
                    {(
                      [
                        { id: 'off', label: 'Tắt' },
                        { id: 'track', label: 'Track' },
                        { id: 'album', label: 'Album' },
                      ] as Array<{ id: ReplayGainMode; label: string }>
                    ).map((opt) => {
                      const selected = replayGain.mode === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          data-testid={`settings-rg-${opt.id}`}
                          onClick={() => uiStore.updateReplayGainSettings({ mode: opt.id })}
                          style={
                            selected
                              ? {
                                  backgroundColor: `rgba(${userAccent.glowRgb}, 0.2)`,
                                  borderColor: userAccent.activeHex,
                                  color: userAccent.activeHex,
                                }
                              : undefined
                          }
                          className={`flex items-center justify-center gap-1 rounded-xl border py-2 text-[12.5px] font-semibold transition ${
                            selected
                              ? ''
                              : 'border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
                          }`}
                        >
                          {selected && <Check className="h-3.5 w-3.5" />}
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>

                  <div className="mt-3">
                    <SettingToggleRow
                      variant="compact"
                      label="Chống clipping ReplayGain"
                      description="Giới hạn mức khuếch đại dương theo thông số peak của bài hát để tránh vỡ tiếng."
                      checked={replayGain.preventClipping}
                      onChange={(next) =>
                        uiStore.updateReplayGainSettings({ preventClipping: next })
                      }
                      accentHex={userAccent.activeHex}
                      testId="settings-rg-clipping-toggle"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-4 rounded-2xl border border-[var(--border-glass)] bg-[var(--surface-glass-light)] p-5">
                <div>
                  <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                    Điều khiển phát nhạc & Hàng đợi
                  </h3>
                  <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                    Đồng bộ trực tiếp với Mini Player, màn hình Đang phát và chế độ Focus Vinyl. Tự động lưu cho lần mở tiếp theo.
                  </p>
                </div>

                <SettingToggleRow
                  variant="compact"
                  label="Phát ngẫu nhiên (Shuffle)"
                  description="Xáo trộn thứ tự các bài trong mục Kế tiếp và hiển thị đúng thứ tự phát thực tế."
                  checked={ui.shuffle}
                  onChange={(next) => uiStore.setShuffle(next)}
                  accentHex={userAccent.activeHex}
                  testId="settings-shuffle-toggle"
                />

                <div className="border-t border-[var(--border-subtle)] pt-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[12.5px] font-medium text-[var(--text-secondary)]">
                      Chế độ lặp (Repeat)
                    </span>
                    <span className="text-[11.5px] font-medium text-[var(--text-muted)]">
                      {REPEAT_MODE_LABELS[ui.repeat]}
                    </span>
                  </div>
                  <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-5">
                    {(
                      [
                        { id: 'off', label: 'Tắt' },
                        { id: 'once', label: 'Lặp 1 lần' },
                        { id: 'twice', label: 'Lặp 2 lần' },
                        { id: 'one', label: 'Lặp vô hạn' },
                        { id: 'all', label: 'Lặp tất cả' },
                      ] as const
                    ).map((opt) => {
                      const selected = ui.repeat === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          data-testid={`settings-repeat-${opt.id}`}
                          onClick={() => uiStore.setRepeatMode(opt.id)}
                          style={
                            selected
                              ? {
                                  backgroundColor: `rgba(${userAccent.glowRgb}, 0.2)`,
                                  borderColor: userAccent.activeHex,
                                  color: userAccent.activeHex,
                                }
                              : undefined
                          }
                          className={`flex items-center justify-center gap-1 rounded-xl border py-2 text-[12px] font-semibold transition ${
                            selected
                              ? ''
                              : 'border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
                          }`}
                        >
                          {selected && <Check className="h-3.5 w-3.5" />}
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="border-t border-[var(--border-subtle)] pt-3.5">
                  <SettingToggleRow
                    variant="compact"
                    label="Tự động chuyển bài (Auto Next)"
                    description="Khi bật, DoReMi tự động chuyển sang bài kế tiếp sau khi hết lượt phát/lặp. Khi tắt, phát xong bài hiện tại (và các lượt lặp 1/2 lần nếu có) rồi dừng."
                    checked={ui.autoNext}
                    onChange={(next) => uiStore.setAutoNext(next)}
                    accentHex={userAccent.activeHex}
                    testId="settings-auto-next-toggle"
                  />
                </div>

                <div className="border-t border-[var(--border-subtle)] pt-3.5">
                  <SettingToggleRow
                    variant="compact"
                    label="Tự động phát tiếp khi hết danh sách"
                    description="Khi hết bài cuối của Album, Playlist hoặc Hàng đợi và không bật lặp tất cả, tự động nối tiếp phát nhạc từ Thư viện nhạc (theo thứ tự hoặc phát ngẫu nhiên thông minh)."
                    checked={ui.preferences.autoContinueEnabled ?? true}
                    onChange={(next) => uiStore.setAutoContinueEnabled(next)}
                    accentHex={userAccent.activeHex}
                    testId="settings-auto-continue-toggle"
                  />
                </div>
              </div>
            </div>
          )}

          {section === 'library' && (
            <div className="space-y-5">
              <h2 className="font-display text-[20px] font-semibold text-[var(--text-primary)]">
                Thư viện nhạc cục bộ (SQLite)
              </h2>
              <div className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-5 text-[13px]">
                <div>
                  <span className="text-[var(--text-muted)]">Đường dẫn cơ sở dữ liệu SQLite:</span>
                  <p className="font-mono-tabular mt-1 break-all text-[12px] text-[var(--text-primary)]">
                    {library.databasePath ||
                      'Chạy trong ứng dụng desktop Electron để hiển thị đường dẫn userData SQLite thực tế.'}
                  </p>
                </div>
                <div>
                  <span className="text-[var(--text-muted)]">Số thư mục đã gắn kết:</span>
                  <p className="mt-0.5 text-[var(--text-primary)]">{library.roots.length} thư mục</p>
                </div>
                <div>
                  <span className="text-[var(--text-muted)]">Tổng bản thu đã lưu SQLite:</span>
                  <p className="mt-0.5 text-[var(--text-primary)]">{library.tracks.length} bản thu</p>
                </div>
              </div>
            </div>
          )}

          {section === 'backup' && (
            <div className="space-y-4">
              <h2 className="font-display text-[20px] font-semibold text-[var(--text-primary)]">
                Dữ liệu & Sao lưu cục bộ
              </h2>
              <p className="text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
                DoReMi lưu toàn bộ thư viện, ảnh đại diện, lời bài hát, thông tin tùy chỉnh và lịch sử nghe nhạc hoàn toàn trên máy tính Windows của bạn. Trước mỗi lần nâng cấp cấu trúc cơ sở dữ liệu, ứng dụng tự động tạo bản sao lưu an toàn bên cạnh tệp{' '}
                <span className="font-mono-tabular text-[var(--text-primary)]">library.db</span>.
              </p>
            </div>
          )}

          {section === 'guide' && (
            <Suspense
              fallback={
                <div className="py-12 text-center text-[13px] text-[var(--text-muted)]">
                  Đang tải Hướng dẫn sử dụng...
                </div>
              }
            >
              <UserGuideSection />
            </Suspense>
          )}

          {section === 'about' && (
            <Suspense
              fallback={
                <div className="py-12 text-center text-[13px] text-[var(--text-muted)]">
                  Đang tải thông tin giới thiệu...
                </div>
              }
            >
              <AboutSection onOpenGuide={() => setSection('guide')} />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
