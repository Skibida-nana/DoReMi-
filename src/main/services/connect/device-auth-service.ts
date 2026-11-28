import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { CONNECT_INVITATION_TTL_MS } from '../../../shared/contracts/connect-api';
import {
  isValidLanPairingAddress,
  normalizeFullFingerprint,
  PAIRING_PAYLOAD_PROTOCOL,
  PAIRING_PAYLOAD_VERSION,
  sanitizeHostDisplayNameForPairing,
  serializePairingPayload,
} from '../../../shared/contracts/connect-pairing';
import {
  CONNECT_REMOTE_TOKEN_PREFIX,
} from '../../../shared/contracts/connect-remote';
import type {
  EnrollmentInvitationSummary,
  InvitationLifecycleState,
  PendingEnrollmentRequest,
  SecurityAuditCategory,
  SecurityAuditEvent,
} from '../../../shared/types/connect';
import type { ConnectRepository, StoredDeviceAuthRow } from './connect-repository';

interface ActiveInvitationState {
  invitationId: string;
  inviteCodeHash: string;
  inviteCodeSalt: string;
  rawInviteCode: string;
  pairingPayload: string;
  qrDataUrl: string | null;
  createdAtMs: number;
  expiresAtMs: number;
  autoApproveSingleUse: boolean;
  used: boolean;
  lifecycleState: InvitationLifecycleState;
}

interface InternalPendingRequest {
  requestId: string;
  invitationId: string;
  deviceName: string;
  platform: string;
  remoteAddress: string;
  clientNonce: string;
  pollTokenHash: string;
  requestedAtMs: number;
  expiresAtMs: number;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  issuedCredentials: { deviceId: string; deviceToken: string } | null;
}

interface RateLimitBucket {
  failedAttempts: number;
  windowStartMs: number;
  lockedUntilMs: number;
}

interface GraceTokenRecord {
  prevHash: string;
  prevSalt: string;
  expiresAtMs: number;
}

const INVITE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ROTATION_GRACE_MS = 60_000;
const MAX_FAILED_ENROLL_ATTEMPTS = 5;
const ENROLL_LOCKOUT_MS = 60_000;
const ENROLL_WINDOW_MS = 120_000;
const MAX_FAILED_POLL_ATTEMPTS = 8;
const POLL_LOCKOUT_MS = 60_000;
const POLL_WINDOW_MS = 120_000;
const MAX_FAILED_AUTH_ATTEMPTS = 10;
const AUTH_LOCKOUT_MS = 60_000;
const AUTH_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_BUCKETS = 512;
const MAX_PENDING_REQUESTS = 16;
const REPLAY_NONCE_TTL_MS = 10 * 60 * 1000;
const MAX_SECURITY_EVENTS = 64;
const DEVICE_AUTH_CACHE_TTL_MS = 10_000;
const ACTIVITY_WRITE_THROTTLE_MS = 30_000;

interface CachedDeviceAuthEntry {
  row: StoredDeviceAuthRow;
  cachedAtMs: number;
}

interface DeviceActivityThrottleState {
  lastFlushedAtMs: number;
  lastFlushedIp: string | null;
  pendingTouchAtMs: number | null;
  pendingIp: string | null;
}

