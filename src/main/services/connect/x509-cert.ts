import crypto from 'node:crypto';

function encodeDerLength(len: number): Buffer {
  if (len < 0x80) {
    return Buffer.from([len]);
  }
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
  if (buf[0] & 0x80) {
    buf = Buffer.concat([Buffer.from([0x00]), buf]);
  }
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

function derUtf8String(text: string): Buffer {
  return derTag(0x0c, Buffer.from(text, 'utf8'));
}

function derBitString(bytes: Buffer, unusedBits = 0): Buffer {
  return derTag(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes]));
}

function derOctetString(bytes: Buffer): Buffer {
  return derTag(0x04, bytes);
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

function buildName(commonName: string): Buffer {
  // OID 2.5.4.3 (CN)
  const attr = derSequence([derOid([2, 5, 4, 3]), derUtf8String(commonName)]);
  return derSequence([derSet([attr])]);
}

function toPem(label: string, der: Buffer): string {
  const b64 = der.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export interface GeneratedHostCertificate {
  privateKeyPem: string;
  certificatePem: string;
  spkiFingerprintSha256: string;
  shortFingerprint: string;
  hostId: string;
  createdAt: string;
}

/**
 * Formats a SHA-256 hex digest into colon-separated uppercase hex (`AA:BB:...`)
 * and extracts a 16-char human-verifiable out-of-band verification string (`XXXX-XXXX-XXXX-XXXX`).
 */
export function formatSha256Fingerprint(hex64: string): {
  fingerprintSha256: string;
  shortFingerprint: string;
} {
  const clean = hex64.replace(/[^0-9a-f]/gi, '').toUpperCase();
  const pairs: string[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    pairs.push(clean.slice(i, i + 2));
  }
  const shortRaw = clean.slice(0, 16);
  const shortFingerprint = [
    shortRaw.slice(0, 4),
    shortRaw.slice(4, 8),
    shortRaw.slice(8, 12),
    shortRaw.slice(12, 16),
  ]
    .filter(Boolean)
    .join('-');

  return {
    fingerprintSha256: pairs.join(':'),
    shortFingerprint,
  };
}

/**
 * Computes the SPKI SHA-256 fingerprint from an X.509 PEM certificate using Node's native crypto.X509Certificate.
 */
export function computeCertSpkiFingerprint(certificatePem: string): {
  fingerprintSha256: string;
  shortFingerprint: string;
  hostId: string;
} {
  const cert = new crypto.X509Certificate(certificatePem);
  const spkiDer = cert.publicKey.export({ type: 'spki', format: 'der' });
  const digest = crypto.createHash('sha256').update(spkiDer).digest();
  const hex = digest.toString('hex');
  const formatted = formatSha256Fingerprint(hex);
  const hostId = deriveUuidV4ShapeFromDigest(digest);
  return {
    ...formatted,
    hostId,
  };
}

export function deriveUuidV4ShapeFromDigest(digest: Buffer): string {
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Generates an ECDSA P-256 self-signed X.509 v3 certificate in pure Node.js crypto
 * with zero external OpenSSL binary dependency or native addons.
 */
export function generateSelfSignedHostCertificate(
  commonName = 'DoReMi Personal Host',
  validityYears = 10,
): GeneratedHostCertificate {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });

  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  const serial = crypto.randomBytes(15);
  serial[0] &= 0x7f;
  if (serial[0] === 0) {
    serial[0] = 1;
  }

  const now = new Date();
  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + validityYears * 365 * 24 * 60 * 60 * 1000);

  // ecdsa-with-SHA256: 1.2.840.10045.4.3.2
  const sigAlg = derSequence([derOid([1, 2, 840, 10045, 4, 3, 2])]);
  const issuer = buildName(commonName.slice(0, 64) || 'DoReMi Host');
  const validity = derSequence([
    derGeneralizedTime(notBefore),
    derGeneralizedTime(notAfter),
  ]);

  // BasicConstraints (2.5.29.19): cA=false
  const basicConstraintsExt = derSequence([
    derOid([2, 5, 29, 19]),
    derTag(0x01, Buffer.from([0xff])), // critical = TRUE
    derOctetString(derSequence([])),
  ]);

  // KeyUsage (2.5.29.15): digitalSignature (bit 0) + keyEncipherment (bit 2)
  const keyUsageExt = derSequence([
    derOid([2, 5, 29, 15]),
    derTag(0x01, Buffer.from([0xff])),
    derOctetString(derBitString(Buffer.from([0xa0]), 5)),
  ]);

  // ExtKeyUsage (2.5.29.37): id-kp-serverAuth (1.3.6.1.5.5.7.3.1)
  const extKeyUsageExt = derSequence([
    derOid([2, 5, 29, 37]),
    derOctetString(derSequence([derOid([1, 3, 6, 1, 5, 5, 7, 3, 1])])),
  ]);

  // SubjectAltName (2.5.29.17): dNSName "doremi.local", "localhost", iPAddress 127.0.0.1
  const sanExt = derSequence([
    derOid([2, 5, 29, 17]),
    derOctetString(
      derSequence([
        derTag(0x82, Buffer.from('doremi.local', 'ascii')),
        derTag(0x82, Buffer.from('localhost', 'ascii')),
        derTag(0x87, Buffer.from([127, 0, 0, 1])),
      ]),
    ),
  ]);

  const extensions = derExplicit(
    3,
    derSequence([basicConstraintsExt, keyUsageExt, extKeyUsageExt, sanExt]),
  );

  const tbsCertificate = derSequence([
    derExplicit(0, derInteger(Buffer.from([0x02]))), // v3
    derInteger(serial),
    sigAlg,
    issuer,
    validity,
    issuer, // self-signed subject === issuer
    spkiDer,
    extensions,
  ]);

  const signature = crypto.sign('sha256', tbsCertificate, privateKey);
  const fullCertDer = derSequence([
    tbsCertificate,
    sigAlg,
    derBitString(signature, 0),
  ]);

  const certificatePem = toPem('CERTIFICATE', fullCertDer);
  const info = computeCertSpkiFingerprint(certificatePem);

  return {
    privateKeyPem,
    certificatePem,
    spkiFingerprintSha256: info.fingerprintSha256,
    shortFingerprint: info.shortFingerprint,
    hostId: info.hostId,
    createdAt: now.toISOString(),
  };
}
