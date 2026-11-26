import type {
  AudioConvertOptions,
  CodecId,
  ConversionCommandPlan,
  ConversionPipelineStep,
  ConvertTargetFormat,
  FfmpegCapabilities,
  ResourceMode,
  SourceAudioSpec,
  StreamingTranscodePlan,
  TranscodingProfile,
} from '../types/codec-engine';
import {
  DEFAULT_CONVERT_OPTIONS,
  DEFAULT_RESOURCE_MODE,
  FFMPEG_ENCODER_BY_TARGET,
  RESOURCE_MODE_POLICIES,
  TARGET_FORMAT_META,
} from './codec-registry';

const ALLOWED_SAMPLE_RATES = new Set([44100, 48000, 88200, 96000, 192000]);
const ALLOWED_BIT_DEPTHS = new Set([16, 24, 32]);
const ALLOWED_CHANNELS = new Set([1, 2]);
const ALLOWED_WAVPACK_MODES = new Set(['fast', 'normal', 'high', 'extra']);

function isResourceMode(value: unknown): value is ResourceMode {
  return value === 'power-saving' || value === 'balanced' || value === 'performance';
}

export function normalizeConvertOptions(
  partial?: Partial<AudioConvertOptions>,
): AudioConvertOptions {
  const merged = { ...DEFAULT_CONVERT_OPTIONS, ...partial };
  const targetFormat = Object.prototype.hasOwnProperty.call(
    TARGET_FORMAT_META,
    merged.targetFormat,
  )
    ? merged.targetFormat
    : 'flac';

  const resourceMode: ResourceMode = isResourceMode(merged.resourceMode)
    ? merged.resourceMode
    : DEFAULT_RESOURCE_MODE;
  const modePolicy = RESOURCE_MODE_POLICIES[resourceMode];

  const requestedConcurrency =
    partial?.concurrency !== undefined ? partial.concurrency : DEFAULT_CONVERT_OPTIONS.concurrency;

  const rawMaxThreads =
    merged.maxThreads === null || merged.maxThreads === undefined
      ? null
      : clampInt(merged.maxThreads, 1, modePolicy.maxEncoderThreads, modePolicy.maxEncoderThreads);

  return {
    targetFormat,
    flacCompressionLevel: clampInt(merged.flacCompressionLevel, 0, 8, 5),
    flacVerify: Boolean(merged.flacVerify),
    mp3Mode: merged.mp3Mode === 'cbr' ? 'cbr' : 'vbr',
    mp3VbrQuality: clampInt(merged.mp3VbrQuality, 0, 6, 0),
    bitrateKbps: clampInt(merged.bitrateKbps, 64, 320, 192),
    vorbisQuality: clampInt(merged.vorbisQuality, 0, 10, 6),
    wavpackMode: ALLOWED_WAVPACK_MODES.has(merged.wavpackMode)
      ? merged.wavpackMode
      : 'normal',
    musepackQuality: clampInt(merged.musepackQuality ?? 5, 0, 10, 5),
    sampleRateHz:
      merged.sampleRateHz === 'source'
        ? 'source'
        : ALLOWED_SAMPLE_RATES.has(merged.sampleRateHz)
          ? merged.sampleRateHz
          : 'source',
    bitDepth:
      merged.bitDepth === 'source'
        ? 'source'
        : ALLOWED_BIT_DEPTHS.has(merged.bitDepth)
          ? merged.bitDepth
          : 'source',
    channels:
      merged.channels === 'source'
        ? 'source'
        : ALLOWED_CHANNELS.has(merged.channels)
          ? merged.channels
          : 'source',
    preserveMetadata: Boolean(merged.preserveMetadata),
    preserveArtwork: Boolean(merged.preserveArtwork),
    conflictPolicy:
      merged.conflictPolicy === 'skip' || merged.conflictPolicy === 'overwrite'
        ? merged.conflictPolicy
        : 'rename',
    outputDirectory:
      typeof merged.outputDirectory === 'string' && merged.outputDirectory.trim().length > 0
        ? merged.outputDirectory.trim()
        : null,
    autoImportToLibrary: Boolean(merged.autoImportToLibrary),
    preferNativeEncoder: Boolean(merged.preferNativeEncoder),
    concurrency: clampInt(requestedConcurrency, 1, modePolicy.maxConversionConcurrency, 1),
    resourceMode,
    maxThreads: rawMaxThreads,
    verifyPcmOnLossless: Boolean(merged.verifyPcmOnLossless),
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(num)));
}

/**
 * Formats an argument list safely for human-readable preview only (never passed to a shell).
 */
export function formatCommandPreview(steps: readonly ConversionPipelineStep[]): string {
  const quoteArg = (arg: string): string => {
    if (/^[a-zA-Z0-9_./:\\-]+$/.test(arg)) {
      return arg;
    }
    return `"${arg.replace(/"/g, '\\"')}"`;
  };
  return steps
    .map((step) => [step.executableName, ...step.args.map(quoteArg)].join(' '))
    .join(' | ');
}

function getExtensionLower(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

function buildFfmpegAudioFilterArgs(options: AudioConvertOptions): string[] {
  const args: string[] = [];
  if (options.sampleRateHz !== 'source') {
    args.push('-ar', String(options.sampleRateHz));
  }
  if (options.channels !== 'source') {
    args.push('-ac', String(options.channels));
  }
  return args;
}

/**
 * Resolves the exact WAV PCM codec preserving source bit depth and integer vs float format.
 * Never silently upgrades 16-bit to 24-bit or silently truncates 32-bit / float PCM to 24-bit int.
 */
export function resolvePcmCodecForTarget(params: {
  bitDepthOption: AudioConvertOptions['bitDepth'];
  sourceSpec?: SourceAudioSpec;
  targetFormat: ConvertTargetFormat;
  allowFloatPcm: boolean;
}): {
  pcmCodec: string | null;
  warning?: string;
} {
  const { bitDepthOption, sourceSpec, targetFormat, allowFloatPcm } = params;

  if (bitDepthOption === 16) {
    return { pcmCodec: 'pcm_s16le' };
  }
  if (bitDepthOption === 24) {
    return { pcmCodec: 'pcm_s24le' };
  }
  if (bitDepthOption === 32) {
    if (allowFloatPcm && sourceSpec?.sampleFormat === 'pcm-float') {
      return { pcmCodec: 'pcm_f32le' };
    }
    return { pcmCodec: 'pcm_s32le' };
  }

  // bitDepthOption === 'source'
  if (sourceSpec?.sampleFormat === 'pcm-float') {
    if (allowFloatPcm) {
      return {
        pcmCodec: sourceSpec.bitDepth === 64 ? 'pcm_f64le' : 'pcm_f32le',
      };
    }
    // Target codec only supports integer PCM (e.g., FLAC, ALAC)
    return {
      pcmCodec: 'pcm_s24le',
      warning: `Nguồn là PCM dấu phẩy động (${sourceSpec.bitDepth ?? 32}-bit float) nhưng đích ${targetFormat.toUpperCase()} không hỗ trợ float PCM — dữ liệu sẽ được lượng tử hóa sang 24-bit integer. Chọn WAV hoặc WavPack nếu muốn bảo toàn float nguyên bản.`,
    };
  }

  const effectiveBits = sourceSpec?.validBitsPerSample ?? sourceSpec?.bitDepth ?? null;
  if (effectiveBits !== null && Number.isFinite(effectiveBits) && effectiveBits > 0) {
    if (effectiveBits <= 8) return { pcmCodec: 'pcm_u8' };
    if (effectiveBits <= 16) return { pcmCodec: 'pcm_s16le' };
    if (effectiveBits <= 24) return { pcmCodec: 'pcm_s24le' };
    // >= 32-bit integer
    if (targetFormat === 'alac') {
      return {
        pcmCodec: 'pcm_s24le',
        warning:
          'Nguồn là 32-bit integer PCM; ALAC chuẩn hỗ trợ tối đa 24-bit nên tín hiệu sẽ hạ xuống 24-bit integer.',
      };
    }
    return { pcmCodec: 'pcm_s32le' };
  }

  // Lossy source has no fixed integer bit depth; decode at 24-bit float/int headroom cleanly
  if (sourceSpec?.sampleFormat === 'lossy' || sourceSpec?.isLosslessCodec === false) {
    return {
      pcmCodec: 'pcm_s24le',
    };
  }

  // Unknown source spec: return null so callers never silently assume 24-bit without disclosure
  return {
    pcmCodec: null,
    warning:
      'Chưa xác định được bit depth gốc của tệp nguồn — giữ nguyên mặc định giải mã của bộ mã hóa mà không tự ý ép bit depth.',
  };
}

/**
 * Checks whether the detected FFmpeg build actually contains an encoder required for `targetFormat`.
 * If `capabilities` is null/undefined, returns optimistic default except for `mpc` (stock FFmpeg has no MPC encoder).
 */
export function resolveFfmpegEncoderForTarget(
  targetFormat: ConvertTargetFormat,
  capabilities?: FfmpegCapabilities | null,
): {
  supported: boolean;
  encoderName: string | null;
  reason?: string;
} {
  const candidates = FFMPEG_ENCODER_BY_TARGET[targetFormat];
  if (candidates.length === 0) {
    if (capabilities && capabilities.encoders.includes('mpc8')) {
      return { supported: true, encoderName: 'mpc8' };
    }
    return {
      supported: false,
      encoderName: null,
      reason: `FFmpeg tiêu chuẩn không tích hợp bộ mã hóa ${targetFormat.toUpperCase()} — cần bộ mã hóa gốc (mpcenc).`,
    };
  }

  if (!capabilities) {
    // Fallback default encoder selection when capability list was not probed
    const defaultMap: Record<Exclude<ConvertTargetFormat, 'mpc'>, string> = {
      flac: 'flac',
      wav: 'pcm_s16le',
      alac: 'alac',
      wv: 'wavpack',
      opus: 'libopus',
      mp3: 'libmp3lame',
      ogg: 'libvorbis',
      aac: 'aac',
    };
    return {
      supported: true,
      encoderName: defaultMap[targetFormat as Exclude<ConvertTargetFormat, 'mpc'>],
    };
  }

  const availableSet = new Set(capabilities.encoders.map((e) => e.toLowerCase()));
  for (const candidate of candidates) {
    if (availableSet.has(candidate.toLowerCase())) {
      return { supported: true, encoderName: candidate };
    }
  }

  return {
    supported: false,
    encoderName: null,
    reason: `Bản FFmpeg hiện tại không có bộ mã hóa hỗ trợ ${targetFormat.toUpperCase()} (cần một trong: ${candidates.join(', ')}).`,
  };
}

function sanitizeTagValue(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\r\n\0]/g, ' ').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 240) : null;
}

