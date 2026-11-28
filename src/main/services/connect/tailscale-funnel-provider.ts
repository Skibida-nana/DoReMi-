import {
  CONNECT_REMOTE_ALLOWED_PORTS,
  CONNECT_REMOTE_DEFAULT_MOUNT_PATH,
  isAllowedFunnelPublicPort,
  isValidTailscaleFunnelHostname,
  normalizeRemoteMountPath,
  TAILSCALE_WINDOWS_DOWNLOAD_URL,
  validateRemoteHttpsOrigin,
} from '../../../shared/contracts/connect-remote';
import type {
  RemoteOwnedRouteRecord,
  RemoteProviderId,
  RemoteProviderStatusSnapshot,
} from '../../../shared/types/connect';
import {
  inspectServeConfigPorts,
  isSupportedTailscaleVersion,
  parseTailscaleSemver,
  parseTailscaleStatusJson,
  SafeTailscaleCliExecutor,
  sanitizeTailscaleText,
  type TailscaleCommandExecutor,
} from './tailscale-cli';

export interface RemoteActivationResult {
  ok: true;
  ownedRoute: RemoteOwnedRouteRecord;
  publicEndpointUrl: string;
}

export interface RemoteActivationFailure {
  ok: false;
  code: string;
  message: string;
  providerStatus: RemoteProviderStatusSnapshot;
}

export interface RemoteDeactivationResult {
  ok: boolean;
  staleRouteWarning: string | null;
}

/**
 * Replaceable Remote HTTPS Transport Provider abstraction (Phase 6.3).
 * Allows swapping or adding future providers without rewriting Server Core, Auth, or Audio Engine.
 */
export interface RemoteTransportProvider {
  readonly providerId: RemoteProviderId;
  detectStatus(options?: {
    preferredPort?: 443 | 8443 | 10000;
    mountPath?: string;
    ownedLocalTarget?: string | null;
    forceRefresh?: boolean;
    signal?: AbortSignal;
  }): Promise<RemoteProviderStatusSnapshot>;
  activateRoute(params: {
    localGatewayPort: number;
    preferredPublicPort: 443 | 8443 | 10000;
    mountPath: string;
    signal?: AbortSignal;
  }): Promise<RemoteActivationResult | RemoteActivationFailure>;
  verifyOwnedRouteActive(
    ownedRoute: RemoteOwnedRouteRecord,
    signal?: AbortSignal,
  ): Promise<{ active: boolean; detail?: string }>;
  deactivateOwnedRoute(
    ownedRoute: RemoteOwnedRouteRecord,
    signal?: AbortSignal,
  ): Promise<RemoteDeactivationResult>;
  reconcileStaleOwnedRoute(
    persistedRoute: RemoteOwnedRouteRecord | null,
    signal?: AbortSignal,
  ): Promise<RemoteDeactivationResult>;
}

function isLoopbackHttpTarget(proxyUrl: string | undefined): boolean {
  if (!proxyUrl) return false;
  return /^http:\/\/127\.0\.0\.1:\d{2,5}\/?$/i.test(proxyUrl.trim());
}

const PROVIDER_STATUS_CACHE_TTL_MS = 5_000;

export class TailscaleFunnelProvider implements RemoteTransportProvider {
  readonly providerId: RemoteProviderId = 'tailscale-funnel';
  private readonly cli: TailscaleCommandExecutor;
  private readonly statusCacheTtlMs: number;
  private cachedStatus: {
    key: string;
    atMs: number;
    snapshot: RemoteProviderStatusSnapshot;
  } | null = null;
  private inflightDetect: {
    key: string;
    promise: Promise<RemoteProviderStatusSnapshot>;
  } | null = null;

  constructor(options?: { cli?: TailscaleCommandExecutor; statusCacheTtlMs?: number }) {
    this.cli = options?.cli ?? new SafeTailscaleCliExecutor();
    this.statusCacheTtlMs = Math.max(0, options?.statusCacheTtlMs ?? PROVIDER_STATUS_CACHE_TTL_MS);
  }

  invalidateStatusCache(): void {
    this.cachedStatus = null;
  }

