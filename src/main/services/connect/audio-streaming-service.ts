import fs from 'node:fs';
import type http from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CONNECT_STREAM_HIGH_WATER_MARK } from '../../../shared/contracts/connect-api';
import { getMimeTypeForExtension } from '../../../shared/contracts/media-protocol';
import { parseByteRangeHeader } from '../audio-stream-handler';
import { extractFileExtension } from '../path-utils';
import type { ConnectTransportMode, HostStreamTraceEntry } from '../../../shared/types/connect';
import type { SharedFilesystemGuard } from './filesystem-guard';
import type { ResourceBudgetManager } from './resource-budget';

const MAX_HOST_STREAM_TRACES = 64;

/**
 * Original-file HTTP audio streaming handler (`GET` and `HEAD`) over authenticated LAN transport.
 * Guarantees:
 * - Zero transcoding, zero FFmpeg invocation, zero temp files, zero full-file RAM buffering.
 * - Strict `SharedFilesystemGuard` validation on every request (including HEAD & partial Range).
 * - Rejects multi-range headers (`bytes=0-10,20-30`) cleanly with 416 Range Not Satisfiable.
 * - Respects backpressure via bounded 64KB chunk streaming and releases file descriptors on cancel/abort/close.
 */
export class ConnectAudioStreamingService {
  private readonly fsGuard: SharedFilesystemGuard;
  private readonly budget: ResourceBudgetManager;
  private readonly recentTraces: HostStreamTraceEntry[] = [];

  constructor(options: {
    fsGuard: SharedFilesystemGuard;
    budget: ResourceBudgetManager;
  }) {
    this.fsGuard = options.fsGuard;
    this.budget = options.budget;
  }

  getRecentTraces(): HostStreamTraceEntry[] {
    return [...this.recentTraces];
  }

  clearTraces(): void {
    this.recentTraces.length = 0;
  }

  private recordTrace(entry: HostStreamTraceEntry): void {
    this.recentTraces.unshift(entry);
    if (this.recentTraces.length > MAX_HOST_STREAM_TRACES) {
      this.recentTraces.length = MAX_HOST_STREAM_TRACES;
    }
  }

