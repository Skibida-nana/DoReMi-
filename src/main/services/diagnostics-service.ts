import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { DiagnosticLogEntry, DiagnosticRecordInput } from '../../shared/types/stage6';

const MAX_IN_MEMORY_ENTRIES = 250;
const MAX_LOG_FILE_BYTES = 512 * 1024;
const MAX_STRING_LEN = 1200;

function sanitizeText(value: unknown, maxLen = MAX_STRING_LEN): string {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = value.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').trim();
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, maxLen - 1)}…`;
}

export interface DiagnosticsServiceOptions {
  userDataDir: string;
  sessionId?: string;
}

/**
 * Bounded, offline structured diagnostic logger scoped to an app session.
 * Maintains an in-memory ring buffer + rotated JSONL log file inside userData/logs/
 * (`<= ~1 MB` max total) without writing sensitive credentials or large payloads.
 */
export class DiagnosticsService {
  readonly sessionId: string;
  private readonly logDir: string;
  private readonly logFilePath: string;
  private readonly backupLogFilePath: string;
  private readonly entries: DiagnosticLogEntry[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: DiagnosticsServiceOptions) {
    this.sessionId =
      options.sessionId ??
      `doremi-${process.pid}-${Date.now().toString(36)}`;
    this.logDir = path.join(options.userDataDir, 'logs');
    this.logFilePath = path.join(this.logDir, 'playback-diagnostics.log');
    this.backupLogFilePath = path.join(this.logDir, 'playback-diagnostics.1.log');
  }

  record(input: DiagnosticRecordInput): DiagnosticLogEntry {
    const level: DiagnosticLogEntry['level'] =
      input.level === 'error' || input.level === 'warn' ? input.level : 'info';

    const entry: DiagnosticLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      scope: sanitizeText(input.scope, 64) || 'app',
      message: sanitizeText(input.message, 500) || '(no message)',
      sessionId: this.sessionId,
      ...(input.code ? { code: sanitizeText(input.code, 64) } : {}),
      ...(input.stage ? { stage: sanitizeText(input.stage, 64) } : {}),
      ...(input.attemptId ? { attemptId: sanitizeText(input.attemptId, 80) } : {}),
      ...(input.detail ? { detail: sanitizeText(input.detail, 1200) } : {}),
    };

    this.entries.push(entry);
    if (this.entries.length > MAX_IN_MEMORY_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_IN_MEMORY_ENTRIES);
    }

    const serializedLine = `${JSON.stringify(entry)}\n`;
    this.writeQueue = this.writeQueue
      .then(() => this.appendLineWithRotation(serializedLine))
      .catch(() => {});

    return entry;
  }

  getRecentEntries(limit = 100): DiagnosticLogEntry[] {
    const bounded = Math.max(1, Math.min(MAX_IN_MEMORY_ENTRIES, Math.floor(limit)));
    return this.entries.slice(-bounded).map((entry) => ({ ...entry }));
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  getLogFilePath(): string {
    return this.logFilePath;
  }

  private async appendLineWithRotation(line: string): Promise<void> {
    fs.mkdirSync(this.logDir, { recursive: true });
    try {
      const stat = await fsPromises.stat(this.logFilePath);
      if (stat.size >= MAX_LOG_FILE_BYTES) {
        await fsPromises.rm(this.backupLogFilePath, { force: true }).catch(() => {});
        await fsPromises.rename(this.logFilePath, this.backupLogFilePath).catch(() => {});
      }
    } catch {
      // Log file does not exist yet
    }
    await fsPromises.appendFile(this.logFilePath, line, 'utf8');
  }
}