  async detectStatus(options?: {
    preferredPort?: 443 | 8443 | 10000;
    mountPath?: string;
    ownedLocalTarget?: string | null;
    forceRefresh?: boolean;
    signal?: AbortSignal;
  }): Promise<RemoteProviderStatusSnapshot> {
    const mountPath =
      normalizeRemoteMountPath(options?.mountPath ?? CONNECT_REMOTE_DEFAULT_MOUNT_PATH) ??
      CONNECT_REMOTE_DEFAULT_MOUNT_PATH;
    const cacheKey = `${options?.preferredPort ?? 'any'}::${mountPath}::${options?.ownedLocalTarget ?? ''}`;
    const now = Date.now();
    if (
      !options?.forceRefresh &&
      this.statusCacheTtlMs > 0 &&
      this.cachedStatus &&
      this.cachedStatus.key === cacheKey &&
      now - this.cachedStatus.atMs < this.statusCacheTtlMs
    ) {
      return {
        ...this.cachedStatus.snapshot,
        availablePublicPorts: [...this.cachedStatus.snapshot.availablePublicPorts],
        conflictingRoutes: [...this.cachedStatus.snapshot.conflictingRoutes],
      };
    }

    if (!options?.forceRefresh && this.inflightDetect && this.inflightDetect.key === cacheKey) {
      return this.inflightDetect.promise;
    }

    const work = this.detectStatusUncached({
      preferredPort: options?.preferredPort,
      mountPath,
      ownedLocalTarget: options?.ownedLocalTarget,
      signal: options?.signal,
    }).then((snap) => {
      if (this.statusCacheTtlMs > 0 && snap.detectionStatus === 'ready') {
        this.cachedStatus = {
          key: cacheKey,
          atMs: Date.now(),
          snapshot: snap,
        };
      } else {
        this.cachedStatus = null;
      }
      return snap;
    }).finally(() => {
      if (this.inflightDetect?.key === cacheKey) {
        this.inflightDetect = null;
      }
    });

    this.inflightDetect = { key: cacheKey, promise: work };
    return work;
  }

