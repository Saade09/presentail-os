import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let authFailureListener:
  | ((detail: { status: number; url?: string; code?: string }) => void)
  | undefined;

const mockSignOut = vi.fn();
const mockClear = vi.fn();
const mockInvalidateQueries = vi.fn();
const mockGetToken = vi.fn();
let mockIsSignedIn = true;

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isSignedIn: mockIsSignedIn }),
  useClerk: () => ({
    session: { getToken: mockGetToken },
    signOut: mockSignOut,
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    clear: mockClear,
    invalidateQueries: mockInvalidateQueries,
  }),
}));

vi.mock("@/lib/queryClient", () => ({
  on401: vi.fn(
    (
      listener: (detail: {
        status: number;
        url?: string;
        code?: string;
      }) => void,
    ) => {
      authFailureListener = listener;
      return vi.fn();
    },
  ),
}));

import {
  forceStaleSessionRecovery,
  SessionExpiredBanner,
} from "./SessionExpiredBanner";

describe("SessionExpiredBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authFailureListener = undefined;
    mockIsSignedIn = true;
    mockSignOut.mockResolvedValue(undefined);
    mockGetToken.mockResolvedValue("fresh-token");
    mockInvalidateQueries.mockResolvedValue(undefined);
  });

  it("clears user data and signs out immediately for a deleted Clerk user", async () => {
    render(<SessionExpiredBanner />);

    await act(async () => {
      authFailureListener?.({
        status: 401,
        url: "/api/users",
        code: "stale_clerk_session",
      });
    });

    expect(mockClear).toHaveBeenCalledOnce();
    expect(mockSignOut).toHaveBeenCalledWith({
      redirectUrl: "/sign-in?session-reset=1",
    });
    expect(screen.queryByTestId("session-expired-banner")).not.toBeInTheDocument();
  });

  it("recovers a deleted API cookie even when Clerk already reports signed out", async () => {
    mockIsSignedIn = false;
    render(<SessionExpiredBanner />);

    await act(async () => {
      authFailureListener?.({
        status: 401,
        url: "/api/products/318",
        code: "stale_clerk_session",
      });
    });

    expect(mockClear).toHaveBeenCalledOnce();
    expect(mockSignOut).toHaveBeenCalledWith({
      redirectUrl: "/sign-in?session-reset=1",
    });
  });

  it("keeps the manual retry banner for an ordinary temporary 401", async () => {
    render(<SessionExpiredBanner />);

    await act(async () => {
      authFailureListener?.({ status: 401, url: "/api/orders" });
    });

    expect(mockClear).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(screen.getByTestId("session-expired-banner")).toHaveTextContent(
      "/api/orders → 401",
    );
  });

  it("runs forced recovery only once when several protected calls fail together", async () => {
    render(<SessionExpiredBanner />);

    await act(async () => {
      authFailureListener?.({
        status: 401,
        url: "/api/users",
        code: "stale_clerk_session",
      });
      authFailureListener?.({
        status: 401,
        url: "/api/orders",
        code: "stale_clerk_session",
      });
    });

    expect(mockClear).toHaveBeenCalledOnce();
    expect(mockSignOut).toHaveBeenCalledOnce();
  });

  it("allows recovery again after a new signed-in session starts", async () => {
    const { rerender } = render(<SessionExpiredBanner />);

    await act(async () => {
      authFailureListener?.({
        status: 401,
        url: "/api/users",
        code: "stale_clerk_session",
      });
    });
    expect(mockSignOut).toHaveBeenCalledOnce();

    mockIsSignedIn = false;
    rerender(<SessionExpiredBanner />);
    mockIsSignedIn = true;
    rerender(<SessionExpiredBanner />);

    await act(async () => {
      authFailureListener?.({
        status: 401,
        url: "/api/users",
        code: "stale_clerk_session",
      });
    });

    expect(mockSignOut).toHaveBeenCalledTimes(2);
  });

  it("hard-navigates even when Clerk resolves sign-out without redirecting", async () => {
    const redirect = vi.fn();
    const clearUserData = vi.fn();

    await forceStaleSessionRecovery({
      signOut: vi.fn().mockResolvedValue(undefined),
      clearUserData,
      redirect,
      redirectUrl: "/sign-in?session-reset=1",
    });

    expect(clearUserData).toHaveBeenCalledOnce();
    expect(redirect).toHaveBeenCalledOnce();
    expect(redirect).toHaveBeenCalledWith("/sign-in?session-reset=1");
  });

  it("hard-navigates even when Clerk rejects sign-out", async () => {
    const redirect = vi.fn();

    await forceStaleSessionRecovery({
      signOut: vi.fn().mockRejectedValue(new Error("Clerk unavailable")),
      clearUserData: vi.fn(),
      redirect,
      redirectUrl: "/sign-in?session-reset=1",
    });

    expect(redirect).toHaveBeenCalledOnce();
  });

  it("hard-navigates on a timeout when Clerk sign-out never settles", async () => {
    vi.useFakeTimers();
    const redirect = vi.fn();

    void forceStaleSessionRecovery({
      signOut: vi.fn(() => new Promise(() => undefined)),
      clearUserData: vi.fn(),
      redirect,
      redirectUrl: "/sign-in?session-reset=1",
    });
    await vi.advanceTimersByTimeAsync(1_500);

    expect(redirect).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});