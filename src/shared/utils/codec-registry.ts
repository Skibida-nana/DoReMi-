import type {
  AudioConvertOptions,
  CodecId,
  CodecManifestEntry,
  CodecSupportingFileSpec,
  ConversionPreset,
  ConvertTargetFormat,
  ResourceMode,
  ResourceModePolicy,
  TranscodingProfile,
} from '../types/codec-engine';

export const DEFAULT_ENCODER_PACK_VERSION = '2026.03.13';
export const COMPATIBLE_FOOBAR_PACK_DATE = '2026-03-13';

/**
 * Exact supporting files & license documents present in foobar2000 Free Encoder Pack (2026-03-13).
 */
export const FOOBAR_PACK_SUPPORTING_FILES: readonly CodecSupportingFileSpec[] = [
  {
    fileName: 'nsutil.dll',
    kind: 'supporting-dll',
    includedInFoobarPack: true,
    relatedCodecs: ['fhgaacenc'],
    redistributionStatus: 'license-verification-required',
    verificationStatus: 'pending-desktop-verification',
    description:
      'Thư viện hỗ trợ đi kèm bộ foobar2000 Free Encoder Pack 2026-03-13 (liên quan đến fhgaacenc; cần xác minh phụ thuộc thực tế trên Windows).',
  },
  {
    fileName: 'fhgaacenc_license.txt',
    kind: 'license-file',
    includedInFoobarPack: true,
    relatedCodecs: ['fhgaacenc'],
    license: 'fhgaacenc License (bundled text)',
    redistributionStatus: 'license-verification-required',
    verificationStatus: 'verified',
    description: 'Tệp bản quyền đi kèm fhgaacenc.exe trong Free Encoder Pack 2026-03-13.',
  },
  {
    fileName: 'flac_license.txt',
    kind: 'license-file',
    includedInFoobarPack: true,
    relatedCodecs: ['flac'],
    license: 'BSD-3-Clause',
    redistributionStatus: 'redistributable',
    verificationStatus: 'verified',
    description: 'Tệp bản quyền đi kèm flac.exe trong Free Encoder Pack 2026-03-13.',
  },
  {
    fileName: 'lame_license.txt',
    kind: 'license-file',
    includedInFoobarPack: true,
    relatedCodecs: ['lame'],
    license: 'LGPL-2.0-or-later',
    redistributionStatus: 'redistributable',
    verificationStatus: 'verified',
    description: 'Tệp bản quyền đi kèm lame.exe trong Free Encoder Pack 2026-03-13.',
  },
  {
    fileName: 'opusenc_license.txt',
    kind: 'license-file',
    includedInFoobarPack: true,
    relatedCodecs: ['opusenc'],
    license: 'BSD-3-Clause',
    redistributionStatus: 'redistributable',
    verificationStatus: 'verified',
    description: 'Tệp bản quyền đi kèm opusenc.exe trong Free Encoder Pack 2026-03-13.',
  },
  {
    fileName: 'wavpack_license.txt',
    kind: 'license-file',
    includedInFoobarPack: true,
    relatedCodecs: ['wavpack'],
    license: 'BSD-3-Clause',
    redistributionStatus: 'redistributable',
    verificationStatus: 'verified',
    description: 'Tệp bản quyền đi kèm wavpack.exe trong Free Encoder Pack 2026-03-13.',
  },
];

/**
 * Canonical Codec Registry accurately synchronized with foobar2000 Free Encoder Pack (2026-03-13).
 * Strict separation between:
 *  - default-encoder-pack (actual 9 encoder executables in 2026-03-13 pack)
 *  - additional-decoder (standalone decoders NOT included in the 2026-03-13 Encoder Pack)
 *  - optional-encoder (optional third-party encoders NOT included in the 2026-03-13 Encoder Pack)
 *  - ffmpeg / ffprobe (external universal suite)
 *  - builtin-wasm (DoReMi built-in ALAC WASM decoder)
 */
