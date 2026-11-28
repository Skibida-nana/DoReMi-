import crypto from 'node:crypto';
import {
  CONNECT_API_PREFIX,
} from '../../../shared/contracts/connect-api';
import { normalizeFullFingerprint } from '../../../shared/contracts/connect-pairing';
import {
  buildRemoteEndpointDescriptorSigningInput,
  buildRemoteHostProofSigningInput,
  CONNECT_REMOTE_CHALLENGE_TTL_MS,
  CONNECT_REMOTE_DESCRIPTOR_TTL_MS,
  isValidRemoteChallengeNonce,
  normalizeRemoteMountPath,
  validateRemoteEndpointDescriptorShape,
  validateRemoteHostProofShape,
  validateRemoteHttpsOrigin,
} from '../../../shared/contracts/connect-remote';
import type {
  RemoteEndpointDescriptorV1,
  RemoteHostIdentityProofV1,
  RemoteProviderId,
} from '../../../shared/types/connect';
import { deriveUuidV4ShapeFromDigest, formatSha256Fingerprint } from './x509-cert';

export function extractCertSpkiDerBase64(certificatePem: string): string {
  const cert = new crypto.X509Certificate(certificatePem);
  const spkiDer = cert.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.toString('base64');
}

function verifySpkiMatchesTrustedHost(
  spkiBase64: string,
  expectedHostId: string,
  expectedPinnedFingerprintSha256: string,
): { ok: true; publicKey: crypto.KeyObject; formattedFp: string } | { ok: false; code: string; message: string } {
  const expectedNorm = normalizeFullFingerprint(expectedPinnedFingerprintSha256);
  if (!expectedNorm) {
    return {
      ok: false,
      code: 'INVALID_PINNED_FINGERPRINT',
      message: 'Vân tay Host đã ghim trên thiết bị không hợp lệ.',
    };
  }

  let spkiDer: Buffer;
  try {
    spkiDer = Buffer.from(spkiBase64, 'base64');
    if (spkiDer.length < 32 || spkiDer.length > 512) {
      return { ok: false, code: 'INVALID_PUBLIC_KEY', message: 'Khóa công khai SPKI có kích thước không hợp lệ.' };
    }
  } catch {
    return { ok: false, code: 'INVALID_PUBLIC_KEY', message: 'Không thể giải mã khóa công khai SPKI.' };
  }

  const digest = crypto.createHash('sha256').update(spkiDer).digest();
  const formatted = formatSha256Fingerprint(digest.toString('hex')).fingerprintSha256;
  const observedNorm = normalizeFullFingerprint(formatted);
  if (!observedNorm || observedNorm !== expectedNorm) {
    return {
      ok: false,
      code: 'HOST_IDENTITY_MISMATCH',
      message: 'Khóa công khai của Remote Endpoint không khớp với vân tay mật mã Host đã tin cậy.',
    };
  }

  const derivedHostId = deriveUuidV4ShapeFromDigest(digest).toLowerCase();
  if (derivedHostId !== expectedHostId.trim().toLowerCase()) {
    return {
      ok: false,
      code: 'HOST_IDENTITY_MISMATCH',
      message: 'Host ID dẫn xuất từ khóa công khai không khớp với Host đã tin cậy.',
    };
  }

  try {
    const publicKey = crypto.createPublicKey({
      key: spkiDer,
      format: 'der',
      type: 'spki',
    });
    return { ok: true, publicKey, formattedFp: observedNorm };
  } catch {
    return { ok: false, code: 'INVALID_PUBLIC_KEY', message: 'Cấu trúc khóa công khai ECDSA không hợp lệ.' };
  }
}