  private async detectStatusUncached(options: {
    preferredPort?: 443 | 8443 | 10000;
    mountPath: string;
    ownedLocalTarget?: string | null;
    signal?: AbortSignal;
  }): Promise<RemoteProviderStatusSnapshot> {
    const mountPath = options.mountPath;
    const baseEmpty = (
      detectionStatus: RemoteProviderStatusSnapshot['detectionStatus'],
      message: string,
      extra?: Partial<RemoteProviderStatusSnapshot>,
    ): RemoteProviderStatusSnapshot => ({
      providerId: 'tailscale-funnel',
      detectionStatus,
      executableDetected: false,
      cliVersion: null,
      backendState: null,
      dnsName: null,
      magicDnsEnabled: false,
      httpsCertEnabled: false,
      funnelAllowed: false,
      availablePublicPorts: [],
      conflictingRoutes: [],
      downloadUrl: TAILSCALE_WINDOWS_DOWNLOAD_URL,
      message,
      ...extra,
    });

    const exe = this.cli.findExecutable();
    if (!exe) {
      return baseEmpty(
        'not_installed',
        'Chưa cài đặt ứng dụng Tailscale chính thức trên máy Host Windows.',
      );
    }

    const verRes = await this.cli.exec(['version', '--json'], { signal: options?.signal });
    const parsedVer = parseTailscaleSemver(verRes.stdout || verRes.stderr);
    if (!verRes.ok && verRes.timedOut) {
      return baseEmpty(
        'service_unavailable',
        'Lệnh kiểm tra phiên bản Tailscale bị quá thời gian chờ.',
        { executableDetected: true },
      );
    }
    if (!isSupportedTailscaleVersion(parsedVer)) {
      return baseEmpty(
        'unsupported_version',
        `Phiên bản Tailscale CLI (${parsedVer?.version ?? 'không xác định'}) quá cũ. Cần Tailscale >= 1.52.0 hỗ trợ Funnel.`,
        { executableDetected: true, cliVersion: parsedVer?.version ?? null },
      );
    }

    const statusRes = await this.cli.exec(['status', '--json'], { signal: options?.signal });
    if (!statusRes.ok) {
      const errClean = sanitizeTailscaleText(statusRes.stderr || statusRes.stdout);
      const isStopped = /stopped|service.*not running|failed to connect/i.test(
        statusRes.stderr + statusRes.stdout,
      );
      return baseEmpty(
        isStopped ? 'stopped' : 'service_unavailable',
        isStopped
          ? 'Dịch vụ nền Tailscale đang dừng. Hãy mở ứng dụng Tailscale trên Windows.'
          : `Không thể đọc trạng thái dịch vụ Tailscale (${errClean || 'service unavailable'}).`,
        { executableDetected: true, cliVersion: parsedVer!.version },
      );
    }

    const nodeStatus = parseTailscaleStatusJson(statusRes.stdout);
    if (!nodeStatus) {
      return baseEmpty(
        'service_unavailable',
        'Dữ liệu trạng thái JSON từ Tailscale CLI không đúng định dạng.',
        { executableDetected: true, cliVersion: parsedVer!.version },
      );
    }

    if (
      nodeStatus.backendState === 'NeedsLogin' ||
      nodeStatus.backendState === 'NoState' ||
      nodeStatus.backendState === 'NeedsMachineAuth'
    ) {
      return baseEmpty(
        'login_required',
        'Tailscale trên máy Host chưa đăng nhập tài khoản. Hãy đăng nhập trong ứng dụng Tailscale.',
        {
          executableDetected: true,
          cliVersion: parsedVer!.version,
          backendState: nodeStatus.backendState,
        },
      );
    }

    if (nodeStatus.backendState === 'Stopped') {
      return baseEmpty(
        'stopped',
        'Tailscale hiện đang ở trạng thái Đã tắt (Disconnected). Hãy bật kết nối Tailscale trên máy Host.',
        {
          executableDetected: true,
          cliVersion: parsedVer!.version,
          backendState: nodeStatus.backendState,
        },
      );
    }

    if (nodeStatus.backendState !== 'Running') {
      return baseEmpty(
        'service_unavailable',
        `Tailscale chưa sẵn sàng (Trạng thái: ${nodeStatus.backendState}).`,
        {
          executableDetected: true,
          cliVersion: parsedVer!.version,
          backendState: nodeStatus.backendState,
        },
      );
    }

    if (
      !nodeStatus.dnsName ||
      !isValidTailscaleFunnelHostname(nodeStatus.dnsName) ||
      !nodeStatus.magicDnsEnabled ||
      !nodeStatus.httpsCertEnabled
    ) {
      return baseEmpty(
        'magicdns_or_https_missing',
        'Tailnet chưa bật đầy đủ MagicDNS và HTTPS Certificates trong trang quản trị Tailscale DNS.',
        {
          executableDetected: true,
          cliVersion: parsedVer!.version,
          backendState: nodeStatus.backendState,
          dnsName: nodeStatus.dnsName,
          magicDnsEnabled: nodeStatus.magicDnsEnabled,
          httpsCertEnabled: nodeStatus.httpsCertEnabled,
        },
      );
    }

    if (!nodeStatus.funnelCapPresent) {
      return baseEmpty(
        'funnel_permission_denied',
        'Tài khoản/thiết bị Tailscale chưa có quyền Funnel trong chính sách ACL (nodeAttrs: funnel).',
        {
          executableDetected: true,
          cliVersion: parsedVer!.version,
          backendState: nodeStatus.backendState,
          dnsName: nodeStatus.dnsName,
          magicDnsEnabled: true,
          httpsCertEnabled: true,
          funnelAllowed: false,
        },
      );
    }

    // Query Serve/Funnel config to verify port safety and protect unrelated user routes
    const serveRes = await this.cli.exec(['funnel', 'status', '--json'], {
      signal: options?.signal,
    });
    if (!serveRes.ok && /denied|not allowed|permission/i.test(serveRes.stderr + serveRes.stdout)) {
      return baseEmpty(
        'funnel_permission_denied',
        'Tailscale từ chối quyền truy cập Funnel trên thiết bị này.',
        {
          executableDetected: true,
          cliVersion: parsedVer!.version,
          backendState: nodeStatus.backendState,
          dnsName: nodeStatus.dnsName,
          magicDnsEnabled: true,
          httpsCertEnabled: true,
          funnelAllowed: false,
        },
      );
    }

    const portsMap = inspectServeConfigPorts(serveRes.ok ? serveRes.stdout : '{}', nodeStatus.dnsName);
    const availablePorts: Array<443 | 8443 | 10000> = [];
    const conflicts: string[] = [];

    for (const p of CONNECT_REMOTE_ALLOWED_PORTS) {
      const info = portsMap[p];
      if (info.hasRawTcpNonHttp) {
        conflicts.push(`:${p} đang chạy TCP forwarder khác`);
        continue;
      }
      // Do NOT enable Funnel on a port that has private Tailscale Serve routes (AllowFunnel=false),
      // because enabling Funnel on that HostPort would publicly expose the user's private Serve handler!
      if (info.hasAnyConfig && !info.allowFunnel) {
        conflicts.push(`:${p} đang có dịch vụ Tailscale Serve nội bộ riêng tư`);
        continue;
      }
      const existingMount = info.handlers[mountPath];
      if (existingMount) {
        const matchesOwned =
          options?.ownedLocalTarget && existingMount.proxy === options.ownedLocalTarget;
        if (!matchesOwned && !isLoopbackHttpTarget(existingMount.proxy)) {
          conflicts.push(`:${p}${mountPath} đang được dùng bởi dịch vụ khác`);
          continue;
        }
      }
      availablePorts.push(p);
    }

    const pref = options?.preferredPort;
    if (availablePorts.length === 0 || (pref && !availablePorts.includes(pref))) {
      return baseEmpty(
        'route_conflict',
        pref && !availablePorts.includes(pref)
          ? `Cổng Funnel HTTPS :${pref} đang bận bởi cấu hình Tailscale khác (${conflicts.join('; ')}). DoReMi từ chối ghi đè dịch vụ không thuộc quyền sở hữu.`
          : `Tất cả cổng Funnel (443, 8443, 10000) đều đang bận bởi dịch vụ khác (${conflicts.join('; ')}).`,
        {
          executableDetected: true,
          cliVersion: parsedVer!.version,
          backendState: nodeStatus.backendState,
          dnsName: nodeStatus.dnsName,
          magicDnsEnabled: true,
          httpsCertEnabled: true,
          funnelAllowed: true,
          availablePublicPorts: availablePorts,
          conflictingRoutes: conflicts,
        },
      );
    }

    return {
      providerId: 'tailscale-funnel',
      detectionStatus: 'ready',
      executableDetected: true,
      cliVersion: parsedVer!.version,
      backendState: nodeStatus.backendState,
      dnsName: nodeStatus.dnsName,
      magicDnsEnabled: true,
      httpsCertEnabled: true,
      funnelAllowed: true,
      availablePublicPorts: availablePorts,
      conflictingRoutes: conflicts,
      downloadUrl: TAILSCALE_WINDOWS_DOWNLOAD_URL,
      message: `Tailscale v${parsedVer!.version} sẵn sàng cho Funnel (${nodeStatus.dnsName}).`,
    };
  }

