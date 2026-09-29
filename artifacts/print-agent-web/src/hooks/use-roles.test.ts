import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  queryClient: { invalidateQueries: vi.fn() },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn().mockReturnValue({ data: undefined, status: "pending" }),
}));

import { renderHook } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { useRoles } from "./use-roles";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useRoles — missing/partial data", () => {
  it("does not crash when query data is undefined", () => {
    vi.mocked(useQuery).mockReturnValueOnce({
      data: undefined,
      status: "pending",
    } as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useRoles());

    expect(result.current.data).toBeUndefined();
  });

  it("does not crash when query data has no roles field", () => {
    vi.mocked(useQuery).mockReturnValueOnce({
      data: {} as never,
      status: "success",
    } as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useRoles());

    expect((result.current.data as Record<string, unknown> | undefined)?.roles).toBeUndefined();
  });

  it("returns the roles array when the API response is complete", () => {
    const roles = [
      { id: 1, name: "Admin", allowed_pages: [], channel_ids: [], created_at: "2024-01-01" },
      { id: 2, name: "Viewer", allowed_pages: ["devices"], channel_ids: [3], created_at: "2024-01-02" },
    ];

    vi.mocked(useQuery).mockReturnValueOnce({
      data: { roles },
      status: "success",
    } as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useRoles());

    expect(result.current.data).toEqual({ roles });
  });

  it("returns an empty roles array without crashing", () => {
    vi.mocked(useQuery).mockReturnValueOnce({
      data: { roles: [] },
      status: "success",
    } as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useRoles());

    expect(result.current.data).toEqual({ roles: [] });
  });
});
