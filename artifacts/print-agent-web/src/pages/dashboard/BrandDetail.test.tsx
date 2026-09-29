import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BrandDetailPage from "./BrandDetail";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  useParams: () => ({ brandId: "42" }),
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  getClerkToken: vi.fn().mockResolvedValue("mock-token"),
  queryClient: { invalidateQueries: vi.fn() },
}));

const mockUseWorkspaceRole = vi.fn();
vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => mockUseWorkspaceRole(),
}));

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock("@dnd-kit/core", async () => {
  const React = await import("react");
  return {
    DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    closestCenter: vi.fn(),
    KeyboardSensor: vi.fn(),
    PointerSensor: vi.fn(),
    useSensor: vi.fn(),
    useSensors: vi.fn(() => []),
  };
});

vi.mock("@dnd-kit/sortable", async () => {
  const React = await import("react");
  return {
    SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    sortableKeyboardCoordinates: vi.fn(),
    useSortable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      transition: undefined,
      isDragging: false,
    }),
    verticalListSortingStrategy: "vertical",
    arrayMove: vi.fn((arr: unknown[]) => arr),
  };
});

vi.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: { toString: vi.fn(() => "") },
  },
}));

vi.mock("@/components/ui/tooltip", async () => {
  const React = await import("react");
  return {
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
      asChild ? <>{children}</> : <div>{children}</div>,
    TooltipContent: () => null,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock("recharts", async () => {
  const React = await import("react");
  return {
    ComposedChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Bar: () => null,
    Line: () => null,
    LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    PieChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Pie: () => null,
    Cell: () => null,
    BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: ({ children }: { children?: React.ReactNode }) => children ? <>{children}</> : null,
    ReferenceLine: () => null,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Legend: () => null,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogo(overrides: Partial<{
  id: number;
  brand_id: number;
  label: string | null;
  logo_mime: string;
  sort_order: number;
  created_at: string;
}> = {}) {
  return {
    id: 1,
    brand_id: 42,
    label: null,
    logo_mime: "image/png",
    sort_order: 0,
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

const noop = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };

function setupMocks({ meRole = "owner", logos = [makeLogo()] } = {}) {
  const isOwner = meRole === "owner";
  mockUseWorkspaceRole.mockReturnValue({
    isOwner,
    realIsOwner: isOwner,
    role: meRole,
    allowedPages: isOwner ? null : [],
    customRoleId: null,
    loaded: true,
  });
  mockUseMutation.mockReturnValue(noop);
  mockUseWorkspaceRole.mockReturnValue({
    isOwner: meRole === "owner",
    role: meRole,
    allowedPages: meRole === "owner" ? null : [],
    customRoleId: null,
    loaded: true,
  });
  mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
    const key = opts.queryKey[0];
    const subKey = opts.queryKey[2];
    if (key === "users") {
      return {
        data: { members: [], me: { role: meRole, email: "user@example.com" } },
        isLoading: false,
      };
    }
    if (key === "brands" && subKey === "logos") {
      return { data: { logos }, isLoading: false };
    }
    if (key === "brands" && subKey === undefined) {
      return {
        data: {
          brand: {
            id: 42,
            name: "Test Brand",
            description: null,
            target_cogs: null,
            created_at: "2024-01-01T00:00:00Z",
            sticker_count: "0",
            has_logo: true,
            has_card_message: false,
          },
        },
        isLoading: false,
      };
    }
    return { data: undefined, isLoading: false };
  });
}

function renderBrandDetail() {
  return render(<BrandDetailPage />);
}

// ---------------------------------------------------------------------------
// Tests: Download button render
// ---------------------------------------------------------------------------

describe("BrandDetailPage — Logo download button render", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a download button on each logo row when the user can manage (owner)", () => {
    const logo1 = makeLogo({ id: 1, label: "Primary" });
    const logo2 = makeLogo({ id: 2, label: "Dark mode" });
    setupMocks({ meRole: "owner", logos: [logo1, logo2] });

    renderBrandDetail();
    fireEvent.click(screen.getByRole("tab", { name: "Assets" }));

    const downloadButtons = screen.getAllByRole("button", { name: /download logo/i });
    expect(downloadButtons).toHaveLength(2);
  });

  it("renders a download button on each logo row when the user cannot manage (member)", () => {
    const logo1 = makeLogo({ id: 3, label: "Primary" });
    const logo2 = makeLogo({ id: 4, label: "Secondary" });
    setupMocks({ meRole: "member", logos: [logo1, logo2] });

    renderBrandDetail();
    fireEvent.click(screen.getByRole("tab", { name: "Assets" }));

    const downloadButtons = screen.getAllByRole("button", { name: /download logo/i });
    expect(downloadButtons).toHaveLength(2);
  });

  it("renders a download button for a single logo row regardless of canManage", () => {
    const logo = makeLogo({ id: 5, label: "Only logo" });

    for (const role of ["owner", "member", "designer"] as const) {
      vi.clearAllMocks();
      setupMocks({ meRole: role, logos: [logo] });

      const { unmount } = renderBrandDetail();
      fireEvent.click(screen.getByRole("tab", { name: "Assets" }));
      expect(screen.getAllByRole("button", { name: /download logo/i })).toHaveLength(1);
      unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Download button click behaviour
// ---------------------------------------------------------------------------

describe("BrandDetailPage — Logo download button click", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches the correct image URL and triggers a file download when the download button is clicked", async () => {
    const logo = makeLogo({ id: 7, label: "my-logo", logo_mime: "image/png" });
    setupMocks({ meRole: "owner", logos: [logo] });

    const fakeBlob = new Blob(["img"], { type: "image/png" });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(fakeBlob),
    } as unknown as Response);
    global.fetch = mockFetch;

    renderBrandDetail();
    fireEvent.click(screen.getByRole("tab", { name: "Assets" }));

    const createObjectURLSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://localhost/fake-url");
    const revokeObjectURLSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const clickSpy = vi.fn();
    const fakeAnchor = { href: "", download: "", click: clickSpy, remove: vi.fn() } as unknown as HTMLAnchorElement;
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "a") return fakeAnchor;
      return originalCreateElement(tag) as HTMLElement;
    }) as unknown as typeof document.createElement;
    const appendChildSpy = vi.spyOn(document.body, "appendChild").mockReturnValue(fakeAnchor as unknown as Node);

    const downloadBtn = screen.getByRole("button", { name: /download logo/i });
    fireEvent.click(downloadBtn);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/brands/42/logos/7/image",
        expect.any(Object),
      );
    });

    await waitFor(() => {
      expect(createObjectURLSpy).toHaveBeenCalledWith(fakeBlob);
      expect(fakeAnchor.href).toBe("blob:http://localhost/fake-url");
      expect(fakeAnchor.download).toBe("test-brand-my-logo-logo.png");
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:http://localhost/fake-url");
    });

    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
    (createElementSpy as ReturnType<typeof vi.spyOn>).mockRestore();
    appendChildSpy.mockRestore();
  });

  it("shows a destructive toast when the fetch fails", async () => {
    const logo = makeLogo({ id: 8, label: "bad-logo" });
    setupMocks({ meRole: "owner", logos: [logo] });

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      blob: () => Promise.resolve(new Blob()),
    } as unknown as Response);

    renderBrandDetail();
    fireEvent.click(screen.getByRole("tab", { name: "Assets" }));

    const downloadBtn = screen.getByRole("button", { name: /download logo/i });
    fireEvent.click(downloadBtn);

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Download failed",
          variant: "destructive",
        }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Product image link
