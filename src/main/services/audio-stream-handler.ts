import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { Readable } from 'node:stream';
import {
  getMimeTypeForExtension,
  parseTrackIdFromMediaUrl,
} from '../../shared/contracts/media-protocol';
import type { TrackRepository } from '../database/track-repository';
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
}

/**
 * Pure request handler for `lossless-media://track/<uuid>`.
 * Security guarantees:
 * - Strictly requires a valid UUID via parseTrackIdFromMediaUrl (rejects path traversal / arbitrary paths).
 * - Resolves file paths exclusively from SQLite `tracks` records.
 * - Supports HTTP 206 Partial Content byte-range streaming for smooth seeking on large FLAC/WAV files.
 * - Never transcodes or modifies source audio files.
 */
export async function resolveTrackMediaResponse(
  request: Request,
  deps: AudioProtocolDeps,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const trackId = parseTrackIdFromMediaUrl(request.url);
  if (!trackId) {
    return new Response('Forbidden: Invalid media track identifier.', { status: 403 });
  }

  const track = deps.trackRepo.findById(trackId);
  if (!track) {
    return new Response('Not Found: Track is not registered in library.', { status: 404 });
  }

  let fileStat;
  try {
    fileStat = await fsPromises.stat(track.original_path);
  } catch {
    if (track.status !== 'missing') {
      deps.trackRepo.updateStatus(track.id, 'missing');
      deps.onTrackMissing?.(track.id);
    }
    return new Response('Not Found: Source audio file is missing.', { status: 404 });
  }

  if (!fileStat.isFile()) {
    return new Response('Forbidden: Registered track path is not a regular file.', {
      status: 403,
    });
  }

  const fileSize = fileStat.size;
  const contentType = getMimeTypeForExtension(extractFileExtension(track.original_path));
  const rangeResult = parseByteRangeHeader(request.headers.get('range'), fileSize);

  if (!rangeResult.ok) {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: {
        'Content-Range': `bytes */${fileSize}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }

  const { start, end, isPartial } = rangeResult;
  const contentLength = end - start + 1;

  const headers = new Headers({
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