function extractCommonTags(sourceSpec?: SourceAudioSpec): {
  title: string | null;
  artist: string | null;
  album: string | null;
  date: string | null;
  track: string | null;
  genre: string | null;
} {
  const tags = sourceSpec?.tags ?? {};
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(tags)) {
    lower.set(k.toLowerCase(), v);
  }
  return {
    title: sanitizeTagValue(lower.get('title')),
    artist: sanitizeTagValue(lower.get('artist') ?? lower.get('album_artist')),
    album: sanitizeTagValue(lower.get('album')),
    date: sanitizeTagValue(lower.get('date') ?? lower.get('year')),
    track: sanitizeTagValue(lower.get('track') ?? lower.get('tracknumber')),
    genre: sanitizeTagValue(lower.get('genre')),
  };
}

export interface BuildConversionPlanInput {
  sourcePath: string;
  outputPath: string;
  options: Partial<AudioConvertOptions>;
  availableCodecs: ReadonlySet<CodecId>;
  sourceAudioSpec?: SourceAudioSpec;
  ffmpegCapabilities?: FfmpegCapabilities | null;
  effectiveMaxThreads?: number | null;
}

/**
 * Pure, deterministic conversion pipeline planner.
 * - Never constructs shell strings for execution — emits strict argv arrays for `spawn(..., { shell: false })`.
 * - Preserves source bit depth, integer vs float PCM, sample rate, and multichannel layout by default.
 * - Respects FFmpeg capability detection and Resource Mode thread bounds (only on adapters that support it).
 * - Distinguishes attached album artwork (`attached_pic`) from arbitrary video streams.
 */
