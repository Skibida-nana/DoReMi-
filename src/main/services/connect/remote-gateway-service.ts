import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { CONNECT_API_PREFIX } from '../../../shared/contracts/connect-api';
import {
  CONNECT_REMOTE_DEFAULT_MOUNT_PATH,
  normalizeRemoteMountPath,
} from '../../../shared/contracts/connect-remote';
import { isLoopbackIp } from './network-interfaces';

const MAX_GATEWAY_SOCKETS = 32;
const MAX_URL_LENGTH = 1024;
const ENCODED_BYPASS_RE = /%(?:2e|2f|5c|00)/i;

export interface RemoteGatewayRequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  subPath: string;
  url: URL;
}

/**
 * Dedicated minimal Loopback HTTP Gateway (`127.0.0.1` ONLY) for Phase 6.3 Remote HTTPS providers.
 * - Never binds to `0.0.0.0` or LAN adapters.
 * - Inactive (`null` listener) whenever Remote Access is disabled.
 * - Enforces path canonicalization & an explicit route/method allowlist BEFORE forwarding to shared Server Core.
 * - Blocks public enrollment, admin, provisioning, and diagnostic routes unconditionally.
 * - Never trusts `X-Forwarded-For` or `Tailscale-User-*` headers for authorization.
 */
export class RemoteGatewayService {
  private server: http.Server | null = null;
  private listeningPort: number | null = null;
  private mountPath: string = CONNECT_REMOTE_DEFAULT_MOUNT_PATH;
  private readonly activeSockets = new Set<Socket>();

  // Separate bounded rate-limit window for unauthenticated Internet traffic so public probes
  // cannot exhaust legitimate authenticated streaming capacity.
  private unauthWindowStartMs = 0;
  private unauthRequestCount = 0;
  private challengeWindowStartMs = 0;
  private challengeRequestCount = 0;

  isRunning(): boolean {
    return Boolean(this.server && this.listeningPort !== null);
  }

  getListeningPort(): number | null {
    return this.listeningPort;
  }

  getMountPath(): string {
    return this.mountPath;
  }