export function signRemoteEndpointDescriptor(params: {
  hostId: string;
  hostDisplayName: string;
  providerId: RemoteProviderId;
  publicOrigin: string;
  mountPath: string;
  endpointGeneration: number;
  certificatePem: string;
  privateKeyPem: string;
  hostFingerprintSha256: string;
  nowMs?: number;
  ttlMs?: number;
}): RemoteEndpointDescriptorV1 {
  const originValidation = validateRemoteHttpsOrigin(params.publicOrigin, params.providerId);
  if (!originValidation.ok) {
    throw new Error(`Invalid Remote HTTPS origin: ${originValidation.message}`);
  }
  const mountPath = normalizeRemoteMountPath(params.mountPath);
  if (!mountPath) {
    throw new Error('Invalid Remote mount path.');
  }
  const normalizedFp = normalizeFullFingerprint(params.hostFingerprintSha256);
  if (!normalizedFp) {
    throw new Error('Invalid Host SPKI fingerprint.');
  }

  const nowMs = params.nowMs ?? Date.now();
  const ttlMs = Math.max(60_000, params.ttlMs ?? CONNECT_REMOTE_DESCRIPTOR_TTL_MS);
  const issuedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ttlMs).toISOString();
  const apiBasePath = `${mountPath}${CONNECT_API_PREFIX}`;
  const hostId = params.hostId.trim().toLowerCase();
  const spkiBase64 = extractCertSpkiDerBase64(params.certificatePem);

  const signingInput = buildRemoteEndpointDescriptorSigningInput({
    hostId,
    providerId: params.providerId,
    publicOrigin: originValidation.canonicalOrigin,
    mountPath,
    apiBasePath,
    endpointGeneration: params.endpointGeneration,
    issuedAt,
    expiresAt,
    hostFingerprintSha256: normalizedFp,
  });

  const privKey = crypto.createPrivateKey(params.privateKeyPem);
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), privKey);

  return {
    schema: 'doremi-remote-endpoint',
    version: 1,
    hostId,
    hostDisplayName:
      params.hostDisplayName.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 48) ||
      'DoReMi Host',
    providerId: params.providerId,
    publicOrigin: originValidation.canonicalOrigin,
    mountPath,
    apiBasePath,
    endpointGeneration: params.endpointGeneration,
    issuedAt,
    expiresAt,
    identityAlgorithm: 'ecdsa-p256-spki-sha256',
    hostFingerprintSha256: normalizedFp,
    hostPublicKeySpkiBase64: spkiBase64,
    signatureBase64: signature.toString('base64'),
  };
}

export function verifyRemoteEndpointDescriptor(
  rawDescriptor: unknown,
  expectedHostId: string,
  expectedPinnedFingerprintSha256: string,
  options?: { nowMs?: number; minGeneration?: number; allowExpired?: boolean },
): { ok: true; descriptor: RemoteEndpointDescriptorV1 } | { ok: false; code: string; message: string } {
  const shape = validateRemoteEndpointDescriptorShape(rawDescriptor, options);
  if (!shape.ok) {
    return shape;
  }

  const desc = shape.descriptor;
  if (desc.hostId !== expectedHostId.trim().toLowerCase()) {
    return {
      ok: false,
      code: 'HOST_IDENTITY_MISMATCH',
      message: 'Host ID của Remote Endpoint không khớp với Host đã ghép nối.',
    };
  }

  if (options?.minGeneration !== undefined && desc.endpointGeneration < options.minGeneration) {
    return {
      ok: false,
      code: 'SUPERSEDED_DESCRIPTOR',
      message: 'Thông tin Remote Endpoint đã cũ (bị thay thế bởi thế hệ mới hơn).',
    };
  }

  const spkiCheck = verifySpkiMatchesTrustedHost(
    desc.hostPublicKeySpkiBase64,
    expectedHostId,
    expectedPinnedFingerprintSha256,
  );
  if (!spkiCheck.ok) {
    return spkiCheck;
  }

  if (desc.hostFingerprintSha256 !== spkiCheck.formattedFp) {
    return {
      ok: false,
      code: 'HOST_IDENTITY_MISMATCH',
      message: 'Vân tay trong descriptor không khớp với khóa công khai SPKI.',
    };
  }

  const signingInput = buildRemoteEndpointDescriptorSigningInput({
    hostId: desc.hostId,
    providerId: desc.providerId,
    publicOrigin: desc.publicOrigin,
    mountPath: desc.mountPath,
    apiBasePath: desc.apiBasePath,
    endpointGeneration: desc.endpointGeneration,
    issuedAt: desc.issuedAt,
    expiresAt: desc.expiresAt,
    hostFingerprintSha256: desc.hostFingerprintSha256,
  });

  try {
    const sigBuf = Buffer.from(desc.signatureBase64, 'base64');
    const verified = crypto.verify(
      'sha256',
      Buffer.from(signingInput, 'utf8'),
      spkiCheck.publicKey,
      sigBuf,
    );
    if (!verified) {
      return {
        ok: false,
        code: 'INVALID_SIGNATURE',
        message: 'Chữ ký mật mã của Remote Endpoint Descriptor không hợp lệ.',
      };
    }
  } catch {
    return {
      ok: false,
      code: 'INVALID_SIGNATURE',
      message: 'Không thể xác minh chữ ký ECDSA của Remote Endpoint Descriptor.',
    };
  }

  return { ok: true, descriptor: desc };
}

