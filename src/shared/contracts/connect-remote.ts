import { CONNECT_API_PREFIX } from './connect-api';
import { normalizeFullFingerprint } from './connect-pairing';
import { isValidTrackUuid } from './media-protocol';
import type {
  RemoteEndpointDescriptorV1,
  RemoteHostIdentityProofV1,
  RemoteProviderId,
} from '../types/connect';

export const CONNECT_REMOTE_DEFAULT_MOUNT_PATH = '/doremi-connect';
export const CONNECT_REMOTE_ALLOWED_PORTS = [443, 8443, 10000] as const;
export const CONNECT_REMOTE_DESCRIPTOR_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const CONNECT_REMOTE_CHALLENGE_TTL_MS = 60 * 1000;
export const CONNECT_REMOTE_TOKEN_PREFIX = 'r1.';
export const TAILSCALE_WINDOWS_DOWNLOAD_URL = 'https://tailscale.com/download/windows';

const DNS_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CLIENT_NONCE_REGEX = /^[A-Za-z0-9_-]{16,64}$/;
const ENCODED_TRAVERSAL_REGEX = /%(?:2e|2f|5c|00)/i;

export type AllowedFunnelPublicPort = (typeof CONNECT_REMOTE_ALLOWED_PORTS)[number];

export function isAllowedFunnelPublicPort(port: unknown): port is AllowedFunnelPublicPort {
  return port === 443 || port === 8443 || port === 10000;
}

export function normalizeRemoteMountPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/') || trimmed.length < 2 || trimmed.length > 64) {
    return null;
  }
  if (
    trimmed.includes('//') ||
    trimmed.includes('\\') ||
    trimmed.includes('..') ||
    trimmed.includes('?') ||
    trimmed.includes('#') ||
    ENCODED_TRAVERSAL_REGEX.test(trimmed) ||
    !/^\/[a-z0-9/_-]+$/i.test(trimmed)
  ) {
    return null;
  }
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * Validates that a hostname strictly belongs to Tailscale MagicDNS/Funnel (`<node>.<tailnet>.ts.net`),
 * rejecting substring tricks (`evilts.net`, `ts.net.attacker.com`, bare `ts.net`, or single-label `sub.ts.net`).
 */
export function isValidTailscaleFunnelHostname(rawHostname: unknown): boolean {
  if (typeof rawHostname !== 'string') return false;
  const trimmed = rawHostname.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed || trimmed.length > 253 || trimmed.includes('..')) {
    return false;
  }
  const labels = trimmed.split('.');
  // Must have at least 4 labels: <node>.<tailnet>.ts.net
  if (labels.length < 4) {
    return false;
  }
  if (labels[labels.length - 2] !== 'ts' || labels[labels.length - 1] !== 'net') {
    return false;
  }
  return labels.every((label) => DNS_LABEL_REGEX.test(label));
}

