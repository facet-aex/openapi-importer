import { lookup as nodeLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { ImportError } from "./import-error.js";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type HostnameResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

const blockedHostnameSuffixes = [
  "localhost",
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
];

export function assertPublicAddress(address: string): void {
  const family = isIP(address);
  if (family === 0) {
    throw new ImportError(
      "IMPORT_FETCH_BLOCKED",
      "DNS returned an invalid IP address.",
    );
  }
  const blocked =
    family === 4
      ? blockedIpv4Addresses.check(address, "ipv4")
      : blockedIpv6Addresses.check(address, "ipv6");
  if (blocked) {
    throw new ImportError(
      "IMPORT_FETCH_BLOCKED",
      "The source resolved to a non-public network address.",
    );
  }
}

function normalizeHostname(hostname: string): string {
  const withoutTrailingDot = hostname.toLowerCase().replace(/\.$/u, "");
  return withoutTrailingDot.startsWith("[") && withoutTrailingDot.endsWith("]")
    ? withoutTrailingDot.slice(1, -1)
    : withoutTrailingDot;
}

export function parseSafeHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ImportError("INVALID_SOURCE_URL", "The source URL is invalid.");
  }

  if (url.protocol !== "https:") {
    throw new ImportError(
      "IMPORT_FETCH_BLOCKED",
      "Only HTTPS source URLs are allowed.",
    );
  }
  if (url.username || url.password) {
    throw new ImportError(
      "IMPORT_FETCH_BLOCKED",
      "Source URLs cannot contain credentials.",
    );
  }
  if (url.port && url.port !== "443") {
    throw new ImportError(
      "IMPORT_FETCH_BLOCKED",
      "Only the standard HTTPS port is allowed.",
    );
  }

  const hostname = normalizeHostname(url.hostname);
  if (
    blockedHostnameSuffixes.some(
      (suffix) => hostname === suffix || hostname.endsWith(suffix),
    )
  ) {
    throw new ImportError(
      "IMPORT_FETCH_BLOCKED",
      "Local and internal hostnames are not allowed.",
    );
  }
  if (isIP(hostname)) assertPublicAddress(hostname);
  return url;
}

const defaultResolver: HostnameResolver = async (hostname) => {
  const answers = await nodeLookup(hostname, { all: true, order: "verbatim" });
  return answers.map(({ address, family }) => ({
    address,
    family: family as 4 | 6,
  }));
};

export async function resolvePublicAddresses(
  url: URL,
  resolver: HostnameResolver = defaultResolver,
): Promise<ResolvedAddress[]> {
  const hostname = normalizeHostname(url.hostname);
  if (isIP(hostname)) {
    assertPublicAddress(hostname);
    return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new ImportError(
      "IMPORT_FETCH_FAILED",
      "The source hostname could not be resolved.",
    );
  }
  if (addresses.length === 0) {
    throw new ImportError(
      "IMPORT_FETCH_FAILED",
      "The source hostname has no IP addresses.",
    );
  }
  for (const { address } of addresses) assertPublicAddress(address);
  return addresses;
}

export async function validateRemoteSourceUrl(
  value: string,
  resolver?: HostnameResolver,
): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  const url = parseSafeHttpsUrl(value);
  return { url, addresses: await resolvePublicAddresses(url, resolver) };
}
