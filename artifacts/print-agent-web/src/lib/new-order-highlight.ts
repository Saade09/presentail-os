import { useSyncExternalStore } from "react";

/**
 * Tiny module-level store of recently arrived (SSE `order.created`) order ids,
 * used by the Orders page to briefly highlight the new row once the refetched
 * list contains it. Written by `useNewOrderSse`, read via
 * `useRecentNewOrderIds`. Entries auto-expire after HIGHLIGHT_MS.
 */

export const HIGHLIGHT_MS = 12_000;

const recent = new Map<string, number>();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();

function rebuildSnapshot(): void {
  snapshot = new Set(recent.keys());
  for (const l of listeners) l();
}

export function markNewOrder(orderId: string): void {
  if (recent.has(orderId)) return;
  recent.set(orderId, Date.now());
  rebuildSnapshot();
  const timer = setTimeout(() => {
    recent.delete(orderId);
    rebuildSnapshot();
  }, HIGHLIGHT_MS);
  // Never keep a test process alive for the fade-out timer.
  (timer as unknown as { unref?: () => void }).unref?.();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ReadonlySet<string> {
  return snapshot;
}

/** Set of order ids that arrived via SSE within the last HIGHLIGHT_MS. */
export function useRecentNewOrderIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only helper. */
export function __clearNewOrderHighlightsForTests(): void {
  recent.clear();
  rebuildSnapshot();
}
