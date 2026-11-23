import afterlightCover from '../../../assets/images/album_afterlight_1795373224459.jpg';
import velvetSkyCover from '../../../assets/images/album_velvet_sky_1795373225564.jpg';
import midnightEchoesCover from '../../../assets/images/album_midnight_echoes_1795373225467.jpg';
import blueHourCover from '../../../assets/images/album_blue_hour_1795373225132.jpg';
import goldenBloomCover from '../../../assets/images/album_golden_bloom_1795373225778.jpg';
import quietTidesCover from '../../../assets/images/album_quiet_tides_1795373224426.jpg';
import auroraLinesCover from '../../../assets/images/album_aurora_lines_1795373226748.jpg';
import type { TimedLyricLine } from '../utils/vietnamese-search';

export interface AlbumColorPalette {
  dominant: string;
  secondary: string;
  glowRgb: string;
  secondaryGlowRgb: string;
  badgeBg: string;
  borderGlow: string;
}

export interface PrototypeAlbum {
  id: string;
  title: string;
  artist: string;
  year: number;
  genre: string;
  coverUrl: string;
  formatLabel: string;
  palette: AlbumColorPalette;
  description: string;
}

export interface PrototypeTrack {
  id: string;
  albumId: string;
  title: string;
  artist: string;
  albumTitle: string;
  trackNumber: number;
  durationSec: number;
  formatBadge: string;
  container: string;
  bitDepth: number | null;
  sampleRateHz: number | null;
  bitrateKbps: number;
  fileSizeBytes: number;
  coverUrl: string;
  status: 'available' | 'missing';
  source: 'sample' | 'local';
  addedOrder: number;
  playCount: number;
  lyrics?: TimedLyricLine[];
  plainLyrics?: string[];
  filePathDisplay: string;
}

export interface PrototypePlaylist {
  id: string;
  name: string;
  description: string;
  trackIds: string[];
  updatedLabel: string;
  coverUrl?: string | null;
}

export interface SampleStatsPeriodData {
  totalMinutes: number;
  tracksPlayed: number;
  topArtist: string;
  longestStreakDays: number;
  byDay: Array<{ label: string; minutes: number }>;
  byHour: Array<{ label: string; minutes: number }>;
  topSongs: Array<{
    id: string;
    title: string;
    artist: string;
    albumTitle: string;
    coverUrl: string;
    plays: number;
    minutes: number;
    isDeleted?: boolean;
  }>;
  topArtists: Array<{ name: string; minutes: number; tracks: number; sharePct: number }>;
  topAlbums: Array<{ id: string; title: string; artist: string; coverUrl: string; plays: number }>;
  deletedGroup: {
    trackCount: number;
    totalPlays: number;
    totalMinutes: number;
    note: string;
  };
}

