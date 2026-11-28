import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface StoredSecretEnvelope {
  encoding: 'dpapi-safe-storage' | 'file-fallback';
  payload: string;
  updatedAt: string;
}

interface SecretsVaultFile {
  version: 1;
  entries: Record<string, StoredSecretEnvelope>;
}

function tryResolveElectronSafeStorage(): SafeStorageLike | null {
  if (!process.versions.electron) {
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronModule = require('electron') as { safeStorage?: SafeStorageLike };
    const storage = electronModule?.safeStorage;
    if (storage && typeof storage.isEncryptionAvailable === 'function') {
      return storage;
    }
  } catch {
    // Outside Electron main GUI (e.g. ELECTRON_RUN_AS_NODE test runner)
  }
  return null;
}

/**
 * Manages encrypted storage of sensitive Host private keys and Client device tokens
 * under `userData/connect/secrets.json` (never inside library.db or SQLite backups).
 * Uses Electron `safeStorage` (Windows DPAPI) whenever available.
 */
export class ConnectSecretStorage {
  private readonly vaultPath: string;
  private readonly safeStorage: SafeStorageLike | null;
  private readonly fallbackKey: Buffer;
  private readonly allowFileFallback: boolean;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: {
    userDataDir: string;
    safeStorage?: SafeStorageLike | null;
    allowFileFallback?: boolean;
  }) {
    const connectDir = path.join(options.userDataDir, 'connect');
    this.vaultPath = path.join(connectDir, 'secrets.json');
    this.safeStorage =
      options.safeStorage !== undefined ? options.safeStorage : tryResolveElectronSafeStorage();
    const isElectronGuiRuntime =
      Boolean(process.versions.electron) && process.env.ELECTRON_RUN_AS_NODE !== '1';
    this.allowFileFallback =
      options.allowFileFallback !== undefined ? options.allowFileFallback : !isElectronGuiRuntime;
    // Machine/userData-bound fallback AES-256-GCM key used strictly when allowFileFallback=true
    // (e.g. headless Node/ELECTRON_RUN_AS_NODE test runner), never silently in Electron Main GUI.
    this.fallbackKey = crypto
      .createHash('sha256')
      .update(`doremi-connect-vault::${path.resolve(options.userDataDir)}`)
      .digest();
  }

  getStorageBackend(): 'electron-safe-storage' | 'file-fallback' | 'unavailable' {
    try {
      if (this.safeStorage && this.safeStorage.isEncryptionAvailable()) {
        return 'electron-safe-storage';
      }
    } catch {
      // Ignore query failure
    }
    return this.allowFileFallback ? 'file-fallback' : 'unavailable';
  }

  isOsEncryptionAvailable(): boolean {
    try {
      return Boolean(this.safeStorage && this.safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  private readVaultSync(): SecretsVaultFile {
    try {
      if (!fs.existsSync(this.vaultPath)) {
        return { version: 1, entries: {} };
      }
      const raw = fs.readFileSync(this.vaultPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SecretsVaultFile>;
      if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
        return { version: 1, entries: { ...parsed.entries } };
      }
    } catch {
      // Corrupt vault treated as empty without crashing local playback
    }
    return { version: 1, entries: {} };
  }

  private async writeVaultAtomic(vault: SecretsVaultFile): Promise<void> {
    const dir = path.dirname(this.vaultPath);
    await fsPromises.mkdir(dir, { recursive: true });
    const tmpPath = `${this.vaultPath}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    await fsPromises.writeFile(tmpPath, JSON.stringify(vault, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fsPromises.rename(tmpPath, this.vaultPath);
  }

  private encryptValue(plaintext: string): StoredSecretEnvelope {
    const now = new Date().toISOString();
    const backend = this.getStorageBackend();
    if (backend === 'electron-safe-storage' && this.safeStorage) {
      const cipherBuf = this.safeStorage.encryptString(plaintext);
      return {
        encoding: 'dpapi-safe-storage',
        payload: cipherBuf.toString('base64'),
        updatedAt: now,
      };
    }

    if (!this.allowFileFallback) {
      throw new Error(
        'Không thể lưu thông tin bảo mật DoReMi Connect vì hệ thống mã hóa an toàn của Windows (OS safeStorage) hiện không khả dụng.',
      );
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.fallbackKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      encoding: 'file-fallback',
      payload: Buffer.concat([iv, tag, encrypted]).toString('base64'),
      updatedAt: now,
    };
  }

  private decryptValue(envelope: StoredSecretEnvelope): string | null {
    try {
      const raw = Buffer.from(envelope.payload, 'base64');
      if (envelope.encoding === 'dpapi-safe-storage') {
        if (!this.safeStorage) {
          return null;
        }
        return this.safeStorage.decryptString(raw);
      }
      if (!this.allowFileFallback) {
        return null;
      }
      if (raw.length < 28) {
        return null;
      }
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const ciphertext = raw.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.fallbackKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  async setSecret(key: string, plaintext: string): Promise<void> {
    const next = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        const vault = this.readVaultSync();
        vault.entries[key] = this.encryptValue(plaintext);
        await this.writeVaultAtomic(vault);
      });
    this.writeChain = next;
    await next;
  }

  getSecret(key: string): string | null {
    const vault = this.readVaultSync();
    const entry = vault.entries[key];
    if (!entry) {
      return null;
    }
    return this.decryptValue(entry);
  }

  async deleteSecret(key: string): Promise<void> {
    const next = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        const vault = this.readVaultSync();
        if (key in vault.entries) {
          delete vault.entries[key];
          await this.writeVaultAtomic(vault);
        }
      });
    this.writeChain = next;
    await next;
  }
}