export function buildConversionCommandPlan(
  input: BuildConversionPlanInput,
): ConversionCommandPlan {
  const opts = normalizeConvertOptions(input.options);
  const meta = TARGET_FORMAT_META[opts.targetFormat];
  const srcExt = getExtensionLower(input.sourcePath);
  const sourceSpec = input.sourceAudioSpec;
  const ffmpegCaps = input.ffmpegCapabilities ?? null;
  const has = (id: CodecId): boolean => input.availableCodecs.has(id);

  const needsResampleOrMix =
    opts.sampleRateHz !== 'source' || opts.channels !== 'source' || opts.bitDepth !== 'source';

  const modePolicy = RESOURCE_MODE_POLICIES[opts.resourceMode ?? DEFAULT_RESOURCE_MODE];
  const effectiveThreads = clampInt(
    input.effectiveMaxThreads ?? opts.maxThreads ?? modePolicy.maxEncoderThreads,
    1,
    modePolicy.maxEncoderThreads,
    modePolicy.maxEncoderThreads,
  );

  const notes: string[] = [];
  const warnings: string[] = [];
  const commonTags = extractCommonTags(sourceSpec);

  // Audio Quality Guardrail #1: warn explicitly when transcoding lossy -> lossless
  if (meta.isLossless && sourceSpec?.isLosslessCodec === false) {
    warnings.push(
      `Tệp nguồn là định dạng lossy (${sourceSpec.codecName ?? 'lossy'}). Chuyển sang ${meta.label} không khôi phục dữ liệu đã mất và sẽ làm tăng dung lượng tệp.`,
    );
  }

  // Audio Quality Guardrail #2: check target codec sample rate / channel compatibility
  const srcChannels = opts.channels === 'source' ? (sourceSpec?.channels ?? null) : opts.channels;
  const srcRate = opts.sampleRateHz === 'source' ? (sourceSpec?.sampleRateHz ?? null) : opts.sampleRateHz;

  if (opts.targetFormat === 'mp3') {
    if (srcChannels !== null && srcChannels > 2) {
      warnings.push(
        `MP3 (LAME) chỉ hỗ trợ tối đa 2 kênh (stereo); nguồn có ${srcChannels} kênh nên không thể giữ nguyên đa kênh ở định dạng MP3.`,
      );
    }
    if (srcRate !== null && srcRate > 48000) {
      warnings.push(
        `MP3 chỉ hỗ trợ sample rate tối đa 48000 Hz; nguồn là ${srcRate} Hz nên bộ mã hóa sẽ phải hạ tần số lấy mẫu.`,
      );
    }
  }

  if (opts.targetFormat === 'opus' && srcRate !== null && srcRate !== 48000) {
    notes.push(
      `Opus mã hóa nội bộ ở 48000 Hz (nguồn ${srcRate} Hz); đây là đặc tính tiêu chuẩn của RFC 6716.`,
    );
  }

  if (opts.targetFormat === 'flac' && srcChannels !== null && srcChannels > 8) {
    warnings.push(`FLAC chỉ hỗ trợ tối đa 8 kênh âm thanh (nguồn có ${srcChannels} kênh).`);
  }

  // Helper to build a safe FFmpeg-to-WAV-stdout decode step for piping into native encoders
  const buildFfmpegPipeDecoder = (allowFloatPcm: boolean): ConversionPipelineStep => {
    const pcmResolution = resolvePcmCodecForTarget({
      bitDepthOption: opts.bitDepth,
      sourceSpec,
      targetFormat: opts.targetFormat,
      allowFloatPcm,
    });
    if (pcmResolution.warning) {
      warnings.push(pcmResolution.warning);
    }

    const args: string[] = [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-threads',
      String(effectiveThreads),
      '-i',
      input.sourcePath,
      '-map',
      '0:a:0',
      '-vn',
      ...buildFfmpegAudioFilterArgs(opts),
    ];

    if (pcmResolution.pcmCodec) {
      args.push('-c:a', pcmResolution.pcmCodec);
    }

    args.push('-f', 'wav', 'pipe:1');
    return {
      codecId: 'ffmpeg',
      executableName: 'ffmpeg',
      args,
    };
  };

  // Helper to build direct FFmpeg encode plan (gated by FFmpeg capabilities)
  const buildFfmpegDirectPlan = (fallbackFromNative = false): ConversionCommandPlan => {
    const ffmpegEncCheck = resolveFfmpegEncoderForTarget(opts.targetFormat, ffmpegCaps);
    if (!ffmpegEncCheck.supported || !ffmpegEncCheck.encoderName) {
      throw new Error(
        ffmpegEncCheck.reason ??
          `FFmpeg không hỗ trợ mã hóa sang định dạng ${opts.targetFormat.toUpperCase()}.`,
      );
    }

    const args: string[] = [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-threads',
      String(effectiveThreads),
      '-i',
      input.sourcePath,
      '-progress',
      'pipe:1',
      '-loglevel',
      'error',
    ];

    let metadataHandlingNote: string;
    if (opts.preserveMetadata) {
      args.push('-map_metadata', '0');
      metadataHandlingNote = 'Giữ nguyên metadata gốc qua FFmpeg (-map_metadata 0).';
    } else {
      args.push('-map_metadata', '-1');
      metadataHandlingNote = 'Đã xóa metadata theo tùy chọn (-map_metadata -1).';
    }

    // Strictly distinguish attached album artwork (`attached_pic`) from regular video streams!
    const containerSupportsArtwork =
      opts.targetFormat === 'flac' ||
      opts.targetFormat === 'mp3' ||
      opts.targetFormat === 'alac' ||
      opts.targetFormat === 'aac';

    let artworkHandlingNote: string;
    if (opts.preserveArtwork && containerSupportsArtwork) {
      if (sourceSpec?.hasAttachedPic === false) {
        args.push('-map', '0:a:0', '-vn');
        if (sourceSpec.hasVideoStream) {
          artworkHandlingNote =
            'Đã loại bỏ luồng video thông thường (không phải ảnh bìa attached_pic).';
          notes.push(artworkHandlingNote);
        } else {
          artworkHandlingNote = 'Tệp nguồn không chứa ảnh bìa gắn kèm (attached_pic).';
        }
      } else {
        // Specifically target attached_pic video stream rather than uncontrolled `-map 0:v?`
        args.push(
          '-map',
          '0:a:0',
          '-map',
          '0:v:m:attached_pic?',
          '-c:v',
          'copy',
          '-disposition:v',
          'attached_pic',
        );
        if (opts.targetFormat === 'mp3') {
          args.push('-id3v2_version', '3');
        }
        artworkHandlingNote =
          'Chỉ sao chép ảnh bìa gắn kèm (attached_pic), không sao chép luồng video thông thường.';
      }
    } else {
      args.push('-map', '0:a:0', '-vn');
      artworkHandlingNote = opts.preserveArtwork
        ? `Định dạng đích ${meta.label} không hỗ trợ gắn ảnh bìa trực tiếp trong bước FFmpeg này.`
        : 'Đã tắt giữ ảnh bìa theo tùy chọn (-vn).';
    }

    args.push(...buildFfmpegAudioFilterArgs(opts));

    switch (opts.targetFormat) {
      case 'flac': {
        args.push('-c:a', 'flac', '-compression_level', String(opts.flacCompressionLevel));
        if (opts.bitDepth === 16) {
          args.push('-sample_fmt', 's16');
        } else if (opts.bitDepth === 24) {
          args.push('-sample_fmt', 's32', '-bits_per_raw_sample', '24');
        } else if (opts.bitDepth === 32) {
          args.push('-sample_fmt', 's32');
          notes.push('FFmpeg FLAC chỉ lưu tối đa 24-bit raw sample trên nhiều bản build; cần xác minh đầu ra.');
        } else if (sourceSpec?.sampleFormat === 'pcm-float') {
          warnings.push(
            'Nguồn là PCM float nhưng FLAC chỉ hỗ trợ PCM integer — FFmpeg sẽ chuyển sang integer PCM (tối đa 24-bit).',
          );
        }
        break;
      }
      case 'wav': {
        const pcmRes = resolvePcmCodecForTarget({
          bitDepthOption: opts.bitDepth,
          sourceSpec,
          targetFormat: 'wav',
          allowFloatPcm: true,
        });
        if (pcmRes.warning) {
          warnings.push(pcmRes.warning);
        }
        if (pcmRes.pcmCodec) {
          args.push('-c:a', pcmRes.pcmCodec);
        } else if (srcExt === '.wav' && !needsResampleOrMix) {
          args.push('-c:a', 'copy');
          notes.push('Giữ nguyên luồng PCM WAV gốc bằng -c:a copy do không thay đổi thông số.');
        }
        break;
      }
      case 'alac': {
        args.push('-c:a', 'alac');
        if (opts.bitDepth === 16) {
          args.push('-sample_fmt', 's16p');
        } else if (opts.bitDepth === 24) {
          args.push('-sample_fmt', 's32p');
        } else if (opts.bitDepth === 32 || sourceSpec?.sampleFormat === 'pcm-float') {
          warnings.push(
            'ALAC chuẩn hỗ trợ PCM integer 16/24-bit; nguồn 32-bit hoặc float sẽ không giữ nguyên 32-bit float trong container ALAC.',
          );
        }
        break;
      }
      case 'mp3': {
        args.push('-c:a', ffmpegEncCheck.encoderName);
        if (opts.mp3Mode === 'vbr') {
          args.push('-q:a', String(opts.mp3VbrQuality));
        } else {
          args.push('-b:a', `${opts.bitrateKbps}k`);
        }
        break;
      }
      case 'opus': {
        args.push('-c:a', ffmpegEncCheck.encoderName, '-b:a', `${opts.bitrateKbps}k`, '-vbr', 'on');
        break;
      }
      case 'ogg': {
        args.push('-c:a', ffmpegEncCheck.encoderName, '-q:a', String(opts.vorbisQuality));
        break;
      }
      case 'aac': {
        args.push('-c:a', ffmpegEncCheck.encoderName, '-b:a', `${opts.bitrateKbps}k`);
        break;
      }
      case 'wv': {
        args.push('-c:a', 'wavpack');
        break;
      }
      case 'mpc': {
        args.push('-c:a', ffmpegEncCheck.encoderName);
        break;
      }
    }

    args.push(input.outputPath);

    const step: ConversionPipelineStep = {
      codecId: 'ffmpeg',
      executableName: 'ffmpeg',
      args,
    };

    return {
      pipelineMode: 'direct',
      encoderLabel: `FFmpeg (${meta.label})`,
      targetExtension: meta.extension,
      steps: [step],
      commandPreview: formatCommandPreview([step]),
      requiredCodecs: ['ffmpeg'],
      notes,
      warnings,
      fallbackFromNative,
      metadataHandlingNote,
      artworkHandlingNote,
    };
  };

  // Prefer native encoder from Default Encoder Pack when enabled & available
  if (opts.preferNativeEncoder) {
    // 1. Native FLAC encoder
    if (opts.targetFormat === 'flac' && has('flac')) {
      const sourceIsFloat = sourceSpec?.sampleFormat === 'pcm-float';
      const canDirectFlacInput =
        (srcExt === '.wav' || srcExt === '.flac') && !needsResampleOrMix && !sourceIsFloat;
      const flacArgs: string[] = ['--force', `-${opts.flacCompressionLevel}`];
      if (opts.flacVerify) {
        flacArgs.push('--verify');
      }

      if (canDirectFlacInput) {
        if (opts.preserveMetadata && srcExt === '.wav') {
          if (commonTags.title) flacArgs.push(`--tag=TITLE=${commonTags.title}`);
          if (commonTags.artist) flacArgs.push(`--tag=ARTIST=${commonTags.artist}`);
          if (commonTags.album) flacArgs.push(`--tag=ALBUM=${commonTags.album}`);
          if (commonTags.date) flacArgs.push(`--tag=DATE=${commonTags.date}`);
        }
        flacArgs.push('-o', input.outputPath, input.sourcePath);
        const step: ConversionPipelineStep = {
          codecId: 'flac',
          executableName: 'flac',
          args: flacArgs,
        };
        notes.push('Sử dụng bộ mã hóa chuẩn Xiph FLAC trực tiếp không cần trung gian.');
        return {
          pipelineMode: 'direct',
          encoderLabel: 'FLAC Reference Encoder',
          targetExtension: '.flac',
          steps: [step],
          commandPreview: formatCommandPreview([step]),
          requiredCodecs: ['flac'],
          notes,
          warnings,
          metadataHandlingNote: opts.preserveMetadata
            ? 'FLAC gốc tự bảo toàn Vorbis Comments khi đầu vào là FLAC hoặc nhận tag chỉ định.'
            : 'Chú ý: đầu vào FLAC trực tiếp có thể giữ lại tag cũ nếu không dùng FFmpeg -map_metadata -1.',
          artworkHandlingNote: opts.preserveArtwork
            ? 'FLAC gốc bảo toàn khối PICTURE khi đầu vào là FLAC.'
            : 'Không chèn ảnh bìa mới.',
        };
      }

      if (has('ffmpeg')) {
        if (opts.preserveMetadata) {
          if (commonTags.title) flacArgs.push(`--tag=TITLE=${commonTags.title}`);
          if (commonTags.artist) flacArgs.push(`--tag=ARTIST=${commonTags.artist}`);
          if (commonTags.album) flacArgs.push(`--tag=ALBUM=${commonTags.album}`);
          if (commonTags.date) flacArgs.push(`--tag=DATE=${commonTags.date}`);
        }
        flacArgs.push('--ignore-chunk-sizes', '-o', input.outputPath, '-');
        const steps: ConversionPipelineStep[] = [
          buildFfmpegPipeDecoder(false),
          { codecId: 'flac', executableName: 'flac', args: flacArgs },
        ];
        notes.push('Giải mã bằng FFmpeg pipe sang FLAC Reference Encoder không tạo file WAV tạm.');
        let artworkHandlingNote = 'Không chèn ảnh bìa trong luồng pipe WAV.';
        if (opts.preserveArtwork && sourceSpec?.hasAttachedPic) {
          artworkHandlingNote =
            'Luồng pipe WAV không mang theo ảnh bìa (attached_pic); dùng FFmpeg trực tiếp nếu cần giữ nguyên ảnh bìa nhúng.';
          warnings.push(artworkHandlingNote);
        }
        return {
          pipelineMode: 'piped',
          encoderLabel: 'FFmpeg → FLAC Reference',
          targetExtension: '.flac',
          steps,
          commandPreview: formatCommandPreview(steps),
          requiredCodecs: ['ffmpeg', 'flac'],
          notes,
          warnings,
          metadataHandlingNote: opts.preserveMetadata
            ? 'Truyền tag cơ bản qua cờ --tag của flac (luồng WAV pipe không tự mang metadata).'
            : 'Bỏ qua metadata trên luồng pipe.',
          artworkHandlingNote,
        };
      }
    }

    // 2. Native LAME MP3 encoder
    if (opts.targetFormat === 'mp3' && has('lame')) {
      const lameIncompatibleWithSource =
        (srcChannels !== null && srcChannels > 2) || (srcRate !== null && srcRate > 48000);

      if (!lameIncompatibleWithSource) {
        const lameArgs: string[] = ['--silent'];
        if (opts.mp3Mode === 'vbr') {
          lameArgs.push('-V', String(opts.mp3VbrQuality));
        } else {
          lameArgs.push('-b', String(opts.bitrateKbps), '--cbr');
        }

        if (opts.preserveMetadata) {
          lameArgs.push('--add-id3v2');
          if (commonTags.title) lameArgs.push('--tt', commonTags.title);
          if (commonTags.artist) lameArgs.push('--ta', commonTags.artist);
          if (commonTags.album) lameArgs.push('--tl', commonTags.album);
          if (commonTags.date) lameArgs.push('--ty', commonTags.date);
          if (commonTags.track) lameArgs.push('--tn', commonTags.track);
          if (commonTags.genre) lameArgs.push('--tg', commonTags.genre);
        }

        if (srcExt === '.wav' && !needsResampleOrMix) {
          lameArgs.push(input.sourcePath, input.outputPath);
          const step: ConversionPipelineStep = {
            codecId: 'lame',
            executableName: 'lame',
            args: lameArgs,
          };
          return {
            pipelineMode: 'direct',
            encoderLabel: 'LAME MP3 Encoder',
            targetExtension: '.mp3',
            steps: [step],
            commandPreview: formatCommandPreview([step]),
            requiredCodecs: ['lame'],
            notes,
            warnings,
            metadataHandlingNote: opts.preserveMetadata
              ? 'Ghi tag ID3v2 qua cờ --tt/--ta/--tl của LAME.'
              : 'Không ghi metadata ID3.',
            artworkHandlingNote: opts.preserveArtwork
              ? 'LAME CLI cần tệp ảnh tách rời (--ti); không nhúng ảnh tự động từ luồng WAV.'
              : 'Đã tắt giữ ảnh bìa.',
          };
        }

        if (srcExt === '.flac' && has('flac') && !needsResampleOrMix) {
          const decStep: ConversionPipelineStep = {
            codecId: 'flac',
            executableName: 'flac',
            args: ['-d', '-c', '--silent', input.sourcePath],
          };
          lameArgs.push('-', input.outputPath);
          const encStep: ConversionPipelineStep = {
            codecId: 'lame',
            executableName: 'lame',
            args: lameArgs,
          };
          notes.push('Pipe trực tiếp FLAC Decoder → LAME MP3 (100% Native Encoder Pack).');
          return {
            pipelineMode: 'piped',
            encoderLabel: 'FLAC → LAME MP3',
            targetExtension: '.mp3',
            steps: [decStep, encStep],
            commandPreview: formatCommandPreview([decStep, encStep]),
            requiredCodecs: ['flac', 'lame'],
            notes,
            warnings,
            metadataHandlingNote: opts.preserveMetadata
              ? 'Truyền tag cơ bản sang LAME qua ID3v2.'
              : 'Không ghi metadata ID3.',
            artworkHandlingNote:
              opts.preserveArtwork && sourceSpec?.hasAttachedPic
                ? 'Luồng pipe FLAC→LAME không tự mang ảnh bìa; dùng FFmpeg trực tiếp nếu cần giữ ảnh bìa.'
                : 'Không nhúng ảnh bìa.',
          };
        }

        if (has('ffmpeg')) {
          lameArgs.push('-', input.outputPath);
          const steps: ConversionPipelineStep[] = [
            buildFfmpegPipeDecoder(false),
            { codecId: 'lame', executableName: 'lame', args: lameArgs },
          ];
          return {
            pipelineMode: 'piped',
            encoderLabel: 'FFmpeg → LAME MP3',
            targetExtension: '.mp3',
            steps,
            commandPreview: formatCommandPreview(steps),
            requiredCodecs: ['ffmpeg', 'lame'],
            notes,
            warnings,
            metadataHandlingNote: opts.preserveMetadata
              ? 'Truyền tag cơ bản sang LAME qua ID3v2.'
              : 'Không ghi metadata ID3.',
            artworkHandlingNote:
              opts.preserveArtwork && sourceSpec?.hasAttachedPic
                ? 'Luồng pipe WAV→LAME không tự mang ảnh bìa; dùng FFmpeg trực tiếp nếu cần giữ ảnh bìa.'
                : 'Không nhúng ảnh bìa.',
          };
        }
      } else {
        notes.push(
          'Chuyển sang FFmpeg vì tệp nguồn vượt giới hạn đầu vào trực tiếp của LAME (>2 kênh hoặc >48kHz).',
        );
      }
    }

    // 3. Native Opus encoder (opusenc)
    if (opts.targetFormat === 'opus' && has('opusenc')) {
      const opusArgs: string[] = ['--bitrate', String(opts.bitrateKbps), '--vbr'];
      if (!opts.preserveMetadata) {
        opusArgs.push('--discard-comments');
      }
      if (!opts.preserveArtwork) {
        opusArgs.push('--discard-pictures');
      }
      const directSupported = (srcExt === '.wav' || srcExt === '.flac') && !needsResampleOrMix;

      if (directSupported) {
        opusArgs.push(input.sourcePath, input.outputPath);
        const step: ConversionPipelineStep = {
          codecId: 'opusenc',
          executableName: 'opusenc',
          args: opusArgs,
        };
        notes.push('opusenc đọc trực tiếp FLAC/WAV và tự xử lý Vorbis Comment / picture block.');
        return {
          pipelineMode: 'direct',
          encoderLabel: 'Opus Tools Encoder',
          targetExtension: '.opus',
          steps: [step],
          commandPreview: formatCommandPreview([step]),
          requiredCodecs: ['opusenc'],
          notes,
          warnings,
          metadataHandlingNote: opts.preserveMetadata
            ? 'opusenc tự bảo toàn metadata khi đầu vào là FLAC.'
            : 'Đã bật --discard-comments để xóa metadata.',
          artworkHandlingNote: opts.preserveArtwork
            ? 'opusenc tự bảo toàn ảnh bìa khi đầu vào là FLAC.'
            : 'Đã bật --discard-pictures để loại bỏ ảnh bìa.',
        };
      }

      if (has('ffmpeg')) {
        opusArgs.push('--ignorelength');
        if (opts.preserveMetadata) {
          if (commonTags.title) opusArgs.push('--title', commonTags.title);
          if (commonTags.artist) opusArgs.push('--artist', commonTags.artist);
          if (commonTags.album) opusArgs.push('--album', commonTags.album);
          if (commonTags.date) opusArgs.push('--date', commonTags.date);
          if (commonTags.genre) opusArgs.push('--genre', commonTags.genre);
        }
        opusArgs.push('-', input.outputPath);
        const steps: ConversionPipelineStep[] = [
          buildFfmpegPipeDecoder(true),
          { codecId: 'opusenc', executableName: 'opusenc', args: opusArgs },
        ];
        return {
          pipelineMode: 'piped',
          encoderLabel: 'FFmpeg → Opus Tools',
          targetExtension: '.opus',
          steps,
          commandPreview: formatCommandPreview(steps),
          requiredCodecs: ['ffmpeg', 'opusenc'],
          notes,
          warnings,
          metadataHandlingNote: opts.preserveMetadata
            ? 'Truyền tag cơ bản qua --title/--artist/--album của opusenc.'
            : 'Đã bật --discard-comments.',
          artworkHandlingNote: 'Luồng pipe WAV không mang ảnh bìa vào opusenc.',
        };
      }
    }

    // 4. Native Ogg Vorbis encoder (oggenc2)
    if (opts.targetFormat === 'ogg' && has('oggenc')) {
      const oggArgs: string[] = ['-q', String(opts.vorbisQuality)];
      if (!opts.preserveMetadata) {
        oggArgs.push('--discard-comments');
      }
      const directSupported = (srcExt === '.wav' || srcExt === '.flac') && !needsResampleOrMix;

      if (directSupported) {
        oggArgs.push('-o', input.outputPath, input.sourcePath);
        const step: ConversionPipelineStep = {
          codecId: 'oggenc',
          executableName: 'oggenc2',
          args: oggArgs,
        };
        return {
          pipelineMode: 'direct',
          encoderLabel: 'Ogg Vorbis (oggenc2)',
          targetExtension: '.ogg',
          steps: [step],
          commandPreview: formatCommandPreview([step]),
          requiredCodecs: ['oggenc'],
          notes,
          warnings,
          metadataHandlingNote: opts.preserveMetadata
            ? 'oggenc2 tự sao chép Vorbis Comments khi đầu vào là FLAC.'
            : 'Đã bật --discard-comments.',
          artworkHandlingNote: 'oggenc2 không nhúng ảnh bìa mặc định.',
        };
      }

      if (has('ffmpeg')) {
        oggArgs.push('--ignorelength');
        if (opts.preserveMetadata) {
          if (commonTags.title) oggArgs.push('-t', commonTags.title);
          if (commonTags.artist) oggArgs.push('-a', commonTags.artist);
          if (commonTags.album) oggArgs.push('-l', commonTags.album);
          if (commonTags.date) oggArgs.push('-d', commonTags.date);
          if (commonTags.genre) oggArgs.push('-G', commonTags.genre);
        }
        oggArgs.push('-o', input.outputPath, '-');
        const steps: ConversionPipelineStep[] = [
          buildFfmpegPipeDecoder(true),
          { codecId: 'oggenc', executableName: 'oggenc2', args: oggArgs },
        ];
        return {
          pipelineMode: 'piped',
          encoderLabel: 'FFmpeg → Ogg Vorbis',
          targetExtension: '.ogg',
          steps,
          commandPreview: formatCommandPreview(steps),
          requiredCodecs: ['ffmpeg', 'oggenc'],
          notes,
          warnings,
          metadataHandlingNote: opts.preserveMetadata
            ? 'Truyền tag cơ bản qua cờ -t/-a/-l của oggenc2.'
            : 'Đã bật --discard-comments.',
          artworkHandlingNote: 'oggenc2 không nhúng ảnh bìa từ pipe WAV.',
        };
      }
    }

    // 5. Native WavPack encoder (wavpack — supports 16/24/32-bit int, 32-bit float & multichannel)
    if (opts.targetFormat === 'wv' && has('wavpack')) {
      const modeFlag =
        opts.wavpackMode === 'fast'
          ? '-f'
          : opts.wavpackMode === 'high'
            ? '-h'
            : opts.wavpackMode === 'extra'
              ? '-hh'
              : null;
      const wvArgs: string[] = ['-y', '-m'];
      if (modeFlag) {
        wvArgs.push(modeFlag);
      }
      if (opts.preserveMetadata) {
        if (commonTags.title) wvArgs.push('-w', `Title=${commonTags.title}`);
        if (commonTags.artist) wvArgs.push('-w', `Artist=${commonTags.artist}`);
        if (commonTags.album) wvArgs.push('-w', `Album=${commonTags.album}`);
        if (commonTags.date) wvArgs.push('-w', `Year=${commonTags.date}`);
      }

      if (srcExt === '.wav' && !needsResampleOrMix) {
        wvArgs.push(input.sourcePath, '-o', input.outputPath);
        const step: ConversionPipelineStep = {
          codecId: 'wavpack',
          executableName: 'wavpack',
          args: wvArgs,
        };
        notes.push('WavPack gốc bảo toàn nguyên bản PCM 16/24/32-bit integer, float và đa kênh + MD5 (-m).');
        return {
          pipelineMode: 'direct',
          encoderLabel: 'WavPack Native Encoder',
          targetExtension: '.wv',
          steps: [step],
          commandPreview: formatCommandPreview([step]),
          requiredCodecs: ['wavpack'],
          notes,
          warnings,
          metadataHandlingNote: opts.preserveMetadata
            ? 'Ghi tag APEv2 qua cờ -w của wavpack.'
            : 'Không ghi metadata APEv2.',
          artworkHandlingNote: 'WavPack CLI cần tệp ảnh riêng (--write-binary-tag).',
        };
      }

      if (has('ffmpeg')) {
        wvArgs.push('-i', '-', '-o', input.outputPath);
        const steps: ConversionPipelineStep[] = [
          buildFfmpegPipeDecoder(true),
          { codecId: 'wavpack', executableName: 'wavpack', args: wvArgs },
        ];
        return {
          pipelineMode: 'piped',
          encoderLabel: 'FFmpeg → WavPack',
          targetExtension: '.wv',
          steps,
          commandPreview: formatCommandPreview(steps),
          requiredCodecs: ['ffmpeg', 'wavpack'],
          notes,
          warnings,
          metadataHandlingNote: opts.preserveMetadata
            ? 'Ghi tag APEv2 qua cờ -w của wavpack.'
            : 'Không ghi metadata APEv2.',
          artworkHandlingNote: 'Luồng pipe WAV không mang ảnh bìa vào wavpack.',
        };
      }
    }

    // 6. Native Reference ALAC (refalac64 — preferred standalone ALAC encoder before QAAC)
    if (opts.targetFormat === 'alac' && has('refalac')) {
      const refalacArgs: string[] =
        opts.sampleRateHz === 'source'
          ? ['--rate', 'keep']
          : ['--rate', String(opts.sampleRateHz)];
      if (opts.bitDepth === 16 || opts.bitDepth === 24) {
        refalacArgs.push('--bits-per-sample', String(opts.bitDepth));
      }
      if (opts.preserveMetadata) {
        if (commonTags.title) refalacArgs.push('--title', commonTags.title);
        if (commonTags.artist) refalacArgs.push('--artist', commonTags.artist);
        if (commonTags.album) refalacArgs.push('--album', commonTags.album);
        if (commonTags.date) refalacArgs.push('--date', commonTags.date);
        if (commonTags.track) refalacArgs.push('--track', commonTags.track);
        if (commonTags.genre) refalacArgs.push('--genre', commonTags.genre);
      }
      notes.push(
        'Sử dụng Reference ALAC (refalac64) độc lập (--rate keep) — không phụ thuộc Apple CoreAudioToolbox và tách biệt hoàn toàn với ALAC WASM Decoder.',
      );

      if (srcExt === '.wav' && !needsResampleOrMix) {
        refalacArgs.push('-o', input.outputPath, input.sourcePath);
        const step: ConversionPipelineStep = {
          codecId: 'refalac',
          executableName: 'refalac64',
          args: refalacArgs,
        };
        return {
          pipelineMode: 'direct',
          encoderLabel: 'Reference ALAC (refalac64)',
          targetExtension: '.m4a',
          steps: [step],
          commandPreview: formatCommandPreview([step]),
          requiredCodecs: ['refalac'],
          notes,
          warnings,
          metadataHandlingNote: opts.preserveMetadata
            ? 'Truyền tag MP4 cơ bản qua cờ --title/--artist/--album của refalac64.'
            : 'Không ghi metadata MP4.',
          artworkHandlingNote: 'refalac64 CLI không nhận ảnh bìa tự động từ WAV.',
        };
      }

      if (has('ffmpeg')) {
        refalacArgs.push('--ignorelength', '-o', input.outputPath, '-');
        const steps: ConversionPipelineStep[] = [
          buildFfmpegPipeDecoder(false),
          { codecId: 'refalac', executableName: 'refalac64', args: refalacArgs },
        ];
        return {
          pipelineMode: 'piped',
          encoderLabel: 'FFmpeg → Reference ALAC',
          targetExtension: '.m4a',
          steps,
          commandPreview: formatCommandPreview(steps),
          requiredCodecs: ['ffmpeg', 'refalac'],
          notes,
          warnings,
          metadataHandlingNote: opts.preserveMetadata
            ? 'Truyền tag MP4 cơ bản qua cờ của refalac64.'
            : 'Không ghi metadata MP4.',
          artworkHandlingNote:
            opts.preserveArtwork && sourceSpec?.hasAttachedPic
              ? 'Luồng pipe WAV→refalac64 không mang ảnh bìa; dùng FFmpeg trực tiếp nếu cần giữ nguyên ảnh bìa.'
              : 'Không nhúng ảnh bìa.',
        };
      }
    }

    // 7. Native QAAC for ALAC (secondary to refalac)
    if (opts.targetFormat === 'alac' && has('qaac')) {
      const qaacArgs: string[] = ['--alac'];
      if (opts.preserveMetadata) {
        if (commonTags.title) qaacArgs.push('--title', commonTags.title);
        if (commonTags.artist) qaacArgs.push('--artist', commonTags.artist);
        if (commonTags.album) qaacArgs.push('--album', commonTags.album);
        if (commonTags.date) qaacArgs.push('--date', commonTags.date);
      }

      if (srcExt === '.wav' && !needsResampleOrMix) {
        qaacArgs.push('-o', input.outputPath, input.sourcePath);
        const step: ConversionPipelineStep = {
          codecId: 'qaac',
          executableName: 'qaac64',
          args: qaacArgs,
        };
        return {
          pipelineMode: 'direct',
          encoderLabel: 'QAAC Apple Lossless',
          targetExtension: '.m4a',
          steps: [step],
          commandPreview: formatCommandPreview([step]),
          requiredCodecs: ['qaac'],
          notes,
          warnings,
          metadataHandlingNote: opts.preserveMetadata
            ? 'Truyền tag MP4 qua cờ của qaac64.'
            : 'Không ghi metadata MP4.',
          artworkHandlingNote: 'qaac64 CLI không nhận ảnh bìa tự động từ WAV.',
        };
      }
      if (has('ffmpeg')) {
        qaacArgs.push('--ignorelength', '-o', input.outputPath, '-');
        const steps: ConversionPipelineStep[] = [
          buildFfmpegPipeDecoder(false),
          { codecId: 'qaac', executableName: 'qaac64', args: qaacArgs },
        ];
        return {
          pipelineMode: 'piped',
          encoderLabel: 'FFmpeg → QAAC ALAC',
          targetExtension: '.m4a',
          steps,
          commandPreview: formatCommandPreview(steps),
          requiredCodecs: ['ffmpeg', 'qaac'],
          notes,
          warnings,
          metadataHandlingNote: opts.preserveMetadata
            ? 'Truyền tag MP4 qua cờ của qaac64.'
            : 'Không ghi metadata MP4.',
          artworkHandlingNote: 'Luồng pipe WAV→qaac64 không mang ảnh bìa.',
        };
      }
    }

    // 8. Native AAC encoders: QAAC -> fhgaacenc -> FDK-AAC
    if (opts.targetFormat === 'aac' && (has('qaac') || has('fhgaacenc') || has('fdkaac'))) {
      if (has('qaac')) {
        const qaacArgs: string[] = ['--cvbr', String(opts.bitrateKbps)];
        if (opts.preserveMetadata) {
          if (commonTags.title) qaacArgs.push('--title', commonTags.title);
          if (commonTags.artist) qaacArgs.push('--artist', commonTags.artist);
          if (commonTags.album) qaacArgs.push('--album', commonTags.album);
          if (commonTags.date) qaacArgs.push('--date', commonTags.date);
        }

        if (srcExt === '.wav' && !needsResampleOrMix) {
          qaacArgs.push('-o', input.outputPath, input.sourcePath);
          const step: ConversionPipelineStep = {
            codecId: 'qaac',
            executableName: 'qaac64',
            args: qaacArgs,
          };
          return {
            pipelineMode: 'direct',
            encoderLabel: 'QAAC CoreAudio AAC',
            targetExtension: '.m4a',
            steps: [step],
            commandPreview: formatCommandPreview([step]),
            requiredCodecs: ['qaac'],
            notes,
            warnings,
          };
        }
        if (has('ffmpeg')) {
          qaacArgs.push('--ignorelength', '-o', input.outputPath, '-');
          const steps: ConversionPipelineStep[] = [
            buildFfmpegPipeDecoder(false),
            { codecId: 'qaac', executableName: 'qaac64', args: qaacArgs },
          ];
          return {
            pipelineMode: 'piped',
            encoderLabel: 'FFmpeg → QAAC',
            targetExtension: '.m4a',
            steps,
            commandPreview: formatCommandPreview(steps),
            requiredCodecs: ['ffmpeg', 'qaac'],
            notes,
            warnings,
          };
        }
      } else if (has('fhgaacenc')) {
        notes.push(
          'Sử dụng Fraunhofer AAC (fhgaacenc) — yêu cầu nsutil.dll & enc_fhgaac.dll trên Windows (cờ CLI: Pending Desktop Verification).',
        );
        const fhgArgs: string[] = ['--cbr', String(opts.bitrateKbps)];
        if (srcExt === '.wav' && !needsResampleOrMix) {
          fhgArgs.push(input.sourcePath, input.outputPath);
          const step: ConversionPipelineStep = {
            codecId: 'fhgaacenc',
            executableName: 'fhgaacenc',
            args: fhgArgs,
          };
          return {
            pipelineMode: 'direct',
            encoderLabel: 'Fraunhofer AAC (fhgaacenc)',
            targetExtension: '.m4a',
            steps: [step],
            commandPreview: formatCommandPreview([step]),
            requiredCodecs: ['fhgaacenc'],
            notes,
            warnings,
            metadataHandlingNote:
              'fhgaacenc CLI không nhúng đầy đủ MP4 metadata/artwork; cần kiểm thử thực tế trên Windows.',
          };
        }
        if (has('ffmpeg')) {
          fhgArgs.push('--ignorelength', '-', input.outputPath);
          const steps: ConversionPipelineStep[] = [
            buildFfmpegPipeDecoder(false),
            { codecId: 'fhgaacenc', executableName: 'fhgaacenc', args: fhgArgs },
          ];
          return {
            pipelineMode: 'piped',
            encoderLabel: 'FFmpeg → Fraunhofer AAC',
            targetExtension: '.m4a',
            steps,
            commandPreview: formatCommandPreview(steps),
            requiredCodecs: ['ffmpeg', 'fhgaacenc'],
            notes,
            warnings,
            metadataHandlingNote:
              'fhgaacenc CLI qua pipe không nhúng đầy đủ metadata/artwork; dùng FFmpeg trực tiếp nếu ưu tiên giữ metadata.',
          };
        }
      } else if (has('fdkaac')) {
        const fdkArgs: string[] = ['-b', String(opts.bitrateKbps)];
        if (opts.preserveMetadata) {
          if (commonTags.title) fdkArgs.push('--title', commonTags.title);
          if (commonTags.artist) fdkArgs.push('--artist', commonTags.artist);
          if (commonTags.album) fdkArgs.push('--album', commonTags.album);
          if (commonTags.date) fdkArgs.push('--date', commonTags.date);
        }
        if (srcExt === '.wav' && !needsResampleOrMix) {
          fdkArgs.push('-o', input.outputPath, input.sourcePath);
          const step: ConversionPipelineStep = {
            codecId: 'fdkaac',
            executableName: 'fdkaac',
            args: fdkArgs,
          };
          return {
            pipelineMode: 'direct',
            encoderLabel: 'FDK-AAC Encoder',
            targetExtension: '.m4a',
            steps: [step],
            commandPreview: formatCommandPreview([step]),
            requiredCodecs: ['fdkaac'],
            notes,
            warnings,
          };
        }
        if (has('ffmpeg')) {
          fdkArgs.push('--ignorelength', '-o', input.outputPath, '-');
          const steps: ConversionPipelineStep[] = [
            buildFfmpegPipeDecoder(false),
            { codecId: 'fdkaac', executableName: 'fdkaac', args: fdkArgs },
          ];
          return {
            pipelineMode: 'piped',
            encoderLabel: 'FFmpeg → FDK-AAC',
            targetExtension: '.m4a',
            steps,
            commandPreview: formatCommandPreview(steps),
            requiredCodecs: ['ffmpeg', 'fdkaac'],
            notes,
            warnings,
          };
        }
      }
    }

    // 9. Native Musepack SV8 encoder (mpcenc)
    if (opts.targetFormat === 'mpc' && has('mpcenc')) {
      const quality = clampInt(opts.musepackQuality ?? 5, 0, 10, 5);
      const mpcArgs: string[] = ['--quality', String(quality), '--overwrite'];
      if (opts.preserveMetadata) {
        if (commonTags.title) mpcArgs.push('--title', commonTags.title);
        if (commonTags.artist) mpcArgs.push('--artist', commonTags.artist);
        if (commonTags.album) mpcArgs.push('--album', commonTags.album);
        if (commonTags.date) mpcArgs.push('--year', commonTags.date);
      }
      notes.push(
        'Sử dụng Musepack SV8 (mpcenc) — thực thi Windows CLI cần Pending Desktop Verification.',
      );

      if (srcExt === '.wav' && !needsResampleOrMix) {
        mpcArgs.push(input.sourcePath, input.outputPath);
        const step: ConversionPipelineStep = {
          codecId: 'mpcenc',
          executableName: 'mpcenc',
          args: mpcArgs,
        };
        return {
          pipelineMode: 'direct',
          encoderLabel: 'Musepack SV8 (mpcenc)',
          targetExtension: '.mpc',
          steps: [step],
          commandPreview: formatCommandPreview([step]),
          requiredCodecs: ['mpcenc'],
          notes,
          warnings,
          metadataHandlingNote: opts.preserveMetadata
            ? 'Ghi tag APEv2 cơ bản qua cờ của mpcenc.'
            : 'Không ghi metadata APEv2.',
          artworkHandlingNote: 'Musepack CLI không nhúng ảnh bìa tự động.',
        };
      }

      if (has('ffmpeg')) {
        mpcArgs.push('-', input.outputPath);
        const steps: ConversionPipelineStep[] = [
          buildFfmpegPipeDecoder(false),
          { codecId: 'mpcenc', executableName: 'mpcenc', args: mpcArgs },
        ];
        return {
          pipelineMode: 'piped',
          encoderLabel: 'FFmpeg → Musepack SV8',
          targetExtension: '.mpc',
          steps,
          commandPreview: formatCommandPreview(steps),
          requiredCodecs: ['ffmpeg', 'mpcenc'],
          notes,
          warnings,
          metadataHandlingNote: opts.preserveMetadata
            ? 'Ghi tag APEv2 cơ bản qua cờ của mpcenc.'
            : 'Không ghi metadata APEv2.',
          artworkHandlingNote: 'Luồng pipe WAV→mpcenc không mang ảnh bìa.',
        };
      }
    }
  }

  // Fallback to universal FFmpeg direct conversion (with FFmpeg capability verification)
  const fallbackFromNative = opts.preferNativeEncoder && opts.targetFormat !== 'wav';
  if (fallbackFromNative) {
    notes.push(
      `Sử dụng FFmpeg fallback cho ${meta.label} do bộ mã hóa gốc không sẵn sàng hoặc không phù hợp nguồn.`,
    );
  }
  return buildFfmpegDirectPlan(fallbackFromNative);
}

