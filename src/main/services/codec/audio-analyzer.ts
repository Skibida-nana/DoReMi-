import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AudioAnalysisReport,
  DecoderStrategyKind,
  FfprobeExecutionStatus,
  LosslessVerificationStatus,
  SourceAudioSpec,
  SourceSampleFormat,
  WavPackModeKind,
} from '../../../shared/types/codec-engine';
import { isAlacTrackMetadata } from '../../../shared/utils/audio-codec';
import { detectMp4AudioCodec } from '../alac-decoder';
import { readTrackMetadata } from '../metadata-service';
import { extractFileExtension } from '../path-utils';
import type { CodecManager } from './codec-manager';
import type { ResourcePolicyManager } from './resource-policy';

const DEFAULT_FFPROBE_TIMEOUT_MS = 12_000;
const MAX_FFPROBE_STDOUT_BYTES = 512 * 1024;
const MAX_FFPROBE_STDERR_BYTES = 8 * 1024;

const SOURCE_AUTHENTICITY_NOTE =
  'Codec nén không suy hao (lossless codec) chỉ xác nhận định dạng mã hóa, KHÔNG chứng minh bản master gốc chưa từng bị transcode từ nguồn lossy (ví dụ MP3 → FLAC).';
const PLAYBACK_OUTPUT_NOTE =
  'Thông số phân tích tệp nguồn KHÔNG khẳng định chuỗi phát lại đầu ra đang ở chế độ Bit-Perfect.';

const LOSSLESS_CODECS = new Set([
  'flac',
  'alac',
  'ape',
  'monkey',
  'tak',
  'mlp',
  'truehd',
  'tta',
  'shorten',
]);

const LOSSY_CODECS = new Set([
  'mp3',
  'aac',
  'opus',
  'vorbis',
  'ogg',
  'mpc',
  'musepack',
  'mpc7',
  'mpc8',
  'wma',
  'wmav1',
  'wmav2',
  'wmapro',
  'ac3',
  'eac3',
  'mp2',
  'mp1',
  'amr_nb',
  'amr_wb',
  'speex',
  'atrac3',
  'dts',
]);

const LOSSY_PCM_VARIANTS = new Set(['pcm_mulaw', 'pcm_alaw', 'pcm_vidc', 'pcm_zork']);

const PLAYBACK_ENGINE_SUPPORTED_CODECS = new Set([
  'flac',
  'mp3',
  'aac',
  'opus',
  'vorbis',
  'pcm_s16le',
  'pcm_s16be',
  'pcm_s24le',
  'pcm_s24be',
  'pcm_s32le',
  'pcm_s32be',
  'pcm_f32le',
  'pcm_f32be',
  'pcm_u8',
  'pcm',
  'wav',
]);

export interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  codec_long_name?: string;
  profile?: string;
  sample_fmt?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  bits_per_raw_sample?: string;
  bits_per_sample?: number;
  bit_rate?: string;
  duration?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
}

export interface FfprobeJsonOutput {
  streams?: FfprobeStream[];
  format?: {
    format_name?: string;
    format_long_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
}

export interface FfprobeRunResult {
  status: FfprobeExecutionStatus;
  data: FfprobeJsonOutput | null;
  errorDetail: string | null;
}

export interface AudioAnalyzerServiceOptions {
  resourcePolicy?: ResourcePolicyManager;
  ffprobeTimeoutMs?: number;
}

/**
 * Infers integer vs float vs lossy sample format from FFprobe `sample_fmt` and codec name.
 */
export function detectSampleFormat(
  codecNameRaw: string | null | undefined,
  rawSampleFmt: string | null | undefined,
): SourceSampleFormat {
  const codec = (codecNameRaw ?? '').trim().toLowerCase();
  const fmt = (rawSampleFmt ?? '').trim().toLowerCase();

  if (codec.startsWith('pcm_f') || fmt === 'flt' || fmt === 'fltp' || fmt === 'dbl' || fmt === 'dblp') {
    // Lossy codecs decode to float in FFprobe (e.g. mp3/aac/opus report fltp) — distinguish lossy first!
    if (isKnownLossyCodecName(codec)) {
      return 'lossy';
    }
    return 'pcm-float';
  }

  if (isKnownLossyCodecName(codec)) {
    return 'lossy';
  }

  if (
    codec.startsWith('pcm_s') ||
    codec.startsWith('pcm_u') ||
    fmt === 'u8' ||
    fmt === 'u8p' ||
    fmt === 's16' ||
    fmt === 's16p' ||
    fmt === 's32' ||
    fmt === 's32p' ||
    fmt === 's64' ||
    fmt === 's64p'
  ) {
    return 'pcm-int';
  }

  if (LOSSLESS_CODECS.has(codec) || codec === 'wavpack' || codec === 'wv') {
    return 'pcm-int';
  }

  return 'unknown';
}

function isKnownLossyCodecName(codecLower: string): boolean {
  if (!codecLower) return false;
  if (LOSSY_PCM_VARIANTS.has(codecLower) || codecLower.startsWith('adpcm')) {
    return true;
  }
  for (const lossy of LOSSY_CODECS) {
    if (codecLower === lossy || codecLower.startsWith(`${lossy}_`)) {
      return true;
    }
  }
  return false;
}

function isUncompressedLinearPcmCodec(codecLower: string): boolean {
  if (!codecLower) return false;
  if (LOSSY_PCM_VARIANTS.has(codecLower) || codecLower.startsWith('adpcm')) {
    return false;
  }
  return (
    codecLower === 'pcm' ||
    /^pcm_[suf](?:8|16|24|32|64)(?:le|be)?$/.test(codecLower) ||
    codecLower === 'pcm_dvd' ||
    codecLower === 'pcm_bluray'
  );
}

/**
 * Reads the standard 32-byte WavPack block header (`wvpk`, flags uint32LE at offset 24)
 * and checks for a companion `.wvc` correction file.
 * Bit 3 (`0x08`) in WavPack block header flags is `HYBRID_FLAG`:
 * - 0 => pure lossless WavPack
 * - 1 => hybrid/lossy WavPack (lossless ONLY when paired with `.wvc` correction file)
 */
export async function inspectWavPackFileMode(
  filePath: string,
  ffprobeHint?: { profile?: string | null; tags?: Record<string, string> },
): Promise<WavPackModeKind> {
  const wvcPath = `${filePath.slice(0, Math.max(0, filePath.lastIndexOf('.')))}.wvc`;
  const hasWvc = await fs
    .stat(wvcPath)
    .then((st) => st.isFile() && st.size > 0)
    .catch(() => false);

  // Check real 32-byte WavPack header first (works 100% offline with or without FFprobe)
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(32);
    const { bytesRead } = await fh.read(buf, 0, 32, 0);
    if (bytesRead >= 32 && buf.subarray(0, 4).toString('ascii') === 'wvpk') {
      const flags = buf.readUInt32LE(24);
      const isHybridFlag = (flags & 0x08) !== 0;
      if (!isHybridFlag) {
        return 'lossless';
      }
      return hasWvc ? 'hybrid-with-correction' : 'hybrid-without-correction';
    }
  } catch {
    // Fall through to FFprobe/tag hints
  } finally {
    await fh?.close().catch(() => {});
  }