  async handleStreamRequest(params: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    trackId: string;
    deviceId: string;
    deviceName: string;
    transport?: ConnectTransportMode;
  }): Promise<void> {
    const { req, res, trackId, deviceId, deviceName, transport } = params;
    const startedAtMs = Date.now();
    const method = (req.method || 'GET').toUpperCase();
    const rawRangeHeader = typeof req.headers.range === 'string' ? req.headers.range : null;
    const rawCorrelation = req.headers['x-doremi-correlation'];
    const correlationId =
      typeof rawCorrelation === 'string' && rawCorrelation.trim().length > 0
        ? rawCorrelation.trim().slice(0, 64)
        : null;
    const traceBase = {
      timestamp: new Date(startedAtMs).toISOString(),
      correlationId,
      deviceId,
      trackId,
      method,
      rangeHeader: rawRangeHeader,
    };

    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'METHOD_NOT_ALLOWED', message: 'Use GET or HEAD.' }));
      this.recordTrace({
        ...traceBase,
        statusCode: 405,
        errorCode: 'METHOD_NOT_ALLOWED',
        bytesSent: 0,
        durationMs: Date.now() - startedAtMs,
      });
      return;
    }

    const clientCheck = this.budget.canStartPlaybackStream(deviceId);
    if (!clientCheck.ok) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'CLIENT_LIMIT_REACHED', message: clientCheck.reason }));
      this.recordTrace({
        ...traceBase,
        statusCode: 429,
        errorCode: 'CLIENT_LIMIT_REACHED',
        bytesSent: 0,
        durationMs: Date.now() - startedAtMs,
      });
      return;
    }

    const resolved = await this.fsGuard.resolveAuthorizedAudioFile(trackId);
    if (!resolved.ok) {
      res.writeHead(resolved.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: resolved.code, message: resolved.message }));
      this.recordTrace({
        ...traceBase,
        statusCode: resolved.status,
        errorCode: resolved.code,
        bytesSent: 0,
        durationMs: Date.now() - startedAtMs,
      });
      return;
    }

    const { size: fileSize, handle, rootId, realPath } = resolved;
    const ext = extractFileExtension(realPath);
    const contentType = getMimeTypeForExtension(ext);
    const rangeHeader = rawRangeHeader;

    // Explicit single-range only: reject multi-range requests (comma-separated ranges) with 416
    if (rangeHeader && rangeHeader.includes(',')) {
      await handle.close().catch(() => {});
      res.writeHead(416, {
        'Content-Range': `bytes */${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/json',
      });
      res.end(
        JSON.stringify({
          code: 'MULTI_RANGE_UNSUPPORTED',
          message: 'Multi-part byte ranges are not supported; issue a single byte range.',
        }),
      );
      this.recordTrace({
        ...traceBase,
        statusCode: 416,
        errorCode: 'MULTI_RANGE_UNSUPPORTED',
        bytesSent: 0,
        durationMs: Date.now() - startedAtMs,
      });
      return;
    }

    const rangeResult = parseByteRangeHeader(rangeHeader, fileSize);
    if (!rangeResult.ok) {
      await handle.close().catch(() => {});
      res.writeHead(416, {
        'Content-Range': `bytes */${fileSize}`,
        'Accept-Ranges': 'bytes',
      });
      res.end();
      this.recordTrace({
        ...traceBase,
        statusCode: 416,
        errorCode: 'INVALID_RANGE',
        bytesSent: 0,
        durationMs: Date.now() - startedAtMs,
      });
      return;
    }

    const { start, end, isPartial } = rangeResult;
    const contentLength = end - start + 1;

    const roundedMtimeMs = Math.round(resolved.mtimeMs);
    const sourceRev = `${fileSize}:${roundedMtimeMs}`;
    const responseHeaders: Record<string, string> = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(contentLength),
      'Cache-Control': 'no-store',
      'ETag': `"doremi-${resolved.track.id}-${fileSize}-${roundedMtimeMs}"`,
      'X-DoReMi-Source-Revision': sourceRev,
      'X-DoReMi-Transfer-Mode': 'direct-original',
    };
    if (correlationId) {
      responseHeaders['X-DoReMi-Correlation'] = correlationId;
    }
    if (isPartial) {
      responseHeaders['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;
    }

    if (method === 'HEAD') {
      await handle.close().catch(() => {});
      res.writeHead(isPartial ? 206 : 200, responseHeaders);
      res.end();
      this.recordTrace({
        ...traceBase,
        statusCode: isPartial ? 206 : 200,
        errorCode: null,
        bytesSent: 0,
        durationMs: Date.now() - startedAtMs,
      });
      return;
    }

    const session = this.budget.registerStreamSession({
      deviceId,
      deviceName,
      trackId: resolved.track.id,
      rootId,
      isPartial,
      transport: transport ?? 'lan-direct',
    });

    const readStream = fs.createReadStream(realPath, {
      fd: handle.fd,
      autoClose: false,
      start,
      end,
      highWaterMark: CONNECT_STREAM_HIGH_WATER_MARK,
    });

    let bytesSentInStream = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        session.recordBytesRead(chunk.length);
        session.recordBytesSent(chunk.length);
        bytesSentInStream += chunk.length;
        callback(null, chunk);
      },
    });

    const cleanup = () => {
      readStream.destroy();
      meter.destroy();
      void handle.close().catch(() => {});
      session.finish();
    };

    const onAbort = () => {
      cleanup();
      if (!res.destroyed) {
        res.destroy();
      }
    };

    session.signal.addEventListener('abort', onAbort, { once: true });
    req.once('close', cleanup);
    res.once('close', cleanup);

    const statusCode = isPartial ? 206 : 200;
    res.writeHead(statusCode, responseHeaders);

    let streamErrorCode: string | null = null;
    try {
      await pipeline(readStream, meter, res);
    } catch (err) {
      streamErrorCode = session.signal.aborted ? 'SESSION_ABORTED' : 'CLIENT_DISCONNECTED';
      void err;
    } finally {
      session.signal.removeEventListener('abort', onAbort);
      req.removeListener('close', cleanup);
      res.removeListener('close', cleanup);
      cleanup();
      this.recordTrace({
        ...traceBase,
        statusCode,
        errorCode: streamErrorCode,
        bytesSent: bytesSentInStream,
        durationMs: Date.now() - startedAtMs,
      });
    }
  }
}
