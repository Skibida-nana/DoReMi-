import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { HostIdentityPublicInfo } from '../../../shared/types/connect';
import type { ConnectSecretStorage } from './secret-storage';
import { computeCertSpkiFingerprint, generateSelfSignedHostCertificate } from './x509-cert';

const HOST_PRIVATE_KEY_SECRET = 'host.tls.privateKeyPem';

export interface LoadedHostIdentity {
  hostId: string;
  certificatePem: string;
  privateKeyPem: string;
  fingerprintSha256: string;
  shortFingerprint: string;
  createdAt: string;
  storageBackend: 'electron-safe-storage' | 'file-fallback' | 'unavailable';
}

interface HostCertDiskRecord {
  version: 1;
  certificatePem: string;
  createdAt: string;
}

/**
 * Manages the Host's persistent cryptographic TLS identity (ECDSA P-256 certificate + encrypted private key).
 * Validates certificate/key consistency on load and cleanly recovers or replaces corrupted records.
 */
export class HostIdentityService {
  private readonly certPath: string;
  private readonly secrets: ConnectSecretStorage;
  private cached: LoadedHostIdentity | null = null;
  private cachedPublicInfo: HostIdentityPublicInfo | null = null;
  private checkedMissing = false;

  constructor(options: { userDataDir: string; secrets: ConnectSecretStorage }) {
    this.certPath = path.join(options.userDataDir, 'connect', 'host-cert.json');
    this.secrets = options.secrets;
  }

  async ensureIdentity(displayName = 'DoReMi Host'): Promise<LoadedHostIdentity> {
    if (this.cached) {
      return this.cached;
    }

    const existing = this.tryLoadExisting();
    if (existing) {
      this.cached = existing;
      this.cachedPublicInfo = {
        hostId: existing.hostId,
        fingerprintSha256: existing.fingerprintSha256,
        shortFingerprint: existing.shortFingerprint,
        createdAt: existing.createdAt,
        storageBackend: existing.storageBackend,
      };
      this.checkedMissing = false;
      return existing;
    }

    return this.rotateIdentity(displayName);
  }

  /**
   * Releases the decrypted private key PEM from in-memory cache when Host is STOPPED,
   * while retaining the non-sensitive public fingerprint summary so repeated STOPPED snapshots
   * perform zero filesystem or DPAPI decryption work.
   */
  releasePrivateKeyFromMemory(): void {
    if (this.cached) {
      this.cachedPublicInfo = {
        hostId: this.cached.hostId,
        fingerprintSha256: this.cached.fingerprintSha256,
        shortFingerprint: this.cached.shortFingerprint,
        createdAt: this.cached.createdAt,
        storageBackend: this.cached.storageBackend,
      };
      this.cached = null;
    }
  }

  getPublicInfo(): HostIdentityPublicInfo | null {
    if (this.cachedPublicInfo) {
      return { ...this.cachedPublicInfo };
    }
    if (this.cached) {
      this.cachedPublicInfo = {
        hostId: this.cached.hostId,
        fingerprintSha256: this.cached.fingerprintSha256,
        shortFingerprint: this.cached.shortFingerprint,
        createdAt: this.cached.createdAt,
        storageBackend: this.cached.storageBackend,
      };
      return { ...this.cachedPublicInfo };
    }
    if (this.checkedMissing) {
      return null;
    }
    const loaded = this.tryLoadExisting();
    if (!loaded) {
      this.checkedMissing = true;
      return null;
    }
    this.cachedPublicInfo = {
      hostId: loaded.hostId,
      fingerprintSha256: loaded.fingerprintSha256,
      shortFingerprint: loaded.shortFingerprint,
      createdAt: loaded.createdAt,
      storageBackend: loaded.storageBackend,
    };
    return { ...this.cachedPublicInfo };
  }

  async rotateIdentity(displayName = 'DoReMi Host'): Promise<LoadedHostIdentity> {
    const generated = generateSelfSignedHostCertificate(displayName);
    await this.secrets.setSecret(HOST_PRIVATE_KEY_SECRET, generated.privateKeyPem);

    const dir = path.dirname(this.certPath);
    await fsPromises.mkdir(dir, { recursive: true });
    const record: HostCertDiskRecord = {
      version: 1,
      certificatePem: generated.certificatePem,
      createdAt: generated.createdAt,
    };
    const tmp = `${this.certPath}.tmp-${process.pid}`;
    await fsPromises.writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
    await fsPromises.rename(tmp, this.certPath);

    const created: LoadedHostIdentity = {
      hostId: generated.hostId,
      certificatePem: generated.certificatePem,
      privateKeyPem: generated.privateKeyPem,
      fingerprintSha256: generated.spkiFingerprintSha256,
      shortFingerprint: generated.shortFingerprint,
      createdAt: generated.createdAt,
      storageBackend: this.secrets.getStorageBackend(),
    };
    this.cached = created;
    this.cachedPublicInfo = {
      hostId: created.hostId,
      fingerprintSha256: created.fingerprintSha256,
      shortFingerprint: created.shortFingerprint,
      createdAt: created.createdAt,
      storageBackend: created.storageBackend,
    };
    this.checkedMissing = false;
    return created;
  }

  private tryLoadExisting(): LoadedHostIdentity | null {
    try {
      if (!fs.existsSync(this.certPath)) {
        return null;
      }
      const raw = fs.readFileSync(this.certPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<HostCertDiskRecord>;
      if (!parsed || parsed.version !== 1 || typeof parsed.certificatePem !== 'string') {
        return null;
      }
      const privateKeyPem = this.secrets.getSecret(HOST_PRIVATE_KEY_SECRET);
      if (!privateKeyPem) {
        return null;
      }

      // Verify certificate & private key match cryptographically and certificate isn't expired
      const cert = new crypto.X509Certificate(parsed.certificatePem);
      const privObj = crypto.createPrivateKey(privateKeyPem);
      if (!cert.checkPrivateKey(privObj)) {
        return null;
      }
      const expiresMs = Date.parse(cert.validTo);
      if (!Number.isFinite(expiresMs) || expiresMs <= Date.now() + 24 * 60 * 60 * 1000) {
        return null;
      }

      const fp = computeCertSpkiFingerprint(parsed.certificatePem);
      return {
        hostId: fp.hostId,
        certificatePem: parsed.certificatePem,
        privateKeyPem,
        fingerprintSha256: fp.fingerprintSha256,
        shortFingerprint: fp.shortFingerprint,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
        storageBackend: this.secrets.getStorageBackend(),
      };
    } catch {
      return null;
    }
  }
}
