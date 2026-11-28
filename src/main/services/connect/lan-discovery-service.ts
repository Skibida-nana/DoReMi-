import dgram from 'node:dgram';
import {
  CONNECT_MDNS_MULTICAST_ADDR,
  CONNECT_MDNS_PORT,
  CONNECT_MDNS_SERVICE_TYPE,
} from '../../../shared/contracts/connect-api';
import type { ConnectTransportMode, DiscoveredHostRecord } from '../../../shared/types/connect';
import { isPrivateLanIpv4, listEligibleLanInterfaces } from './network-interfaces';

const MDNS_HOST_DOMAIN = 'local';
const RECORD_TTL_SECONDS = 90;
const RECORD_EXPIRY_MS = 120_000;
const ANNOUNCE_INTERVAL_MS = 25_000;

export interface MdnsHostAdvertisement {
  hostId: string;
  displayName: string;
  address: string;
  port: number;
  apiVersion: string;
  mode: ConnectTransportMode;
  fingerprintPrefix: string;
}

export interface MdnsSocketLike {
  on(event: 'message', cb: (msg: Buffer, rinfo: { address: string; port: number }) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  bind(port?: number, address?: string, cb?: () => void): void;
  addMembership(multicastAddress: string, multicastInterface?: string): void;
  setMulticastTTL?(ttl: number): void;
  setMulticastLoopback?(flag: boolean): void;
  send(
    msg: Buffer,
    offset: number,
    length: number,
    port: number,
    address: string,
    cb?: (err: Error | null) => void,
  ): void;
  close(cb?: () => void): void;
}

function encodeDnsName(name: string): Buffer {
  const labels = name
    .replace(/\.$/, '')
    .split('.')
    .filter((l) => l.length > 0);
  const parts: Buffer[] = [];
  for (const label of labels) {
    const buf = Buffer.from(label, 'utf8');
    if (buf.length > 63) {
      throw new Error(`DNS label too long: ${label}`);
    }
    parts.push(Buffer.from([buf.length]), buf);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function decodeDnsName(packet: Buffer, startOffset: number): { name: string; nextOffset: number } | null {
  const labels: string[] = [];
  let offset = startOffset;
  let jumped = false;
  let endOffset = startOffset;
  let safety = 0;

  while (offset < packet.length && safety < 64) {
    safety += 1;
    const len = packet[offset];
    if (len === 0) {
      if (!jumped) {
        endOffset = offset + 1;
      }
      return { name: labels.join('.'), nextOffset: endOffset };
    }
    if ((len & 0xc0) === 0xc0) {
      if (offset + 1 >= packet.length) {
        return null;
      }
      const ptr = ((len & 0x3f) << 8) | packet[offset + 1];
      if (!jumped) {
        endOffset = offset + 2;
      }
      offset = ptr;
      jumped = true;
      continue;
    }
    offset += 1;
    if (offset + len > packet.length) {
      return null;
    }
    labels.push(packet.subarray(offset, offset + len).toString('utf8'));
    offset += len;
  }
  return null;
}

function encodeTxtRecord(kv: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  for (const [key, value] of Object.entries(kv)) {
    const raw = Buffer.from(`${key}=${value}`, 'utf8');
    const bounded = raw.subarray(0, 255);
    chunks.push(Buffer.from([bounded.length]), bounded);
  }
  if (chunks.length === 0) {
    return Buffer.from([0]);
  }
  return Buffer.concat(chunks);
}

function decodeTxtRecord(buf: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < buf.length) {
    const len = buf[offset];
    offset += 1;
    if (offset + len > buf.length) {
      break;
    }
    const entry = buf.subarray(offset, offset + len).toString('utf8');
    offset += len;
    const eqIdx = entry.indexOf('=');
    if (eqIdx > 0) {
      result[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
    }
  }
  return result;
}

function buildResourceRecord(
  name: string,
  type: number,
  klass: number,
  ttl: number,
  rdata: Buffer,
): Buffer {
  const nameBuf = encodeDnsName(name);
  const hdr = Buffer.alloc(10);
  hdr.writeUInt16BE(type, 0);
  hdr.writeUInt16BE(klass, 2);
  hdr.writeUInt32BE(ttl, 4);
  hdr.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([nameBuf, hdr, rdata]);
}

/**
 * Encodes an mDNS DNS-SD announcement packet containing ONLY non-sensitive Host discovery fields.
 * Never includes library paths, track names, filenames, tokens, or secrets.
 */
export function encodeMdnsAnnouncementPacket(
  adv: MdnsHostAdvertisement,
  ttlSeconds = RECORD_TTL_SECONDS,
): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // ID = 0 for mDNS
  header.writeUInt16BE(0x8400, 2); // Standard query response, authoritative
  header.writeUInt16BE(0, 4); // QDCOUNT
  header.writeUInt16BE(3, 6); // ANCOUNT (PTR, SRV, TXT)
  header.writeUInt16BE(0, 8); // NSCOUNT
  header.writeUInt16BE(1, 10); // ARCOUNT (A)

  const instanceFqdn = `doremi-${adv.hostId.slice(0, 12)}.${CONNECT_MDNS_SERVICE_TYPE}`;
  const targetHost = `doremi-${adv.hostId.slice(0, 12)}.${MDNS_HOST_DOMAIN}`;

  const ptrRdata = encodeDnsName(instanceFqdn);
  const ptrRr = buildResourceRecord(CONNECT_MDNS_SERVICE_TYPE, 12, 0x0001, ttlSeconds, ptrRdata);

  const srvHead = Buffer.alloc(6);
  srvHead.writeUInt16BE(0, 0); // priority
  srvHead.writeUInt16BE(0, 2); // weight
  srvHead.writeUInt16BE(adv.port, 4);
  const srvRr = buildResourceRecord(
    instanceFqdn,
    33,
    0x8001,
    ttlSeconds,
    Buffer.concat([srvHead, encodeDnsName(targetHost)]),
  );

  const txtRdata = encodeTxtRecord({
    v: adv.apiVersion,
    id: adv.hostId,
    name: adv.displayName.slice(0, 48),
    port: String(adv.port),
    mode: adv.mode,
    fp: adv.fingerprintPrefix.slice(0, 19),
    addr: adv.address,
  });
  const txtRr = buildResourceRecord(instanceFqdn, 16, 0x8001, ttlSeconds, txtRdata);

  const ipParts = adv.address.split('.').map((p) => Number(p));
  const aRdata =
    ipParts.length === 4 && ipParts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
      ? Buffer.from(ipParts)
      : Buffer.from([127, 0, 0, 1]);
  const aRr = buildResourceRecord(targetHost, 1, 0x8001, ttlSeconds, aRdata);

  return Buffer.concat([header, ptrRr, srvRr, txtRr, aRr]);
}

export function encodeMdnsQueryPacket(): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0x0000, 2); // Standard query
  header.writeUInt16BE(1, 4); // QDCOUNT = 1
  const qname = encodeDnsName(CONNECT_MDNS_SERVICE_TYPE);
  const qtail = Buffer.alloc(4);
  qtail.writeUInt16BE(12, 0); // PTR
  qtail.writeUInt16BE(1, 2); // IN
  return Buffer.concat([header, qname, qtail]);
}

