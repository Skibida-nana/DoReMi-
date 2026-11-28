import { isValidTrackUuid } from './media-protocol';

export const PAIRING_PAYLOAD_PROTOCOL = 'doremi-pair';
export const PAIRING_PAYLOAD_VERSION = 1;
export const PAIRING_PAYLOAD_MAX_BYTES = 2048;

export interface PairingEndpointV1 {
  transport: 'lan-https';
  address: string;
  port: number;
}

export interface DoremipairPayloadV1 {
  protocol: typeof PAIRING_PAYLOAD_PROTOCOL;
  version: typeof PAIRING_PAYLOAD_VERSION;
  hostId: string;
  hostName: string;
  endpoints: PairingEndpointV1[];
  identityAlgorithm: 'spki-sha256';
  identityFingerprint: string;
  invitation: string;
  expiresAt: string;
}

const FULL_SPKI_FINGERPRINT_REGEX = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const INVITE_FORMAT_REGEX = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const UNSAFE_SCHEME_REGEX = /^(https?|javascript|data|vbscript|file|cmd|powershell|ms-msdt):/i;
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type PairingValidationResult =
  | { ok: true; payload: DoremipairPayloadV1 }
  | { ok: false; code: string; message: string };

export function normalizeFullFingerprint(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleanHex = raw.replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (cleanHex.length !== 64) {
    return null;
  }
  const pairs: string[] = [];
  for (let i = 0; i < cleanHex.length; i += 2) {
    pairs.push(cleanHex.slice(i, i + 2));
  }
  const formatted = pairs.join(':');
  return FULL_SPKI_FINGERPRINT_REGEX.test(formatted) ? formatted : null;
}

export function sanitizeHostDisplayNameForPairing(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 48);
  return clean.length > 0 ? clean : null;
}

export function isValidLanPairingAddress(address: unknown): address is string {
  if (typeof address !== 'string') return false;
  let trimmed = address.trim();
  if (!trimmed || trimmed.length > 64 || /\s/.test(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
    return false;
  }
  if (trimmed === 'localhost' || trimmed === '::1') {
    return true;
  }
  if (trimmed.startsWith('::ffff:')) {
    trimmed = trimmed.slice('::ffff:'.length);
  }
  const parts = trimmed.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p))) {
    return false;
  }
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = nums;
  if (a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Serializes a validated `doremi-pair` v1 payload into a compact JSON string (`<= 2048` UTF-8 bytes)
 * suitable for offline QR rendering or secure clipboard import. Never logs invitation secrets.
 */
export function serializePairingPayload(payload: DoremipairPayloadV1): string {
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, 'utf8') > PAIRING_PAYLOAD_MAX_BYTES) {
    throw new Error('Pairing payload exceeded maximum safe QR size limit.');
  }
  return encoded;
}

/**
 * Strictly validates untrusted QR / pasted pairing text according to Phase 6.2 security rules:
 * - Size cap <= 2048 bytes, rejects URL schemes or prototype keys
 * - Exact protocol & version match (`doremi-pair`, v1)
 * - Valid Host UUID, LAN endpoints (private IPv4 / localhost), full SPKI SHA-256 fingerprint,
 *   invitation format, and expiration timestamp check.
 */