export const DEFAULT_CODEC_MANIFEST: readonly CodecManifestEntry[] = [
  // =========================================================================
  // 1. DEFAULT ENCODER PACK (foobar2000 Free Encoder Pack 2026-03-13 — exact 9 encoders)
  // =========================================================================
  {
    id: 'flac',
    name: 'FLAC Reference Encoder',
    displayFormat: 'FLAC Lossless',
    category: 'encoder',
    group: 'default-encoder-pack',
    capabilities: ['encode', 'decode'],
    extensions: ['.flac'],
    winExecutableNames: ['flac.exe', 'flac64.exe'],
    posixExecutableNames: ['flac'],
    versionArgs: ['--version'],
    acceptedVersionExitCodes: [0],
    versionIdentityPatterns: ['flac'],
    license: 'BSD-3-Clause',
    licenseFile: 'flac_license.txt',
    redistributionStatus: 'redistributable',
    officialSource: 'https://xiph.org/flac/',
    expectedSha256: null,
    supportedPlatforms: ['win32', 'darwin', 'linux'],
    supportedArchitectures: ['x64', 'x86', 'arm64'],
    requiredDependencies: [],
    includedInFoobarPack: true,
    optional: false,
    description: 'Bộ mã hóa và giải mã chuẩn tham chiếu Xiph FLAC lossless không suy hao.',
    officialHomepage: 'https://xiph.org/flac/',
  },
  {
    id: 'lame',
    name: 'LAME MP3 Encoder',
    displayFormat: 'MP3 (MPEG-1 Layer III)',
    category: 'encoder',
    group: 'default-encoder-pack',
    capabilities: ['encode'],
    extensions: ['.mp3'],
    winExecutableNames: ['lame.exe', 'lame64.exe'],
    posixExecutableNames: ['lame'],
    versionArgs: ['--version'],
    acceptedVersionExitCodes: [0],
    versionIdentityPatterns: ['lame'],
    license: 'LGPL-2.0-or-later',
    licenseFile: 'lame_license.txt',
    redistributionStatus: 'redistributable',
    officialSource: 'https://lame.sourceforge.io/',
    expectedSha256: null,
    supportedPlatforms: ['win32', 'darwin', 'linux'],
    supportedArchitectures: ['x64', 'x86', 'arm64'],
    requiredDependencies: [],
    includedInFoobarPack: true,
    optional: false,
    description: 'Bộ mã hóa MP3 chất lượng cao (V0–V6 VBR & 128–320 kbps CBR).',
    officialHomepage: 'https://lame.sourceforge.io/',
  },
  {
    id: 'opusenc',
    name: 'Opus Tools Encoder',
    displayFormat: 'Opus',
    category: 'encoder',
    group: 'default-encoder-pack',
    capabilities: ['encode'],
    extensions: ['.opus'],
    winExecutableNames: ['opusenc.exe'],
    posixExecutableNames: ['opusenc'],
    versionArgs: ['--version'],
    acceptedVersionExitCodes: [0],
    versionIdentityPatterns: ['opusenc', 'opus-tools', 'libopus'],
    license: 'BSD-3-Clause',
    licenseFile: 'opusenc_license.txt',
    redistributionStatus: 'redistributable',
    officialSource: 'https://opus-codec.org/',
    expectedSha256: null,
    supportedPlatforms: ['win32', 'darwin', 'linux'],
    supportedArchitectures: ['x64', 'x86', 'arm64'],
    requiredDependencies: [],
    includedInFoobarPack: true,
    optional: false,
    description: 'Bộ mã hóa Xiph Opus hiệu suất nén vượt trội cho nghe di động và streaming.',
    officialHomepage: 'https://opus-codec.org/',
  },
  {
    id: 'oggenc',
    name: 'Ogg Vorbis Encoder (oggenc2)',
    displayFormat: 'Ogg Vorbis',
    category: 'encoder',
    group: 'default-encoder-pack',
    capabilities: ['encode'],
    extensions: ['.ogg'],
    winExecutableNames: ['oggenc2.exe', 'oggenc.exe'],
    posixExecutableNames: ['oggenc', 'oggenc2'],
    versionArgs: ['--version'],
    acceptedVersionExitCodes: [0],
    versionIdentityPatterns: ['oggenc', 'vorbis'],
    license: 'BSD-3-Clause',
    licenseFile: null,
    redistributionStatus: 'redistributable',
    officialSource: 'https://xiph.org/vorbis/',
    expectedSha256: null,
    supportedPlatforms: ['win32', 'darwin', 'linux'],
    supportedArchitectures: ['x64', 'x86', 'arm64'],
    requiredDependencies: [],
    includedInFoobarPack: true,
    optional: false,
    description: 'Bộ mã hóa Ogg Vorbis (aoTuV / oggenc2) hỗ trợ thang chất lượng Q0–Q10.',
    officialHomepage: 'https://xiph.org/vorbis/',
  },
  {
    id: 'wavpack',
    name: 'WavPack Encoder',
    displayFormat: 'WavPack Lossless',
    category: 'encoder',
    group: 'default-encoder-pack',
    capabilities: ['encode'],
    extensions: ['.wv'],
    winExecutableNames: ['wavpack.exe'],
    posixExecutableNames: ['wavpack'],
    versionArgs: ['--version'],
    acceptedVersionExitCodes: [0],
    versionIdentityPatterns: ['wavpack'],
    license: 'BSD-3-Clause',
    licenseFile: 'wavpack_license.txt',
    redistributionStatus: 'redistributable',
    officialSource: 'https://www.wavpack.com/',
    expectedSha256: null,
    supportedPlatforms: ['win32', 'darwin', 'linux'],
    supportedArchitectures: ['x64', 'x86', 'arm64'],
    requiredDependencies: [],
    includedInFoobarPack: true,
    optional: false,
    description: 'Bộ mã hóa WavPack hỗ trợ PCM 16/24/32-bit, float và chế độ lossless/hybrid.',
    officialHomepage: 'https://www.wavpack.com/',
  },
  {
    id: 'mpcenc',
    name: 'Musepack SV8 Encoder',
    displayFormat: 'Musepack (MPC)',
    category: 'encoder',
    group: 'default-encoder-pack',
    capabilities: ['encode'],
    extensions: ['.mpc'],
    winExecutableNames: ['mpcenc.exe'],
    posixExecutableNames: ['mpcenc'],
    versionArgs: ['--version'],
    acceptedVersionExitCodes: [0],
    versionIdentityPatterns: ['mpcenc', 'musepack'],
    license: 'LGPL-2.1',
    licenseFile: null,
    redistributionStatus: 'redistributable',
    officialSource: 'https://www.musepack.net/',
    expectedSha256: null,
    supportedPlatforms: ['win32', 'darwin', 'linux'],
    supportedArchitectures: ['x64', 'x86'],
    requiredDependencies: [],
    includedInFoobarPack: true,
    optional: true,
    description:
      'Bộ mã hóa Musepack SV8 (có trong Free Encoder Pack 2026-03-13; thực thi Windows CLI cần Pending Desktop Verification).',
    officialHomepage: 'https://www.musepack.net/',
  },
  {
    id: 'refalac',
    name: 'Reference ALAC Encoder (refalac64)',
    displayFormat: 'ALAC (Apple Lossless M4A)',
    category: 'encoder',
    group: 'default-encoder-pack',
    capabilities: ['encode'],
    extensions: ['.m4a'],
    winExecutableNames: ['refalac64.exe', 'refalac.exe'],
    posixExecutableNames: ['refalac'],
    versionArgs: ['--check'],
    acceptedVersionExitCodes: [0],
    versionIdentityPatterns: ['refalac'],
    license: 'Apache-2.0 (Apple ALAC) / Public Domain (nu774)',
    licenseFile: null,
    redistributionStatus: 'redistributable',
    officialSource: 'https://github.com/nu774/qaac',
    expectedSha256: null,
    supportedPlatforms: ['win32'],
    supportedArchitectures: ['x64', 'x86'],
    requiredDependencies: [],
    includedInFoobarPack: true,
    optional: true,
    description:
      'Bộ mã hóa Apple Lossless (ALAC) độc lập từ dự án nu774 — không cần Apple CoreAudioToolbox, tách biệt hoàn toàn với QAAC và ALAC WASM Decoder.',
    officialHomepage: 'https://github.com/nu774/qaac',
  },
  {
    id: 'qaac',
    name: 'QAAC (Apple CoreAudio AAC/ALAC)',
    displayFormat: 'AAC / ALAC (M4A)',
    category: 'encoder',
    group: 'default-encoder-pack',
    capabilities: ['encode'],
    extensions: ['.m4a', '.aac'],
    winExecutableNames: ['qaac64.exe', 'qaac.exe'],
    posixExecutableNames: ['qaac'],
    versionArgs: ['--check'],
    acceptedVersionExitCodes: [0],
    versionIdentityPatterns: ['qaac'],
    license: 'Public Domain (CLI wrapper) + Apple Application Support (proprietary runtime)',
    licenseFile: null,
    redistributionStatus: 'license-verification-required',
    officialSource: 'https://github.com/nu774/qaac',
    expectedSha256: null,
    supportedPlatforms: ['win32'],
    supportedArchitectures: ['x64', 'x86'],
    requiredDependencies: [
      {
        name: 'CoreAudioToolbox.dll',
        kind: 'system-runtime',
        required: true,
        verificationStatus: 'pending-desktop-verification',
        description:
          'Yêu cầu Apple Application Support / CoreAudioToolbox.dll trên Windows để mã hóa AAC qua QAAC.',
      },
    ],
    includedInFoobarPack: true,
    optional: true,
    description:
      'Bộ mã hóa AAC TVBR/CVBR và ALAC dùng Apple CoreAudio trên Windows (có trong Free Encoder Pack 2026-03-13; yêu cầu CoreAudioToolbox.dll).',
    officialHomepage: 'https://github.com/nu774/qaac',
  },
  {
    id: 'fhgaacenc',
    name: 'Fraunhofer AAC Encoder (fhgaacenc)',
    displayFormat: 'AAC-LC / HE-AAC (M4A)',
    category: 'encoder',
    group: 'default-encoder-pack',
    capabilities: ['encode'],
    extensions: ['.m4a', '.aac'],
    winExecutableNames: ['fhgaacenc.exe'],
    posixExecutableNames: [],
    versionArgs: ['--version'],
    acceptedVersionExitCodes: [0],
    versionIdentityPatterns: ['fhgaacenc', 'fraunhofer'],
    license: 'fhgaacenc wrapper license + Winamp enc_fhgaac proprietary DLL',
    licenseFile: 'fhgaacenc_license.txt',
    redistributionStatus: 'license-verification-required',
    officialSource: 'https://www.foobar2000.org/encoderpack',
    expectedSha256: null,
    supportedPlatforms: ['win32'],
    supportedArchitectures: ['x86', 'x64'],
    requiredDependencies: [
      {
        name: 'nsutil.dll',
        kind: 'supporting-dll',
        required: true,
        verificationStatus: 'pending-desktop-verification',
        description:
          'Thư viện hỗ trợ đi kèm trong foobar2000 Free Encoder Pack 2026-03-13 (cần xác minh thực tế trên Windows).',
      },
      {
        name: 'enc_fhgaac.dll',
        kind: 'system-runtime',
        required: true,
        verificationStatus: 'pending-desktop-verification',
        description:
          'Yêu cầu thư viện Fraunhofer enc_fhgaac.dll do người dùng cung cấp hợp lệ trên Windows (không phân phối lại tự động).',
      },
    ],
    includedInFoobarPack: true,
    optional: true,
    description:
      'CLI wrapper Fraunhofer AAC trong Free Encoder Pack 2026-03-13 (tách biệt với FDK-AAC; không đánh dấu Ready nếu thiếu DLL phụ thuộc).',
    officialHomepage: 'https://www.foobar2000.org/encoderpack',
  },

  // =========================================================================
  // 2. ADDITIONAL DECODERS (NOT included in foobar2000 Free Encoder Pack 2026-03-13)
  // =========================================================================
  {
    id: 'opusdec',
    name: 'Opus Tools Decoder',
    displayFormat: 'Opus Decode',
    category: 'decoder',
    group: 'additional-decoder',
    capabilities: ['decode'],
    extensions: ['.opus'],
    winExecutableNames: ['opusdec.exe'],
    posixExecutableNames: ['opusdec'],
    versionArgs: ['--version'],
    acceptedVersionExitCodes: [0],
    versionIdentityPatterns: ['opusdec', 'opus-tools', 'libopus'],
    license: 'BSD-3-Clause',
    licenseFile: null,
    redistributionStatus: 'redistributable',
    officialSource: 'https://opus-codec.org/',
    expectedSha256: null,
    supportedPlatforms: ['win32', 'darwin', 'linux'],
    supportedArchitectures: ['x64', 'x86', 'arm64'],
    requiredDependencies: [],
    includedInFoobarPack: false,
    optional: true,
    description: 'Bộ giải mã Opus độc lập sang PCM WAV (tùy chọn ngoài Free Encoder Pack 2026-03-13).',
    officialHomepage: 'https://opus-codec.org/',
  },
  {
    id: 'wvunpack',
    name: 'WavPack Decoder',
    displayFormat: 'WavPack Decode',
    category: 'decoder',
    group: 'additional-decoder',
    capabilities: ['decode'],
    extensions: ['.wv'],
    winExecutableNames: ['wvunpack.exe'],
    posixExecutableNames: ['wvunpack'],
    versionArgs: ['--version'],
    acceptedVersionExitCodes: [0],
    versionIdentityPatterns: ['wvunpack', 'wavpack'],
    license: 'BSD-3-Clause',
    licenseFile: null,
    redistributionStatus: 'redistributable',
    officialSource: 'https://www.wavpack.com/',
    expectedSha256: null,
    supportedPlatforms: ['win32', 'darwin', 'linux'],
    supportedArchitectures: ['x64', 'x86', 'arm64'],
    requiredDependencies: [],
    includedInFoobarPack: false,
    optional: true,
    description: 'Bộ giải mã WavPack (.wv) độc lập (tùy chọn ngoài Free Encoder Pack 2026-03-13).',
    officialHomepage: 'https://www.wavpack.com/',
  },
  {
    id: 'mpcdec',
    name: 'Musepack SV8 Decoder',
    displayFormat: 'Musepack Decode',
    category: 'decoder',
    group: 'additional-decoder',
    capabilities: ['decode'],
    extensions: ['.mpc'],
    winExecutableNames: ['mpcdec.exe'],
    posixExecutableNames: ['mpcdec'],
    versionArgs: ['-h'],
    acceptedVersionExitCodes: [0, 1],
    versionIdentityPatterns: ['mpcdec', 'musepack'],
    license: 'BSD-3-Clause',
    licenseFile: null,
    redistributionStatus: 'redistributable',
    officialSource: 'https://www.musepack.net/',
    expectedSha256: null,
    supportedPlatforms: ['win32', 'darwin', 'linux'],
    supportedArchitectures: ['x64', 'x86'],
    requiredDependencies: [],
    includedInFoobarPack: false,
    optional: true,
    description: 'Bộ giải mã Musepack (.mpc) độc lập (tùy chọn ngoài Free Encoder Pack 2026-03-13).',
    officialHomepage: 'https://www.musepack.net/',
  },

  // =========================================================================
  // 3. OPTIONAL THIRD-PARTY ENCODERS (NOT included in foobar2000 Free Encoder Pack 2026-03-13)
  // =========================================================================
  {
    id: 'fdkaac',
    name: 'FDK-AAC Encoder',
    displayFormat: 'AAC-LC / HE-AAC',
    category: 'encoder',
    group: 'optional-encoder',
    capabilities: ['encode'],
    extensions: ['.m4a', '.aac'],
    winExecutableNames: ['fdkaac.exe'],
    posixExecutableNames: ['fdkaac'],
    versionArgs: ['--version'],
    acceptedVersionExitCodes: [0],
    versionIdentityPatterns: ['fdkaac', 'libfdk'],
    license: 'Fraunhofer FDK AAC License (non-GPL compatible)',
    licenseFile: null,
    redistributionStatus: 'license-verification-required',
    officialSource: 'https://github.com/nu774/fdkaac',
    expectedSha256: null,
    supportedPlatforms: ['win32', 'darwin', 'linux'],
    supportedArchitectures: ['x64', 'x86', 'arm64'],
    requiredDependencies: [],
    includedInFoobarPack: false,
    optional: true,
    description:
      'Bộ mã hóa Fraunhofer FDK-AAC tùy chọn (không có trong Free Encoder Pack 2026-03-13; tách biệt với fhgaacenc).',
    officialHomepage: 'https://github.com/nu774/fdkaac',
  },
  {
    id: 'tak',
    name: 'TAK Lossless Codec',
    displayFormat: 'TAK Lossless',
    category: 'encoder',
    group: 'optional-encoder',
    capabilities: ['encode', 'decode'],
    extensions: ['.tak'],
    winExecutableNames: ['Takc.exe', 'takc.exe'],
    posixExecutableNames: ['takc'],
    versionArgs: ['-v'],
    acceptedVersionExitCodes: [0, 1],
    versionIdentityPatterns: ['tak'],
    license: 'Proprietary Freeware (non-redistributable without permission)',
    licenseFile: null,
    redistributionStatus: 'non-redistributable',
    officialSource: 'https://thbeck.de/Tak/Tak.html',
    expectedSha256: null,
    supportedPlatforms: ['win32'],
    supportedArchitectures: ['x86', 'x64'],
    requiredDependencies: [],
    includedInFoobarPack: false,
    optional: true,
    description:
      'Bộ nén lossless TAK do người dùng tự cung cấp (freeware đóng nguồn, không có trong Free Encoder Pack 2026-03-13 và không tự phân phối lại).',
    officialHomepage: 'https://thbeck.de/Tak/Tak.html',
  },
  {
    id: 'mac',
    name: "Monkey's Audio (APE)",
    displayFormat: "Monkey's Audio (.ape)",
    category: 'encoder',
    group: 'optional-encoder',
    capabilities: ['encode', 'decode'],
    extensions: ['.ape'],
    winExecutableNames: ['MAC.exe', 'mac.exe'],
    posixExecutableNames: ['mac'],
    versionArgs: ['-v'],
    acceptedVersionExitCodes: [0, 1],
    versionIdentityPatterns: ['monkey', 'mac'],
    license: 'BSD-3-Clause',
    licenseFile: null,
    redistributionStatus: 'redistributable',
    officialSource: 'https://www.monkeysaudio.com/',
    expectedSha256: null,
    supportedPlatforms: ['win32', 'darwin', 'linux'],
    supportedArchitectures: ['x64', 'x86'],
    requiredDependencies: [],
    includedInFoobarPack: false,
    optional: true,
    description:
      "Bộ nén/giải mã lossless Monkey's Audio (.ape) tùy chọn (không có trong Free Encoder Pack 2026-03-13).",
    officialHomepage: 'https://www.monkeysaudio.com/',
  },

  // =========================================================================
  // 4. FFMPEG & FFPROBE SUITE (Separate universal engine, NOT part of foobar2000 pack)
  // =========================================================================
  {
    id: 'ffmpeg',
    name: 'FFmpeg Audio Engine',
    displayFormat: 'Universal Transcoder / Decoder',
    category: 'transcoder',
    group: 'ffmpeg',
    capabilities: ['encode', 'decode', 'stream-transcode'],
    extensions: [
      '.flac',
      '.wav',
      '.m4a',
      '.mp3',
      '.opus',
      '.ogg',
      '.aac',
      '.wv',
      '.ape',
      '.aiff',
      '.wma',
      '.mpc',
    ],
    winExecutableNames: ['ffmpeg.exe'],
    posixExecutableNames: ['ffmpeg'],
    versionArgs: ['-version'],
    acceptedVersionExitCodes: [0],
    versionIdentityPatterns: ['ffmpeg version'],
    license: 'LGPL-2.1+ or GPL-2.0+ (depends on build configuration)',
    licenseFile: null,
    redistributionStatus: 'license-verification-required',
    officialSource: 'https://ffmpeg.org/',
    expectedSha256: null,
    supportedPlatforms: ['win32', 'darwin', 'linux'],
    supportedArchitectures: ['x64', 'x86', 'arm64'],
    requiredDependencies: [],
    includedInFoobarPack: false,
    optional: false,
    description:
      'Động cơ giải mã và chuyển đổi đa định dạng (provider fallback cho AAC/ALAC/WAV/FLAC; cần kiểm tra giấy phép bản build trước khi đóng gói phân phối).',
    officialHomepage: 'https://ffmpeg.org/',
  },
  {
    id: 'ffprobe',
    name: 'FFprobe Media Analyzer',
    displayFormat: 'Deep Stream & Loudness Probe',
    category: 'analyzer',
    group: 'ffprobe',
    capabilities: ['probe'],
    extensions: [
      '.flac',
      '.wav',
      '.m4a',
      '.mp3',
      '.opus',
      '.ogg',
      '.aac',
      '.wv',
      '.ape',
      '.tak',
      '.mpc',
    ],
    winExecutableNames: ['ffprobe.exe'],
    posixExecutableNames: ['ffprobe'],
    versionArgs: ['-version'],
    acceptedVersionExitCodes: [0],
    versionIdentityPatterns: ['ffprobe version'],
    license: 'LGPL-2.1+ or GPL-2.0+ (depends on build configuration)',
    licenseFile: null,
    redistributionStatus: 'license-verification-required',
    officialSource: 'https://ffmpeg.org/',
    expectedSha256: null,
    supportedPlatforms: ['win32', 'darwin', 'linux'],
    supportedArchitectures: ['x64', 'x86', 'arm64'],
    requiredDependencies: [],
    includedInFoobarPack: false,
    optional: false,
    description:
      'Công cụ phân tích luồng âm thanh chi tiết (codec, sample format, bit depth, sample rate, tag).',
    officialHomepage: 'https://ffmpeg.org/',
  },

  // =========================================================================
  // 5. BUILT-IN WASM DECODER (Always available offline inside DoReMi)
  // =========================================================================
  {
    id: 'alac-wasm',
    name: 'DoReMi Built-in ALAC WASM',
    displayFormat: 'Apple Lossless (ALAC M4A)',
    category: 'decoder',
    group: 'builtin-wasm',
    capabilities: ['decode'],
    extensions: ['.m4a'],
    winExecutableNames: [],
    posixExecutableNames: [],
    versionArgs: [],
    acceptedVersionExitCodes: [0],
    versionIdentityPatterns: [],
    license: 'MIT (@mgz-dev/alac)',
    licenseFile: null,
    redistributionStatus: 'builtin',
    officialSource: 'https://github.com/nicolo-ribaudo/alac',
    expectedSha256: null,
    supportedPlatforms: ['win32', 'darwin', 'linux'],
    supportedArchitectures: ['universal'],
    requiredDependencies: [],
    includedInFoobarPack: false,
    optional: false,
    description:
      'Bộ giải mã ALAC tích hợp sẵn trong DoReMi — hoạt động 100% offline không cần binary ngoài (tách biệt với refalac64 và QAAC).',
    officialHomepage: 'https://github.com/nicolo-ribaudo/alac',
  },
];

