import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import {
  DateRangePicker,
  detectDateRangePreset,
  formatDateRangeLabel,
  getPickerStartMonth,
  getPresetDates,
  todayInTimezone,
} from "./date-range-picker";

const mobileState = vi.hoisted(() => ({ value: false }));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mobileState.value,
}));

afterEach(() => {
  mobileState.value = false;
});

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe("date-range timezone and preset helpers", () => {
  const now = new Date("2026-08-26T21:30:00.000Z");

  it("resolves today in the configured timezone rather than browser time", () => {
    expect(todayInTimezone("Asia/Beirut", now)).toBe("2026-08-27");
    expect(todayInTimezone("America/New_York", now)).toBe("2026-08-26");
  });

  it("resolves week-to-date using the configured first weekday", () => {
    expect(getPresetDates("this_week", {
      timezone: "Asia/Beirut",
      weekStartsOn: 1,
      now,
    })).toEqual({ from: "2026-08-24", to: "2026-08-27" });
    expect(getPresetDates("this_week", {
      timezone: "Asia/Beirut",
      weekStartsOn: 0,
      now,
    })).toEqual({ from: "2026-08-23", to: "2026-08-27" });
  });

  it("defaults week-to-date to Sunday while preserving explicit overrides", () => {
    expect(getPresetDates("this_week", {
      timezone: "Asia/Beirut",
      now,
    })).toEqual({ from: "2026-08-23", to: "2026-08-27" });
    expect(getPresetDates("this_week", {
      timezone: "Asia/Beirut",
      weekStartsOn: 1,
      now,
    })).toEqual({ from: "2026-08-24", to: "2026-08-27" });
  });

  it("anchors a two-month view to the range end or today", () => {
    expect(getPickerStartMonth(
      { from: "2026-06-20", to: "2026-08-05" },
      { timezone: "UTC", now },
    )).toEqual(new Date(2026, 6, 1));
    expect(getPickerStartMonth(
      { from: "2026-06-20" },
      { timezone: "Asia/Beirut", now },
    )).toEqual(new Date(2026, 6, 1));
  });

  it("resolves month-to-date and the full previous month across year boundaries", () => {
    expect(getPresetDates("this_month", {
      timezone: "UTC",
      now: new Date("2027-01-05T12:00:00.000Z"),
    })).toEqual({ from: "2027-01-01", to: "2027-01-05" });
    expect(getPresetDates("last_month", {
      timezone: "UTC",
      now: new Date("2027-01-05T12:00:00.000Z"),
    })).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("highlights a preset only for an exact range match", () => {
    expect(detectDateRangePreset(
      { from: "2026-08-01", to: "2026-08-27" },
      { timezone: "Asia/Beirut", now },
    )).toBe("this_month");
    expect(detectDateRangePreset(
      { from: "2026-08-01", to: "2026-08-26" },
      { timezone: "Asia/Beirut", now },
    )).toBe("custom");
  });

  it("formats same-day, same-year, and cross-year ranges without numeric ambiguity", () => {
    expect(formatDateRangeLabel({ from: "2026-08-26", to: "2026-08-26" }, "en-US"))
      .toBe("Aug 26, 2026");
    expect(formatDateRangeLabel({ from: "2026-08-01", to: "2026-08-26" }, "en-US"))
      .toBe("Aug 1 – Aug 26, 2026");
    expect(formatDateRangeLabel({ from: "2026-12-20", to: "2027-01-05" }, "en-US"))
      .toBe("Dec 20, 2026 – Jan 5, 2027");
  });
});

describe("DateRangePicker explicit apply mode", () => {
  it("keeps preset changes pending until Apply", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(
      <DateRangePicker
        value={{ from: "2026-08-01", to: "2026-08-10" }}
        onApply={onApply}
        timezone="UTC"
        allowClear={false}
        data-testid="range-trigger"
      />,
    );

    await user.click(screen.getByTestId("range-trigger"));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /^Today$/ }));
    expect(onApply).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^Apply$/ }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(getPresetDates("today", { timezone: "UTC" }));
  });

  it("renders the compact desktop presentation only when opted in", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const { unmount } = render(
      <DateRangePicker
        value={{ from: "2026-08-01", to: "2026-08-10" }}
        onApply={onApply}
        timezone="UTC"
        allowClear={false}
        data-testid="compact-range-trigger"
        compact
      />,
    );

    await user.click(screen.getByTestId("compact-range-trigger"));
    expect(screen.queryByTestId("date-range-picker-header")).not.toBeInTheDocument();
    expect(screen.queryByTestId("date-range-picker-fields")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".rdp-month")).toHaveLength(2);
    expect(Array.from(document.querySelectorAll(".rdp-caption_label")).map((node) => node.textContent))
      .toEqual(["July 2026", "August 2026"]);
    expect(Array.from(document.querySelectorAll(".rdp-month")).map((month) =>
      Array.from(month.querySelectorAll(".rdp-weekday")).map((day) => day.textContent),
    )).toEqual([
      ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"],
      ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"],
    ]);
    expect(screen.getByTestId("button-date-preset-custom")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("button-date-preset-custom").querySelector("svg")).toBeNull();
    expect(screen.queryByTestId("button-date-range-clear")).not.toBeInTheDocument();
    expect(screen.getByTestId("date-range-picker-selected-range")).toHaveTextContent("Aug 1 – Aug 10, 2026");
    await user.click(screen.getByTestId("button-date-preset-today"));
    expect(onApply).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("button-date-range-apply"));
    expect(onApply).toHaveBeenCalledWith(getPresetDates("today", { timezone: "UTC" }));

    unmount();
    render(
      <DateRangePicker
        value={{ from: "2026-08-01", to: "2026-08-10" }}
        onApply={vi.fn()}
        timezone="UTC"
        allowClear={false}
        data-testid="default-range-trigger"
      />,
    );
    await user.click(screen.getByTestId("default-range-trigger"));
    expect(screen.getByTestId("date-range-picker-header")).toBeInTheDocument();
    expect(screen.getByTestId("date-range-picker-fields")).toBeInTheDocument();
  });

  it("re-anchors presets while keeping custom calendar navigation in place", async () => {
    const user = userEvent.setup();
    render(
      <DateRangePicker
        value={{ from: "2026-08-01", to: "2026-08-10" }}
        onApply={vi.fn()}
        timezone="UTC"
        allowClear={false}
        data-testid="navigation-range-trigger"
        compact
      />,
    );

    await user.click(screen.getByTestId("navigation-range-trigger"));
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(Array.from(document.querySelectorAll(".rdp-caption_label")).map((node) => node.textContent))
      .toEqual(["August 2026", "September 2026"]);

    await user.click(screen.getByTestId("button-date-preset-custom"));
    expect(Array.from(document.querySelectorAll(".rdp-caption_label")).map((node) => node.textContent))
      .toEqual(["August 2026", "September 2026"]);

    await user.click(screen.getByTestId("button-date-preset-last_month"));
    const lastMonth = getPresetDates("last_month", { timezone: "UTC" });
    const expectedLeft = getPickerStartMonth(lastMonth, { timezone: "UTC" });
    const expectedCaptions = [expectedLeft, new Date(expectedLeft.getFullYear(), expectedLeft.getMonth() + 1, 1)]
      .map((date) => date.toLocaleDateString("en-US", { month: "long", year: "numeric" }));
    expect(Array.from(document.querySelectorAll(".rdp-caption_label")).map((node) => node.textContent))
      .toEqual(expectedCaptions);
  });

  it("keeps cross-month ranges on real month days and disables duplicate fillers", async () => {
    const user = userEvent.setup();
    render(
      <DateRangePicker
        value={{ from: "2026-07-20", to: "2026-08-05" }}
        onApply={vi.fn()}
        timezone="UTC"
        allowClear={false}
        data-testid="cross-month-range-trigger"
        compact
      />,
    );

    await user.click(screen.getByTestId("cross-month-range-trigger"));
    expect(screen.getByTestId("button-calendar-day-2026-07-20")).toHaveAttribute("data-range-start", "true");
    expect(screen.getByTestId("button-calendar-day-2026-08-05")).toHaveAttribute("data-range-end", "true");

    const duplicateDates = screen.getAllByTestId("button-calendar-day-2026-07-27");
    const filler = duplicateDates.find((button) => button.getAttribute("data-outside") === "true");
    const inMonth = duplicateDates.find((button) => button.getAttribute("data-outside") === "false");
    expect(filler).toBeDisabled();
    expect(filler).toHaveAttribute("data-range-middle", "false");
    expect(inMonth).not.toBeDisabled();
    expect(inMonth).toHaveAttribute("data-range-middle", "true");
  });

  it("keeps compact mode on the accessible one-month mobile sheet", async () => {
    mobileState.value = true;
    const user = userEvent.setup();
    const { unmount } = render(
      <DateRangePicker
        value={{ from: "2026-08-01", to: "2026-08-10" }}
        onApply={vi.fn()}
        allowClear={false}
        data-testid="compact-mobile-trigger"
        compact
      />,
    );

    await user.click(screen.getByTestId("compact-mobile-trigger"));
    expect(screen.getByTestId("date-range-picker-header")).toBeInTheDocument();
    expect(screen.getByTestId("date-range-picker-fields")).toBeInTheDocument();
    expect(document.querySelectorAll(".rdp-month")).toHaveLength(1);

    unmount();
    mobileState.value = false;
  });

  it("discards pending changes on Cancel and Escape", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const onCancel = vi.fn();
    render(
      <DateRangePicker
        value={{ from: "2026-08-01", to: "2026-08-10" }}
        onApply={onApply}
        onCancel={onCancel}
        timezone="UTC"
        allowClear={false}
        data-testid="range-trigger"
      />,
    );

    await user.click(screen.getByTestId("range-trigger"));
    await user.click(screen.getByRole("button", { name: /^Yesterday$/ }));
    await user.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(onApply).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("range-trigger"));
    await user.click(screen.getByRole("button", { name: /^Today$/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onApply).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();

    await user.click(screen.getByTestId("range-trigger"));
    await user.click(screen.getByRole("button", { name: /^Yesterday$/ }));
    await user.click(document.body);
    expect(onApply).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(3);
  });

  it("uses a one-month bottom drawer on mobile", async () => {
    mobileState.value = true;
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    const user = userEvent.setup();
    const { container, unmount } = render(
      <DateRangePicker
        value={{ from: "2026-08-01", to: "2026-08-10" }}
        onApply={vi.fn()}
        allowClear={false}
        data-testid="mobile-range-trigger"
      />,
    );

    await user.click(screen.getByTestId("mobile-range-trigger"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(document.querySelectorAll(".rdp-month")).toHaveLength(1);

    unmount();
    mobileState.value = false;
    expect(container).toBeEmptyDOMElement();
  });

  it("announces selected date states in Arabic when Arabic is active", async () => {
    await i18n.changeLanguage("ar");
    const today = todayInTimezone("UTC");
    const user = userEvent.setup();
    render(
      <DateRangePicker
        value={{ from: today, to: today }}
        onApply={vi.fn()}
        timezone="UTC"
        allowClear={false}
        data-testid="arabic-range-trigger"
      />,
    );

    await user.click(screen.getByTestId("arabic-range-trigger"));
    const selectedDay = screen.getByTestId(`button-calendar-day-${today}`);
    expect(selectedDay).toHaveAttribute("aria-label", expect.stringContaining("بداية النطاق المحدد"));
    expect(selectedDay).toHaveAttribute("aria-label", expect.stringContaining("نهاية النطاق المحدد"));
    await i18n.changeLanguage("en");
  });
});