export function signRemoteHostIdentityProof(params: {
  hostId: string;
  publicOrigin: string;
  apiBasePath: string;
  endpointGeneration: number;
  clientNonce: string;
  certificatePem: string;
  privateKeyPem: string;
  nowMs?: number;
  ttlMs?: number;
}): RemoteHostIdentityProofV1 {
  if (!isValidRemoteChallengeNonce(params.clientNonce)) {
    throw new Error('Invalid challenge nonce.');
  }
  const originValidation = validateRemoteHttpsOrigin(params.publicOrigin);
  if (!originValidation.ok) {
    throw new Error(originValidation.message);
  }
  const nowMs = params.nowMs ?? Date.now();
  const ttlMs = Math.max(5_000, Math.min(120_000, params.ttlMs ?? CONNECT_REMOTE_CHALLENGE_TTL_MS));
  const issuedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ttlMs).toISOString();
  const hostId = params.hostId.trim().toLowerCase();
  const spkiBase64 = extractCertSpkiDerBase64(params.certificatePem);

  const signingInput = buildRemoteHostProofSigningInput({
    hostId,
    publicOrigin: originValidation.canonicalOrigin,
    apiBasePath: params.apiBasePath,
    endpointGeneration: params.endpointGeneration,
    clientNonce: params.clientNonce,
    issuedAt,
    expiresAt,
  });

  const privKey = crypto.createPrivateKey(params.privateKeyPem);
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), privKey);

  return {
    schema: 'doremi-remote-host-proof',
    version: 1,
    hostId,
    publicOrigin: originValidation.canonicalOrigin,
    apiBasePath: params.apiBasePath,
    endpointGeneration: params.endpointGeneration,
    clientNonce: params.clientNonce,
    issuedAt,
    expiresAt,
    hostPublicKeySpkiBase64: spkiBase64,
    signatureBase64: signature.toString('base64'),
  };
}

export function verifyRemoteHostIdentityProof(
  rawProof: unknown,
  expected: {
    hostId: string;
    publicOrigin: string;
    apiBasePath: string;
    minGeneration: number;
    clientNonce: string;
    pinnedFingerprintSha256: string;
    nowMs?: number;
    maxClockSkewMs?: number;
  },
): { ok: true; proof: RemoteHostIdentityProofV1 } | { ok: false; code: string; message: string } {
  const shape = validateRemoteHostProofShape(rawProof);
  if (!shape.ok) {
    return shape;
  }
  const proof = shape.proof;

  if (proof.hostId !== expected.hostId.trim().toLowerCase()) {
    return {
      ok: false,
      code: 'HOST_IDENTITY_MISMATCH',
      message: 'Host ID phản hồi từ Remote không khớp với Host đã tin cậy.',
    };
  }
  if (proof.publicOrigin !== expected.publicOrigin) {
    return {
      ok: false,
      code: 'ORIGIN_MISMATCH',
      message: 'Origin trong bằng chứng danh tính không khớp với Remote Endpoint đã xác minh.',
    };
  }
  if (proof.apiBasePath !== expected.apiBasePath) {
    return {
      ok: false,
      code: 'API_PATH_MISMATCH',
      message: 'API path trong bằng chứng danh tính không khớp.',
    };
  }
  if (proof.endpointGeneration < expected.minGeneration) {
    return {
      ok: false,
      code: 'STALE_GENERATION',
      message: 'Endpoint generation từ Remote thấp hơn thế hệ đã xác minh.',
    };
  }
  if (proof.clientNonce !== expected.clientNonce) {
    return {
      ok: false,
      code: 'NONCE_MISMATCH',
      message: 'Challenge nonce phản hồi từ Remote không khớp (nghi vấn phát lại/giả mạo).',
    };
  }

  const nowMs = expected.nowMs ?? Date.now();
  const skewMs = expected.maxClockSkewMs ?? 30_000;
  const issuedMs = Date.parse(proof.issuedAt);
  const expiresMs = Date.parse(proof.expiresAt);
  if (issuedMs > nowMs + skewMs || expiresMs <= nowMs - skewMs) {
    return {
      ok: false,
      code: 'CHALLENGE_EXPIRED',
      message: 'Bằng chứng danh tính Host đã hết hạn hoặc lệch đồng hồ quá mức cho phép.',
    };
  }

  const spkiCheck = verifySpkiMatchesTrustedHost(
    proof.hostPublicKeySpkiBase64,
    expected.hostId,
    expected.pinnedFingerprintSha256,
  );
  if (!spkiCheck.ok) {
    return spkiCheck;
  }

  const signingInput = buildRemoteHostProofSigningInput({
    hostId: proof.hostId,
    publicOrigin: proof.publicOrigin,
    apiBasePath: proof.apiBasePath,
    endpointGeneration: proof.endpointGeneration,
    clientNonce: proof.clientNonce,
    issuedAt: proof.issuedAt,
    expiresAt: proof.expiresAt,
  });

  try {
    const sigBuf = Buffer.from(proof.signatureBase64, 'base64');
    const verified = crypto.verify(
      'sha256',
      Buffer.from(signingInput, 'utf8'),
      spkiCheck.publicKey,
      sigBuf,
    );
    if (!verified) {
      return {
        ok: false,
        code: 'INVALID_SIGNATURE',
        message: 'Chữ ký mật mã chứng minh danh tính Host qua Remote không hợp lệ.',
      };
    }
  } catch {
    return {
      ok: false,
      code: 'INVALID_SIGNATURE',
      message: 'Lỗi xác minh chữ ký danh tính Host qua Remote.',
    };
  }

  return { ok: true, proof };
}