export interface DecodedMdnsPacket {
  isQueryForDoremi: boolean;
  advertisement: (MdnsHostAdvertisement & { ttl: number }) | null;
}

export function decodeMdnsPacket(packet: Buffer, fallbackSenderIp: string): DecodedMdnsPacket {
  if (!Buffer.isBuffer(packet) || packet.length < 12) {
    return { isQueryForDoremi: false, advertisement: null };
  }

  const flags = packet.readUInt16BE(2);
  const qdCount = packet.readUInt16BE(4);
  const anCount = packet.readUInt16BE(6);
  const nsCount = packet.readUInt16BE(8);
  const arCount = packet.readUInt16BE(10);

  let offset = 12;
  let isQueryForDoremi = false;

  for (let i = 0; i < qdCount && offset < packet.length; i += 1) {
    const qname = decodeDnsName(packet, offset);
    if (!qname || qname.nextOffset + 4 > packet.length) {
      return { isQueryForDoremi: false, advertisement: null };
    }
    offset = qname.nextOffset + 4;
    if (qname.name.toLowerCase() === CONNECT_MDNS_SERVICE_TYPE && (flags & 0x8000) === 0) {
      isQueryForDoremi = true;
    }
  }

  let hasDoremiPtr = false;
  let txtData: Record<string, string> | null = null;
  let srvPort: number | null = null;
  let aAddress: string | null = null;
  let minTtl = RECORD_TTL_SECONDS;

  const totalRrs = Math.min(32, anCount + nsCount + arCount);
  for (let i = 0; i < totalRrs && offset < packet.length; i += 1) {
    const rrName = decodeDnsName(packet, offset);
    if (!rrName || rrName.nextOffset + 10 > packet.length) {
      break;
    }
    const type = packet.readUInt16BE(rrName.nextOffset);
    const ttl = packet.readUInt32BE(rrName.nextOffset + 4);
    const rdLength = packet.readUInt16BE(rrName.nextOffset + 8);
    const rdataStart = rrName.nextOffset + 10;
    const rdataEnd = rdataStart + rdLength;
    if (rdataEnd > packet.length) {
      break;
    }
    const rdata = packet.subarray(rdataStart, rdataEnd);
    offset = rdataEnd;

    if (type === 12 && rrName.name.toLowerCase() === CONNECT_MDNS_SERVICE_TYPE) {
      hasDoremiPtr = true;
      minTtl = Math.min(minTtl, ttl);
    } else if (type === 16 && rrName.name.toLowerCase().includes(CONNECT_MDNS_SERVICE_TYPE)) {
      txtData = decodeTxtRecord(rdata);
      minTtl = Math.min(minTtl, ttl);
    } else if (type === 33 && rrName.name.toLowerCase().includes(CONNECT_MDNS_SERVICE_TYPE) && rdata.length >= 6) {
      srvPort = rdata.readUInt16BE(4);
      minTtl = Math.min(minTtl, ttl);
    } else if (type === 1 && rdata.length === 4) {
      aAddress = `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`;
    }
  }

  if (!hasDoremiPtr || !txtData || !txtData.id || !txtData.name) {
    return { isQueryForDoremi, advertisement: null };
  }

  const parsedPort = srvPort ?? Number(txtData.port);
  if (!Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
    return { isQueryForDoremi, advertisement: null };
  }

  const chosenAddress =
    txtData.addr && isPrivateLanIpv4(txtData.addr)
      ? txtData.addr
      : aAddress && isPrivateLanIpv4(aAddress)
        ? aAddress
        : fallbackSenderIp;

  return {
    isQueryForDoremi,
    advertisement: {
      hostId: txtData.id,
      displayName: txtData.name,
      address: chosenAddress,
      port: parsedPort,
      apiVersion: txtData.v || '1',
      mode: txtData.mode === 'lan-direct' ? 'lan-direct' : 'lan-direct',
      fingerprintPrefix: txtData.fp || '',
      ttl: minTtl,
    },
  };
}