// ---------------------------------------------------------------------------

describe("BrandDetailPage — product image link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupWithProducts(products: Array<{ id: number; name: string; main_image_url: string | null }>) {
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: true,
      role: "owner",
      allowedPages: null,
      customRoleId: null,
      loaded: true,
    });
    mockUseMutation.mockReturnValue(noop);
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      const key = opts.queryKey[0];
      const subKey = opts.queryKey[2];
      if (key === "users") {
        return { data: { members: [], me: { role: "owner", email: "user@example.com" } }, isLoading: false };
      }
      if (key === "brands" && subKey === "logos") {
        return { data: { logos: [] }, isLoading: false };
      }
      if (key === "brands" && subKey === undefined) {
        return {
          data: {
            brand: {
              id: 42,
              name: "Test Brand",
              description: null,
              target_cogs: null,
              created_at: "2024-01-01T00:00:00Z",
              sticker_count: "0",
              has_logo: false,
              has_card_message: false,
            },
          },
          isLoading: false,
        };
      }
      if (key === "products") {
        return {
          data: {
            products: products.map((p) => ({
              ...p,
              price_usd: null,
              price_aed: null,
              status: "available",
              category: null,
              additional_image_urls: [],
            })),
          },
          isLoading: false,
        };
      }
      return { data: undefined, isLoading: false };
    });
  }

  it("wraps the main product thumbnail in a link to /products/{id} opening in a new tab", () => {
    setupWithProducts([{ id: 77, name: "Cool Mug", main_image_url: "/images/mug.png" }]);

    renderBrandDetail();

    const img = screen.getByAltText("Cool Mug");
    const link = img.closest("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/products/77");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("wraps the main thumbnail in a link even when there is no image (icon fallback)", () => {
    setupWithProducts([{ id: 88, name: "No Image Product", main_image_url: null }]);

    renderBrandDetail();

    const productLinks = screen
      .getAllByRole("link")
      .filter((el) => el.getAttribute("href") === "/products/88");
    expect(productLinks.length).toBeGreaterThanOrEqual(2);
  });

  it("does not link additional thumbnail images", () => {
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: true,
      role: "owner",
      allowedPages: null,
      customRoleId: null,
      loaded: true,
    });
    mockUseMutation.mockReturnValue(noop);
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      const key = opts.queryKey[0];
      const subKey = opts.queryKey[2];
      if (key === "users") {
        return { data: { members: [], me: { role: "owner", email: "user@example.com" } }, isLoading: false };
      }
      if (key === "brands" && subKey === "logos") {
        return { data: { logos: [] }, isLoading: false };
      }
      if (key === "brands" && subKey === undefined) {
        return {
          data: {
            brand: {
              id: 42,
              name: "Test Brand",
              description: null,
              target_cogs: null,
              created_at: "2024-01-01T00:00:00Z",
              sticker_count: "0",
              has_logo: false,
              has_card_message: false,
            },
          },
          isLoading: false,
        };
      }
      if (key === "products") {
        return {
          data: {
            products: [
              {
                id: 99,
                name: "Multi Image",
                main_image_url: "/images/main.png",
                price_usd: null,
                price_aed: null,
                status: "available",
                category: null,
                additional_image_urls: ["/images/extra1.png", "/images/extra2.png"],
              },
            ],
          },
          isLoading: false,
        };
      }
      return { data: undefined, isLoading: false };
    });

    renderBrandDetail();

    const allLinks = screen.getAllByRole("link").filter((el) => el.getAttribute("href") === "/products/99");
    const imgLinks = allLinks.filter((el) => el.tagName.toLowerCase() === "a");
    const additionalImgLinks = imgLinks.filter((el) => {
      const imgs = el.querySelectorAll("img");
      return imgs.length > 0 && Array.from(imgs).some((img) => img.getAttribute("src")?.includes("extra"));
    });
    expect(additionalImgLinks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: canManage flag driven by brands.manage allowedPage
// ---------------------------------------------------------------------------

describe("BrandDetailPage — canManage derived from brands.manage permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupWithAllowedPages(allowedPages: string[]) {
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: false,
      role: "member",
      allowedPages,
      customRoleId: 42,
      loaded: true,
    });
    mockUseMutation.mockReturnValue(noop);
    const logo = makeLogo({ id: 99 });
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      const key = opts.queryKey[0];
      const subKey = opts.queryKey[2];
      if (key === "brands" && subKey === "logos") {
        return { data: { logos: [logo] }, isLoading: false };
      }
      if (key === "brands" && subKey === undefined) {
        return {
          data: {
            brand: {
              id: 42,
              name: "Test Brand",
              description: null,
              target_cogs: null,
              created_at: "2024-01-01T00:00:00Z",
              sticker_count: "0",
              has_logo: true,
              has_card_message: false,
            },
          },
          isLoading: false,
        };
      }
      return { data: undefined, isLoading: false };
    });
  }

  it("shows edit controls (canManage=true) when allowedPages includes brands.manage", () => {
    setupWithAllowedPages(["brands", "brands.manage"]);

    renderBrandDetail();
    fireEvent.click(screen.getByRole("tab", { name: "Assets" }));

    expect(screen.queryByTitle("Drag to reorder")).not.toBeNull();
  });

  it("hides edit controls (canManage=false) when allowedPages does not include brands.manage", () => {
    setupWithAllowedPages(["brands", "brands.edit"]);

    renderBrandDetail();
    fireEvent.click(screen.getByRole("tab", { name: "Assets" }));

    expect(screen.queryByTitle("Drag to reorder")).toBeNull();
  });

  it("hides edit controls (canManage=false) when allowedPages is empty", () => {
    setupWithAllowedPages([]);

    renderBrandDetail();
    fireEvent.click(screen.getByRole("tab", { name: "Assets" }));

    expect(screen.queryByTitle("Drag to reorder")).toBeNull();
  });

  it("shows edit controls (canManage=true) for an owner even without brands.manage in allowedPages", () => {
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: true,
      role: "owner",
      allowedPages: null,
      customRoleId: null,
      loaded: true,
    });
    mockUseMutation.mockReturnValue(noop);
    const logo = makeLogo({ id: 100 });
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      const key = opts.queryKey[0];
      const subKey = opts.queryKey[2];
      if (key === "brands" && subKey === "logos") {
        return { data: { logos: [logo] }, isLoading: false };
      }
      if (key === "brands" && subKey === undefined) {
        return {
          data: {
            brand: {
              id: 42,
              name: "Owner Brand",
              description: null,
              target_cogs: null,
              created_at: "2024-01-01T00:00:00Z",
              sticker_count: "0",
              has_logo: true,
              has_card_message: false,
            },
          },
          isLoading: false,
        };
      }
      return { data: undefined, isLoading: false };
    });

    renderBrandDetail();
    fireEvent.click(screen.getByRole("tab", { name: "Assets" }));

    expect(screen.queryByTitle("Drag to reorder")).not.toBeNull();
  });
});