  async activateRoute(params: {
    localGatewayPort: number;
    preferredPublicPort: 443 | 8443 | 10000;
    mountPath: string;
    signal?: AbortSignal;
  }): Promise<RemoteActivationResult | RemoteActivationFailure> {
    const mountPath = normalizeRemoteMountPath(params.mountPath);
    if (!mountPath || !isAllowedFunnelPublicPort(params.preferredPublicPort)) {
      const snap = await this.detectStatus({ signal: params.signal });
      return {
        ok: false,
        code: 'INVALID_FUNNEL_CONFIG',
        message: 'Cấu hình cổng hoặc đường dẫn Funnel không hợp lệ.',
        providerStatus: snap,
      };
    }
    if (
      !Number.isInteger(params.localGatewayPort) ||
      params.localGatewayPort < 1024 ||
      params.localGatewayPort > 65535
    ) {
      const snap = await this.detectStatus({ signal: params.signal });
      return {
        ok: false,
        code: 'INVALID_GATEWAY_PORT',
        message: 'Cổng Remote Gateway cục bộ không hợp lệ.',
        providerStatus: snap,
      };
    }

    const localTarget = `http://127.0.0.1:${params.localGatewayPort}`;
    const preStatus = await this.detectStatus({
      preferredPort: params.preferredPublicPort,
      mountPath,
      ownedLocalTarget: localTarget,
      forceRefresh: true,
      signal: params.signal,
    });

    if (preStatus.detectionStatus !== 'ready' || !preStatus.dnsName) {
      return {
        ok: false,
        code: preStatus.detectionStatus.toUpperCase(),
        message: preStatus.message,
        providerStatus: preStatus,
      };
    }

    const publicPort = params.preferredPublicPort;
    const rawOrigin =
      publicPort === 443
        ? `https://${preStatus.dnsName}`
        : `https://${preStatus.dnsName}:${publicPort}`;
    const validatedOrigin = validateRemoteHttpsOrigin(rawOrigin, 'tailscale-funnel');
    if (!validatedOrigin.ok) {
      return {
        ok: false,
        code: validatedOrigin.code,
        message: validatedOrigin.message,
        providerStatus: preStatus,
      };
    }

    // Configure ONLY the DoReMi-owned path using modern Tailscale CLI (`--bg --https=<port> --set-path=<mount>`)
    const enableRes = await this.cli.exec(
      [
        'funnel',
        '--bg',
        `--https=${publicPort}`,
        `--set-path=${mountPath}`,
        localTarget,
      ],
      { timeoutMs: 12_000, signal: params.signal },
    );

    if (!enableRes.ok) {
      const errDetail = sanitizeTailscaleText(enableRes.stderr || enableRes.stdout);
      return {
        ok: false,
        code: 'FUNNEL_ENABLE_FAILED',
        message: `Không thể kích hoạt tuyến Tailscale Funnel (${errDetail || 'CLI error'}).`,
        providerStatus: preStatus,
      };
    }

    const ownedRoute: RemoteOwnedRouteRecord = {
      providerId: 'tailscale-funnel',
      publicOrigin: validatedOrigin.canonicalOrigin,
      publicPort,
      mountPath,
      localTarget,
      createdAt: new Date().toISOString(),
    };

    const verify = await this.verifyOwnedRouteActive(ownedRoute, params.signal);
    if (!verify.active) {
      // Attempt immediate targeted cleanup if verification failed
      await this.deactivateOwnedRoute(ownedRoute).catch(() => {});
      return {
        ok: false,
        code: 'FUNNEL_VERIFICATION_FAILED',
        message:
          verify.detail ||
          'Tailscale CLI báo thành công nhưng không xác nhận được tuyến Funnel hoạt động thực tế.',
        providerStatus: preStatus,
      };
    }

    this.invalidateStatusCache();
    return {
      ok: true,
      ownedRoute,
      publicEndpointUrl: `${validatedOrigin.canonicalOrigin}${mountPath}`,
    };
  }