export class LanDiscoveryService {
  private readonly socketFactory: () => MdnsSocketLike;
  private hostSocket: MdnsSocketLike | null = null;
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  private currentAdvertisement: MdnsHostAdvertisement | null = null;
  private discoveryState: 'stopped' | 'advertising' | 'unavailable' = 'stopped';
  private lastError: string | null = null;

  private discoveredHosts = new Map<string, DiscoveredHostRecord>();

  constructor(options?: { socketFactory?: () => MdnsSocketLike }) {
    this.socketFactory =
      options?.socketFactory ?? (() => dgram.createSocket({ type: 'udp4', reuseAddr: true }));
  }

  getState(): { state: 'stopped' | 'advertising' | 'unavailable'; lastError: string | null } {
    return {
      state: this.discoveryState,
      lastError: this.lastError,
    };
  }

  async startAdvertising(adv: MdnsHostAdvertisement): Promise<void> {
    this.currentAdvertisement = adv;
    if (this.hostSocket) {
      this.sendAnnouncementNow(0);
      return;
    }

    const socket = this.socketFactory();
    this.hostSocket = socket;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      socket.on('error', (err) => {
        this.discoveryState = 'unavailable';
        this.lastError = err.message;
        done();
      });

      socket.on('message', (msg, rinfo) => {
        const decoded = decodeMdnsPacket(msg, rinfo.address);
        if (decoded.isQueryForDoremi && this.currentAdvertisement) {
          this.sendAnnouncementNow(RECORD_TTL_SECONDS);
        }
      });

      try {
        socket.bind(CONNECT_MDNS_PORT, undefined, () => {
          try {
            const ifaces = listEligibleLanInterfaces();
            if (ifaces.length > 0) {
              for (const iface of ifaces) {
                try {
                  socket.addMembership(CONNECT_MDNS_MULTICAST_ADDR, iface.address);
                } catch {
                  // Ignore per-interface join failures
                }
              }
            } else {
              socket.addMembership(CONNECT_MDNS_MULTICAST_ADDR);
            }
            socket.setMulticastTTL?.(255);
            socket.setMulticastLoopback?.(true);
            this.discoveryState = 'advertising';
            this.lastError = null;
            this.sendAnnouncementNow(RECORD_TTL_SECONDS);
          } catch (err) {
            this.discoveryState = 'unavailable';
            this.lastError = err instanceof Error ? err.message : String(err);
          }
          done();
        });
      } catch (err) {
        this.discoveryState = 'unavailable';
        this.lastError = err instanceof Error ? err.message : String(err);
        done();
      }
    });

    if (!this.announceTimer) {
      this.announceTimer = setInterval(() => {
        if (this.currentAdvertisement) {
          this.sendAnnouncementNow(RECORD_TTL_SECONDS);
        }
      }, ANNOUNCE_INTERVAL_MS);
      this.announceTimer.unref?.();
    }
  }

  refreshAdvertisement(adv: MdnsHostAdvertisement): void {
    this.currentAdvertisement = adv;
    if (this.hostSocket && this.discoveryState === 'advertising') {
      this.sendAnnouncementNow(RECORD_TTL_SECONDS);
    }
  }

  async stopAdvertising(): Promise<void> {
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }

    if (this.hostSocket && this.currentAdvertisement && this.discoveryState === 'advertising') {
      // Send goodbye packet (TTL=0) best-effort before closing
      this.sendAnnouncementNow(0);
    }

    const sock = this.hostSocket;
    this.hostSocket = null;
    this.currentAdvertisement = null;
    this.discoveryState = 'stopped';

    if (sock) {
      await new Promise<void>((resolve) => {
        try {
          sock.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
  }

  private sendAnnouncementNow(ttlSeconds: number): void {
    if (!this.hostSocket || !this.currentAdvertisement) {
      return;
    }
    try {
      const pkt = encodeMdnsAnnouncementPacket(this.currentAdvertisement, ttlSeconds);
      this.hostSocket.send(pkt, 0, pkt.length, CONNECT_MDNS_PORT, CONNECT_MDNS_MULTICAST_ADDR);
    } catch {
      // Non-fatal on transient interface unavailability
    }
  }

  /**
   * Performs a bounded active LAN mDNS scan (Client side, independent of Host state).
   * Cleans up socket immediately after timeout and prunes expired records.
   */
  async scanLanHosts(timeoutMs = 1500): Promise<DiscoveredHostRecord[]> {
    this.pruneExpiredDiscovered();
    const boundedTimeout = Math.max(250, Math.min(5000, timeoutMs));
    const socket = this.socketFactory();

    await new Promise<void>((resolve) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        try {
          socket.close(() => resolve());
        } catch {
          resolve();
        }
      };

      socket.on('error', () => {
        finish();
      });

      socket.on('message', (msg, rinfo) => {
        const decoded = decodeMdnsPacket(msg, rinfo.address);
        if (!decoded.advertisement) {
          return;
        }
        const adv = decoded.advertisement;
        if (adv.ttl === 0) {
          this.discoveredHosts.delete(adv.hostId);
          return;
        }
        const now = Date.now();
        this.discoveredHosts.set(adv.hostId, {
          hostId: adv.hostId,
          displayName: adv.displayName,
          address: adv.address,
          port: adv.port,
          apiVersion: adv.apiVersion,
          mode: adv.mode,
          fingerprintPrefix: adv.fingerprintPrefix,
          lastSeenAt: new Date(now).toISOString(),
          expiresAt: new Date(now + RECORD_EXPIRY_MS).toISOString(),
        });
      });

      timer = setTimeout(finish, boundedTimeout);

      try {
        socket.bind(CONNECT_MDNS_PORT, undefined, () => {
          try {
            socket.addMembership(CONNECT_MDNS_MULTICAST_ADDR);
          } catch {
            // Proceed with outbound query even if multicast join fails on restricted adapter
          }
          try {
            const query = encodeMdnsQueryPacket();
            socket.send(query, 0, query.length, CONNECT_MDNS_PORT, CONNECT_MDNS_MULTICAST_ADDR);
          } catch {
            // Ignore send failure
          }
        });
      } catch {
        finish();
      }
    });

    this.pruneExpiredDiscovered();
    return Array.from(this.discoveredHosts.values());
  }

  getCachedDiscoveredHosts(): DiscoveredHostRecord[] {
    this.pruneExpiredDiscovered();
    return Array.from(this.discoveredHosts.values());
  }

  ingestDiscoveryPacket(packet: Buffer, senderAddress: string): void {
    const decoded = decodeMdnsPacket(packet, senderAddress);
    if (!decoded.advertisement) {
      return;
    }
    const adv = decoded.advertisement;
    if (adv.ttl === 0) {
      this.discoveredHosts.delete(adv.hostId);
      return;
    }
    const now = Date.now();
    this.discoveredHosts.set(adv.hostId, {
      hostId: adv.hostId,
      displayName: adv.displayName,
      address: adv.address,
      port: adv.port,
      apiVersion: adv.apiVersion,
      mode: adv.mode,
      fingerprintPrefix: adv.fingerprintPrefix,
      lastSeenAt: new Date(now).toISOString(),
      expiresAt: new Date(now + RECORD_EXPIRY_MS).toISOString(),
    });
  }

  private pruneExpiredDiscovered(): void {
    const now = Date.now();
    for (const [hostId, item] of this.discoveredHosts.entries()) {
      if (Date.parse(item.expiresAt) <= now) {
        this.discoveredHosts.delete(hostId);
      }
    }
  }
}
