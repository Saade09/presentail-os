import { describe, it, expect, vi, beforeEach } from "vitest";
import { usersResponseSchema } from "./use-workspace-role";
import { ALL_PAGES, SUB_PERMISSION_LABELS } from "@workspace/page-keys";
import { postLoginPageKeySchema } from "@/post-login-routes";

const { mockApiFetch, mockGetToken } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockGetToken: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: mockApiFetch,
  queryClient: { invalidateQueries: vi.fn() },
}));

vi.mock("@clerk/react", () => ({
  useAuth: vi.fn().mockReturnValue({
    isSignedIn: true,
    getToken: mockGetToken,
  }),
}));

vi.mock("@/contexts/simulated-role-context", () => ({
  useSimulatedRole: vi.fn().mockReturnValue({ simulatedRole: null }),
}));

const { capturedQueryFn } = vi.hoisted(() => ({
  capturedQueryFn: { fn: null as null | (() => Promise<unknown>) },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn().mockImplementation(({ queryKey, queryFn }) => {
    // The hook also issues a ["roles"] query (for live role simulation);
    // only capture the ["users"] queryFn these tests exercise.
    if (Array.isArray(queryKey) && queryKey[0] === "users") {
      capturedQueryFn.fn = queryFn;
    }
    return { data: undefined, status: "pending" };
  }),
}));

import { renderHook } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceRole } from "./use-workspace-role";

const VALID_RESPONSE = {
  members: [],
  me: {
    role: "member",
    email: "user@example.com",
    allowedPages: ["devices", "project-manager-dashboard"],
    customRoleId: null,
  },
};

const ALL_TOP_LEVEL_KEYS = ALL_PAGES.map((p) => p.key);
const ALL_SUB_PERMISSION_KEYS = Object.keys(SUB_PERMISSION_LABELS);
const ALL_POST_LOGIN_KEYS = postLoginPageKeySchema.options;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetToken.mockResolvedValue("fresh-token");
  capturedQueryFn.fn = null;
});

describe("usersResponseSchema", () => {
  it("accepts a response with only known page keys", () => {
    expect(() => usersResponseSchema.parse(VALID_RESPONSE)).not.toThrow();
  });

  it("accepts null allowedPages (owner)", () => {
    const ownerResponse = {
      ...VALID_RESPONSE,
      me: { ...VALID_RESPONSE.me, allowedPages: null },
    };
    expect(() => usersResponseSchema.parse(ownerResponse)).not.toThrow();
  });

  it("accepts all known top-level page keys without error", () => {
    expect(() =>
      usersResponseSchema.parse({
        ...VALID_RESPONSE,
        me: { ...VALID_RESPONSE.me, allowedPages: ALL_TOP_LEVEL_KEYS },
      }),
    ).not.toThrow();
  });

  it("accepts all known sub-permission keys without error", () => {
    expect(() =>
      usersResponseSchema.parse({
        ...VALID_RESPONSE,
        me: { ...VALID_RESPONSE.me, allowedPages: ALL_SUB_PERMISSION_KEYS },
      }),
    ).not.toThrow();
  });

  it("accepts all known post-login page keys without error", () => {
    expect(() =>
      usersResponseSchema.parse({
        ...VALID_RESPONSE,
        me: { ...VALID_RESPONSE.me, allowedPages: ALL_POST_LOGIN_KEYS },
      }),
    ).not.toThrow();
  });

  it("accepts all known valid page keys combined without error", () => {
    const allKeys = [
      ...ALL_TOP_LEVEL_KEYS,
      ...ALL_SUB_PERMISSION_KEYS,
      ...ALL_POST_LOGIN_KEYS,
    ].filter((v, i, arr) => arr.indexOf(v) === i);
    expect(() =>
      usersResponseSchema.parse({
        ...VALID_RESPONSE,
        me: { ...VALID_RESPONSE.me, allowedPages: allKeys },
      }),
    ).not.toThrow();
  });

  it("throws when allowedPages contains an unrecognised page key", () => {
    const badResponse = {
      ...VALID_RESPONSE,
      me: {
        ...VALID_RESPONSE.me,
        allowedPages: ["project_manager_dashboard"],
      },
    };
    expect(() => usersResponseSchema.parse(badResponse)).toThrow();
  });

  it("throws when allowedPages contains a hyphen/underscore typo in a route key", () => {
    const badResponse = {
      ...VALID_RESPONSE,
      me: {
        ...VALID_RESPONSE.me,
        allowedPages: ["project-manager_dashboard"],
      },
    };
    expect(() => usersResponseSchema.parse(badResponse)).toThrow();
  });

  it("throws when allowedPages contains an arbitrary unrecognised string", () => {
    const badResponse = {
      ...VALID_RESPONSE,
      me: { ...VALID_RESPONSE.me, allowedPages: ["completely-unknown-page"] },
    };
    expect(() => usersResponseSchema.parse(badResponse)).toThrow();
  });
});

