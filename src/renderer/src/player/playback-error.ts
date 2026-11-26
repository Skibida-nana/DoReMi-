import type {
  PlaybackErrorCode,
  PlaybackErrorDetails,
  PlaybackErrorStage,
} from '../../../shared/types/player';
import type { DiagnosticLogEntry } from '../../../shared/types/stage6';
import type { TrackRecord } from '../../../shared/types/track';
import { classifyTrackAudioCodec } from '../../../shared/utils/audio-codec';

export interface MediaErrorContext {
  readonly code: number;
  readonly message?: string;
}

export interface BuildPlaybackErrorInput {
  attemptId: string;
  stage: PlaybackErrorStage;
  track: TrackRecord | null;
  mediaError?: MediaErrorContext | null;
  thrownError?: unknown;
  explicitCode?: PlaybackErrorCode;
  explicitMessage?: string;
  isMissingFile?: boolean;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.name && error.name !== 'Error'
      ? `${error.name}: ${error.message}`
      : error.message;
  }
  return typeof error === 'string' ? error : String(error ?? '');
}

function buildFormatLabel(track: TrackRecord | null): string {
  if (!track) return '';
  const classified = classifyTrackAudioCodec(track);
  const spec = classified.isM4aContainer
    ? `${classified.displayCodec} (${classified.qualityLabel})`
    : classified.displayCodec;
  const sr = track.sample_rate_hz ? `${(track.sample_rate_hz / 1000).toFixed(1).replace(/\.0$/, '')}kHz` : null;
  const bits = track.bit_depth ? `${track.bit_depth}-bit` : null;
  return [spec, bits, sr].filter(Boolean).join(' · ');
}

/**
 * Classifies playback errors into deterministic user-facing Vietnamese summaries,
 * actionable recovery guidance, and structured diagnostic metadata without guessing or hiding causes.
 */
