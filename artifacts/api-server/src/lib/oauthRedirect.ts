/**
 * Build the external origin for OAuth redirect URIs.
 *
 * In production the API sits behind Replit's reverse proxy; even with
 * trust-proxy enabled, a misconfigured hop could still leave req.protocol as
 * "http". Google only registers https redirect URIs, so anything other than
 * localhost is forced to https. Localhost keeps whatever protocol the dev
 * server actually used (http) so local flows continue to work.
 */
export function externalOrigin(req: { protocol: string; hostname: string }): string {
  const host = req.hostname;
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".localhost");
  const protocol = isLocal ? req.protocol : "https";
  return `${protocol}://${host}`;
}
