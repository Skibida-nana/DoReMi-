import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const MIN_TAILSCALE_MAJOR = 1;
export const MIN_TAILSCALE_MINOR = 52;
const DEFAULT_CLI_TIMEOUT_MS = 8_000;
const MAX_CLI_OUTPUT_BYTES = 256 * 1024;

export interface TailscaleCliExecResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  errorCode?: string;
}

export interface TailscaleCommandExecutor {
  findExecutable(): string | null;
  exec(
    args: readonly string[],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<TailscaleCliExecResult>;
}

/**
 * Resolves only official fixed Windows installation locations for `tailscale.exe`.
 * Never resolves from current working directory or untrusted user-supplied strings.
 */
export function findOfficialWindowsTailscaleExecutable(
  customCheckExists: (filePath: string) => boolean = (p) => fs.existsSync(p),
): string | null {
  const candidates: string[] = [];
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA;

  candidates.push(path.join(programFiles, 'Tailscale', 'tailscale.exe'));
  candidates.push(path.join(programFilesX86, 'Tailscale', 'tailscale.exe'));
  if (localAppData) {
    candidates.push(path.join(localAppData, 'Tailscale', 'tailscale.exe'));
  }

  for (const candidate of candidates) {
    try {
      const normalized = path.resolve(candidate);
      if (path.basename(normalized).toLowerCase() !== 'tailscale.exe') {
        continue;
      }
      if (customCheckExists(normalized)) {
        return normalized;
      }
    } catch {
      // Ignore inaccessible candidate
    }
  }
  return null;
}

/**
 * Strips auth URLs, keys, or query parameters from Tailscale CLI stderr/stdout before surfacing in diagnostics.
 */
export function sanitizeTailscaleText(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/(?:tskey-[A-Za-z0-9_-]+|authkey=[^\s&]+)/gi, '[redacted-secret]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 400);
}

export function parseTailscaleSemver(rawOutput: string): {
  version: string;
  major: number;
  minor: number;
  patch: number;
} | null {
  if (!rawOutput) return null;
  try {
    const asJson = JSON.parse(rawOutput) as { majorMinorPatch?: string; short?: string };
    const candidate = asJson.majorMinorPatch || asJson.short;
    if (typeof candidate === 'string') {
      const m = candidate.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
      if (m) {
        return {
          version: `${m[1]}.${m[2]}.${m[3]}`,
          major: Number(m[1]),
          minor: Number(m[2]),
          patch: Number(m[3]),
        };
      }
    }
  } catch {
    // Plain text fallback
  }

  const firstLine = rawOutput.split(/\r?\n/)[0]?.trim() ?? '';
  const match = firstLine.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    version: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function isSupportedTailscaleVersion(parsed: { major: number; minor: number } | null): boolean {
  if (!parsed) return false;
  if (parsed.major > MIN_TAILSCALE_MAJOR) return true;
  if (parsed.major < MIN_TAILSCALE_MAJOR) return false;
  return parsed.minor >= MIN_TAILSCALE_MINOR;
}

export interface ParsedTailscaleNodeStatus {
  backendState: string;
  dnsName: string | null;
  magicDnsSuffix: string | null;
  magicDnsEnabled: boolean;
  certDomains: string[];
  httpsCertEnabled: boolean;
  funnelCapPresent: boolean;
}

export function parseTailscaleStatusJson(rawStdout: string): ParsedTailscaleNodeStatus | null {
  try {
    const obj = JSON.parse(rawStdout) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return null;
    }
    const backendState = typeof obj.BackendState === 'string' ? obj.BackendState : 'Unknown';
    const selfObj =
      obj.Self && typeof obj.Self === 'object' ? (obj.Self as Record<string, unknown>) : null;
    const rawDns = typeof selfObj?.DNSName === 'string' ? selfObj.DNSName.trim() : '';
    const dnsName = rawDns ? rawDns.replace(/\.$/, '').toLowerCase() : null;

    const tailnetObj =
      obj.CurrentTailnet && typeof obj.CurrentTailnet === 'object'
        ? (obj.CurrentTailnet as Record<string, unknown>)
        : null;
    const magicDnsSuffix =
      typeof tailnetObj?.MagicDNSSuffix === 'string'
        ? tailnetObj.MagicDNSSuffix.replace(/\.$/, '').toLowerCase()
        : typeof obj.MagicDNSSuffix === 'string'
          ? obj.MagicDNSSuffix.replace(/\.$/, '').toLowerCase()
          : null;
    const magicDnsEnabled =
      typeof tailnetObj?.MagicDNSEnabled === 'boolean'
        ? tailnetObj.MagicDNSEnabled
        : Boolean(dnsName && dnsName.endsWith('.ts.net'));

    const certDomains = Array.isArray(obj.CertDomains)
      ? obj.CertDomains.filter((d): d is string => typeof d === 'string').map((d) =>
          d.replace(/\.$/, '').toLowerCase(),
        )
      : [];
    const httpsCertEnabled = certDomains.length > 0;

    // Inspect node capabilities (Self.CapMap or Self.Capabilities) for Funnel ACL attribute
    let funnelCapPresent = false;
    const capMap = selfObj?.CapMap;
    if (capMap && typeof capMap === 'object' && !Array.isArray(capMap)) {
      for (const key of Object.keys(capMap as Record<string, unknown>)) {
        if (key === 'funnel' || key.endsWith('/cap/funnel')) {
          funnelCapPresent = true;
          break;
        }
      }
    }
    const capArr = selfObj?.Capabilities;
    if (!funnelCapPresent && Array.isArray(capArr)) {
      for (const item of capArr) {
        if (typeof item === 'string' && (item === 'funnel' || item.endsWith('/cap/funnel'))) {
          funnelCapPresent = true;
          break;
        }
      }
    }

    return {
      backendState,
      dnsName,
      magicDnsSuffix,
      magicDnsEnabled,
      certDomains,
      httpsCertEnabled,
      funnelCapPresent,
    };
  } catch {
    return null;
  }
}

export interface ParsedServePortInspection {
  port: 443 | 8443 | 10000;
  hasAnyConfig: boolean;
  allowFunnel: boolean;
  hasRawTcpNonHttp: boolean;
  handlers: Record<string, { proxy?: string; otherType?: boolean }>;
}

export function inspectServeConfigPorts(
  rawJson: string,
  dnsName: string,
): Record<443 | 8443 | 10000, ParsedServePortInspection> {
  const cleanDns = dnsName.replace(/\.$/, '').toLowerCase();
  const baseResult: Record<443 | 8443 | 10000, ParsedServePortInspection> = {
    443: { port: 443, hasAnyConfig: false, allowFunnel: false, hasRawTcpNonHttp: false, handlers: {} },
    8443: { port: 8443, hasAnyConfig: false, allowFunnel: false, hasRawTcpNonHttp: false, handlers: {} },
    10000: { port: 10000, hasAnyConfig: false, allowFunnel: false, hasRawTcpNonHttp: false, handlers: {} },
  };

  if (!rawJson.trim()) {
    return baseResult;
  }

  let parsed: Record<string, unknown>;
  try {
    const p = JSON.parse(rawJson);
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return baseResult;
    }
    parsed = p as Record<string, unknown>;
  } catch {
    return baseResult;
  }

