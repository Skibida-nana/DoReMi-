import http from 'node:http';
import https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import type { ConnectTransportMode } from '../../../shared/types/connect';
import { isEligibleLanSocketAddress, resolveBindHostForConfig } from './network-interfaces';

export type ConnectHttpRequestHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void> | void;

export interface TransportProvider {
  readonly mode: ConnectTransportMode;
  start(options: {
    bindAddress: string;
    port: number;
    certificatePem: string;
    privateKeyPem: string;
    requestHandler: ConnectHttpRequestHandler;
  }): Promise<{ port: number; listenAddresses: string[] }>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getListeningPort(): number | null;
  getListenAddresses(): string[];
}

/**
 * TLS-encrypted LAN Direct HTTPS transport provider.
 * - Enforces TLS 1.2+ with the Host's cryptographic certificate.
 * - Rejects non-private/public remote and local socket addresses at connection time.
 * - Tracks all open TCP/TLS sockets so `stop()` destroys them cleanly without hanging.
 */
export class LanDirectProvider implements TransportProvider {
  readonly mode: ConnectTransportMode = 'lan-direct';
  private server: https.Server | null = null;
  private activeSockets = new Set<Socket>();
  private listeningPort: number | null = null;
  private listenAddresses: string[] = [];

  isRunning(): boolean {
    return Boolean(this.server && this.server.listening);
  }

  getListeningPort(): number | null {
    return this.listeningPort;
  }

  getListenAddresses(): string[] {
    return [...this.listenAddresses];
  }

  async start(options: {
    bindAddress: string;
    port: number;
    certificatePem: string;
    privateKeyPem: string;
    requestHandler: ConnectHttpRequestHandler;
  }): Promise<{ port: number; listenAddresses: string[] }> {
    if (this.server) {
      await this.stop();
    }

    const { listenHost, advertisedAddresses } = resolveBindHostForConfig(options.bindAddress);

    const server = https.createServer(
      {
        cert: options.certificatePem,
        key: options.privateKeyPem,
        minVersion: 'TLSv1.2',
      },
      (req, res) => {
        void Promise.resolve(options.requestHandler(req, res)).catch(() => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
          }
          if (!res.destroyed) {
            res.end(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Unexpected server error.' }));
          }
        });
      },
    );

    // Bounded HTTP timeouts against slow-loris / stalled requests
    server.headersTimeout = 15_000;
    server.requestTimeout = 0; // Individual non-stream endpoints enforce timeouts; audio streaming uses stream backpressure
    server.keepAliveTimeout = 10_000;
    server.maxHeadersCount = 48;

    server.on('connection', (socket: Socket) => {
      // Strictly reject connections from public/non-private interfaces or remote hosts
      const remoteOk = isEligibleLanSocketAddress(socket.remoteAddress);
      const localOk =
        !socket.localAddress || isEligibleLanSocketAddress(socket.localAddress);
      if (!remoteOk || !localOk) {
        socket.destroy();
        return;
      }

      socket.setKeepAlive(true, 15_000);
      this.activeSockets.add(socket);
      socket.once('close', () => {
        this.activeSockets.delete(socket);
      });
    });

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
      server.listen(options.port, listenHost);
    });

    const addr = server.address() as AddressInfo | null;
    this.server = server;
    this.listeningPort = addr?.port ?? options.port;
    this.listenAddresses = advertisedAddresses;

    return {
      port: this.listeningPort,
      listenAddresses: [...this.listenAddresses],
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listeningPort = null;
    this.listenAddresses = [];

    if (!server) {
      return;
    }

    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch {
        // Ignore socket destroy errors
      }
    }
    this.activeSockets.clear();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}
