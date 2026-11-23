import type {
  ComputedReplayGain,
  ReplayGainMode,
  ReplayGainSettings,
  TrackReplayGainMetadata,
} from '../types/stage6';

export const DEFAULT_REPLAYGAIN_SETTINGS: ReplayGainSettings = {
  mode: 'off',
  preventClipping: true,
};

/** Conservative safety ceiling for positive gain when a file lacks peak metadata (+6 dB ≈ 2.0x) */
export const MAX_SAFE_LINEAR_GAIN_WITHOUT_PEAK = 2.0;
/** Hard upper bound even with low-peak files (+12 dB ≈ 3.98x) to prevent uncontrolled distortion */
export const MAX_HARD_LINEAR_GAIN = 3.981;
/** Minimum floor (-24 dB ≈ 0.063x) so bad tags never silence audio completely */
export const MIN_LINEAR_GAIN = 0.063;

/**
 * Parses a ReplayGain dB tag string or numeric value (e.g. "-6.42 dB", "+2.10 dB", -4.5)
 * into a finite decibel number, or null if absent/invalid.
 */
export function parseReplayGainDb(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < -40 || raw > 40) {
      return null;
    }
    return Number(raw.toFixed(3));
  }
  if (raw && typeof raw === 'object' && 'dB' in raw) {
    return parseReplayGainDb((raw as { dB?: unknown }).dB);
  }
  if (typeof raw !== 'string') {
    return null;
  }
  const match = raw.trim().match(/^([+-]?\d+(?:\.\d+)?)\s*(?:db)?$/i);
  if (!match) {
    return null;
  }
  const parsed = Number.parseFloat(match[1]);
  if (!Number.isFinite(parsed) || parsed < -40 || parsed > 40) {
    return null;
  }
  return Number(parsed.toFixed(3));
}

/**
 * Parses a ReplayGain peak tag (linear sample peak, typically 0.0 < peak <= 2.0).
 */
export function parseReplayGainPeak(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0 || raw > 4) {
      return null;
    }
    return Number(raw.toFixed(6));
  }
  if (raw && typeof raw === 'object' && 'ratio' in raw) {
    return parseReplayGainPeak((raw as { ratio?: unknown }).ratio);
  }
  if (typeof raw !== 'string') {
    return null;
  }
  const parsed = Number.parseFloat(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 4) {
    return null;
  }
  return Number(parsed.toFixed(6));
}

/**
 * Extracts ReplayGain metadata from music-metadata `common` and `native` tag blocks
 * in read-only mode without inventing any synthetic values.
 */
export function extractReplayGainFromMetadata(metadata: {
  common?: {
    replaygain_track_gain?: unknown;
    replaygain_album_gain?: unknown;
    replaygain_track_peak?: unknown;
    replaygain_album_peak?: unknown;
  };
  native?: Record<string, Array<{ id: string; value: unknown }>>;
}): TrackReplayGainMetadata {
  let trackGainDb = parseReplayGainDb(metadata.common?.replaygain_track_gain);
  let albumGainDb = parseReplayGainDb(metadata.common?.replaygain_album_gain);
  let trackPeak = parseReplayGainPeak(metadata.common?.replaygain_track_peak);
  let albumPeak = parseReplayGainPeak(metadata.common?.replaygain_album_peak);

  if (metadata.native && (trackGainDb === null || albumGainDb === null || trackPeak === null || albumPeak === null)) {
    for (const tags of Object.values(metadata.native)) {
      if (!Array.isArray(tags)) {
        continue;
      }
      for (const tag of tags) {
        if (!tag || typeof tag.id !== 'string') {
          continue;
        }
        const upperId = tag.id.trim().toUpperCase();
        // Handle Vorbis/APE/MP4 freeform and ID3v2 TXXX descriptors
        let key = upperId;
        let value = tag.value;
        if (upperId === 'TXXX' && value && typeof value === 'object') {
          const txxx = value as { description?: unknown; text?: unknown };
          if (typeof txxx.description === 'string') {
            key = txxx.description.trim().toUpperCase();
            value = txxx.text;
          }
        } else if (upperId.startsWith('TXXX:')) {
          key = upperId.slice(5).trim();
        } else if (upperId.includes(':REPLAYGAIN_')) {
          key = upperId.slice(upperId.indexOf('REPLAYGAIN_'));
        }

        if (key === 'REPLAYGAIN_TRACK_GAIN' && trackGainDb === null) {
          trackGainDb = parseReplayGainDb(value);
        } else if (key === 'REPLAYGAIN_ALBUM_GAIN' && albumGainDb === null) {
          albumGainDb = parseReplayGainDb(value);
        } else if (key === 'REPLAYGAIN_TRACK_PEAK' && trackPeak === null) {
          trackPeak = parseReplayGainPeak(value);
        } else if (key === 'REPLAYGAIN_ALBUM_PEAK' && albumPeak === null) {
          albumPeak = parseReplayGainPeak(value);
        }
      }
    }
  }

  return {
    trackGainDb,
    albumGainDb,
    trackPeak,
    albumPeak,
  };
}