  const tcpMap =
    parsed.TCP && typeof parsed.TCP === 'object' ? (parsed.TCP as Record<string, unknown>) : {};
  const webMap =
    parsed.Web && typeof parsed.Web === 'object' ? (parsed.Web as Record<string, unknown>) : {};
  const allowFunnelMap =
    parsed.AllowFunnel && typeof parsed.AllowFunnel === 'object'
      ? (parsed.AllowFunnel as Record<string, unknown>)
      : {};

  for (const port of [443, 8443, 10000] as const) {
    const entry = baseResult[port];
    const portStr = String(port);
    const hostPortKey = `${cleanDns}:${port}`;

    const tcpCfg = tcpMap[portStr];
    if (tcpCfg && typeof tcpCfg === 'object') {
      entry.hasAnyConfig = true;
      const tcpObj = tcpCfg as Record<string, unknown>;
      if (tcpObj.TCPForward || (tcpObj.HTTPS !== true && tcpObj.HTTP !== true)) {
        entry.hasRawTcpNonHttp = true;
      }
    }

    // Match exact hostPortKey or case-insensitive trailing dot variants
    for (const [k, val] of Object.entries(allowFunnelMap)) {
      const normK = k.replace(/\.:/, ':').toLowerCase();
      if (normK === hostPortKey && val === true) {
        entry.allowFunnel = true;
      }
    }

    for (const [k, val] of Object.entries(webMap)) {
      const normK = k.replace(/\.:/, ':').toLowerCase();
      if (normK === hostPortKey && val && typeof val === 'object') {
        entry.hasAnyConfig = true;
        const handlersObj = (val as Record<string, unknown>).Handlers;
        if (handlersObj && typeof handlersObj === 'object') {
          for (const [mount, hVal] of Object.entries(handlersObj as Record<string, unknown>)) {
            if (hVal && typeof hVal === 'object') {
              const hRec = hVal as Record<string, unknown>;
              if (typeof hRec.Proxy === 'string') {
                entry.handlers[mount] = { proxy: hRec.Proxy };
              } else {
                entry.handlers[mount] = { otherType: true };
              }
            }
          }
        }
      }
    }
  }

