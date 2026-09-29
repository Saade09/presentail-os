/**
 * Unit tests for useUpload hook.
 *
 * Imports directly from the lib source to bypass the workspace alias that
 * maps @workspace/object-storage-web → the vi.fn() mock shim used by
 * component tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Direct import bypasses the "@workspace/object-storage-web" alias in vitest.config.ts
import { useUpload } from "../../../../lib/object-storage-web/src/use-upload";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRESIGNED_RESPONSE = {
  uploadURL: "https://storage.example.com/presigned",
  objectPath: "/objects/workspace/test.jpg",
  metadata: { name: "test.jpg", size: 1000, contentType: "image/jpeg" },
};

function makePresignedFetchResponse() {
  return {
    ok: true,
    json: async () => PRESIGNED_RESPONSE,
  };
}

function makePutFetchResponse() {
  return { ok: true };
}

function makeFile(name = "test.jpg", type = "image/jpeg") {
  return new File(["content"], name, { type });
}

// ---------------------------------------------------------------------------
// Tests: Authorization header
// ---------------------------------------------------------------------------

describe("useUpload – Authorization header", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends Authorization: Bearer <token> on the presigned-URL request when getAuthToken is provided", async () => {
    mockFetch
      .mockResolvedValueOnce(makePresignedFetchResponse())
      .mockResolvedValueOnce(makePutFetchResponse());

    const getAuthToken = vi.fn().mockResolvedValue("test-token-abc");
    const { result } = renderHook(() => useUpload({ getAuthToken }));

    await act(async () => {
      await result.current.uploadFile(makeFile());
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, requestInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = requestInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token-abc");
  });

  it("does NOT send Authorization header when getAuthToken is not provided", async () => {
    mockFetch
      .mockResolvedValueOnce(makePresignedFetchResponse())
      .mockResolvedValueOnce(makePutFetchResponse());

    const { result } = renderHook(() => useUpload());

    await act(async () => {
      await result.current.uploadFile(makeFile());
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, requestInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = requestInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("calls getAuthToken before the request, not after", async () => {
    mockFetch
      .mockResolvedValueOnce(makePresignedFetchResponse())
      .mockResolvedValueOnce(makePutFetchResponse());

    const getAuthToken = vi.fn().mockResolvedValue("token-xyz");
    const { result } = renderHook(() => useUpload({ getAuthToken }));

    await act(async () => {
      await result.current.uploadFile(makeFile());
    });

    expect(getAuthToken).toHaveBeenCalledOnce();
    expect(mockFetch.mock.invocationCallOrder[0]).toBeGreaterThan(
      getAuthToken.mock.invocationCallOrder[0],
    );
  });

  it("omits Authorization header when getAuthToken returns null", async () => {
    mockFetch
      .mockResolvedValueOnce(makePresignedFetchResponse())
      .mockResolvedValueOnce(makePutFetchResponse());

    const getAuthToken = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() => useUpload({ getAuthToken }));

    await act(async () => {
      await result.current.uploadFile(makeFile());
    });

    const [, requestInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = requestInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: error handling
// ---------------------------------------------------------------------------

describe("useUpload – error handling", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls onError and returns null when the presigned-URL request fails (non-ok status)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Unauthorized" }),
    });

    const onError = vi.fn();
    const { result } = renderHook(() => useUpload({ onError }));

    let uploadResult: Awaited<ReturnType<typeof result.current.uploadFile>>;
    await act(async () => {
      uploadResult = await result.current.uploadFile(makeFile());
    });

    expect(uploadResult!).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("calls onError and returns null when the PUT to storage fails", async () => {
    mockFetch
      .mockResolvedValueOnce(makePresignedFetchResponse())
      .mockResolvedValueOnce({ ok: false });

    const onError = vi.fn();
    const { result } = renderHook(() => useUpload({ onError }));

    let uploadResult: Awaited<ReturnType<typeof result.current.uploadFile>>;
    await act(async () => {
      uploadResult = await result.current.uploadFile(makeFile());
    });

    expect(uploadResult!).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("calls onSuccess with the upload response on a successful upload", async () => {
    mockFetch
      .mockResolvedValueOnce(makePresignedFetchResponse())
      .mockResolvedValueOnce(makePutFetchResponse());

    const onSuccess = vi.fn();
    const { result } = renderHook(() => useUpload({ onSuccess }));

    let uploadResult: Awaited<ReturnType<typeof result.current.uploadFile>>;
    await act(async () => {
      uploadResult = await result.current.uploadFile(makeFile());
    });

    expect(uploadResult).toMatchObject({
      objectPath: PRESIGNED_RESPONSE.objectPath,
      uploadURL: PRESIGNED_RESPONSE.uploadURL,
    });
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ objectPath: PRESIGNED_RESPONSE.objectPath }),
    );
  });
});