function generateRandomInviteCode(): string {
  const bytes = crypto.randomBytes(12);
  let raw = '';
  for (let i = 0; i < 12; i += 1) {
    raw += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function hashWithSalt(value: string, salt: string): string {
  return crypto.createHash('sha256').update(`${salt}::${value}`).digest('hex');
}

function constantTimeHexEqual(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length || aHex.length === 0) {
    return false;
  }
  const aBuf = Buffer.from(aHex, 'hex');
  const bBuf = Buffer.from(bHex, 'hex');
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function normalizeInviteCodeInput(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function sanitizeClientField(raw: unknown, fallback: string, maxLen: number): string {
  if (typeof raw !== 'string') {
    return fallback;
  }
  const clean = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen);
  return clean || fallback;
}

function generateQrSvgDataUrl(payload: string): string | null {
  try {
    let svgOutput: string | null = null;
    QRCode.toString(
      payload,
      {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 2,
      },
      (err, svg) => {
        if (!err && typeof svg === 'string' && svg.includes('<svg')) {
          svgOutput = svg;
        }
      },
    );
    if (!svgOutput) {
      return null;
    }
    return `data:image/svg+xml;base64,${Buffer.from(svgOutput, 'utf8').toString('base64')}`;
  } catch {
    return null;
  }
}

export class DeviceAuthorizationService {
  private readonly connectRepo: ConnectRepository;
  private readonly onDeviceRevoked?: (deviceId: string) => void;
  private readonly onDeviceRemoteRevoked?: (deviceId: string) => void;
  private activeInvitation: ActiveInvitationState | null = null;
  private lastInvitationState: InvitationLifecycleState | null = null;
  private pendingRequests = new Map<string, InternalPendingRequest>();
  private usedNonces = new Map<string, number>();
  private ipRateLimits = new Map<string, RateLimitBucket>();
  private pollRateLimits = new Map<string, RateLimitBucket>();
  private authRateLimits = new Map<string, RateLimitBucket>();
  private revokedDeviceIds = new Set<string>();
  private lanRotationGrace = new Map<string, GraceTokenRecord>();
  private remoteRotationGrace = new Map<string, GraceTokenRecord>();
  private deviceAuthCache = new Map<string, CachedDeviceAuthEntry>();
  private activityThrottle = new Map<string, DeviceActivityThrottleState>();
  private securityEvents: SecurityAuditEvent[] = [];

  constructor(options: {
    connectRepo: ConnectRepository;
    onDeviceRevoked?: (deviceId: string) => void;
    onDeviceRemoteRevoked?: (deviceId: string) => void;
  }) {
    this.connectRepo = options.connectRepo;
    this.onDeviceRevoked = options.onDeviceRevoked;
    this.onDeviceRemoteRevoked = options.onDeviceRemoteRevoked;
    this.syncRevokedCacheFromRepo();
  }

  private syncRevokedCacheFromRepo(): void {
    try {
      for (const dev of this.connectRepo.listAuthorizedDevices()) {
        if (dev.authState === 'revoked') {
          this.revokedDeviceIds.add(dev.deviceId);
        }
      }
    } catch {
      // Safe fallback during initial boot
    }
  }

  recordSecurityEvent(event: {
    category: SecurityAuditCategory;
    outcome: 'success' | 'blocked' | 'error';
    detail: string;
    deviceId?: string | null;
    statusCode?: number | null;
    correlationId?: string | null;
  }): void {
    this.securityEvents.push({
      timestamp: new Date().toISOString(),
      category: event.category,
      correlationId: event.correlationId ?? null,
      deviceId: event.deviceId ?? null,
      statusCode: event.statusCode ?? null,
      outcome: event.outcome,
      detail: event.detail.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 240),
    });
    if (this.securityEvents.length > MAX_SECURITY_EVENTS) {
      this.securityEvents.splice(0, this.securityEvents.length - MAX_SECURITY_EVENTS);
    }
  }

  getRecentSecurityEvents(): SecurityAuditEvent[] {
    return [...this.securityEvents];
  }

  getLastInvitationState(): InvitationLifecycleState | null {
    this.pruneExpiredState();
    return this.activeInvitation ? this.activeInvitation.lifecycleState : this.lastInvitationState;
  }

  hasOpenEnrollment(): boolean {
    this.pruneExpiredState();
    return Boolean(this.activeInvitation && !this.activeInvitation.used);
  }

  createInvitation(params: {
    hostId: string;
    hostDisplayName: string;
    shortFingerprint: string;
    fullFingerprint?: string;
    listenAddresses: string[];
    port: number;
    autoApproveSingleUse?: boolean;
    ttlMs?: number;
  }): EnrollmentInvitationSummary {
    this.pruneExpiredState();

    // Regenerating an invitation immediately invalidates prior active invitation & pending approvals
    if (this.activeInvitation) {
      this.invalidatePendingRequestsForInvitation(this.activeInvitation.invitationId, 'expired');
    } else {
      this.invalidateAllPendingRequests('expired');
    }

    const now = Date.now();
    const ttl = Math.max(10_000, Math.min(30 * 60_000, params.ttlMs ?? CONNECT_INVITATION_TTL_MS));
    const rawCode = generateRandomInviteCode();
    const normalizedForHash = normalizeInviteCodeInput(rawCode);
    const salt = crypto.randomBytes(16).toString('hex');
    const invitationId = crypto.randomUUID();
    const createdAtIso = new Date(now).toISOString();
    const expiresAtIso = new Date(now + ttl).toISOString();
    const normalizedFullFp = normalizeFullFingerprint(params.fullFingerprint) ?? '';

    const validAddresses = params.listenAddresses.filter((addr) => isValidLanPairingAddress(addr));
    const endpoints = (validAddresses.length > 0 ? validAddresses : ['127.0.0.1'])
      .slice(0, 8)
      .map((address) => ({
        transport: 'lan-https' as const,
        address,
        port: params.port,
      }));

    let pairingPayload = '';
    if (normalizedFullFp) {
      try {
        pairingPayload = serializePairingPayload({
          protocol: PAIRING_PAYLOAD_PROTOCOL,
          version: PAIRING_PAYLOAD_VERSION,
          hostId: params.hostId.toLowerCase(),
          hostName: sanitizeHostDisplayNameForPairing(params.hostDisplayName) ?? 'DoReMi Host',
          endpoints,
          identityAlgorithm: 'spki-sha256',
          identityFingerprint: normalizedFullFp,
          invitation: rawCode,
          expiresAt: expiresAtIso,
        });
      } catch {
        // Retry with fewer endpoints if payload approached 2KB bound
        pairingPayload = serializePairingPayload({
          protocol: PAIRING_PAYLOAD_PROTOCOL,
          version: PAIRING_PAYLOAD_VERSION,
          hostId: params.hostId.toLowerCase(),
          hostName: sanitizeHostDisplayNameForPairing(params.hostDisplayName) ?? 'DoReMi Host',
          endpoints: endpoints.slice(0, 2),
          identityAlgorithm: 'spki-sha256',
          identityFingerprint: normalizedFullFp,
          invitation: rawCode,
          expiresAt: expiresAtIso,
        });
      }
    }
    const qrDataUrl = pairingPayload ? generateQrSvgDataUrl(pairingPayload) : null;

    this.activeInvitation = {
      invitationId,
      inviteCodeHash: hashWithSalt(normalizedForHash, salt),
      inviteCodeSalt: salt,
      rawInviteCode: rawCode,
      pairingPayload,
      qrDataUrl,
      createdAtMs: now,
      expiresAtMs: now + ttl,
      autoApproveSingleUse: Boolean(params.autoApproveSingleUse),
      used: false,
      lifecycleState: 'ACTIVE',
    };
    this.lastInvitationState = 'ACTIVE';
    this.recordSecurityEvent({
      category: 'invitation_created',
      outcome: 'success',
      detail: 'Tạo mã ghép nối đơn dụng mới (hết hạn tự động sau 5 phút).',
    });

    return {
      invitationId,
      inviteCode: rawCode,
      shortFingerprint: params.shortFingerprint,
      fullFingerprint: normalizedFullFp || params.shortFingerprint,
      hostId: params.hostId,
      hostDisplayName: params.hostDisplayName,
      listenAddresses: params.listenAddresses,
      port: params.port,
      createdAt: createdAtIso,
      expiresAt: expiresAtIso,
      autoApproveSingleUse: Boolean(params.autoApproveSingleUse),
      used: false,
      lifecycleState: 'ACTIVE',
      pairingPayload,
      qrDataUrl,
    };
  }

  getActiveInvitationSummary(params: {
    hostId: string;
    hostDisplayName: string;
    shortFingerprint: string;
    fullFingerprint?: string;
    listenAddresses: string[];
    port: number;
  }): EnrollmentInvitationSummary | null {
    this.pruneExpiredState();
    const inv = this.activeInvitation;
    if (!inv || inv.used) {
      return null;
    }
    const normalizedFullFp = normalizeFullFingerprint(params.fullFingerprint) ?? '';
    return {
      invitationId: inv.invitationId,
      inviteCode: inv.rawInviteCode,
      shortFingerprint: params.shortFingerprint,
      fullFingerprint: normalizedFullFp || params.shortFingerprint,
      hostId: params.hostId,
      hostDisplayName: params.hostDisplayName,
      listenAddresses: params.listenAddresses,
      port: params.port,
      createdAt: new Date(inv.createdAtMs).toISOString(),
      expiresAt: new Date(inv.expiresAtMs).toISOString(),
      autoApproveSingleUse: inv.autoApproveSingleUse,
      used: inv.used,
      lifecycleState: inv.lifecycleState,
      pairingPayload: inv.pairingPayload,
      qrDataUrl: inv.qrDataUrl,
    };
  }

  revokeActiveInvitation(): void {
    const prevId = this.activeInvitation?.invitationId ?? null;
    this.activeInvitation = null;
    this.lastInvitationState = 'CANCELED';
    if (prevId) {
      this.invalidatePendingRequestsForInvitation(prevId, 'expired');
    } else {
      this.invalidateAllPendingRequests('expired');
    }
    this.recordSecurityEvent({
      category: 'invitation_canceled',
      outcome: 'success',
      detail: 'Đã hủy mã ghép nối hiện tại và vô hiệu hóa các yêu cầu chờ tương ứng.',
    });
  }

  listPendingRequests(): PendingEnrollmentRequest[] {
    this.pruneExpiredState();
    const list: PendingEnrollmentRequest[] = [];
    for (const req of this.pendingRequests.values()) {
      if (req.status === 'pending') {
        list.push({
          requestId: req.requestId,
          invitationId: req.invitationId,
          deviceName: req.deviceName,
          platform: req.platform,
          remoteAddress: req.remoteAddress,
          requestedAt: new Date(req.requestedAtMs).toISOString(),
          expiresAt: new Date(req.expiresAtMs).toISOString(),
          status: req.status,
        });
      }
    }
    return list;
  }

  submitEnrollmentRequest(input: {
    inviteCode: string;
    deviceName: unknown;
    platform: unknown;
    clientNonce: unknown;
    remoteAddress: string;
  }):
    | {
        ok: true;
        status: 'pending' | 'approved';
        requestId: string;
        pollToken: string;
        deviceId?: string;
        deviceToken?: string;
      }
    | {
        ok: false;
        httpStatus: 400 | 401 | 403 | 409 | 429;
        code: string;
        message: string;
      } {
    this.pruneExpiredState();
    const now = Date.now();
    const bucket = this.ipRateLimits.get(input.remoteAddress);
    if (bucket && bucket.lockedUntilMs > now) {
      this.recordSecurityEvent({
        category: 'auth_rate_limited',
        outcome: 'blocked',
        statusCode: 429,
        detail: `Chặn tạm thời yêu cầu ghép nối từ ${input.remoteAddress} do nhập sai quá số lần quy định.`,
      });
      return {
        ok: false,
        httpStatus: 429,
        code: 'RATE_LIMITED',
        message: 'Too many invalid enrollment attempts. Please wait before retrying.',
      };
    }

    const nonce =
      typeof input.clientNonce === 'string' && input.clientNonce.trim().length >= 8
        ? input.clientNonce.trim().slice(0, 128)
        : null;
    if (!nonce) {
      return {
        ok: false,
        httpStatus: 400,
        code: 'INVALID_NONCE',
        message: 'Missing or invalid clientNonce.',
      };
    }
    if (this.usedNonces.has(nonce)) {
      this.recordSecurityEvent({
        category: 'enrollment_replay_blocked',
        outcome: 'blocked',
        statusCode: 409,
        detail: `Phát hiện clientNonce bị gửi lại từ ${input.remoteAddress}.`,
      });
      return {
        ok: false,
        httpStatus: 409,
        code: 'REPLAY_DETECTED',
        message: 'Enrollment nonce has already been used.',
      };
    }

    const inv = this.activeInvitation;
    if (!inv || inv.used || inv.expiresAtMs <= now) {
      this.recordRateLimitedFailure(
        this.ipRateLimits,
        input.remoteAddress,
        now,
        ENROLL_WINDOW_MS,
        MAX_FAILED_ENROLL_ATTEMPTS,
        ENROLL_LOCKOUT_MS,
      );
      this.recordSecurityEvent({
        category: 'enrollment_expired',
        outcome: 'blocked',
        statusCode: 403,
        detail: `Từ chối ghép nối từ ${input.remoteAddress} vì mã ghép nối không tồn tại, đã dùng hoặc hết hạn.`,
      });
      return {
        ok: false,
        httpStatus: 403,
        code: 'ENROLLMENT_EXPIRED',
        message: 'No active single-use enrollment invitation is open on this Host.',
      };
    }

    const normalizedCandidate = normalizeInviteCodeInput(
      typeof input.inviteCode === 'string' ? input.inviteCode : '',
    );
    if (normalizedCandidate.length < 8) {
      this.recordRateLimitedFailure(
        this.ipRateLimits,
        input.remoteAddress,
        now,
        ENROLL_WINDOW_MS,
        MAX_FAILED_ENROLL_ATTEMPTS,
        ENROLL_LOCKOUT_MS,
      );
      return {
        ok: false,
        httpStatus: 401,
        code: 'INVALID_INVITE',
        message: 'Invalid invitation code.',
      };
    }

    const candidateHash = hashWithSalt(normalizedCandidate, inv.inviteCodeSalt);
    if (!constantTimeHexEqual(candidateHash, inv.inviteCodeHash)) {
      this.recordRateLimitedFailure(
        this.ipRateLimits,
        input.remoteAddress,
        now,
        ENROLL_WINDOW_MS,
        MAX_FAILED_ENROLL_ATTEMPTS,
        ENROLL_LOCKOUT_MS,
      );
      this.recordSecurityEvent({
        category: 'auth_failed',
        outcome: 'blocked',
        statusCode: 401,
        detail: `Từ chối ghép nối từ ${input.remoteAddress} do sai mã mời.`,
      });
      return {
        ok: false,
        httpStatus: 401,
        code: 'INVALID_INVITE',
        message: 'Invalid invitation code.',
      };
    }

    // Consume invitation single-use + nonce immediately to defeat concurrent replay
    inv.used = true;
    inv.lifecycleState = inv.autoApproveSingleUse ? 'CONSUMED' : 'PENDING_APPROVAL';
    this.lastInvitationState = inv.lifecycleState;
    this.usedNonces.set(nonce, now + REPLAY_NONCE_TTL_MS);
    this.ipRateLimits.delete(input.remoteAddress);

    const requestId = crypto.randomUUID();
    const pollToken = crypto.randomBytes(24).toString('base64url');
    const pollTokenHash = hashWithSalt(pollToken, requestId);
    const deviceName = sanitizeClientField(input.deviceName, 'DoReMi Client', 48);
    const platform = sanitizeClientField(input.platform, 'windows', 24);

    if (inv.autoApproveSingleUse) {
      const issued = this.issueDeviceCredentials(deviceName, platform, input.remoteAddress);
      this.recordSecurityEvent({
        category: 'enrollment_approved',
        outcome: 'success',
        statusCode: 200,
        deviceId: issued.deviceId,
        detail: `Ghép nối đơn dụng thành công cho thiết bị "${deviceName}".`,
      });
      return {
        ok: true,
        status: 'approved',
        requestId,
        pollToken,
        deviceId: issued.deviceId,
        deviceToken: issued.deviceToken,
      };
    }

    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      const oldestKey = this.pendingRequests.keys().next().value;
      if (oldestKey) {
        this.pendingRequests.delete(oldestKey);
      }
    }

    this.pendingRequests.set(requestId, {
      requestId,
      invitationId: inv.invitationId,
      deviceName,
      platform,
      remoteAddress: input.remoteAddress,
      clientNonce: nonce,
      pollTokenHash,
      requestedAtMs: now,
      expiresAtMs: Math.min(inv.expiresAtMs + 60_000, now + CONNECT_INVITATION_TTL_MS),
      status: 'pending',
      issuedCredentials: null,
    });
    this.recordSecurityEvent({
      category: 'enrollment_submitted',
      outcome: 'success',
      statusCode: 202,
      detail: `Nhận yêu cầu ghép nối chờ phê duyệt từ "${deviceName}".`,
    });

    return {
      ok: true,
      status: 'pending',
      requestId,
      pollToken,
    };
  }

  approveEnrollmentRequest(requestId: string): boolean {
    this.pruneExpiredState();
    const req = this.pendingRequests.get(requestId);
    if (!req || req.status !== 'pending') {
      return false;
    }
    const issued = this.issueDeviceCredentials(req.deviceName, req.platform, req.remoteAddress);
    req.status = 'approved';
    req.issuedCredentials = issued;
    if (this.activeInvitation && this.activeInvitation.invitationId === req.invitationId) {
      this.activeInvitation.lifecycleState = 'CONSUMED';
    }
    this.lastInvitationState = 'CONSUMED';
    this.recordSecurityEvent({
      category: 'enrollment_approved',
      outcome: 'success',
      statusCode: 200,
      deviceId: issued.deviceId,
      detail: `Người dùng đã phê duyệt thiết bị "${req.deviceName}".`,
    });
    return true;
  }

  rejectEnrollmentRequest(requestId: string): boolean {
    this.pruneExpiredState();
    const req = this.pendingRequests.get(requestId);
    if (!req || req.status !== 'pending') {
      return false;
    }
    req.status = 'rejected';
    req.issuedCredentials = null;
    if (this.activeInvitation && this.activeInvitation.invitationId === req.invitationId) {
      this.activeInvitation.lifecycleState = 'REJECTED';
    }
    this.lastInvitationState = 'REJECTED';
    this.recordSecurityEvent({
      category: 'enrollment_rejected',
      outcome: 'blocked',
      statusCode: 403,
      detail: `Người dùng đã từ chối yêu cầu ghép nối từ "${req.deviceName}".`,
    });
    return true;
  }

  pollEnrollmentRequest(
    requestId: string,
    pollToken: string,
    remoteIp: string = 'unknown',
  ):
    | {
        ok: true;
        status: 'pending' | 'approved' | 'rejected' | 'expired';
        deviceId?: string;
        deviceToken?: string;
      }
    | { ok: false; httpStatus: 403 | 404 | 429; code: string; message: string } {
    this.pruneExpiredState();
    const now = Date.now();
    const pollKey = `${remoteIp}::${requestId}`;
    const pollBucket = this.pollRateLimits.get(pollKey);
    if (pollBucket && pollBucket.lockedUntilMs > now) {
      return {
        ok: false,
        httpStatus: 429,
        code: 'RATE_LIMITED',
        message: 'Too many invalid enrollment poll attempts.',
      };
    }

    const req = this.pendingRequests.get(requestId);
    if (!req) {
      this.recordRateLimitedFailure(
        this.pollRateLimits,
        pollKey,
        now,
        POLL_WINDOW_MS,
        MAX_FAILED_POLL_ATTEMPTS,
        POLL_LOCKOUT_MS,
      );
      return {
        ok: false,
        httpStatus: 404,
        code: 'ENROLLMENT_NOT_FOUND',
        message: 'Enrollment request not found or expired.',
      };
    }

    const candidateHash = hashWithSalt(pollToken || '', req.requestId);
    if (!constantTimeHexEqual(candidateHash, req.pollTokenHash)) {
      this.recordRateLimitedFailure(
        this.pollRateLimits,
        pollKey,
        now,
        POLL_WINDOW_MS,
        MAX_FAILED_POLL_ATTEMPTS,
        POLL_LOCKOUT_MS,
      );
      this.recordSecurityEvent({
        category: 'auth_failed',
        outcome: 'blocked',
        statusCode: 403,
        detail: `Từ chối poll yêu cầu ghép nối từ ${remoteIp} do pollToken không hợp lệ.`,
      });
      return {
        ok: false,
        httpStatus: 403,
        code: 'FORBIDDEN',
        message: 'Invalid poll token.',
      };
    }

    this.pollRateLimits.delete(pollKey);

    if (req.status === 'approved' && req.issuedCredentials) {
      const creds = req.issuedCredentials;
      // Credential handoff is strictly single-delivery
      req.issuedCredentials = null;
      this.pendingRequests.delete(requestId);
      return {
        ok: true,
        status: 'approved',
        deviceId: creds.deviceId,
        deviceToken: creds.deviceToken,
      };
    }

    if (req.status === 'rejected' || req.status === 'expired') {
      const status = req.status;
      this.pendingRequests.delete(requestId);
      return { ok: true, status };
    }

    return { ok: true, status: 'pending' };
  }

  verifyBearerToken(
    authHeader: string | undefined,
    remoteIp: string | null,
  ):
    | { ok: true; device: StoredDeviceAuthRow }
    | { ok: false; httpStatus: 401 | 403 | 429; code: string; message: string } {
    this.pruneExpiredState();
    const now = Date.now();
    const rateKey = remoteIp || 'unknown';
    const authBucket = this.authRateLimits.get(rateKey);
    if (authBucket && authBucket.lockedUntilMs > now) {
      return {
        ok: false,
        httpStatus: 429,
        code: 'RATE_LIMITED',
        message: 'Too many authentication failures. Please wait before retrying.',
      };
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      this.recordRateLimitedFailure(
        this.authRateLimits,
        rateKey,
        now,
        AUTH_WINDOW_MS,
        MAX_FAILED_AUTH_ATTEMPTS,
        AUTH_LOCKOUT_MS,
      );
      return {
        ok: false,
        httpStatus: 401,
        code: 'AUTH_FAILED',
        message: 'Missing Bearer authentication token.',
      };
    }

    const rawToken = authHeader.slice('Bearer '.length).trim();
    // Scoped remote tokens (`r1.<deviceId>.<secret>`) are strictly restricted to Remote Gateway,
    // never interchangeable with LAN credentials.
    if (rawToken.startsWith(CONNECT_REMOTE_TOKEN_PREFIX)) {
      return {
        ok: false,
        httpStatus: 401,
        code: 'AUTH_FAILED',
        message: 'Scoped Remote token cannot be used on LAN Direct endpoint.',
      };
    }

    const dotIdx = rawToken.indexOf('.');
    if (dotIdx <= 0 || dotIdx === rawToken.length - 1) {
      this.recordRateLimitedFailure(
        this.authRateLimits,
        rateKey,
        now,
        AUTH_WINDOW_MS,
        MAX_FAILED_AUTH_ATTEMPTS,
        AUTH_LOCKOUT_MS,
      );
      return {
        ok: false,
        httpStatus: 401,
        code: 'AUTH_FAILED',
        message: 'Malformed device token.',
      };
    }

    const deviceId = rawToken.slice(0, dotIdx);
    const secret = rawToken.slice(dotIdx + 1);
    if (this.revokedDeviceIds.has(deviceId)) {
      return {
        ok: false,
        httpStatus: 403,
        code: 'ACCESS_REVOKED',
        message: 'Device access has been revoked by the Host.',
      };
    }

    const device = this.getDeviceAuthFast(deviceId, now);
    if (!device) {
      this.recordRateLimitedFailure(
        this.authRateLimits,
        rateKey,
        now,
        AUTH_WINDOW_MS,
        MAX_FAILED_AUTH_ATTEMPTS,
        AUTH_LOCKOUT_MS,
      );
      return {
        ok: false,
        httpStatus: 401,
        code: 'AUTH_FAILED',
        message: 'Unknown device credential.',
      };
    }

    if (device.authState === 'revoked') {
      this.revokedDeviceIds.add(device.deviceId);
      return {
        ok: false,
        httpStatus: 403,
        code: 'ACCESS_REVOKED',
        message: 'Device access has been revoked by the Host.',
      };
    }

    const expectedHash = hashWithSalt(secret, device.tokenSalt);
    if (!constantTimeHexEqual(expectedHash, device.tokenHash)) {
      const grace = this.lanRotationGrace.get(device.deviceId);
      const matchesGrace =
        grace &&
        grace.expiresAtMs > now &&
        constantTimeHexEqual(hashWithSalt(secret, grace.prevSalt), grace.prevHash);
      if (!matchesGrace) {
        this.recordRateLimitedFailure(
          this.authRateLimits,
          rateKey,
          now,
          AUTH_WINDOW_MS,
          MAX_FAILED_AUTH_ATTEMPTS,
          AUTH_LOCKOUT_MS,
        );
        this.recordSecurityEvent({
          category: 'auth_failed',
          outcome: 'blocked',
          statusCode: 401,
          deviceId: device.deviceId,
          detail: `Xác thực thiết bị từ ${rateKey} thất bại do token không khớp.`,
        });
        return {
          ok: false,
          httpStatus: 401,
          code: 'AUTH_FAILED',
          message: 'Invalid device authentication token.',
        };
      }
    } else {
      this.lanRotationGrace.delete(device.deviceId);
    }

    this.authRateLimits.delete(rateKey);
    this.touchDeviceActivityThrottled(device.deviceId, remoteIp, now);
    return { ok: true, device };
  }

  /**
   * Verifies a scoped Remote HTTPS Bearer credential (`Bearer r1.<deviceId>.<secret>`).
   * Rejects LAN tokens, revoked devices, and devices without explicit `remoteAccessEnabled`.
   */
  verifyRemoteBearerToken(
    authHeader: string | undefined,
    rateLimitBucketKey: string = 'remote-gateway',
  ):
    | { ok: true; device: StoredDeviceAuthRow }
    | { ok: false; httpStatus: 401 | 403 | 429; code: string; message: string } {
    this.pruneExpiredState();
    const now = Date.now();
    const authBucket = this.authRateLimits.get(rateLimitBucketKey);
    if (authBucket && authBucket.lockedUntilMs > now) {
      return {
        ok: false,
        httpStatus: 429,
        code: 'RATE_LIMITED',
        message: 'Too many authentication failures on Remote Gateway.',
      };
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      this.recordRateLimitedFailure(
        this.authRateLimits,
        rateLimitBucketKey,
        now,
        AUTH_WINDOW_MS,
        MAX_FAILED_AUTH_ATTEMPTS,
        AUTH_LOCKOUT_MS,
      );
      return {
        ok: false,
        httpStatus: 401,
        code: 'AUTH_FAILED',
        message: 'Missing Remote Bearer authentication token.',
      };
    }

    const rawToken = authHeader.slice('Bearer '.length).trim();
    if (!rawToken.startsWith(CONNECT_REMOTE_TOKEN_PREFIX)) {
      this.recordRateLimitedFailure(
        this.authRateLimits,
        rateLimitBucketKey,
        now,
        AUTH_WINDOW_MS,
        MAX_FAILED_AUTH_ATTEMPTS,
        AUTH_LOCKOUT_MS,
      );
      this.recordSecurityEvent({
        category: 'auth_failed',
        outcome: 'blocked',
        statusCode: 403,
        detail: 'Từ chối yêu cầu Remote HTTPS do sử dụng token LAN hoặc sai định dạng Remote token.',
      });
      return {
        ok: false,
        httpStatus: 403,
        code: 'REMOTE_ACCESS_NOT_GRANTED',
        message: 'Remote HTTPS requires a scoped Remote Access credential.',
      };
    }

    const withoutPrefix = rawToken.slice(CONNECT_REMOTE_TOKEN_PREFIX.length);
    const dotIdx = withoutPrefix.indexOf('.');
    if (dotIdx <= 0 || dotIdx === withoutPrefix.length - 1) {
      this.recordRateLimitedFailure(
        this.authRateLimits,
        rateLimitBucketKey,
        now,
        AUTH_WINDOW_MS,
        MAX_FAILED_AUTH_ATTEMPTS,
        AUTH_LOCKOUT_MS,
      );
      return {
        ok: false,
        httpStatus: 401,
        code: 'AUTH_FAILED',
        message: 'Malformed Remote credential.',
      };
    }

    const deviceId = withoutPrefix.slice(0, dotIdx);
    const secret = withoutPrefix.slice(dotIdx + 1);
    if (this.revokedDeviceIds.has(deviceId)) {
      return {
        ok: false,
        httpStatus: 403,
        code: 'ACCESS_REVOKED',
        message: 'Device access has been revoked by the Host.',
      };
    }

    const device = this.getDeviceAuthFast(deviceId, now);
    if (!device) {
      this.recordRateLimitedFailure(
        this.authRateLimits,
        rateLimitBucketKey,
        now,
        AUTH_WINDOW_MS,
        MAX_FAILED_AUTH_ATTEMPTS,
        AUTH_LOCKOUT_MS,
      );
      return {
        ok: false,
        httpStatus: 401,
        code: 'AUTH_FAILED',
        message: 'Unknown device credential.',
      };
    }

    if (device.authState === 'revoked') {
      this.revokedDeviceIds.add(device.deviceId);
      return {
        ok: false,
        httpStatus: 403,
        code: 'ACCESS_REVOKED',
        message: 'Device access has been revoked by the Host.',
      };
    }

    if (!device.remoteAccessEnabled || !device.remoteTokenHash || !device.remoteTokenSalt) {
      return {
        ok: false,
        httpStatus: 403,
        code: 'REMOTE_ACCESS_NOT_GRANTED',
        message: 'Remote Access permission is not enabled for this device.',
      };
    }

    const expectedHash = hashWithSalt(secret, device.remoteTokenSalt);
    if (!constantTimeHexEqual(expectedHash, device.remoteTokenHash)) {
      const grace = this.remoteRotationGrace.get(device.deviceId);
      const matchesGrace =
        grace &&
        grace.expiresAtMs > now &&
        constantTimeHexEqual(hashWithSalt(secret, grace.prevSalt), grace.prevHash);
      if (!matchesGrace) {
        this.recordRateLimitedFailure(
          this.authRateLimits,
          rateLimitBucketKey,
          now,
          AUTH_WINDOW_MS,
          MAX_FAILED_AUTH_ATTEMPTS,
          AUTH_LOCKOUT_MS,
        );
        this.recordSecurityEvent({
          category: 'auth_failed',
          outcome: 'blocked',
          statusCode: 401,
          deviceId: device.deviceId,
          detail: 'Xác thực Remote HTTPS thất bại do Remote token không khớp.',
        });
        return {
          ok: false,
          httpStatus: 401,
          code: 'AUTH_FAILED',
          message: 'Invalid Remote authentication token.',
        };
      }
    } else {
      this.remoteRotationGrace.delete(device.deviceId);
    }

    this.authRateLimits.delete(rateLimitBucketKey);
    this.touchDeviceActivityThrottled(device.deviceId, null, now);
    return { ok: true, device };
  }

  private getDeviceAuthFast(deviceId: string, now = Date.now()): StoredDeviceAuthRow | null {
    if (this.revokedDeviceIds.has(deviceId)) {
      return null;
    }
    const cached = this.deviceAuthCache.get(deviceId);
    if (cached && now - cached.cachedAtMs < DEVICE_AUTH_CACHE_TTL_MS) {
      return cached.row;
    }
    const fresh = this.connectRepo.findDeviceById(deviceId);
    if (!fresh) {
      this.deviceAuthCache.delete(deviceId);
      return null;
    }
    if (fresh.authState === 'revoked') {
      this.revokedDeviceIds.add(deviceId);
      this.deviceAuthCache.delete(deviceId);
      return fresh;
    }
    if (this.deviceAuthCache.size >= 64) {
      const oldest = this.deviceAuthCache.keys().next().value;
      if (oldest !== undefined) {
        this.deviceAuthCache.delete(oldest);
      }
    }
    this.deviceAuthCache.set(deviceId, { row: fresh, cachedAtMs: now });
    return fresh;
  }

  invalidateDeviceCache(deviceId?: string): void {
    if (deviceId) {
      this.deviceAuthCache.delete(deviceId);
    } else {
      this.deviceAuthCache.clear();
    }
  }

  private touchDeviceActivityThrottled(
    deviceId: string,
    remoteIp: string | null,
    now = Date.now(),
  ): void {
    const state = this.activityThrottle.get(deviceId);
    const ipChanged = Boolean(remoteIp && state && remoteIp !== state.lastFlushedIp);
    if (!state || ipChanged || now - state.lastFlushedAtMs >= ACTIVITY_WRITE_THROTTLE_MS) {
      this.connectRepo.touchDeviceActivity(deviceId, remoteIp);
      this.activityThrottle.set(deviceId, {
        lastFlushedAtMs: now,
        lastFlushedIp: remoteIp ?? state?.lastFlushedIp ?? null,
        pendingTouchAtMs: null,
        pendingIp: null,
      });
      return;
    }
    state.pendingTouchAtMs = now;
    if (remoteIp) {
      state.pendingIp = remoteIp;
    }
  }

  flushPendingDeviceActivity(deviceId?: string): void {
    if (deviceId) {
      const st = this.activityThrottle.get(deviceId);
      if (st && st.pendingTouchAtMs !== null && !this.revokedDeviceIds.has(deviceId)) {
        try {
          this.connectRepo.touchDeviceActivity(deviceId, st.pendingIp ?? st.lastFlushedIp);
        } catch {
          // Ignore if DB already closed during shutdown
        }
        st.lastFlushedAtMs = st.pendingTouchAtMs;
        st.pendingTouchAtMs = null;
      }
      return;
    }
    for (const [id, st] of this.activityThrottle.entries()) {
      if (st.pendingTouchAtMs !== null && !this.revokedDeviceIds.has(id)) {
        try {
          this.connectRepo.touchDeviceActivity(id, st.pendingIp ?? st.lastFlushedIp);
        } catch {
          // Ignore if DB already closed during shutdown
        }
        st.lastFlushedAtMs = st.pendingTouchAtMs;
        st.pendingTouchAtMs = null;
      }
    }
  }

  rotateDeviceToken(
    deviceId: string,
    options?: { allowInterruptedRecoveryGrace?: boolean },
  ): { deviceId: string; deviceToken: string; rotatedAt: string } | null {
    if (this.revokedDeviceIds.has(deviceId)) {
      return null;
    }
    const existing = this.connectRepo.findDeviceById(deviceId);
    if (!existing || existing.authState !== 'authorized') {
      return null;
    }
    if (options?.allowInterruptedRecoveryGrace && existing.tokenHash && existing.tokenSalt) {
      this.lanRotationGrace.set(deviceId, {
        prevHash: existing.tokenHash,
        prevSalt: existing.tokenSalt,
        expiresAtMs: Date.now() + ROTATION_GRACE_MS,
      });
    } else {
      this.lanRotationGrace.delete(deviceId);
    }
    const secret = crypto.randomBytes(32).toString('base64url');
    const tokenSalt = crypto.randomBytes(16).toString('hex');
    const tokenHash = hashWithSalt(secret, tokenSalt);
    const updated = this.connectRepo.updateDeviceTokenHash(deviceId, tokenHash, tokenSalt);
    if (!updated) {
      return null;
    }
    this.invalidateDeviceCache(deviceId);
    this.recordSecurityEvent({
      category: 'credential_rotated',
      outcome: 'success',
      statusCode: 200,
      deviceId,
      detail: `Đã xoay vòng (rotate) token xác thực cho thiết bị "${existing.displayName}".`,
    });
    return {
      deviceId,
      deviceToken: `${deviceId}.${secret}`,
      rotatedAt: new Date().toISOString(),
    };
  }

  setDeviceRemoteAccess(deviceId: string, enabled: boolean): boolean {
    if (this.revokedDeviceIds.has(deviceId)) {
      return false;
    }
    const existing = this.connectRepo.findDeviceById(deviceId);
    if (!existing || (enabled && existing.authState !== 'authorized')) {
      return false;
    }
    this.remoteRotationGrace.delete(deviceId);
    const ok = this.connectRepo.setDeviceRemoteAccess(deviceId, enabled);
    this.invalidateDeviceCache(deviceId);
    if (!enabled) {
      this.onDeviceRemoteRevoked?.(deviceId);
    }
    if (ok) {
      this.recordSecurityEvent({
        category: 'remote_permission_changed',
        outcome: 'success',
        deviceId,
        detail: enabled
          ? `Đã bật quyền truy cập từ xa (Remote HTTPS) cho thiết bị "${existing.displayName}".`
          : `Đã thu hồi quyền truy cập từ xa (Remote HTTPS) của thiết bị "${existing.displayName}" (giữ nguyên quyền LAN).`,
      });
    }
    return ok;
  }

  issueOrRotateRemoteToken(
    deviceId: string,
    options?: { allowInterruptedRecoveryGrace?: boolean },
  ): { deviceId: string; remoteToken: string; issuedAt: string } | null {
    if (this.revokedDeviceIds.has(deviceId)) {
      return null;
    }
    const existing = this.connectRepo.findDeviceById(deviceId);
    if (!existing || existing.authState !== 'authorized' || !existing.remoteAccessEnabled) {
      return null;
    }
    if (
      options?.allowInterruptedRecoveryGrace &&
      existing.remoteTokenHash &&
      existing.remoteTokenSalt
    ) {
      this.remoteRotationGrace.set(deviceId, {
        prevHash: existing.remoteTokenHash,
        prevSalt: existing.remoteTokenSalt,
        expiresAtMs: Date.now() + ROTATION_GRACE_MS,
      });
    } else {
      this.remoteRotationGrace.delete(deviceId);
    }
    const secret = crypto.randomBytes(32).toString('base64url');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashWithSalt(secret, salt);
    const ok = this.connectRepo.updateDeviceRemoteTokenHash(deviceId, hash, salt);
    if (!ok) {
      return null;
    }
    this.invalidateDeviceCache(deviceId);
    this.recordSecurityEvent({
      category: 'credential_rotated',
      outcome: 'success',
      statusCode: 200,
      deviceId,
      detail: `Đã cấp/xoay vòng Remote HTTPS token cho thiết bị "${existing.displayName}".`,
    });
    return {
      deviceId,
      remoteToken: `${CONNECT_REMOTE_TOKEN_PREFIX}${deviceId}.${secret}`,
      issuedAt: new Date().toISOString(),
    };
  }

  revokeDevice(deviceId: string): boolean {
    const existing = this.connectRepo.findDeviceById(deviceId);
    this.revokedDeviceIds.add(deviceId);
    this.invalidateDeviceCache(deviceId);
    this.activityThrottle.delete(deviceId);
    this.lanRotationGrace.delete(deviceId);
    this.remoteRotationGrace.delete(deviceId);
    const ok = this.connectRepo.revokeDevice(deviceId);
    this.onDeviceRevoked?.(deviceId);
    if (ok) {
      this.recordSecurityEvent({
        category: 'device_revoked',
        outcome: 'success',
        statusCode: 403,
        deviceId,
        detail: `Đã thu hồi quyền truy cập thiết bị "${existing?.displayName ?? deviceId}".`,
      });
    }
    return ok;
  }

  removeDevice(deviceId: string): boolean {
    const existing = this.connectRepo.findDeviceById(deviceId);
    this.revokedDeviceIds.add(deviceId);
    this.invalidateDeviceCache(deviceId);
    this.activityThrottle.delete(deviceId);
    this.lanRotationGrace.delete(deviceId);
    this.remoteRotationGrace.delete(deviceId);
    this.onDeviceRevoked?.(deviceId);
    const ok = this.connectRepo.removeDevice(deviceId);
    if (ok) {
      this.recordSecurityEvent({
        category: 'device_removed',
        outcome: 'success',
        deviceId,
        detail: `Đã xóa thiết bị "${existing?.displayName ?? deviceId}" khỏi danh sách ủy quyền.`,
      });
    }
    return ok;
  }

  clearVolatileState(): void {
    this.flushPendingDeviceActivity();
    this.activityThrottle.clear();
    this.deviceAuthCache.clear();
    this.activeInvitation = null;
    this.pendingRequests.clear();
    this.usedNonces.clear();
    this.ipRateLimits.clear();
    this.pollRateLimits.clear();
    this.authRateLimits.clear();
    this.syncRevokedCacheFromRepo();
  }

  private invalidatePendingRequestsForInvitation(
    invitationId: string,
    nextStatus: 'expired' | 'rejected',
  ): void {
    for (const req of this.pendingRequests.values()) {
      if (req.invitationId === invitationId && req.status === 'pending') {
        req.status = nextStatus;
        req.issuedCredentials = null;
      }
    }
  }

  private invalidateAllPendingRequests(nextStatus: 'expired' | 'rejected'): void {
    for (const req of this.pendingRequests.values()) {
      if (req.status === 'pending') {
        req.status = nextStatus;
        req.issuedCredentials = null;
      }
    }
  }

  private issueDeviceCredentials(
    displayName: string,
    platform: string,
    remoteAddress: string,
  ): { deviceId: string; deviceToken: string } {
    const deviceId = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('base64url');
    const tokenSalt = crypto.randomBytes(16).toString('hex');
    const tokenHash = hashWithSalt(secret, tokenSalt);
    this.revokedDeviceIds.delete(deviceId);
    this.invalidateDeviceCache(deviceId);
    this.connectRepo.insertAuthorizedDevice({
      deviceId,
      displayName,
      platform,
      tokenHash,
      tokenSalt,
      lastIp: remoteAddress,
    });
    return {
      deviceId,
      deviceToken: `${deviceId}.${secret}`,
    };
  }

  private recordRateLimitedFailure(
    map: Map<string, RateLimitBucket>,
    key: string,
    now: number,
    windowMs: number,
    maxAttempts: number,
    lockoutMs: number,
  ): void {
    const prev = map.get(key);
    if (!prev || now - prev.windowStartMs > windowMs) {
      if (map.size >= MAX_RATE_LIMIT_BUCKETS) {
        const oldestKey = map.keys().next().value;
        if (oldestKey) {
          map.delete(oldestKey);
        }
      }
      map.set(key, {
        failedAttempts: 1,
        windowStartMs: now,
        lockedUntilMs: 0,
      });
      return;
    }
    prev.failedAttempts += 1;
    if (prev.failedAttempts >= maxAttempts) {
      prev.lockedUntilMs = now + lockoutMs;
    }
  }

  private pruneExpiredState(): void {
    const now = Date.now();
    if (this.activeInvitation && this.activeInvitation.expiresAtMs <= now) {
      const expiredId = this.activeInvitation.invitationId;
      this.lastInvitationState = 'EXPIRED';
      this.activeInvitation = null;
      this.invalidatePendingRequestsForInvitation(expiredId, 'expired');
    }
    for (const [id, req] of this.pendingRequests.entries()) {
      if (req.status === 'pending' && req.expiresAtMs <= now) {
        req.status = 'expired';
      }
      if (req.status !== 'pending' && now - req.requestedAtMs > 10 * 60_000) {
        this.pendingRequests.delete(id);
      }
    }
    for (const [nonce, exp] of this.usedNonces.entries()) {
      if (exp <= now) {
        this.usedNonces.delete(nonce);
      }
    }
    for (const [ip, bucket] of this.ipRateLimits.entries()) {
      if (bucket.lockedUntilMs <= now && now - bucket.windowStartMs > ENROLL_WINDOW_MS) {
        this.ipRateLimits.delete(ip);
      }
    }
    for (const [key, bucket] of this.pollRateLimits.entries()) {
      if (bucket.lockedUntilMs <= now && now - bucket.windowStartMs > POLL_WINDOW_MS) {
        this.pollRateLimits.delete(key);
      }
    }
    for (const [key, bucket] of this.authRateLimits.entries()) {
      if (bucket.lockedUntilMs <= now && now - bucket.windowStartMs > AUTH_WINDOW_MS) {
        this.authRateLimits.delete(key);
      }
    }
    for (const [devId, g] of this.lanRotationGrace.entries()) {
      if (g.expiresAtMs <= now) {
        this.lanRotationGrace.delete(devId);
      }
    }
    for (const [devId, g] of this.remoteRotationGrace.entries()) {
      if (g.expiresAtMs <= now) {
        this.remoteRotationGrace.delete(devId);
      }
    }
  }
}