/**
 * Builds a future-ready Server Streaming Transcode pipeline plan (on-the-fly chunked stream to stdout).
 * Preserves source multichannel layout when `profile.channels === null` (e.g., `lan-lossless-flac`).
 */
export function buildStreamingTranscodePlan(
  sourcePath: string,
  profile: TranscodingProfile,
  availableCodecs: ReadonlySet<CodecId>,
  options?: {
    ffmpegCapabilities?: FfmpegCapabilities | null;
    maxThreads?: number | null;
  },
): StreamingTranscodePlan {
  const notes: string[] = [];
  const args: string[] = ['-hide_banner', '-nostdin', '-loglevel', 'error'];

  if (options?.maxThreads && Number.isFinite(options.maxThreads) && options.maxThreads >= 1) {
    args.push('-threads', String(clampInt(options.maxThreads, 1, 4, 1)));
  }

  args.push('-i', sourcePath, '-map', '0:a:0', '-vn');

  if (profile.channels !== null && Number.isFinite(profile.channels)) {
    args.push('-ac', String(clampInt(profile.channels, 1, 8, 2)));
  } else {
    notes.push('Giữ nguyên số kênh gốc của bản nhạc (không tự động downmix stereo).');
  }

  if (profile.sampleRateHz && ALLOWED_SAMPLE_RATES.has(profile.sampleRateHz)) {
    args.push('-ar', String(profile.sampleRateHz));
  } else {
    notes.push('Giữ nguyên tần số lấy mẫu gốc (không resample).');
  }

  const encCheck = resolveFfmpegEncoderForTarget(profile.targetFormat, options?.ffmpegCapabilities);
  const encoderName = encCheck.encoderName ?? profile.targetFormat;

  switch (profile.targetFormat) {
    case 'opus':
      args.push(
        '-c:a',
        encoderName,
        '-b:a',
        `${clampInt(profile.bitrateKbps ?? 192, 64, 320, 192)}k`,
        '-vbr',
        'on',
        '-f',
        'ogg',
        'pipe:1',
      );
      break;
    case 'aac':
      args.push(
        '-c:a',
        encoderName,
        '-b:a',
        `${clampInt(profile.bitrateKbps ?? 256, 96, 320, 256)}k`,
        '-movflags',
        'frag_keyframe+empty_moov',
        '-f',
        'mp4',
        'pipe:1',
      );
      break;
    case 'mp3':
      args.push(
        '-c:a',
        encoderName,
        '-b:a',
        `${clampInt(profile.bitrateKbps ?? 320, 128, 320, 320)}k`,
        '-f',
        'mp3',
        'pipe:1',
      );
      break;
    case 'flac':
      args.push('-c:a', 'flac', '-compression_level', '2', '-f', 'flac', 'pipe:1');
      notes.push(
        'LAN Lossless Stream: ưu tiên Direct Play / Original Quality nếu client phát trực tiếp được định dạng gốc.',
      );
      break;
  }

  const ffmpegPresent = availableCodecs.has('ffmpeg');
  const available = ffmpegPresent && encCheck.supported;
  return {
    profile,
    available,
    requiredCodec: 'ffmpeg',
    args,
    commandPreview: formatCommandPreview([
      { codecId: 'ffmpeg', executableName: 'ffmpeg', args },
    ]),
    reasonIfUnavailable: !ffmpegPresent
      ? 'Cần FFmpeg trong Codec Pack để kích hoạt Server Streaming Transcoding.'
      : !encCheck.supported
        ? encCheck.reason
        : undefined,
    notes,
  };
}

