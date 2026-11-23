import { useState } from 'react';
import {
  AlertTriangle,
  Disc3,
  Heart,
  Layers,
  Play,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import { VinylTurntable, type StoryboardFrameNumber } from '../components/VinylTurntable';
import { PROTOTYPE_ALBUMS, PROTOTYPE_TRACKS } from '../data/prototype-catalog';
import { uiStore, useUiState, type VinylSwapPhase } from '../stores/ui-store';

interface FrameSpec {
  frame: StoryboardFrameNumber;
  title: string;
  timing: string;
  description: string;
  albumIndex: number;
  highlightEmpty?: boolean;
}

const STORYBOARD_FRAMES: FrameSpec[] = [
  {
    frame: 1,
    title: 'Khung 1 · Đang phát Bài A',
    timing: '0.00s',
    description: 'Đĩa than Afterlight (tím) đang quay đều 33⅓ RPM, tay kim kim loại hạ nhẹ lên rãnh đĩa.',
    albumIndex: 0,
  },
  {
    frame: 2,
    title: 'Khung 2 · Nhấc tay kim',
    timing: '0.00s – 0.18s',
    description: 'Tay kim champagne tách khỏi mặt đĩa và xoay ra vị trí chờ; tay kim không quay theo đĩa.',
    albumIndex: 0,
  },
  {
    frame: 3,
    title: 'Khung 3 · Nhấc đĩa cũ ra',
    timing: '0.18s – 0.42s',
    description: 'Đĩa Bài A nâng lên nhẹ theo chiều dọc, mờ dần cùng độ tách bóng đổ trên mâm xoay.',
    albumIndex: 0,
  },
  {
    frame: 4,
    title: 'Khung 4 · Mâm xoay trống (Empty Platter)',
    timing: '0.42s – 0.66s',
    description: 'BẮT BUỘC: Lộ rõ toàn bộ mâm nhôm xước, đệm cao su, trục giữa và tay kim đang ở vị trí chờ.',
    albumIndex: 0,
    highlightEmpty: true,
  },
  {
    frame: 5,
    title: 'Khung 5 · Đặt đĩa mới vào',
    timing: '0.66s – 0.92s',
    description: 'Đĩa Bài B (Golden Bloom — nhãn tròn hổ phách) hạ mượt xuống trục giữa mâm xoay.',
    albumIndex: 4,
  },
  {
    frame: 6,
    title: 'Khung 6 · Hạ tay kim & Phát Bài B',
    timing: '0.92s – 1.12s',
    description: 'Tay kim hạ vào rãnh đĩa mới, ánh sáng nền chuyển mượt từ tím sang vàng hổ phách.',
    albumIndex: 4,
  },
];

export function VinylStoryboardPage() {
  const ui = useUiState();
  const [activeTab, setActiveTab] = useState<'storyboard' | 'states'>('storyboard');
  const [livePhase, setLivePhase] = useState<VinylSwapPhase>('idle');
  const [liveAlbumIndex, setLiveAlbumIndex] = useState(0);
  const [showSampleDialog, setShowSampleDialog] = useState(false);

  const liveAlbum = PROTOTYPE_ALBUMS[liveAlbumIndex];

  const runLiveSwapDemo = () => {
    const nextIdx = liveAlbumIndex === 0 ? 4 : 0;
    setLivePhase('tonearm-lift');
    setTimeout(() => setLivePhase('disc-out'), 200);
    setTimeout(() => setLivePhase('empty-platter'), 460);
    setTimeout(() => {
      setLiveAlbumIndex(nextIdx);
      setLivePhase('disc-in');
    }, 740);
    setTimeout(() => setLivePhase('tonearm-drop'), 1020);
    setTimeout(() => setLivePhase('idle'), 1240);
  };

  return (
    <div className="mx-auto w-full max-w-[1360px] space-y-8 pb-36">
      {/* Header & Switcher */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.16em] text-[#858B97] uppercase">
            Motion & Design System Specification
          </p>
          <h1 className="font-display mt-1 text-[30px] font-semibold tracking-[-0.02em] text-[#F5F6F8]">
            {activeTab === 'storyboard'
              ? 'Storyboard Thay Đĩa Than 6 Khung Hình'
              : 'Component States & Interaction Notes'}
          </h1>
        </div>

        <div className="lp-glass-subtle flex items-center gap-1 rounded-full p-1">
          <button
            type="button"
            onClick={() => setActiveTab('storyboard')}
            className={`flex items-center gap-2 rounded-full px-4 py-2 text-[12.5px] font-medium transition ${
              activeTab === 'storyboard'
                ? 'bg-[#F5F6F8] text-[#090A0D]'
                : 'text-[#B9BEC8] hover:text-[#F5F6F8]'
            }`}
          >
            <Disc3 className="h-3.5 w-3.5" />
            11 · Vinyl Swap Storyboard
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('states')}
            className={`flex items-center gap-2 rounded-full px-4 py-2 text-[12.5px] font-medium transition ${
              activeTab === 'states'
                ? 'bg-[#F5F6F8] text-[#090A0D]'
                : 'text-[#B9BEC8] hover:text-[#F5F6F8]'
            }`}
          >
            <Layers className="h-3.5 w-3.5" />
            12 · Component States
          </button>
        </div>
      </div>

      {activeTab === 'storyboard' ? (
        <>
          {/* Live Interactive Preview Banner */}
          <div className="lp-glass-panel flex flex-col items-center justify-between gap-6 rounded-[26px] p-6 md:flex-row">
            <div className="flex flex-col items-center gap-5 sm:flex-row">
              <VinylTurntable
                coverUrl={liveAlbum.coverUrl}
                albumTitle={liveAlbum.title}
                accentColor={liveAlbum.palette.dominant}
                glowRgb={liveAlbum.palette.glowRgb}
                isPlaying={livePhase === 'idle'}
                sizePx={220}
                swapPhase={livePhase}
                vinylAnimationEnabled={ui.appearance.vinylAnimation}
                reducedMotion={ui.appearance.reducedMotion}
              />
              <div className="max-w-[460px] space-y-2 text-center sm:text-left">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.06] px-3 py-0.5 text-[11px] font-medium text-[#F5F6F8]">
                  <Sparkles className="h-3 w-3" style={{ color: liveAlbum.palette.dominant }} />
                  Trình diễn trực tiếp · Tổng thời lượng ~1.1s
                </span>
                <h2 className="font-display text-[20px] font-semibold text-[#F5F6F8]">
                  Afterlight (Tím) ⇄ Golden Bloom (Hổ phách)
                </h2>
                <p className="text-[13px] leading-relaxed text-[#B9BEC8]">
                  Nhấn nút bên phải để quan sát trọn vẹn 6 giai đoạn cơ học: nhấc tay kim, tách đĩa cũ,
                  lộ rõ mâm xoay trống (Empty Platter), đặt đĩa mới vào trục giữa và hạ tay kim phát tiếp.
                </p>
                <p className="font-mono-tabular text-[12px] text-[#858B97]">
                  Trạng thái hiện tại: <strong className="text-[#F5F6F8]">{livePhase}</strong>
                </p>
              </div>
            </div>

            <div className="flex shrink-0 flex-col gap-2.5">
              <button
                type="button"
                onClick={runLiveSwapDemo}
                className="flex h-11 items-center justify-center gap-2 rounded-full bg-[#F5F6F8] px-6 text-[13px] font-semibold text-[#090A0D] shadow-lg transition hover:scale-[1.02] active:scale-[0.98]"
              >
                <RotateCcw className="h-4 w-4" />
                Chạy mô phỏng thay đĩa
              </button>
              <button
                type="button"
                onClick={() => uiStore.openNowPlaying(true)}
                className="flex h-10 items-center justify-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-5 text-[12.5px] font-medium text-[#F5F6F8] transition hover:bg-white/[0.12]"
              >
                Mở trong Now Playing
              </button>
            </div>
          </div>

          {/* 6-Frame Static Side-by-Side Storyboard Grid (Identical Camera Angle & Lighting) */}
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
            {STORYBOARD_FRAMES.map((item) => {
              const album = PROTOTYPE_ALBUMS[item.albumIndex];
              return (
                <article
                  key={item.frame}
                  className={`lp-glass-panel flex flex-col items-center rounded-[24px] p-5 transition ${
                    item.highlightEmpty
                      ? 'ring-1 ring-[#B89874]/60'
                      : ''
                  }`}
                >
                  <div className="mb-4 flex w-full items-center justify-between gap-2">
                    <span className="text-[13px] font-semibold text-[#F5F6F8]">{item.title}</span>
                    <span className="font-mono-tabular rounded-full border border-white/12 bg-white/[0.06] px-2.5 py-0.5 text-[11px] text-[#B9BEC8]">
                      {item.timing}
                    </span>
                  </div>

                  {/* Identical Camera Angle Turntable Freeze-Frame */}
                  <div className="my-2 flex items-center justify-center">
                    <VinylTurntable
                      coverUrl={album.coverUrl}
                      albumTitle={album.title}
                      accentColor={album.palette.dominant}
                      glowRgb={album.palette.glowRgb}
                      isPlaying={item.frame === 1 || item.frame === 6}
                      sizePx={235}
                      storyboardFrame={item.frame}
                    />
                  </div>

                  <p className="mt-4 text-center text-[12.5px] leading-relaxed text-[#B9BEC8]">
                    {item.description}
                  </p>
                </article>
              );
            })}
          </div>
        </>
      ) : (
        /* Screen 12: Component States & Interaction Notes */
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Buttons & Icon Buttons */}
          <div className="lp-glass-panel space-y-5 rounded-[24px] p-6">
            <h2 className="font-display text-[17px] font-semibold text-[#F5F6F8]">
              1. Primary & Icon Button States
            </h2>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="flex h-10 items-center gap-2 rounded-full bg-[#F5F6F8] px-5 text-[13px] font-semibold text-[#090A0D]"
              >
                <Play className="h-4 w-4 fill-current" /> Default
              </button>
              <button
                type="button"
                className="flex h-10 items-center gap-2 rounded-full bg-white px-5 text-[13px] font-semibold text-[#090A0D] shadow-[0_0_24px_rgba(255,255,255,0.28)]"
              >
                <Play className="h-4 w-4 fill-current" /> Hover / Focus
              </button>
              <button
                type="button"
                className="flex h-10 scale-95 items-center gap-2 rounded-full bg-white/85 px-5 text-[13px] font-semibold text-[#090A0D]"
              >
                Pressed
              </button>
              <button
                type="button"
                disabled
                className="flex h-10 cursor-not-allowed items-center gap-2 rounded-full bg-white/20 px-5 text-[13px] font-semibold text-white/45"
              >
                Disabled
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-white/10 pt-4">
              <span className="text-[12px] text-[#858B97]">Icon Buttons:</span>
              <button
                type="button"
                className="flex h-10 w-10 items-center justify-center rounded-full border border-white/12 bg-white/[0.05] text-[#B9BEC8]"
              >
                <Heart className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="flex h-10 w-10 items-center justify-center rounded-full border border-white/25 bg-white/[0.14] text-[#F5F6F8]"
              >
                <Heart className="h-4 w-4 fill-[#9276D8] text-[#9276D8]" />
              </button>
              <button
                type="button"
                onClick={() => setShowSampleDialog(true)}
                className="ml-auto rounded-full border border-white/15 bg-white/[0.06] px-4 py-2 text-[12px] font-medium text-[#F5F6F8] transition hover:bg-white/[0.12]"
              >
                Mở mẫu Dialog kính mờ
              </button>
            </div>
          </div>

          {/* Track Row States */}
          <div className="lp-glass-panel space-y-4 rounded-[24px] p-6">
            <h2 className="font-display text-[17px] font-semibold text-[#F5F6F8]">
              2. Track Row States (Default / Active / Missing File)
            </h2>
            <div className="space-y-2">
              <div className="flex h-[56px] items-center gap-3.5 rounded-2xl border border-transparent bg-white/[0.03] px-3.5">
                <img
                  src={PROTOTYPE_TRACKS[1].coverUrl}
                  alt=""
                  className="h-10 w-10 rounded-lg object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium text-[#F5F6F8]">Violet Horizon</p>
                  <p className="text-[11.5px] text-[#858B97]">Default Row · FLAC 24-bit / 96 kHz</p>
                </div>
                <span className="font-mono-tabular text-[12px] text-[#858B97]">3:58</span>
              </div>

              <div className="flex h-[56px] items-center gap-3.5 rounded-2xl border border-[#9276D8]/45 bg-[#9276D8]/12 px-3.5">
                <img
                  src={PROTOTYPE_TRACKS[0].coverUrl}
                  alt=""
                  className="h-10 w-10 rounded-lg object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-semibold text-[#BFA8F5]">Ánh Đèn Sau Mưa</p>
                  <p className="text-[11.5px] text-[#F5F6F8]/80">Active Playing State</p>
                </div>
                <span className="rounded-full bg-[#9276D8]/25 px-2.5 py-0.5 text-[10.5px] font-medium text-[#F5F6F8]">
                  Đang phát
                </span>
              </div>

              <div className="flex h-[56px] items-center gap-3.5 rounded-2xl border border-amber-400/25 bg-amber-500/[0.07] px-3.5 opacity-80">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300">
                  <AlertTriangle className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium text-amber-100/90">
                    Bản Ghi Bị Di Chuyển
                  </p>
                  <p className="text-[11.5px] text-amber-200/70">Missing File State · Không tìm thấy trên ổ đĩa</p>
                </div>
                <span className="rounded-full border border-amber-300/30 px-2.5 py-0.5 text-[10.5px] text-amber-200">
                  Thiếu file
                </span>
              </div>
            </div>
          </div>

          {/* Lyrics Line States */}
          <div className="lp-glass-panel space-y-4 rounded-[24px] p-6">
            <h2 className="font-display text-[17px] font-semibold text-[#F5F6F8]">
              3. Synced Lyrics Line Hierarchy
            </h2>
            <div className="space-y-3 rounded-2xl border border-white/10 bg-black/30 p-5">
              <p className="text-[18px] font-medium text-[#F5F6F8]/35">
                Mưa vừa tạnh trên ô cửa kính mờ (Past · 35% opacity)
              </p>
              <p className="font-display text-[26px] font-semibold text-[#F5F6F8]">
                Ánh đèn thành phố loang chậm giữa đêm sâu (Active · 100%)
              </p>
              <p className="text-[19px] font-medium text-[#F5F6F8]/55">
                Kim đĩa than chạm nhẹ lên rãnh nhạc cũ (Upcoming · 55%)
              </p>
            </div>
          </div>

          {/* Motion & Reduced Motion Notes */}
          <div className="lp-glass-panel space-y-4 rounded-[24px] p-6">
            <h2 className="font-display text-[17px] font-semibold text-[#F5F6F8]">
              4. Quy chuẩn chuyển động & Reduced Motion
            </h2>
            <ul className="space-y-2.5 text-[13px] leading-relaxed text-[#B9BEC8]">
              <li>
                <strong className="text-[#F5F6F8]">Album Gallery Reposition:</strong> 450ms{' '}
                <code className="font-mono-tabular text-[12px] text-[#F5F6F8]">cubic-bezier(0.16, 1, 0.3, 1)</code>, ảnh bìa 1:1 không bị kéo dãn.
              </li>
              <li>
                <strong className="text-[#F5F6F8]">Dynamic Ambient Color Shift:</strong> 800ms chuyển màu nền dịu mắt theo album đang chọn/phát.
              </li>
              <li>
                <strong className="text-[#F5F6F8]">Vinyl Swap Sequence:</strong> 1.1s gồm 6 khung có Empty Platter. Khi bật <em>Giảm chuyển động</em> trong Cài đặt, thay bằng chuyển mờ nhẹ và dừng quay đĩa.
              </li>
              <li>
                <strong className="text-[#F5F6F8]">No Duplicate Players:</strong> Mini Player tự động ẩn khi mở Now Playing toàn màn hình.
              </li>
            </ul>
          </div>
        </div>
      )}

      {/* Sample Frosted Glass Modal Dialog */}
      {showSampleDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="lp-glass-panel w-full max-w-[440px] rounded-[26px] p-6">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-[18px] font-semibold text-[#F5F6F8]">
                Xác nhận thao tác thư viện
              </h3>
              <button
                type="button"
                onClick={() => setShowSampleDialog(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-[#858B97] hover:bg-white/10 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-[#B9BEC8]">
              Đây là mẫu Dialog kính mờ dùng cho các thao tác tạo playlist, xác nhận xóa hoặc cảnh báo file thiếu trên Windows Desktop.
            </p>
            <div className="mt-6 flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setShowSampleDialog(false)}
                className="rounded-full border border-white/15 bg-white/[0.06] px-4 py-2 text-[13px] font-medium text-[#B9BEC8] hover:text-white"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowSampleDialog(false);
                  uiStore.showToast('Đã xác nhận mẫu dialog kính mờ');
                }}
                className="rounded-full bg-[#F5F6F8] px-5 py-2 text-[13px] font-semibold text-[#090A0D]"
              >
                Đồng ý
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