export function normalizeReplayGainSettings(
  raw: Partial<ReplayGainSettings> | null | undefined,
): ReplayGainSettings {
  const mode: ReplayGainMode =
    raw?.mode === 'track' || raw?.mode === 'album' || raw?.mode === 'off'
      ? raw.mode
      : 'off';
  return {
    mode,
    preventClipping:
      typeof raw?.preventClipping === 'boolean' ? raw.preventClipping : true,
  };
}

/**
 * Computes the safe linear playback gain multiplier from ReplayGain settings & track metadata.
 *
 * Rules:
 * - When mode === 'off': always neutral (1.0, applied: false).
 * - When mode === 'album': prefers album gain/peak, falls back to track gain/peak if album tag is absent.
 * - When mode === 'track': uses track gain/peak (does not invent values when absent).
 * - If no matching gain tag exists: returns neutral 1.0 (`applied: false`).
 * - Clipping prevention: when `preventClipping` is true and peak metadata exists,
 *   caps `linearGain <= 1.0 / peak` (with tiny -0.1dB safety headroom 0.9885) so output
 *   peaks cannot clip digital full-scale (0 dBFS).
 * - When positive gain has NO peak tag, caps conservatively at `1.0` when `preventClipping`
 *   is enabled so positive boosts without peak knowledge cannot clip unknown loud masters.
 */
export function computeReplayGainMultiplier(
  settings: ReplayGainSettings,
  meta: TrackReplayGainMetadata | null | undefined,
): ComputedReplayGain {
  if (settings.mode === 'off' || !meta) {
    return {
      applied: false,
      source: 'none',
      gainDb: 0,
      peak: null,
      linearGain: 1,
      clippedPrevented: false,
    };
  }

  let source: 'track' | 'album' | 'none' = 'none';
  let gainDb: number | null = null;
  let peak: number | null = null;

  if (settings.mode === 'album') {
    if (meta.albumGainDb !== null) {
      source = 'album';
      gainDb = meta.albumGainDb;
      peak = meta.albumPeak ?? meta.trackPeak;
    } else if (meta.trackGainDb !== null) {
      source = 'track';
      gainDb = meta.trackGainDb;
      peak = meta.trackPeak;
    }
  } else if (settings.mode === 'track') {
    if (meta.trackGainDb !== null) {
      source = 'track';
      gainDb = meta.trackGainDb;
      peak = meta.trackPeak;
    }
  }

  if (source === 'none' || gainDb === null) {
    return {
      applied: false,
      source: 'none',
      gainDb: 0,
      peak: null,
      linearGain: 1,
      clippedPrevented: false,
    };
  }

  let linear = Math.pow(10, gainDb / 20);
  let clippedPrevented = false;

  if (settings.preventClipping) {
    if (peak !== null && peak > 0) {
      // Keep digital full-scale peak safely below 0 dBFS (~ -0.1 dB margin)
      const maxNoClip = 0.9885 / peak;
      if (linear > maxNoClip) {
        linear = maxNoClip;
        clippedPrevented = true;
      }
    } else if (linear > 1.0) {
      // Unknown peak with positive gain: prevent blind clipping by capping at unity
      linear = 1.0;
      clippedPrevented = true;
    }
  } else if (peak === null && linear > MAX_SAFE_LINEAR_GAIN_WITHOUT_PEAK) {
    linear = MAX_SAFE_LINEAR_GAIN_WITHOUT_PEAK;
    clippedPrevented = true;
  }

  linear = Math.min(MAX_HARD_LINEAR_GAIN, Math.max(MIN_LINEAR_GAIN, linear));

  return {
    applied: true,
    source,
    gainDb,
    peak,
    linearGain: Number(linear.toFixed(6)),
    clippedPrevented,
  };
}