export type ValidatedRemoteOriginResult =
  | {
      ok: true;
      canonicalOrigin: string;
      hostname: string;
      port: AllowedFunnelPublicPort;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

/**
 * Strictly validates a provider-supplied Remote HTTPS origin before Host descriptor signing
 * or Client network connection.
 */
export function validateRemoteHttpsOrigin(
  rawUrlOrOrigin: unknown,
  providerId: RemoteProviderId = 'tailscale-funnel',
): ValidatedRemoteOriginResult {
  if (typeof rawUrlOrOrigin !== 'string' || rawUrlOrOrigin.trim().length === 0) {
    return {
      ok: false,
      code: 'INVALID_ORIGIN',
      message: 'Địa chỉ Remote HTTPS đang trống.',
    };
  }

  const trimmed = rawUrlOrOrigin.trim();
  if (trimmed.length > 512 || /\s/.test(trimmed) || ENCODED_TRAVERSAL_REGEX.test(trimmed)) {
    return {
      ok: false,
      code: 'INVALID_ORIGIN',
      message: 'Địa chỉ Remote HTTPS chứa ký tự hoặc mã hóa không hợp lệ.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      code: 'INVALID_ORIGIN',
      message: 'Không thể phân tích cú pháp URL Remote HTTPS.',
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'HTTPS_REQUIRED',
      message: 'Kết nối từ xa bắt buộc sử dụng giao thức HTTPS an toàn.',
    };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      code: 'EMBEDDED_CREDENTIALS_FORBIDDEN',
      message: 'URL Remote HTTPS không được phép chứa thông tin đăng nhập nhúng.',
    };
  }

  if (parsed.search || parsed.hash) {
    return {
      ok: false,
      code: 'UNEXPECTED_QUERY_OR_FRAGMENT',
      message: 'Origin Remote HTTPS không được chứa query hoặc fragment.',
    };
  }

  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return {
      ok: false,
      code: 'ORIGIN_MUST_NOT_HAVE_PATH',
      message: 'Origin Remote HTTPS không được chứa đường dẫn phụ.',
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (providerId === 'tailscale-funnel' && !isValidTailscaleFunnelHostname(hostname)) {
    return {
      ok: false,
      code: 'UNTRUSTED_PROVIDER_DOMAIN',
      message: 'Tên miền không thuộc định dạng Tailscale Funnel hợp lệ (<node>.<tailnet>.ts.net).',
    };
  }

  const portNum = parsed.port ? Number(parsed.port) : 443;
  if (!Number.isInteger(portNum) || !isAllowedFunnelPublicPort(portNum)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_PUBLIC_PORT',
      message: 'Cổng HTTPS công cộng của Funnel chỉ hỗ trợ 443, 8443 hoặc 10000.',
    };
  }

  const canonicalOrigin = portNum === 443 ? `https://${hostname}` : `https://${hostname}:${portNum}`;
  return {
    ok: true,
    canonicalOrigin,
    hostname,
    port: portNum,
  };
}

export function isValidRemoteChallengeNonce(nonce: unknown): nonce is string {
  return typeof nonce === 'string' && CLIENT_NONCE_REGEX.test(nonce);
}

/**
 * Deterministic, domain-separated canonical signing string for `RemoteEndpointDescriptorV1`.
 */
export function buildRemoteEndpointDescriptorSigningInput(params: {
  hostId: string;
  providerId: RemoteProviderId;
  publicOrigin: string;
  mountPath: string;
  apiBasePath: string;
  endpointGeneration: number;
  issuedAt: string;
  expiresAt: string;
  hostFingerprintSha256: string;
}): string {
  return [
    'DOREMI-REMOTE-ENDPOINT-V1',
    params.hostId.trim().toLowerCase(),
    params.providerId,
    params.publicOrigin,
    params.mountPath,
    params.apiBasePath,
    String(params.endpointGeneration),
    params.issuedAt,
    params.expiresAt,
    params.hostFingerprintSha256,
  ].join('\n');
}

/**
 * Deterministic, domain-separated canonical signing string for `RemoteHostIdentityProofV1`.
 */
export function buildRemoteHostProofSigningInput(params: {
  hostId: string;
  publicOrigin: string;
  apiBasePath: string;
  endpointGeneration: number;
  clientNonce: string;
  issuedAt: string;
  expiresAt: string;
}): string {
  return [
    'DOREMI-REMOTE-HOST-PROOF-V1',
    params.hostId.trim().toLowerCase(),
    params.publicOrigin,
    params.apiBasePath,
    String(params.endpointGeneration),
    params.clientNonce,
    params.issuedAt,
    params.expiresAt,
  ].join('\n');
}

/**
 * Pure structural check of `RemoteEndpointDescriptorV1` (safe in both Main and Renderer).
 * Full ECDSA P-256 cryptographic signature & SPKI fingerprint verification is performed in Main (`remote-trust.ts`).
 */