describe("useWorkspaceRole — missing me field", () => {
  it("returns safe defaults when query data has no me field", () => {
    vi.mocked(useQuery).mockReturnValueOnce({
      data: { members: [] } as never,
      status: "success",
    } as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useWorkspaceRole());

    expect(result.current.role).toBeNull();
    expect(result.current.allowedPages).toBeNull();
    expect(result.current.customRoleId).toBeNull();
    expect(result.current.isOwner).toBe(false);
    expect(result.current.loaded).toBe(true);
  });
});

describe("useWorkspaceRole — queryFn validation", () => {
  it("resolves when the API returns a valid response", async () => {
    mockApiFetch.mockResolvedValue(VALID_RESPONSE);

    renderHook(() => useWorkspaceRole());

    expect(capturedQueryFn.fn).not.toBeNull();
    await expect(capturedQueryFn.fn!()).resolves.toBeDefined();
  });

  it("does not log console.error when the API returns a valid response", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApiFetch.mockResolvedValue(VALID_RESPONSE);

    renderHook(() => useWorkspaceRole());
    await capturedQueryFn.fn!().catch(() => {});

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("refreshes the Clerk token once before surfacing a no_access response", async () => {
    const noAccessError = Object.assign(new Error("no_access"), {
      status: 403,
    });
    mockApiFetch
      .mockRejectedValueOnce(noAccessError)
      .mockResolvedValueOnce(VALID_RESPONSE);
    mockGetToken
      .mockResolvedValueOnce("cached-token")
      .mockResolvedValueOnce("fresh-token");

    renderHook(() => useWorkspaceRole());

    await expect(capturedQueryFn.fn!()).resolves.toEqual(VALID_RESPONSE);
    expect(mockGetToken).toHaveBeenNthCalledWith(1);
    expect(mockGetToken).toHaveBeenNthCalledWith(2, { skipCache: true });
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(mockApiFetch).toHaveBeenNthCalledWith(
      2,
      "/api/users",
      expect.objectContaining({
        headers: { Authorization: "Bearer fresh-token" },
      }),
    );
  });

  it("does not log console.error when the API returns all known valid page keys", async () => {
    const allKeys = [
      ...ALL_TOP_LEVEL_KEYS,
      ...ALL_SUB_PERMISSION_KEYS,
      ...ALL_POST_LOGIN_KEYS,
    ].filter((v, i, arr) => arr.indexOf(v) === i);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApiFetch.mockResolvedValue({
      ...VALID_RESPONSE,
      me: { ...VALID_RESPONSE.me, allowedPages: allKeys },
    });

    renderHook(() => useWorkspaceRole());
    await capturedQueryFn.fn!().catch(() => {});

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("logs console.error when the API returns an unknown allowedPages key", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApiFetch.mockResolvedValue({
      ...VALID_RESPONSE,
      me: {
        ...VALID_RESPONSE.me,
        allowedPages: ["project_manager_dashboard"],
      },
    });

    renderHook(() => useWorkspaceRole());
    await capturedQueryFn.fn!().catch(() => {});

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain("[useWorkspaceRole]");
    errorSpy.mockRestore();
  });

  it("logs console.error when the API returns a completely unknown page key", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApiFetch.mockResolvedValue({
      ...VALID_RESPONSE,
      me: {
        ...VALID_RESPONSE.me,
        allowedPages: ["not-a-real-page"],
      },
    });

    renderHook(() => useWorkspaceRole());
    await capturedQueryFn.fn!().catch(() => {});

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain("[useWorkspaceRole]");
    errorSpy.mockRestore();
  });

  it("rejects when the API returns an unknown allowedPages key", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApiFetch.mockResolvedValue({
      ...VALID_RESPONSE,
      me: {
        ...VALID_RESPONSE.me,
        allowedPages: ["project_manager_dashboard"],
      },
    });

    renderHook(() => useWorkspaceRole());

    expect(capturedQueryFn.fn).not.toBeNull();
    await expect(capturedQueryFn.fn!()).rejects.toThrow();
    errorSpy.mockRestore();
  });

  it("rejects when the API returns a completely unknown page key", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApiFetch.mockResolvedValue({
      ...VALID_RESPONSE,
      me: {
        ...VALID_RESPONSE.me,
        allowedPages: ["not-a-real-page"],
      },
    });

    renderHook(() => useWorkspaceRole());

    expect(capturedQueryFn.fn).not.toBeNull();
    await expect(capturedQueryFn.fn!()).rejects.toThrow();
    errorSpy.mockRestore();
  });
});