export const DEFAULT_RESOURCE_MODE: ResourceMode = 'power-saving';

/**
 * Resource Management Policies (Music Player First, U-series laptop / 8GB RAM friendly).
 * Switching resource modes NEVER degrades audio quality — it only controls concurrency, thread count,
 * discovery pace, and event throttling.
 */
export const RESOURCE_MODE_POLICIES: Record<ResourceMode, ResourceModePolicy> = {
  'power-saving': {
    mode: 'power-saving',
    label: 'Power Saving (Mặc định)',
    description:
      'Ưu tiên tối đa độ ổn định phát nhạc và CPU/RAM thấp trên laptop tiết kiệm điện (1 tác vụ chuyển đổi mỗi lúc, nhường tài nguyên khi đang phát nhạc).',
    maxConversionConcurrency: 1,
    maxEncoderThreads: 1,
    maxProbeConcurrency: 1,
    maxAnalyzerConcurrency: 1,
    progressThrottleMs: 350,
    deferNewJobsDuringPlayback: true,
    playbackConversionConcurrencyCap: 1,
    playbackEncoderThreadsCap: 1,
    deferProbeWhenPlaybackActive: true,
    deferHeavyAnalysisWhenPlaybackActive: true,
  },
  balanced: {
    mode: 'balanced',
    label: 'Balanced',
    description:
      'Cân bằng tốc độ xử lý và tài nguyên hệ thống (tối đa 2 tác vụ khi không phát nhạc; tự hạ xuống 1 tác vụ khi đang phát nhạc).',
    maxConversionConcurrency: 2,
    maxEncoderThreads: 2,
    maxProbeConcurrency: 1,
    maxAnalyzerConcurrency: 2,
    progressThrottleMs: 250,
    deferNewJobsDuringPlayback: false,
    playbackConversionConcurrencyCap: 1,
    playbackEncoderThreadsCap: 1,
    deferProbeWhenPlaybackActive: true,
    deferHeavyAnalysisWhenPlaybackActive: true,
  },
  performance: {
    mode: 'performance',
    label: 'Performance (Opt-in)',
    description:
      'Ưu tiên tốc độ chuyển đổi hàng loạt nhưng vẫn có trần an toàn để tránh quá tải CPU/RAM; vẫn giới hạn tiến trình khi đang phát nhạc.',
    maxConversionConcurrency: 3,
    maxEncoderThreads: 4,
    maxProbeConcurrency: 2,
    maxAnalyzerConcurrency: 2,
    progressThrottleMs: 150,
    deferNewJobsDuringPlayback: false,
    playbackConversionConcurrencyCap: 1,
    playbackEncoderThreadsCap: 2,
    deferProbeWhenPlaybackActive: false,
    deferHeavyAnalysisWhenPlaybackActive: false,
  },
};