  async start(options: {
    port?: number;
    mountPath?: string;
    onAllowlistedRequest: (ctx: RemoteGatewayRequestContext) => Promise<void>;
  }): Promise<{ port: number; mountPath: string }> {
    await this.stop();

    const normalizedMount =
      normalizeRemoteMountPath(options.mountPath ?? CONNECT_REMOTE_DEFAULT_MOUNT_PATH) ??
      CONNECT_REMOTE_DEFAULT_MOUNT_PATH;
    this.mountPath = normalizedMount;

    const server = http.createServer((req, res) => {
      void this.dispatch(req, res, options.onAllowlistedRequest).catch(() => {
        if (!res.headersSent) {
          this.sendJson(res, 500, {
            code: 'INTERNAL_ERROR',
            message: 'Unexpected Remote Gateway error.',
          });
        } else if (!res.destroyed) {
          res.destroy();
        }
      });
    });

    server.headersTimeout = 10_000;
    server.requestTimeout = 0; // Enforced per-route: 12s on non-stream routes, bounded session sweep on /stream/
    server.keepAliveTimeout = 8_000;
    server.maxHeadersCount = 32;

    server.on('connection', (socket: Socket) => {
      if (!isLoopbackIp(socket.remoteAddress) || this.activeSockets.size >= MAX_GATEWAY_SOCKETS) {
        socket.destroy();
        return;
      }
      socket.setKeepAlive(true, 15_000);
      this.activeSockets.add(socket);
      socket.once('close', () => {
        this.activeSockets.delete(socket);
      });
    });

    const targetPort = options.port ?? 0;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // Strictly bind ONLY to IPv4 loopback 127.0.0.1
      server.listen(targetPort, '127.0.0.1');
    });

    const addr = server.address() as AddressInfo | null;
    if (!addr || typeof addr.port !== 'number') {
      server.close();
      throw new Error('Failed to bind Remote Gateway loopback port.');
    }

    this.server = server;
    this.listeningPort = addr.port;
    return {
      port: addr.port,
      mountPath: this.mountPath,
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listeningPort = null;

    if (!server) {
      return;
    }

    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch {
        // Ignore socket destroy error
      }
    }
    this.activeSockets.clear();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private checkUnauthenticatedBudget(kind: 'general' | 'challenge'): boolean {
    const now = Date.now();
    if (kind === 'challenge') {
      if (now - this.challengeWindowStartMs > 10_000) {
        this.challengeWindowStartMs = now;
        this.challengeRequestCount = 1;
        return true;
      }
      this.challengeRequestCount += 1;
      return this.challengeRequestCount <= 20;
    }
    if (now - this.unauthWindowStartMs > 10_000) {
      this.unauthWindowStartMs = now;
      this.unauthRequestCount = 1;
      return true;
    }
    this.unauthRequestCount += 1;
    return this.unauthRequestCount <= 40;
  }

  private sendJson(res: http.ServerResponse, status: number, payload: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }

  private async dispatch(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    onAllowlistedRequest: (ctx: RemoteGatewayRequestContext) => Promise<void>,
  ): Promise<void> {
    // Verify loopback socket origin on every request
    if (!isLoopbackIp(req.socket.remoteAddress)) {
      req.socket.destroy();
      return;
    }

    // Strip / neutralize spoofable proxy identity headers so downstream code can never rely on them
    delete req.headers['x-forwarded-for'];
    delete req.headers['x-real-ip'];
    delete req.headers['tailscale-user-login'];
    delete req.headers['tailscale-user-name'];
    delete req.headers['tailscale-user-profile-pic'];
    delete req.headers['tailscale-headers-info'];

    const rawUrl = req.url || '';
    if (!rawUrl || rawUrl.length > MAX_URL_LENGTH || ENCODED_BYPASS_RE.test(rawUrl) || rawUrl.includes('\\')) {
      this.sendJson(res, 400, {
        code: 'INVALID_URL',
        message: 'Rejected malformed or encoded-traversal Remote request URL.',
      });
      return;
    }

    let url: URL;
    try {
      url = new URL(rawUrl, 'http://127.0.0.1');
    } catch {
      this.sendJson(res, 400, { code: 'INVALID_URL', message: 'Malformed request URL.' });
      return;
    }

    const pathname = url.pathname;
    if (pathname.includes('..') || pathname.includes('//')) {
      this.sendJson(res, 400, { code: 'INVALID_URL', message: 'Path normalization rejected.' });
      return;
    }

    const expectedPrefix = `${this.mountPath}${CONNECT_API_PREFIX}`;
    if (!pathname.startsWith(expectedPrefix)) {
      this.sendJson(res, 404, { code: 'NOT_FOUND', message: 'Endpoint not found.' });
      return;
    }

    const subPath = pathname.slice(expectedPrefix.length) || '/';
    const method = (req.method || 'GET').toUpperCase();

    // Explicitly block enrollment, provisioning, admin, and diagnostic endpoints on Remote Gateway
    if (
      subPath.startsWith('/enrollment') ||
      subPath.startsWith('/remote/provision') ||
      subPath.startsWith('/admin') ||
      subPath.startsWith('/diagnostics') ||
      subPath === '/auth/rotate-token'
    ) {
      this.sendJson(res, 403, {
        code: 'PUBLIC_ROUTE_FORBIDDEN',
        message: 'Enrollment and administrative routes are disabled on Remote HTTPS.',
      });
      return;
    }

    // Strict allowlist of routes & HTTP methods
    const isCapabilities = subPath === '/capabilities';
    const isVerifyHost = subPath === '/remote/verify-host';
    const isDisconnect = subPath === '/auth/disconnect';
    const isRotateRemoteToken = subPath === '/auth/rotate-remote-token';
    const isSummary = subPath === '/library/summary';
    const isTracksList = subPath === '/library/tracks';
    const isAlbumsList = subPath === '/library/albums';
    const isArtistsList = subPath === '/library/artists';
    const isTrackSubroute = subPath.startsWith('/library/tracks/');
    const isStreamRoute = subPath.startsWith('/stream/');

    if (
      !isCapabilities &&
      !isVerifyHost &&
      !isDisconnect &&
      !isRotateRemoteToken &&
      !isSummary &&
      !isTracksList &&
      !isAlbumsList &&
      !isArtistsList &&
      !isTrackSubroute &&
      !isStreamRoute
    ) {
      this.sendJson(res, 404, { code: 'NOT_FOUND', message: 'Remote endpoint is not allowlisted.' });
      return;
    }

    // Method check per allowlisted route
    if (isVerifyHost || isDisconnect || isRotateRemoteToken) {
      if (method !== 'POST') {
        this.sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' });
        return;
      }
    } else if (isStreamRoute) {
      if (method !== 'GET' && method !== 'HEAD') {
        this.sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or HEAD.' });
        return;
      }
    } else if (method !== 'GET') {
      this.sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' });
      return;
    }

    // Unauthenticated route rate limits
    if (isCapabilities) {
      if (!this.checkUnauthenticatedBudget('general')) {
        this.sendJson(res, 429, {
          code: 'RATE_LIMITED',
          message: 'Too many unauthenticated Remote requests.',
        });
        return;
      }
    } else if (isVerifyHost) {
      if (!this.checkUnauthenticatedBudget('challenge')) {
        this.sendJson(res, 429, {
          code: 'RATE_LIMITED',
          message: 'Too many Host identity challenge requests.',
        });
        return;
      }
    }

    if (isStreamRoute) {
      req.setTimeout(0);
    } else {
      req.setTimeout(12_000, () => {
        if (!res.headersSent && !res.writableEnded) {
          this.sendJson(res, 408, { code: 'REQUEST_TIMEOUT', message: 'Remote request timed out.' });
        }
        req.destroy();
      });
    }

    await onAllowlistedRequest({ req, res, subPath, url });
  }
}