  return baseResult;
}

/**
 * Production safe subprocess executor for `tailscale.exe` (`shell: false`, bounded timeout & output).
 */
export class SafeTailscaleCliExecutor implements TailscaleCommandExecutor {
  private readonly customFinder?: () => string | null;

  constructor(options?: { findExecutable?: () => string | null }) {
    this.customFinder = options?.findExecutable;
  }

  findExecutable(): string | null {
    if (this.customFinder) {
      return this.customFinder();
    }
    return findOfficialWindowsTailscaleExecutable();
  }

  async exec(
    args: readonly string[],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<TailscaleCliExecResult> {
    const exePath = this.findExecutable();
    if (!exePath) {
      return {
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: 'Tailscale executable not found.',
        timedOut: false,
        aborted: false,
        errorCode: 'NOT_INSTALLED',
      };
    }

    // Validate all CLI arguments are plain strings without NUL or control characters
    for (const arg of args) {
      if (typeof arg !== 'string' || /[\u0000\r\n]/.test(arg)) {
        return {
          ok: false,
          exitCode: null,
          stdout: '',
          stderr: 'Rejected unsafe CLI argument.',
          timedOut: false,
          aborted: false,
          errorCode: 'INVALID_ARGS',
        };
      }
    }

    const timeoutMs = Math.max(500, Math.min(30_000, options?.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS));

    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let aborted = false;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutLen = 0;
      let stderrLen = 0;

      const child = spawn(exePath, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const finish = (exitCode: number | null, errorCode?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (options?.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
        resolve({
          ok: !timedOut && !aborted && !errorCode && exitCode === 0,
          exitCode,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          timedOut,
          aborted,
          errorCode,
        });
      };

      const killChild = () => {
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore kill errors
        }
      };

      const onAbort = () => {
        aborted = true;
        killChild();
      };

      if (options?.signal) {
        if (options.signal.aborted) {
          aborted = true;
          killChild();
          finish(null, 'ABORTED');
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        timedOut = true;
        killChild();
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutLen < MAX_CLI_OUTPUT_BYTES) {
          const slice = chunk.subarray(0, MAX_CLI_OUTPUT_BYTES - stdoutLen);
          stdoutChunks.push(slice);
          stdoutLen += slice.length;
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrLen < MAX_CLI_OUTPUT_BYTES) {
          const slice = chunk.subarray(0, MAX_CLI_OUTPUT_BYTES - stderrLen);
          stderrChunks.push(slice);
          stderrLen += slice.length;
        }
      });

      child.once('error', (err) => {
        finish(null, (err as NodeJS.ErrnoException).code || 'SPAWN_ERROR');
      });

      child.once('close', (code) => {
        finish(code, timedOut ? 'TIMEOUT' : aborted ? 'ABORTED' : undefined);
      });
    });
  }
}