export function validateRemoteEndpointDescriptorShape(
  raw: unknown,
  options?: { nowMs?: number; allowExpired?: boolean },
): { ok: true; descriptor: RemoteEndpointDescriptorV1 } | { ok: false; code: string; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'MALFORMED_DESCRIPTOR', message: 'Descriptor Remote không hợp lệ.' };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schema !== 'doremi-remote-endpoint' || obj.version !== 1) {
    return {
      ok: false,
      code: 'UNSUPPORTED_DESCRIPTOR_VERSION',
      message: 'Phiên bản Remote Endpoint Descriptor không được hỗ trợ.',
    };
  }
  if (!isValidTrackUuid(obj.hostId)) {
    return { ok: false, code: 'INVALID_HOST_ID', message: 'Host ID trong descriptor không hợp lệ.' };
  }
  if (obj.providerId !== 'tailscale-funnel') {
    return { ok: false, code: 'UNSUPPORTED_PROVIDER', message: 'Nhà cung cấp kết nối từ xa chưa được hỗ trợ.' };
  }
  const originCheck = validateRemoteHttpsOrigin(obj.publicOrigin, obj.providerId);
  if (!originCheck.ok) {
    return originCheck;
  }
  const mountPath = normalizeRemoteMountPath(obj.mountPath);
  if (!mountPath) {
    return { ok: false, code: 'INVALID_MOUNT_PATH', message: 'Đường dẫn mount Remote không hợp lệ.' };
  }
  const expectedApiBase = `${mountPath}${CONNECT_API_PREFIX}`;
  if (obj.apiBasePath !== expectedApiBase) {
    return { ok: false, code: 'INVALID_API_BASE_PATH', message: 'Đường dẫn API Remote không khớp mount path.' };
  }
  if (
    typeof obj.endpointGeneration !== 'number' ||
    !Number.isSafeInteger(obj.endpointGeneration) ||
    obj.endpointGeneration < 1
  ) {
    return { ok: false, code: 'INVALID_GENERATION', message: 'Số thế hệ endpoint (generation) không hợp lệ.' };
  }
  if (obj.identityAlgorithm !== 'ecdsa-p256-spki-sha256') {
    return { ok: false, code: 'UNSUPPORTED_ALGORITHM', message: 'Thuật toán chữ ký Host không được hỗ trợ.' };
  }
  const normalizedFp = normalizeFullFingerprint(obj.hostFingerprintSha256);
  if (!normalizedFp) {
    return { ok: false, code: 'INVALID_FINGERPRINT', message: 'Vân tay SPKI SHA-256 trong descriptor không hợp lệ.' };
  }
  if (
    typeof obj.hostPublicKeySpkiBase64 !== 'string' ||
    obj.hostPublicKeySpkiBase64.length < 64 ||
    obj.hostPublicKeySpkiBase64.length > 512
  ) {
    return { ok: false, code: 'INVALID_PUBLIC_KEY', message: 'Khóa công khai SPKI của Host không hợp lệ.' };
  }
  if (
    typeof obj.signatureBase64 !== 'string' ||
    obj.signatureBase64.length < 64 ||
    obj.signatureBase64.length > 512
  ) {
    return { ok: false, code: 'INVALID_SIGNATURE', message: 'Chữ ký mật mã của descriptor bị thiếu hoặc sai.' };
  }
  const issuedMs = typeof obj.issuedAt === 'string' ? Date.parse(obj.issuedAt) : NaN;
  const expiresMs = typeof obj.expiresAt === 'string' ? Date.parse(obj.expiresAt) : NaN;
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs) || expiresMs <= issuedMs) {
    return { ok: false, code: 'INVALID_TIMESTAMPS', message: 'Thời hạn hiệu lực của descriptor không hợp lệ.' };
  }
  const nowMs = options?.nowMs ?? Date.now();
  if (!options?.allowExpired && expiresMs <= nowMs) {
    return {
      ok: false,
      code: 'DESCRIPTOR_EXPIRED',
      message: 'Thông tin Remote Endpoint đã hết hạn. Hãy kết nối qua LAN để đồng bộ lại.',
    };
  }
  const hostDisplayName =
    typeof obj.hostDisplayName === 'string' && obj.hostDisplayName.trim().length > 0
      ? obj.hostDisplayName.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 48)
      : 'DoReMi Host';

  return {
    ok: true,
    descriptor: {
      schema: 'doremi-remote-endpoint',
      version: 1,
      hostId: obj.hostId.trim().toLowerCase(),
      hostDisplayName,
      providerId: 'tailscale-funnel',
      publicOrigin: originCheck.canonicalOrigin,
      mountPath,
      apiBasePath: expectedApiBase,
      endpointGeneration: obj.endpointGeneration,
      issuedAt: new Date(issuedMs).toISOString(),
      expiresAt: new Date(expiresMs).toISOString(),
      identityAlgorithm: 'ecdsa-p256-spki-sha256',
      hostFingerprintSha256: normalizedFp,
      hostPublicKeySpkiBase64: obj.hostPublicKeySpkiBase64.trim(),
      signatureBase64: obj.signatureBase64.trim(),
    },
  };
}