/**
 * Required FFmpeg encoder names (from `ffmpeg -encoders`) for each conversion target.
 * Empty array means stock FFmpeg does not ship an encoder for that format by default.
 */
export const FFMPEG_ENCODER_BY_TARGET: Record<ConvertTargetFormat, readonly string[]> = {
  flac: ['flac'],
  wav: ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_f64le'],
  alac: ['alac'],
  wv: ['wavpack'],
  opus: ['libopus', 'opus'],
  mp3: ['libmp3lame'],
  ogg: ['libvorbis'],
  aac: ['libfdk_aac', 'aac'],
  mpc: [],
};

export const DEFAULT_CONVERT_OPTIONS: AudioConvertOptions = {
  targetFormat: 'flac',
  flacCompressionLevel: 5,
  flacVerify: true,
  mp3Mode: 'vbr',
  mp3VbrQuality: 0,
  bitrateKbps: 192,
  vorbisQuality: 6,
  wavpackMode: 'normal',
  musepackQuality: 5,
  sampleRateHz: 'source',
  bitDepth: 'source',
  channels: 'source',
  preserveMetadata: true,
  preserveArtwork: true,
  conflictPolicy: 'rename',
  outputDirectory: null,
  autoImportToLibrary: false,
  preferNativeEncoder: true,
  concurrency: 1,
  resourceMode: DEFAULT_RESOURCE_MODE,
  maxThreads: null,
  verifyPcmOnLossless: false,
};

