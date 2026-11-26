import { useEffect, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  Cpu,
  Database,
  Disc3,
  Heart,
  Layers,
  Scale,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type {
  AppRuntimeInfo,
  OptionalCodecStatusReport,
} from '../../../../shared/types/library';
import {
  DOREMI_ALAC_DECODER_LABEL,
  DOREMI_DESIGN_SLOGAN,
  DOREMI_DEVELOPER_HANDLE,
  DOREMI_PRODUCT_NAME,
  DOREMI_PRODUCT_SUBTITLE,
  formatOperatingPlatformLabel,
  formatReleaseChannelBadge,
  resolveReleaseChannel,
} from '../../../../shared/utils/app-metadata';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../../assets/default-artwork';
import { useLibraryState } from '../../stores/library-store';
import { uiStore } from '../../stores/ui-store';

export interface AboutSectionProps {
  onOpenGuide?: () => void;
}

const CORE_VALUES = [
  {
    title: 'Audio Quality First',
    detail: 'Giữ nguyên độ trung thực của nguồn FLAC, ALAC và WAV qua đường truyền phát sạch.',
  },
  {
    title: 'Offline First & Privacy',
    detail: 'Hoạt động 100% cục bộ trên Windows: không quảng cáo, không telemetry, không phụ thuộc cloud.',
  },
  {
    title: 'Low-end Hardware First',
    detail: 'Ảo hóa danh sách dài, giải phóng tài nguyên theo nhu cầu và có chế độ tiết kiệm phần cứng.',
  },
  {
    title: 'Minimal UI & Craft',
    detail: 'Tập trung vào trải nghiệm nghe sâu lắng với Vinyl Mode, Dynamic Palette và Lời bài hát đa ngôn ngữ.',
  },
];

const THIRD_PARTY_CREDITS = [
  { name: 'Electron', role: 'Desktop Runtime & Sandboxed Renderer Shell', license: 'MIT' },
  { name: 'React & React DOM', role: 'UI Component Architecture', license: 'MIT' },
  { name: 'TypeScript, Vite & Tailwind CSS', role: 'Type Safety, Bundling & Styling', license: 'Apache-2.0 / MIT' },
  { name: 'better-sqlite3 & SQLite', role: 'Local WAL Library & Statistics Database', license: 'MIT / Public Domain' },
  { name: '@mgz-dev/alac', role: 'Built-in WebAssembly ALAC (.m4a) Decoder', license: 'MIT' },
  { name: 'music-metadata', role: 'Read-only Audio Tag & Embedded Artwork Parser', license: 'MIT' },
  { name: 'lucide-react', role: 'Minimalist Vector Iconography', license: 'ISC' },
  { name: '@fontsource/poppins', role: 'Offline Embedded Sans Typography', license: 'OFL-1.1' },
];

export function AboutSection({ onOpenGuide }: AboutSectionProps) {
  const library = useLibraryState();
  const userAccent = uiStore.getUserAccentPalette();
  const [appInfo, setAppInfo] = useState<AppRuntimeInfo | null>(null);
  const [showTechDetails, setShowTechDetails] = useState(true);
  const [showCredits, setShowCredits] = useState(false);
  const [codecReport, setCodecReport] = useState<OptionalCodecStatusReport | null>(null);
  const [probingCodecs, setProbingCodecs] = useState(false);

  useEffect(() => {
    let active = true;
    const api = typeof window !== 'undefined' ? window.losslessApi : undefined;
    if (!api?.getAppInfo) {
      return;
    }
    void api
      .getAppInfo()
      .then((info) => {
        if (active) {
          setAppInfo(info);
        }
      })
      .catch(() => {
        // Non-fatal in preview/test harnesses
      });
    return () => {
      active = false;
    };
  }, []);

  const versionText = appInfo?.appVersion ?? 'Web Preview';
  const channelText = appInfo?.appVersion
    ? formatReleaseChannelBadge(
        appInfo.releaseChannel ?? resolveReleaseChannel(appInfo.appVersion),
      )
    : 'Browser Preview';
  const platformText = appInfo
    ? formatOperatingPlatformLabel(appInfo)
    : 'Windows Desktop';

  const handleProbeOptionalCodecs = async () => {
    const api = typeof window !== 'undefined' ? window.losslessApi : undefined;
    if (!api?.probeOptionalCodecs || probingCodecs) {
      return;
    }
    setProbingCodecs(true);
    try {
      const report = await api.probeOptionalCodecs(true);
      setCodecReport(report);
    } finally {
      setProbingCodecs(false);
    }
  };

  return (
    <div className="space-y-6" data-testid="settings-about-section">
      {/* Product Identity & Developer Banner */}
      <div className="relative overflow-hidden rounded-[24px] border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <img
              src={DEFAULT_DOREMI_ARTWORK_URL}
              alt="Biểu tượng DoReMi"
              className="h-20 w-20 shrink-0 rounded-2xl border border-[var(--border-glass)] object-cover shadow-lg"
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-[24px] font-bold tracking-[-0.02em] text-[var(--text-primary)]">
                  {appInfo?.appName ?? DOREMI_PRODUCT_NAME}
                </h2>
                <span
                  data-testid="about-version-badge"
                  style={{
                    backgroundColor: `rgba(${userAccent.glowRgb}, 0.16)`,
                    borderColor: `rgba(${userAccent.glowRgb}, 0.35)`,
                    color: userAccent.activeHex,
                  }}
                  className="font-mono-tabular rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold"
                >
                  v{versionText}
                </span>
                <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-glass-strong)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]">
                  {channelText}
                </span>
              </div>
              <p className="mt-1 text-[13.5px] font-medium text-[var(--text-secondary)]">
                {DOREMI_PRODUCT_SUBTITLE}
              </p>
              <p
                data-testid="about-developer-credit"
                className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] text-[var(--text-muted)]"
              >
                <Heart className="h-3.5 w-3.5 shrink-0" style={{ color: userAccent.activeHex }} />
                <span>
                  Designed &amp; Developed by{' '}
                  <strong className="font-semibold text-[var(--text-primary)]">
                    {DOREMI_DEVELOPER_HANDLE}
                  </strong>
                </span>
              </p>
            </div>
          </div>

          {onOpenGuide && (
            <button
              type="button"
              data-testid="about-open-guide-btn"
              onClick={onOpenGuide}
              className="lp-btn-ghost inline-flex h-10 shrink-0 items-center gap-2 self-start rounded-full px-4 text-[12.5px] font-semibold transition hover:brightness-110 sm:self-center"
            >
              <BookOpen className="h-4 w-4" style={{ color: userAccent.activeHex }} />
              <span>Hướng dẫn sử dụng</span>
            </button>
          )}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-4 text-[12px] text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-glass-strong)] px-3 py-1">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
            <span>{appInfo?.operatingMode ?? 'Offline Standalone (Zero Network)'}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-glass-strong)] px-3 py-1">
            <Database className="h-3.5 w-3.5" />
            <span>SQLite {appInfo?.sqliteVersion ?? '3.x'} · WAL Mode</span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-glass-strong)] px-3 py-1">
            <Disc3 className="h-3.5 w-3.5" />
            <span>{library.tracks.length} bản thu đang lưu cục bộ</span>
          </span>
        </div>
      </div>

      {/* Story & Design Philosophy */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-[22px] border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" style={{ color: userAccent.activeHex }} />
            <h3 className="font-display text-[16px] font-semibold text-[var(--text-primary)]">
              Câu chuyện phát triển
            </h3>
          </div>
          <div className="mt-3 space-y-2.5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
            <p>
              DoReMi ra đời từ niềm đam mê với âm nhạc chất lượng cao và mong muốn tạo nên một không gian nghe nhạc hoàn toàn offline ngay trên Windows — nơi bạn có thể lắng nghe trọn vẹn từng chi tiết của bản thu FLAC, ALAC hay WAV mà không bị quảng cáo, thuật toán gợi ý hay kết nối mạng làm gián đoạn.
            </p>
            <p>
              Được thiết kế và hoàn thiện bởi <strong className="text-[var(--text-primary)]">{DOREMI_DEVELOPER_HANDLE}</strong>, DoReMi kết hợp cảm hứng từ mâm đĩa than cổ điển, phòng trưng bày bìa album tinh gọn cùng kiến trúc lưu trữ SQLite bền vững để đồng hành lâu dài cùng bộ sưu tập nhạc cá nhân của bạn.
            </p>
          </div>
          <p
            className="mt-4 border-l-2 pl-3 text-[12.5px] italic text-[var(--text-primary)]"
            style={{ borderColor: userAccent.activeHex }}
          >
            &ldquo;{DOREMI_DESIGN_SLOGAN}&rdquo;
          </p>
        </section>

        <section className="rounded-[22px] border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-5">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4" style={{ color: userAccent.activeHex }} />
            <h3 className="font-display text-[16px] font-semibold text-[var(--text-primary)]">
              Triết lý thiết kế
            </h3>
          </div>
          <div className="mt-3 space-y-2.5">
            {CORE_VALUES.map((item) => (
              <div
                key={item.title}
                className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-glass-strong)] px-3.5 py-2.5"
              >
                <p className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                  {item.title}
                </p>
                <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">{item.detail}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Collapsible Technical Information & Audio Architecture */}
      <section className="rounded-[22px] border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-5">
        <button
          type="button"
          onClick={() => setShowTechDetails((prev) => !prev)}
          aria-expanded={showTechDetails}
          data-testid="about-toggle-tech-btn"
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <span className="flex items-center gap-2">
            <Cpu className="h-4 w-4" style={{ color: userAccent.activeHex }} />
            <span className="font-display text-[16px] font-semibold text-[var(--text-primary)]">
              Thông tin kỹ thuật &amp; Audio Engine
            </span>
          </span>
          {showTechDetails ? (
            <ChevronUp className="h-4 w-4 text-[var(--text-muted)]" />
          ) : (
            <ChevronDown className="h-4 w-4 text-[var(--text-muted)]" />
          )}
        </button>

        {showTechDetails && (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-1 gap-3 text-[12.5px] sm:grid-cols-2 lg:grid-cols-3">
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-glass-strong)] p-3.5">
                <p className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                  Audio Playback Engine
                </p>
                <p className="mt-1 font-semibold text-[var(--text-primary)]">
                  HTMLAudioElement + Web Audio AudioDspGraph
                </p>
                <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
                  Protocol nội bộ lossless-media:// (HTTP 206 Byte-Range), 10-Band Graphic &amp; 8-Band Parametric EQ, ReplayGain, Auto Headroom, FFT Spectrum.
                </p>
              </div>

              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-glass-strong)] p-3.5">
                <p className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                  Audio Decoder Pipeline
                </p>
                <p className="mt-1 font-semibold text-[var(--text-primary)]">
                  Chromium Media + ALAC WASM
                </p>
                <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
                  FLAC (với flac-stream-sanitizer), WAV, MP3, AAC, OGG, Opus qua Chromium; ALAC (.m4a) qua{' '}
                  <span className="font-mono-tabular text-[var(--text-secondary)]">
                    {DOREMI_ALAC_DECODER_LABEL}
                  </span>
                  .
                </p>
              </div>

              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-glass-strong)] p-3.5">
                <p className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                  Optional Codec Engine
                </p>
                <p className="mt-1 font-semibold text-[var(--text-primary)]">
                  Isolated (Không đóng gói FFmpeg)
                </p>
                <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
                  Không spawn FFmpeg khi khởi động. Phát nhạc hoạt động độc lập hoàn toàn.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-glass-strong)] p-4 text-[12px] sm:grid-cols-2">
              <div>
                <span className="text-[var(--text-muted)]">Electron / Chromium / Node:</span>
                <p className="font-mono-tabular mt-0.5 text-[var(--text-primary)]">
                  {appInfo
                    ? `Electron ${appInfo.electronVersion} · Chromium ${appInfo.chromeVersion ?? '—'} · Node ${appInfo.nodeVersion ?? '—'}`
                    : 'Đang chạy ở chế độ xem trước trình duyệt'}
                </p>
              </div>
              <div>
                <span className="text-[var(--text-muted)]">Hệ điều hành &amp; Kiến trúc:</span>
                <p className="font-mono-tabular mt-0.5 text-[var(--text-primary)]">
                  {platformText}
                </p>
              </div>
              <div>
                <span className="text-[var(--text-muted)]">V8 / SQLite Engine:</span>
                <p className="font-mono-tabular mt-0.5 text-[var(--text-primary)]">
                  V8 {appInfo?.v8Version ?? '—'} · SQLite {appInfo?.sqliteVersion ?? '3.x'}
                </p>
              </div>
              <div>
                <span className="text-[var(--text-muted)]">Đường dẫn cơ sở dữ liệu:</span>
                <p className="font-mono-tabular mt-0.5 break-all text-[var(--text-primary)]">
                  {appInfo?.databasePath || library.databasePath || '%APPDATA%\\Lossless Player\\library.db'}
                </p>
              </div>
            </div>

            {typeof window !== 'undefined' && window.losslessApi?.probeOptionalCodecs && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-glass-strong)] px-4 py-3 text-[12px]">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-[var(--text-primary)]">
                    Kiểm tra Codec Engine tách biệt (tùy chọn)
                  </p>
                  <p className="mt-0.5 text-[var(--text-muted)]">
                    {codecReport
                      ? codecReport.summary
                      : 'Chỉ kiểm tra khi bạn bấm nút bên cạnh; không ảnh hưởng quá trình khởi động hay phát nhạc.'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={probingCodecs}
                  data-testid="about-probe-codecs-btn"
                  onClick={() => void handleProbeOptionalCodecs()}
                  className="lp-btn-ghost shrink-0 rounded-full px-3.5 py-1.5 text-[12px] font-semibold disabled:opacity-45"
                >
                  {probingCodecs ? 'Đang kiểm tra...' : 'Kiểm tra codec cục bộ'}
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Third-Party Credits */}
      <section className="rounded-[22px] border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-5">
        <button
          type="button"
          onClick={() => setShowCredits((prev) => !prev)}
          aria-expanded={showCredits}
          data-testid="about-toggle-credits-btn"
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <span className="flex items-center gap-2">
            <Scale className="h-4 w-4" style={{ color: userAccent.activeHex }} />
            <span className="font-display text-[16px] font-semibold text-[var(--text-primary)]">
              Thư viện &amp; Công nghệ nguồn mở (Third-Party Credits)
            </span>
          </span>
          {showCredits ? (
            <ChevronUp className="h-4 w-4 text-[var(--text-muted)]" />
          ) : (
            <ChevronDown className="h-4 w-4 text-[var(--text-muted)]" />
          )}
        </button>

        {showCredits && (
          <div className="mt-4 space-y-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {THIRD_PARTY_CREDITS.map((credit) => (
                <div
                  key={credit.name}
                  className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-glass-strong)] px-3.5 py-2.5 text-[12px]"
                >
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-[var(--text-primary)]">
                      {credit.name}
                    </p>
                    <p className="truncate text-[11px] text-[var(--text-muted)]">{credit.role}</p>
                  </div>
                  <span className="font-mono-tabular shrink-0 rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)]">
                    {credit.license}
                  </span>
                </div>
              ))}
            </div>
            <p className="pt-1 text-[11.5px] text-[var(--text-muted)]">
              Danh mục bản quyền đầy đủ được lưu trong tệp{' '}
              <span className="font-mono-tabular text-[var(--text-secondary)]">
                THIRD_PARTY_NOTICES.md
              </span>{' '}
              đi kèm mã nguồn và gói phát hành.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
