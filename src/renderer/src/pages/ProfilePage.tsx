import { useRef, useState, type ChangeEvent } from 'react';
import {
  AlertCircle,
  Check,
  ImagePlus,
  Moon,
  Palette,
  RotateCcw,
  Sparkles,
  Sun,
  Trash2,
  Type,
  Upload,
  UserRound,
} from 'lucide-react';
import type { HomeBackgroundMode, ThemeMode } from '../../../shared/types/stage5';
import {
  MAX_EDITORIAL_TEXT_LENGTH,
  RECOMMENDED_EDITORIAL_TEXT_LENGTH,
} from '../../../shared/utils/editorial-typography';
import { HomeEditorialTypography } from '../components/HomeEditorialTypography';
import { ProfileAvatar } from '../components/ProfileAvatar';
import { SettingToggleRow } from '../components/ToggleSwitch';
import {
  DEFAULT_DISPLAY_NAME,
  MAX_DISPLAY_NAME_LENGTH,
  uiStore,
  useUiState,
} from '../stores/ui-store';
import { THEME_ACCENT_PRESETS } from '../utils/theme-presets';

const MAX_WEB_IMAGE_BYTES = 10 * 1024 * 1024;

function detectAnimatedGifInArrayBuffer(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 14) return false;
  const header = String.fromCharCode(...bytes.slice(0, 6));
  if (header !== 'GIF87a' && header !== 'GIF89a') return false;
  let offset = 13;
  const packed = bytes[10];
  if (packed & 0x80) {
    offset += 3 * (1 << ((packed & 0x07) + 1));
  }
  let frames = 0;
  while (offset < bytes.length) {
    const id = bytes[offset];
    if (id === 0x3b) break;
    if (id === 0x2c) {
      frames += 1;
      if (frames >= 2) return true;
      if (offset + 10 >= bytes.length) break;
      const lPacked = bytes[offset + 9];
      offset += 10;
      if (lPacked & 0x80) {
        offset += 3 * (1 << ((lPacked & 0x07) + 1));
      }
      offset += 1;
      while (offset < bytes.length) {
        const len = bytes[offset++];
        if (len === 0) break;
        offset += len;
      }
    } else if (id === 0x21) {
      offset += 2;
      while (offset < bytes.length) {
        const len = bytes[offset++];
        if (len === 0) break;
        offset += len;
      }
    } else {
      offset += 1;
    }
  }
  return frames >= 2;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Không thể đọc file ảnh đã chọn.'));
    reader.readAsDataURL(file);
  });
}

/**
 * M5.2 Unified Local Profile & Personalization Hub
 * Single source of truth for Profile, Avatar (JPG/PNG/WEBP/Animated GIF),
 * Dark/Light Theme, Accent Color, Custom Home Background, and Visual Effects.
 * Reached from BOTH the top-left Sidebar avatar AND Settings > Cá nhân hóa.
 */
