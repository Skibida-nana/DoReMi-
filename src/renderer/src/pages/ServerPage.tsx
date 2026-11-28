import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Disc3,
  Download,
  FolderPlus,
  Globe,
  HardDrive,
  KeyRound,
  Laptop,
  ListPlus,
  Play,
  Plus,
  Power,
  QrCode,
  Radar,
  RefreshCw,
  RotateCw,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Unplug,
  Upload,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import jsQR from 'jsqr';
import {
  PAIRING_PAYLOAD_MAX_BYTES,
  parseAndValidatePairingPayload,
} from '../../../shared/contracts/connect-pairing';
import type {
  ConnectClientSnapshot,
  ConnectionSelectionMode,
  HostLifecycleState,
  HostPowerPolicy,
  InvitationLifecycleState,
  RemoteTrackDto,
  SmartConnectionState,
} from '../../../shared/types/connect';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import { buildRemoteArtworkMediaUrl } from '../../../shared/contracts/media-protocol';
import { connectStore, useConnectState } from '../stores/connect-store';
import { useLibraryState } from '../stores/library-store';
import { usePlaybackCoreState } from '../stores/player-store';
import { uiStore } from '../stores/ui-store';
import { formatDurationSeconds } from '../utils/formatters';

type ServerTab = 'overview' | 'shared' | 'devices' | 'connect' | 'resources' | 'diagnostics';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function formatCountdownMs(expiresAtIso: string, nowMs: number): { text: string; expired: boolean } {
  const exp = Date.parse(expiresAtIso);
  if (!Number.isFinite(exp)) return { text: '00:00', expired: true };
  const diff = exp - nowMs;
  if (diff <= 0) return { text: '00:00', expired: true };
  const totalSec = Math.ceil(diff / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return {
    text: `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`,
    expired: false,
  };
}

function describeInvitationLifecycle(state: InvitationLifecycleState | null | undefined): string | null {
  switch (state) {
    case 'CANCELED':
      return 'Mã ghép nối trước đã bị hủy bởi người dùng.';
    case 'EXPIRED':
      return 'Mã ghép nối trước đã hết hạn.';
    case 'CONSUMED':
      return 'Mã ghép nối đơn dụng trước đã được sử dụng thành công.';
    case 'REJECTED':
      return 'Yêu cầu ghép nối gần nhất đã bị từ chối.';
    case 'PENDING_APPROVAL':
      return 'Đang có yêu cầu ghép nối chờ phê duyệt.';
    default:
      return null;
  }
}

function formatConnectionModeLabel(mode: ConnectionSelectionMode | undefined): string {
  switch (mode) {
    case 'lan-only':
      return 'Chỉ LAN';
    case 'remote-only':
      return 'Chỉ Remote';
    case 'automatic':
    default:
      return 'Tự động';
  }
}

function describeClientSmartStatus(snap: ConnectClientSnapshot | null | undefined): {
  label: string;
  tone: 'emerald' | 'sky' | 'amber' | 'rose' | 'muted';
} {
  if (!snap) {
    return { label: 'Đã ngắt kết nối', tone: 'muted' };
  }
  const smartState: SmartConnectionState | undefined = snap.smartState;
  switch (smartState) {
    case 'CONNECTED_LAN':
      return { label: 'Đang kết nối qua LAN', tone: 'emerald' };
    case 'CONNECTED_REMOTE':
      return { label: 'Đang kết nối qua Remote HTTPS', tone: 'sky' };
    case 'HANDOVER_PENDING':
    case 'HANDOVER_IN_PROGRESS':
      return { label: 'Đang chuyển kết nối...', tone: 'amber' };
    case 'RECONNECTING':
    case 'DEGRADED':
      return { label: 'Đang kết nối lại...', tone: 'amber' };
    case 'CHECKING_NETWORK':
    case 'DISCOVERING_LAN':
    case 'VERIFYING_LAN':
    case 'CONNECTING_LAN':
    case 'VERIFYING_REMOTE':
    case 'CONNECTING_REMOTE':
      return { label: 'Đang kết nối...', tone: 'amber' };
    case 'HOST_UNAVAILABLE':
      return { label: 'Không tìm thấy Host', tone: 'amber' };
    case 'NETWORK_UNAVAILABLE':
      return { label: 'Mất kết nối mạng', tone: 'amber' };
    case 'ACCESS_REVOKED':
      return { label: 'Đã thu hồi quyền', tone: 'rose' };
    case 'SECURITY_BLOCKED':
      return { label: 'Xác minh bảo mật thất bại', tone: 'rose' };
    case 'AUTHORIZATION_REQUIRED':
      return { label: 'Chưa đủ quyền cho chế độ đã chọn', tone: 'amber' };
    case 'ERROR':
      return { label: 'Lỗi kết nối', tone: 'rose' };
    case 'DISCONNECTED':
      return { label: 'Đã ngắt kết nối', tone: 'muted' };
    default:
      if (snap.status === 'connected') {
        return snap.activeTransport === 'remote-https'
          ? { label: 'Đang kết nối qua Remote HTTPS', tone: 'sky' }
          : { label: 'Đang kết nối qua LAN', tone: 'emerald' };
      }
      if (snap.status === 'reconnecting') {
        return { label: 'Đang kết nối lại...', tone: 'amber' };
      }
      if (snap.status === 'connecting') {
        return { label: 'Đang kết nối...', tone: 'amber' };
      }
      return { label: 'Đã ngắt kết nối', tone: 'muted' };
  }
}

async function decodeQrFromImageFile(file: File): Promise<string> {
  if (file.size > 8 * 1024 * 1024) {
    throw new Error('Ảnh QR vượt quá giới hạn an toàn 8 MB.');
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Không thể đọc định dạng ảnh đã chọn.'));
      el.src = objectUrl;
    });
    const maxDim = 1024;
    const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Trình render không hỗ trợ giải mã ảnh QR cục bộ.');
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const decoded = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'attemptBoth',
    });
    if (!decoded || !decoded.data) {
      throw new Error('Không tìm thấy mã QR hợp lệ trong ảnh. Hãy thử ảnh rõ nét hơn.');
    }
    return decoded.data;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function downloadQrAsPng(qrDataUrl: string, hostName: string): void {
  const img = new Image();
  img.onload = () => {
    const size = 440;
    const pad = 28;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, pad, pad, size - pad * 2, size - pad * 2);
    const pngUrl = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    const safeName = hostName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32) || 'host';
    a.href = pngUrl;
    a.download = `doremi-pair-${safeName}.png`;
    a.click();
  };
  img.src = qrDataUrl;
}

function describeHostState(state: HostLifecycleState): {
  label: string;
  tone: 'neutral' | 'warn' | 'good' | 'active' | 'error';
} {
  switch (state) {
    case 'STOPPED':
      return { label: 'Đã tắt (STOPPED)', tone: 'neutral' };
    case 'STARTING':
      return { label: 'Đang khởi động (STARTING)', tone: 'warn' };
    case 'STANDBY':
      return { label: 'Sẵn sàng (STANDBY)', tone: 'good' };
    case 'ACTIVE':
      return { label: 'Đang phát (ACTIVE)', tone: 'active' };
    case 'STOPPING':
      return { label: 'Đang dừng (STOPPING)', tone: 'warn' };
    case 'ERROR':
      return { label: 'Lỗi (ERROR)', tone: 'error' };
  }
}