export const CONVERSION_PRESETS: readonly ConversionPreset[] = [
  {
    id: 'audiophile-flac',
    name: 'FLAC Lưu trữ chuẩn (Level 5)',
    subtitle: 'Lossless 100% · Giữ nguyên sample rate & bit depth · Kiểm tra MD5',
    category: 'lossless',
    options: {
      targetFormat: 'flac',
      flacCompressionLevel: 5,
      flacVerify: true,
      sampleRateHz: 'source',
      bitDepth: 'source',
      channels: 'source',
    },
  },
  {
    id: 'max-flac',
    name: 'FLAC Nén tối đa (Level 8)',
    subtitle: 'Dung lượng nhỏ nhất mà vẫn giữ nguyên vẹn từng bit PCM',
    category: 'lossless',
    options: {
      targetFormat: 'flac',
      flacCompressionLevel: 8,
      flacVerify: true,
      sampleRateHz: 'source',
      bitDepth: 'source',
    },
  },
  {
    id: 'apple-alac',
    name: 'Apple Lossless (ALAC M4A)',
    subtitle: 'Tương thích hoàn hảo iPhone, iPad, Mac & Apple Music',
    category: 'lossless',
    options: {
      targetFormat: 'alac',
      sampleRateHz: 'source',
      bitDepth: 'source',
    },
  },
  {
    id: 'portable-opus-192',
    name: 'Opus Di động cao cấp (192 kbps)',
    subtitle: 'Trong suốt gần như lossless · Rất nhẹ cho điện thoại',
    category: 'portable',
    options: {
      targetFormat: 'opus',
      bitrateKbps: 192,
      sampleRateHz: 48000,
    },
  },
  {
    id: 'universal-mp3-v0',
    name: 'MP3 LAME V0 (VBR ~245 kbps)',
    subtitle: 'Tương thích mọi thiết bị, đầu xe hơi & máy nghe nhạc cổ điển',
    category: 'universal',
    options: {
      targetFormat: 'mp3',
      mp3Mode: 'vbr',
      mp3VbrQuality: 0,
      bitrateKbps: 320,
    },
  },
  {
    id: 'universal-aac-256',
    name: 'AAC 256 kbps (M4A)',
    subtitle: 'Chuẩn iTunes Plus · Cân bằng dung lượng và độ chi tiết',
    category: 'portable',
    options: {
      targetFormat: 'aac',
      bitrateKbps: 256,
    },
  },
  {
    id: 'studio-wav-24',
    name: 'Studio WAV PCM 24-bit',
    subtitle: 'Không nén · Dành cho chỉnh sửa âm thanh & mastering',
    category: 'studio',
    options: {
      targetFormat: 'wav',
      bitDepth: 24,
      sampleRateHz: 'source',
    },
  },
  {
    id: 'wavpack-lossless',
    name: 'WavPack Lossless (.wv)',
    subtitle: 'Hỗ trợ 24/32-bit, tốc độ giải mã nhanh & kiểm tra MD5',
    category: 'lossless',
    options: {
      targetFormat: 'wv',
      wavpackMode: 'high',
    },
  },
];