  const profileLower = (ffprobeHint?.profile ?? '').toLowerCase();
  const modeTag = extractTagCaseInsensitive(ffprobeHint?.tags ?? {}, [
    'wavpack_mode',
    'encoding',
    'encoder_settings',
  ])?.toLowerCase();

  if (profileLower.includes('hybrid') || modeTag?.includes('hybrid')) {
    return hasWvc ? 'hybrid-with-correction' : 'hybrid-without-correction';
  }
  if (profileLower.includes('lossy') || modeTag?.includes('lossy')) {
    return 'lossy';
  }
  if (profileLower.includes('lossless') || modeTag?.includes('lossless')) {
    return 'lossless';
  }

  return 'unknown';
}

/**
 * Classifies an audio stream accurately without claiming fake `verified-lossless`.
 */
export function classifyAudioStream(params: {
  codecName: string;
  container: string;
  rawSampleFmt?: string | null;
  wavpackMode?: WavPackModeKind | null;
  codecInferredFromExtension?: boolean;
}): {
  status: LosslessVerificationStatus;
  summary: string;
} {
  const codec = params.codecName.trim().toLowerCase();
  const container = params.container.trim().toLowerCase();

  if (params.codecInferredFromExtension && (!codec || codec === 'm4a' || codec === 'mp4')) {
    return {
      status: 'unknown',
      summary:
        'Container MP4/M4A chưa được phân tích luồng — không thể tự đoán ALAC hay AAC chỉ từ phần mở rộng tệp.',
    };
  }

  // WavPack requires dedicated lossless vs hybrid vs lossy inspection
  if (codec === 'wavpack' || codec === 'wv') {
    const mode = params.wavpackMode ?? 'unknown';
    if (mode === 'lossless') {
      return {
        status: 'lossless-codec',
        summary:
          'WavPack Lossless (đã kiểm tra cờ header không hybrid) — codec nén không suy hao.',
      };
    }
    if (mode === 'hybrid-with-correction') {
      return {
        status: 'wavpack-hybrid',
        summary:
          'WavPack Hybrid kèm tệp hiệu chỉnh (.wvc) — có thể tái tạo lossless khi giải mã đủ cặp .wv + .wvc.',
      };
    }
    if (mode === 'hybrid-without-correction') {
      return {
        status: 'wavpack-lossy',
        summary:
          'WavPack Hybrid nhưng THIẾU tệp hiệu chỉnh (.wvc) — luồng hiện tại chỉ giải mã được ở chế độ lossy.',
      };
    }
    if (mode === 'lossy') {
      return {
        status: 'wavpack-lossy',
        summary: 'WavPack chế độ Lossy — dữ liệu âm thanh đã bị nén có suy hao.',
      };
    }
    return {
      status: 'unknown',
      summary:
        'WavPack chưa xác định được chế độ (lossless / hybrid / lossy) — không mặc định là lossless khi chưa kiểm tra header hoặc FFprobe.',
    };
  }

  // Reject ADPCM / u-law / A-law from being misclassified as uncompressed lossless PCM
  if (LOSSY_PCM_VARIANTS.has(codec) || codec.startsWith('adpcm')) {
    return {
      status: 'lossy-compressed',
      summary: `Biến thể PCM nén có suy hao (${params.codecName.toUpperCase()}) — không phải PCM tuyến tính không suy hao.`,
    };
  }

  // Uncompressed linear PCM (must verify codec is actually linear PCM, not just WAV container)
  if (isUncompressedLinearPcmCodec(codec)) {
    const floatNote =
      codec.startsWith('pcm_f') || params.rawSampleFmt === 'flt' || params.rawSampleFmt === 'dbl'
        ? ' (dấu phẩy động float)'
        : ' (số nguyên integer)';
    return {
      status: 'uncompressed-pcm',
      summary: `PCM tuyến tính không nén${floatNote} (${params.codecName.toUpperCase()}) — không áp dụng nén có suy hao.`,
    };
  }

  // WAV/AIFF container without confirmed linear PCM codec should not be assumed linear PCM
  if ((container.includes('wav') || container.includes('aiff')) && !codec) {
    return {
      status: 'unknown',
      summary:
        'Container WAV/AIFF nhưng chưa xác định được codec bên trong (có thể chứa PCM tuyến tính hoặc ADPCM/MP3).',
    };
  }

  // Standard lossless codecs (never claim `verified-lossless` authenticity from codec name alone)
  if (LOSSLESS_CODECS.has(codec)) {
    return {
      status: 'lossless-codec',
      summary: `Codec nén không suy hao (${params.codecName.toUpperCase()}) — bảo toàn mẫu PCM đầu vào khi mã hóa (không thay thế kiểm chứng nguồn gốc master).`,
    };
  }

  if (isKnownLossyCodecName(codec)) {
    return {
      status: 'lossy-compressed',
      summary: `Codec nén có suy hao (${params.codecName.toUpperCase()}) — tối ưu dung lượng phát lại.`,
    };
  }

  return {
    status: 'unknown',
    summary: `Chưa đủ dữ liệu luồng để phân loại chính xác codec "${params.codecName || 'Unknown'}".`,
  };
}