export function validateRemoteHostProofShape(
  raw: unknown,
): { ok: true; proof: RemoteHostIdentityProofV1 } | { ok: false; code: string; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'MALFORMED_PROOF', message: 'Phản hồi xác minh danh tính Host không hợp lệ.' };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schema !== 'doremi-remote-host-proof' || obj.version !== 1) {
    return { ok: false, code: 'UNSUPPORTED_PROOF_VERSION', message: 'Phiên bản bằng chứng danh tính Host không hợp lệ.' };
  }
  if (!isValidTrackUuid(obj.hostId)) {
    return { ok: false, code: 'INVALID_HOST_ID', message: 'Host ID trong bằng chứng không hợp lệ.' };
  }
  const originCheck = validateRemoteHttpsOrigin(obj.publicOrigin);
  if (!originCheck.ok) {
    return originCheck;
  }
  if (typeof obj.apiBasePath !== 'string' || !obj.apiBasePath.endsWith(CONNECT_API_PREFIX)) {
    return { ok: false, code: 'INVALID_API_BASE_PATH', message: 'API base path trong bằng chứng không hợp lệ.' };
  }
  if (
    typeof obj.endpointGeneration !== 'number' ||
    !Number.isSafeInteger(obj.endpointGeneration) ||
    obj.endpointGeneration < 1
  ) {
    return { ok: false, code: 'INVALID_GENERATION', message: 'Generation trong bằng chứng không hợp lệ.' };
  }
  if (!isValidRemoteChallengeNonce(obj.clientNonce)) {
    return { ok: false, code: 'INVALID_NONCE', message: 'Nonce trong bằng chứng không hợp lệ.' };
  }
  const issuedMs = typeof obj.issuedAt === 'string' ? Date.parse(obj.issuedAt) : NaN;
  const expiresMs = typeof obj.expiresAt === 'string' ? Date.parse(obj.expiresAt) : NaN;
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs) || expiresMs <= issuedMs) {
    return { ok: false, code: 'INVALID_TIMESTAMPS', message: 'Thời gian hiệu lực bằng chứng không hợp lệ.' };
  }
  if (
    typeof obj.hostPublicKeySpkiBase64 !== 'string' ||
    obj.hostPublicKeySpkiBase64.length < 64 ||
    obj.hostPublicKeySpkiBase64.length > 512 ||
    typeof obj.signatureBase64 !== 'string' ||
    obj.signatureBase64.length < 64 ||
    obj.signatureBase64.length > 512
  ) {
    return { ok: false, code: 'INVALID_SIGNATURE', message: 'Chữ ký bằng chứng danh tính không hợp lệ.' };
  }

  return {
    ok: true,
    proof: {
      schema: 'doremi-remote-host-proof',
      version: 1,
      hostId: obj.hostId.trim().toLowerCase(),
      publicOrigin: originCheck.canonicalOrigin,
      apiBasePath: obj.apiBasePath,
      endpointGeneration: obj.endpointGeneration,
      clientNonce: obj.clientNonce,
      issuedAt: new Date(issuedMs).toISOString(),
      expiresAt: new Date(expiresMs).toISOString(),
      hostPublicKeySpkiBase64: obj.hostPublicKeySpkiBase64.trim(),
      signatureBase64: obj.signatureBase64.trim(),
    },
  };
}
