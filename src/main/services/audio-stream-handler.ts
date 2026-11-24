import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { Readable } from 'node:stream';
import {
  getMimeTypeForExtension,
  parseTrackIdFromMediaUrl,
} from '../../shared/contracts/media-protocol';
import { isAlacTrackMetadata } from '../../shared/utils/audio-codec';
import type { TrackRepository } from '../database/track-repository';
import {
  detectMp4AudioCodec,
  getAlacStreamManager,
  type AlacStreamManager,
} from './alac-decoder';
import { extractFileExtension } from './path-utils';

export type ByteRangeParseResult =
  | {
      ok: true;
      isPartial: boolean;
      start: number;
      end: number;
    }
  | {
      ok: false;
      status: 416;
    };

/**
 * Parses an HTTP Range header (`bytes=start-end`, `bytes=start-`, or `bytes=-suffix`)
 * for large FLAC/WAV seeking support.
 */
export function parseByteRangeHeader(
  rangeHeader: string | null,
  fileSize: number,
): ByteRangeParseResult {
  if (fileSize <= 0) {
    return { ok: false, status: 416 };
  }

  if (!rangeHeader) {
    return {
      ok: true,
      isPartial: false,
      start: 0,
      end: fileSize - 1,
    };
  }

  const trimmed = rangeHeader.trim();
  const match = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
  if (!match) {
    return { ok: false, status: 416 };
  }

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') {
    return { ok: false, status: 416 };
  }

  let start: number;
  let end: number;

  if (rawStart === '') {
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return { ok: false, status: 416 };
    }
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? fileSize - 1 : Number(rawEnd);

    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return { ok: false, status: 416 };
    }

    if (start < 0 || start >= fileSize) {
      return { ok: false, status: 416 };
    }

    if (end >= fileSize) {
      end = fileSize - 1;
    }

    if (end < start) {
      return { ok: false, status: 416 };
    }
  }

  return {
    ok: true,
    isPartial: true,
    start,
    end,
  };
}

export interface AudioProtocolDeps {
  trackRepo: Pick<TrackRepository, 'findById' | 'updateStatus'>;
  onTrackMissing?: (trackId: string) => void;
  alacManager?: AlacStreamManager;
}

/**
 * Validates that any CORS Origin header originates exclusively from this local Electron app
 * (`null` for packaged `file://`, `http://localhost:*` / `http://127.0.0.1:*` for dev, or `lossless-media://`).
 * Rejects arbitrary remote web origins while allowing `HTMLAudioElement.crossOrigin = "anonymous"`
 * to feed Web Audio `MediaElementAudioSourceNode` without CORS silencing.
 */
export function isAllowedMediaCorsOrigin(originHeader: string | null): boolean {
  if (originHeader === null || originHeader === '' || originHeader === 'null') {
    return true;
  }
  try {
    const parsed = new URL(originHeader);
    if (parsed.protocol === 'lossless-media:' || parsed.protocol === 'file:') {
      return true;
    }
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function buildMediaCorsHeaders(originHeader: string | null): Record<string, string> {
  // Packaged file:// sends Origin: "null"; anonymous CORS audio requires "*" or matching origin.
  const allowOrigin =
    originHeader && originHeader !== 'null' && isAllowedMediaCorsOrigin(originHeader)
      ? originHeader
      : '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, Content-Type',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    Vary: 'Origin',
  };
}

/**
 * Pure request handler for `lossless-media://track/<uuid>`.
 * Security guarantees:
 * - Strictly requires a valid UUID via parseTrackIdFromMediaUrl (rejects path traversal / arbitrary paths).
 * - Resolves file paths exclusively from SQLite `tracks` records.
 * - Rejects non-local third-party CORS origins while enabling Web Audio API `MediaElementAudioSourceNode`.
 * - Supports HTTP 206 Partial Content byte-range streaming for smooth seeking on large FLAC/WAV files.
 * - Never transcodes or modifies source audio files.
 */
export async function resolveTrackMediaResponse(
  request: Request,
  deps: AudioProtocolDeps,
): Promise<Response> {
  const originHeader = request.headers.get('origin');
  if (!isAllowedMediaCorsOrigin(originHeader)) {
    return new Response('Forbidden: Disallowed CORS origin.', { status: 403 });
  }

  const corsHeaders = buildMediaCorsHeaders(originHeader);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
  }

  const trackId = parseTrackIdFromMediaUrl(request.url);
  if (!trackId) {
    return new Response('Forbidden: Invalid media track identifier.', {
      status: 403,
      headers: corsHeaders,
    });
  }

  const track = deps.trackRepo.findById(trackId);
  if (!track) {
    return new Response('Not Found: Track is not registered in library.', {
      status: 404,
      headers: corsHeaders,
    });
  }

  let fileStat;
  try {
    fileStat = await fsPromises.stat(track.original_path);
  } catch {
    if (track.status !== 'missing') {
      deps.trackRepo.updateStatus(track.id, 'missing');
      deps.onTrackMissing?.(track.id);
    }
    return new Response('Not Found: Source audio file is missing.', {
      status: 404,
      headers: corsHeaders,
    });
  }

  if (!fileStat.isFile()) {
    return new Response('Forbidden: Registered track path is not a regular file.', {
      status: 403,
      headers: corsHeaders,
    });
  }

  const ext = extractFileExtension(track.original_path);

  // Offline ALAC M4A support:
  // Electron/Chromium natively decodes AAC inside M4A (`audio/mp4`), but lacks a native ALAC decoder.
  // For ALAC tracks, stream lossless decoded PCM WAV on demand with full 206 byte-range seeking
  // directly into the single HTMLAudioElement -> AudioDspGraph pipeline (zero temp files, zero file mutation).
  let shouldDecodeAlac = isAlacTrackMetadata(track);
  if (!shouldDecodeAlac && (ext === '.m4a' || ext === '.mp4') && !track.codec) {
    const probed = await detectMp4AudioCodec(track.original_path);
    shouldDecodeAlac = probed.codec === 'alac';
  }

  if (shouldDecodeAlac) {
    const alacManager = deps.alacManager ?? getAlacStreamManager();
    const alacResponse = await alacManager.resolveAlacWavResponse(
      request,
      track.original_path,
      corsHeaders,
    );
    if (alacResponse) {
      return alacResponse;
    }
  }

  const fileSize = fileStat.size;
  const contentType = getMimeTypeForExtension(ext);
  const rangeResult = parseByteRangeHeader(request.headers.get('range'), fileSize);

  if (!rangeResult.ok) {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: {
        ...corsHeaders,
        'Content-Range': `bytes */${fileSize}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }

  const { start, end, isPartial } = rangeResult;
  const contentLength = end - start + 1;

  const headers = new Headers({
    ...corsHeaders,
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(contentLength),
    'Cache-Control': 'no-store',
  });

  if (isPartial) {
    headers.set('Content-Range', `bytes ${start}-${end}/${fileSize}`);
  }

  if (request.method === 'HEAD') {
    return new Response(null, {
      status: isPartial ? 206 : 200,
      headers,
    });
  }

  const nodeStream = fs.createReadStream(track.original_path, { start, end });
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

  return new Response(webStream, {
    status: isPartial ? 206 : 200,
    headers,
  });
}
