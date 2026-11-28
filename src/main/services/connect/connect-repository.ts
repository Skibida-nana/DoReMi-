import crypto from 'node:crypto';
import os from 'node:os';
import type Database from 'better-sqlite3';
import {
  CONNECT_DEFAULT_MAX_CLIENTS,
  CONNECT_DEFAULT_MAX_GLOBAL_REQUESTS,
  CONNECT_DEFAULT_MAX_REQUESTS_PER_DEVICE,
  CONNECT_DEFAULT_PORT,
  clampConnectPageLimit,
  clampConnectPageOffset,
} from '../../../shared/contracts/connect-api';
import {
  CONNECT_REMOTE_DEFAULT_MOUNT_PATH,
  isAllowedFunnelPublicPort,
  normalizeRemoteMountPath,
  validateRemoteEndpointDescriptorShape,
} from '../../../shared/contracts/connect-remote';
import type {
  AuthorizedDeviceRecord,
  ConnectionSelectionMode,
  ConnectTransportMode,
  DeviceAuthState,
  HostConfig,
  HostPowerPolicy,
  RememberedHostRecord,
  RemoteAlbumDto,
  RemoteArtistDto,
  RemoteEndpointDescriptorV1,
  RemoteLibraryPage,
  RemoteLibrarySummaryDto,
  RemoteOwnedRouteRecord,
  RemoteTrackDto,
  SharedSourceRecord,
} from '../../../shared/types/connect';
import type { LibraryRootRecord } from '../../../shared/types/library';
import type { TrackRecord } from '../../../shared/types/track';
import { isNormalizedPathWithinRoot } from '../path-utils';

interface HostConfigRow {
  enabled: number;
  auto_start: number;
  display_name: string;
  port: number;
  bind_address: string;
  max_active_clients: number;
  max_requests_per_device: number;
  max_global_requests: number;
  remote_provider?: string;
  remote_public_port?: number;
  remote_mount_path?: string;
  remote_endpoint_generation?: number;
  remote_owned_route_json?: string | null;
  remote_user_acknowledged?: number;
  updated_at: string;
}

interface AuthorizedDeviceRow {
  device_id: string;
  display_name: string;
  platform: string;
  auth_state: DeviceAuthState;
  token_hash: string;
  token_salt: string;
  enrolled_at: string;
  last_activity_at: string | null;
  last_ip: string | null;
  revoked_at: string | null;
  remote_access_enabled?: number;
  remote_token_hash?: string;
  remote_token_salt?: string;
  remote_granted_at?: string | null;
}

