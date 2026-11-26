import fs from 'node:fs';
import path from 'node:path';

export interface SerializedErrorDetail {
  name: string;
  message: string;
  stack?: string;
}

export interface CrashDumpEntry {
  kind: 'uncaughtException' | 'unhandledRejection' | 'render-process-gone' | 'child-process-gone';
  timestamp: string;
  detail: SerializedErrorDetail;
  extra?: Record<string, string | number | boolean | undefined>;
}

const MAX_CRASH_LOG_BYTES = 512 * 1024;
const MAX_FIELD_CHARS = 1500;

function truncateField(value: string, maxChars = MAX_FIELD_CHARS): string {
  const sanitized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').trim();
  if (sanitized.length <= maxChars) {
    return sanitized;
  }
  return `${sanitized.slice(0, maxChars - 1)}…`;
}

export function formatUnexpectedErrorDetail(error: unknown): SerializedErrorDetail {
  if (error instanceof Error) {
    return {
      name: truncateField(error.name || 'Error', 120),
      message: truncateField(error.message || '(empty error message)', 600),
      ...(error.stack ? { stack: truncateField(error.stack, MAX_FIELD_CHARS) } : {}),
    };
  }
  if (typeof error === 'string') {
    return {
      name: 'Error',
      message: truncateField(error, 600) || '(empty error string)',
    };
  }
  try {
    return {
      name: 'NonErrorThrow',
      message: truncateField(JSON.stringify(error) ?? String(error), 600),
    };
  } catch {
    return {
      name: 'NonErrorThrow',
      message: truncateField(String(error), 600),
    };
  }
}

export function isIgnorableAbortError(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') {
    return false;
  }
  const maybeErr = reason as { name?: unknown; code?: unknown };
  return maybeErr.name === 'AbortError' || maybeErr.code === 'ABORT_ERR';
}

/**
 * Synchronously writes a bounded structured crash entry into `<userDataDir>/logs/main-crash.log`
 * with automatic rotation at 512 KB so fatal main/renderer errors are never lost silently.
 */
export function writeBoundedCrashDumpSync(userDataDir: string, entry: CrashDumpEntry): boolean {
  if (!userDataDir || typeof userDataDir !== 'string') {
    return false;
  }
  try {
    const logDir = path.join(userDataDir, 'logs');
    const logFile = path.join(logDir, 'main-crash.log');
    const backupLogFile = path.join(logDir, 'main-crash.1.log');

    fs.mkdirSync(logDir, { recursive: true });
    if (fs.existsSync(logFile)) {
      const stat = fs.statSync(logFile);
      if (stat.size >= MAX_CRASH_LOG_BYTES) {
        fs.rmSync(backupLogFile, { force: true });
        fs.renameSync(logFile, backupLogFile);
      }
    }

    const line = `${JSON.stringify(entry)}\n`;
    fs.appendFileSync(logFile, line, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Prevents unbounded auto-reload loops if a renderer crashes repeatedly.
 * Allows at most 1 automatic recovery per 15-second window.
 */
export function createCrashRecoveryLimiter(cooldownMs = 15_000): {
  canAutoRecover: (nowMs?: number) => boolean;
} {
  let lastRecoveryAt = -Infinity;
  return {
    canAutoRecover(nowMs = Date.now()): boolean {
      if (nowMs - lastRecoveryAt >= cooldownMs) {
        lastRecoveryAt = nowMs;
        return true;
      }
      return false;
    },
  };
}
