/**
 * Unit tests: country filter dropdown is rendered with the correct options and
 * drives the query key / URL param when a country is selected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockSearch } = vi.hoisted(() => ({
  mockSearch: { value: "" },
}));

vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSearch: () => mockSearch.value,
  useLocation: () => ["/orders", vi.fn()],
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn().mockResolvedValue({ orders: [], total: 0, limit: 50, offset: 0 }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: true, allowedPages: null }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // Return the bare translation key — the country names in the dropdown are
    // hardcoded English strings so they are unaffected.
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === "object") {
        return Object.keys(opts).reduce(
          (acc, k) => acc.replace(`{{${k}}}`, String(opts[k])),
          key,
        );
      }
      return key;
    },
  }),
}));

vi.mock("@/components/CreateOrderWizard", () => ({
  CreateOrderWizard: () => null,
}));

// Capture each useQuery call so we can inspect queryKey / queryFn.
type QueryCall = { queryKey: unknown[]; queryFn: () => Promise<unknown> };
const capturedQueryCalls: QueryCall[] = [];

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: QueryCall) => {
    capturedQueryCalls.push(opts);
    return { data: { orders: [], total: 0, limit: 50, offset: 0 }, isLoading: false };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  keepPreviousData: (prev: unknown) => prev,
}));

import OrdersPage from "./Orders";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the options object passed to the orders list useQuery (key[0] === "orders"). */
function lastOrdersQueryCall(): QueryCall | undefined {
  return capturedQueryCalls.findLast(
    (c) => Array.isArray(c.queryKey) && c.queryKey[0] === "orders",
  );
}

/** Execute the orders queryFn and return the URL params it was called with. */
async function captureOrdersQueryUrl(): Promise<URLSearchParams> {
  const { apiFetch } = await import("@/lib/queryClient");
  const mockApiFetch = vi.mocked(apiFetch);
  mockApiFetch.mockClear();

  const call = lastOrdersQueryCall();
  if (!call) return new URLSearchParams();
  await call.queryFn();

  const orderCall = mockApiFetch.mock.calls.find(
    ([url]) => typeof url === "string" && url.startsWith("/api/orders?"),
  );
  const qs = orderCall ? (orderCall[0] as string).split("?")[1] ?? "" : "";
  return new URLSearchParams(qs);
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedQueryCalls.length = 0;
  mockSearch.value = "";
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OrdersPage – country filter dropdown", () => {
  it("initializes the processing and delivery-date filters from an Ops dashboard link", async () => {
    mockSearch.value =
      "status=processing&deliveryDates=2026-08-19";

    render(<OrdersPage />);

    const params = await captureOrdersQueryUrl();
    expect(params.get("status")).toBe("processing");
    expect(params.get("deliveryDates")).toBe("2026-08-19");
  });

  it("renders the country filter trigger in the filter bar", () => {
    render(<OrdersPage />);
    expect(screen.getByTestId("filter-country")).toBeInTheDocument();
  });

  it("shows Lebanon, UAE, and Cyprus options when the dropdown is opened", async () => {
    const user = userEvent.setup();
    render(<OrdersPage />);

    await user.click(screen.getByTestId("filter-country"));

    // Country names are hardcoded strings (not i18n keys), so they always match.
    expect(screen.getByRole("option", { name: /Lebanon/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /UAE/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Cyprus/i })).toBeInTheDocument();
  });

  it("does not include a country param in the query URL when no country is selected (default)", async () => {
    render(<OrdersPage />);
    const params = await captureOrdersQueryUrl();
    expect(params.has("country")).toBe(false);
  });

  it("includes country=lb in the queryKey and URL after selecting Lebanon", async () => {
    const user = userEvent.setup();
    render(<OrdersPage />);

    await user.click(screen.getByTestId("filter-country"));
    await user.click(screen.getByRole("option", { name: /Lebanon/i }));

    // queryKey must include the country code so React Query fires a new fetch.
    expect(lastOrdersQueryCall()?.queryKey).toContain("lb");

    const params = await captureOrdersQueryUrl();
    expect(params.get("country")).toBe("lb");
  });

  it("includes country=ae in the queryKey and URL after selecting UAE", async () => {
    const user = userEvent.setup();
    render(<OrdersPage />);

    await user.click(screen.getByTestId("filter-country"));
    await user.click(screen.getByRole("option", { name: /UAE/i }));

    expect(lastOrdersQueryCall()?.queryKey).toContain("ae");

    const params = await captureOrdersQueryUrl();
    expect(params.get("country")).toBe("ae");
  });

  it("includes country=cy in the queryKey and URL after selecting Cyprus", async () => {
    const user = userEvent.setup();
    render(<OrdersPage />);

    await user.click(screen.getByTestId("filter-country"));
    await user.click(screen.getByRole("option", { name: /Cyprus/i }));

    expect(lastOrdersQueryCall()?.queryKey).toContain("cy");

    const params = await captureOrdersQueryUrl();
    expect(params.get("country")).toBe("cy");
  });

  it("drops the country param after switching back to 'All countries'", async () => {
    const user = userEvent.setup();
    render(<OrdersPage />);

    // Select Lebanon first.
    await user.click(screen.getByTestId("filter-country"));
    await user.click(screen.getByRole("option", { name: /Lebanon/i }));

    let params = await captureOrdersQueryUrl();
    expect(params.get("country")).toBe("lb");

    // Reopen the dropdown and choose the "all" option (rendered as the i18n key).
    await user.click(screen.getByTestId("filter-country"));
    // The "all" SelectItem text is the i18n key in tests; find it via value role.
    const allOption = await screen.findByRole("option", { name: /allCountries/i });
    await user.click(allOption);

    params = await captureOrdersQueryUrl();
    expect(params.has("country")).toBe(false);
  });
});