function parseNumericTag(value: string | undefined): number | null {
  if (!value) return null;
  const match = /-?\d+(?:\.\d+)?/.exec(value);
  if (!match) return null;
  const num = Number(match[0]);
  return Number.isFinite(num) ? num : null;
}

/**
 * Parses RFC 7845 `R128_TRACK_GAIN` (stored as signed Q7.8 fixed-point integer in Opus/Ogg,
 * where 1 dB = 256 units, or occasionally written with explicit `dB` suffix).
 * Kept strictly separate from EBU R128 Integrated LUFS!
 */
export function parseR128TrackGainDb(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Explicit dB notation (e.g. "-3.50 dB")
  if (/db$/i.test(trimmed)) {
    return parseNumericTag(trimmed);
  }

  // Standard RFC 7845 integer Q7.8 format (e.g. "-512" => -2.0 dB)
  if (/^[+-]?\d+$/.test(trimmed)) {
    const q78 = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(q78)) return null;
    return Number((q78 / 256).toFixed(3));
  }

  return parseNumericTag(trimmed);
}

export function extractTagCaseInsensitive(
  tags: Record<string, string>,
  candidates: readonly string[],
): string | undefined {
  const lowerMap = new Map<string, string>();
  for (const [k, v] of Object.entries(tags)) {
    lowerMap.set(k.toLowerCase(), v);
  }
  for (const name of candidates) {
    const val = lowerMap.get(name.toLowerCase());
    if (val !== undefined) {
      return val;
    }
  }
  return undefined;
}

/**
 * Strictly separates ReplayGain tags, RFC 7845 `R128_TRACK_GAIN`, and explicit Integrated LUFS tags.
 */
export function parseReplayGainAndLoudnessTags(tags: Record<string, string>): {
  replayGain: AudioAnalysisReport['replayGain'];
  r128TrackGainDb: number | null;
  loudness: AudioAnalysisReport['loudness'];
} {
  return {
    replayGain: {
      trackGainDb: parseNumericTag(
        extractTagCaseInsensitive(tags, ['replaygain_track_gain']),
      ),
      albumGainDb: parseNumericTag(
        extractTagCaseInsensitive(tags, ['replaygain_album_gain']),
      ),
      trackPeak: parseNumericTag(
        extractTagCaseInsensitive(tags, ['replaygain_track_peak']),
      ),
      albumPeak: parseNumericTag(
        extractTagCaseInsensitive(tags, ['replaygain_album_peak']),
      ),
    },
    r128TrackGainDb: parseR128TrackGainDb(
      extractTagCaseInsensitive(tags, ['r128_track_gain']),
    ),
    loudness: {
      integratedLufs: parseNumericTag(
        extractTagCaseInsensitive(tags, [
          'loudness_integrated',
          'ebu_r128_integrated',
          'r128_integrated_lufs',
        ]),
      ),
      truePeakDbtp: parseNumericTag(
        extractTagCaseInsensitive(tags, ['loudness_true_peak', 'ebu_r128_true_peak']),
      ),
      loudnessRangeLu: parseNumericTag(
        extractTagCaseInsensitive(tags, ['loudness_range', 'ebu_r128_lra']),
      ),
      measured: false,
    },
  };
}

