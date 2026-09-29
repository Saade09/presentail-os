import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryFilterBar } from "./CmcPosSalesPage";

const apiFetchMock = vi.fn();

vi.mock("@/lib/queryClient", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getClerkToken: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CMC History filter commits", () => {
  it("uses the compact date picker presentation without changing filter controls", async () => {
    const user = userEvent.setup();
    render(
      <HistoryFilterBar
        filter={{
          localFrom: "2026-08-01",
          localTo: "2026-08-26",
          paymentMethod: "",
          search: "",
        }}
        onFilterChange={vi.fn()}
        onApply={vi.fn()}
        onExport={vi.fn()}
        isExporting={false}
        noRecords={false}
      />,
    );

    await user.click(screen.getByTestId("input-cmc-history-date-range"));
    expect(screen.queryByTestId("date-range-picker-header")).not.toBeInTheDocument();
    expect(screen.queryByTestId("date-range-picker-fields")).not.toBeInTheDocument();
    expect(screen.getByTestId("button-date-preset-custom")).toHaveAttribute("aria-pressed", "true");
    expect(Array.from(document.querySelectorAll(".rdp-caption_label")).map((node) => node.textContent))
      .toEqual(["July 2026", "August 2026"]);
    expect(Array.from(document.querySelectorAll(".rdp-weekday")).slice(0, 7).map((node) => node.textContent))
      .toEqual(["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]);
    expect(screen.queryByTestId("button-date-range-clear")).not.toBeInTheDocument();
    expect(screen.getByTestId("select-cmc-history-payment-method")).toBeInTheDocument();
    expect(screen.getByTestId("input-cmc-history-search")).toBeInTheDocument();
    expect(screen.queryByTestId("btn-open-cmc-bulk-date-correction")).not.toBeInTheDocument();
    expect(screen.getByTestId("btn-export-csv")).toBeInTheDocument();
  });

  it("does not commit a draft search merely because another control receives focus", () => {
    const onApply = vi.fn();
    const onFilterChange = vi.fn();
    render(
      <HistoryFilterBar
        filter={{
          localFrom: "2026-08-01",
          localTo: "2026-08-26",
          paymentMethod: "",
          search: "",
        }}
        onFilterChange={onFilterChange}
        onApply={onApply}
        onExport={vi.fn()}
        isExporting={false}
        noRecords={false}
      />,
    );

    const search = screen.getByTestId("input-cmc-history-search");
    fireEvent.change(search, { target: { value: "CMC-123" } });
    fireEvent.blur(search);
    expect(onFilterChange).toHaveBeenCalledWith({ search: "CMC-123" });
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.keyDown(search, { key: "Enter" });
    expect(onApply).toHaveBeenCalledTimes(1);
  });
});
