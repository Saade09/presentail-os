import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDocumentVisibility } from "./use-document-visibility";

function setVisibilityState(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

function fireVisibilityChange() {
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useDocumentVisibility — initial value", () => {
  afterEach(() => {
    setVisibilityState("visible");
  });

  it("returns true when the page is visible", () => {
    setVisibilityState("visible");
    const { result } = renderHook(() => useDocumentVisibility());
    expect(result.current).toBe(true);
  });

  it("returns false when the page is hidden", () => {
    setVisibilityState("hidden");
    const { result } = renderHook(() => useDocumentVisibility());
    expect(result.current).toBe(false);
  });
});

describe("useDocumentVisibility — visibilitychange events", () => {
  beforeEach(() => {
    setVisibilityState("visible");
  });

  afterEach(() => {
    setVisibilityState("visible");
  });

  it("switches from true to false when the tab is hidden", () => {
    const { result } = renderHook(() => useDocumentVisibility());
    expect(result.current).toBe(true);

    act(() => {
      setVisibilityState("hidden");
      fireVisibilityChange();
    });

    expect(result.current).toBe(false);
  });

  it("switches from false to true when the tab becomes visible again", () => {
    setVisibilityState("hidden");
    const { result } = renderHook(() => useDocumentVisibility());
    expect(result.current).toBe(false);

    act(() => {
      setVisibilityState("visible");
      fireVisibilityChange();
    });

    expect(result.current).toBe(true);
  });

  it("reflects multiple visibility toggles correctly", () => {
    const { result } = renderHook(() => useDocumentVisibility());
    expect(result.current).toBe(true);

    act(() => {
      setVisibilityState("hidden");
      fireVisibilityChange();
    });
    expect(result.current).toBe(false);

    act(() => {
      setVisibilityState("visible");
      fireVisibilityChange();
    });
    expect(result.current).toBe(true);

    act(() => {
      setVisibilityState("hidden");
      fireVisibilityChange();
    });
    expect(result.current).toBe(false);
  });
});

describe("useDocumentVisibility — event listener cleanup", () => {
  it("removes the visibilitychange listener on unmount", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    const { unmount } = renderHook(() => useDocumentVisibility());

    const addedHandler = addSpy.mock.calls.find(
      ([event]) => event === "visibilitychange",
    )?.[1];

    unmount();

    const removedHandler = removeSpy.mock.calls.find(
      ([event]) => event === "visibilitychange",
    )?.[1];

    expect(addedHandler).toBeDefined();
    expect(removedHandler).toBe(addedHandler);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("does not update state after unmount", () => {
    setVisibilityState("visible");
    const { result, unmount } = renderHook(() => useDocumentVisibility());
    expect(result.current).toBe(true);

    unmount();

    act(() => {
      setVisibilityState("hidden");
      fireVisibilityChange();
    });

    expect(result.current).toBe(true);
  });
});
