import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthLoadingRecovery } from "./AuthLoadingRecovery";

describe("AuthLoadingRecovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("replaces the Clerk loading spinner with recovery UI after 15 seconds", () => {
    render(<AuthLoadingRecovery />);

    expect(screen.queryByTestId("dashboard-loading-recovery")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(15_000);
    });

    expect(screen.getByTestId("dashboard-loading-recovery")).toBeInTheDocument();
    expect(
      screen.getByText("Sign-in is taking longer than expected"),
    ).toBeInTheDocument();
  });
});