export const PROTOTYPE_ALBUMS: PrototypeAlbum[] = [
  {
    id: 'alb-afterlight',
    title: 'Afterlight',
    artist: 'Nocturne Collective',
    year: 2025,
    genre: 'Ambient Electronic',
    coverUrl: afterlightCover,
    formatLabel: 'FLAC 24-bit / 96 kHz',
    palette: {
      dominant: '#9276D8',
      secondary: '#5B459E',
      glowRgb: '146, 118, 216',
      secondaryGlowRgb: '91, 69, 158',
      badgeBg: 'rgba(146, 118, 216, 0.18)',
      borderGlow: 'rgba(176, 152, 240, 0.45)',
    },
    description: 'Bản thu phòng thu không gian tối với dải trầm ấm và chiều sâu analog tinh khiết.',
  },
  {
    id: 'alb-velvet-sky',
    title: 'Velvet Sky',
    artist: 'Mỹ Linh & Acoustic Trio',
    year: 2024,
    genre: 'Neo-Soul / Vocal Jazz',
    coverUrl: velvetSkyCover,
    formatLabel: 'FLAC 24-bit / 88.2 kHz',
    palette: {
      dominant: '#C46D9E',
      secondary: '#7C3E65',
      glowRgb: '196, 109, 158',
      secondaryGlowRgb: '124, 62, 101',
      badgeBg: 'rgba(196, 109, 158, 0.18)',
      borderGlow: 'rgba(220, 138, 184, 0.45)',
    },
    description: 'Giọng hát mộc mạc hòa quyện cùng piano điện và dàn dây thu trực tiếp.',
  },
  {
    id: 'alb-midnight-echoes',
    title: 'Midnight Echoes',
    artist: 'Đen Vâu & Band',
    year: 2024,
    genre: 'Hip-Hop Acoustic',
    coverUrl: midnightEchoesCover,
    formatLabel: 'FLAC 24-bit / 48 kHz',
    palette: {
      dominant: '#D25D6B',
      secondary: '#873340',
      glowRgb: '210, 93, 107',
      secondaryGlowRgb: '135, 51, 64',
      badgeBg: 'rgba(210, 93, 107, 0.18)',
      borderGlow: 'rgba(232, 122, 135, 0.45)',
    },
    description: 'Những tự sự đêm muộn với nhịp trống ấm, guitar thùng và âm trường gần gũi.',
  },
  {
    id: 'alb-blue-hour',
    title: 'Blue Hour',
    artist: 'Sora Takahashi',
    year: 2025,
    genre: 'Modern Classical',
    coverUrl: blueHourCover,
    formatLabel: 'WAV 24-bit / 192 kHz',
    palette: {
      dominant: '#4D94DC',
      secondary: '#2B5B94',
      glowRgb: '77, 148, 220',
      secondaryGlowRgb: '43, 91, 148',
      badgeBg: 'rgba(77, 148, 220, 0.18)',
      borderGlow: 'rgba(116, 178, 240, 0.45)',
    },
    description: 'Piano đại dương cầm và cello thu âm chuẩn Hi-Res trong khán phòng gỗ.',
  },
  {
    id: 'alb-golden-bloom',
    title: 'Golden Bloom',
    artist: 'Hà Anh Tuấn Quartet',
    year: 2023,
    genre: 'Chamber Ballad',
    coverUrl: goldenBloomCover,
    formatLabel: 'FLAC 24-bit / 96 kHz',
    palette: {
      dominant: '#DF9348',
      secondary: '#965A24',
      glowRgb: '223, 147, 72',
      secondaryGlowRgb: '150, 90, 36',
      badgeBg: 'rgba(223, 147, 72, 0.18)',
      borderGlow: 'rgba(240, 178, 112, 0.48)',
    },
    description: 'Sắc vàng hổ phách của buổi chiều thu với dàn nhạc thính phòng ấm áp.',
  },
  {
    id: 'alb-quiet-tides',
    title: 'Quiet Tides',
    artist: 'Maren Lind',
    year: 2025,
    genre: 'Nordic Folk',
    coverUrl: quietTidesCover,
    formatLabel: 'ALAC 24-bit / 96 kHz',
    palette: {
      dominant: '#44A8AD',
      secondary: '#256970',
      glowRgb: '68, 168, 173',
      secondaryGlowRgb: '37, 105, 112',
      badgeBg: 'rgba(68, 168, 173, 0.18)',
      borderGlow: 'rgba(104, 198, 204, 0.46)',
    },
    description: 'Âm thanh tĩnh lặng của vùng biển Bắc Âu, giàu chi tiết tự nhiên.',
  },
  {
    id: 'alb-aurora-lines',
    title: 'Aurora Lines',
    artist: 'Kaito & The Ensemble',
    year: 2024,
    genre: 'Post-Rock / Instrumental',
    coverUrl: auroraLinesCover,
    formatLabel: 'FLAC 24-bit / 96 kHz',
    palette: {
      dominant: '#50BA95',
      secondary: '#2B755D',
      glowRgb: '80, 186, 149',
      secondaryGlowRgb: '43, 117, 93',
      badgeBg: 'rgba(80, 186, 149, 0.18)',
      borderGlow: 'rgba(116, 214, 178, 0.46)',
    },
    description: 'Những dải hợp âm rộng mở không lời, tối ưu cho tai nghe kiểm âm trở kháng cao.',
  },
];

