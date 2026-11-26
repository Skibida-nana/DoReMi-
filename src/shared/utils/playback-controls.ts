import type { PlaybackControlState, RepeatMode } from '../types/player';

export const DEFAULT_PLAYBACK_CONTROLS: PlaybackControlState = {
  shuffleEnabled: false,
  repeatMode: 'off',
  autoNextEnabled: true,
};

export const REPEAT_MODE_ORDER: readonly RepeatMode[] = [
  'off',
  'once',
  'twice',
  'one',
  'all',
];

export const REPEAT_MODE_LABELS: Record<RepeatMode, string> = {
  off: 'Tắt lặp',
  once: 'Lặp 1 lần',
  twice: 'Lặp 2 lần',
  one: 'Lặp vô hạn (1 bài)',
  all: 'Lặp toàn bộ danh sách',
};

const VALID_REPEAT_MODES = new Set<RepeatMode>(REPEAT_MODE_ORDER);

export function normalizeRepeatMode(value: unknown, fallback: RepeatMode = 'off'): RepeatMode {
  if (typeof value === 'string' && VALID_REPEAT_MODES.has(value as RepeatMode)) {
    return value as RepeatMode;
  }
  return fallback;
}

export function normalizePlaybackControls(
  raw: Partial<PlaybackControlState> | null | undefined,
  fallback: PlaybackControlState = DEFAULT_PLAYBACK_CONTROLS,
): PlaybackControlState {
  if (!raw || typeof raw !== 'object') {
    return { ...fallback };
  }
  return {
    shuffleEnabled:
      typeof raw.shuffleEnabled === 'boolean' ? raw.shuffleEnabled : fallback.shuffleEnabled,
    repeatMode: normalizeRepeatMode(raw.repeatMode, fallback.repeatMode),
    autoNextEnabled:
      typeof raw.autoNextEnabled === 'boolean' ? raw.autoNextEnabled : fallback.autoNextEnabled,
  };
}

/**
 * Returns the initial remaining automatic replay count when a queue entry starts playing:
 * - 'off': 0 extra replays (plays 1 time)
 * - 'once': 1 extra replay (plays 2 times total)
 * - 'twice': 2 extra replays (plays 3 times total)
 * - 'one': null (unlimited automatic replays for current track)
 * - 'all': 0 per-track replays (queue loops across the full list)
 */
export function getInitialRemainingReplays(repeatMode: RepeatMode): number | null {
  switch (repeatMode) {
    case 'once':
      return 1;
    case 'twice':
      return 2;
    case 'one':
      return null;
    case 'all':
    case 'off':
    default:
      return 0;
  }
}

export function nextRepeatMode(current: RepeatMode): RepeatMode {
  const idx = REPEAT_MODE_ORDER.indexOf(current);
  if (idx < 0) {
    return 'off';
  }
  return REPEAT_MODE_ORDER[(idx + 1) % REPEAT_MODE_ORDER.length];
}