/**
 * Sanitizes an output file base name so it is safe on Windows NTFS and POSIX filesystems.
 */
export function sanitizeOutputBaseName(rawName: string): string {
  const cleaned = rawName
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\.+$/g, '')
    .trim();
  if (!cleaned) {
    return 'converted_track';
  }
  // Avoid Windows reserved device filenames (CON, PRN, AUX, NUL, COM1..9, LPT1..9)
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) {
    return `${cleaned}_audio`;
  }
  return cleaned.slice(0, 180);
}

function parseIpv4ToUint32(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const n = parseIpv4ToUint32(ip);
  if (n === null) return false;
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  const c = (n >>> 8) & 0xff;

  if (a === 0) return true; // 0.0.0.0/8 ("this" network)
  if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT RFC6598)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF protocol)
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmark)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255
  return false;
}

function expandIpv6ToWords(raw: string): number[] | null {
  let addr = raw.trim().toLowerCase();
  if (addr.startsWith('[') && addr.endsWith(']')) {
    addr = addr.slice(1, -1);
  }
  const zoneIdx = addr.indexOf('%');
  if (zoneIdx >= 0) {
    addr = addr.slice(0, zoneIdx);
  }
  if (!addr.includes(':')) return null;

  // Handle IPv4-embedded suffix (e.g. ::ffff:127.0.0.1)
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const ipv4 = parseIpv4ToUint32(tail);
    if (ipv4 === null) return null;
    const hi = ((ipv4 >>> 16) & 0xffff).toString(16);
    const lo = (ipv4 & 0xffff).toString(16);
    addr = `${addr.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const parsePart = (part: string): number[] | null => {
    if (!part) return [];
    const segs = part.split(':');
    const out: number[] = [];
    for (const seg of segs) {
      if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
      out.push(Number.parseInt(seg, 16));
    }
    return out;
  };

  const left = parsePart(halves[0]);
  const right = halves.length === 2 ? parsePart(halves[1]) : [];
  if (!left || !right) return null;

  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

/**
 * Checks whether an IPv4 or IPv6 literal belongs to loopback, private, link-local,
 * CGNAT, multicast, IPv4-mapped private IPv6, or reserved ranges.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const trimmed = ip.trim().toLowerCase();
  if (!trimmed) return true;

  if (parseIpv4ToUint32(trimmed) !== null) {
    return isPrivateOrReservedIpv4(trimmed);
  }

  const words = expandIpv6ToWords(trimmed);
  if (!words) {
    return false;
  }

  const allZeroExceptLast =
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0;

  if (allZeroExceptLast && words[6] === 0 && (words[7] === 0 || words[7] === 1)) {
    return true;
  }

  const isIpv4Mapped =
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0xffff;
  const isIpv4Compat = allZeroExceptLast && (words[6] !== 0 || words[7] > 1);
  if (isIpv4Mapped || isIpv4Compat) {
    const ipv4 = `${(words[6] >>> 8) & 0xff}.${words[6] & 0xff}.${(words[7] >>> 8) & 0xff}.${words[7] & 0xff}`;
    return isPrivateOrReservedIpv4(ipv4);
  }

  if (
    words[0] === 0x0064 &&
    words[1] === 0xff9b &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0
  ) {
    const ipv4 = `${(words[6] >>> 8) & 0xff}.${words[6] & 0xff}.${(words[7] >>> 8) & 0xff}.${words[7] & 0xff}`;
    return isPrivateOrReservedIpv4(ipv4);
  }

  if ((words[0] & 0xfe00) === 0xfc00) return true;
  if ((words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xffc0) === 0xfec0) return true;
  if ((words[0] & 0xff00) === 0xff00) return true;
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true;
  if (words[0] === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 0) return true;

  return false;
}

/**
 * Pure URL-level validator for optional Codec Update Manager manifest checks.
 */
export function validateSafeUpdateManifestUrl(rawUrl: string): { valid: boolean; reason?: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048) {
    return { valid: false, reason: 'URL không hợp lệ hoặc vượt quá độ dài cho phép.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: 'URL không hợp lệ.' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Chỉ chấp nhận giao thức HTTPS cho kiểm tra cập nhật codec.' };
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return { valid: false, reason: 'Không chấp nhận thông tin xác thực (credentials) trong URL.' };
  }

  if (parsed.port !== '' && parsed.port !== '443') {
    return { valid: false, reason: 'Chỉ chấp nhận cổng HTTPS tiêu chuẩn (443).' };
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) {
    return { valid: false, reason: 'URL thiếu tên miền đích.' };
  }

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localdomain') ||
    host.endsWith('.home.arpa') ||
    host === 'metadata.google.internal'
  ) {
    return { valid: false, reason: 'Từ chối địa chỉ nội bộ hoặc loopback để đảm bảo bảo mật.' };
  }

  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host) || /^0[0-7]+\./.test(host)) {
    return { valid: false, reason: 'Từ chối định dạng địa chỉ IP rút gọn/mơ hồ.' };
  }

  const unbracketed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (parseIpv4ToUint32(unbracketed) !== null || unbracketed.includes(':')) {
    if (isPrivateOrReservedIp(unbracketed)) {
      return { valid: false, reason: 'Từ chối địa chỉ IP nội bộ, loopback, link-local hoặc dành riêng.' };
    }
    return {
      valid: false,
      reason: 'Yêu cầu tên miền HTTPS hợp lệ thay vì truy cập trực tiếp bằng địa chỉ IP.',
    };
  }

  if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) {
    return { valid: false, reason: 'Tên miền HTTPS không hợp lệ.' };
  }

  return { valid: true };
}

/**
 * Pure path-confinement helper preventing Zip-Slip & directory traversal when importing/extracting codecs.
 * Both inputs should be resolved absolute paths using matching separator style.
 */
export function isPathStrictlyWithinDirectory(
  resolvedCandidatePath: string,
  resolvedBaseDir: string,
  sep: '/' | '\\' = '/',
): boolean {
  const normBase = resolvedBaseDir.endsWith(sep) ? resolvedBaseDir : `${resolvedBaseDir}${sep}`;
  const isWin = sep === '\\';
  if (isWin) {
    return resolvedCandidatePath.toLowerCase().startsWith(normBase.toLowerCase());
  }
  return resolvedCandidatePath.startsWith(normBase);
}