export function ServerPage() {
  const connect = useConnectState();
  const library = useLibraryState();
  const playback = usePlaybackCoreState();
  const userAccent = uiStore.getUserAccentPalette();
  const tab = connect.serverPageTab;
  const setTab = (next: ServerTab) => connectStore.setServerPageTab(next);
  const remoteViewTab = connect.remoteViewTab;
  const setRemoteViewTab = (next: 'tracks' | 'albums' | 'artists') =>
    connectStore.setRemoteViewTab(next);

  // Host settings draft
  const [hostNameDraft, setHostNameDraft] = useState('');
  const [hostPortDraft, setHostPortDraft] = useState('48620');
  const [maxClientsDraft, setMaxClientsDraft] = useState('3');
  const [autoApproveOnce, setAutoApproveOnce] = useState(false);

  // Client connect / enrollment draft
  const [manualAddress, setManualAddress] = useState('127.0.0.1');
  const [manualPort, setManualPort] = useState('48620');
  const [inviteCodeDraft, setInviteCodeDraft] = useState('');
  const [clientDeviceName, setClientDeviceName] = useState('DoReMi Windows Client');
  const [pairingPayloadDraft, setPairingPayloadDraft] = useState('');
  const [qrDecodeError, setQrDecodeError] = useState<string | null>(null);
  const [showHostFullFp, setShowHostFullFp] = useState(false);
  const [confirmRemoteExposure, setConfirmRemoteExposure] = useState(false);
  const [remotePublicPortDraft, setRemotePublicPortDraft] = useState<443 | 8443 | 10000>(443);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [isPageVisible, setIsPageVisible] = useState(
    () => (typeof document !== 'undefined' ? !document.hidden : true),
  );
  const [showAdvancedDiag, setShowAdvancedDiag] = useState(false);
  const [copiedDiagReport, setCopiedDiagReport] = useState(false);

  // Device rename inline state
  const [renamingDeviceId, setRenamingDeviceId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const isElectronDesktop =
    typeof window !== 'undefined' && Boolean(window.losslessApi?.connectGetHostSnapshot);

  useEffect(() => {
    void connectStore.initialize();
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
      return;
    }
    const onVisibilityChange = () => {
      const visible = !document.hidden;
      setIsPageVisible(visible);
      if (visible && isElectronDesktop) {
        void connectStore.refreshSnapshots();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [isElectronDesktop]);

  useEffect(() => {
    if (connect.hostSnapshot) {
      setHostNameDraft(connect.hostSnapshot.config.displayName);
      setHostPortDraft(String(connect.hostSnapshot.config.port));
      setMaxClientsDraft(String(connect.hostSnapshot.config.resourceLimits.maxActiveClients));
      setConfirmRemoteExposure(Boolean(connect.hostSnapshot.config.remoteUserAcknowledged));
      if (connect.hostSnapshot.config.remotePublicPort) {
        setRemotePublicPortDraft(connect.hostSnapshot.config.remotePublicPort);
      }
    }
  }, [
    connect.hostSnapshot?.config.displayName,
    connect.hostSnapshot?.config.port,
    connect.hostSnapshot?.config.resourceLimits.maxActiveClients,
    connect.hostSnapshot?.config.remoteUserAcknowledged,
    connect.hostSnapshot?.config.remotePublicPort,
  ]);

  // Auto-load unfiltered remote library once when connected Host hasn't loaded yet
  useEffect(() => {
    const activeHostId = connect.clientSnapshot?.activeHost?.hostId;
    if (
      !isElectronDesktop ||
      connect.clientSnapshot?.status !== 'connected' ||
      !activeHostId ||
      connect.remoteLibraryLoadedHostId === activeHostId ||
      connect.isLoadingRemoteLibrary ||
      connect.remoteLibraryError
    ) {
      return;
    }
    void connectStore.loadRemoteLibrary({ query: '' });
  }, [
    isElectronDesktop,
    connect.clientSnapshot?.status,
    connect.clientSnapshot?.activeHost?.hostId,
    connect.remoteLibraryLoadedHostId,
    connect.isLoadingRemoteLibrary,
    connect.remoteLibraryError,
  ]);

  // Refresh Client Diagnostics whenever user visits Diagnostics tab (works even when local Host is OFF)
  useEffect(() => {
    if (!isElectronDesktop || tab !== 'diagnostics') {
      return;
    }
    void connectStore.refreshClientDiagnostics();
  }, [isElectronDesktop, tab]);

  // Low-frequency resource metrics refresh ONLY while page is visible, user is viewing Resources/Diagnostics/Overview, and Host is ON
  useEffect(() => {
    if (
      !isElectronDesktop ||
      !isPageVisible ||
      (tab !== 'resources' && tab !== 'diagnostics' && tab !== 'overview') ||
      !connect.hostSnapshot ||
      connect.hostSnapshot.state === 'STOPPED'
    ) {
      return;
    }
    const timer = setInterval(() => {
      void connectStore.refreshSnapshots();
    }, 3000);
    return () => clearInterval(timer);
  }, [isElectronDesktop, isPageVisible, tab, connect.hostSnapshot?.state]);

  // 1-second local UI countdown tick only when active invitation is visible and window is not minimized/hidden
  useEffect(() => {
    if (!connect.hostSnapshot?.activeInvitation || !isPageVisible) {
      return;
    }
    setNowMs(Date.now());
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [connect.hostSnapshot?.activeInvitation?.invitationId, isPageVisible]);

  const parsedClientPairingPreview = useMemo(() => {
    if (!pairingPayloadDraft.trim()) return null;
    return parseAndValidatePairingPayload(pairingPayloadDraft, { nowMs });
  }, [pairingPayloadDraft, nowMs]);

  const hostSnap = connect.hostSnapshot;
  const clientSnap = connect.clientSnapshot;
  const clientDiag = connect.clientDiagnostics;
  const hostState = hostSnap?.state ?? 'STOPPED';
  const isHostRunning = hostState === 'STANDBY' || hostState === 'ACTIVE';
  const isHostBusy = hostState === 'STARTING' || hostState === 'STOPPING';
  const stateInfo = describeHostState(hostState);

  const sharedRootIdSet = useMemo(
    () => new Set((hostSnap?.sharedSources ?? []).map((s) => s.rootId)),
    [hostSnap?.sharedSources],
  );

  const unsharedRoots = useMemo(
    () => library.roots.filter((r) => !sharedRootIdSet.has(r.id)),
    [library.roots, sharedRootIdSet],
  );

  const navTabs: Array<{ id: ServerTab; label: string; badge?: string | number }> = [
    { id: 'overview', label: 'Tổng quan' },
    {
      id: 'shared',
      label: 'Thư viện chia sẻ',
      badge: hostSnap ? hostSnap.sharedSources.length : 0,
    },
    {
      id: 'devices',
      label: 'Thiết bị kết nối',
      badge: hostSnap
        ? hostSnap.pendingEnrollments.length > 0
          ? `${hostSnap.pendingEnrollments.length} chờ`
          : hostSnap.authorizedDevices.filter((d) => d.authState === 'authorized').length
        : 0,
    },
    { id: 'connect', label: 'Kết nối Server' },
    { id: 'resources', label: 'Tài nguyên' },
    { id: 'diagnostics', label: 'Chẩn đoán' },
  ];

  const handleToggleHost = () => {
    if (isHostBusy) return;
    if (isHostRunning) {
      void connectStore.stopHost();
    } else {
      void connectStore.startHost();
    }
  };

  const handleSaveHostConfig = () => {
    const parsedPort = Number.parseInt(hostPortDraft, 10);
    const parsedMaxClients = Number.parseInt(maxClientsDraft, 10);
    void connectStore.updateHostConfig({
      displayName: hostNameDraft,
      port:
        Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65535
          ? parsedPort
          : undefined,
      maxActiveClients:
        Number.isInteger(parsedMaxClients) && parsedMaxClients >= 1 && parsedMaxClients <= 10
          ? parsedMaxClients
          : undefined,
    });
    uiStore.showToast('Đã lưu cấu hình Host Server');
  };

  const handleCopyText = (text: string, label: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text).then(() => {
        uiStore.showToast(`Đã sao chép ${label}`);
      });
    }
  };

  const handlePlayRemote = (dto: RemoteTrackDto) => {
    void connectStore.playRemoteTrack(dto);
  };

  const handleQueueRemote = (dto: RemoteTrackDto, next = false) => {
    const hostId = clientSnap?.activeHost?.hostId;
    if (!hostId) return;
    const compositeId = `remote::${hostId}::${dto.trackId}`;
    if (next) {
      uiStore.playNextInQueue(compositeId);
    } else {
      uiStore.addToQueue(compositeId);
    }
  };

  if (!isElectronDesktop) {
    return (
      <div className="mx-auto w-full max-w-[1120px] space-y-6 pb-36 pt-2">
        <div className="lp-glass-panel rounded-[26px] p-8">
          <h1 className="font-display text-[26px] font-semibold text-[var(--text-primary)]">
            DoReMi Connect Server
          </h1>
          <p className="mt-2 text-[13.5px] text-[var(--text-secondary)]">
            Chức năng Personal Hybrid Server &amp; LAN Direct Streaming yêu cầu chạy trong ứng dụng desktop Electron trên Windows.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="server-page" className="mx-auto w-full max-w-[1200px] space-y-6 pb-36 pt-2">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
            DoReMi Connect · Phase 6.3 (LAN Direct &amp; Remote HTTPS)
          </p>
          <h1 className="font-display mt-1 text-[30px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
            Máy chủ nhạc cá nhân
          </h1>
          <p className="mt-1 text-[13px] text-[var(--text-secondary)]">
            Chia sẻ thư viện lossless nguyên bản qua mạng LAN nội bộ — không Cloud, không chuyển mã, không phụ thuộc VPN ngoài.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          {clientSnap?.status === 'connected' && clientSnap.activeHost && (
            <div className="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/12 px-3.5 py-1.5 text-[12px] font-medium text-emerald-300">
              <Wifi className="h-3.5 w-3.5" />
              <span>Đang nghe từ: {clientSnap.activeHost.displayName}</span>
            </div>
          )}

          <button
            type="button"
            data-testid="host-power-toggle-btn"
            disabled={isHostBusy}
            onClick={handleToggleHost}
            style={
              isHostRunning
                ? {
                    backgroundColor: `rgba(${userAccent.glowRgb}, 0.22)`,
                    borderColor: userAccent.activeHex,
                    color: 'var(--text-primary)',
                  }
                : undefined
            }
            className={`inline-flex items-center gap-2 rounded-full border px-5 py-2.5 text-[13px] font-semibold transition ${
              isHostRunning
                ? 'shadow-lg'
                : 'border-[var(--border-glass)] bg-[var(--surface-glass-light)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
            } disabled:opacity-50`}
          >
            <Power
              className="h-4 w-4"
              style={{ color: isHostRunning ? userAccent.activeHex : undefined }}
            />
            <span>{isHostRunning ? 'Tắt Host Server' : isHostBusy ? 'Đang xử lý...' : 'Bật Host Server'}</span>
          </button>
        </div>
      </div>

      {/* Section Navigation Pills */}
      <div className="flex flex-wrap gap-2">
        {navTabs.map((item) => {
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              data-testid={`server-tab-${item.id}`}
              onClick={() => setTab(item.id)}
              style={
                active
                  ? {
                      backgroundColor: `rgba(${userAccent.glowRgb}, 0.18)`,
                      borderColor: userAccent.activeHex,
                      color: 'var(--text-primary)',
                    }
                  : undefined
              }
              className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[13px] font-medium transition ${
                active
                  ? ''
                  : 'border-[var(--border-subtle)] bg-[var(--surface-glass-light)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              <span>{item.label}</span>
              {item.badge !== undefined && (
                <span className="rounded-full bg-[var(--bg-elevated)] px-2 py-0.5 text-[11px] font-semibold text-[var(--text-muted)]">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {(connect.actionError || hostSnap?.lastError) && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-2xl border border-rose-500/35 bg-rose-500/10 p-4 text-[13px] text-rose-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
          <div className="flex-1">{connect.actionError || hostSnap?.lastError}</div>
        </div>
      )}

      {/* =================================================================== */}
      {/* A. SERVER OVERVIEW                                                  */}
      {/* =================================================================== */}
      {tab === 'overview' && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <div className="lp-glass-panel space-y-5 rounded-[26px] p-6 lg:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-11 w-11 items-center justify-center rounded-2xl"
                  style={{
                    backgroundColor: `rgba(${userAccent.glowRgb}, 0.16)`,
                    color: userAccent.activeHex,
                  }}
                >
                  <Server className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="font-display text-[19px] font-semibold text-[var(--text-primary)]">
                    Trạng thái Host Server
                  </h2>
                  <p className="text-[12.5px] text-[var(--text-muted)]">
                    Chế độ truyền tải: LAN Direct (HTTPS + TLS Pinning · Nguyên bản)
                  </p>
                </div>
              </div>

              <span
                data-testid="host-lifecycle-badge"
                className={`rounded-full border px-3 py-1 text-[12px] font-semibold ${
                  stateInfo.tone === 'active'
                    ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                    : stateInfo.tone === 'good'
                      ? 'border-sky-400/40 bg-sky-500/15 text-sky-300'
                      : stateInfo.tone === 'error'
                        ? 'border-rose-400/40 bg-rose-500/15 text-rose-300'
                        : 'border-[var(--border-subtle)] bg-[var(--surface-glass-light)] text-[var(--text-secondary)]'
                }`}
              >
                {stateInfo.label}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-3.5">
                <p className="text-[11px] text-[var(--text-muted)]">Bài hát chia sẻ</p>
                <p className="font-mono-tabular mt-1 text-[20px] font-semibold text-[var(--text-primary)]">
                  {hostSnap?.sharedTrackCount ?? 0}
                </p>
              </div>
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-3.5">
                <p className="text-[11px] text-[var(--text-muted)]">Thiết bị được cấp quyền</p>
                <p className="font-mono-tabular mt-1 text-[20px] font-semibold text-[var(--text-primary)]">
                  {(hostSnap?.authorizedDevices ?? []).filter((d) => d.authState === 'authorized').length}
                </p>
              </div>
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-3.5">
                <p className="text-[11px] text-[var(--text-muted)]">Client đang stream</p>
                <p className="font-mono-tabular mt-1 text-[20px] font-semibold text-[var(--text-primary)]">
                  {hostSnap?.activeSessions.length ?? 0} / {hostSnap?.config.resourceLimits.maxActiveClients ?? 3}
                </p>
              </div>
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-3.5">
                <p className="text-[11px] text-[var(--text-muted)]">Cổng LAN đang mở</p>
                <p className="font-mono-tabular mt-1 text-[20px] font-semibold text-[var(--text-primary)]">
                  {hostSnap?.listeningPort ?? 'Đóng'}
                </p>
              </div>
            </div>

            {/* Host Identity & Network Endpoints */}
            <div className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-4 text-[12.5px]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-[var(--text-primary)]">
                  Định danh mã hóa Host (X.509 ECDSA P-256)
                </span>
                <button
                  type="button"
                  onClick={() => void connectStore.rotateHostIdentity()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                >
                  <RefreshCw className="h-3 w-3" />
                  Đổi khóa định danh
                </button>
              </div>
              {hostSnap?.identity ? (
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[var(--text-muted)]">Mã xác minh ngắn:</span>
                    <code className="font-mono-tabular rounded-lg bg-[var(--bg-elevated)] px-2 py-0.5 font-semibold text-[var(--text-primary)]">
                      {hostSnap.identity.shortFingerprint}
                    </code>
                    <button
                      type="button"
                      onClick={() =>
                        handleCopyText(hostSnap.identity!.shortFingerprint, 'mã xác minh Host')
                      }
                      className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      title="Sao chép mã xác minh"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <p className="text-[11.5px] text-[var(--text-muted)]">
                    Lưu trữ khóa bí mật: {hostSnap.identity.storageBackend === 'electron-safe-storage' ? 'Windows DPAPI (safeStorage)' : 'Tệp mã hóa cục bộ'} ·{' '}
                    {isHostRunning && hostSnap.listenAddresses.length > 0
                      ? `Địa chỉ LAN: ${hostSnap.listenAddresses.map((a) => `${a}:${hostSnap.listeningPort}`).join(', ')}`
                      : 'Host đang tắt — không mở cổng mạng hay timer nền.'}
                  </p>
                </div>
              ) : (
                <p className="text-[var(--text-muted)]">
                  Chứng chỉ định danh sẽ được khởi tạo an toàn khi bạn bật Host Server lần đầu.
                </p>
              )}
            </div>

            {/* Phase 6.3 Minimal Remote HTTPS (Tailscale Funnel) Section */}
            <div
              data-testid="remote-access-panel"
              className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-4 text-[12.5px]"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4" style={{ color: userAccent.activeHex }} />
                  <span className="font-semibold text-[var(--text-primary)]">
                    Truy cập từ xa qua Internet (Remote HTTPS · Tailscale Funnel)
                  </span>
                </div>
                <span
                  data-testid="remote-access-state-badge"
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                    hostSnap?.remoteAccess?.state === 'READY'
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : hostSnap?.remoteAccess?.state === 'DISABLED' || !hostSnap?.remoteAccess
                        ? 'bg-[var(--bg-elevated)] text-[var(--text-muted)]'
                        : 'bg-amber-500/15 text-amber-300'
                  }`}
                >
                  {hostSnap?.remoteAccess?.state ?? 'DISABLED'}
                </span>
              </div>

              <p className="text-[12px] text-[var(--text-secondary)]">
                Cho phép nghe nhạc nguyên bản từ mạng Wi-Fi/4G khác mà <strong>máy Client không cần cài Tailscale hay VPN</strong>. Máy Host ở nhà cần mở sẵn, kết nối mạng và chạy Tailscale (gói Personal miễn phí có hỗ trợ Funnel).
              </p>

              {hostSnap?.remoteAccess && (
                <div className="rounded-xl bg-[var(--bg-elevated)] p-3 text-[12px] text-[var(--text-secondary)] space-y-1.5">
                  <p>
                    <span className="text-[var(--text-muted)]">Trạng thái Tailscale trên Host: </span>
                    <span className="font-medium text-[var(--text-primary)]">
                      {hostSnap.remoteAccess.providerStatus.message}
                    </span>
                  </p>
                  {hostSnap.remoteAccess.providerStatus.detectionStatus === 'not_installed' && (
                    <p className="text-[11.5px] text-amber-200">
                      Tải Tailscale chính thức cho Windows tại:{' '}
                      <code className="font-mono-tabular">{hostSnap.remoteAccess.providerStatus.downloadUrl}</code>{' '}
                      rồi đăng nhập, bật MagicDNS + HTTPS Certificates trong trang quản trị Tailscale.
                    </p>
                  )}
                  {hostSnap.remoteAccess.publicEndpointUrl && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <span className="text-[var(--text-muted)]">Endpoint đã xác minh:</span>
                      <code
                        data-testid="verified-remote-endpoint-url"
                        className="font-mono-tabular rounded bg-black/20 px-2 py-0.5 text-[11.5px] font-semibold text-emerald-300"
                      >
                        {hostSnap.remoteAccess.publicEndpointUrl}
                      </code>
                      <button
                        type="button"
                        onClick={() =>
                          handleCopyText(
                            hostSnap.remoteAccess!.publicEndpointUrl!,
                            'địa chỉ Remote HTTPS',
                          )
                        }
                        className="inline-flex items-center gap-1 rounded border border-[var(--border-subtle)] px-2 py-0.5 text-[11px] text-[var(--text-primary)]"
                      >
                        <Copy className="h-3 w-3" />
                        Sao chép
                      </button>
                    </div>
                  )}
                  {hostSnap.remoteAccess.lastError && (
                    <p className="text-[11.5px] text-rose-300">{hostSnap.remoteAccess.lastError}</p>
                  )}
                  {hostSnap.remoteAccess.staleRouteWarning && (
                    <p className="text-[11.5px] text-amber-300">
                      {hostSnap.remoteAccess.staleRouteWarning}
                    </p>
                  )}
                </div>
              )}

              <label className="flex items-start gap-2 text-[11.5px] text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  data-testid="confirm-remote-exposure-checkbox"
                  checked={confirmRemoteExposure}
                  onChange={(e) => setConfirmRemoteExposure(e.target.checked)}
                  className="mt-0.5 rounded"
                />
                <span>
                  Tôi xác nhận cho phép mở cổng HTTPS chỉ đọc qua Tailscale Funnel cho thư mục nhạc đã chia sẻ (chỉ các thiết bị được cấp quyền Remote riêng mới truy cập được; không mở ghép nối công khai).
                </span>
              </label>

              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={remotePublicPortDraft}
                  onChange={(e) =>
                    setRemotePublicPortDraft(Number(e.target.value) as 443 | 8443 | 10000)
                  }
                  aria-label="Cổng HTTPS công cộng của Funnel"
                  className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)]"
                >
                  <option value={443}>HTTPS :443 (Mặc định)</option>
                  <option value={8443}>HTTPS :8443</option>
                  <option value={10000}>HTTPS :10000</option>
                </select>

                <button
                  type="button"
                  data-testid="check-tailscale-btn"
                  disabled={connect.isLoadingHost}
                  onClick={() => void connectStore.checkRemoteProvider()}
                  className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                >
                  Kiểm tra Tailscale
                </button>

                {hostSnap?.remoteAccess?.state === 'READY' ? (
                  <button
                    type="button"
                    data-testid="disable-remote-access-btn"
                    disabled={connect.isLoadingHost}
                    onClick={() => void connectStore.disableRemoteAccess()}
                    className="rounded-xl border border-rose-500/35 bg-rose-500/15 px-3.5 py-1.5 text-[12px] font-semibold text-rose-300 disabled:opacity-50"
                  >
                    Tắt Remote HTTPS
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid="enable-remote-access-btn"
                    disabled={!isHostRunning || !confirmRemoteExposure || connect.isLoadingHost}
                    onClick={() =>
                      void connectStore.enableRemoteAccess({
                        confirmPublicExposure: confirmRemoteExposure,
                        preferredPublicPort: remotePublicPortDraft,
                      })
                    }
                    style={
                      isHostRunning && confirmRemoteExposure
                        ? {
                            backgroundColor: `rgba(${userAccent.glowRgb}, 0.22)`,
                            borderColor: userAccent.activeHex,
                          }
                        : undefined
                    }
                    className="rounded-xl border border-[var(--border-glass)] px-3.5 py-1.5 text-[12px] font-semibold text-[var(--text-primary)] disabled:opacity-45"
                  >
                    Bật Remote HTTPS
                  </button>
                )}
              </div>
            </div>

            {/* Phase 6.5 Minimal Host Power Management Controls */}
            <div
              data-testid="host-power-policy-panel"
              className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-4 text-[12.5px]"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Power className="h-4 w-4" style={{ color: userAccent.activeHex }} />
                  <span className="font-semibold text-[var(--text-primary)]">
                    Quản lý nguồn điện Host trên Windows
                  </span>
                </div>
                <span
                  data-testid="host-power-blocker-badge"
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                    hostSnap?.power?.blockerActive
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : 'bg-[var(--bg-elevated)] text-[var(--text-muted)]'
                  }`}
                >
                  {hostSnap?.power?.blockerActive
                    ? 'Đang giữ máy thức (Màn hình vẫn tự tắt)'
                    : 'Theo cài đặt ngủ của Windows'}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <label
                  htmlFor="host-power-policy-select"
                  className="text-[12px] text-[var(--text-muted)]"
                >
                  Chế độ ngủ khi chạy Host:
                </label>
                <select
                  id="host-power-policy-select"
                  data-testid="host-power-policy-select"
                  value={hostSnap?.power?.policy ?? hostSnap?.config.powerPolicy ?? 'follow-system'}
                  onChange={(e) => {
                    const next = e.target.value as HostPowerPolicy;
                    void connectStore.setHostPowerPolicy(next);
                  }}
                  className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--text-primary)] outline-none focus:border-[var(--border-glass)]"
                >
                  <option value="follow-system">Theo cài đặt Windows (Mặc định)</option>
                  <option value="keep-awake-streaming">Giữ máy thức khi đang phát nhạc</option>
                  <option value="keep-awake-host-on">Giữ máy thức khi bật Host</option>
                </select>
              </div>

              {hostSnap?.power?.policyWarning && (
                <p className="text-[11.5px] text-[var(--text-secondary)]">
                  {hostSnap.power.policyWarning}
                </p>
              )}

              {hostSnap?.power?.batteryWarning && (
                <p
                  data-testid="host-power-battery-warning"
                  className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11.5px] text-amber-200"
                >
                  {hostSnap.power.batteryWarning}
                </p>
              )}
            </div>

            {/* Host Config Form */}
            <div className="space-y-3 border-t border-[var(--border-subtle)] pt-4">
              <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                Cấu hình máy chủ cá nhân
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="space-y-1 text-[12px]">
                  <span className="text-[var(--text-muted)]">Tên hiển thị Host</span>
                  <input
                    type="text"
                    value={hostNameDraft}
                    maxLength={48}
                    onChange={(e) => setHostNameDraft(e.target.value)}
                    className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--border-glass)]"
                  />
                </label>
                <label className="space-y-1 text-[12px]">
                  <span className="text-[var(--text-muted)]">Cổng HTTPS (1024–65535)</span>
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    value={hostPortDraft}
                    onChange={(e) => setHostPortDraft(e.target.value)}
                    className="font-mono-tabular w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--border-glass)]"
                  />
                </label>
                <label className="space-y-1 text-[12px]">
                  <span className="text-[var(--text-muted)]">Giới hạn Client đồng thời</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={maxClientsDraft}
                    onChange={(e) => setMaxClientsDraft(e.target.value)}
                    className="font-mono-tabular w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--border-glass)]"
                  />
                </label>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleSaveHostConfig}
                  className="rounded-xl border border-[var(--border-glass)] bg-[var(--surface-hover)] px-4 py-2 text-[12.5px] font-semibold text-[var(--text-primary)] transition hover:brightness-110"
                >
                  Lưu cấu hình Host
                </button>
              </div>
            </div>
          </div>

          {/* Side Guidance Card */}
          <div className="lp-glass-panel space-y-4 rounded-[26px] p-6">
            <h3 className="font-display text-[16px] font-semibold text-[var(--text-primary)]">
              Kiến trúc Hybrid Phase 6.1
            </h3>
            <ul className="space-y-2.5 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
              <li className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                <span>Mặc định TẮT khi mới cài đặt; chỉ mở cổng mạng khi bạn chủ động bật Host.</span>
              </li>
              <li className="flex items-start gap-2">
                <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
                <span>Truyền phát file gốc (Direct Streaming + HTTP 206 Range), giữ nguyên file nhạc gốc trên ổ đĩa.</span>
              </li>
              <li className="flex items-start gap-2">
                <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                <span>Yêu cầu ghép nối mã mời dùng 1 lần và xác minh vân tay TLS trước khi truy cập thư viện.</span>
              </li>
              <li className="flex items-start gap-2">
                <Laptop className="mt-0.5 h-4 w-4 shrink-0 text-violet-400" />
                <span>Trình phát cục bộ &amp; Connect Client hoạt động độc lập ngay cả khi Host của máy này đang TẮT.</span>
              </li>
            </ul>

            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-3.5 text-[11.5px] text-[var(--text-muted)]">
              <strong>Lưu ý phạm vi Phase 6.1:</strong> Chỉ hỗ trợ mạng LAN nội bộ. Ghép nối QR đầy đủ, Tailscale Funnel từ xa và ứng dụng Android sẽ thuộc các Phase tiếp theo.
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* B. SHARED LIBRARY                                                   */}
      {/* =================================================================== */}
      {tab === 'shared' && (
        <div className="lp-glass-panel space-y-6 rounded-[26px] p-6">
          <div>
            <h2 className="font-display text-[20px] font-semibold text-[var(--text-primary)]">
              Thư viện chia sẻ qua LAN (Chỉ đọc)
            </h2>
            <p className="mt-1 text-[13px] text-[var(--text-muted)]">
              Không có thư mục nào được chia sẻ mặc định. Chỉ các thư mục bạn chọn bên dưới mới cho phép thiết bị đã cấp quyền truy cập ở chế độ chỉ đọc.
            </p>
          </div>

          {/* Active Shared Sources */}
          <div className="space-y-3">
            <h3 className="text-[13.5px] font-semibold text-[var(--text-primary)]">
              Nguồn đang chia sẻ ({hostSnap?.sharedSources.length ?? 0})
            </h3>
            {(hostSnap?.sharedSources ?? []).length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[var(--border-subtle)] p-6 text-center text-[13px] text-[var(--text-muted)]">
                Chưa có thư mục nhạc nào được chia sẻ. Hãy thêm thư mục từ danh sách bên dưới.
              </div>
            ) : (
              <div className="space-y-2.5">
                {hostSnap!.sharedSources.map((src) => (
                  <div
                    key={src.id}
                    data-testid={`shared-source-${src.rootId}`}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border-glass)] bg-[var(--surface-glass-light)] px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[14px] font-semibold text-[var(--text-primary)]">
                          {src.folderName}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            src.available && src.enabled
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : 'bg-amber-500/15 text-amber-300'
                          }`}
                        >
                          {src.available && src.enabled ? 'Khả dụng' : 'Không khả dụng'}
                        </span>
                      </div>
                      <p className="font-mono-tabular mt-0.5 truncate text-[11.5px] text-[var(--text-muted)]">
                        {src.originalPath} · {src.trackCount} bài hát
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void connectStore.removeSharedSource(src.rootId)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-[12px] font-semibold text-rose-300 hover:bg-rose-500/20"
                    >
                      <X className="h-3.5 w-3.5" />
                      Gỡ chia sẻ
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Available Library Roots to Share */}
          <div className="space-y-3 border-t border-[var(--border-subtle)] pt-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                Thư mục đã lập chỉ mục trong DoReMi
              </h3>
              <button
                type="button"
                onClick={() => uiStore.openLibraryTab('folders')}
                className="text-[12px] font-medium hover:underline"
                style={{ color: userAccent.activeHex }}
              >
                Quản lý thư mục gốc
              </button>
            </div>

            {unsharedRoots.length === 0 ? (
              <p className="text-[12.5px] text-[var(--text-muted)]">
                {library.roots.length === 0
                  ? 'Thư viện cục bộ chưa gắn thư mục nào. Hãy thêm thư mục nhạc trong trang Thư viện trước.'
                  : 'Tất cả thư mục trong thư viện đã được thêm vào danh sách chia sẻ.'}
              </p>
            ) : (
              <div className="space-y-2">
                {unsharedRoots.map((root) => (
                  <div
                    key={root.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                        {root.original_path}
                      </p>
                      <p className="text-[11.5px] text-[var(--text-muted)]">
                        Trạng thái: {root.status === 'available' ? 'Sẵn sàng' : 'Thiếu / Ngắt kết nối'}
                      </p>
                    </div>
                    <button
                      type="button"
                      data-testid={`add-shared-source-${root.id}`}
                      onClick={() => void connectStore.addSharedSource(root.id)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-glass)] bg-[var(--surface-hover)] px-3 py-1.5 text-[12px] font-semibold text-[var(--text-primary)] hover:brightness-110"
                    >
                      <FolderPlus className="h-3.5 w-3.5" />
                      Chia sẻ nguồn này
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* C. CONNECTED DEVICES & ENROLLMENT                                   */}
      {/* =================================================================== */}
      {tab === 'devices' && (
        <div className="space-y-5">
          {/* Pairing Invitation Panel */}
          <div className="lp-glass-panel space-y-4 rounded-[26px] p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-[19px] font-semibold text-[var(--text-primary)]">
                  Ghép nối thiết bị mới
                </h2>
                <p className="mt-1 text-[12.5px] text-[var(--text-muted)]">
                  Tạo mã mời dùng 1 lần (hết hạn sau 5 phút) để thiết bị khác gửi yêu cầu kết nối tới Host này.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={autoApproveOnce}
                    onChange={(e) => setAutoApproveOnce(e.target.checked)}
                    className="rounded"
                  />
                  Tự động duyệt mã mời 1 lần này
                </label>
                <button
                  type="button"
                  data-testid="host-create-invite-btn"
                  disabled={!isHostRunning}
                  onClick={() => void connectStore.createInvitation(autoApproveOnce)}
                  style={
                    isHostRunning
                      ? {
                          backgroundColor: `rgba(${userAccent.glowRgb}, 0.2)`,
                          borderColor: userAccent.activeHex,
                        }
                      : undefined
                  }
                  className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-glass)] px-4 py-2 text-[12.5px] font-semibold text-[var(--text-primary)] disabled:opacity-45"
                >
                  <Plus className="h-4 w-4" />
                  Tạo mã mời ghép nối
                </button>
              </div>
            </div>

            {!isHostRunning && (
              <p className="text-[12.5px] text-amber-300">
                Hãy bật Host Server ở góc trên bên phải trước khi tạo mã mời ghép nối.
              </p>
            )}

            {hostSnap?.activeInvitation ? (
              (() => {
                const inv = hostSnap.activeInvitation;
                const countdown = formatCountdownMs(inv.expiresAt, nowMs);
                return (
                  <div
                    data-testid="active-invitation-card"
                    className="relative flex flex-col gap-4 rounded-2xl border border-emerald-500/35 bg-emerald-500/10 p-4 sm:flex-row sm:items-start sm:justify-between"
                  >
                    {inv.qrDataUrl && (
                      <div className="relative flex shrink-0 flex-col items-center gap-2">
                        <div className="relative rounded-2xl bg-white p-2.5 shadow-sm">
                          <img
                            src={inv.qrDataUrl}
                            alt="Mã QR ghép nối DoReMi Connect"
                            data-testid="pairing-qr-image"
                            className={`h-40 w-40 object-contain ${countdown.expired || inv.used ? 'opacity-25 blur-[2px]' : ''}`}
                          />
                          {(countdown.expired || inv.used) && (
                            <div
                              data-testid="qr-expired-overlay"
                              className="absolute inset-0 flex items-center justify-center rounded-2xl bg-black/55 p-2 text-center text-[11.5px] font-bold text-white"
                            >
                              {inv.used ? 'Mã đã sử dụng' : 'Mã QR đã hết hạn'}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          data-testid="download-qr-png-btn"
                          onClick={() => downloadQrAsPng(inv.qrDataUrl!, inv.hostDisplayName)}
                          className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        >
                          <Download className="h-3 w-3" />
                          Tải ảnh QR (.png)
                        </button>
                      </div>
                    )}

                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-[12px] font-semibold text-emerald-300">
                          Mã ghép nối đang hoạt động (dùng 1 lần)
                        </p>
                        <span
                          data-testid="invite-countdown"
                          className={`font-mono-tabular rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            countdown.expired
                              ? 'bg-rose-500/20 text-rose-300'
                              : 'bg-emerald-500/20 text-emerald-200'
                          }`}
                        >
                          Còn lại: {countdown.text}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2.5">
                        <code
                          data-testid="active-invite-code"
                          className="font-mono-tabular text-[22px] font-bold tracking-wider text-[var(--text-primary)]"
                        >
                          {inv.inviteCode}
                        </code>
                        <button
                          type="button"
                          onClick={() => handleCopyText(inv.inviteCode, 'mã mời ghép nối')}
                          className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11.5px] text-[var(--text-primary)]"
                        >
                          Sao chép mã
                        </button>
                        {inv.pairingPayload && (
                          <button
                            type="button"
                            data-testid="copy-pairing-payload-btn"
                            onClick={() =>
                              handleCopyText(inv.pairingPayload, 'gói dữ liệu ghép nối QR (JSON)')
                            }
                            className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11.5px] text-[var(--text-primary)]"
                          >
                            <Copy className="h-3 w-3" />
                            Sao chép JSON ghép nối
                          </button>
                        )}
                      </div>

                      <p className="text-[11.5px] text-[var(--text-secondary)]">
                        Vân tay xác minh rút gọn:{' '}
                        <code className="font-mono-tabular font-semibold">{inv.shortFingerprint}</code> · Địa chỉ:{' '}
                        {inv.listenAddresses.join(', ')}:{inv.port}
                      </p>

                      <div>
                        <button
                          type="button"
                          onClick={() => setShowHostFullFp((v) => !v)}
                          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                        >
                          {showHostFullFp ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                          {showHostFullFp ? 'Ẩn Full SPKI SHA-256 Fingerprint' : 'Xem Full SPKI SHA-256 Fingerprint'}
                        </button>
                        {showHostFullFp && (
                          <p
                            data-testid="host-full-fingerprint"
                            className="font-mono-tabular mt-1 break-all rounded-xl bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[11px] text-[var(--text-secondary)]"
                          >
                            {inv.fullFingerprint}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-row gap-2 sm:flex-col">
                      <button
                        type="button"
                        data-testid="regenerate-invite-btn"
                        onClick={() => void connectStore.createInvitation(autoApproveOnce)}
                        className="inline-flex items-center justify-center gap-1 rounded-xl border border-[var(--border-glass)] bg-[var(--bg-elevated)] px-3 py-1.5 text-[12px] font-semibold text-[var(--text-primary)]"
                      >
                        <RotateCw className="h-3.5 w-3.5" />
                        Tạo mã mới
                      </button>
                      <button
                        type="button"
                        data-testid="revoke-invite-btn"
                        onClick={() => void connectStore.revokeInvitation()}
                        className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-[12px] font-semibold text-rose-300"
                      >
                        Hủy mã mời
                      </button>
                    </div>
                  </div>
                );
              })()
            ) : (
              hostSnap?.diagnostics.lastInvitationState &&
              describeInvitationLifecycle(hostSnap.diagnostics.lastInvitationState) && (
                <p
                  data-testid="last-invitation-notice"
                  className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3.5 py-2 text-[12px] text-[var(--text-muted)]"
                >
                  {describeInvitationLifecycle(hostSnap.diagnostics.lastInvitationState)}
                </p>
              )
            )}

            {/* Pending Enrollment Requests */}
            {hostSnap && hostSnap.pendingEnrollments.length > 0 && (
              <div className="space-y-2 border-t border-[var(--border-subtle)] pt-4">
                <h3 className="text-[13px] font-semibold text-amber-300">
                  Yêu cầu ghép nối đang chờ phê duyệt ({hostSnap.pendingEnrollments.length})
                </h3>
                {hostSnap.pendingEnrollments.map((req) => (
                  <div
                    key={req.requestId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
                  >
                    <div>
                      <p className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                        {req.deviceName}
                      </p>
                      <p className="text-[11.5px] text-[var(--text-secondary)]">
                        Nền tảng: {req.platform} · IP: {req.remoteAddress}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void connectStore.approveEnrollment(req.requestId)}
                        className="inline-flex items-center gap-1 rounded-xl bg-emerald-500/20 px-3 py-1.5 text-[12px] font-semibold text-emerald-300 hover:bg-emerald-500/30"
                      >
                        <Check className="h-3.5 w-3.5" />
                        Chấp thuận
                      </button>
                      <button
                        type="button"
                        onClick={() => void connectStore.rejectEnrollment(req.requestId)}
                        className="inline-flex items-center gap-1 rounded-xl bg-rose-500/20 px-3 py-1.5 text-[12px] font-semibold text-rose-300 hover:bg-rose-500/30"
                      >
                        <X className="h-3.5 w-3.5" />
                        Từ chối
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Authorized Devices List */}
          <div className="lp-glass-panel space-y-4 rounded-[26px] p-6">
            <h2 className="font-display text-[19px] font-semibold text-[var(--text-primary)]">
              Danh sách thiết bị ({hostSnap?.authorizedDevices.length ?? 0})
            </h2>
            {(hostSnap?.authorizedDevices ?? []).length === 0 ? (
              <p className="text-[13px] text-[var(--text-muted)]">
                Chưa có thiết bị nào được ghép nối với Host này.
              </p>
            ) : (
              <div className="space-y-2.5">
                {hostSnap!.authorizedDevices.map((dev) => (
                  <div
                    key={dev.deviceId}
                    data-testid={`authorized-device-${dev.deviceId}`}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-4 py-3"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {renamingDeviceId === dev.deviceId ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="text"
                              value={renameDraft}
                              onChange={(e) => setRenameDraft(e.target.value)}
                              maxLength={48}
                              className="rounded-lg border border-[var(--border-glass)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[13px] text-[var(--text-primary)]"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                void connectStore.renameDevice(dev.deviceId, renameDraft);
                                setRenamingDeviceId(null);
                              }}
                              className="rounded-lg bg-emerald-500/20 px-2.5 py-1 text-[11.5px] font-semibold text-emerald-300"
                            >
                              Lưu
                            </button>
                          </div>
                        ) : (
                          <span className="text-[14px] font-semibold text-[var(--text-primary)]">
                            {dev.displayName}
                          </span>
                        )}
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            dev.authState === 'revoked'
                              ? 'bg-rose-500/15 text-rose-300'
                              : dev.isConnected
                                ? 'bg-emerald-500/15 text-emerald-300'
                                : 'bg-[var(--bg-elevated)] text-[var(--text-muted)]'
                          }`}
                        >
                          {dev.authState === 'revoked'
                            ? 'Đã thu hồi quyền'
                            : dev.isConnected
                              ? `Đang kết nối · ${dev.activeSessionCount} luồng`
                              : 'Đã cấp quyền (Ngoại tuyến)'}
                        </span>
                      </div>
                      <p className="text-[11.5px] text-[var(--text-muted)]">
                        {dev.platform} · IP gần nhất: {dev.lastIp ?? '—'} · Hoạt động cuối:{' '}
                        {dev.lastActivityAt ? new Date(dev.lastActivityAt).toLocaleString('vi-VN') : '—'}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setRenamingDeviceId(dev.deviceId);
                          setRenameDraft(dev.displayName);
                        }}
                        className="rounded-lg border border-[var(--border-subtle)] px-2.5 py-1.5 text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                      >
                        Đổi tên
                      </button>
                      {dev.isConnected && dev.authState === 'authorized' && (
                        <button
                          type="button"
                          onClick={() => void connectStore.disconnectDevice(dev.deviceId)}
                          className="inline-flex items-center gap-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] font-semibold text-amber-300"
                        >
                          <Unplug className="h-3 w-3" />
                          Ngắt kết nối
                        </button>
                      )}
                      {dev.authState === 'authorized' && (
                        <button
                          type="button"
                          data-testid={`toggle-device-remote-${dev.deviceId}`}
                          onClick={() =>
                            void connectStore.setDeviceRemoteAccess(
                              dev.deviceId,
                              !dev.remoteAccessEnabled,
                            )
                          }
                          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11.5px] font-semibold ${
                            dev.remoteAccessEnabled
                              ? 'border-emerald-500/35 bg-emerald-500/15 text-emerald-300'
                              : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]'
                          }`}
                          title="Cho phép hoặc thu hồi riêng quyền nghe từ xa qua Internet (Remote HTTPS) cho thiết bị này"
                        >
                          <Globe className="h-3 w-3" />
                          {dev.remoteAccessEnabled ? 'Remote: Bật' : 'Cho phép Remote'}
                        </button>
                      )}
                      {dev.authState === 'authorized' && (
                        <button
                          type="button"
                          onClick={() => void connectStore.revokeDevice(dev.deviceId)}
                          className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[11.5px] font-semibold text-rose-300"
                        >
                          <ShieldAlert className="h-3 w-3" />
                          Thu hồi quyền
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void connectStore.removeDevice(dev.deviceId)}
                        className="rounded-lg border border-[var(--border-subtle)] p-1.5 text-[var(--text-muted)] hover:bg-rose-500/15 hover:text-rose-300"
                        title="Xóa bản ghi thiết bị"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* D. CONNECT TO SERVER (WINDOWS CLIENT)                               */}
      {/* =================================================================== */}
      {tab === 'connect' && (() => {
        const smartStatus = describeClientSmartStatus(clientSnap);
        const activeOrIntendedHost =
          clientSnap?.activeHost ??
          (clientSnap?.intendedHostId
            ? clientSnap.rememberedHosts.find((h) => h.hostId === clientSnap.intendedHostId) ?? null
            : null);
        const showRemoteWorkspace =
          Boolean(activeOrIntendedHost) &&
          (clientSnap?.status === 'connected' ||
            (connect.remoteLibraryLoadedHostId === activeOrIntendedHost?.hostId &&
              (clientSnap?.status === 'reconnecting' ||
                clientSnap?.smartState === 'HANDOVER_PENDING' ||
                clientSnap?.smartState === 'HANDOVER_IN_PROGRESS' ||
                clientSnap?.smartState === 'HOST_UNAVAILABLE' ||
                clientSnap?.smartState === 'NETWORK_UNAVAILABLE')));
        const activeMode: ConnectionSelectionMode =
          activeOrIntendedHost?.connectionMode ?? clientSnap?.selectedMode ?? 'automatic';

        return (
        <div className="space-y-5">
          {/* Active / Recovering Remote Connection Status */}
          {showRemoteWorkspace && activeOrIntendedHost && (
            <div className="lp-glass-panel space-y-5 rounded-[26px] p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p
                      data-testid="active-transport-banner"
                      className={`text-[11px] font-semibold uppercase tracking-wider ${
                        smartStatus.tone === 'emerald'
                          ? 'text-emerald-400'
                          : smartStatus.tone === 'sky'
                            ? 'text-sky-300'
                            : smartStatus.tone === 'amber'
                              ? 'text-amber-300'
                              : smartStatus.tone === 'rose'
                                ? 'text-rose-300'
                                : 'text-[var(--text-muted)]'
                      }`}
                    >
                      {smartStatus.label}
                    </p>
                    <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--text-secondary)]">
                      Chế độ: {formatConnectionModeLabel(activeMode)}
                    </span>
                    {clientSnap?.alternativeTransportAvailable && (
                      <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10.5px] text-[var(--text-muted)]">
                        Dự phòng:{' '}
                        {clientSnap.alternativeTransportAvailable === 'remote-https'
                          ? 'Remote HTTPS'
                          : 'LAN'}
                      </span>
                    )}
                  </div>
                  <h2 className="mt-0.5 font-display text-[20px] font-semibold text-[var(--text-primary)]">
                    {activeOrIntendedHost.displayName}
                  </h2>
                  <p className="text-[12px] text-[var(--text-muted)]">
                    {clientSnap?.activeEndpointDisplay ??
                      `${activeOrIntendedHost.lastAddress}:${activeOrIntendedHost.port}`}{' '}
                    · {clientSnap?.summary?.totalSharedTracks ?? connect.remoteTracksTotal} bài hát ·{' '}
                    {clientSnap?.summary?.totalAlbums ?? connect.remoteAlbums.length} album
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[12px] text-[var(--text-secondary)]">
                    <span className="text-[11px] text-[var(--text-muted)]">Chế độ:</span>
                    <select
                      data-testid="active-connection-mode-select"
                      value={activeMode}
                      disabled={connect.isLoadingClient}
                      onChange={(e) =>
                        void connectStore.setConnectionMode(
                          activeOrIntendedHost.hostId,
                          e.target.value as ConnectionSelectionMode,
                        )
                      }
                      className="bg-transparent text-[12px] font-semibold text-[var(--text-primary)] outline-none"
                    >
                      <option value="automatic">Tự động (Ưu tiên LAN)</option>
                      <option value="lan-only">Chỉ LAN</option>
                      <option value="remote-only">Chỉ Remote HTTPS</option>
                    </select>
                  </label>
                  {clientSnap?.status === 'connected' &&
                    clientSnap.activeTransport !== 'remote-https' && (
                    <button
                      type="button"
                      data-testid="client-sync-remote-btn"
                      disabled={connect.isLoadingClient}
                      onClick={() =>
                        void connectStore.syncRemoteAccessOverLan(activeOrIntendedHost.hostId)
                      }
                      className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] px-3 py-2 text-[12px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                      title="Đồng bộ địa chỉ Remote HTTPS đã ký và token truy cập từ xa qua kết nối LAN tin cậy"
                    >
                      <Globe className="h-3.5 w-3.5" />
                      Đồng bộ Remote
                    </button>
                  )}
                  {clientSnap?.status === 'connected' && (
                    <button
                      type="button"
                      data-testid="client-rotate-token-btn"
                      disabled={connect.isLoadingClient}
                      onClick={() => void connectStore.rotateActiveHostToken()}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] px-3 py-2 text-[12px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                      title="Đổi mới token xác thực với máy Host mà không cần ghép nối lại"
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                      Xoay vòng Token
                    </button>
                  )}
                  {clientSnap?.status === 'connected' ? (
                    <button
                      type="button"
                      onClick={() => void connectStore.loadRemoteLibrary({ forceRefresh: true })}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] px-3 py-2 text-[12px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Làm mới
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-testid="client-manual-reconnect-btn"
                      disabled={connect.isLoadingClient}
                      onClick={() => void connectStore.manualReconnect()}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-amber-400/35 bg-amber-500/15 px-3 py-2 text-[12px] font-semibold text-amber-200 hover:bg-amber-500/25 disabled:opacity-50"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Thử kết nối lại
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="client-disconnect-btn"
                    onClick={() => void connectStore.disconnectClient()}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-rose-500/35 bg-rose-500/12 px-3.5 py-2 text-[12px] font-semibold text-rose-300 hover:bg-rose-500/20"
                  >
                    <WifiOff className="h-3.5 w-3.5" />
                    Ngắt kết nối
                  </button>
                </div>
              </div>

              {/* Remote Library Browsing Controls */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-4">
                <div className="flex items-center gap-2">
                  {(['tracks', 'albums', 'artists'] as const).map((sub) => (
                    <button
                      key={sub}
                      type="button"
                      onClick={() => setRemoteViewTab(sub)}
                      className={`rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition ${
                        remoteViewTab === sub
                          ? 'bg-[var(--surface-hover)] text-[var(--text-primary)]'
                          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      {sub === 'tracks' ? 'Bài hát' : sub === 'albums' ? 'Album' : 'Nghệ sĩ'}
                    </button>
                  ))}
                  {(connect.remoteSearchQuery || connect.selectedRemoteAlbumKey || connect.selectedRemoteArtist) && (
                    <button
                      type="button"
                      data-testid="remote-clear-filters-btn"
                      onClick={() => {
                        setRemoteViewTab('tracks');
                        void connectStore.clearRemoteFilters();
                      }}
                      className="inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-3 py-1 text-[11.5px] font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                    >
                      <X className="h-3 w-3" />
                      Xóa bộ lọc
                    </button>
                  )}
                </div>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void connectStore.searchRemoteLibrary(connect.remoteSearchInput);
                  }}
                  className="flex items-center gap-2"
                >
                  <div className="relative flex items-center">
                    <input
                      type="text"
                      data-testid="remote-search-input"
                      placeholder="Tìm bài hát, nghệ sĩ, album trên Host..."
                      value={connect.remoteSearchInput}
                      onChange={(e) => connectStore.setRemoteSearchInput(e.target.value)}
                      className="w-64 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] py-1.5 pl-3 pr-8 text-[12.5px] text-[var(--text-primary)] outline-none"
                    />
                    {(connect.remoteSearchInput || connect.remoteSearchQuery) && (
                      <button
                        type="button"
                        data-testid="remote-search-clear-btn"
                        aria-label="Xóa tìm kiếm"
                        onClick={() => void connectStore.clearRemoteSearch()}
                        className="absolute right-2 rounded-md p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <button
                    type="submit"
                    data-testid="remote-search-submit-btn"
                    className="rounded-xl border border-[var(--border-glass)] bg-[var(--surface-hover)] px-3 py-1.5 text-[12px] font-semibold text-[var(--text-primary)]"
                  >
                    Tìm
                  </button>
                </form>
              </div>

              {(connect.remoteSearchQuery || connect.selectedRemoteAlbumKey || connect.selectedRemoteArtist) && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-3.5 py-2 text-[12px]">
                  <span className="text-[var(--text-secondary)]">
                    Đang hiển thị kết quả đã lọc
                    {connect.remoteSearchQuery ? ` · Từ khóa: "${connect.remoteSearchQuery}"` : ''}
                    {connect.selectedRemoteArtist ? ` · Nghệ sĩ: ${connect.selectedRemoteArtist}` : ''}
                    {connect.selectedRemoteAlbumKey ? ' · Theo Album đã chọn' : ''}
                    {` (${connect.remoteTracksTotal} bài)`}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setRemoteViewTab('tracks');
                      void connectStore.clearRemoteFilters();
                    }}
                    className="font-semibold text-[var(--text-primary)] underline underline-offset-2"
                  >
                    Về thư viện đầy đủ
                  </button>
                </div>
              )}

              {/* Remote Library Content */}
              {remoteViewTab === 'tracks' && (
                <div className="space-y-2">
                  {connect.remoteLibraryError ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-500/35 bg-rose-500/10 px-4 py-3 text-[13px] text-rose-200">
                      <span>Không thể tải danh sách từ Host: {connect.remoteLibraryError}</span>
                      <button
                        type="button"
                        onClick={() => void connectStore.loadRemoteLibrary({ forceRefresh: true })}
                        className="rounded-xl bg-rose-500/20 px-3 py-1.5 text-[12px] font-semibold text-rose-100"
                      >
                        Thử lại
                      </button>
                    </div>
                  ) : connect.remoteTracks.length === 0 ? (
                    <div className="py-6 text-center text-[13px] text-[var(--text-muted)]">
                      <p>
                        {connect.isLoadingRemoteLibrary
                          ? 'Đang tải thư viện từ Host...'
                          : connect.remoteSearchQuery || connect.selectedRemoteAlbumKey || connect.selectedRemoteArtist
                            ? 'Không tìm thấy bài hát phù hợp với bộ lọc hiện tại.'
                            : 'Thư viện chia sẻ trên Host hiện chưa có bài hát nào.'}
                      </p>
                      {!connect.isLoadingRemoteLibrary &&
                        (connect.remoteSearchQuery || connect.selectedRemoteAlbumKey || connect.selectedRemoteArtist) && (
                          <button
                            type="button"
                            onClick={() => void connectStore.clearRemoteFilters()}
                            className="mt-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-3.5 py-1.5 text-[12px] font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                          >
                            Xóa tìm kiếm &amp; hiển thị tất cả
                          </button>
                        )}
                    </div>
                  ) : (
                    connect.remoteTracks.map((dto) => {
                      const compositeId = `remote::${activeOrIntendedHost.hostId}::${dto.trackId}`;
                      const isCurrent = playback.currentTrackId === compositeId;
                      const thumbUrl = dto.hasArtwork
                        ? buildRemoteArtworkMediaUrl(
                            activeOrIntendedHost.hostId,
                            dto.trackId,
                            'thumb',
                            dto.artworkHash,
                          )
                        : DEFAULT_DOREMI_ARTWORK_URL;
                      return (
                        <div
                          key={dto.trackId}
                          data-testid={`remote-track-row-${dto.trackId}`}
                          className={`flex items-center justify-between gap-3 rounded-2xl border px-3.5 py-2.5 transition ${
                            isCurrent
                              ? 'border-[var(--border-glass)] bg-[var(--surface-hover)]'
                              : 'border-[var(--border-subtle)] bg-[var(--surface-glass-light)] hover:bg-[var(--surface-hover)]'
                          }`}
                        >
                          <div className="flex min-w-0 flex-1 items-center gap-3">
                            <img
                              src={thumbUrl}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              className="h-10 w-10 shrink-0 rounded-lg object-cover"
                              onError={(e) => {
                                e.currentTarget.src = DEFAULT_DOREMI_ARTWORK_URL;
                              }}
                            />
                            <div className="min-w-0">
                              <p className="truncate text-[13.5px] font-semibold text-[var(--text-primary)]">
                                {dto.title}
                              </p>
                              <p className="truncate text-[11.5px] text-[var(--text-muted)]">
                                {dto.artist}
                                {dto.album ? ` · ${dto.album}` : ''} ·{' '}
                                {(dto.codec || dto.container || 'AUDIO').toUpperCase()}
                                {dto.bitDepth ? ` ${dto.bitDepth}-bit` : ''}
                                {dto.sampleRateHz
                                  ? `/${Number((dto.sampleRateHz / 1000).toFixed(1))}kHz`
                                  : ''}
                              </p>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-2">
                            <span className="font-mono-tabular text-[11.5px] text-[var(--text-muted)]">
                              {dto.durationMs ? formatDurationSeconds(Math.round(dto.durationMs / 1000)) : '—'}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleQueueRemote(dto, true)}
                              title="Phát tiếp theo"
                              className="rounded-lg border border-[var(--border-subtle)] p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]"
                            >
                              <ListPlus className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handlePlayRemote(dto)}
                              style={{
                                backgroundColor: `rgba(${userAccent.glowRgb}, 0.2)`,
                                color: userAccent.activeHex,
                              }}
                              className="inline-flex items-center gap-1 rounded-xl px-3 py-1.5 text-[12px] font-semibold"
                            >
                              <Play className="h-3.5 w-3.5 fill-current" />
                              Phát
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}

                  {connect.remoteTracksHasMore && (
                    <div className="pt-2 text-center">
                      <button
                        type="button"
                        onClick={() => void connectStore.loadRemoteLibrary({ append: true })}
                        className="rounded-xl border border-[var(--border-subtle)] px-4 py-2 text-[12px] font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                      >
                        Tải thêm ({connect.remoteTracks.length}/{connect.remoteTracksTotal})
                      </button>
                    </div>
                  )}
                </div>
              )}

              {remoteViewTab === 'albums' && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {connect.remoteAlbums.map((alb) => (
                    <button
                      key={alb.albumKey}
                      type="button"
                      onClick={() => {
                        setRemoteViewTab('tracks');
                        void connectStore.loadRemoteLibrary({ albumKey: alb.albumKey, artist: null });
                      }}
                      className="flex items-center gap-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-3 text-left transition hover:bg-[var(--surface-hover)]"
                    >
                      <Disc3 className="h-9 w-9 shrink-0 text-[var(--text-muted)]" />
                      <div className="min-w-0">
                        <p className="truncate text-[13.5px] font-semibold text-[var(--text-primary)]">
                          {alb.title}
                        </p>
                        <p className="truncate text-[11.5px] text-[var(--text-muted)]">
                          {alb.artist} · {alb.trackCount} bài
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {remoteViewTab === 'artists' && (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                  {connect.remoteArtists.map((art) => (
                    <button
                      key={art.name}
                      type="button"
                      onClick={() => {
                        setRemoteViewTab('tracks');
                        void connectStore.loadRemoteLibrary({ artist: art.name, albumKey: null });
                      }}
                      className="flex items-center justify-between rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-4 py-3 text-left transition hover:bg-[var(--surface-hover)]"
                    >
                      <span className="truncate text-[13.5px] font-semibold text-[var(--text-primary)]">
                        {art.name}
                      </span>
                      <span className="text-[11.5px] text-[var(--text-muted)]">
                        {art.trackCount} bài · {art.albumCount} album
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Client Error / Reconnect / Handover Banner */}
          {clientSnap &&
            clientSnap.status !== 'connected' &&
            (clientSnap.lastError ||
              clientSnap.status === 'reconnecting' ||
              clientSnap.status === 'connecting') && (
            <div
              data-testid="client-connection-status-banner"
              className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4 text-[13px] ${
                smartStatus.tone === 'rose'
                  ? 'border-rose-500/35 bg-rose-500/10 text-rose-200'
                  : 'border-amber-500/35 bg-amber-500/10 text-amber-200'
              }`}
            >
              <div>
                <strong>{smartStatus.label}</strong>
                {clientSnap.reconnectAttempt > 0 ? ` (lần thử ${clientSnap.reconnectAttempt})` : ''}
                {clientSnap.lastError ? ` · ${clientSnap.lastError}` : ''}
              </div>
              <div className="flex items-center gap-2">
                {activeOrIntendedHost &&
                  smartStatus.tone !== 'rose' &&
                  clientSnap.status !== 'connecting' && (
                  <button
                    type="button"
                    onClick={() => void connectStore.manualReconnect()}
                    className="rounded-xl bg-amber-500/20 px-3 py-1.5 text-[12px] font-semibold"
                  >
                    Thử kết nối lại
                  </button>
                )}
                {activeOrIntendedHost && (
                  <button
                    type="button"
                    onClick={() => void connectStore.disconnectClient()}
                    className="rounded-xl border border-current/25 px-3 py-1.5 text-[12px] font-medium"
                  >
                    Dừng thử lại
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {/* Discovered + Remembered Hosts */}
            <div className="lp-glass-panel space-y-5 rounded-[26px] p-6">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-display text-[18px] font-semibold text-[var(--text-primary)]">
                  Máy Host trong mạng LAN
                </h2>
                <button
                  type="button"
                  data-testid="client-discover-btn"
                  disabled={clientSnap?.isDiscovering}
                  onClick={() => void connectStore.discoverHosts()}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-glass)] bg-[var(--surface-hover)] px-3 py-1.5 text-[12px] font-semibold text-[var(--text-primary)] disabled:opacity-50"
                >
                  <Radar className="h-3.5 w-3.5" />
                  {clientSnap?.isDiscovering ? 'Đang quét mDNS...' : 'Quét LAN'}
                </button>
              </div>

              {(clientSnap?.discoveredHosts ?? []).length === 0 ? (
                <p className="text-[12.5px] text-[var(--text-muted)]">
                  Chưa phát hiện máy Host tự động qua mDNS. Nếu router hoặc Wi-Fi chặn multicast (AP Isolation), bạn có thể nhập trực tiếp địa chỉ IP bên cạnh.
                </p>
              ) : (
                <div className="space-y-2">
                  {clientSnap!.discoveredHosts.map((h) => (
                    <div
                      key={h.hostId}
                      className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-4 py-3"
                    >
                      <div>
                        <p className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                          {h.displayName}
                        </p>
                        <p className="font-mono-tabular text-[11.5px] text-[var(--text-muted)]">
                          {h.address}:{h.port} · API v{h.apiVersion} · FP: {h.fingerprintPrefix || '—'}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setManualAddress(h.address);
                          setManualPort(String(h.port));
                          void connectStore.probeHost(h.address, h.port);
                        }}
                        className="rounded-xl border border-[var(--border-glass)] px-3 py-1.5 text-[12px] font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                      >
                        Chọn Host
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="border-t border-[var(--border-subtle)] pt-4">
                <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                  Host đã ghi nhớ ({clientSnap?.rememberedHosts.length ?? 0})
                </h3>
                {(clientSnap?.rememberedHosts ?? []).length === 0 ? (
                  <p className="mt-2 text-[12.5px] text-[var(--text-muted)]">
                    Chưa có Host nào được ghép nối.
                  </p>
                ) : (
                  <div className="mt-2.5 space-y-2">
                    {clientSnap!.rememberedHosts.map((rh) => {
                      const isThisConnected =
                        clientSnap?.status === 'connected' &&
                        clientSnap.activeHost?.hostId === rh.hostId;
                      const rhMode: ConnectionSelectionMode = rh.connectionMode ?? 'automatic';
                      return (
                        <div
                          key={rh.hostId}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3.5 py-2.5"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
                              {rh.displayName}
                            </p>
                            <p className="font-mono-tabular text-[11px] text-[var(--text-muted)]">
                              LAN: {rh.lastAddress}:{rh.port} · {rh.shortFingerprint}
                              {rh.remoteEndpoint && rh.hasRemoteCredential
                                ? ' · Đã sẵn sàng Remote HTTPS'
                                : ''}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <select
                              data-testid={`connection-mode-select-${rh.hostId}`}
                              value={rhMode}
                              disabled={connect.isLoadingClient}
                              onChange={(e) =>
                                void connectStore.setConnectionMode(
                                  rh.hostId,
                                  e.target.value as ConnectionSelectionMode,
                                )
                              }
                              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-2 py-1 text-[11.5px] font-medium text-[var(--text-primary)] outline-none"
                              title="Chọn chính sách kết nối cho Host này"
                            >
                              <option value="automatic">Tự động</option>
                              <option value="lan-only">Chỉ LAN</option>
                              <option value="remote-only">Chỉ Remote</option>
                            </select>
                            {isThisConnected ? (
                              <span className="rounded-lg bg-emerald-500/15 px-2.5 py-1 text-[11.5px] font-semibold text-emerald-300">
                                {clientSnap.activeTransport === 'remote-https'
                                  ? 'Đang kết nối qua Remote HTTPS'
                                  : 'Đang kết nối qua LAN'}
                              </span>
                            ) : (
                              <button
                                type="button"
                                data-testid={`connect-host-${rh.hostId}`}
                                disabled={connect.isLoadingClient}
                                onClick={() =>
                                  void connectStore.connectToRememberedHost(rh.hostId)
                                }
                                className="rounded-lg border border-[var(--border-glass)] bg-[var(--surface-hover)] px-2.5 py-1 text-[11.5px] font-semibold text-[var(--text-primary)] disabled:opacity-50"
                              >
                                Kết nối
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => void connectStore.removeRememberedHost(rh.hostId)}
                              className="rounded-lg border border-[var(--border-subtle)] p-1 text-[var(--text-muted)] hover:text-rose-300"
                              title="Quên Host này"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* QR Image & Versioned Pairing Payload + Manual Fallback */}
            <div className="lp-glass-panel space-y-4 rounded-[26px] p-6">
              <div
                data-testid="client-qr-pairing-panel"
                className="space-y-3 border-b border-[var(--border-subtle)] pb-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <QrCode className="h-4 w-4" style={{ color: userAccent.activeHex }} />
                    <h2 className="font-display text-[18px] font-semibold text-[var(--text-primary)]">
                      Ghép nối nhanh bằng QR / Payload (Offline)
                    </h2>
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-[var(--border-glass)] bg-[var(--surface-hover)] px-3 py-1.5 text-[12px] font-semibold text-[var(--text-primary)]">
                    <Upload className="h-3.5 w-3.5" />
                    Nhập ảnh QR
                    <input
                      type="file"
                      accept="image/*"
                      data-testid="client-qr-file-input"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        setQrDecodeError(null);
                        void decodeQrFromImageFile(file)
                          .then((decodedText) => {
                            setPairingPayloadDraft(decodedText);
                          })
                          .catch((err) => {
                            setQrDecodeError(err instanceof Error ? err.message : String(err));
                          });
                      }}
                    />
                  </label>
                </div>

                <textarea
                  data-testid="client-pairing-payload-input"
                  value={pairingPayloadDraft}
                  onChange={(e) => {
                    setQrDecodeError(null);
                    setPairingPayloadDraft(e.target.value);
                  }}
                  maxLength={PAIRING_PAYLOAD_MAX_BYTES * 2}
                  rows={3}
                  placeholder='Dán chuỗi JSON "doremi-pair" v1 hoặc chọn file ảnh QR để giải mã cục bộ...'
                  className="font-mono-tabular w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-[11.5px] text-[var(--text-primary)]"
                />

                {qrDecodeError && (
                  <p data-testid="qr-decode-error" className="text-[12px] text-rose-300">
                    {qrDecodeError}
                  </p>
                )}

                {parsedClientPairingPreview && (
                  <div
                    data-testid="pairing-payload-preview"
                    className={`rounded-2xl border p-3 text-[12px] ${
                      parsedClientPairingPreview.ok
                        ? 'border-emerald-500/35 bg-emerald-500/10'
                        : 'border-rose-500/35 bg-rose-500/10'
                    }`}
                  >
                    {parsedClientPairingPreview.ok ? (
                      <div className="space-y-1.5">
                        <p className="font-semibold text-emerald-300">
                          Payload hợp lệ · Host: {parsedClientPairingPreview.payload.hostName}
                        </p>
                        <p className="font-mono-tabular text-[11px] text-[var(--text-secondary)]">
                          LAN Endpoints:{' '}
                          {parsedClientPairingPreview.payload.endpoints
                            .map((ep) => `${ep.address}:${ep.port}`)
                            .join(', ')}
                        </p>
                        <p className="font-mono-tabular break-all text-[11px] text-[var(--text-muted)]">
                          Pinned SPKI SHA-256: {parsedClientPairingPreview.payload.identityFingerprint}
                        </p>
                      </div>
                    ) : (
                      <p className="text-rose-200">
                        Payload không hợp lệ ({parsedClientPairingPreview.code}): {parsedClientPairingPreview.message}
                      </p>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={clientDeviceName}
                    onChange={(e) => setClientDeviceName(e.target.value)}
                    maxLength={48}
                    placeholder="Tên thiết bị này"
                    className="min-w-[180px] flex-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-[12.5px] text-[var(--text-primary)]"
                  />
                  <button
                    type="button"
                    data-testid="submit-payload-enroll-btn"
                    disabled={!parsedClientPairingPreview?.ok || connect.isLoadingClient}
                    onClick={() =>
                      void connectStore
                        .enrollFromPairingPayload({
                          rawPayload: pairingPayloadDraft,
                          deviceName: clientDeviceName,
                        })
                        .then((snap) => {
                          if (snap?.status === 'connected') {
                            setPairingPayloadDraft('');
                          }
                        })
                    }
                    style={{
                      backgroundColor: `rgba(${userAccent.glowRgb}, 0.22)`,
                      borderColor: userAccent.activeHex,
                    }}
                    className="rounded-xl border px-4 py-2 text-[12.5px] font-semibold text-[var(--text-primary)] disabled:opacity-45"
                  >
                    Xác nhận &amp; Ghép nối QR
                  </button>
                </div>
              </div>

              <h2 className="font-display text-[18px] font-semibold text-[var(--text-primary)]">
                Kết nối thủ công &amp; Ghép nối thiết bị
              </h2>

              <div className="grid grid-cols-3 gap-2.5">
                <label className="col-span-2 space-y-1 text-[12px]">
                  <span className="text-[var(--text-muted)]">Địa chỉ IP LAN của Host</span>
                  <input
                    type="text"
                    data-testid="manual-host-ip-input"
                    value={manualAddress}
                    onChange={(e) => setManualAddress(e.target.value)}
                    placeholder="Ví dụ: 192.168.1.20"
                    className="font-mono-tabular w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-[13px] text-[var(--text-primary)]"
                  />
                </label>
                <label className="space-y-1 text-[12px]">
                  <span className="text-[var(--text-muted)]">Cổng</span>
                  <input
                    type="number"
                    data-testid="manual-host-port-input"
                    value={manualPort}
                    onChange={(e) => setManualPort(e.target.value)}
                    className="font-mono-tabular w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-[13px] text-[var(--text-primary)]"
                  />
                </label>
              </div>

              <button
                type="button"
                data-testid="probe-host-btn"
                disabled={connect.isProbing}
                onClick={() =>
                  void connectStore.probeHost(manualAddress, Number.parseInt(manualPort, 10) || 48620)
                }
                className="w-full rounded-xl border border-[var(--border-glass)] bg-[var(--surface-hover)] py-2 text-[12.5px] font-semibold text-[var(--text-primary)] disabled:opacity-50"
              >
                {connect.isProbing ? 'Đang kiểm tra chứng chỉ TLS Host...' : '1. Kiểm tra & Xác minh Host'}
              </button>

              {connect.probeResult && (
                <div
                  data-testid="host-probe-result"
                  className={`space-y-3 rounded-2xl border p-4 text-[12.5px] ${
                    !connect.probeResult.reachable || connect.probeResult.pinnedFingerprintMismatch
                      ? 'border-rose-500/35 bg-rose-500/10'
                      : 'border-emerald-500/30 bg-emerald-500/10'
                  }`}
                >
                  {!connect.probeResult.reachable || !connect.probeResult.capabilities ? (
                    <p className="text-rose-200">
                      Không thể kết nối Host: {connect.probeResult.errorMessage}
                    </p>
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-semibold text-[var(--text-primary)]">
                            {connect.probeResult.capabilities.hostDisplayName}
                          </p>
                          <p className="text-[11.5px] text-[var(--text-secondary)]">
                            API v{connect.probeResult.capabilities.apiVersion} ·{' '}
                            {connect.probeResult.capabilities.enrollmentOpen
                              ? 'Đang mở mã mời ghép nối'
                              : 'Chưa mở mã mời ghép nối'}
                          </p>
                        </div>
                        <Shield className="h-4 w-4 text-emerald-400" />
                      </div>

                      <div className="rounded-xl bg-[var(--bg-elevated)] p-2.5">
                        <p className="text-[11px] text-[var(--text-muted)]">
                          Đối chiếu mã xác minh này với màn hình Host trước khi gửi mã mời:
                        </p>
                        <code className="font-mono-tabular mt-1 block text-[14px] font-bold text-[var(--text-primary)]">
                          {connect.probeResult.observedShortFingerprint}
                        </code>
                      </div>

                      {connect.probeResult.pinnedFingerprintMismatch && (
                        <p className="font-semibold text-rose-300">
                          CẢNH BÁO: Chứng chỉ Host đã thay đổi so với lần kết nối trước! Không tự động tin cậy nếu bạn không đổi khóa định danh trên Host.
                        </p>
                      )}

                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                        <label className="space-y-1 text-[11.5px]">
                          <span className="text-[var(--text-muted)]">Mã mời dùng 1 lần từ Host</span>
                          <input
                            type="text"
                            data-testid="enroll-invite-code-input"
                            value={inviteCodeDraft}
                            onChange={(e) => setInviteCodeDraft(e.target.value)}
                            placeholder="XXXX-XXXX-XXXX"
                            className="font-mono-tabular w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 text-[12.5px] text-[var(--text-primary)]"
                          />
                        </label>
                        <label className="space-y-1 text-[11.5px]">
                          <span className="text-[var(--text-muted)]">Tên thiết bị này</span>
                          <input
                            type="text"
                            value={clientDeviceName}
                            onChange={(e) => setClientDeviceName(e.target.value)}
                            maxLength={48}
                            className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 text-[12.5px] text-[var(--text-primary)]"
                          />
                        </label>
                      </div>

                      <button
                        type="button"
                        data-testid="submit-enroll-btn"
                        disabled={
                          !connect.probeResult.observedFingerprintSha256 ||
                          inviteCodeDraft.trim().length < 8 ||
                          connect.isLoadingClient
                        }
                        onClick={() =>
                          void connectStore.enrollWithHost({
                            address: connect.probeResult!.address,
                            port: connect.probeResult!.port,
                            expectedFingerprintSha256:
                              connect.probeResult!.observedFingerprintSha256!,
                            inviteCode: inviteCodeDraft,
                            deviceName: clientDeviceName,
                          })
                        }
                        style={{
                          backgroundColor: `rgba(${userAccent.glowRgb}, 0.22)`,
                          borderColor: userAccent.activeHex,
                        }}
                        className="w-full rounded-xl border py-2 text-[12.5px] font-semibold text-[var(--text-primary)] disabled:opacity-45"
                      >
                        2. Xác nhận vân tay &amp; Ghép nối
                      </button>

                      {clientSnap?.enrollment.status !== 'idle' && clientSnap?.enrollment.message && (
                        <p className="text-[12px] text-[var(--text-secondary)]">
                          {clientSnap.enrollment.message}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        );
      })()}

      {/* =================================================================== */}
      {/* E. RESOURCE USAGE                                                   */}
      {/* =================================================================== */}
      {tab === 'resources' && hostSnap && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {/* Host-specific metrics */}
            <div className="lp-glass-panel space-y-3 rounded-[24px] p-5">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4" style={{ color: userAccent.activeHex }} />
                <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                  Chỉ số riêng của Host
                </h3>
              </div>
              <dl className="space-y-2 text-[12.5px]">
                <div className="flex justify-between">
                  <dt className="text-[var(--text-muted)]">Trạng thái</dt>
                  <dd className="font-semibold text-[var(--text-primary)]">{hostSnap.metrics.hostMetrics.state}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--text-muted)]">Thời gian hoạt động</dt>
                  <dd className="font-mono-tabular text-[var(--text-primary)]">
                    {formatUptime(hostSnap.metrics.hostMetrics.uptimeMs)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--text-muted)]">Phiên stream hoạt động</dt>
                  <dd className="font-mono-tabular text-[var(--text-primary)]">
                    {hostSnap.metrics.hostMetrics.activePlaybackSessions}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--text-muted)]">Tốc độ payload đang gửi</dt>
                  <dd className="font-mono-tabular text-[var(--text-primary)]">
                    {hostSnap.state === 'STOPPED'
                      ? 'Không khả dụng (Host tắt)'
                      : `${formatBytes(hostSnap.metrics.hostMetrics.currentThroughputBytesPerSec)}/s`}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--text-muted)]">Đã đọc từ streamer</dt>
                  <dd className="font-mono-tabular text-[var(--text-primary)]">
                    {formatBytes(hostSnap.metrics.hostMetrics.totalBytesReadByStreamer)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--text-muted)]">Đã gửi tới Client</dt>
                  <dd className="font-mono-tabular text-[var(--text-primary)]">
                    {formatBytes(hostSnap.metrics.hostMetrics.totalBytesTransmitted)}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Total DoReMi Process Metrics */}
            <div className="lp-glass-panel space-y-3 rounded-[24px] p-5">
              <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                Tiến trình DoReMi (Main)
              </h3>
              <dl className="space-y-2 text-[12.5px]">
                <div className="flex justify-between">
                  <dt className="text-[var(--text-muted)]">CPU tiến trình Main</dt>
                  <dd className="font-mono-tabular text-[var(--text-primary)]">
                    {hostSnap.metrics.appProcessMetrics.processCpuPercent !== null
                      ? `${hostSnap.metrics.appProcessMetrics.processCpuPercent}%`
                      : 'Không đo (Host tắt)'}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--text-muted)]">Bộ nhớ RSS</dt>
                  <dd className="font-mono-tabular text-[var(--text-primary)]">
                    {formatBytes(hostSnap.metrics.appProcessMetrics.rssBytes)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--text-muted)]">JS Heap đang dùng</dt>
                  <dd className="font-mono-tabular text-[var(--text-primary)]">
                    {formatBytes(hostSnap.metrics.appProcessMetrics.heapUsedBytes)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--text-muted)]">Cache Metadata / Ảnh bìa</dt>
                  <dd className="font-mono-tabular text-[var(--text-primary)]">
                    {hostSnap.metrics.hostMetrics.metadataCacheEntries} /{' '}
                    {hostSnap.metrics.hostMetrics.artworkCacheEntries} mục
                  </dd>
                </div>
              </dl>
            </div>

            {/* System-wide Metrics */}
            <div className="lp-glass-panel space-y-3 rounded-[24px] p-5">
              <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                Toàn hệ thống Windows
              </h3>
              <dl className="space-y-2 text-[12.5px]">
                <div className="flex justify-between">
                  <dt className="text-[var(--text-muted)]">RAM hệ thống còn trống</dt>
                  <dd className="font-mono-tabular text-[var(--text-primary)]">
                    {formatBytes(hostSnap.metrics.systemMetrics.freeMemoryBytes)} /{' '}
                    {formatBytes(hostSnap.metrics.systemMetrics.totalMemoryBytes)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--text-muted)]">Luồng CPU logic</dt>
                  <dd className="font-mono-tabular text-[var(--text-primary)]">
                    {hostSnap.metrics.systemMetrics.logicalCpuCount} luồng
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--text-muted)]">Nhiệt độ / Tuổi thọ ổ đĩa</dt>
                  <dd className="text-[var(--text-muted)]">Không khả dụng</dd>
                </div>
              </dl>
            </div>
          </div>

          <p className="text-[12px] text-[var(--text-muted)]">
            Ghi chú đo lường: Số byte đọc là dữ liệu mà trình stream đã đọc từ API tệp (hệ điều hành Windows có thể dùng RAM file cache để giảm đọc đĩa vật lý). Tốc độ payload chỉ tính dữ liệu âm thanh được truyền bởi Host, không tính lưu lượng mạng khác của hệ thống.
          </p>
        </div>
      )}

      {/* =================================================================== */}
      {/* F. DIAGNOSTICS                                                      */}
      {/* =================================================================== */}
      {tab === 'diagnostics' && (
        <div className="lp-glass-panel space-y-5 rounded-[26px] p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-[20px] font-semibold text-[var(--text-primary)]">
                Chẩn đoán &amp; Khắc phục sự cố LAN
              </h2>
              <p className="mt-1 text-[13px] text-[var(--text-muted)]">
                Trạng thái thực tế của Host, Client, luồng phát nhạc LAN (Stream Traces) và hướng dẫn cấu hình mạng nội bộ Windows.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void connectStore.refreshSnapshots()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-3 py-1.5 text-[12px] font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Làm mới
              </button>
              <button
                type="button"
                onClick={() => {
                  const report = JSON.stringify(
                    {
                      generatedAt: new Date().toISOString(),
                      hostDiagnostics: hostSnap?.diagnostics ?? null,
                      clientDiagnostics: clientDiag ?? null,
                    },
                    null,
                    2,
                  );
                  void navigator.clipboard?.writeText(report).then(() => {
                    setCopiedDiagReport(true);
                    setTimeout(() => setCopiedDiagReport(false), 2000);
                  });
                }}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-3 py-1.5 text-[12px] font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
              >
                {copiedDiagReport ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedDiagReport ? 'Đã sao chép' : 'Sao chép báo cáo Connect'}
              </button>
            </div>
          </div>

          {hostSnap && (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-4 text-[12.5px]">
                  <p className="text-[var(--text-muted)]">Trạng thái Host</p>
                  <p className="mt-1 font-semibold text-[var(--text-primary)]">{hostSnap.diagnostics.hostState}</p>
                </div>
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-4 text-[12.5px]">
                  <p className="text-[var(--text-muted)]">mDNS Discovery</p>
                  <p className="mt-1 font-semibold text-[var(--text-primary)]">
                    {hostSnap.diagnostics.discoveryState === 'advertising'
                      ? 'Đang quảng bá (_doremi._tcp.local)'
                      : hostSnap.diagnostics.discoveryState === 'unavailable'
                        ? 'Không khả dụng (dùng kết nối IP thủ công)'
                        : 'Đang tắt'}
                  </p>
                </div>
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-4 text-[12.5px]">
                  <p className="text-[var(--text-muted)]">Mạng LAN nội bộ</p>
                  <p className="mt-1 font-semibold text-[var(--text-primary)]">
                    {hostSnap.diagnostics.networkAvailable ? 'Có giao diện IPv4 Private' : 'Chưa phát hiện IP LAN'}
                  </p>
                </div>
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-4 text-[12.5px]">
                  <p className="text-[var(--text-muted)]">Cấu trúc bảo vệ</p>
                  <p className="mt-1 font-semibold text-emerald-300">
                    TLS ≥ 1.2 + SPKI Pinning ·{' '}
                    {hostSnap.identity?.storageBackend === 'electron-safe-storage'
                      ? 'DPAPI SafeStorage'
                      : hostSnap.identity?.storageBackend === 'unavailable'
                        ? 'SafeStorage Không khả dụng'
                        : 'Fallback AES-256'}
                  </p>
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-4 text-[13px] leading-relaxed text-[var(--text-secondary)]">
                <p className="font-semibold text-[var(--text-primary)]">Hướng dẫn tường lửa Windows &amp; Wi-Fi:</p>
                <p className="mt-1">{hostSnap.diagnostics.firewallNote}</p>
                <p className="mt-1.5 text-[12px] text-[var(--text-muted)]">
                  Nếu thiết bị khác báo hết thời gian kết nối dù cùng Wi-Fi, hãy kiểm tra mục AP/Client Isolation trên Router hoặc dùng tính năng Kết nối thủ công bằng IP LAN + Cổng ({hostSnap.config.port}).
                </p>
              </div>
            </>
          )}

          {/* Client Streaming Diagnostics */}
          <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-4 text-[12.5px]">
            <p className="font-semibold text-[var(--text-primary)]">Chẩn đoán Client &amp; Smart Connection Manager</p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-4 text-[12px]">
              <div>
                <span className="text-[var(--text-muted)]">Trạng thái thông minh: </span>
                <span className="font-mono-tabular text-[var(--text-primary)]">
                  {clientDiag?.smartConnection?.smartState ?? clientSnap?.smartState ?? clientSnap?.status ?? 'DISCONNECTED'}
                </span>
              </div>
              <div>
                <span className="text-[var(--text-muted)]">Chế độ / Đường truyền: </span>
                <span className="text-[var(--text-primary)]">
                  {formatConnectionModeLabel(
                    clientDiag?.smartConnection?.selectedMode ?? clientSnap?.selectedMode,
                  )}{' '}
                  · {clientDiag?.activeTransport ?? clientSnap?.activeTransport ?? 'none'}
                </span>
              </div>
              <div>
                <span className="text-[var(--text-muted)]">Host đang kết nối: </span>
                <span className="text-[var(--text-primary)]">
                  {clientDiag?.activeHostName
                    ? `${clientDiag.activeHostName} (${clientDiag.activeEndpointDisplay ?? `${clientDiag.activeHostAddress}:${clientDiag.activeHostPort}`})`
                    : 'Không'}
                </span>
              </div>
              <div>
                <span className="text-[var(--text-muted)]">Lỗi luồng gần nhất: </span>
                <span className="font-mono-tabular text-[var(--text-primary)]">
                  {clientDiag?.lastTrackFailure?.errorCode ?? clientDiag?.lastErrorCode ?? 'Không có'}
                </span>
              </div>
            </div>
            {clientDiag?.lastTrackFailure && (
              <p className="mt-2 rounded-lg bg-[var(--bg-elevated)] px-3 py-2 text-[11.5px] text-rose-300">
                [{clientDiag.lastTrackFailure.timestamp}] {clientDiag.lastTrackFailure.kind} track={clientDiag.lastTrackFailure.trackId} · HTTP {clientDiag.lastTrackFailure.statusCode ?? '-'} · {clientDiag.lastTrackFailure.errorCode} ({clientDiag.lastTrackFailure.detail ?? ''})
              </p>
            )}
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowAdvancedDiag((v) => !v)}
              className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--text-primary)]"
            >
              {showAdvancedDiag ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              Chi tiết kỹ thuật &amp; Nhật ký Stream Traces gần đây
            </button>
            {showAdvancedDiag && (
              <div className="mt-3 space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-4 text-[12px]">
                {hostSnap && (
                  <>
                    <p>API Version: v{hostSnap.diagnostics.apiVersion}</p>
                    <p>
                      Listening Port: {hostSnap.diagnostics.listeningPort ?? 'none'} · Addresses:{' '}
                      {hostSnap.diagnostics.listenAddresses.join(', ') || 'none'}
                    </p>
                    {hostSnap.diagnostics.recentErrors.length === 0 ? (
                      <p className="text-[var(--text-muted)]">Không có lỗi Host nào được ghi nhận.</p>
                    ) : (
                      <ul className="space-y-1 text-rose-300">
                        {hostSnap.diagnostics.recentErrors.map((err, idx) => (
                          <li key={idx}>
                            [{err.timestamp}] {err.code}: {err.message}
                          </li>
                        ))}
                      </ul>
                    )}
                    {hostSnap.diagnostics.recentStreamTraces.length > 0 && (
                      <div>
                        <p className="mb-1 font-semibold text-[var(--text-primary)]">Host Stream Traces ({hostSnap.diagnostics.recentStreamTraces.length}):</p>
                        <ul className="max-h-40 space-y-1 overflow-auto font-mono-tabular text-[11px] text-[var(--text-secondary)]">
                          {hostSnap.diagnostics.recentStreamTraces.slice(0, 12).map((tr, idx) => (
                            <li key={idx}>
                              [{tr.timestamp}] {tr.method} {tr.trackId.slice(0, 8)} {tr.rangeHeader ?? 'full'} {'->'} {tr.statusCode} {tr.errorCode ?? 'OK'} ({tr.bytesSent} B, {tr.durationMs}ms)
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
                {hostSnap && hostSnap.diagnostics.recentSecurityEvents && hostSnap.diagnostics.recentSecurityEvents.length > 0 && (
                  <div data-testid="security-events-log">
                    <p className="mb-1 font-semibold text-[var(--text-primary)]">
                      Sự kiện bảo mật Host ({hostSnap.diagnostics.recentSecurityEvents.length}):
                    </p>
                    <ul className="max-h-40 space-y-1 overflow-auto font-mono-tabular text-[11px] text-[var(--text-secondary)]">
                      {hostSnap.diagnostics.recentSecurityEvents.slice(-16).reverse().map((ev, idx) => (
                        <li key={idx}>
                          [{ev.timestamp}] [{ev.category}] ({ev.outcome}) {ev.detail}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {clientDiag && clientDiag.recentSecurityEvents && clientDiag.recentSecurityEvents.length > 0 && (
                  <div>
                    <p className="mb-1 font-semibold text-[var(--text-primary)]">
                      Sự kiện bảo mật Client ({clientDiag.recentSecurityEvents.length}):
                    </p>
                    <ul className="max-h-40 space-y-1 overflow-auto font-mono-tabular text-[11px] text-[var(--text-secondary)]">
                      {clientDiag.recentSecurityEvents.slice(0, 12).map((ev, idx) => (
                        <li key={idx}>
                          [{ev.timestamp}] [{ev.category}] ({ev.outcome}) {ev.detail}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {clientDiag?.smartConnection && (
                  <div className="space-y-1.5 border-b border-[var(--border-subtle)] pb-2.5">
                    <p className="font-semibold text-[var(--text-primary)]">
                      Smart Connection Manager (Gen #{clientDiag.smartConnection.connectionGeneration}):
                    </p>
                    <p className="font-mono-tabular text-[11px] text-[var(--text-secondary)]">
                      Mode={clientDiag.smartConnection.selectedMode} · State={clientDiag.smartConnection.smartState} · Active={clientDiag.smartConnection.activeTransport ?? 'none'} · Alt={clientDiag.smartConnection.alternativeTransportAvailable ?? 'none'} · Reason={clientDiag.smartConnection.selectionReason ?? '-'}
                    </p>
                    <p className="font-mono-tabular text-[11px] text-[var(--text-muted)]">
                      FailureCat={clientDiag.smartConnection.failureCategory} · Retries={clientDiag.smartConnection.retryCount} · HealthChecks={clientDiag.smartConnection.healthCheckCount} · CancelledStreams={clientDiag.smartConnection.streamsCancelledCount} · LAN={clientDiag.smartConnection.candidateTransports.lanDirect.availability} · Remote={clientDiag.smartConnection.candidateTransports.remoteHttps.availability}
                    </p>
                    {clientDiag.smartConnection.recentHandovers.length > 0 && (
                      <ul className="max-h-28 space-y-0.5 overflow-auto font-mono-tabular text-[11px] text-[var(--text-secondary)]">
                        {clientDiag.smartConnection.recentHandovers.slice(0, 8).map((ho) => (
                          <li key={ho.handoverId}>
                            [{ho.completedAt}] #{ho.handoverSeq} {ho.fromTransport ?? 'none'} {'->'} {ho.toTransport} ({ho.strategy}, {ho.durationMs}ms, posErr={ho.positionErrorSec != null ? `${ho.positionErrorSec.toFixed(2)}s` : 'n/a'}, {ho.outcome})
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {clientDiag && clientDiag.recentTraces.length > 0 && (
                  <div>
                    <p className="mb-1 font-semibold text-[var(--text-primary)]">Client Stream Traces ({clientDiag.recentTraces.length}):</p>
                    <ul className="max-h-40 space-y-1 overflow-auto font-mono-tabular text-[11px] text-[var(--text-secondary)]">
                      {clientDiag.recentTraces.slice(0, 12).map((tr, idx) => (
                        <li key={idx}>
                          [{tr.timestamp}] [{tr.kind}] {tr.method} {tr.trackId.slice(0, 8)} {tr.rangeHeader ?? 'full'} {'->'} {tr.statusCode ?? '-'} {tr.contentType ?? ''} {tr.errorCode ?? 'OK'} ({tr.bytesDelivered} B, {tr.durationMs}ms)
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
