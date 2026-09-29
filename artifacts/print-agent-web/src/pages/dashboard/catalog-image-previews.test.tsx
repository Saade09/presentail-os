import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Shared mocks — must be at top level for vi.mock hoisting
// ---------------------------------------------------------------------------

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
  useSearch: () => "",
  useLocation: () => ["/stickers", vi.fn()],
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: true, role: "owner", allowedPages: null }),
}));

vi.mock("@/lib/nameWarning", () => ({
  checkNameWarning: () => ({ exactMatch: null, similarMatches: [] }),
}));

vi.mock("@/components/StaleDataBadge", () => ({
  StaleDataBadge: () => null,
}));

// ---------------------------------------------------------------------------
// Configurable React Query mock
// ---------------------------------------------------------------------------

type QueryFn = (opts: { queryKey: string[] }) => { data: unknown; isLoading: boolean };

let mockUseQuery: QueryFn = () => ({ data: undefined, isLoading: false });

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: string[] }) => mockUseQuery(opts),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Brands – image rendering
// ---------------------------------------------------------------------------

describe("Brands catalog page – image rendering", () => {
  beforeEach(() => {
    const brandsData = {
      brands: [
        {
          id: 42,
          name: "Acme",
          description: null,
          target_cogs: null,
          created_at: "2025-01-01",
          sticker_count: "3",
          product_count: "5",
          has_logo: true,
        },
        {
          id: 99,
          name: "No Logo Co",
          description: null,
          target_cogs: null,
          created_at: "2025-01-01",
          sticker_count: "0",
          product_count: "0",
          has_logo: false,
        },
      ],
      workspaceJobCount: 0,
    };
    mockUseQuery = ({ queryKey }) => {
      if (queryKey[0] === "brands") return { data: brandsData, isLoading: false };
      return { data: undefined, isLoading: false };
    };
  });

  it("renders brand logo via the dedicated /api/brands/:id/logo endpoint", async () => {
    const { default: BrandsPage } = await import("./Brands");
    render(<BrandsPage />);

    const logoImg = screen.getByRole("img", { name: "Acme" });
    expect(logoImg).toHaveAttribute("src", "/api/brands/42/logo");
  });

  it("does not use /api/storage for brand logo images", async () => {
    const { default: BrandsPage } = await import("./Brands");
    render(<BrandsPage />);

    const imgs = screen.getAllByRole("img");
    for (const img of imgs) {
      expect(img.getAttribute("src") ?? "").not.toContain("/api/storage");
    }
  });

  it("shows no logo image for brands without a logo", async () => {
    const { default: BrandsPage } = await import("./Brands");
    render(<BrandsPage />);

    const imgs = screen.getAllByRole("img");
    const imgSrcs = imgs.map((img) => img.getAttribute("src") ?? "");
    expect(imgSrcs.some((src) => src.includes("/api/brands/99/logo"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stickers – image rendering
// ---------------------------------------------------------------------------

describe("Stickers catalog page – image rendering", () => {
  beforeEach(() => {
    mockUseQuery = ({ queryKey }) => {
      if (queryKey[0] === "users")
        return { data: { members: [], me: { role: "owner", email: null } }, isLoading: false };
      if (queryKey[0] === "brands")
        return { data: { brands: [] }, isLoading: false };
      if (queryKey[0] === "stickers")
        return {
          data: {
            stickers: [
              {
                id: 7,
                name: "Birthday Label",
                file_name: "birthday.pdf",
                created_at: "2025-01-01",
                brand_id: null,
                brand_name: null,
              },
            ],
          },
          isLoading: false,
        };
      return { data: undefined, isLoading: false };
    };
  });

  it("renders custom stickers with a thumbnail <img> pointing to the thumbnail endpoint", async () => {
    const { default: StickersPage } = await import("./Stickers");
    render(<StickersPage />);

    const thumbnailImg = screen.queryByRole("img", { name: "Birthday Label" });
    expect(thumbnailImg).not.toBeNull();
    expect(thumbnailImg?.getAttribute("src")).toMatch(/^\/api\/stickers\/7\/thumbnail/);
  });

  it("does not render any /api/storage URL in the stickers list", async () => {
    const { default: StickersPage } = await import("./Stickers");
    const { container } = render(<StickersPage />);

    expect(container.innerHTML).not.toContain("/api/storage");
  });
});