export const PROTOTYPE_TRACKS: PrototypeTrack[] = [
  // Album 1: Afterlight
  {
    id: 'trk-afterlight-1',
    albumId: 'alb-afterlight',
    title: 'Ánh Đèn Sau Mưa',
    artist: 'Nocturne Collective',
    albumTitle: 'Afterlight',
    trackNumber: 1,
    durationSec: 254,
    formatBadge: 'FLAC · 24-bit / 96 kHz',
    container: 'FLAC',
    bitDepth: 24,
    sampleRateHz: 96000,
    bitrateKbps: 2890,
    fileSizeBytes: 91_800_000,
    coverUrl: afterlightCover,
    status: 'available',
    source: 'sample',
    addedOrder: 18,
    playCount: 42,
    filePathDisplay: 'D:\\Music\\Lossless\\Afterlight\\01 - Anh Den Sau Mua.flac',
    lyrics: [
      { timeSec: 0, text: 'Mưa vừa tạnh trên ô cửa kính mờ' },
      { timeSec: 8, text: 'Ánh đèn thành phố loang chậm giữa đêm sâu' },
      { timeSec: 17, text: 'Kim đĩa than chạm nhẹ lên rãnh nhạc cũ' },
      { timeSec: 26, text: 'Từng nốt trầm ngân dài như hơi thở bình yên' },
      { timeSec: 36, text: 'Không còn tiếng ồn nào ngoài nhịp tim chậm rãi' },
      { timeSec: 46, text: 'Mọi ký ức dịu dàng trở về trong ánh tím' },
      { timeSec: 58, text: 'Ta giữ lại khoảnh khắc này cho riêng mình' },
      { timeSec: 70, text: 'Giữa thế giới lặng thinh và thuần khiết nhất' },
      { timeSec: 84, text: 'Ánh sáng cuối ngày vẫn ở lại trên vai' },
      { timeSec: 98, text: 'Cho đến khi bản nhạc khép lại trong êm đềm' },
    ],
  },
  {
    id: 'trk-afterlight-2',
    albumId: 'alb-afterlight',
    title: 'Violet Horizon',
    artist: 'Nocturne Collective',
    albumTitle: 'Afterlight',
    trackNumber: 2,
    durationSec: 238,
    formatBadge: 'FLAC · 24-bit / 96 kHz',
    container: 'FLAC',
    bitDepth: 24,
    sampleRateHz: 96000,
    bitrateKbps: 2740,
    fileSizeBytes: 81_400_000,
    coverUrl: afterlightCover,
    status: 'available',
    source: 'sample',
    addedOrder: 17,
    playCount: 31,
    filePathDisplay: 'D:\\Music\\Lossless\\Afterlight\\02 - Violet Horizon.flac',
    lyrics: [
      { timeSec: 0, text: 'Drifting past the quiet edge of twilight' },
      { timeSec: 10, text: 'Warm analog echoes floating in the room' },
      { timeSec: 20, text: 'Every frequency clear as glass in shadow' },
      { timeSec: 32, text: 'Slowing down the clock until the dawn arrives' },
      { timeSec: 44, text: 'Hold the horizon in soft violet light' },
      { timeSec: 58, text: 'Let the vinyl turn without a single rush' },
    ],
  },
  {
    id: 'trk-afterlight-3',
    albumId: 'alb-afterlight',
    title: 'Static Dreams (Instrumental)',
    artist: 'Nocturne Collective',
    albumTitle: 'Afterlight',
    trackNumber: 3,
    durationSec: 292,
    formatBadge: 'FLAC · 24-bit / 96 kHz',
    container: 'FLAC',
    bitDepth: 24,
    sampleRateHz: 96000,
    bitrateKbps: 2950,
    fileSizeBytes: 107_600_000,
    coverUrl: afterlightCover,
    status: 'available',
    source: 'sample',
    addedOrder: 16,
    playCount: 19,
    filePathDisplay: 'D:\\Music\\Lossless\\Afterlight\\03 - Static Dreams.flac',
  },

  // Album 2: Velvet Sky
  {
    id: 'trk-velvet-1',
    albumId: 'alb-velvet-sky',
    title: 'Mây Nhung Chiều Muộn',
    artist: 'Mỹ Linh & Acoustic Trio',
    albumTitle: 'Velvet Sky',
    trackNumber: 1,
    durationSec: 268,
    formatBadge: 'FLAC · 24-bit / 88.2 kHz',
    container: 'FLAC',
    bitDepth: 24,
    sampleRateHz: 88200,
    bitrateKbps: 2580,
    fileSizeBytes: 86_200_000,
    coverUrl: velvetSkyCover,
    status: 'available',
    source: 'sample',
    addedOrder: 15,
    playCount: 36,
    filePathDisplay: 'D:\\Music\\Lossless\\Velvet Sky\\01 - May Nhung Chieu Muon.flac',
    lyrics: [
      { timeSec: 0, text: 'Chiều buông màu mận chín sau hàng cây cũ' },
      { timeSec: 9, text: 'Tiếng dương cầm rơi khẽ lên nền gỗ trầm' },
      { timeSec: 19, text: 'Một tách trà ấm bên khung cửa mở hé' },
      { timeSec: 29, text: 'Nghe giọng hát ngân nga qua từng lớp mây nhung' },
      { timeSec: 40, text: 'Chẳng cần vội vã đi qua mùa thu này' },
      { timeSec: 52, text: 'Để giai điệu ôm trọn khoảng lặng bình yên' },
    ],
  },
  {
    id: 'trk-velvet-2',
    albumId: 'alb-velvet-sky',
    title: 'Rosewood & Tape',
    artist: 'Mỹ Linh & Acoustic Trio',
    albumTitle: 'Velvet Sky',
    trackNumber: 2,
    durationSec: 221,
    formatBadge: 'FLAC · 24-bit / 88.2 kHz',
    container: 'FLAC',
    bitDepth: 24,
    sampleRateHz: 88200,
    bitrateKbps: 2490,
    fileSizeBytes: 68_700_000,
    coverUrl: velvetSkyCover,
    status: 'available',
    source: 'sample',
    addedOrder: 14,
    playCount: 22,
    filePathDisplay: 'D:\\Music\\Lossless\\Velvet Sky\\02 - Rosewood & Tape.flac',
  },

  // Album 3: Midnight Echoes (Đen Vâu — supports Vietnamese accent-insensitive search demo)
  {
    id: 'trk-midnight-1',
    albumId: 'alb-midnight-echoes',
    title: 'Đi Qua Phố Đêm',
    artist: 'Đen Vâu & Band',
    albumTitle: 'Midnight Echoes',
    trackNumber: 1,
    durationSec: 246,
    formatBadge: 'FLAC · 24-bit / 48 kHz',
    container: 'FLAC',
    bitDepth: 24,
    sampleRateHz: 48000,
    bitrateKbps: 1680,
    fileSizeBytes: 51_600_000,
    coverUrl: midnightEchoesCover,
    status: 'available',
    source: 'sample',
    addedOrder: 13,
    playCount: 54,
    filePathDisplay: 'D:\\Music\\Lossless\\Midnight Echoes\\01 - Di Qua Pho Dem.flac',
    lyrics: [
      { timeSec: 0, text: 'Đêm Hà Nội gió thổi nhẹ qua hàng sấu' },
      { timeSec: 9, text: 'Bật bản nhạc mộc nghe cho lòng dịu lại' },
      { timeSec: 18, text: 'Những ngày đi xa nhớ mùi cơm nhà ấm' },
      { timeSec: 28, text: 'Nhớ tiếng guitar vang góc quán quen xưa' },
      { timeSec: 39, text: 'Chậm một nhịp thôi để thấy đời rộng mở' },
      { timeSec: 50, text: 'Giữ lại thanh âm nguyên bản trong tim mình' },
    ],
  },
  {
    id: 'trk-midnight-2',
    albumId: 'alb-midnight-echoes',
    title: 'Lối Nhỏ (Acoustic Session)',
    artist: 'Đen Vâu & Band',
    albumTitle: 'Midnight Echoes',
    trackNumber: 2,
    durationSec: 274,
    formatBadge: 'FLAC · 24-bit / 48 kHz',
    container: 'FLAC',
    bitDepth: 24,
    sampleRateHz: 48000,
    bitrateKbps: 1710,
    fileSizeBytes: 58_500_000,
    coverUrl: midnightEchoesCover,
    status: 'available',
    source: 'sample',
    addedOrder: 12,
    playCount: 47,
    filePathDisplay: 'D:\\Music\\Lossless\\Midnight Echoes\\02 - Loi Nho Acoustic.flac',
    lyrics: [
      { timeSec: 0, text: 'Em vào đời bằng đại lộ còn anh vào đời bằng lối nhỏ' },
      { timeSec: 11, text: 'Anh nhớ mình đã từng kể em nghe những buổi chiều gió lộng' },
      { timeSec: 23, text: 'Tiếng bass gỗ trầm ấm rung lên giữa căn phòng tối' },
      { timeSec: 35, text: 'Từng câu chữ mộc mạc rơi chậm theo nhịp trống' },
    ],
  },
  {
    id: 'trk-midnight-3',
    albumId: 'alb-midnight-echoes',
    title: 'Bản Ghi Bị Di Chuyển (Demo Thiếu File)',
    artist: 'Đen Vâu & Band',
    albumTitle: 'Midnight Echoes',
    trackNumber: 3,
    durationSec: 198,
    formatBadge: 'FLAC · 16-bit / 44.1 kHz',
    container: 'FLAC',
    bitDepth: 16,
    sampleRateHz: 44100,
    bitrateKbps: 920,
    fileSizeBytes: 22_800_000,
    coverUrl: midnightEchoesCover,
    status: 'missing',
    source: 'sample',
    addedOrder: 11,
    playCount: 6,
    filePathDisplay: 'E:\\ExternalDrive\\Archive\\03 - Ban Ghi Cu.flac',
  },

  // Album 4: Blue Hour
  {
    id: 'trk-blue-1',
    albumId: 'alb-blue-hour',
    title: 'Nocturne in Cobalt',
    artist: 'Sora Takahashi',
    albumTitle: 'Blue Hour',
    trackNumber: 1,
    durationSec: 312,
    formatBadge: 'WAV · 24-bit / 192 kHz',
    container: 'WAV',
    bitDepth: 24,
    sampleRateHz: 192000,
    bitrateKbps: 9216,
    fileSizeBytes: 359_400_000,
    coverUrl: blueHourCover,
    status: 'available',
    source: 'sample',
    addedOrder: 10,
    playCount: 28,
    filePathDisplay: 'D:\\Music\\HiRes\\Blue Hour\\01 - Nocturne in Cobalt.wav',
    lyrics: [
      { timeSec: 0, text: '蒼い夜に響くピアノの余韻' },
      { timeSec: 0, text: 'Echoes of cobalt keys across the midnight room' },
      { timeSec: 12, text: '雨粒がガラス窓をそっと叩く' },
      { timeSec: 12, text: 'Raindrops tap softly against the quiet glass' },
      { timeSec: 24, text: '静寂の中で息づく純粋な音色' },
      { timeSec: 24, text: 'Pure lossless resonance breathing through the stillness' },
      { timeSec: 36, text: '夜明けまでこの旋律を抱きしめて' },
      { timeSec: 36, text: 'Holding this nocturnal melody until first light' },
    ],
  },
  {
    id: 'trk-blue-2',
    albumId: 'alb-blue-hour',
    title: 'Rain on Glass Keys',
    artist: 'Sora Takahashi',
    albumTitle: 'Blue Hour',
    trackNumber: 2,
    durationSec: 264,
    formatBadge: 'WAV · 24-bit / 192 kHz',
    container: 'WAV',
    bitDepth: 24,
    sampleRateHz: 192000,
    bitrateKbps: 9216,
    fileSizeBytes: 304_100_000,
    coverUrl: blueHourCover,
    status: 'available',
    source: 'sample',
    addedOrder: 9,
    playCount: 18,
    filePathDisplay: 'D:\\Music\\HiRes\\Blue Hour\\02 - Rain on Glass Keys.wav',
  },

  // Album 5: Golden Bloom
  {
    id: 'trk-golden-1',
    albumId: 'alb-golden-bloom',
    title: 'Tháng Tư Là Lời Nói Dối',
    artist: 'Hà Anh Tuấn Quartet',
    albumTitle: 'Golden Bloom',
    trackNumber: 1,
    durationSec: 289,
    formatBadge: 'FLAC · 24-bit / 96 kHz',
    container: 'FLAC',
    bitDepth: 24,
    sampleRateHz: 96000,
    bitrateKbps: 2810,
    fileSizeBytes: 101_400_000,
    coverUrl: goldenBloomCover,
    status: 'available',
    source: 'sample',
    addedOrder: 8,
    playCount: 39,
    filePathDisplay: 'D:\\Music\\Lossless\\Golden Bloom\\01 - Thang Tu.flac',
    lyrics: [
      { timeSec: 0, text: 'Mùa xuân có em như chưa bắt đầu' },
      { timeSec: 10, text: 'Và cơn gió như khẽ mơn man lay từng nhành hoa rơi' },
      { timeSec: 21, text: 'Em đã bước tới như em đã từng' },
      { timeSec: 32, text: 'Chạy trốn với anh trên cánh đồng xanh' },
      { timeSec: 44, text: 'Ánh nắng hổ phách trải dài qua phím đàn ấm' },
      { timeSec: 56, text: 'Giữ lại mùa hoa đẹp nhất trong thanh âm lossless' },
    ],
  },
  {
    id: 'trk-golden-2',
    albumId: 'alb-golden-bloom',
    title: 'Nắng Hổ Phách',
    artist: 'Hà Anh Tuấn Quartet',
    albumTitle: 'Golden Bloom',
    trackNumber: 2,
    durationSec: 241,
    formatBadge: 'FLAC · 24-bit / 96 kHz',
    container: 'FLAC',
    bitDepth: 24,
    sampleRateHz: 96000,
    bitrateKbps: 2690,
    fileSizeBytes: 81_000_000,
    coverUrl: goldenBloomCover,
    status: 'available',
    source: 'sample',
    addedOrder: 7,
    playCount: 24,
    filePathDisplay: 'D:\\Music\\Lossless\\Golden Bloom\\02 - Nang Ho Phach.flac',
  },

  // Album 6: Quiet Tides
  {
    id: 'trk-quiet-1',
    albumId: 'alb-quiet-tides',
    title: 'Harbor Mist',
    artist: 'Maren Lind',
    albumTitle: 'Quiet Tides',
    trackNumber: 1,
    durationSec: 233,
    formatBadge: 'ALAC · 24-bit / 96 kHz',
    container: 'ALAC',
    bitDepth: 24,
    sampleRateHz: 96000,
    bitrateKbps: 2640,
    fileSizeBytes: 76_900_000,
    coverUrl: quietTidesCover,
    status: 'available',
    source: 'sample',
    addedOrder: 6,
    playCount: 21,
    filePathDisplay: 'D:\\Music\\Lossless\\Quiet Tides\\01 - Harbor Mist.m4a',
    lyrics: [
      { timeSec: 0, text: 'Silver water breathing against the timber pier' },
      { timeSec: 11, text: 'Cold teal horizon waking slowly in the fog' },
      { timeSec: 22, text: 'Every string resonates across the quiet bay' },
      { timeSec: 34, text: 'No signal, no noise, only tide and melody' },
    ],
  },
  {
    id: 'trk-quiet-2',
    albumId: 'alb-quiet-tides',
    title: 'Salt & Cedar',
    artist: 'Maren Lind',
    albumTitle: 'Quiet Tides',
    trackNumber: 2,
    durationSec: 215,
    formatBadge: 'ALAC · 24-bit / 96 kHz',
    container: 'ALAC',
    bitDepth: 24,
    sampleRateHz: 96000,
    bitrateKbps: 2510,
    fileSizeBytes: 67_500_000,
    coverUrl: quietTidesCover,
    status: 'available',
    source: 'sample',
    addedOrder: 5,
    playCount: 15,
    filePathDisplay: 'D:\\Music\\Lossless\\Quiet Tides\\02 - Salt & Cedar.m4a',
  },

  // Album 7: Aurora Lines
  {
    id: 'trk-aurora-1',
    albumId: 'alb-aurora-lines',
    title: 'Emerald Refraction',
    artist: 'Kaito & The Ensemble',
    albumTitle: 'Aurora Lines',
    trackNumber: 1,
    durationSec: 304,
    formatBadge: 'FLAC · 24-bit / 96 kHz',
    container: 'FLAC',
    bitDepth: 24,
    sampleRateHz: 96000,
    bitrateKbps: 2980,
    fileSizeBytes: 113_200_000,
    coverUrl: auroraLinesCover,
    status: 'available',
    source: 'sample',
    addedOrder: 4,
    playCount: 27,
    filePathDisplay: 'D:\\Music\\Lossless\\Aurora Lines\\01 - Emerald Refraction.flac',
  },
  {
    id: 'trk-aurora-2',
    albumId: 'alb-aurora-lines',
    title: 'Northern Resonance',
    artist: 'Kaito & The Ensemble',
    albumTitle: 'Aurora Lines',
    trackNumber: 2,
    durationSec: 276,
    formatBadge: 'FLAC · 24-bit / 96 kHz',
    container: 'FLAC',
    bitDepth: 24,
    sampleRateHz: 96000,
    bitrateKbps: 2850,
    fileSizeBytes: 98_300_000,
    coverUrl: auroraLinesCover,
    status: 'available',
    source: 'sample',
    addedOrder: 3,
    playCount: 17,
    filePathDisplay: 'D:\\Music\\Lossless\\Aurora Lines\\02 - Northern Resonance.flac',
  },
];

