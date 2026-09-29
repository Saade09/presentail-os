import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks — declared before any imports that depend on them
// ---------------------------------------------------------------------------

const mockToast = vi.fn();

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

const mockNavigate = vi.fn();

vi.mock("wouter", () => ({
  useLocation: () => ["/", mockNavigate],
}));

vi.mock("@/components/ui/toast", () => ({
  ToastAction: ({
    children,
    onClick,
    altText,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    altText: string;
  }) => <button onClick={onClick} aria-label={altText}>{children}</button>,
}));

// ---------------------------------------------------------------------------
// Mock of the shared authed-SSE helper. The transport itself (Bearer token,
// reconnect, heartbeat) is covered in use-authed-sse.test.ts; here we only
// exercise the hook's event handling by driving the registered handlers.
// ---------------------------------------------------------------------------

interface SseInstance {
  url: string;
  enabled: boolean;
  handlers: Record<string, (data: string) => void>;
}

let sseInstances: SseInstance[] = [];

vi.mock("@/hooks/use-authed-sse", () => ({
  useAuthedSse: (
    url: string,
    enabled: boolean,
    handlers: Record<string, (data: string) => void>,
  ) => {
    if (!enabled) return;
    const existing = sseInstances.find((i) => i.url === url);
    if (existing) {
      existing.handlers = handlers;
    } else {
      sseInstances.push({ url, enabled, handlers });
    }
  },
}));

// ---------------------------------------------------------------------------
// Import hook AFTER mocks are in place
// ---------------------------------------------------------------------------

import { useLowStockSse } from "./use-low-stock-sse";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush pending microtasks and React state updates. */
const flushPromises = () => act(async () => {});

/** Fire a named event with the given data on the (single) mock connection. */
function triggerEvent(type: string, data: unknown) {
  const inst = sseInstances[0];
  inst?.handlers[type]?.(
    typeof data === "string" ? data : JSON.stringify(data),
  );
}

const PAYLOAD = {
  itemName: "Ficus Plant",
  locationName: "Warehouse A",
  currentStock: 2,
  baseItemId: 101,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useLowStockSse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sseInstances = [];
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  it("does not open a connection when enabled is false", async () => {
    renderHook(() => useLowStockSse(false));
    await flushPromises();

    expect(sseInstances).toHaveLength(0);
  });

  it("opens a connection to /api/base-items/low-stock-events when enabled is true", async () => {
    const { unmount } = renderHook(() => useLowStockSse(true));
    await flushPromises();

    expect(sseInstances).toHaveLength(1);
    expect(sseInstances[0].url).toBe("/api/base-items/low-stock-events");
    expect(sseInstances[0].handlers).toHaveProperty("low_stock");
    unmount();
  });

  // -------------------------------------------------------------------------
  // Toast fires on a low_stock event
  // -------------------------------------------------------------------------

  it("calls toast with the correct title and description when a low_stock event arrives", async () => {
    const { unmount } = renderHook(() => useLowStockSse(true));
    await flushPromises();

    act(() => {
      triggerEvent("low_stock", PAYLOAD);
    });

    expect(mockToast).toHaveBeenCalledOnce();
    const callArg = mockToast.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.title).toBe(`⚠️ Low stock: ${PAYLOAD.itemName}`);
    expect(callArg.description).toContain(PAYLOAD.locationName);
    expect(callArg.description).toContain(String(PAYLOAD.currentStock));

    unmount();
  });

  it("uses 'unit' (singular) in the description when currentStock is 1", async () => {
    const { unmount } = renderHook(() => useLowStockSse(true));
    await flushPromises();

    act(() => {
      triggerEvent("low_stock", { ...PAYLOAD, currentStock: 1 });
    });

    const callArg = mockToast.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.description).toContain("1 unit remaining");

    unmount();
  });

  it("uses 'units' (plural) in the description when currentStock is not 1", async () => {
    const { unmount } = renderHook(() => useLowStockSse(true));
    await flushPromises();

    act(() => {
      triggerEvent("low_stock", { ...PAYLOAD, currentStock: 3 });
    });

    const callArg = mockToast.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.description).toContain("3 units remaining");

    unmount();
  });

  it("sets duration to 10 000 ms on the toast", async () => {
    const { unmount } = renderHook(() => useLowStockSse(true));
    await flushPromises();

    act(() => {
      triggerEvent("low_stock", PAYLOAD);
    });

    const callArg = mockToast.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.duration).toBe(10_000);

    unmount();
  });

  it("does not call toast when the event data is malformed JSON", async () => {
    const { unmount } = renderHook(() => useLowStockSse(true));
    await flushPromises();

    act(() => {
      triggerEvent("low_stock", "not-valid-json{{");
    });

    expect(mockToast).not.toHaveBeenCalled();

    unmount();
  });

  // -------------------------------------------------------------------------
  // Session-scoped deduplication
  // -------------------------------------------------------------------------

  it("suppresses the toast on the second low_stock event for the same item+location", async () => {
    const { unmount } = renderHook(() => useLowStockSse(true));
    await flushPromises();

    act(() => {
      triggerEvent("low_stock", PAYLOAD);
    });

    expect(mockToast).toHaveBeenCalledOnce();

    act(() => {
      triggerEvent("low_stock", PAYLOAD);
    });

    // Still only one call — the second event is deduped
    expect(mockToast).toHaveBeenCalledOnce();

    unmount();
  });

  it("allows the toast for a different location even after the first item+location was seen", async () => {
    const { unmount } = renderHook(() => useLowStockSse(true));
    await flushPromises();

    act(() => {
      triggerEvent("low_stock", PAYLOAD);
    });

    expect(mockToast).toHaveBeenCalledOnce();

    act(() => {
      triggerEvent("low_stock", { ...PAYLOAD, locationName: "Branch B" });
    });

    expect(mockToast).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("allows the toast for a different item even after the first item+location was seen", async () => {
    const { unmount } = renderHook(() => useLowStockSse(true));
    await flushPromises();

    act(() => {
      triggerEvent("low_stock", PAYLOAD);
    });

    expect(mockToast).toHaveBeenCalledOnce();

    act(() => {
      triggerEvent("low_stock", {
        ...PAYLOAD,
        itemName: "Rose Bouquet",
        baseItemId: 202,
      });
    });

    expect(mockToast).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("stores the dedup key in sessionStorage after the first toast", async () => {
    const { unmount } = renderHook(() => useLowStockSse(true));
    await flushPromises();

    act(() => {
      triggerEvent("low_stock", PAYLOAD);
    });

    const key = `low-stock-seen:${PAYLOAD.itemName}::${PAYLOAD.locationName}`;
    expect(sessionStorage.getItem(key)).toBe("1");

    unmount();
  });

  it("suppresses the toast when the dedup key is already in sessionStorage before the event fires", async () => {
    const key = `low-stock-seen:${PAYLOAD.itemName}::${PAYLOAD.locationName}`;
    sessionStorage.setItem(key, "1");

    const { unmount } = renderHook(() => useLowStockSse(true));
    await flushPromises();

    act(() => {
      triggerEvent("low_stock", PAYLOAD);
    });

    expect(mockToast).not.toHaveBeenCalled();

    unmount();
  });
});
