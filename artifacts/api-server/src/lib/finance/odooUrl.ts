import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

type OdooUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  const mappedIpv4 = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    const dotted = [
      (high >> 8) & 0xff,
      high & 0xff,
      (low >> 8) & 0xff,
      low & 0xff,
    ].join(".");
    return isPrivateIpv4(dotted);
  }
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  );
}

export function normaliseOdooBaseUrl(value: unknown): OdooUrlResult {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, error: "odoo_base_url is required for Odoo" };
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { ok: false, error: "odoo_base_url must be a valid URL" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, error: "odoo_base_url must use https" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "odoo_base_url must not contain embedded credentials" };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: "odoo_base_url must not contain a query string or fragment" };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const privateHostname =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan");
  const ipVersion = isIP(hostname);
  if (
    privateHostname ||
    (ipVersion === 4 && isPrivateIpv4(hostname)) ||
    (ipVersion === 6 && isPrivateIpv6(hostname))
  ) {
    return { ok: false, error: "odoo_base_url must use a public Odoo host" };
  }

  return { ok: true, url: parsed.toString().replace(/\/+$/, "") };
}

export function sanitiseOdooBaseUrlForResponse(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

type LookupAddress = { address: string; family: number };
type OdooResolver = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

export async function resolvePublicOdooAddress(
  baseUrl: string,
  resolver: OdooResolver = lookup as OdooResolver,
): Promise<LookupAddress> {
  const normalised = normaliseOdooBaseUrl(baseUrl);
  if (!normalised.ok) throw new Error(normalised.error);

  const hostname = new URL(normalised.url).hostname.replace(/^\[|\]$/g, "");
  const addresses = await resolver(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("Odoo host did not resolve to an IP address");

  for (const address of addresses) {
    const ipVersion = isIP(address.address);
    if (
      !ipVersion ||
      (ipVersion === 4 && isPrivateIpv4(address.address)) ||
      (ipVersion === 6 && isPrivateIpv6(address.address))
    ) {
      throw new Error("Odoo host must resolve only to public IP addresses");
    }
  }

  return addresses[0];
}

export function createPinnedOdooLookup(pinnedAddress: LookupAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (typeof options === "object" && options !== null && options.all === true) {
      callback(null, [pinnedAddress]);
      return;
    }
    callback(null, pinnedAddress.address, pinnedAddress.family);
  };
}

type OdooTransportDependencies = {
  resolver?: OdooResolver;
  request?: typeof httpsRequest;
};

export async function safeOdooFetch(
  input: string | URL,
  init: RequestInit = {},
  dependencies: OdooTransportDependencies = {},
): Promise<Response> {
  const target = new URL(input);
  const normalised = normaliseOdooBaseUrl(`${target.protocol}//${target.host}`);
  if (!normalised.ok) throw new Error(normalised.error);
  const pinnedAddress = await resolvePublicOdooAddress(normalised.url, dependencies.resolver);

  return new Promise<Response>((resolve, reject) => {
    const request = (dependencies.request ?? httpsRequest)(
      target,
      {
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string> | undefined,
        lookup: createPinnedOdooLookup(pinnedAddress),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              value.forEach((item) => headers.append(name, item));
            } else if (value !== undefined) {
              headers.set(name, String(value));
            }
          }
          resolve(new Response(Buffer.concat(chunks), {
            status: response.statusCode ?? 500,
            statusText: response.statusMessage,
            headers,
          }));
        });
      },
    );

    const abort = () => {
      const reason = init.signal?.reason;
      request.destroy(reason instanceof Error ? reason : new Error("Odoo request aborted"));
    };
    if (init.signal?.aborted) {
      abort();
    } else {
      init.signal?.addEventListener("abort", abort, { once: true });
    }
    request.on("error", reject);
    if (typeof init.body === "string" || Buffer.isBuffer(init.body)) {
      request.write(init.body);
    } else if (init.body != null) {
      request.destroy(new Error("Unsupported Odoo request body"));
      return;
    }
    request.end();
  });
}