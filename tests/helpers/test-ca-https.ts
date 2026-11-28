import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import type net from 'node:net';

function encodeDerLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let rem = len;
  while (rem > 0) {
    bytes.unshift(rem & 0xff);
    rem >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTag(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeDerLength(content.length), content]);
}

function derSequence(items: readonly Buffer[]): Buffer {
  return derTag(0x30, Buffer.concat(items));
}

function derSet(items: readonly Buffer[]): Buffer {
  return derTag(0x31, Buffer.concat(items));
}

function derInteger(bytes: Buffer): Buffer {
  let buf = bytes;
  while (buf.length > 1 && buf[0] === 0 && (buf[1] & 0x80) === 0) {
    buf = buf.subarray(1);
  }
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
  return derTag(0x02, buf);
}

function derOid(oidParts: readonly number[]): Buffer {
  const encoded: number[] = [oidParts[0] * 40 + oidParts[1]];
  for (let i = 2; i < oidParts.length; i += 1) {
    let val = oidParts[i];
    if (val < 0x80) {
      encoded.push(val);
    } else {
      const sub: number[] = [];
      sub.unshift(val & 0x7f);
      val >>= 7;
      while (val > 0) {
        sub.unshift((val & 0x7f) | 0x80);
        val >>= 7;
      }
      encoded.push(...sub);
    }
  }
  return derTag(0x06, Buffer.from(encoded));
}

function derOctetString(bytes: Buffer): Buffer {
  return derTag(0x04, bytes);
}

function derBitString(bytes: Buffer, unusedBits = 0): Buffer {
  return derTag(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes]));
}

function derGeneralizedTime(date: Date): Buffer {
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return derTag(0x18, Buffer.from(`${yyyy}${mm}${dd}${hh}${mi}${ss}Z`, 'ascii'));
}

function derExplicit(index: number, inner: Buffer): Buffer {
  return derTag(0xa0 | index, inner);
}

function buildCn(cn: string): Buffer {
  return derSequence([derSet([derSequence([derOid([2, 5, 4, 3]), derTag(0x0c, Buffer.from(cn, 'utf8'))])])]);
}