export function parseAndValidatePairingPayload(
  rawText: unknown,
  options?: { nowMs?: number; allowExpired?: boolean },
): PairingValidationResult {
  if (typeof rawText !== 'string') {
    return { ok: false, code: 'MALFORMED_PAYLOAD', message: 'Dữ liệu ghép nối phải là chuỗi ký tự.' };
  }

  if (rawText.length > PAIRING_PAYLOAD_MAX_BYTES * 4) {
    return {
      ok: false,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Mã ghép nối vượt quá kích thước an toàn tối đa (2 KB).',
    };
  }

  const trimmed = rawText.trim();
  if (!trimmed) {
    return { ok: false, code: 'MALFORMED_PAYLOAD', message: 'Dữ liệu ghép nối đang trống.' };
  }

  if (Buffer.byteLength(trimmed, 'utf8') > PAIRING_PAYLOAD_MAX_BYTES) {
    return {
      ok: false,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Mã ghép nối vượt quá kích thước an toàn tối đa (2 KB).',
    };
  }

  if (UNSAFE_SCHEME_REGEX.test(trimmed)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_URI_SCHEME',
      message: 'Mã QR chứa đường dẫn ngoài không hợp lệ thay vì định dạng DoReMi Connect.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed, (key, value) => {
      if (FORBIDDEN_JSON_KEYS.has(key)) {
        throw new Error('FORBIDDEN_KEY');
      }
      return value;
    });
  } catch (err) {
    const code = err instanceof Error && err.message === 'FORBIDDEN_KEY' ? 'INJECTION_REJECTED' : 'MALFORMED_PAYLOAD';
    return {
      ok: false,
      code,
      message: 'Không thể đọc cấu trúc JSON hợp lệ từ mã ghép nối.',
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'MALFORMED_PAYLOAD', message: 'Cấu trúc payload ghép nối không hợp lệ.' };
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.protocol !== PAIRING_PAYLOAD_PROTOCOL) {
    return {
      ok: false,
      code: 'INVALID_PROTOCOL',
      message: 'Mã QR không thuộc giao thức ghép nối DoReMi Connect.',
    };
  }

  if (obj.version !== PAIRING_PAYLOAD_VERSION) {
    return {
      ok: false,
      code: 'UNSUPPORTED_VERSION',
      message: `Phiên bản mã ghép nối (${String(obj.version)}) không được hỗ trợ.`,
    };
  }

  if (!isValidTrackUuid(obj.hostId)) {
    return { ok: false, code: 'INVALID_HOST_ID', message: 'Host ID trong mã ghép nối không hợp lệ.' };
  }

  const hostName = sanitizeHostDisplayNameForPairing(obj.hostName);
  if (!hostName) {
    return { ok: false, code: 'INVALID_HOST_NAME', message: 'Tên Host trong mã ghép nối không hợp lệ.' };
  }

  if (obj.identityAlgorithm !== 'spki-sha256') {
    return {
      ok: false,
      code: 'UNSUPPORTED_ALGORITHM',
      message: 'Thuật toán định danh máy chủ trong mã QR không được hỗ trợ.',
    };
  }

  const fullFingerprint = normalizeFullFingerprint(obj.identityFingerprint);
  if (!fullFingerprint) {
    return {
      ok: false,
      code: 'INVALID_FINGERPRINT',
      message: 'Vân tay mật mã Host (SPKI SHA-256) không đầy đủ hoặc sai định dạng.',
    };
  }

  if (!Array.isArray(obj.endpoints) || obj.endpoints.length === 0 || obj.endpoints.length > 8) {
    return {
      ok: false,
      code: 'INVALID_ENDPOINTS',
      message: 'Mã ghép nối không chứa danh sách địa chỉ mạng LAN hợp lệ.',
    };
  }

  const validatedEndpoints: PairingEndpointV1[] = [];
  for (const item of obj.endpoints) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, code: 'INVALID_ENDPOINTS', message: 'Endpoint trong mã ghép nối bị hỏng.' };
    }
    const ep = item as Record<string, unknown>;
    if (ep.transport !== 'lan-https') {
      return {
        ok: false,
        code: 'UNSUPPORTED_TRANSPORT',
        message: 'Loại kết nối trong mã ghép nối không phải mạng LAN trực tiếp.',
      };
    }
    if (!isValidLanPairingAddress(ep.address)) {
      return {
        ok: false,
        code: 'UNSAFE_ENDPOINT_ADDRESS',
        message: 'Địa chỉ IP trong mã ghép nối không thuộc mạng LAN hợp lệ.',
      };
    }
    if (
      typeof ep.port !== 'number' ||
      !Number.isInteger(ep.port) ||
      ep.port < 1024 ||
      ep.port > 65535
    ) {
      return { ok: false, code: 'INVALID_PORT', message: 'Cổng mạng trong mã ghép nối không hợp lệ.' };
    }
    validatedEndpoints.push({
      transport: 'lan-https',
      address: ep.address.trim(),
      port: ep.port,
    });
  }

  if (typeof obj.invitation !== 'string') {
    return { ok: false, code: 'INVALID_INVITATION', message: 'Thiếu mã mời ghép nối.' };
  }
  const cleanInvite = obj.invitation.trim().toUpperCase();
  if (!INVITE_FORMAT_REGEX.test(cleanInvite)) {
    return { ok: false, code: 'INVALID_INVITATION', message: 'Định dạng mã mời ghép nối không hợp lệ.' };
  }

  if (typeof obj.expiresAt !== 'string') {
    return { ok: false, code: 'INVALID_EXPIRATION', message: 'Thiếu thời gian hết hạn của mã ghép nối.' };
  }
  const expMs = Date.parse(obj.expiresAt);
  if (!Number.isFinite(expMs)) {
    return { ok: false, code: 'INVALID_EXPIRATION', message: 'Thời gian hết hạn không hợp lệ.' };
  }
  const nowMs = options?.nowMs ?? Date.now();
  if (!options?.allowExpired && expMs <= nowMs) {
    return { ok: false, code: 'INVITATION_EXPIRED', message: 'Mã ghép nối QR đã hết hạn. Vui lòng tạo mã mới trên Host.' };
  }

  return {
    ok: true,
    payload: {
      protocol: PAIRING_PAYLOAD_PROTOCOL,
      version: PAIRING_PAYLOAD_VERSION,
      hostId: obj.hostId.trim().toLowerCase(),
      hostName,
      endpoints: validatedEndpoints,
      identityAlgorithm: 'spki-sha256',
      identityFingerprint: fullFingerprint,
      invitation: cleanInvite,
      expiresAt: new Date(expMs).toISOString(),
    },
  };
}
