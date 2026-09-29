/**
 * True when an API error represents a permission rejection (HTTP 403).
 * Both `apiFetch` (src/lib/queryClient.ts) and the generated api-client
 * attach a numeric `status` to thrown errors.
 */
export function isPermissionError(err: unknown): boolean {
  return (err as { status?: unknown } | null | undefined)?.status === 403;
}