  async verifyOwnedRouteActive(
    ownedRoute: RemoteOwnedRouteRecord,
    signal?: AbortSignal,
  ): Promise<{ active: boolean; detail?: string }> {
    const originInfo = validateRemoteHttpsOrigin(ownedRoute.publicOrigin, 'tailscale-funnel');
    if (!originInfo.ok) {
      return { active: false, detail: originInfo.message };
    }
    const statusRes = await this.cli.exec(['funnel', 'status', '--json'], { signal });
    if (!statusRes.ok) {
      return {
        active: false,
        detail: 'Không thể truy vấn `tailscale funnel status --json` để xác nhận tuyến.',
      };
    }
    const ports = inspectServeConfigPorts(statusRes.stdout, originInfo.hostname);
    const portEntry = ports[ownedRoute.publicPort];
    const handler = portEntry?.handlers[ownedRoute.mountPath];
    if (!portEntry || !portEntry.allowFunnel || !handler) {
      return {
        active: false,
        detail: 'Tuyến Funnel của DoReMi chưa xuất hiện hoặc chưa bật AllowFunnel.',
      };
    }
    const normalizedProxy = (handler.proxy ?? '').replace(/\/$/, '');
    const normalizedExpected = ownedRoute.localTarget.replace(/\/$/, '');
    if (normalizedProxy !== normalizedExpected) {
      return {
        active: false,
        detail: `Target proxy của tuyến không khớp với cổng Gateway DoReMi hiện tại.`,
      };
    }
    return { active: true };
  }

