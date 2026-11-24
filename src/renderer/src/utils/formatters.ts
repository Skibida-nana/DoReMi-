import type { TrackRecord } from '../../../shared/types/track';
import { classifyTrackAudioCodec } from '../../../shared/utils/audio-codec';

export function formatDurationSeconds(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return '--:--';
  }
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;

  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(secs)}`;
  }
  return `${minutes}:${pad(secs)}`;
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    return '--:--';
  }
  return formatDurationSeconds(ms / 1000);
}

/**
 * Formats audio format technical info honestly using only non-null fields from SQLite.
 * Explicitly distinguishes ALAC (Lossless) vs AAC (Lossy) for M4A files and never fabricates specs.
 */
export function formatTrackAudioSpecs(track: TrackRecord): string {
  const parts: string[] = [];
  const classified = classifyTrackAudioCodec(track);

  if (classified.isM4aContainer) {
    if (classified.family === 'alac') {
      parts.push('ALAC (Lossless)');
    } else if (classified.family === 'aac') {
      parts.push('AAC (Lossy)');
    } else {
      parts.push(classified.displayCodec.toUpperCase());
    }
  } else {
    const formatLabel = track.container ?? track.codec;
    if (formatLabel) {
      parts.push(formatLabel.toUpperCase());
    }
  }

  const showBitDepth = classified.qualityTier !== 'lossy' && Boolean(track.bit_depth);
  if (showBitDepth && track.bit_depth && track.sample_rate_hz) {
    const khz = Number((track.sample_rate_hz / 1000).toFixed(1));
    parts.push(`${track.bit_depth}-bit / ${khz} kHz`);
  } else if (track.sample_rate_hz) {
    const khz = Number((track.sample_rate_hz / 1000).toFixed(1));
    parts.push(`${khz} kHz`);
  } else if (showBitDepth && track.bit_depth) {
    parts.push(`${track.bit_depth}-bit`);
  }

  if (track.bitrate_bps) {
    const kbps = Math.round(track.bitrate_bps / 1000);
    if (kbps > 0) {
      parts.push(`${kbps} kbps`);
    }
  }

  return parts.length > 0 ? parts.join(' · ') : '—';
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatPlaybackStatusLabel(status: string): string {
  switch (status) {
    case 'idle':
      return 'Chờ phát';
    case 'loading':
      return 'Đang tải...';
    case 'playing':
      return 'Đang phát';
    case 'paused':
      return 'Tạm dừng';
    case 'ended':
      return 'Đã phát xong';
    case 'error':
      return 'Lỗi phát nhạc';
    default:
      return status;
  }
}
