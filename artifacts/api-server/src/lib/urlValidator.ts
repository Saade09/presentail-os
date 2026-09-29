import { isIP } from "net";
import { promises as dns } from "dns";

/**
 * Private/reserved IPv4 CIDR ranges that must never be reached via SSRF.
 * Each entry is [networkBigInt, maskBigInt].
 */
const PRIVATE_IPV4_RANGES: [bigint, bigint][] = (
  [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
    ["255.255.255.255", 32],
  ] as [string, number][]
).map(([addr, prefix]) => {
  const parts = addr.split(".").map(Number);
  const n = BigInt(
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0,
  );
  const mask =
    prefix === 0
      ? 0n
      : ~((1n << BigInt(32 - prefix)) - 1n) & 0xffff_ffffn;
  return [n & mask, mask] as [bigint, bigint];
});

function ipv4ToBigInt(ip: string): bigint {
  const parts = ip.split(".").map(Number);
  return BigInt(
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0,
  );
}

/** Returns true if the dotted-decimal IPv4 address falls in a private/reserved range. */
function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToBigInt(ip);
  return PRIVATE_IPV4_RANGES.some(([network, mask]) => (n & mask) === network);
}

/**
 * Returns true if the IPv6 address (without brackets) is a private, loopback,
 * link-local, or multicast address — including IPv4-mapped forms like
 * `::ffff:127.0.0.1` or `::ffff:7f00:1`.
 */
function isPrivateIpv6(addr: string): boolean {
  const lower = addr.toLowerCase().replace(/^\[|\]$/g, "");

  if (lower === "::1" || lower === "::") return true;

  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;

  if (lower.startsWith("fe80") || lower.startsWith("fe9") ||
      lower.startsWith("fea") || lower.startsWith("feb")) return true;

  if (lower.startsWith("ff")) return true;

  const v4MappedMatch =
    lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i) ??
    lower.match(/^::ffff:([0-9a-f]{1,4}:[0-9a-f]{1,4})$/i);

  if (v4MappedMatch) {
    const v4part = v4MappedMatch[1];
    if (v4part.includes(".")) {
      return isPrivateIpv4(v4part);
    }
    const [hi, lo] = v4part.split(":").map((h) => parseInt(h, 16));
    const dotted = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
    return isPrivateIpv4(dotted);
  }

  return false;
}

/**
 * Synchronous check: returns true if the *literal* URL would result in a
 * connection to a private/internal address or uses a non-HTTPS scheme.
 *
 * This only checks literal IP addresses and well-known hostnames like
 * "localhost". Use `assertPublicUrl()` for a full async DNS-resolving check.
 */
export function isPrivateUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true;
  }

  if (parsed.protocol !== "https:") return true;

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");

  if (hostname === "localhost") return true;

  const ipVersion = isIP(hostname);

  if (ipVersion === 4) {
    return isPrivateIpv4(hostname);
  }

  if (ipVersion === 6) {
    return isPrivateIpv6(hostname);
  }

  return false;
}

/**
 * Async SSRF guard: resolves `hostname` via DNS (A + AAAA) and returns true
 * if *any* resolved address is private/reserved.
 *
 * Throws if DNS resolution fails entirely (NXDOMAIN, timeout, etc.).
 */
export type PublicUrlAddress = { address: string; family: number };
export type PublicUrlResolver = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<PublicUrlAddress[]>;

export async function resolvePublicUrlAddress(
  rawUrl: string,
  resolver: PublicUrlResolver = dns.lookup as PublicUrlResolver,
): Promise<PublicUrlAddress> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("storeUrl must be a valid URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("storeUrl must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("storeUrl must not contain embedded credentials");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (hostname === "localhost" || isPrivateUrl(rawUrl)) {
    throw new Error("storeUrl must be a public internet address");
  }

  const ipVersion = isIP(hostname);
  if (ipVersion > 0) {
    return { address: hostname, family: ipVersion };
  }

  let addresses: PublicUrlAddress[];
  try {
    addresses = await resolver(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("storeUrl hostname could not be resolved");
  }
  if (addresses.length === 0) {
    throw new Error("storeUrl hostname could not be resolved");
  }

  for (const { address, family } of addresses) {
    if (
      (family !== 4 && family !== 6) ||
      isIP(address) !== family ||
      (family === 4 && isPrivateIpv4(address)) ||
      (family === 6 && isPrivateIpv6(address))
    ) {
      throw new Error("storeUrl must be a public internet address");
    }
  }
  return addresses[0];
}

/**
 * Full SSRF check for an external store URL:
 *  1. Must be parseable as a URL.
 *  2. Must use HTTPS.
 *  3. Must not be a literal private/reserved address (fast synchronous path).
 *  4. Must resolve via DNS to a public address (async DNS path).
 *
 * Throws an Error with a user-safe message if any check fails.
 */
export async function assertPublicStoreUrl(rawUrl: string): Promise<void> {
  await resolvePublicUrlAddress(rawUrl);
}

/**
 * Synchronous URL validation used at store-creation time for an immediate
 * cheap pre-check (rejects bad schemes, literal private IPs, localhost).
 * The full async DNS check happens in `fetchOrdersPage` at sync time.
 *
 * Returns an error string if invalid, or null if the URL passes basic checks.
 */
export function validateStoreUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "storeUrl must be a valid URL";
  }

  if (parsed.protocol !== "https:") {
    return "storeUrl must use HTTPS";
  }

  if (isPrivateUrl(rawUrl)) {
    return "storeUrl must be a public internet address";
  }

  return null;
}