export async function runFfprobeJsonDetailed(
  ffprobePath: string,
  filePath: string,
  timeoutMs = DEFAULT_FFPROBE_TIMEOUT_MS,
): Promise<FfprobeRunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        ffprobePath,
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          filePath,
        ],
        {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch (err) {
      resolve({
        status: 'execution-failed',
        data: null,
        errorDetail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve({
          status: 'timeout',
          data: null,
          errorDetail: `FFprobe vượt quá thời gian chờ (${timeoutMs} ms).`,
        });
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_FFPROBE_STDOUT_BYTES) {
        const remaining = MAX_FFPROBE_STDOUT_BYTES - stdout.length;
        stdout += chunk.toString('utf8', 0, Math.min(chunk.length, remaining));
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_FFPROBE_STDERR_BYTES) {
        const remaining = MAX_FFPROBE_STDERR_BYTES - stderr.length;
        stderr += chunk.toString('utf8', 0, Math.min(chunk.length, remaining));
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          status: 'execution-failed',
          data: null,
          errorDetail: err.message,
        });
      }
    });

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          resolve({
            status: 'execution-failed',
            data: null,
            errorDetail: `FFprobe thoát với mã ${String(code)}${stderr.trim() ? `: ${stderr.trim().slice(0, 220)}` : ''}`,
          });
          return;
        }
        if (!stdout.trim()) {
          resolve({
            status: 'invalid-json',
            data: null,
            errorDetail: 'FFprobe trả về đầu ra rỗng.',
          });
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as FfprobeJsonOutput;
          const audioStream = (parsed.streams ?? []).find((s) => s.codec_type === 'audio');
          if (!audioStream) {
            resolve({
              status: 'audio-stream-not-found',
              data: parsed,
              errorDetail: 'FFprobe không tìm thấy luồng âm thanh (audio stream) hợp lệ trong tệp.',
            });
            return;
          }
          resolve({
            status: 'ok',
            data: parsed,
            errorDetail: null,
          });
        } catch (err) {
          resolve({
            status: 'invalid-json',
            data: null,
            errorDetail: `JSON đầu ra của FFprobe không hợp lệ: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    });
  });
}

function mapFfprobeFailureWarning(
  status: FfprobeExecutionStatus,
  detail: string | null,
): string {
  switch (status) {
    case 'missing':
      return 'Chưa cài đặt FFprobe — đang dùng bộ đọc metadata tích hợp (chế độ offline).';
    case 'incompatible':
      return `FFprobe không tương thích với nền tảng hiện tại${detail ? ` (${detail})` : ''} — đang dùng bộ đọc metadata tích hợp.`;
    case 'missing-dependency':
      return `FFprobe thiếu thư viện phụ thuộc${detail ? ` (${detail})` : ''} — đang dùng bộ đọc metadata tích hợp.`;
    case 'unverified':
      return 'FFprobe chưa được xác minh tin cậy (unverified/chưa cấp quyền) — không tự động thực thi; đang dùng bộ đọc metadata tích hợp.';
    case 'pending-desktop-verification':
      return 'FFprobe thuộc nền tảng Windows (Pending Desktop Verification) — đang dùng bộ đọc metadata tích hợp.';
    case 'timeout':
      return `FFprobe đã cài nhưng thực thi bị quá thời gian chờ (${detail ?? 'timeout'}) — chuyển sang bộ đọc metadata tích hợp.`;
    case 'execution-failed':
      return `FFprobe đã cài nhưng thực thi thất bại (${detail ?? 'exit error'}) — chuyển sang bộ đọc metadata tích hợp.`;
    case 'invalid-json':
      return `FFprobe đã chạy nhưng trả về dữ liệu JSON không hợp lệ (${detail ?? 'parse error'}) — chuyển sang bộ đọc metadata tích hợp.`;
    case 'audio-stream-not-found':
      return 'FFprobe không tìm thấy audio stream hợp lệ trong tệp — kiểm tra lại tệp nguồn hoặc chuyển sang đọc metadata cơ bản.';
    default:
      return 'Đang dùng bộ đọc metadata tích hợp.';
  }
}

export class AudioAnalyzerService {
  private readonly resourcePolicy?: ResourcePolicyManager;
  private readonly ffprobeTimeoutMs: number;
  private activeProbes = 0;
  private readonly probeWaiters: Array<() => void> = [];

  constructor(
    private readonly codecManager: CodecManager,
    options?: AudioAnalyzerServiceOptions,
  ) {
    this.resourcePolicy = options?.resourcePolicy;
    this.ffprobeTimeoutMs = options?.ffprobeTimeoutMs ?? DEFAULT_FFPROBE_TIMEOUT_MS;
  }

  private async acquireProbeSlot(): Promise<void> {
    const limit = this.resourcePolicy?.getEffectiveLimits().analyzerConcurrency ?? 1;
    if (this.activeProbes < limit) {
      this.activeProbes += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.probeWaiters.push(resolve);
    });
    this.activeProbes += 1;
  }

  private releaseProbeSlot(): void {
    this.activeProbes = Math.max(0, this.activeProbes - 1);
    const next = this.probeWaiters.shift();
    if (next) {
      next();
    }
  }

  /**
   * Probes concise source audio parameters (`bitDepth`, `sampleFormat`, `sampleRateHz`, `channels`,
   * `hasAttachedPic`, `hasVideoStream`, `tags`) for AudioProcessingService before planning conversion.
   */
  async probeSourceAudioSpec(filePath: string): Promise<SourceAudioSpec> {
    const resolvedPath = path.resolve(filePath);
    const ffprobeEntry = await this.codecManager.resolveCodec('ffprobe', false);

    if (
      ffprobeEntry.status === 'ready' &&
      ffprobeEntry.executablePath &&
      ffprobeEntry.sourceTier !== 'builtin'
    ) {
      await this.acquireProbeSlot();
      this.codecManager.markCodecInUse('ffprobe');
      try {
        const probeRes = await runFfprobeJsonDetailed(
          ffprobeEntry.executablePath,
          resolvedPath,
          this.ffprobeTimeoutMs,
        );
        if (probeRes.status === 'ok' && probeRes.data) {
          const streams = probeRes.data.streams ?? [];
          const audioStream = streams.find((s) => s.codec_type === 'audio');
          const videoStreams = streams.filter((s) => s.codec_type === 'video');
          const hasAttachedPic = videoStreams.some(
            (v) => v.disposition?.attached_pic === 1,
          );
          const hasVideoStream = videoStreams.some(
            (v) => v.disposition?.attached_pic !== 1,
          );
          const format = probeRes.data.format ?? {};
          const mergedTags: Record<string, string> = {
            ...(format.tags ?? {}),
            ...(audioStream?.tags ?? {}),
          };

          const codecName = audioStream?.codec_name ?? null;
          const rawSampleFmt = audioStream?.sample_fmt ?? null;
          const sampleFormat = detectSampleFormat(codecName, rawSampleFmt);
          const rawBits = audioStream?.bits_per_raw_sample
            ? Number(audioStream.bits_per_raw_sample)
            : typeof audioStream?.bits_per_sample === 'number' && audioStream.bits_per_sample > 0
              ? audioStream.bits_per_sample
              : null;
          const bitDepth =
            rawBits && Number.isFinite(rawBits) && rawBits > 0
              ? rawBits
              : inferBitDepthFromCodecOrSampleFmt(codecName, rawSampleFmt);
          const sampleRateHz = audioStream?.sample_rate ? Number(audioStream.sample_rate) : null;
          const channels = typeof audioStream?.channels === 'number' ? audioStream.channels : null;
          const durationSec = audioStream?.duration
            ? Number(audioStream.duration)
            : format.duration
              ? Number(format.duration)
              : null;

          const ext = extractFileExtension(resolvedPath);
          const wavpackMode =
            codecName?.toLowerCase() === 'wavpack' || ext === '.wv'
              ? await inspectWavPackFileMode(resolvedPath, {
                  profile: audioStream?.profile,
                  tags: mergedTags,
                })
              : null;
          const classification = classifyAudioStream({
            codecName: codecName ?? '',
            container: format.format_name ?? ext,
            rawSampleFmt,
            wavpackMode,
          });

          return {
            codecName,
            container: format.format_name ?? null,
            sampleRateHz: sampleRateHz && Number.isFinite(sampleRateHz) ? sampleRateHz : null,
            bitDepth,
            validBitsPerSample: bitDepth,
            sampleFormat,
            rawSampleFmt,
            channels,
            channelLayout: audioStream?.channel_layout ?? null,
            isLosslessCodec:
              classification.status === 'lossless-codec' ||
              classification.status === 'uncompressed-pcm' ||
              classification.status === 'wavpack-hybrid'
                ? true
                : classification.status === 'lossy-compressed' ||
                    classification.status === 'wavpack-lossy'
                  ? false
                  : null,
            hasAttachedPic,
            hasVideoStream,
            durationSec: durationSec && Number.isFinite(durationSec) ? durationSec : null,
            tags: sanitizeTagsForUi(mergedTags),
          };
        }
      } finally {
        this.codecManager.releaseCodecInUse('ffprobe');
        this.releaseProbeSlot();
      }
    }

    // Offline fallback via music-metadata + MP4 ALAC probe (never invents default bit depth/channels)
    try {
      const meta = await readTrackMetadata(resolvedPath);
      const ext = extractFileExtension(resolvedPath);
      let codecName = meta.codec ?? null;
      let sampleRateHz = meta.sample_rate_hz ?? null;
      let bitDepth = meta.bit_depth ?? null;
      let channels: number | null = null;

      if (ext === '.m4a' || ext === '.mp4') {
        const mp4Probe = await detectMp4AudioCodec(resolvedPath);
        if (mp4Probe.codec === 'alac') {
          codecName = 'alac';
          sampleRateHz = mp4Probe.sampleRateHz ?? sampleRateHz;
          bitDepth = mp4Probe.bitDepth ?? bitDepth;
          channels = mp4Probe.channels ?? null;
        } else if (mp4Probe.codec === 'aac') {
          codecName = 'aac';
        }
      }

      const wavpackMode =
        codecName?.toLowerCase() === 'wavpack' || ext === '.wv'
          ? await inspectWavPackFileMode(resolvedPath)
          : null;
      const classification = classifyAudioStream({
        codecName: codecName ?? '',
        container: meta.container ?? ext,
        wavpackMode,
        codecInferredFromExtension: !codecName,
      });

      const tags: Record<string, string> = {};
      if (meta.title) tags.title = meta.title;
      if (meta.artist) tags.artist = meta.artist;
      if (meta.album) tags.album = meta.album;
      if (meta.year) tags.date = String(meta.year);

      return {
        codecName,
        container: meta.container ?? null,
        sampleRateHz,
        bitDepth,
        validBitsPerSample: bitDepth,
        sampleFormat: detectSampleFormat(codecName, null),
        rawSampleFmt: null,
        channels,
        channelLayout: null,
        isLosslessCodec:
          classification.status === 'lossless-codec' ||
          classification.status === 'uncompressed-pcm' ||
          classification.status === 'wavpack-hybrid'
            ? true
            : classification.status === 'lossy-compressed' ||
                classification.status === 'wavpack-lossy'
              ? false
              : null,
        hasAttachedPic: undefined,
        hasVideoStream: false,
        durationSec: meta.duration_ms ? meta.duration_ms / 1000 : null,
        tags,
      };
    } catch {
      return {
        sampleFormat: 'unknown',
      };
    }
  }

  async analyzeFile(
    filePath: string,
    trackId: string | null = null,
  ): Promise<AudioAnalysisReport> {
    const resolvedPath = path.resolve(filePath);
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) {
      throw new Error('Đường dẫn phân tích không phải là tệp âm thanh hợp lệ.');
    }

    const ext = extractFileExtension(resolvedPath);
    const fileName = path.basename(resolvedPath);
    const readyCodecs = await this.codecManager.getReadyCodecSet();
    const ffprobeEntry = await this.codecManager.resolveCodec('ffprobe', false);

    let ffprobeStatus: FfprobeExecutionStatus = 'missing';
    let ffprobeErrorDetail: string | null = null;
    let ffprobeData: FfprobeJsonOutput | null = null;

    if (
      ffprobeEntry.status === 'ready' &&
      ffprobeEntry.executablePath &&
      ffprobeEntry.sourceTier !== 'builtin'
    ) {
      await this.acquireProbeSlot();
      this.codecManager.markCodecInUse('ffprobe');
      try {
        const res = await runFfprobeJsonDetailed(
          ffprobeEntry.executablePath,
          resolvedPath,
          this.ffprobeTimeoutMs,
        );
        ffprobeStatus = res.status;
        ffprobeErrorDetail = res.errorDetail;
        if (res.status === 'ok') {
          ffprobeData = res.data;
        }
      } finally {
        this.codecManager.releaseCodecInUse('ffprobe');
        this.releaseProbeSlot();
      }
    } else {
      ffprobeErrorDetail = ffprobeEntry.errorMessage ?? null;
      switch (ffprobeEntry.status) {
        case 'incompatible':
          ffprobeStatus = 'incompatible';
          break;
        case 'missing-dependency':
          ffprobeStatus = 'missing-dependency';
          break;
        case 'pending-desktop-verification':
          ffprobeStatus = 'pending-desktop-verification';
          break;
        case 'unverified':
        case 'invalid':
        case 'disabled':
          ffprobeStatus = 'unverified';
          break;
        default:
          ffprobeStatus = 'missing';
          break;
      }
    }

    const warnings: string[] = [];

    if (ffprobeData) {
      const audioStream = (ffprobeData.streams ?? []).find(
        (stream) => stream.codec_type === 'audio',
      );
      const format = ffprobeData.format ?? {};
      const mergedTags: Record<string, string> = {
        ...(format.tags ?? {}),
        ...(audioStream?.tags ?? {}),
      };

      const rawCodecName = audioStream?.codec_name?.trim() ?? '';
      const codecInferredFromExtension = rawCodecName.length === 0;
      const codecName = rawCodecName || 'unknown';
      const codecLongName = audioStream?.codec_long_name ?? codecName.toUpperCase();
      const container = format.format_long_name ?? format.format_name ?? 'Unknown';
      const rawSampleFmt = audioStream?.sample_fmt ?? null;
      const sampleFormat = detectSampleFormat(codecName, rawSampleFmt);

      const sampleRateParsed = audioStream?.sample_rate ? Number(audioStream.sample_rate) : null;
      const sampleRateHz =
        sampleRateParsed && Number.isFinite(sampleRateParsed) && sampleRateParsed > 0
          ? sampleRateParsed
          : null;

      const channels =
        typeof audioStream?.channels === 'number' && audioStream.channels > 0
          ? audioStream.channels
          : null;

      const rawBits = audioStream?.bits_per_raw_sample
        ? Number(audioStream.bits_per_raw_sample)
        : typeof audioStream?.bits_per_sample === 'number' && audioStream.bits_per_sample > 0
          ? audioStream.bits_per_sample
          : null;
      const bitDepth =
        rawBits && Number.isFinite(rawBits) && rawBits > 0
          ? rawBits
          : inferBitDepthFromCodecOrSampleFmt(codecName, rawSampleFmt);

      const durationParsed = audioStream?.duration
        ? Number(audioStream.duration)
        : format.duration
          ? Number(format.duration)
          : null;
      const durationSec =
        durationParsed && Number.isFinite(durationParsed) && durationParsed > 0
          ? durationParsed
          : null;

      const directBitrate = audioStream?.bit_rate
        ? Number(audioStream.bit_rate)
        : format.bit_rate
          ? Number(format.bit_rate)
          : null;
      const hasDirectBitrate = Boolean(directBitrate && Number.isFinite(directBitrate) && directBitrate > 0);
      const bitrateBps = hasDirectBitrate
        ? directBitrate
        : durationSec && durationSec > 0
          ? Math.round((stat.size * 8) / durationSec)
          : null;
      const bitrateEstimated = !hasDirectBitrate && bitrateBps !== null;

      const wavpackMode =
        codecName.toLowerCase() === 'wavpack' || ext === '.wv'
          ? await inspectWavPackFileMode(resolvedPath, {
              profile: audioStream?.profile,
              tags: mergedTags,
            })
          : null;

      const classification = classifyAudioStream({
        codecName,
        container,
        rawSampleFmt,
        wavpackMode,
        codecInferredFromExtension,
      });

      // ONLY compute PCM bitrate when sampleRateHz, channels, AND bitDepth are ALL known (no fake 16-bit/2ch!)
      const estimatedPcmBitrateBps =
        sampleRateHz && channels && bitDepth ? sampleRateHz * channels * bitDepth : null;
      const compressionRatio =
        estimatedPcmBitrateBps && bitrateBps && bitrateBps > 0
          ? Number((bitrateBps / estimatedPcmBitrateBps).toFixed(3))
          : null;

      const { strategy, label, pendingPlaybackIntegration } = resolveDecoderStrategy({
        ext,
        codec: codecName,
        container,
        readyCodecs,
      });

      if (
        classification.status === 'lossless-codec' &&
        compressionRatio !== null &&
        compressionRatio < 0.25
      ) {
        warnings.push(
          'Tỷ lệ nén rất thấp bất thường (< 25% PCM ước tính) — có thể là tín hiệu im lặng kéo dài hoặc nội dung ít năng lượng tần số cao.',
        );
      }

      const { replayGain, r128TrackGainDb, loudness } = parseReplayGainAndLoudnessTags(mergedTags);

      return {
        analyzedAt: new Date().toISOString(),
        sourcePath: resolvedPath,
        trackId,
        fileName,
        fileExtension: ext,
        fileSizeBytes: stat.size,
        analyzerBackend: 'ffprobe',
        ffprobeStatus: 'ok',
        ffprobeErrorDetail: null,
        container,
        codec: codecName.toUpperCase(),
        codecLongName,
        codecInferredFromExtension,
        sampleFormat,
        rawSampleFmt,
        losslessStatus: classification.status,
        losslessSummary: classification.summary,
        wavpackMode,
        fileIntegrityStatus: 'header-probed',
        sourceAuthenticityNote: SOURCE_AUTHENTICITY_NOTE,
        playbackOutputNote: PLAYBACK_OUTPUT_NOTE,
        durationSec,
        sampleRateHz,
        bitDepth,
        channels,
        channelLayout:
          audioStream?.channel_layout ??
          (channels === 2 ? 'stereo' : channels === 1 ? 'mono' : null),
        bitrateBps,
        compressionRatio,
        estimatedPcmBitrateBps,
        estimatedMetrics: {
          bitrateEstimated,
          pcmBitrateEstimated: estimatedPcmBitrateBps !== null,
          compressionRatioEstimated: compressionRatio !== null,
        },
        decoderStrategy: strategy,
        decoderStrategyLabel: label,
        pendingPlaybackIntegration,
        replayGain,
        r128TrackGainDb,
        loudness,
        tags: sanitizeTagsForUi(mergedTags),
        warnings,
      };
    }

    // Pure offline fallback using music-metadata + ISO-BMFF ALAC probe + WavPack header inspection
    warnings.push(mapFfprobeFailureWarning(ffprobeStatus, ffprobeErrorDetail));

    let meta: Awaited<ReturnType<typeof readTrackMetadata>> | null = null;
    try {
      meta = await readTrackMetadata(resolvedPath);
    } catch (err) {
      warnings.push(
        `Bộ đọc metadata tích hợp không đọc được đầy đủ header: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let codecName = meta?.codec?.trim() ?? '';
    let codecInferredFromExtension = false;
    let sampleRateHz = meta?.sample_rate_hz ?? null;
    let bitDepth = meta?.bit_depth ?? null;
    // NEVER hardcode channels = 2 when missing!
    let channels: number | null = null;

    if (ext === '.m4a' || ext === '.mp4') {
      const mp4Probe = await detectMp4AudioCodec(resolvedPath).catch(() => ({
        codec: 'unknown' as const,
        sampleRateHz: null,
        bitDepth: null,
        channels: null,
      }));
      if (mp4Probe.codec === 'alac') {
        codecName = 'alac';
        sampleRateHz = mp4Probe.sampleRateHz ?? sampleRateHz;
        bitDepth = mp4Probe.bitDepth ?? bitDepth;
        channels = mp4Probe.channels ?? null;
      } else if (mp4Probe.codec === 'aac') {
        codecName = 'aac';
      }
    }

    if (!codecName) {
      codecInferredFromExtension = true;
      codecName = ext === '.m4a' || ext === '.mp4' ? '' : ext.replace(/^\./, '');
    }

    const wavpackMode =
      codecName.toLowerCase() === 'wavpack' || ext === '.wv'
        ? await inspectWavPackFileMode(resolvedPath)
        : null;

    const container = meta?.container ?? (ext ? ext.replace(/^\./, '').toUpperCase() : 'Unknown');
    const classification = classifyAudioStream({
      codecName,
      container,
      wavpackMode,
      codecInferredFromExtension,
    });

    const durationSec = meta?.duration_ms && meta.duration_ms > 0 ? meta.duration_ms / 1000 : null;
    const hasDirectBitrate = Boolean(meta?.bitrate_bps && meta.bitrate_bps > 0);
    const bitrateBps = hasDirectBitrate
      ? meta!.bitrate_bps
      : durationSec && durationSec > 0
        ? Math.round((stat.size * 8) / durationSec)
        : null;
    const bitrateEstimated = !hasDirectBitrate && bitrateBps !== null;

    // Never fabricate PCM bitrate with fallback 16-bit or 2-channel assumptions
    const estimatedPcmBitrateBps =
      sampleRateHz && channels && bitDepth ? sampleRateHz * channels * bitDepth : null;
    const compressionRatio =
      estimatedPcmBitrateBps && bitrateBps && bitrateBps > 0
        ? Number((bitrateBps / estimatedPcmBitrateBps).toFixed(3))
        : null;

    const { strategy, label, pendingPlaybackIntegration } = resolveDecoderStrategy({
      ext,
      codec: codecName,
      container,
      readyCodecs,
    });

    const tags: Record<string, string> = {};
    if (meta?.title) tags.title = meta.title;
    if (meta?.artist) tags.artist = meta.artist;
    if (meta?.album) tags.album = meta.album;
    if (meta?.year) tags.year = String(meta.year);

    return {
      analyzedAt: new Date().toISOString(),
      sourcePath: resolvedPath,
      trackId,
      fileName,
      fileExtension: ext,
      fileSizeBytes: stat.size,
      analyzerBackend: 'music-metadata-fallback',
      ffprobeStatus,
      ffprobeErrorDetail,
      container,
      codec: codecName ? codecName.toUpperCase() : 'UNKNOWN',
      codecLongName: codecName
        ? `${codecName.toUpperCase()} (${container})`
        : `Unknown (${container})`,
      codecInferredFromExtension,
      sampleFormat: detectSampleFormat(codecName, null),
      rawSampleFmt: null,
      losslessStatus: classification.status,
      losslessSummary: classification.summary,
      wavpackMode,
      fileIntegrityStatus: meta ? 'metadata-only' : 'unverified',
      sourceAuthenticityNote: SOURCE_AUTHENTICITY_NOTE,
      playbackOutputNote: PLAYBACK_OUTPUT_NOTE,
      durationSec,
      sampleRateHz,
      bitDepth,
      channels,
      channelLayout: channels === 2 ? 'stereo' : channels === 1 ? 'mono' : null,
      bitrateBps,
      compressionRatio,
      estimatedPcmBitrateBps,
      estimatedMetrics: {
        bitrateEstimated,
        pcmBitrateEstimated: estimatedPcmBitrateBps !== null,
        compressionRatioEstimated: compressionRatio !== null,
      },
      decoderStrategy: strategy,
      decoderStrategyLabel: label,
      pendingPlaybackIntegration,
      replayGain: {
        trackGainDb: meta?.replaygain_track_gain_db ?? null,
        albumGainDb: meta?.replaygain_album_gain_db ?? null,
        trackPeak: meta?.replaygain_track_peak ?? null,
        albumPeak: meta?.replaygain_album_peak ?? null,
      },
      r128TrackGainDb: null,
      loudness: {
        integratedLufs: null,
        truePeakDbtp: null,
        loudnessRangeLu: null,
        measured: false,
      },
      tags,
      warnings,
    };
  }
}

function inferBitDepthFromCodecOrSampleFmt(
  codecName: string | null | undefined,
  rawSampleFmt: string | null | undefined,
): number | null {
  const codec = (codecName ?? '').toLowerCase();
  if (codec.includes('s16') || codec.includes('u16')) return 16;
  if (codec.includes('s24') || codec.includes('u24')) return 24;
  if (codec.includes('s32') || codec.includes('f32')) return 32;
  if (codec.includes('f64') || codec.includes('s64')) return 64;
  if (codec === 'pcm_u8' || codec === 'pcm_s8') return 8;

  // Do NOT assign bit depth to lossy codecs just because FFprobe decodes them to `fltp`
  if (isKnownLossyCodecName(codec)) {
    return null;
  }

  const fmt = (rawSampleFmt ?? '').toLowerCase();
  if (fmt === 'u8' || fmt === 'u8p') return 8;
  if (fmt === 's16' || fmt === 's16p') return 16;
  if (fmt === 'flt' || fmt === 'fltp') return 32;
  if (fmt === 'dbl' || fmt === 'dblp') return 64;
  return null;
}

function sanitizeTagsForUi(tags: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  let count = 0;
  for (const [key, val] of Object.entries(tags)) {
    if (count >= 24) break;
    if (typeof val !== 'string') continue;
    const trimmed = val.trim();
    if (!trimmed) continue;
    result[key] = trimmed.length > 220 ? `${trimmed.slice(0, 217)}...` : trimmed;
    count += 1;
  }
  return result;
}

/**
 * Determines decoder strategy honestly from actual codec knowledge (NOT blind file extension),
 * explicitly distinguishing codecs currently integrated in Music Player from CLI candidates
 * whose playback integration is pending Phase 04.
 */
export function resolveDecoderStrategy(input: {
  ext: string;
  codec: string;
  container: string;
  readyCodecs: ReadonlySet<string>;
}): {
  strategy: DecoderStrategyKind;
  label: string;
  pendingPlaybackIntegration: boolean;
} {
  const ext = input.ext.toLowerCase();
  const codecLower = input.codec.trim().toLowerCase();

  if (
    codecLower === 'alac' ||
    isAlacTrackMetadata({
      codec: input.codec,
      container: input.container,
      original_path: `file${ext}`,
    })
  ) {
    return {
      strategy: 'alac-wasm',
      label: 'DoReMi Built-in ALAC WASM Decoder (đã tích hợp sẵn, hoạt động offline)',
      pendingPlaybackIntegration: false,
    };
  }

  if (
    PLAYBACK_ENGINE_SUPPORTED_CODECS.has(codecLower) ||
    isUncompressedLinearPcmCodec(codecLower)
  ) {
    return {
      strategy: 'supported-playback-engine',
      label: 'DoReMi Music Player Playback Engine (hỗ trợ phát trực tiếp)',
      pendingPlaybackIntegration: false,
    };
  }

  if (
    (codecLower === 'wavpack' || codecLower === 'wv' || ext === '.wv') &&
    input.readyCodecs.has('wvunpack')
  ) {
    return {
      strategy: 'native-decoder-candidate',
      label: 'WavPack CLI Decoder (wvunpack sẵn sàng — Pending Playback Integration ở Phase 04)',
      pendingPlaybackIntegration: true,
    };
  }

  if (
    (codecLower === 'mpc' || codecLower === 'mpc7' || codecLower === 'mpc8' || codecLower === 'musepack' || ext === '.mpc') &&
    input.readyCodecs.has('mpcdec')
  ) {
    return {
      strategy: 'native-decoder-candidate',
      label: 'Musepack CLI Decoder (mpcdec sẵn sàng — Pending Playback Integration ở Phase 04)',
      pendingPlaybackIntegration: true,
    };
  }

  if ((codecLower === 'tak' || ext === '.tak') && input.readyCodecs.has('tak')) {
    return {
      strategy: 'native-decoder-candidate',
      label: 'TAK CLI Decoder (takc sẵn sàng — Pending Playback Integration ở Phase 04)',
      pendingPlaybackIntegration: true,
    };
  }

  if ((codecLower === 'ape' || codecLower === 'monkey' || ext === '.ape') && input.readyCodecs.has('mac')) {
    return {
      strategy: 'native-decoder-candidate',
      label: "Monkey's Audio CLI Decoder (mac sẵn sàng — Pending Playback Integration ở Phase 04)",
      pendingPlaybackIntegration: true,
    };
  }

  if (input.readyCodecs.has('ffmpeg')) {
    return {
      strategy: 'ffmpeg-fallback-candidate',
      label: 'FFmpeg Decoder Candidate (sẵn sàng cho chuyển đổi — Pending Playback Integration ở Phase 04)',
      pendingPlaybackIntegration: true,
    };
  }

  return {
    strategy: 'unsupported',
    label: 'Chưa có bộ giải mã tương thích — cần cài bộ giải mã bổ sung hoặc FFmpeg',
    pendingPlaybackIntegration: true,
  };
}
