import { networkInterfaces } from 'node:os';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);
/** Adapter names that are never the Wi-Fi/LAN a guest's phone is on. */
const VIRTUAL_ADAPTER = /vethernet|wsl|virtualbox|vmware|docker|hyper-v|loopback|tailscale|zerotier|bluetooth/i;

type Interfaces = Record<string, { address: string; family: string | number; internal: boolean }[] | undefined>;

function isPrivateIPv4(ip: string) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

/** The machine's LAN IPv4 address (the one phones on the same Wi-Fi can reach), or null. */
export function pickLanAddress(ifaces: Interfaces = networkInterfaces()): string | null {
  const candidates: { ip: string; virtual: boolean }[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list ?? []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4) || !isPrivateIPv4(a.address)) continue;
      candidates.push({ ip: a.address, virtual: VIRTUAL_ADAPTER.test(name) });
    }
  }
  return (candidates.find((c) => !c.virtual) ?? null)?.ip ?? null;
}

/**
 * Base URL printed into guest QR codes and queue tickets. A QR that says "localhost" can never
 * work: the guest's phone would try to reach itself. Order of preference:
 * 1. PUBLIC_BASE_URL when it names a real host (production domain);
 * 2. the address the staff device is using right now (Origin, else Host);
 * 3. either of those with localhost swapped for this machine's LAN address, keeping the port.
 */
export function resolvePublicBaseUrl(o: { configured?: string; origin?: string; host?: string; protocol?: string; lanAddress: string | null }): string {
  const candidates = [o.configured, o.origin, o.host ? `${o.protocol ?? 'http'}://${o.host}` : undefined];
  let fallback: URL | null = null;
  for (const c of candidates) {
    if (!c) continue;
    let u: URL;
    try {
      u = new URL(c);
    } catch {
      continue;
    }
    if (!LOCAL_HOSTS.has(u.hostname)) return u.origin;
    fallback ??= u;
  }
  if (!fallback) return o.lanAddress ? `http://${o.lanAddress}` : 'http://localhost';
  if (o.lanAddress) fallback.hostname = o.lanAddress;
  return fallback.origin;
}
