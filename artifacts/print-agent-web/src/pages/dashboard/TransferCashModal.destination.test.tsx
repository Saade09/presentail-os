/**
 * Regression tests for the Transfer Cash dialog destination selection.
 *
 * Bug: /api/cash-drawers returns per-drawer `currency`/`secondary_currency`
 * (never a `currencies` array), so the old `d.currencies.includes(...)` filter
 * threw on the re-render triggered by picking a Destination location, crashing
 * (and effectively reloading) the page.
 *
 * Covers:
 *   - Selecting a destination location keeps the dialog rendered when a drawer
 *     payload lacks `currencies` entirely, and the drawer dropdown is enabled.
 *   - Drawers expose their supported currencies via currency/secondary_currency.
 *   - drawerSupportedCurrencies is tolerant of malformed payloads.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[] }) => mockUseQuery(opts),
  useMutation: (opts: unknown) => mockUseMutation(opts),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  queryClient: { invalidateQueries: vi.fn() },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import {
  TransferCashModal,
  drawerSupportedCurrencies,
} from "./TransferCashModal";

const LOCATIONS = [
  { id: 1, name: "Beirut HQ" },
  { id: 2, name: "Dubai Branch" },
];

// Real API shape: no `currencies` array at all.
const DRAWERS = [
  {
    id: 10,
    name: "Main Drawer",
    code: "MAIN",
    location_id: 2,
    is_active: true,
    currency: "USD",
    secondary_currency: null,
  },
  {
    id: 11,
    name: "No-currency Drawer",
    code: null,
    location_id: 2,
    is_active: true,
    // no currency fields at all — must not crash and must not be hidden
  },
];

function setupMocks(drawers: unknown[] = DRAWERS) {
  mockUseMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseQuery.mockImplementation(({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === "locations") return { data: { locations: LOCATIONS } };
    if (queryKey[0] === "cash-drawers") return { data: { drawers } };
    if (queryKey[0] === "users") return { data: { members: [] } };
    return { data: undefined };
  });
}

function renderModal(currencies: string[] = ["USD"]) {
  return render(
    <TransferCashModal
      open
      onClose={vi.fn()}
      sessionId="1"
      sessionNumber="CS-001"
      sourceLocationName="Beirut HQ"
      sourceDrawerName="Front Desk"
      sourceDrawerId={99}
      currencies={currencies}
      currencySummary={[
        { currency: currencies[0], expected_cash: 5_000_000 } as never,
      ]}
      onSuccess={vi.fn()}
    />,
  );
}

describe("TransferCashModal – destination selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the dialog open and enables the drawer dropdown when drawers lack `currencies`", async () => {
    setupMocks();
    renderModal();
    const user = userEvent.setup();

    const locationTrigger = screen.getByTestId("select-destination-location");
    await act(() => user.click(locationTrigger));
    await act(() =>
      user.click(screen.getByRole("option", { name: /Dubai Branch/ })),
    );

    // Dialog still rendered — no crash/reload.
    expect(screen.getByTestId("transfer-cash-modal")).toBeInTheDocument();

    // Drawer dropdown is enabled and lists both drawers.
    const drawerTrigger = screen.getByTestId("select-destination-drawer");
    expect(drawerTrigger).toBeEnabled();
    await act(() => user.click(drawerTrigger));
    expect(screen.getByRole("option", { name: /Main Drawer/ })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /No-currency Drawer/ }),
    ).toBeInTheDocument();
  });

  it("filters out drawers whose known currencies don't include the selected one", async () => {
    setupMocks([
      {
        id: 20,
        name: "AED Drawer",
        code: null,
        location_id: 2,
        is_active: true,
        currency: "AED",
        secondary_currency: null,
      },
    ]);
    renderModal();
    const user = userEvent.setup();

    await act(() => user.click(screen.getByTestId("select-destination-location")));
    await act(() =>
      user.click(screen.getByRole("option", { name: /Dubai Branch/ })),
    );
    await act(() => user.click(screen.getByTestId("select-destination-drawer")));

    expect(screen.queryByRole("option", { name: /AED Drawer/ })).not.toBeInTheDocument();
    expect(screen.getByText(/No active drawers support USD/)).toBeInTheDocument();
  });

  it("shows only LBP when the source session snapshot is LBP-only", async () => {
    setupMocks();
    renderModal(["LBP"]);
    const user = userEvent.setup();

    await act(() => user.click(screen.getByTestId("select-transfer-currency")));

    expect(screen.getByRole("option", { name: "LBP" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "USD" })).not.toBeInTheDocument();
  });
});

describe("drawerSupportedCurrencies", () => {
  const base = { id: 1, name: "D", code: null, location_id: 1, is_active: true };

  it("returns null when no currency info exists", () => {
    expect(drawerSupportedCurrencies(base)).toBeNull();
  });

  it("collects currency and secondary_currency", () => {
    expect(
      drawerSupportedCurrencies({ ...base, currency: "USD", secondary_currency: "AED" }),
    ).toEqual(["USD", "AED"]);
  });

  it("tolerates malformed currencies values", () => {
    expect(drawerSupportedCurrencies({ ...base, currencies: "USD" })).toBeNull();
    expect(
      drawerSupportedCurrencies({ ...base, currencies: [1, null, "USD"] }),
    ).toEqual(["USD"]);
  });
});
