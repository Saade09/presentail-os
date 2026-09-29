/**
 * Unit tests for the language-switching behaviour on the Settings page.
 *
 * The Radix UI Select primitive relies on browser APIs (pointer capture,
 * scrollIntoView, ResizeObserver portals) that jsdom does not implement.
 * We replace <Select*> components with plain HTML equivalents so the tests
 * can interact with the picker through standard fireEvent / userEvent calls
 * while still exercising the real handleLanguageChange logic and the real
 * i18n instance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { PropsWithChildren, OptionHTMLAttributes } from "react";
import i18n from "@/i18n";
import SettingsPage from "./Settings";

vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, disabled, children }: PropsWithChildren<{
    value?: string;
    onValueChange?: (v: string) => void;
    disabled?: boolean;
  }>) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children: _children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
    <option value="" hidden {...(props as OptionHTMLAttributes<HTMLOptionElement>)} />
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: PropsWithChildren) => <>{children}</>,
  SelectItem: ({ value, children }: PropsWithChildren<{ value: string }>) => (
    <option value={value}>{children}</option>
  ),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({ data: undefined, isLoading: false })),
  useMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useQueryClient: vi.fn(() => ({ setQueryData: vi.fn() })),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  getClerkToken: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/contexts/simulated-role-context", () => ({
  useSimulatedRole: () => ({ simulatedRole: null, setSimulatedRole: vi.fn() }),
}));

const mockUseWorkspaceRole = vi.fn();
vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => mockUseWorkspaceRole(),
}));

function renderSettings() {
  return render(<SettingsPage />);
}

describe("SettingsPage – language switcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseWorkspaceRole.mockReturnValue({
      role: "owner",
      isOwner: true,
      realRole: "owner",
    });
  });

  afterEach(async () => {
    await i18n.changeLanguage("en");
    localStorage.removeItem("i18nextLng");
  });

  it("selecting العربية changes i18n language to ar", async () => {
    renderSettings();
    const select = screen.getByTestId("language-select").closest("select")!;

    fireEvent.change(select, { target: { value: "ar" } });

    expect(i18n.language).toBe("ar");
  });

  it("selecting العربية sets document dir to rtl", async () => {
    renderSettings();
    const select = screen.getByTestId("language-select").closest("select")!;

    fireEvent.change(select, { target: { value: "ar" } });

    expect(document.documentElement.getAttribute("dir")).toBe("rtl");
  });

  it("selecting English after Arabic reverts i18n language to en and dir to ltr", async () => {
    await i18n.changeLanguage("ar");

    renderSettings();
    const select = screen.getByTestId("language-select").closest("select")!;

    fireEvent.change(select, { target: { value: "en" } });

    expect(i18n.language).toBe("en");
    expect(document.documentElement.getAttribute("dir")).toBe("ltr");
  });

  it("selecting العربية persists the preference to localStorage", () => {
    renderSettings();
    const select = screen.getByTestId("language-select").closest("select")!;

    fireEvent.change(select, { target: { value: "ar" } });

    expect(localStorage.getItem("i18nextLng")).toBe("ar");
  });

  it("selecting English persists the preference to localStorage", async () => {
    await i18n.changeLanguage("ar");

    renderSettings();
    const select = screen.getByTestId("language-select").closest("select")!;

    fireEvent.change(select, { target: { value: "en" } });

    expect(localStorage.getItem("i18nextLng")).toBe("en");
  });
});

/**
 * Initial-load tests
 *
 * i18n.ts reads localStorage and calls applyDirection at module import time
 * (not just on user interaction).  To exercise that path we must let the
 * module re-execute from scratch, which requires vi.resetModules() followed
 * by a fresh dynamic import of both @/i18n and Settings.
 *
 * Note: vi.mock() factories are hoisted and remain registered across
 * vi.resetModules(), so the Radix / react-query / etc. mocks still apply to
 * the freshly-imported modules.
 */
describe("SettingsPage – initial load from stored preference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseWorkspaceRole.mockReturnValue({
      role: "owner",
      isOwner: true,
      realRole: "owner",
    });
  });

  afterEach(() => {
    localStorage.removeItem("i18nextLng");
    document.documentElement.removeAttribute("dir");
    vi.resetModules();
  });

  it("shows العربية as selected and sets dir to rtl on mount when localStorage preference is ar", async () => {
    localStorage.setItem("i18nextLng", "ar");
    vi.resetModules();

    const i18nFresh = (await import("@/i18n")).default;
    const SettingsPageFresh = (await import("./Settings")).default;

    render(<SettingsPageFresh />);

    const select = screen.getByTestId("language-select").closest("select")!;
    expect(select.value).toBe("ar");
    expect(select.options[select.selectedIndex].text).toBe("العربية");
    expect(document.documentElement.getAttribute("dir")).toBe("rtl");

    await i18nFresh.changeLanguage("en");
  });

  it("shows English as selected and sets dir to ltr on mount when no preference is stored", async () => {
    localStorage.removeItem("i18nextLng");
    vi.resetModules();

    const i18nFresh = (await import("@/i18n")).default;
    const SettingsPageFresh = (await import("./Settings")).default;

    render(<SettingsPageFresh />);

    const select = screen.getByTestId("language-select").closest("select")!;
    expect(select.value).toBe("en");
    expect(document.documentElement.getAttribute("dir")).toBe("ltr");

    await i18nFresh.changeLanguage("en");
  });
});
