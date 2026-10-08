import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Outbound-request guard (SSRF). Addresses that must never be reached from
 * user-supplied URLs: loopback, private, link-local, CGNAT, benchmarking,
 * documentation, multicast/reserved, and the IPv6 forms that embed IPv4
 * (mapped, NAT64, 6to4) or are local-scoped.
 */
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, prefix, 'ipv6');

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family !== 6) return true; // not an address: refuse rather than guess
  const v6 = ip.toLowerCase().split('%')[0]!;
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:7f00:1): judge the embedded IPv4 address.
  const mapped = /^(?:0*:)*:?ffff:(.+)$/.exec(v6)?.[1];
  if (mapped) {
    if (isIP(mapped) === 4) return blocked.check(mapped, 'ipv4');
    const hex = mapped.split(':');
    if (hex.length === 2) {
      const n = hex.map((h) => parseInt(h, 16));
      return blocked.check(`${n[0]! >> 8}.${n[0]! & 255}.${n[1]! >> 8}.${n[1]! & 255}`, 'ipv4');
    }
  }
  return blocked.check(v6, 'ipv6');
}

/**
 * DNS lookup that fails when any resolved address is private. Used as the socket's
 * lookup, so the address that is checked is the one connected to (no DNS-rebinding gap).
 */
function guardedLookup(hostname: string, options: any, callback: (...args: any[]) => void) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err);
    const bad = addresses.find((a) => isPrivateAddress(a.address));
    if (bad) return callback(Object.assign(new Error(`destination ${hostname} resolves to a blocked address`), { code: 'EBLOCKED' }));
    if (options?.all) return callback(null, addresses);
    return callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}

const publicOnly = new Agent({ connect: { lookup: guardedLookup as any }, connectTimeout: 5_000 });

/** fetch() for user-supplied URLs: public destinations only, never follows redirects. */
export async function fetchPublic(url: string, init: Parameters<typeof undiciFetch>[1] = {}) {
  const { hostname } = new URL(url);
  const literal = hostname.replace(/^\[|\]$/g, '');
  // IP literals skip DNS, so check them here.
  if (isIP(literal) && isPrivateAddress(literal)) throw new Error(`destination ${hostname} is a blocked address`);
  return undiciFetch(url, { ...init, redirect: 'manual', dispatcher: publicOnly });
}