export const INITIAL_PROTOTYPE_PLAYLISTS: PrototypePlaylist[] = [
  {
    id: 'pl-late-night',
    name: 'Đêm Muộn Lossless',
    description: 'Những bản thu 24-bit tĩnh lặng cho không gian làm việc ban đêm.',
    trackIds: ['trk-afterlight-1', 'trk-velvet-1', 'trk-midnight-1', 'trk-blue-1'],
    updatedLabel: '4 bài hát',
  },
  {
    id: 'pl-velvet-vocal',
    name: 'Velvet Vocal Sessions',
    description: 'Giọng hát mộc và ban nhạc jazz thu trực tiếp trong phòng thu analog.',
    trackIds: ['trk-velvet-1', 'trk-velvet-2', 'trk-golden-1'],
    updatedLabel: '3 bài hát',
  },
  {
    id: 'pl-acoustic-vn',
    name: 'Acoustic Việt Tuyển Chọn',
    description: 'Mộc mạc, gần gũi và giàu cảm xúc từ những bản thu nguyên bản.',
    trackIds: ['trk-midnight-1', 'trk-midnight-2', 'trk-golden-1', 'trk-velvet-1'],
    updatedLabel: '4 bài hát',
  },
  {
    id: 'pl-cobalt-piano',
    name: 'Cobalt & Rain',
    description: 'Piano đêm mưa, âm sắc tinh khiết độ phân giải 192 kHz.',
    trackIds: ['trk-blue-1', 'trk-blue-2', 'trk-afterlight-3'],
    updatedLabel: '3 bài hát',
  },
  {
    id: 'pl-golden-afternoon',
    name: 'Nắng Chiều Hổ Phách',
    description: 'Giai điệu ấm áp cho những buổi chiều cuối tuần thư thái.',
    trackIds: ['trk-golden-1', 'trk-golden-2', 'trk-quiet-1'],
    updatedLabel: '3 bài hát',
  },
  {
    id: 'pl-quiet-tides',
    name: 'Sóng Lặng & Thư Giãn',
    description: 'Không gian âm thanh chậm rãi giúp cân bằng nhịp thở và tâm trí.',
    trackIds: ['trk-quiet-1', 'trk-quiet-2', 'trk-afterlight-2'],
    updatedLabel: '3 bài hát',
  },
  {
    id: 'pl-aurora-focus',
    name: 'Không Lời Tập Trung',
    description: 'Ambient và khí nhạc hiện đại chuẩn Hi-Res dành cho giờ tập trung sâu.',
    trackIds: ['trk-aurora-1', 'trk-aurora-2', 'trk-blue-2', 'trk-afterlight-3'],
    updatedLabel: '4 bài hát',
  },
];