interface RememberedHostRow {
  host_id: string;
  display_name: string;
  last_address: string;
  port: number;
  pinned_fingerprint: string;
  short_fingerprint: string;
  device_id: string;
  api_version: string;
  credential_ref: string;
  preferred_transport?: string;
  remote_descriptor_json?: string | null;
  remote_credential_ref?: string | null;
  last_remote_connected_at?: string | null;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SharedSourceJoinRow {
  id: string;
  root_id: string;
  source_enabled: number;
  added_at: string;
  original_path: string;
  normalized_path: string;
  status: 'available' | 'missing';
  root_enabled: number | null;
}

export interface StoredDeviceAuthRow {
  deviceId: string;
  displayName: string;
  platform: string;
  authState: DeviceAuthState;
  tokenHash: string;
  tokenSalt: string;
  enrolledAt: string;
  lastActivityAt: string | null;
  lastIp: string | null;
  revokedAt: string | null;
  remoteAccessEnabled: boolean;
  remoteTokenHash: string;
  remoteTokenSalt: string;
  remoteGrantedAt: string | null;
}

export interface StoredRememberedHost extends RememberedHostRecord {
  credentialRef: string;
  remoteCredentialRef: string | null;
}

function defaultHostDisplayName(): string {
  try {
    const name = os.hostname().trim();
    if (name) {
      return `DoReMi (${name})`.slice(0, 48);
    }
  } catch {
    // Ignore hostname read error
  }
  return 'DoReMi Personal Host';
}

function buildAlbumKey(title: string, artist: string): string {
  const raw = `${title.normalize('NFC').toLowerCase()}::${artist.normalize('NFC').toLowerCase()}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

const HOST_POWER_POLICY_PREF_KEY = 'connect.host.power_policy';

function normalizePowerPolicy(raw: unknown): HostPowerPolicy {
  if (raw === 'keep-awake-streaming' || raw === 'keep-awake-host-on') {
    return raw;
  }
  return 'follow-system';
}

export class ConnectRepository {
  constructor(private readonly db: Database.Database) {}

  getHostPowerPolicy(): HostPowerPolicy {
    try {
      const row = this.db
        .prepare('SELECT value_json FROM app_preferences WHERE key = ?')
        .get(HOST_POWER_POLICY_PREF_KEY) as { value_json?: string } | undefined;
      if (!row?.value_json) {
        return 'follow-system';
      }
      const parsed = JSON.parse(row.value_json) as unknown;
      return normalizePowerPolicy(parsed);
    } catch {
      return 'follow-system';
    }
  }

  setHostPowerPolicy(policy: HostPowerPolicy): HostPowerPolicy {
    const clean = normalizePowerPolicy(policy);
    const current = this.getHostPowerPolicy();
    if (current === clean) {
      return clean;
    }
    this.db
      .prepare(
        `INSERT INTO app_preferences (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(HOST_POWER_POLICY_PREF_KEY, JSON.stringify(clean), new Date().toISOString());
    return clean;
  }

  getLibraryStateToken(): string {
    try {
      const row = this.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM tracks) AS tc,
             (SELECT COALESCE(MAX(updated_at), '') FROM tracks) AS tu,
             (SELECT COALESCE(MAX(updated_at), '') FROM track_artwork) AS au,
             (SELECT COALESCE(MAX(updated_at), '') FROM track_lyrics) AS lu,
             (SELECT COUNT(*) FROM connect_shared_sources WHERE enabled = 1) AS sc`,
        )
        .get() as
        | { tc: number; tu: string; au: string; lu: string; sc: number }
        | undefined;
      if (!row) return '0::::0';
      return `${row.tc}:${row.tu}:${row.au}:${row.lu}:${row.sc}`;
    } catch {
      return '0::::0';
    }
  }

  getHostConfig(): HostConfig {
    const powerPolicy = this.getHostPowerPolicy();
    const row = this.db
      .prepare('SELECT * FROM connect_host_config WHERE id = 1')
      .get() as HostConfigRow | undefined;

    if (!row) {
      const now = new Date().toISOString();
      const displayName = defaultHostDisplayName();
      this.db
        .prepare(
          `INSERT OR IGNORE INTO connect_host_config
           (id, enabled, auto_start, display_name, port, bind_address, max_active_clients, max_requests_per_device, max_global_requests, updated_at)
           VALUES (1, 0, 0, ?, ?, 'auto-private', ?, ?, ?, ?)`,
        )
        .run(
          displayName,
          CONNECT_DEFAULT_PORT,
          CONNECT_DEFAULT_MAX_CLIENTS,
          CONNECT_DEFAULT_MAX_REQUESTS_PER_DEVICE,
          CONNECT_DEFAULT_MAX_GLOBAL_REQUESTS,
          now,
        );
      return {
        enabled: false,
        autoStart: false,
        displayName,
        port: CONNECT_DEFAULT_PORT,
        bindAddress: 'auto-private',
        resourceLimits: {
          maxActiveClients: CONNECT_DEFAULT_MAX_CLIENTS,
          maxRequestsPerDevice: CONNECT_DEFAULT_MAX_REQUESTS_PER_DEVICE,
          maxGlobalRequests: CONNECT_DEFAULT_MAX_GLOBAL_REQUESTS,
        },
        powerPolicy,
        remoteProvider: 'tailscale-funnel',
        remotePublicPort: 443,
        remoteMountPath: CONNECT_REMOTE_DEFAULT_MOUNT_PATH,
        remoteEndpointGeneration: 1,
        remoteUserAcknowledged: false,
        updatedAt: now,
      };
    }

    const remotePort = isAllowedFunnelPublicPort(row.remote_public_port)
      ? row.remote_public_port
      : 443;
    const remoteMount =
      normalizeRemoteMountPath(row.remote_mount_path) ?? CONNECT_REMOTE_DEFAULT_MOUNT_PATH;

    return {
      enabled: row.enabled === 1,
      autoStart: row.auto_start === 1,
      displayName: row.display_name || defaultHostDisplayName(),
      port: row.port,
      bindAddress: row.bind_address || 'auto-private',
      resourceLimits: {
        maxActiveClients: Math.max(1, Math.min(10, row.max_active_clients)),
        maxRequestsPerDevice: Math.max(
          CONNECT_DEFAULT_MAX_REQUESTS_PER_DEVICE,
          Math.min(32, row.max_requests_per_device),
        ),
        maxGlobalRequests: Math.max(
          CONNECT_DEFAULT_MAX_GLOBAL_REQUESTS,
          Math.min(96, row.max_global_requests),
        ),
      },
      powerPolicy,
      remoteProvider: 'tailscale-funnel',
      remotePublicPort: remotePort,
      remoteMountPath: remoteMount,
      remoteEndpointGeneration: Math.max(1, row.remote_endpoint_generation ?? 1),
      remoteUserAcknowledged: row.remote_user_acknowledged === 1,
      updatedAt: row.updated_at,
    };
  }

  updateHostConfig(patch: {
    enabled?: boolean;
    autoStart?: boolean;
    displayName?: string;
    port?: number;
    bindAddress?: string;
    maxActiveClients?: number;
    powerPolicy?: HostPowerPolicy;
    remotePublicPort?: 443 | 8443 | 10000;
    remoteUserAcknowledged?: boolean;
  }): HostConfig {
    const current = this.getHostConfig();
    if (patch.powerPolicy !== undefined) {
      this.setHostPowerPolicy(patch.powerPolicy);
    }

    const nextEnabled = patch.enabled !== undefined ? patch.enabled : current.enabled;
    const nextAutoStart = patch.autoStart !== undefined ? patch.autoStart : current.autoStart;
    const nextName =
      typeof patch.displayName === 'string' && patch.displayName.trim().length > 0
        ? patch.displayName.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 48)
        : current.displayName;
    const nextPort =
      typeof patch.port === 'number' &&
      Number.isInteger(patch.port) &&
      (patch.port === 0 || (patch.port >= 1024 && patch.port <= 65535))
        ? patch.port
        : current.port;
    const nextBind =
      typeof patch.bindAddress === 'string' && patch.bindAddress.trim().length > 0
        ? patch.bindAddress.trim().slice(0, 64)
        : current.bindAddress;
    const nextMaxClients =
      typeof patch.maxActiveClients === 'number' && Number.isInteger(patch.maxActiveClients)
        ? Math.max(1, Math.min(10, patch.maxActiveClients))
        : current.resourceLimits.maxActiveClients;
    const nextRemotePort = isAllowedFunnelPublicPort(patch.remotePublicPort)
      ? patch.remotePublicPort
      : (current.remotePublicPort ?? 443);
    const nextRemoteAck =
      patch.remoteUserAcknowledged !== undefined
        ? patch.remoteUserAcknowledged
        : Boolean(current.remoteUserAcknowledged);

    const rowChanged =
      nextEnabled !== current.enabled ||
      nextAutoStart !== current.autoStart ||
      nextName !== current.displayName ||
      nextPort !== current.port ||
      nextBind !== current.bindAddress ||
      nextMaxClients !== current.resourceLimits.maxActiveClients ||
      nextRemotePort !== (current.remotePublicPort ?? 443) ||
      nextRemoteAck !== Boolean(current.remoteUserAcknowledged);

    if (rowChanged) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE connect_host_config
           SET enabled = ?, auto_start = ?, display_name = ?, port = ?, bind_address = ?, max_active_clients = ?,
               remote_public_port = ?, remote_user_acknowledged = ?, updated_at = ?
           WHERE id = 1`,
        )
        .run(
          nextEnabled ? 1 : 0,
          nextAutoStart ? 1 : 0,
          nextName,
          nextPort,
          nextBind,
          nextMaxClients,
          nextRemotePort,
          nextRemoteAck ? 1 : 0,
          now,
        );
    }

