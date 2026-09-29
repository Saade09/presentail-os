import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SortableLogoItem } from "./BrandDetail";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  sortableKeyboardCoordinates: {},
  verticalListSortingStrategy: {},
  arrayMove: vi.fn(),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: { toString: () => "" },
  },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultLogo = {
  id: 42,
  brand_id: 7,
  label: "Primary Logo",
  logo_mime: "image/png",
  sort_order: 0,
  created_at: "2024-01-01T00:00:00Z",
};

const defaultProps = {
  logo: defaultLogo,
  idx: 0,
  isFirst: true,
  isOnlyOne: false,
  canManage: true,
  brandId: 7,
  editingLogoLabelId: null,
  editingLogoLabelValue: "",
  setEditingLogoLabelId: vi.fn(),
  setEditingLogoLabelValue: vi.fn(),
  onSaveLabel: vi.fn(),
  onDelete: vi.fn(),
  isSavingLabel: false,
  isDeleting: false,
  brandName: "Acme Co",
};

function getDownloadButton() {
  return screen.getByRole("button", { name: "Download logo" });
}

// ---------------------------------------------------------------------------
// Tests: logo download loading state
// ---------------------------------------------------------------------------

describe("SortableLogoItem — download button loading state", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:mock-url"),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows spinner and disables the button while fetching, then restores the Download icon on success", async () => {
    let resolveFetch!: (v: Response) => void;
    vi.spyOn(global, "fetch").mockReturnValue(
      new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );

    render(<SortableLogoItem {...defaultProps} />);
    const button = getDownloadButton();

    // Idle state: enabled, shows Download icon, no spinner
    expect(button).not.toBeDisabled();
    expect(button.querySelector(".lucide-download")).toBeInTheDocument();
    expect(button.querySelector(".animate-spin")).not.toBeInTheDocument();

    fireEvent.click(button);

    // Loading state: disabled, shows spinner, no Download icon
    expect(button).toBeDisabled();
    expect(button.querySelector(".animate-spin")).toBeInTheDocument();
    expect(button.querySelector(".lucide-download")).not.toBeInTheDocument();

    // Resolve the fetch and confirm the button returns to its normal state
    resolveFetch(new Response(new Blob(["data"], { type: "image/png" }), { status: 200 }));

    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button.querySelector(".animate-spin")).not.toBeInTheDocument();
    expect(button.querySelector(".lucide-download")).toBeInTheDocument();
  });

  it("sanitises special characters in the brand name so the download filename is OS-safe", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(new Blob(["data"], { type: "image/png" }), { status: 200 }),
    );

    const appendSpy = vi.spyOn(document.body, "appendChild");

    render(
      <SortableLogoItem
        {...defaultProps}
        brandName="Acme/Corp: My<Best>Brand?"
        logo={{ ...defaultLogo, label: "Main Logo" }}
      />,
    );

    fireEvent.click(getDownloadButton());

    await waitFor(() =>
      appendSpy.mock.calls.some(([node]) => (node as Element).tagName === "A"),
    );

    const anchor = appendSpy.mock.calls.find(
      ([node]) => (node as Element).tagName === "A",
    )![0] as HTMLAnchorElement;
    expect(anchor.download).toMatch(/^acmecorp-mybestbrand-main-logo-logo\./);
  });

  it("restores the Download icon and re-enables the button when the fetch rejects (network error)", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("Network error"));

    render(<SortableLogoItem {...defaultProps} />);
    const button = getDownloadButton();

    fireEvent.click(button);

    // Loading state: disabled with spinner
    expect(button).toBeDisabled();
    expect(button.querySelector(".animate-spin")).toBeInTheDocument();
    expect(button.querySelector(".lucide-download")).not.toBeInTheDocument();

    // After rejection: button recovers, Download icon is back
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button.querySelector(".animate-spin")).not.toBeInTheDocument();
    expect(button.querySelector(".lucide-download")).toBeInTheDocument();
  });
});