export type StatsPeriod = '7d' | '30d' | 'all';

/**
 * Clearly marked SAMPLE mockup statistics for Screen 09 (Listening Statistics).
 * Never presented as real persisted SQLite play history until a stats backend is built.
 */
export const SAMPLE_STATISTICS_BY_PERIOD: Record<StatsPeriod, SampleStatsPeriodData> = {
  '7d': {
    totalMinutes: 642,
    tracksPlayed: 138,
    topArtist: 'Đen Vâu & Band',
    longestStreakDays: 7,
    byDay: [
      { label: 'T2', minutes: 74 },
      { label: 'T3', minutes: 96 },
      { label: 'T4', minutes: 62 },
      { label: 'T5', minutes: 112 },
      { label: 'T6', minutes: 88 },
      { label: 'T7', minutes: 126 },
      { label: 'CN', minutes: 84 },
    ],
    byHour: [
      { label: '00h', minutes: 48 },
      { label: '04h', minutes: 10 },
      { label: '08h', minutes: 54 },
      { label: '12h', minutes: 42 },
      { label: '16h', minutes: 78 },
      { label: '20h', minutes: 186 },
      { label: '22h', minutes: 224 },
    ],
    topSongs: [
      {
        id: 'trk-midnight-1',
        title: 'Đi Qua Phố Đêm',
        artist: 'Đen Vâu & Band',
        albumTitle: 'Midnight Echoes',
        coverUrl: midnightEchoesCover,
        plays: 19,
        minutes: 78,
      },
      {
        id: 'trk-afterlight-1',
        title: 'Ánh Đèn Sau Mưa',
        artist: 'Nocturne Collective',
        albumTitle: 'Afterlight',
        coverUrl: afterlightCover,
        plays: 16,
        minutes: 68,
      },
      {
        id: 'trk-golden-1',
        title: 'Tháng Tư Là Lời Nói Dối',
        artist: 'Hà Anh Tuấn Quartet',
        albumTitle: 'Golden Bloom',
        coverUrl: goldenBloomCover,
        plays: 14,
        minutes: 67,
      },
      {
        id: 'trk-velvet-1',
        title: 'Mây Nhung Chiều Muộn',
        artist: 'Mỹ Linh & Acoustic Trio',
        albumTitle: 'Velvet Sky',
        coverUrl: velvetSkyCover,
        plays: 12,
        minutes: 54,
      },
      {
        id: 'trk-blue-1',
        title: 'Nocturne in Cobalt',
        artist: 'Sora Takahashi',
        albumTitle: 'Blue Hour',
        coverUrl: blueHourCover,
        plays: 10,
        minutes: 52,
      },
    ],
    topArtists: [
      { name: 'Đen Vâu & Band', minutes: 168, tracks: 3, sharePct: 26 },
      { name: 'Nocturne Collective', minutes: 142, tracks: 3, sharePct: 22 },
      { name: 'Hà Anh Tuấn Quartet', minutes: 118, tracks: 2, sharePct: 18 },
      { name: 'Mỹ Linh & Acoustic Trio', minutes: 104, tracks: 2, sharePct: 16 },
      { name: 'Sora Takahashi', minutes: 72, tracks: 2, sharePct: 11 },
    ],
    topAlbums: [
      { id: 'alb-midnight-echoes', title: 'Midnight Echoes', artist: 'Đen Vâu & Band', coverUrl: midnightEchoesCover, plays: 34 },
      { id: 'alb-afterlight', title: 'Afterlight', artist: 'Nocturne Collective', coverUrl: afterlightCover, plays: 29 },
      { id: 'alb-golden-bloom', title: 'Golden Bloom', artist: 'Hà Anh Tuấn Quartet', coverUrl: goldenBloomCover, plays: 23 },
      { id: 'alb-velvet-sky', title: 'Velvet Sky', artist: 'Mỹ Linh & Acoustic Trio', coverUrl: velvetSkyCover, plays: 19 },
    ],
    deletedGroup: {
      trackCount: 3,
      totalPlays: 14,
      totalMinutes: 56,
      note: 'Các bản thu đã bị xóa khỏi thư viện local nhưng vẫn giữ số liệu lịch sử tổng hợp.',
    },
  },
  '30d': {
    totalMinutes: 2680,
    tracksPlayed: 594,
    topArtist: 'Nocturne Collective',
    longestStreakDays: 19,
    byDay: [
      { label: 'T2', minutes: 310 },
      { label: 'T3', minutes: 380 },
      { label: 'T4', minutes: 340 },
      { label: 'T5', minutes: 410 },
      { label: 'T6', minutes: 430 },
      { label: 'T7', minutes: 460 },
      { label: 'CN', minutes: 350 },
    ],
    byHour: [
      { label: '00h', minutes: 210 },
      { label: '04h', minutes: 45 },
      { label: '08h', minutes: 260 },
      { label: '12h', minutes: 195 },
      { label: '16h', minutes: 380 },
      { label: '20h', minutes: 740 },
      { label: '22h', minutes: 850 },
    ],
    topSongs: [
      {
        id: 'trk-afterlight-1',
        title: 'Ánh Đèn Sau Mưa',
        artist: 'Nocturne Collective',
        albumTitle: 'Afterlight',
        coverUrl: afterlightCover,
        plays: 64,
        minutes: 271,
      },
      {
        id: 'trk-midnight-1',
        title: 'Đi Qua Phố Đêm',
        artist: 'Đen Vâu & Band',
        albumTitle: 'Midnight Echoes',
        coverUrl: midnightEchoesCover,
        plays: 58,
        minutes: 238,
      },
      {
        id: 'trk-golden-1',
        title: 'Tháng Tư Là Lời Nói Dối',
        artist: 'Hà Anh Tuấn Quartet',
        albumTitle: 'Golden Bloom',
        coverUrl: goldenBloomCover,
        plays: 49,
        minutes: 236,
      },
      {
        id: 'trk-velvet-1',
        title: 'Mây Nhung Chiều Muộn',
        artist: 'Mỹ Linh & Acoustic Trio',
        albumTitle: 'Velvet Sky',
        coverUrl: velvetSkyCover,
        plays: 43,
        minutes: 192,
      },
      {
        id: 'trk-aurora-1',
        title: 'Emerald Refraction',
        artist: 'Kaito & The Ensemble',
        albumTitle: 'Aurora Lines',
        coverUrl: auroraLinesCover,
        plays: 36,
        minutes: 182,
      },
    ],
    topArtists: [
      { name: 'Nocturne Collective', minutes: 684, tracks: 3, sharePct: 26 },
      { name: 'Đen Vâu & Band', minutes: 612, tracks: 3, sharePct: 23 },
      { name: 'Hà Anh Tuấn Quartet', minutes: 486, tracks: 2, sharePct: 18 },
      { name: 'Mỹ Linh & Acoustic Trio', minutes: 420, tracks: 2, sharePct: 16 },
      { name: 'Kaito & The Ensemble', minutes: 298, tracks: 2, sharePct: 11 },
    ],
    topAlbums: [
      { id: 'alb-afterlight', title: 'Afterlight', artist: 'Nocturne Collective', coverUrl: afterlightCover, plays: 124 },
      { id: 'alb-midnight-echoes', title: 'Midnight Echoes', artist: 'Đen Vâu & Band', coverUrl: midnightEchoesCover, plays: 112 },
      { id: 'alb-golden-bloom', title: 'Golden Bloom', artist: 'Hà Anh Tuấn Quartet', coverUrl: goldenBloomCover, plays: 94 },
      { id: 'alb-aurora-lines', title: 'Aurora Lines', artist: 'Kaito & The Ensemble', coverUrl: auroraLinesCover, plays: 76 },
    ],
    deletedGroup: {
      trackCount: 7,
      totalPlays: 41,
      totalMinutes: 168,
      note: 'Nhóm tổng hợp các bài đã xóa khỏi ổ cứng hoặc thư viện để tránh đứt gãy tổng thời lượng.',
    },
  },
  all: {
    totalMinutes: 8940,
    tracksPlayed: 2048,
    topArtist: 'Nocturne Collective',
    longestStreakDays: 34,
    byDay: [
      { label: 'T2', minutes: 1080 },
      { label: 'T3', minutes: 1220 },
      { label: 'T4', minutes: 1140 },
      { label: 'T5', minutes: 1360 },
      { label: 'T6', minutes: 1410 },
      { label: 'T7', minutes: 1520 },
      { label: 'CN', minutes: 1210 },
    ],
    byHour: [
      { label: '00h', minutes: 740 },
      { label: '04h', minutes: 180 },
      { label: '08h', minutes: 890 },
      { label: '12h', minutes: 720 },
      { label: '16h', minutes: 1290 },
      { label: '20h', minutes: 2380 },
      { label: '22h', minutes: 2740 },
    ],
    topSongs: [
      {
        id: 'trk-afterlight-1',
        title: 'Ánh Đèn Sau Mưa',
        artist: 'Nocturne Collective',
        albumTitle: 'Afterlight',
        coverUrl: afterlightCover,
        plays: 184,
        minutes: 779,
      },
      {
        id: 'trk-midnight-1',
        title: 'Đi Qua Phố Đêm',
        artist: 'Đen Vâu & Band',
        albumTitle: 'Midnight Echoes',
        coverUrl: midnightEchoesCover,
        plays: 171,
        minutes: 701,
      },
      {
        id: 'trk-golden-1',
        title: 'Tháng Tư Là Lời Nói Dối',
        artist: 'Hà Anh Tuấn Quartet',
        albumTitle: 'Golden Bloom',
        coverUrl: goldenBloomCover,
        plays: 148,
        minutes: 713,
      },
      {
        id: 'trk-velvet-1',
        title: 'Mây Nhung Chiều Muộn',
        artist: 'Mỹ Linh & Acoustic Trio',
        albumTitle: 'Velvet Sky',
        coverUrl: velvetSkyCover,
        plays: 132,
        minutes: 590,
      },
      {
        id: 'trk-blue-1',
        title: 'Nocturne in Cobalt',
        artist: 'Sora Takahashi',
        albumTitle: 'Blue Hour',
        coverUrl: blueHourCover,
        plays: 119,
        minutes: 618,
      },
    ],
    topArtists: [
      { name: 'Nocturne Collective', minutes: 2240, tracks: 3, sharePct: 25 },
      { name: 'Đen Vâu & Band', minutes: 1980, tracks: 3, sharePct: 22 },
      { name: 'Hà Anh Tuấn Quartet', minutes: 1620, tracks: 2, sharePct: 18 },
      { name: 'Mỹ Linh & Acoustic Trio', minutes: 1390, tracks: 2, sharePct: 16 },
      { name: 'Sora Takahashi', minutes: 1020, tracks: 2, sharePct: 11 },
    ],
    topAlbums: [
      { id: 'alb-afterlight', title: 'Afterlight', artist: 'Nocturne Collective', coverUrl: afterlightCover, plays: 412 },
      { id: 'alb-midnight-echoes', title: 'Midnight Echoes', artist: 'Đen Vâu & Band', coverUrl: midnightEchoesCover, plays: 386 },
      { id: 'alb-golden-bloom', title: 'Golden Bloom', artist: 'Hà Anh Tuấn Quartet', coverUrl: goldenBloomCover, plays: 320 },
      { id: 'alb-blue-hour', title: 'Blue Hour', artist: 'Sora Takahashi', coverUrl: blueHourCover, plays: 264 },
    ],
    deletedGroup: {
      trackCount: 12,
      totalPlays: 128,
      totalMinutes: 514,
      note: 'Lịch sử tổng hợp cho 12 bài hát đã bị xóa khỏi thư viện trước đây.',
    },
  },
};

export function getAlbumById(albumId: string): PrototypeAlbum {
  return PROTOTYPE_ALBUMS.find((a) => a.id === albumId) ?? PROTOTYPE_ALBUMS[0];
}