  async deactivateOwnedRoute(
    ownedRoute: RemoteOwnedRouteRecord,
    signal?: AbortSignal,
  ): Promise<RemoteDeactivationResult> {
    this.invalidateStatusCache();
    const exe = this.cli.findExecutable();
    if (!exe) {
      return { ok: true, staleRouteWarning: null };
    }

    const originInfo = validateRemoteHttpsOrigin(ownedRoute.publicOrigin, 'tailscale-funnel');
    if (!originInfo.ok) {
      return { ok: false, staleRouteWarning: 'Thông tin tuyến sở hữu không hợp lệ khi dọn dẹp.' };
    }

    // Re-verify route ownership right before removal so we NEVER touch an unrelated user route
    const statusRes = await this.cli.exec(['funnel', 'status', '--json'], { signal });
    if (!statusRes.ok) {
      return {
        ok: false,
        staleRouteWarning:
          'Gateway cục bộ của DoReMi đã ĐÓNG an toàn, nhưng không thể đọc trạng thái Tailscale để gỡ tuyến Funnel cũ.',
      };
    }

    const ports = inspectServeConfigPorts(statusRes.stdout, originInfo.hostname);
    const portEntry = ports[ownedRoute.publicPort];
    const handler = portEntry?.handlers[ownedRoute.mountPath];
    if (!handler) {
      // Already absent — nothing to remove
      return { ok: true, staleRouteWarning: null };
    }

    // Ownership check: must be DoReMi's mountPath AND proxy to 127.0.0.1 loopback
    if (
      ownedRoute.mountPath !== CONNECT_REMOTE_DEFAULT_MOUNT_PATH &&
      handler.proxy?.replace(/\/$/, '') !== ownedRoute.localTarget.replace(/\/$/, '')
    ) {
      return {
        ok: false,
        staleRouteWarning:
          'Phát hiện cấu hình không rõ quyền sở hữu trên tuyến Funnel; DoReMi đã đóng Gateway cục bộ và giữ nguyên cấu hình Tailscale của bạn.',
      };
    }
    if (!isLoopbackHttpTarget(handler.proxy)) {
      return {
        ok: false,
        staleRouteWarning:
          'Tuyến hiện tại không trỏ về loopback của DoReMi; đã đóng Gateway cục bộ mà không sửa cấu hình Tailscale.',
      };
    }

    const offRes = await this.cli.exec(
      [
        'funnel',
        `--https=${ownedRoute.publicPort}`,
        `--set-path=${ownedRoute.mountPath}`,
        'off',
      ],
      { timeoutMs: 10_000, signal },
    );

    if (!offRes.ok) {
      return {
        ok: false,
        staleRouteWarning:
          'Gateway cục bộ của DoReMi đã đóng hoàn toàn (không thể truy cập nhạc), nhưng lệnh gỡ tuyến Tailscale Funnel chưa hoàn tất.',
      };
    }

    return { ok: true, staleRouteWarning: null };
  }

  async reconcileStaleOwnedRoute(
    persistedRoute: RemoteOwnedRouteRecord | null,
    signal?: AbortSignal,
  ): Promise<RemoteDeactivationResult> {
    if (!persistedRoute) {
      return { ok: true, staleRouteWarning: null };
    }
    return this.deactivateOwnedRoute(persistedRoute, signal);
  }
}
