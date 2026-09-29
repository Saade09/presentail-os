/**
 * Regression tests for live role simulation ("View as role").
 *
 * The simulated role's permissions must be resolved LIVE from the current
 * ["roles"] query data — not from a snapshot taken when simulation started —
 * so editing a role's permissions while simulating it updates the effective
 * allowedPages as soon as the roles data refreshes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SimulatedRoleProvider, useSimulatedRole } from "@/contexts/simulated-role-context";
import { useWorkspaceRole } from "./use-workspace-role";

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: mockApiFetch,
  queryClient: { invalidateQueries: vi.fn() },
}));

vi.mock("@clerk/react", () => ({
  useAuth: vi.fn().mockReturnValue({ isSignedIn: true }),
}));

const USERS_RESPONSE = {
  members: [],
  me: {
    role: "owner",
    email: "owner@example.com",
    allowedPages: null,
    customRoleId: null,
  },
};

const CMC_ROLE_BEFORE = {
  id: 7,
  name: "CMC",
  description: null,
  allowed_pages: ["cmc_pos.sell"],
  channel_ids: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const CMC_ROLE_AFTER = {
  ...CMC_ROLE_BEFORE,
  allowed_pages: ["cmc_pos.sell", "cmc_pos.cash_drawer", "cmc_pos.returns"],
};

function useTestHarness() {
  const workspaceRole = useWorkspaceRole();
  const { simulatedRole, setSimulatedRole } = useSimulatedRole();
  return { workspaceRole, simulatedRole, setSimulatedRole };
}

function setup(rolesResponse: { roles: unknown[] }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mockApiFetch.mockImplementation(async (url: string) => {
    if (url === "/api/users") return USERS_RESPONSE;
    if (url === "/api/roles") return rolesResponse;
    throw new Error(`unexpected fetch: ${url}`);
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <SimulatedRoleProvider>{children}</SimulatedRoleProvider>
    </QueryClientProvider>
  );
  const rendered = renderHook(() => useTestHarness(), { wrapper });
  return { queryClient, ...rendered };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe("useWorkspaceRole — live role simulation", () => {
  it("resolves simulated allowedPages from the current roles data by role id", async () => {
    const { result } = setup({ roles: [CMC_ROLE_BEFORE] });

    await waitFor(() => expect(result.current.workspaceRole.loaded).toBe(true));
    expect(result.current.workspaceRole.allowedPages).toBeNull();

    act(() => {
      result.current.setSimulatedRole({ id: 7, name: "CMC" });
    });

    await waitFor(() =>
      expect(result.current.workspaceRole.allowedPages).toEqual(["cmc_pos.sell"]),
    );
    expect(result.current.workspaceRole.isOwner).toBe(false);
    expect(result.current.workspaceRole.realIsOwner).toBe(true);
  });

  it("reflects permission edits after the roles data refreshes (role save)", async () => {
    const { result, queryClient } = setup({ roles: [CMC_ROLE_BEFORE] });

    act(() => {
      result.current.setSimulatedRole({ id: 7, name: "CMC" });
    });
    await waitFor(() =>
      expect(result.current.workspaceRole.allowedPages).toEqual(["cmc_pos.sell"]),
    );

    // Simulate saving the role: the Roles page invalidates ["roles"];
    // the refetch now returns the updated permissions.
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === "/api/users") return USERS_RESPONSE;
      if (url === "/api/roles") return { roles: [CMC_ROLE_AFTER] };
      throw new Error(`unexpected fetch: ${url}`);
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["roles"] });
    });

    await waitFor(() =>
      expect(result.current.workspaceRole.allowedPages).toEqual([
        "cmc_pos.sell",
        "cmc_pos.cash_drawer",
        "cmc_pos.returns",
      ]),
    );
  });

  it("does not persist an allowedPages snapshot in sessionStorage", async () => {
    const { result } = setup({ roles: [CMC_ROLE_BEFORE] });

    act(() => {
      result.current.setSimulatedRole({ id: 7, name: "CMC" });
    });

    const stored = JSON.parse(sessionStorage.getItem("simulatedRole")!);
    expect(stored).toEqual({ id: 7, name: "CMC" });
    expect(stored).not.toHaveProperty("allowedPages");
  });

  it("falls back to the user's own view when the simulated role was deleted", async () => {
    const { result } = setup({ roles: [] });

    act(() => {
      result.current.setSimulatedRole({ id: 99, name: "Ghost" });
    });

    await waitFor(() => expect(result.current.simulatedRole).toBeNull());
    await waitFor(() => expect(result.current.workspaceRole.loaded).toBe(true));
    expect(result.current.workspaceRole.allowedPages).toBeNull();
    expect(result.current.workspaceRole.isOwner).toBe(true);
  });
});