export const TARGET_FORMAT_META: Record<
  ConvertTargetFormat,
  {
    label: string;
    extension: string;
    isLossless: boolean;
    nativeCodecIds: CodecId[];
    fallbackCodecId: CodecId;
    description: string;
  }
> = {
  flac: {
    label: 'FLAC',
    extension: '.flac',
    isLossless: true,
    nativeCodecIds: ['flac'],
    fallbackCodecId: 'ffmpeg',
    description: 'Lossless mã nguồn mở, chuẩn vàng cho thư viện nhạc cá nhân.',
  },
  wav: {
    label: 'WAV (PCM)',
    extension: '.wav',
    isLossless: true,
    nativeCodecIds: ['ffmpeg'],
    fallbackCodecId: 'ffmpeg',
    description: 'PCM không nén, tương thích tối đa với phần mềm phòng thu.',
  },
  alac: {
    label: 'ALAC (M4A)',
    extension: '.m4a',
    isLossless: true,
    nativeCodecIds: ['refalac', 'qaac'],
    fallbackCodecId: 'ffmpeg',
    description: 'Apple Lossless đóng gói trong container M4A (ưu tiên refalac64 độc lập hoặc FFmpeg ALAC).',
  },
  wv: {
    label: 'WavPack',
    extension: '.wv',
    isLossless: true,
    nativeCodecIds: ['wavpack'],
    fallbackCodecId: 'ffmpeg',
    description: 'Lossless đa năng hỗ trợ PCM 16/24/32-bit.',
  },
  opus: {
    label: 'Opus',
    extension: '.opus',
    isLossless: false,
    nativeCodecIds: ['opusenc'],
    fallbackCodecId: 'ffmpeg',
    description: 'Codec lossy hiện đại nhất, chất lượng vượt trội ở 128–192 kbps.',
  },
  mp3: {
    label: 'MP3',
    extension: '.mp3',
    isLossless: false,
    nativeCodecIds: ['lame'],
    fallbackCodecId: 'ffmpeg',
    description: 'Định dạng phổ biến toàn cầu với bộ mã hóa LAME.',
  },
  ogg: {
    label: 'Ogg Vorbis',
    extension: '.ogg',
    isLossless: false,
    nativeCodecIds: ['oggenc'],
    fallbackCodecId: 'ffmpeg',
    description: 'Định dạng lossy mã nguồn mở theo thang chất lượng Q0–Q10.',
  },
  aac: {
    label: 'AAC (M4A)',
    extension: '.m4a',
    isLossless: false,
    nativeCodecIds: ['qaac', 'fhgaacenc', 'fdkaac'],
    fallbackCodecId: 'ffmpeg',
    description: 'Chuẩn nhạc số hiệu quả cao cho hệ sinh thái Apple & di động (FFmpeg AAC fallback).',
  },
  mpc: {
    label: 'Musepack (MPC)',
    extension: '.mpc',
    isLossless: false,
    nativeCodecIds: ['mpcenc'],
    fallbackCodecId: 'ffmpeg',
    description:
      'Musepack SV8 tối ưu độ trong suốt ở bitrate trung bình–cao (dùng mpcenc; FFmpeg chuẩn không có encoder MPC).',
  },
};