    return this.getHostConfig();
  }

  getOwnedRemoteRoute(): RemoteOwnedRouteRecord | null {
    this.getHostConfig();
    const row = this.db
      .prepare('SELECT remote_owned_route_json FROM connect_host_config WHERE id = 1')
      .get() as { remote_owned_route_json?: string | null } | undefined;
    if (!row?.remote_owned_route_json) {
      return null;
    }
    try {
      const parsed = JSON.parse(row.remote_owned_route_json) as Partial<RemoteOwnedRouteRecord>;
      if (
        parsed &&
        parsed.providerId === 'tailscale-funnel' &&
        typeof parsed.publicOrigin === 'string' &&
        isAllowedFunnelPublicPort(parsed.publicPort) &&
        typeof parsed.mountPath === 'string' &&
        typeof parsed.localTarget === 'string' &&
        typeof parsed.createdAt === 'string'
      ) {
        return parsed as RemoteOwnedRouteRecord;
      }
    } catch {
      // Ignore corrupt route JSON
    }
    return null;
  }

  setOwnedRemoteRoute(route: RemoteOwnedRouteRecord | null): void {
    this.getHostConfig();
    this.db
      .prepare('UPDATE connect_host_config SET remote_owned_route_json = ?, updated_at = ? WHERE id = 1')
      .run(route ? JSON.stringify(route) : null, new Date().toISOString());
  }

  bumpRemoteEndpointGeneration(): number {
    const current = this.getHostConfig();
    const nextGen = (current.remoteEndpointGeneration ?? 1) + 1;
    this.db
      .prepare('UPDATE connect_host_config SET remote_endpoint_generation = ?, updated_at = ? WHERE id = 1')
      .run(nextGen, new Date().toISOString());
    return nextGen;
  }

  // ---------------------------------------------------------------------------
  // Explicit Shared Sources
  // ---------------------------------------------------------------------------

  listSharedSourceRoots(): Array<SharedSourceRecord & { normalizedPath: string }> {
    const rows = this.db
      .prepare(
        `SELECT
           s.id,
           s.root_id,
           s.enabled AS source_enabled,
           s.added_at,
           r.original_path,
           r.normalized_path,
           r.status,
           r.enabled AS root_enabled
         FROM connect_shared_sources s
         INNER JOIN library_roots r ON r.id = s.root_id
         ORDER BY s.added_at ASC`,
      )
      .all() as SharedSourceJoinRow[];

    const allTracks = this.db
      .prepare("SELECT normalized_path, status FROM tracks")
      .all() as Array<{ normalized_path: string; status: string }>;

    return rows.map((row) => {
      const enabled = row.source_enabled === 1 && row.root_enabled !== 0;
      const available = row.status === 'available';
      const count = allTracks.reduce(
        (acc, t) =>
          acc + (isNormalizedPathWithinRoot(t.normalized_path, row.normalized_path) ? 1 : 0),
        0,
      );
      const parts = row.original_path.replace(/[\\/]+$/, '').split(/[\\/]/);
      const folderName = parts[parts.length - 1] || row.original_path;

      return {
        id: row.id,
        rootId: row.root_id,
        folderName,
        originalPath: row.original_path,
        normalizedPath: row.normalized_path,
        enabled,
        available,
        trackCount: count,
        addedAt: row.added_at,
      };
    });
  }

  addSharedSource(rootId: string): LibraryRootRecord {
    const root = this.db
      .prepare('SELECT * FROM library_roots WHERE id = ?')
      .get(rootId) as LibraryRootRecord | undefined;
    if (!root) {
      throw new Error('Thư mục nguồn không tồn tại trong thư viện DoReMi.');
    }

    const existing = this.db
      .prepare('SELECT id FROM connect_shared_sources WHERE root_id = ?')
      .get(rootId) as { id: string } | undefined;
    if (existing) {
      this.db
        .prepare('UPDATE connect_shared_sources SET enabled = 1 WHERE id = ?')
        .run(existing.id);
      return root;
    }

    this.db
      .prepare(
        'INSERT INTO connect_shared_sources (id, root_id, enabled, added_at) VALUES (?, ?, 1, ?)',
      )
      .run(crypto.randomUUID(), rootId, new Date().toISOString());

    return root;
  }

  removeSharedSource(rootId: string): boolean {
    const res = this.db
      .prepare('DELETE FROM connect_shared_sources WHERE root_id = ?')
      .run(rootId);
    return res.changes > 0;
  }

  getActiveSharedNormalizedRoots(): Array<{
    rootId: string;
    originalPath: string;
    normalizedPath: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT r.id AS rootId, r.original_path AS originalPath, r.normalized_path AS normalizedPath
         FROM connect_shared_sources s
         INNER JOIN library_roots r ON r.id = s.root_id
         WHERE s.enabled = 1 AND COALESCE(r.enabled, 1) = 1 AND r.status = 'available'`,
      )
      .all() as Array<{ rootId: string; originalPath: string; normalizedPath: string }>;
    return rows;
  }

  /**
   * Returns all shared TrackRecords filtered strictly to active shared library roots,
   * using existing SQLite metadata & overrides without exposing paths to clients.
   */
  getSharedTracksRaw(allTrackRepoFindAll: () => TrackRecord[]): Array<{
    track: TrackRecord;
    matchedRoot: { rootId: string; originalPath: string; normalizedPath: string };
  }> {
    const activeRoots = this.getActiveSharedNormalizedRoots();
    if (activeRoots.length === 0) {
      return [];
    }
    const allTracks = allTrackRepoFindAll();
    const matched: Array<{
      track: TrackRecord;
      matchedRoot: { rootId: string; originalPath: string; normalizedPath: string };
    }> = [];

    for (const track of allTracks) {
      if (track.status === 'missing') {
        continue;
      }
      const root = activeRoots.find((r) =>
        isNormalizedPathWithinRoot(track.normalized_path, r.normalizedPath),
      );
      if (root) {
        matched.push({ track, matchedRoot: root });
      }
    }
    return matched;
  }

  findSharedTrackForStream(
    track: TrackRecord,
  ): { rootId: string; originalPath: string; normalizedPath: string } | null {
    const activeRoots = this.getActiveSharedNormalizedRoots();
    let best: { rootId: string; originalPath: string; normalizedPath: string } | null = null;
    for (const root of activeRoots) {
      if (isNormalizedPathWithinRoot(track.normalized_path, root.normalizedPath)) {
        if (!best || root.normalizedPath.length > best.normalizedPath.length) {
          best = root;
        }
      }
    }
    return best;
  }

  buildRemoteLibraryView(
    hostId: string,
    hostDisplayName: string,
    allTracks: TrackRecord[],
    artworkMap: Map<string, { custom_hash: string | null; embedded_hash: string | null; folder_hash: string | null }>,
    lyricsIds: Set<string>,
  ): {
    summary: RemoteLibrarySummaryDto;
    tracks: RemoteTrackDto[];
    albums: RemoteAlbumDto[];
    artists: RemoteArtistDto[];
  } {
    const activeRoots = this.getActiveSharedNormalizedRoots();
    const tracks: RemoteTrackDto[] = [];
    const albumMap = new Map<string, RemoteAlbumDto>();
    const artistMap = new Map<string, { name: string; trackCount: number; albums: Set<string> }>();

    if (activeRoots.length > 0) {
      for (const t of allTracks) {
        if (t.status === 'missing') {
          continue;
        }
        const inside = activeRoots.some((r) =>
          isNormalizedPathWithinRoot(t.normalized_path, r.normalizedPath),
        );
        if (!inside) {
          continue;
        }

        const artRow = artworkMap.get(t.id);
        const artHash =
          artRow?.custom_hash ?? artRow?.embedded_hash ?? artRow?.folder_hash ?? null;
        const hasArtwork = Boolean(artHash);
        const hasLyrics = lyricsIds.has(t.id);

        const dto: RemoteTrackDto = {
          trackId: t.id,
          title: t.title,
          artist: t.artist || 'Unknown Artist',
          album: t.album,
          albumArtist: t.album_artist ?? null,
          genre: t.genre ?? null,
          year: t.year ?? null,
          trackNumber: t.track_number ?? null,
          trackTotal: t.track_total ?? null,
          discNumber: t.disc_number ?? null,
          discTotal: t.disc_total ?? null,
          durationMs: t.duration_ms,
          codec: t.codec,
          container: t.container,
          sampleRateHz: t.sample_rate_hz,
          bitDepth: t.bit_depth,
          bitrateBps: t.bitrate_bps,
          channels: t.channels ?? null,
          fileSizeBytes: t.file_size_bytes,
          sourceRevision: `${t.file_size_bytes ?? 0}:${Math.trunc(t.modified_at_ms ?? 0)}`,
          availabilityState: t.availability_state ?? (t.status === 'error' ? 'access_error' : 'available'),
          hasArtwork,
          artworkHash: artHash,
          hasLyrics,
        };
        tracks.push(dto);

        const albumTitle = dto.album || 'Không rõ Album';
        const albumArtist = dto.albumArtist || dto.artist || 'Unknown Artist';
        const albumKey = buildAlbumKey(albumTitle, albumArtist);
        const existingAlbum = albumMap.get(albumKey);
        if (!existingAlbum) {
          albumMap.set(albumKey, {
            albumKey,
            title: albumTitle,
            artist: albumArtist,
            year: dto.year,
            trackCount: 1,
            totalDurationMs: dto.durationMs ?? 0,
            coverTrackId: hasArtwork ? dto.trackId : null,
            coverHash: artHash,
          });
        } else {
          existingAlbum.trackCount += 1;
          existingAlbum.totalDurationMs += dto.durationMs ?? 0;
          if (!existingAlbum.coverTrackId && hasArtwork) {
            existingAlbum.coverTrackId = dto.trackId;
            existingAlbum.coverHash = artHash;
          }
          if (!existingAlbum.year && dto.year) {
            existingAlbum.year = dto.year;
          }
        }

        const artistName = dto.artist || 'Unknown Artist';
        const artistKey = artistName.normalize('NFC').toLowerCase();
        const existingArtist = artistMap.get(artistKey);
        if (!existingArtist) {
          artistMap.set(artistKey, {
            name: artistName,
            trackCount: 1,
            albums: new Set([albumKey]),
          });
        } else {
          existingArtist.trackCount += 1;
          existingArtist.albums.add(albumKey);
        }
      }
    }

    const albums = Array.from(albumMap.values()).sort((a, b) =>
      a.title.localeCompare(b.title, 'vi'),
    );
    const artists: RemoteArtistDto[] = Array.from(artistMap.values())
      .map((a) => ({
        name: a.name,
        trackCount: a.trackCount,
        albumCount: a.albums.size,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'));

    return {
      summary: {
        hostId,
        hostDisplayName,
        totalSharedTracks: tracks.length,
        totalAlbums: albums.length,
        totalArtists: artists.length,
        sharedSourceCount: activeRoots.length,
        updatedAt: new Date().toISOString(),
      },
      tracks,
      albums,
      artists,
    };
  }

  // ---------------------------------------------------------------------------
  // Authorized Devices
  // ---------------------------------------------------------------------------

  listAuthorizedDevices(): StoredDeviceAuthRow[] {
    const rows = this.db
      .prepare('SELECT * FROM connect_authorized_devices ORDER BY enrolled_at DESC')
      .all() as AuthorizedDeviceRow[];
    return rows.map((row) => this.mapDeviceRow(row));
  }

  findDeviceById(deviceId: string): StoredDeviceAuthRow | null {
    const row = this.db
      .prepare('SELECT * FROM connect_authorized_devices WHERE device_id = ?')
      .get(deviceId) as AuthorizedDeviceRow | undefined;
    if (!row) {
      return null;
    }
    return this.mapDeviceRow(row);
  }

  private mapDeviceRow(row: AuthorizedDeviceRow): StoredDeviceAuthRow {
    return {
      deviceId: row.device_id,
      displayName: row.display_name,
      platform: row.platform,
      authState: row.auth_state,
      tokenHash: row.token_hash,
      tokenSalt: row.token_salt,
      enrolledAt: row.enrolled_at,
      lastActivityAt: row.last_activity_at,
      lastIp: row.last_ip,
      revokedAt: row.revoked_at,
      remoteAccessEnabled: row.remote_access_enabled === 1,
      remoteTokenHash: row.remote_token_hash ?? '',
      remoteTokenSalt: row.remote_token_salt ?? '',
      remoteGrantedAt: row.remote_granted_at ?? null,
    };
  }

  insertAuthorizedDevice(device: {
    deviceId: string;
    displayName: string;
    platform: string;
    tokenHash: string;
    tokenSalt: string;
    lastIp: string | null;
  }): StoredDeviceAuthRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO connect_authorized_devices
         (device_id, display_name, platform, auth_state, token_hash, token_salt, enrolled_at, last_activity_at, last_ip, revoked_at)
         VALUES (?, ?, ?, 'authorized', ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        device.deviceId,
        device.displayName,
        device.platform,
        device.tokenHash,
        device.tokenSalt,
        now,
        now,
        device.lastIp,
      );
    return this.findDeviceById(device.deviceId)!;
  }

  renameDevice(deviceId: string, displayName: string): boolean {
    const cleaned = displayName.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 48);
    if (!cleaned) {
      return false;
    }
    const res = this.db
      .prepare('UPDATE connect_authorized_devices SET display_name = ? WHERE device_id = ?')
      .run(cleaned, deviceId);
    return res.changes > 0;
  }

  touchDeviceActivity(deviceId: string, ip: string | null): void {
    this.db
      .prepare(
        'UPDATE connect_authorized_devices SET last_activity_at = ?, last_ip = COALESCE(?, last_ip) WHERE device_id = ?',
      )
      .run(new Date().toISOString(), ip, deviceId);
  }

  updateDeviceTokenHash(deviceId: string, tokenHash: string, tokenSalt: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE connect_authorized_devices
         SET token_hash = ?, token_salt = ?, last_activity_at = ?
         WHERE device_id = ? AND auth_state = 'authorized'`,
      )
      .run(tokenHash, tokenSalt, new Date().toISOString(), deviceId);
    return res.changes > 0;
  }

  setDeviceRemoteAccess(deviceId: string, enabled: boolean): boolean {
    const now = new Date().toISOString();
    if (enabled) {
      const res = this.db
        .prepare(
          `UPDATE connect_authorized_devices
           SET remote_access_enabled = 1, remote_granted_at = COALESCE(remote_granted_at, ?)
           WHERE device_id = ? AND auth_state = 'authorized'`,
        )
        .run(now, deviceId);
      return res.changes > 0;
    }
    const res = this.db
      .prepare(
        `UPDATE connect_authorized_devices
         SET remote_access_enabled = 0, remote_token_hash = '', remote_token_salt = '', remote_granted_at = NULL
         WHERE device_id = ?`,
      )
      .run(deviceId);
    return res.changes > 0;
  }

  updateDeviceRemoteTokenHash(deviceId: string, remoteTokenHash: string, remoteTokenSalt: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE connect_authorized_devices
         SET remote_token_hash = ?, remote_token_salt = ?, last_activity_at = ?
         WHERE device_id = ? AND auth_state = 'authorized' AND remote_access_enabled = 1`,
      )
      .run(remoteTokenHash, remoteTokenSalt, new Date().toISOString(), deviceId);
    return res.changes > 0;
  }

  revokeDevice(deviceId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE connect_authorized_devices
         SET auth_state = 'revoked', token_hash = '', token_salt = '',
             remote_access_enabled = 0, remote_token_hash = '', remote_token_salt = '', remote_granted_at = NULL,
             revoked_at = ?
         WHERE device_id = ?`,
      )
      .run(new Date().toISOString(), deviceId);
    return res.changes > 0;
  }

  removeDevice(deviceId: string): boolean {
    const res = this.db
      .prepare('DELETE FROM connect_authorized_devices WHERE device_id = ?')
      .run(deviceId);
    return res.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Remembered Hosts (Connect Client)
  // ---------------------------------------------------------------------------

  private mapRememberedHostRow(row: RememberedHostRow): StoredRememberedHost {
    let remoteEndpoint: RemoteEndpointDescriptorV1 | null = null;
    if (row.remote_descriptor_json) {
      try {
        const parsed = JSON.parse(row.remote_descriptor_json);
        const check = validateRemoteEndpointDescriptorShape(parsed, { allowExpired: true });
        if (check.ok) {
          remoteEndpoint = check.descriptor;
        }
      } catch {
        remoteEndpoint = null;
      }
    }
    let connectionMode: ConnectionSelectionMode = 'lan-only';
    let pref: ConnectTransportMode = 'lan-direct';
    if (row.preferred_transport === 'automatic') {
      connectionMode = 'automatic';
      pref = 'lan-direct';
    } else if (
      row.preferred_transport === 'remote-only' ||
      row.preferred_transport === 'remote-https'
    ) {
      connectionMode = 'remote-only';
      pref = 'remote-https';
    }
    return {
      hostId: row.host_id,
      displayName: row.display_name,
      lastAddress: row.last_address,
      port: row.port,
      pinnedFingerprint: row.pinned_fingerprint,
      shortFingerprint: row.short_fingerprint,
      deviceId: row.device_id,
      apiVersion: row.api_version,
      credentialRef: row.credential_ref,
      connectionMode,
      preferredTransport: pref,
      remoteEndpoint,
      remoteCredentialRef: row.remote_credential_ref ?? null,
      hasRemoteCredential: Boolean(row.remote_credential_ref),
      lastRemoteConnectedAt: row.last_remote_connected_at ?? null,
      lastConnectedAt: row.last_connected_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listRememberedHosts(): StoredRememberedHost[] {
    const rows = this.db
      .prepare('SELECT * FROM connect_remembered_hosts ORDER BY COALESCE(last_connected_at, updated_at) DESC')
      .all() as RememberedHostRow[];
    return rows.map((row) => this.mapRememberedHostRow(row));
  }

  findRememberedHost(hostId: string): StoredRememberedHost | null {
    const row = this.db
      .prepare('SELECT * FROM connect_remembered_hosts WHERE host_id = ?')
      .get(hostId) as RememberedHostRow | undefined;
    if (!row) {
      return null;
    }
    return this.mapRememberedHostRow(row);
  }

  upsertRememberedHost(host: {
    hostId: string;
    displayName: string;
    lastAddress: string;
    port: number;
    pinnedFingerprint: string;
    shortFingerprint: string;
    deviceId: string;
    apiVersion: string;
    credentialRef: string;
    connectionMode?: ConnectionSelectionMode;
    lastConnectedAt?: string | null;
  }): StoredRememberedHost {
    const now = new Date().toISOString();
    const initialMode: ConnectionSelectionMode = host.connectionMode ?? 'automatic';
    this.db
      .prepare(
        `INSERT INTO connect_remembered_hosts
         (host_id, display_name, last_address, port, pinned_fingerprint, short_fingerprint, device_id, api_version, credential_ref, preferred_transport, last_connected_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(host_id) DO UPDATE SET
           display_name = excluded.display_name,
           last_address = excluded.last_address,
           port = excluded.port,
           pinned_fingerprint = excluded.pinned_fingerprint,
           short_fingerprint = excluded.short_fingerprint,
           device_id = excluded.device_id,
           api_version = excluded.api_version,
           credentialRef_noop: NULL,
           credential_ref = excluded.credential_ref,
           last_connected_at = COALESCE(excluded.last_connected_at, connect_remembered_hosts.last_connected_at),
           updated_at = excluded.updated_at`
          .replace('credentialRef_noop: NULL,\n           ', ''),
      )
      .run(
        host.hostId,
        host.displayName,
        host.lastAddress,
        host.port,
        host.pinnedFingerprint,
        host.shortFingerprint,
        host.deviceId,
        host.apiVersion,
        host.credentialRef,
        initialMode,
        host.lastConnectedAt ?? now,
        now,
        now,
      );
    return this.findRememberedHost(host.hostId)!;
  }

  touchRememberedHostEndpoint(hostId: string, address: string, port: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE connect_remembered_hosts
         SET last_address = ?, port = ?, last_connected_at = ?, updated_at = ?
         WHERE host_id = ?`,
      )
      .run(address, port, now, now, hostId);
  }

  touchRememberedHostRemoteConnected(hostId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE connect_remembered_hosts
         SET last_remote_connected_at = ?, last_connected_at = ?, updated_at = ?
         WHERE host_id = ?`,
      )
      .run(now, now, now, hostId);
  }

  setRememberedHostConnectionMode(hostId: string, mode: ConnectionSelectionMode): boolean {
    const validMode: ConnectionSelectionMode =
      mode === 'automatic' || mode === 'remote-only' ? mode : 'lan-only';
    const res = this.db
      .prepare(
        `UPDATE connect_remembered_hosts
         SET preferred_transport = ?, updated_at = ?
         WHERE host_id = ?`,
      )
      .run(validMode, new Date().toISOString(), hostId);
    return res.changes > 0;
  }

  setRememberedHostPreferredTransport(hostId: string, mode: ConnectTransportMode): boolean {
    return this.setRememberedHostConnectionMode(
      hostId,
      mode === 'remote-https' ? 'remote-only' : 'lan-only',
    );
  }

  saveRememberedHostRemoteAssociation(params: {
    hostId: string;
    descriptor: RemoteEndpointDescriptorV1 | null;
    remoteCredentialRef: string | null;
  }): boolean {
    const res = this.db
      .prepare(
        `UPDATE connect_remembered_hosts
         SET remote_descriptor_json = ?, remote_credential_ref = ?, updated_at = ?
         WHERE host_id = ?`,
      )
      .run(
        params.descriptor ? JSON.stringify(params.descriptor) : null,
        params.remoteCredentialRef,
        new Date().toISOString(),
        params.hostId,
      );
    return res.changes > 0;
  }

  removeRememberedHost(hostId: string): StoredRememberedHost | null {
    const existing = this.findRememberedHost(hostId);
    if (!existing) {
      return null;
    }
    this.db.prepare('DELETE FROM connect_remembered_hosts WHERE host_id = ?').run(hostId);
    return existing;
  }
}

export function paginateItems<T>(
  items: readonly T[],
  rawOffset: unknown,
  rawLimit: unknown,
): RemoteLibraryPage<T> {
  const offset = clampConnectPageOffset(rawOffset);
  const limit = clampConnectPageLimit(rawLimit);
  const sliced = items.slice(offset, offset + limit);
  return {
    items: sliced,
    total: items.length,
    offset,
    limit,
    hasMore: offset + sliced.length < items.length,
  };
}

export function toPublicAuthorizedDevice(
  row: StoredDeviceAuthRow,
  runtime: { isConnected: boolean; activeSessionCount: number },
): AuthorizedDeviceRecord {
  return {
    deviceId: row.deviceId,
    displayName: row.displayName,
    platform: row.platform,
    authState: row.authState,
    enrolledAt: row.enrolledAt,
    lastActivityAt: row.lastActivityAt,
    lastIp: row.lastIp,
    revokedAt: row.revokedAt,
    remoteAccessEnabled: row.remoteAccessEnabled,
    remoteGrantedAt: row.remoteGrantedAt,
    isConnected: runtime.isConnected,
    activeSessionCount: runtime.activeSessionCount,
  };
}