export function ProfilePage() {
  const ui = useUiState();
  const { profile, preferences } = ui;
  const userAccent = uiStore.getUserAccentPalette();
  const isElectron = typeof window !== 'undefined' && Boolean(window.losslessApi);

  const [nameInput, setNameInput] = useState(profile.displayName);
  const [nameSavedPulse, setNameSavedPulse] = useState(false);
  const [customHexDraft, setCustomHexDraft] = useState(
    preferences.customAccentHex ?? userAccent.hex,
  );
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const bgInputRef = useRef<HTMLInputElement | null>(null);
  const editorialFontInputRef = useRef<HTMLInputElement | null>(null);
  const [isImportingFont, setIsImportingFont] = useState(false);

  const editorial = preferences.editorialTypography;
  const editorialFonts = preferences.editorialFonts;
  const isTopLong = Array.from(editorial.topText.trim()).length > RECOMMENDED_EDITORIAL_TEXT_LENGTH;
  const isBottomLong =
    Array.from(editorial.bottomText.trim()).length > RECOMMENDED_EDITORIAL_TEXT_LENGTH;
  const previewPlaylists = ui.playlists.slice(0, 3);
  const previewHasCustomBg =
    preferences.homeBackgroundMode === 'custom' && Boolean(preferences.customBackgroundUrl);

  const handleImportFontClick = async () => {
    if (isElectron) {
      setIsImportingFont(true);
      try {
        await uiStore.importEditorialFontDesktop();
      } finally {
        setIsImportingFont(false);
      }
      return;
    }
    editorialFontInputRef.current?.click();
  };

  const handleWebEditorialFontSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setIsImportingFont(true);
    try {
      await uiStore.importWebEditorialFont(file);
    } finally {
      setIsImportingFont(false);
    }
  };

  const handleSaveName = async () => {
    await uiStore.updateDisplayName(nameInput);
    const updated = uiStore.getSnapshot().profile.displayName;
    setNameInput(updated);
    setNameSavedPulse(true);
    setTimeout(() => setNameSavedPulse(false), 1600);
  };

  const handleAvatarUploadClick = () => {
    if (isElectron) {
      void uiStore.importProfileAvatarDesktop();
      return;
    }
    avatarInputRef.current?.click();
  };

  const handleAvatarFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (file.size > MAX_WEB_IMAGE_BYTES) {
      uiStore.showToast('Dung lượng avatar vượt quá giới hạn 10MB.');
      return;
    }

    const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!validTypes.includes(file.type)) {
      uiStore.showToast('Định dạng avatar không hợp lệ. Chỉ hỗ trợ JPG, PNG, WEBP hoặc GIF.');
      return;
    }

    try {
      const [buf, dataUrl] = await Promise.all([file.arrayBuffer(), fileToDataUrl(file)]);
      const isAnimated = file.type === 'image/gif' && detectAnimatedGifInArrayBuffer(buf);
      uiStore.setWebProfileAvatar(dataUrl, file.type, isAnimated);
    } catch {
      uiStore.showToast('Không thể đọc file ảnh đại diện.');
    }
  };

  const handleBgUploadClick = () => {
    if (isElectron) {
      void uiStore.importCustomBackgroundDesktop();
      return;
    }
    bgInputRef.current?.click();
  };

  const handleBgFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (file.size > MAX_WEB_IMAGE_BYTES) {
      uiStore.showToast('Dung lượng ảnh nền vượt quá giới hạn 10MB.');
      return;
    }

    const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      uiStore.showToast('Ảnh nền chỉ hỗ trợ JPG, PNG hoặc WEBP.');
      return;
    }

    try {
      const dataUrl = await fileToDataUrl(file);
      uiStore.setWebCustomBackground(dataUrl);
    } catch {
      uiStore.showToast('Không thể đọc ảnh nền tùy chỉnh.');
    }
  };

  const setThemeMode = (mode: ThemeMode) => {
    uiStore.updatePreferences({ themeMode: mode });
  };

  const setHomeBgMode = (mode: HomeBackgroundMode) => {
    if (mode === 'custom' && !preferences.customBackgroundUrl) {
      handleBgUploadClick();
      return;
    }
    uiStore.updatePreferences({ homeBackgroundMode: mode });
  };

  return (
    <div
      data-testid="profile-personalization-page"
      className="mx-auto max-w-[1040px] space-y-6 pb-36 pt-2"
    >
      {/* Hidden browser-preview file inputs */}
      <input
        ref={avatarInputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp,.gif,image/jpeg,image/png,image/webp,image/gif"
        onChange={handleAvatarFileSelected}
        data-testid="profile-avatar-file-input"
        className="hidden"
      />
      <input
        ref={bgInputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
        onChange={handleBgFileSelected}
        data-testid="profile-bg-file-input"
        className="hidden"
      />
      <input
        ref={editorialFontInputRef}
        type="file"
        accept=".ttf,.otf,.woff,.woff2"
        onChange={(e) => void handleWebEditorialFontSelected(e)}
        data-testid="editorial-font-file-input"
        className="hidden"
      />

      {/* Page Header */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--text-muted)]">
            Hồ sơ cục bộ · 100% Offline
          </p>
          <h1 className="mt-1 font-display text-3xl font-bold tracking-tight text-[var(--text-primary)]">
            Hồ sơ & Cá nhân hóa
          </h1>
          <p className="mt-1 text-[13.5px] text-[var(--text-secondary)]">
            Tùy chỉnh tên hiển thị, ảnh đại diện (hỗ trợ GIF động), chế độ Sáng/Tối, màu chủ đạo và không gian trang chủ.
          </p>
        </div>
      </header>

      {/* Section 1: Local Profile & Animated GIF Avatar */}
      <section className="lp-glass-panel rounded-[26px] p-6">
        <div className="mb-5 flex items-center gap-2.5">
          <UserRound className="h-5 w-5" style={{ color: userAccent.activeHex }} />
          <h2 className="font-display text-lg font-semibold text-[var(--text-primary)]">
            Hồ sơ người nghe cục bộ
          </h2>
        </div>

        <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
          <div className="relative flex flex-col items-center gap-2">
            <ProfileAvatar
              profile={profile}
              sizePx={96}
              accentHex={userAccent.activeHex}
              pauseAnimatedGif={
                preferences.reducedMotion && preferences.reduceMotionStaticGif
              }
              className="ring-2 ring-[var(--border-glass)]"
            />
            {profile.avatarIsAnimated && (
              <span
                data-testid="avatar-animated-gif-badge"
                className="rounded-full border border-[var(--border-glass)] bg-[var(--surface-glass-light)] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]"
              >
                GIF động
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1 space-y-4">
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={handleAvatarUploadClick}
                data-testid="upload-avatar-btn"
                style={{
                  backgroundColor: userAccent.activeHex,
                  color: userAccent.onAccentText,
                }}
                className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-semibold shadow transition hover:brightness-110"
              >
                <Upload className="h-4 w-4" />
                Đổi ảnh đại diện
              </button>

              {profile.avatarUrl && (
                <button
                  type="button"
                  onClick={() => void uiStore.removeProfileAvatar()}
                  data-testid="remove-avatar-btn"
                  className="lp-btn-ghost inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Xóa ảnh
                </button>
              )}

              <span className="text-[12px] text-[var(--text-muted)]">
                Hỗ trợ JPG, PNG, WEBP, GIF động (tối đa 10MB)
              </span>
            </div>

            <div className="max-w-lg">
              <label
                htmlFor="doremi-display-name"
                className="mb-1.5 block text-[12px] font-medium text-[var(--text-secondary)]"
              >
                Tên hiển thị (hỗ trợ Tiếng Việt, Tiếng Nhật, Tiếng Hàn, Tiếng Trung)
              </label>
              <div className="flex gap-2">
                <input
                  id="doremi-display-name"
                  type="text"
                  maxLength={MAX_DISPLAY_NAME_LENGTH}
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      void handleSaveName();
                    }
                  }}
                  placeholder={DEFAULT_DISPLAY_NAME}
                  data-testid="profile-display-name-input"
                  className="lp-surface-input flex-1 rounded-xl px-3.5 py-2 text-[14px] outline-none focus:ring-2"
                />
                <button
                  type="button"
                  onClick={() => void handleSaveName()}
                  data-testid="profile-save-name-btn"
                  className="lp-btn-ghost inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-[13px] font-semibold"
                >
                  {nameSavedPulse ? <Check className="h-4 w-4 text-emerald-500" /> : null}
                  Lưu tên
                </button>
              </div>
              <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
                Để trống sẽ tự động khôi phục về “{DEFAULT_DISPLAY_NAME}”.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Section 2: Appearance (Dark / Light Mode + Accent Color + Live Preview) */}
      <section className="lp-glass-panel rounded-[26px] p-6">
        <div className="mb-5 flex items-center gap-2.5">
          <Palette className="h-5 w-5" style={{ color: userAccent.activeHex }} />
          <h2 className="font-display text-lg font-semibold text-[var(--text-primary)]">
            Giao diện & Màu chủ đạo
          </h2>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.25fr_0.95fr]">
          <div className="space-y-5">
            {/* Dark / Light Theme Switcher */}
            <div>
              <p className="mb-2.5 text-[12.5px] font-medium text-[var(--text-secondary)]">
                Chế độ màu nền
              </p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setThemeMode('dark')}
                  data-testid="theme-mode-dark-btn"
                  style={
                    preferences.themeMode === 'dark'
                      ? {
                          borderColor: userAccent.activeHex,
                          backgroundColor: `rgba(${userAccent.glowRgb}, 0.14)`,
                        }
                      : undefined
                  }
                  className="flex items-center gap-3 rounded-2xl border border-[var(--border-glass)] bg-[var(--surface-glass-light)] px-4 py-3.5 text-left transition hover:bg-[var(--surface-hover)]"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#12141C] text-white shadow-inner">
                    <Moon className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-[14px] font-semibold text-[var(--text-primary)]">
                      Dark Mode
                    </p>
                    <p className="text-[11.5px] text-[var(--text-muted)]">
                      Không gian nghe nhạc sâu
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setThemeMode('light')}
                  data-testid="theme-mode-light-btn"
                  style={
                    preferences.themeMode === 'light'
                      ? {
                          borderColor: userAccent.activeHex,
                          backgroundColor: `rgba(${userAccent.glowRgb}, 0.12)`,
                        }
                      : undefined
                  }
                  className="flex items-center gap-3 rounded-2xl border border-[var(--border-glass)] bg-[var(--surface-glass-light)] px-4 py-3.5 text-left transition hover:bg-[var(--surface-hover)]"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-black/10 bg-[#FAFBFD] text-[#1A1E2C] shadow-inner">
                    <Sun className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-[14px] font-semibold text-[var(--text-primary)]">
                      Light Mode
                    </p>
                    <p className="text-[11.5px] text-[var(--text-muted)]">
                      Sáng sạch, tương phản cao
                    </p>
                  </div>
                </button>
              </div>
            </div>

            {/* Curated Accent Swatches + Custom Color */}
            <div>
              <p className="mb-2.5 text-[12.5px] font-medium text-[var(--text-secondary)]">
                Màu chủ đạo (áp dụng cho Mini Player, thanh điều hướng và nút hành động)
              </p>
              <div className="flex flex-wrap items-center gap-2.5">
                {THEME_ACCENT_PRESETS.map((preset) => {
                  const isSelected =
                    !preferences.customAccentHex && preferences.accentPresetId === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() =>
                        uiStore.updatePreferences({
                          accentPresetId: preset.id,
                          customAccentHex: null,
                        })
                      }
                      data-testid={`accent-preset-${preset.id}`}
                      aria-label={`Chọn màu ${preset.name}`}
                      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition ${
                        isSelected
                          ? 'border-[var(--text-primary)] bg-[var(--surface-hover)] text-[var(--text-primary)]'
                          : 'border-[var(--border-subtle)] bg-[var(--surface-glass-light)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]'
                      }`}
                    >
                      <span
                        className="flex h-4 w-4 items-center justify-center rounded-full shadow-sm"
                        style={{ backgroundColor: preset.hex }}
                      >
                        {isSelected && <Check className="h-2.5 w-2.5 text-white" />}
                      </span>
                      {preset.name}
                    </button>
                  );
                })}

                <label
                  className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-[var(--border-glass)] bg-[var(--surface-glass-light)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
                  title="Chọn màu tùy chỉnh"
                >
                  <input
                    type="color"
                    value={customHexDraft}
                    onChange={(e) => {
                      const val = e.target.value.toUpperCase();
                      setCustomHexDraft(val);
                      uiStore.updatePreferences({ customAccentHex: val });
                    }}
                    aria-label="Chọn màu chủ đạo tùy chỉnh"
                    className="h-4 w-4 cursor-pointer rounded-full border-0 bg-transparent p-0"
                  />
                  <span>Tùy chỉnh</span>
                  <span className="font-mono-tabular text-[11px] text-[var(--text-muted)]">
                    {userAccent.activeHex}
                  </span>
                </label>
              </div>
            </div>
          </div>

          {/* Live Theme & Contrast Preview Card */}
          <div className="flex flex-col justify-between rounded-2xl border border-[var(--border-glass)] bg-[var(--bg-elevated)] p-5 shadow-inner">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
                Xem trước trực tiếp
              </p>
              <div className="mt-3 flex items-center gap-3">
                <ProfileAvatar
                  profile={profile}
                  sizePx={40}
                  accentHex={userAccent.activeHex}
                  pauseAnimatedGif={
                    preferences.reducedMotion && preferences.reduceMotionStaticGif
                  }
                />
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold text-[var(--text-primary)]">
                    {profile.displayName}
                  </p>
                  <p className="text-[12px] text-[var(--text-secondary)]">
                    {preferences.themeMode === 'dark' ? 'Dark Mode' : 'Light Mode'} ·{' '}
                    {userAccent.name}
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              {/* Sample Mini Player volume bar preview */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-[11px] text-[var(--text-muted)]">
                  <span>Thanh âm lượng Mini Player</span>
                  <span className="font-mono-tabular">72%</span>
                </div>
                <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--volume-track-empty)]">
                  <div
                    className="h-full rounded-full"
                    style={{ width: '72%', backgroundColor: userAccent.activeHex }}
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <span
                  style={{
                    backgroundColor: userAccent.activeHex,
                    color: userAccent.onAccentText,
                  }}
                  className="rounded-full px-3.5 py-1.5 text-[12px] font-semibold"
                >
                  Nút chính
                </span>
                <span className="lp-btn-ghost rounded-full px-3.5 py-1.5 text-[12px] font-medium">
                  Nút phụ
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Section 3: Custom Home Background */}
      <section className="lp-glass-panel rounded-[26px] p-6">
        <div className="mb-5 flex items-center gap-2.5">
          <ImagePlus className="h-5 w-5" style={{ color: userAccent.activeHex }} />
          <h2 className="font-display text-lg font-semibold text-[var(--text-primary)]">
            Ảnh nền màn hình Home
          </h2>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {(
            [
              {
                id: 'dynamic',
                title: 'Động theo màu bìa',
                desc: 'Nền chuyển sắc mềm theo playlist đang chọn.',
              },
              {
                id: 'custom',
                title: 'Ảnh nền tùy chỉnh',
                desc: 'Dùng ảnh cục bộ kèm lớp phủ giữ độ tương phản.',
              },
              {
                id: 'default',
                title: 'Nền chuẩn Theme',
                desc: 'Tối giản, sạch sẽ theo Dark/Light Mode.',
              },
            ] as Array<{ id: HomeBackgroundMode; title: string; desc: string }>
          ).map((mode) => {
            const active = preferences.homeBackgroundMode === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                onClick={() => setHomeBgMode(mode.id)}
                data-testid={`home-bg-mode-${mode.id}`}
                style={
                  active
                    ? {
                        borderColor: userAccent.activeHex,
                        backgroundColor: `rgba(${userAccent.glowRgb}, 0.13)`,
                      }
                    : undefined
                }
                className="rounded-2xl border border-[var(--border-glass)] bg-[var(--surface-glass-light)] p-4 text-left transition hover:bg-[var(--surface-hover)]"
              >
                <p className="text-[14px] font-semibold text-[var(--text-primary)]">
                  {mode.title}
                </p>
                <p className="mt-1 text-[12px] text-[var(--text-muted)]">{mode.desc}</p>
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleBgUploadClick}
            data-testid="upload-custom-bg-btn"
            className="lp-btn-ghost inline-flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium"
          >
            <Upload className="h-4 w-4" />
            {preferences.customBackgroundUrl ? 'Đổi ảnh nền tùy chỉnh' : 'Chọn ảnh nền từ máy'}
          </button>

          {preferences.customBackgroundUrl && (
            <button
              type="button"
              onClick={() => void uiStore.removeCustomBackground()}
              data-testid="remove-custom-bg-btn"
              className="lp-btn-ghost inline-flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Khôi phục nền mặc định
            </button>
          )}
        </div>
      </section>

      {/* Section 3B: Home Editorial Background Typography & Custom Display Font */}
      <section
        data-testid="editorial-typography-section"
        className="lp-glass-panel rounded-[26px] p-6"
      >
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Type className="h-5 w-5" style={{ color: userAccent.activeHex }} />
            <div>
              <h2 className="font-display text-lg font-semibold text-[var(--text-primary)]">
                Chữ nền trang chủ · Editorial Typography
              </h2>
              <p className="text-[12.5px] text-[var(--text-secondary)]">
                Tùy chỉnh hai dòng chữ lớn phía sau Playlist Gallery và font hiển thị riêng cho lớp chữ nền này.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => uiStore.restoreDefaultEditorialTypography()}
            data-testid="editorial-restore-default-btn"
            className="lp-btn-ghost inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Khôi phục mặc định
          </button>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.15fr_0.95fr]">
          {/* Left Controls */}
          <div className="space-y-4">
            <SettingToggleRow
              variant="card"
              checked={editorial.enabled}
              onChange={(val) => uiStore.updateEditorialTypography({ enabled: val })}
              label="Hiển thị chữ nền trang chủ"
              description="Đặt lớp typography lớn phía sau các thẻ dọc Playlist Gallery ở màn hình Home."
              accentHex={userAccent.activeHex}
              testId="pref-editorial-typography-enabled"
            />

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="editorial-top-text"
                  className="mb-1.5 block text-[12px] font-medium text-[var(--text-secondary)]"
                >
                  Dòng chữ phía trên
                </label>
                <input
                  id="editorial-top-text"
                  type="text"
                  maxLength={MAX_EDITORIAL_TEXT_LENGTH}
                  value={editorial.topText}
                  onChange={(e) =>
                    uiStore.updateEditorialTypography({ topText: e.target.value })
                  }
                  placeholder="YOUR MUSIC"
                  data-testid="editorial-top-text-input"
                  className="lp-surface-input w-full rounded-xl px-3.5 py-2 text-[13.5px] outline-none focus:ring-2"
                />
                {isTopLong && (
                  <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-500">
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    Chữ hơi dài — cỡ chữ sẽ tự thu nhỏ để vừa khung.
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="editorial-bottom-text"
                  className="mb-1.5 block text-[12px] font-medium text-[var(--text-secondary)]"
                >
                  Dòng chữ phía dưới
                </label>
                <input
                  id="editorial-bottom-text"
                  type="text"
                  maxLength={MAX_EDITORIAL_TEXT_LENGTH}
                  value={editorial.bottomText}
                  onChange={(e) =>
                    uiStore.updateEditorialTypography({ bottomText: e.target.value })
                  }
                  placeholder="YOUR WORLD"
                  data-testid="editorial-bottom-text-input"
                  className="lp-surface-input w-full rounded-xl px-3.5 py-2 text-[13.5px] outline-none focus:ring-2"
                />
                {isBottomLong && (
                  <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-500">
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    Chữ hơi dài — cỡ chữ sẽ tự thu nhỏ để vừa khung.
                  </p>
                )}
              </div>
            </div>

            <p className="text-[11.5px] text-[var(--text-muted)]">
              Giữ nguyên chữ hoa/thường bạn nhập. Hỗ trợ đầy đủ Tiếng Việt, Tiếng Anh, Tiếng Trung, Tiếng Nhật và Tiếng Hàn.
            </p>

            {/* Compact Scale & Opacity Controls */}
            <div className="grid gap-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-3.5 sm:grid-cols-2">
              <label className="space-y-1.5">
                <div className="flex items-center justify-between text-[12px]">
                  <span className="font-medium text-[var(--text-secondary)]">Tỉ lệ cỡ chữ</span>
                  <span className="font-mono-tabular text-[11.5px] text-[var(--text-muted)]">
                    {Math.round(editorial.fontSizeScale * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0.75}
                  max={1.25}
                  step={0.05}
                  value={editorial.fontSizeScale}
                  onChange={(e) =>
                    uiStore.updateEditorialTypography({
                      fontSizeScale: Number(e.target.value),
                    })
                  }
                  data-testid="editorial-scale-slider"
                  className="lp-slider w-full"
                />
              </label>

              <label className="space-y-1.5">
                <div className="flex items-center justify-between text-[12px]">
                  <span className="font-medium text-[var(--text-secondary)]">Độ rõ chữ nền</span>
                  <span className="font-mono-tabular text-[11.5px] text-[var(--text-muted)]">
                    {Math.round(editorial.opacity * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0.08}
                  max={0.32}
                  step={0.01}
                  value={editorial.opacity}
                  onChange={(e) =>
                    uiStore.updateEditorialTypography({
                      opacity: Number(e.target.value),
                    })
                  }
                  data-testid="editorial-opacity-slider"
                  className="lp-slider w-full"
                />
              </label>
            </div>

            {/* Scoped Custom Font Picker (ONLY applies to Home Editorial Background Typography) */}
            <div className="space-y-2.5 pt-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[12.5px] font-medium text-[var(--text-secondary)]">
                    Font chữ nền cá nhân (.ttf, .otf, .woff, .woff2)
                  </p>
                  <p className="text-[11px] text-[var(--text-muted)]">
                    Chỉ áp dụng cho chữ nền trang chủ — không thay đổi font lời bài hát hay giao diện ứng dụng.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={isImportingFont}
                  onClick={() => void handleImportFontClick()}
                  data-testid="editorial-import-font-btn"
                  className="lp-btn-ghost inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-semibold text-[var(--text-primary)] disabled:opacity-50"
                >
                  <Upload className="h-3.5 w-3.5" />
                  {isImportingFont ? 'Đang nhập...' : 'Import font từ máy'}
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => uiStore.selectEditorialFont(null)}
                  data-testid="editorial-font-default-btn"
                  style={
                    editorial.selectedFontId === null
                      ? {
                          borderColor: userAccent.activeHex,
                          backgroundColor: `rgba(${userAccent.glowRgb}, 0.14)`,
                        }
                      : undefined
                  }
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition ${
                    editorial.selectedFontId === null
                      ? 'text-[var(--text-primary)]'
                      : 'border-[var(--border-subtle)] bg-[var(--surface-glass-light)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]'
                  }`}
                >
                  {editorial.selectedFontId === null && (
                    <Check className="h-3 w-3" style={{ color: userAccent.activeHex }} />
                  )}
                  <span>Font mặc định DoReMi</span>
                </button>

                {editorialFonts.map((font) => {
                  const selected = editorial.selectedFontId === font.id;
                  return (
                    <div
                      key={font.id}
                      data-testid={`editorial-font-item-${font.id}`}
                      style={
                        selected
                          ? {
                              borderColor: userAccent.activeHex,
                              backgroundColor: `rgba(${userAccent.glowRgb}, 0.14)`,
                            }
                          : undefined
                      }
                      className={`inline-flex items-center gap-1 rounded-full border pl-3 pr-1.5 py-1 text-[12px] font-medium transition ${
                        selected
                          ? 'text-[var(--text-primary)]'
                          : 'border-[var(--border-subtle)] bg-[var(--surface-glass-light)] text-[var(--text-secondary)]'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => uiStore.selectEditorialFont(font.id)}
                        className="inline-flex items-center gap-1.5 pr-1 text-left"
                      >
                        {selected && (
                          <Check className="h-3 w-3" style={{ color: userAccent.activeHex }} />
                        )}
                        <span className="max-w-[150px] truncate">{font.name}</span>
                        <span className="rounded bg-black/10 px-1.5 py-0.5 font-mono-tabular text-[9.5px] uppercase opacity-70 dark:bg-white/10">
                          {font.format}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void uiStore.deleteEditorialFont(font.id)}
                        aria-label={`Xóa font ${font.name}`}
                        data-testid={`editorial-font-delete-${font.id}`}
                        className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--text-muted)] transition hover:bg-rose-500/15 hover:text-rose-500"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right Live Preview Card (Actual background + Live Editorial Typography + Mini Portrait Cards IN FRONT) */}
          <div className="flex flex-col">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
              Xem trước trực tiếp trên Home Gallery
            </p>
            <div
              data-testid="editorial-live-preview"
              className="relative flex min-h-[250px] flex-1 items-center justify-center overflow-hidden rounded-2xl border border-[var(--border-glass)] shadow-inner"
              style={{
                background:
                  preferences.themeMode === 'light'
                    ? `radial-gradient(ellipse 65% 58% at 50% 28%, rgba(${userAccent.glowRgb}, 0.14), transparent 72%), linear-gradient(180deg, #F6F7FB 0%, #EAECEF 100%)`
                    : `radial-gradient(ellipse 65% 58% at 50% 28%, rgba(${userAccent.glowRgb}, 0.22), transparent 72%), linear-gradient(180deg, #12141A 0%, #090A0D 100%)`,
              }}
            >
              {previewHasCustomBg && preferences.customBackgroundUrl && (
                <div className="pointer-events-none absolute inset-0 z-0">
                  <img
                    src={preferences.customBackgroundUrl}
                    alt=""
                    className="h-full w-full scale-105 object-cover blur-[1.5px]"
                  />
                  <div
                    className="absolute inset-0"
                    style={{
                      background:
                        preferences.themeMode === 'light'
                          ? 'linear-gradient(180deg, rgba(246,247,251,0.72) 0%, rgba(236,238,245,0.82) 100%)'
                          : 'linear-gradient(180deg, rgba(9,10,13,0.62) 0%, rgba(9,10,13,0.78) 100%)',
                    }}
                  />
                </div>
              )}

              {/* Live Editorial Typography Layer BEHIND miniature portrait cards */}
              <HomeEditorialTypography
                settings={editorial}
                fonts={editorialFonts}
                themeMode={preferences.themeMode}
                hasCustomBackground={previewHasCustomBg}
                isPreview
              />

              {/* Miniature staggered portrait artwork cards layered IN FRONT (z-20) */}
              <div className="relative z-20 flex items-center justify-center">
                {[-1, 0, 1].map((slotOffset, idx) => {
                  const pl = previewPlaylists[idx] ?? previewPlaylists[0];
                  const cover = pl ? uiStore.getPlaylistCovers(pl).primaryCover : null;
                  const isMid = slotOffset === 0;
                  return (
                    <div
                      key={slotOffset}
                      style={{
                        width: isMid ? 84 : 64,
                        height: isMid ? 116 : 90,
                        transform: `translate3d(${slotOffset * 68}px, ${slotOffset === -1 ? 8 : slotOffset === 1 ? -7 : 0}px, 0) rotate(${slotOffset * 2.5}deg)`,
                        zIndex: isMid ? 30 : 20,
                      }}
                      className="absolute overflow-hidden rounded-xl border border-white/25 bg-[#191C24] shadow-[0_14px_28px_rgba(0,0,0,0.45)]"
                    >
                      {cover ? (
                        <img
                          src={cover}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div
                          className="h-full w-full"
                          style={{
                            background: `linear-gradient(145deg, ${userAccent.activeHex}, #141720)`,
                          }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              {!editorial.enabled && (
                <div className="lp-glass-pill relative z-30 rounded-full px-3 py-1 text-[11px] font-medium text-[var(--text-secondary)]">
                  Chữ nền đang tắt
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Section 4: Performance Quality Presets, Visual Effects & Reduced Motion */}
      <section
        data-testid="ui-performance-section"
        className="lp-glass-panel rounded-[26px] p-6"
      >
        <div className="mb-5 flex items-center gap-2.5">
          <Sparkles className="h-5 w-5" style={{ color: userAccent.activeHex }} />
          <div>
            <h2 className="font-display text-lg font-semibold text-[var(--text-primary)]">
              Hiệu năng giao diện & Khả năng tiếp cận
            </h2>
            <p className="mt-0.5 text-[12.5px] text-[var(--text-secondary)]">
              Tối ưu mức tiêu thụ CPU/GPU trên laptop Windows mà không làm thay đổi chất lượng âm thanh lossless.
            </p>
          </div>
        </div>

        {/* Quality Preset 3-way selector (Default: Balanced) */}
        <div className="mb-6">
          <p className="mb-2.5 text-[12.5px] font-semibold text-[var(--text-secondary)]">
            Chế độ hiệu năng giao diện
          </p>
          <div
            role="radiogroup"
            aria-label="Hiệu năng giao diện"
            className="grid gap-3 md:grid-cols-3"
          >
            {(
              [
                {
                  id: 'high',
                  title: 'High Quality',
                  badge: null,
                  desc: 'Đầy đủ hiệu ứng kính mờ sâu, ánh sáng nền và chuyển động mượt mà.',
                },
                {
                  id: 'balanced',
                  title: 'Balanced',
                  badge: 'Mặc định',
                  desc: 'Giữ trọn animation Gallery & đĩa than, giảm độ nặng blur cho laptop.',
                },
                {
                  id: 'power-saver',
                  title: 'Power Saver',
                  badge: 'Tiết kiệm',
                  desc: 'Tắt kính mờ và ánh sáng trang trí để giảm tải CPU/GPU tối đa cho máy cấu hình thấp.',
                },
              ] as const
            ).map((preset) => {
              const active = (preferences.uiQualityPreset ?? 'balanced') === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={`quality-preset-${preset.id}`}
                  onClick={() => uiStore.updatePreferences({ uiQualityPreset: preset.id })}
                  style={
                    active
                      ? {
                          borderColor: userAccent.activeHex,
                          backgroundColor: `rgba(${userAccent.glowRgb}, 0.13)`,
                        }
                      : undefined
                  }
                  className="flex flex-col items-start rounded-2xl border border-[var(--border-glass)] bg-[var(--surface-glass-light)] p-4 text-left transition hover:bg-[var(--surface-hover)]"
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="text-[14px] font-semibold text-[var(--text-primary)]">
                      {preset.title}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {preset.badge && (
                        <span className="rounded-md bg-[var(--surface-hover)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-secondary)]">
                          {preset.badge}
                        </span>
                      )}
                      {active && (
                        <span
                          className="flex h-4 w-4 items-center justify-center rounded-full text-white"
                          style={{ backgroundColor: userAccent.activeHex }}
                        >
                          <Check className="h-2.5 w-2.5" />
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                    {preset.desc}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-3">
          <SettingToggleRow
            variant="card"
            checked={preferences.dynamicAlbumColors}
            onChange={(val) => uiStore.updatePreferences({ dynamicAlbumColors: val })}
            label="Màu sắc động theo ảnh bìa"
            description="Tự động trích xuất bảng màu thích ứng từ ảnh bìa cho Now Playing, Focus Vinyl và ánh sáng nền."
            accentHex={userAccent.activeHex}
            testId="pref-dynamic-colors"
          />
          <SettingToggleRow
            variant="card"
            checked={preferences.vinylAnimation}
            onChange={(val) => uiStore.updatePreferences({ vinylAnimation: val })}
            label="Animation đĩa than (33⅓ RPM & đổi đĩa)"
            description="Xoay đĩa vinyl mượt mà khi phát nhạc và hiệu ứng nhấc cần khi chuyển bài."
            accentHex={userAccent.activeHex}
            testId="pref-vinyl-animation"
          />
          <SettingToggleRow
            variant="card"
            checked={preferences.backgroundEffects}
            onChange={(val) => uiStore.updatePreferences({ backgroundEffects: val })}
            label="Hiệu ứng ánh sáng nền"
            description="Hiển thị vầng sáng mềm dịu phía sau giao diện. Tắt để tối ưu GPU tối đa."
            accentHex={userAccent.activeHex}
            testId="pref-bg-effects"
          />
          <SettingToggleRow
            variant="card"
            checked={preferences.reducedMotion}
            onChange={(val) => uiStore.updatePreferences({ reducedMotion: val })}
            label="Giảm chuyển động (Reduced Motion)"
            description="Tùy chọn tiếp cận độc lập với chế độ hiệu năng — giảm tối đa hiệu ứng trượt và xoay đĩa."
            accentHex={userAccent.activeHex}
            testId="pref-reduced-motion"
          />
          {preferences.reducedMotion && (
            <SettingToggleRow
              variant="card"
              checked={preferences.reduceMotionStaticGif}
              onChange={(val) => uiStore.updatePreferences({ reduceMotionStaticGif: val })}
              label="Hiển thị khung tĩnh cho avatar GIF khi bật Giảm chuyển động"
              description="File GIF gốc vẫn được giữ nguyên; tắt tùy chọn này để GIF chạy động trở lại."
              accentHex={userAccent.activeHex}
              testId="pref-static-gif"
            />
          )}
        </div>
      </section>
    </div>
  );
}