/**
 * Future-ready Server Transcoding Profiles (for LAN / Mobile Streaming companion in future releases).
 */
export const SERVER_TRANSCODING_PROFILES: readonly TranscodingProfile[] = [
  {
    id: 'mobile-saver-opus-96',
    name: 'Di động Tiết kiệm (Opus 96 kbps)',
    description: 'Tối ưu cho mạng 4G yếu; giảm hơn 90% băng thông so với FLAC 16-bit.',
    targetFormat: 'opus',
    bitrateKbps: 96,
    sampleRateHz: 48000,
    channels: 2,
    containerMime: 'audio/ogg; codecs=opus',
    estimatedMbPerMinute: 0.72,
    useCase: 'mobile-cellular',
  },
  {
    id: 'mobile-hifi-opus-192',
    name: 'Di động Hi-Fi (Opus 192 kbps)',
    description: 'Độ trong suốt gần như không thể phân biệt với lossless khi nghe qua tai nghe.',
    targetFormat: 'opus',
    bitrateKbps: 192,
    sampleRateHz: 48000,
    channels: 2,
    containerMime: 'audio/ogg; codecs=opus',
    estimatedMbPerMinute: 1.44,
    useCase: 'wifi-balanced',
  },
  {
    id: 'universal-aac-256',
    name: 'Tương thích rộng (AAC 256 kbps)',
    description: 'Tương thích iOS Safari, CarPlay, Chromecast và mọi trình duyệt hiện đại.',
    targetFormat: 'aac',
    bitrateKbps: 256,
    sampleRateHz: 48000,
    channels: 2,
    containerMime: 'audio/mp4',
    estimatedMbPerMinute: 1.92,
    useCase: 'universal-compat',
  },
  {
    id: 'universal-mp3-320',
    name: 'Tương thích cổ điển (MP3 320 kbps)',
    description: 'Stream MP3 CBR 320 kbps cho các thiết bị UPnP/DLNA đời cũ.',
    targetFormat: 'mp3',
    bitrateKbps: 320,
    sampleRateHz: 44100,
    channels: 2,
    containerMime: 'audio/mpeg',
    estimatedMbPerMinute: 2.4,
    useCase: 'universal-compat',
  },
  {
    id: 'lan-lossless-flac',
    name: 'LAN Lossless Stream (FLAC Level 2)',
    description:
      'Độ trễ thấp, bảo toàn nguyên bản sample rate, bit depth và số kênh (không ép downmix stereo; ưu tiên Direct Play nếu thiết bị hỗ trợ định dạng gốc).',
    targetFormat: 'flac',
    bitrateKbps: null,
    sampleRateHz: null,
    channels: null,
    containerMime: 'audio/flac',
    estimatedMbPerMinute: 6.5,
    useCase: 'lan-lossless',
  },
];

