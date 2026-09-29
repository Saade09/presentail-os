import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { WorkspaceImage } from "./WorkspaceImage";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: mockApiFetch,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchMock(status: number) {
  return vi.fn().mockResolvedValue({ status } as Response);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkspaceImage — 401 token refresh and retry", () => {
  it("refreshes the image token and updates src with cache-buster on 401", async () => {
    vi.stubGlobal("fetch", makeFetchMock(401));
    mockApiFetch.mockResolvedValue({});

    const { getByRole } = render(
      <WorkspaceImage src="/api/brands/1/logo" alt="test logo" />,
    );
    const img = getByRole("img");

    expect(img).toHaveAttribute("src", "/api/brands/1/logo");

    fireEvent.error(img);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith("/api/workspace/image-token", {
        method: "POST",
      });
    });

    await waitFor(() => {
      const newSrc = img.getAttribute("src") ?? "";
      expect(newSrc).toMatch(/_t=\d+/);
      expect(newSrc.startsWith("/api/brands/1/logo")).toBe(true);
    });
  });

  it("probes the original src (not the cache-busted one) with a HEAD request", async () => {
    const fetchMock = makeFetchMock(401);
    vi.stubGlobal("fetch", fetchMock);
    mockApiFetch.mockResolvedValue({});

    const { getByRole } = render(
      <WorkspaceImage src="/api/channels/5/logo" alt="channel" />,
    );

    fireEvent.error(getByRole("img"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/channels/5/logo", {
        credentials: "include",
        method: "HEAD",
      });
    });
  });

  it("does not change src or call image-token on non-401 errors", async () => {
    vi.stubGlobal("fetch", makeFetchMock(404));
    mockApiFetch.mockResolvedValue({});

    const onError = vi.fn();
    const { getByRole } = render(
      <WorkspaceImage
        src="/api/stickers/3/thumbnail"
        alt="sticker"
        onError={onError}
      />,
    );
    const img = getByRole("img");

    fireEvent.error(img);

    await waitFor(() => {
      expect(mockApiFetch).not.toHaveBeenCalled();
    });

    expect(img.getAttribute("src")).toBe("/api/stickers/3/thumbnail");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("forwards to caller onError when the HEAD probe throws a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    mockApiFetch.mockResolvedValue({});

    const onError = vi.fn();
    const { getByRole } = render(
      <WorkspaceImage
        src="/api/brands/2/logo"
        alt="brand"
        onError={onError}
      />,
    );

    fireEvent.error(getByRole("img"));

    await waitFor(() => {
      expect(onError).toHaveBeenCalledOnce();
    });

    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("does not retry more than once even when every probe returns 401", async () => {
    vi.stubGlobal("fetch", makeFetchMock(401));
    mockApiFetch.mockResolvedValue({});

    const onError = vi.fn();
    const { getByRole } = render(
      <WorkspaceImage
        src="/api/brands/1/logo"
        alt="logo"
        onError={onError}
      />,
    );
    const img = getByRole("img");

    // First error — should trigger retry
    fireEvent.error(img);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));

    // Second error — retry budget exhausted, forward to onError
    fireEvent.error(img);
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it("retries even when the image-token refresh call fails", async () => {
    vi.stubGlobal("fetch", makeFetchMock(401));
    mockApiFetch.mockRejectedValue(new Error("token endpoint down"));

    const { getByRole } = render(
      <WorkspaceImage src="/api/brands/7/logo" alt="brand" />,
    );
    const img = getByRole("img");

    fireEvent.error(img);

    await waitFor(() => {
      const src = img.getAttribute("src") ?? "";
      expect(src).toMatch(/_t=\d+/);
    });
  });

  it("resets its retry budget when the image src changes", async () => {
    vi.stubGlobal("fetch", makeFetchMock(401));
    mockApiFetch.mockResolvedValue({});

    const onError = vi.fn();
    const { getByRole, rerender } = render(
      <WorkspaceImage src="/api/brands/1/logo" alt="logo" onError={onError} />,
    );
    const img = getByRole("img");

    fireEvent.error(img);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
    fireEvent.error(img);
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());

    rerender(
      <WorkspaceImage src="/api/brands/2/logo" alt="logo" onError={onError} />,
    );
    await waitFor(() =>
      expect(img).toHaveAttribute("src", "/api/brands/2/logo"),
    );
    fireEvent.error(img);

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
  });
});
