import os from 'node:os';

const VIRTUAL_ADAPTER_NAME_RE =
  /vethernet|hyper-v|wsl|vmware|virtualbox|vbox|docker|loopback|teredo|isatap|tailscale|wireguard|tun\d|tap\d|radmin|hamachi/i;

export interface EligibleLanInterface {
  name: string;
  address: string;
  netmask: string;
  isLikelyVirtual: boolean;
}

export function normalizeIpAddress(raw: string | undefined | null): string {
  if (!raw || typeof raw !== 'string') {
    return '';
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice('::ffff:'.length);
  }
  return trimmed;
}

export function isLoopbackIp(raw: string | undefined | null): boolean {
  const ip = normalizeIpAddress(raw);
  if (!ip) return false;
  if (ip === '::1' || ip === 'localhost') return true;
  const parts = ip.split('.');
  return parts.length === 4 && Number(parts[0]) === 127;
}

/**
 * Checks strictly for RFC 1918 private LAN IPv4 addresses:
 * - 10.0.0.0/8
 * - 172.16.0.0/12
 * - 192.168.0.0/16
 */
export function isPrivateLanIpv4(raw: string | undefined | null): boolean {
  const ip = normalizeIpAddress(raw);
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Validates whether a remote or local address is permitted for Phase 6.1 LAN Direct transport
 * (RFC 1918 private LAN IPv4 or loopback, rejecting public Internet IPs and link-local APIPA).
 */
export function isEligibleLanSocketAddress(raw: string | undefined | null): boolean {
  const ip = normalizeIpAddress(raw);
  return isLoopbackIp(ip) || isPrivateLanIpv4(ip);
}

/**
 * Enumerates active non-internal IPv4 private LAN interfaces on this host,
 * deprioritizing known virtual adapters while keeping them visible if explicitly needed.
 */
export function listEligibleLanInterfaces(): EligibleLanInterface[] {
  const ifaces = os.networkInterfaces();
  const physical: EligibleLanInterface[] = [];
  const virtual: EligibleLanInterface[] = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) {
        continue;
      }
      if (!isPrivateLanIpv4(addr.address)) {
        continue;
      }
      const entry: EligibleLanInterface = {
        name,
        address: addr.address,
        netmask: addr.netmask,
        isLikelyVirtual: VIRTUAL_ADAPTER_NAME_RE.test(name),
      };
      if (entry.isLikelyVirtual) {
        virtual.push(entry);
      } else {
        physical.push(entry);
      }
    }
  }

  return [...physical, ...virtual];
}

export function resolveBindHostForConfig(bindAddress: string): {
  listenHost: string;
  advertisedAddresses: string[];
} {
  const trimmed = bindAddress.trim();
  if (trimmed === '127.0.0.1' || trimmed === 'localhost') {
    return {
      listenHost: '127.0.0.1',
      advertisedAddresses: ['127.0.0.1'],
    };
  }

  const eligible = listEligibleLanInterfaces();
  if (trimmed !== 'auto-private' && isPrivateLanIpv4(trimmed)) {
    const matched = eligible.find((item) => item.address === trimmed);
    if (matched) {
      return {
        listenHost: matched.address,
        advertisedAddresses: [matched.address],
      };
    }
  }

  const preferred = eligible.filter((i) => !i.isLikelyVirtual);
  const chosen = preferred.length > 0 ? preferred : eligible;
  const ips = chosen.map((i) => i.address);

  // If no active Wi-Fi/Ethernet LAN IP exists yet, bind safely to loopback only
  if (ips.length === 0) {
    return {
      listenHost: '127.0.0.1',
      advertisedAddresses: ['127.0.0.1'],
    };
  }

  // Bind 0.0.0.0 when multiple private interfaces or dynamic Wi-Fi switching may occur,
  // while socket admission filter rejects any non-private/public IP at TCP accept time.
  return {
    listenHost: '0.0.0.0',
    advertisedAddresses: ips,
  };
}