export function getCodecManifestById(id: CodecId): CodecManifestEntry | undefined {
  return DEFAULT_CODEC_MANIFEST.find((item) => item.id === id);
}

export function getFoobarPackCodecEntries(): CodecManifestEntry[] {
  return DEFAULT_CODEC_MANIFEST.filter((item) => item.includedInFoobarPack);
}

/**
 * Resolves a filename (e.g. "flac.exe", "oggenc2.exe", "qaac64.exe", "refalac64.exe", "fhgaacenc.exe")
 * from an unpacked foobar2000 Free Encoder Pack or custom folder to its canonical CodecId.
 */
export function matchFilenameToCodecId(fileName: string): CodecId | null {
  const lower = fileName.trim().toLowerCase();
  if (!lower) {
    return null;
  }
  for (const entry of DEFAULT_CODEC_MANIFEST) {
    for (const candidate of [...entry.winExecutableNames, ...entry.posixExecutableNames]) {
      if (candidate.toLowerCase() === lower) {
        return entry.id;
      }
    }
  }
  return null;
}

/**
 * Checks whether a filename is an official license file tracked in the pack specification.
 */
export function isRecognizedPackLicenseFile(fileName: string): boolean {
  const lower = fileName.trim().toLowerCase();
  return FOOBAR_PACK_SUPPORTING_FILES.some(
    (item) => item.kind === 'license-file' && item.fileName.toLowerCase() === lower,
  );
}

/**
 * Estimates bandwidth in MB per minute for a given bitrate in kbps.
 */
export function estimateMbPerMinute(bitrateKbps: number): number {
  const clamped = Math.max(32, Math.min(9216, bitrateKbps));
  return Number(((clamped * 60) / 8 / 1024).toFixed(2));
}