export function buildPlaybackErrorDetails(
  input: BuildPlaybackErrorInput,
): PlaybackErrorDetails {
  const { attemptId, stage, track, mediaError, thrownError, explicitCode, explicitMessage, isMissingFile } = input;
  const classified = track ? classifyTrackAudioCodec(track) : null;
  const formatHint = buildFormatLabel(track);
  const mediaMsg = mediaError?.message?.trim() ?? '';
  const thrownText = thrownError ? stringifyError(thrownError).trim() : '';
  const timestamp = new Date().toISOString();

  let code: PlaybackErrorCode = explicitCode ?? 'ERR_UNKNOWN_PLAYBACK';
  let summary = explicitMessage?.trim() || 'Không thể phát file âm thanh này.';
  let suggestion = 'Kiểm tra lại file gốc hoặc thử chuyển sang bài khác.';
  let missingFlag = Boolean(isMissingFile);

  if (code === 'ERR_FILE_MISSING' || missingFlag) {
    code = 'ERR_FILE_MISSING';
    missingFlag = true;
    summary = 'Không tìm thấy file âm thanh gốc trên ổ đĩa.';
    suggestion = 'File có thể đã bị di chuyển, đổi tên hoặc ổ đĩa chưa được kết nối. Hãy kiểm tra lại thư mục nhạc hoặc quét lại thư viện.';
  } else if (code === 'ERR_FILE_ACCESS_DENIED' || /EACCES|EPERM|permission|access denied|forbidden/i.test(`${explicitMessage ?? ''} ${thrownText}`)) {
    code = 'ERR_FILE_ACCESS_DENIED';
    summary = 'Không có quyền đọc file âm thanh hoặc đường dẫn bị chặn truy cập.';
    suggestion = 'Kiểm tra quyền đọc tệp trên Windows hoặc xem file có đang bị khóa bởi ứng dụng khác không.';
  } else if (mediaError) {
    switch (mediaError.code) {
      case 1:
        code = 'ERR_PLAYBACK_ABORTED';
        summary = 'Quá trình nạp luồng âm thanh đã bị gián đoạn trước khi sẵn sàng.';
        suggestion = 'Nhấn "Thử lại" hoặc chọn phát lại bài hát.';
        break;
      case 2:
        code = 'ERR_STREAM_READ_FAILED';
        summary = 'Lỗi đọc luồng dữ liệu âm thanh từ đĩa cục bộ.';
        suggestion = 'Kiểm tra xem ổ đĩa/USB chứa nhạc còn kết nối ổn định và file không bị khóa.';
        break;
      case 3:
        code = classified?.family === 'alac' ? 'ERR_ALAC_DECODE' : 'ERR_AUDIO_DECODE';
        summary =
          code === 'ERR_ALAC_DECODE'
            ? `Lỗi giải mã luồng ALAC${formatHint ? ` (${formatHint})` : ''}.`
            : `Lỗi giải mã khung dữ liệu âm thanh${formatHint ? ` (${formatHint})` : ''}.`;
        suggestion = 'Dữ liệu bên trong file âm thanh có thể bị hỏng hoặc không đúng chuẩn codec.';
        break;
      case 4:
        if (/DEMUXER_ERROR|FFmpegDemuxer|open context failed|moov|atom|header|parse/i.test(mediaMsg)) {
          code = 'ERR_CONTAINER_CORRUPT_HEADER';
          summary = `Không thể mở cấu trúc container/header${formatHint ? ` (${formatHint})` : ''}.`;
          suggestion = 'Header hoặc metadata nhúng trong file có cấu trúc bất thường khiến bộ giải mã từ chối mở luồng.';
        } else if (classified?.family === 'alac') {
          code = 'ERR_ALAC_DECODE';
          summary = `Không thể nạp luồng giải mã ALAC${formatHint ? ` (${formatHint})` : ''}.`;
          suggestion = 'Kiểm tra file M4A ALAC gốc xem có bị cắt cụt hoặc hỏng atom moov hay không.';
        } else if (classified?.family === 'unknown' && mediaMsg) {
          code = 'ERR_MEDIA_FORMAT_UNSUPPORTED';
          summary = `Định dạng hoặc codec${formatHint ? ` (${formatHint})` : ''} không được trình phát hỗ trợ.`;
          suggestion = 'Chuyển đổi file bằng Công cụ Codec hoặc kiểm tra định dạng nguồn.';
        } else {
          code = 'ERR_MEDIA_FORMAT_UNSUPPORTED';
          summary = `Không thể mở nguồn phát${formatHint ? ` (${formatHint})` : ''}: định dạng không tương thích hoặc tệp hỏng.`;
          suggestion = 'Nhấn "Xem chi tiết" để xem mã lỗi giải mã gốc hoặc thử kiểm tra lại file.';
        }
        break;
      default:
        code = 'ERR_UNKNOWN_PLAYBACK';
        summary = mediaMsg || 'Đã xảy ra lỗi không rõ nguyên nhân khi giải mã media.';
        suggestion = 'Sao chép thông tin chẩn đoán để kiểm tra nhật ký phiên phát.';
    }
  } else if (stage === 'queue-lookup') {
    code = explicitCode ?? 'ERR_FILE_MISSING';
    summary = explicitMessage?.trim() || 'Không tìm thấy bài hát trong danh sách thư viện hiện tại.';
    suggestion = 'Thử tải lại thư viện hoặc chọn một bài hát khác.';
  } else if (stage === 'dsp-init') {
    code = 'ERR_AUDIO_OUTPUT_INIT';
    summary = 'Không thể khởi tạo đường dẫn xử lý âm thanh Web Audio.';
    suggestion = 'Kiểm tra thiết bị đầu ra âm thanh trên Windows đang hoạt động bình thường.';
  } else if (/NotSupportedError/i.test(thrownText)) {
    code = 'ERR_MEDIA_FORMAT_UNSUPPORTED';
    summary = `Trình phát không hỗ trợ định dạng hoặc luồng âm thanh này${formatHint ? ` (${formatHint})` : ''}.`;
    suggestion = 'Kiểm tra lại codec bên trong container của tệp nguồn.';
  } else if (/NotAllowedError/i.test(thrownText)) {
    code = 'ERR_AUDIO_OUTPUT_INIT';
    summary = 'Hệ thống âm thanh tạm thời chặn lệnh tự động phát.';
    suggestion = 'Nhấn nút Phát lại trực tiếp để bắt đầu luồng âm thanh.';
  } else if (explicitMessage) {
    summary = explicitMessage.trim();
  } else if (thrownText) {
    summary = `Không thể bắt đầu phát nhạc: ${thrownText}`;
  }

  const techParts: string[] = [
    `code=${code}`,
    `stage=${stage}`,
    `attempt=${attemptId}`,
  ];
  if (mediaError) {
    techParts.push(`mediaError.code=${mediaError.code}`);
    if (mediaMsg) {
      techParts.push(`mediaError.message=${mediaMsg}`);
    }
  }
  if (thrownText) {
    techParts.push(`exception=${thrownText}`);
  }
  if (explicitMessage && explicitMessage.trim() !== summary) {
    techParts.push(`reason=${explicitMessage.trim()}`);
  }
  if (track) {
    techParts.push(`trackId=${track.id}`);
    techParts.push(`format=${formatHint || track.container || track.codec || 'unknown'}`);
  }

  return {
    code,
    stage,
    summary,
    suggestion,
    technicalDetail: techParts.join(' | '),
    mediaErrorCode: mediaError?.code ?? null,
    attemptId,
    timestamp,
    trackId: track?.id ?? null,
    trackTitle: track?.title ?? null,
    codec: classified?.displayCodec ?? track?.codec ?? null,
    container: classified?.containerLabel ?? track?.container ?? null,
    isMissingFile: missingFlag,
  };
}

export function formatPlaybackDiagnosticReport(
  err: PlaybackErrorDetails | null,
  recentLogs: readonly DiagnosticLogEntry[] = [],
): string {
  const lines: string[] = ['=== DoReMi Playback Diagnostic Report ==='];
  if (err) {
    lines.push(`Timestamp : ${err.timestamp}`);
    lines.push(`Code      : ${err.code}`);
    lines.push(`Stage     : ${err.stage}`);
    lines.push(`Attempt   : ${err.attemptId}`);
    if (err.trackTitle || err.trackId) {
      lines.push(`Track     : ${err.trackTitle ?? '(unknown)'} [${err.trackId ?? 'no-id'}]`);
    }
    if (err.codec || err.container) {
      lines.push(`Format    : ${err.codec ?? '?'} / ${err.container ?? '?'}`);
    }
    lines.push(`Summary   : ${err.summary}`);
    lines.push(`Suggestion: ${err.suggestion}`);
    lines.push(`Technical : ${err.technicalDetail}`);
  }
  if (recentLogs.length > 0) {
    lines.push('', '--- Recent Session Events ---');
    for (const log of recentLogs.slice(-15)) {
      const meta = [log.code, log.stage, log.attemptId].filter(Boolean).join(',');
      lines.push(
        `[${log.timestamp}] [${log.level.toUpperCase()}] [${log.scope}${meta ? `:${meta}` : ''}] ${log.message}${log.detail ? ` :: ${log.detail}` : ''}`,
      );
    }
  }
  return lines.join('\n');
}