function toPem(label: string, der: Buffer): string {
  const b64 = der.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export interface TestCaBundle {
  caCertPem: string;
  caKeyPem: string;
  issueLeafCert(options: { dnsNames: string[]; notBeforeOffsetMs?: number; notAfterOffsetMs?: number }): {
    certPem: string;
    keyPem: string;
  };
}

/**
 * Generates an isolated in-memory ECDSA P-256 Test Root CA and CA-signed leaf certificates
 * so automated tests exercise real `rejectUnauthorized: true` + `checkServerIdentity` HTTPS validation.
 */
export function createIsolatedTestCa(): TestCaBundle {
  const caKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const caSpki = caKeys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const caKeyPem = caKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const sigAlg = derSequence([derOid([1, 2, 840, 10045, 4, 3, 2])]);
  const caSubject = buildCn('DoReMi Test Funnel Root CA');
  const now = Date.now();

  const caSerial = crypto.randomBytes(12);
  caSerial[0] = (caSerial[0] & 0x7f) || 1;

  // BasicConstraints: cA=TRUE (0x01 0xff)
  const caBcExt = derSequence([
    derOid([2, 5, 29, 19]),
    derTag(0x01, Buffer.from([0xff])),
    derOctetString(derSequence([derTag(0x01, Buffer.from([0xff]))])),
  ]);
  // KeyUsage: keyCertSign (bit 5) + cRLSign (bit 6) -> 0x06 with 1 unused bit
  const caKuExt = derSequence([
    derOid([2, 5, 29, 15]),
    derTag(0x01, Buffer.from([0xff])),
    derOctetString(derBitString(Buffer.from([0x06]), 1)),
  ]);

  const caTbs = derSequence([
    derExplicit(0, derInteger(Buffer.from([0x02]))),
    derInteger(caSerial),
    sigAlg,
    caSubject,
    derSequence([derGeneralizedTime(new Date(now - 60_000)), derGeneralizedTime(new Date(now + 365 * 86_400_000))]),
    caSubject,
    caSpki,
    derExplicit(3, derSequence([caBcExt, caKuExt])),
  ]);
  const caSig = crypto.sign('sha256', caTbs, caKeys.privateKey);
  const caCertPem = toPem('CERTIFICATE', derSequence([caTbs, sigAlg, derBitString(caSig, 0)]));

  return {
    caCertPem,
    caKeyPem,
    issueLeafCert({ dnsNames, notBeforeOffsetMs = -60_000, notAfterOffsetMs = 30 * 86_400_000 }) {
      const leafKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const leafSpki = leafKeys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
      const keyPem = leafKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
      const leafSerial = crypto.randomBytes(12);
      leafSerial[0] = (leafSerial[0] & 0x7f) || 2;
      const primaryCn = dnsNames[0] || 'doremi-host.tail1234.ts.net';

      const leafBcExt = derSequence([
        derOid([2, 5, 29, 19]),
        derTag(0x01, Buffer.from([0xff])),
        derOctetString(derSequence([])),
      ]);
      const leafKuExt = derSequence([
        derOid([2, 5, 29, 15]),
        derTag(0x01, Buffer.from([0xff])),
        derOctetString(derBitString(Buffer.from([0xa0]), 5)),
      ]);
      const leafEkuExt = derSequence([
        derOid([2, 5, 29, 37]),
        derOctetString(derSequence([derOid([1, 3, 6, 1, 5, 5, 7, 3, 1])])),
      ]);
      const leafSanExt = derSequence([
        derOid([2, 5, 29, 17]),
        derOctetString(derSequence(dnsNames.map((d) => derTag(0x82, Buffer.from(d, 'ascii'))))),
      ]);

      const tbs = derSequence([
        derExplicit(0, derInteger(Buffer.from([0x02]))),
        derInteger(leafSerial),
        sigAlg,
        caSubject,
        derSequence([
          derGeneralizedTime(new Date(now + notBeforeOffsetMs)),
          derGeneralizedTime(new Date(now + notAfterOffsetMs)),
        ]),
        buildCn(primaryCn),
        leafSpki,
        derExplicit(3, derSequence([leafBcExt, leafKuExt, leafEkuExt, leafSanExt])),
      ]);
      const sig = crypto.sign('sha256', tbs, caKeys.privateKey);
      const certPem = toPem('CERTIFICATE', derSequence([tbs, sigAlg, derBitString(sig, 0)]));
      return { certPem, keyPem };
    },
  };
}

export function createLoopbackLookup(expectedHostname: string): net.LookupFunction {
  const cleanExpected = expectedHostname.toLowerCase();
  return (hostname, options, cb) => {
    const opts = typeof options === 'function' ? undefined : options;
    const callback = typeof options === 'function' ? options : cb;
    if (hostname.toLowerCase() === cleanExpected) {
      if (opts && (opts as { all?: boolean }).all) {
        (callback as (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void)(
          null,
          [{ address: '127.0.0.1', family: 4 }],
        );
      } else {
        (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
          null,
          '127.0.0.1',
          4,
        );
      }
      return;
    }
    const err = Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(err, '', 4);
  };
}

/**
 * Simulates Tailscale Funnel edge TLS termination proxying ONLY a configured mount path
 * to `http://127.0.0.1:<localGatewayPort>`.
 */
export async function startSimulatedFunnelTlsProxy(options: {
  certPem: string;
  keyPem: string;
  mountPath: string;
  localGatewayPort: number;
}): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const server = https.createServer(
    {
      cert: options.certPem,
      key: options.keyPem,
      minVersion: 'TLSv1.2',
    },
    (req, res) => {
      const urlPath = req.url || '/';
      if (!urlPath.startsWith(options.mountPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'Not mounted on Funnel.' }));
        return;
      }

      const fwdHeaders = { ...req.headers };
      delete fwdHeaders.host;
      // Edge reverse proxy forwards path unchanged just like Tailscale `funnel --set-path`
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port: options.localGatewayPort,
          path: urlPath,
          method: req.method,
          headers: fwdHeaders,
          agent: false,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 'BAD_GATEWAY', message: 'Remote Gateway unreachable.' }));
        }
      });
      req.pipe(upstream);
    },
  );

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
