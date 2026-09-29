import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BrandDetailPage from "./BrandDetail";

// ---------------------------------------------------------------------------
// Module-level mocks (mirrors BrandDetail.test.tsx)
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  useParams: () => ({ brandId: "42" }),
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({
    isOwner: true,
    realIsOwner: true,
    role: "owner",
    allowedPages: null,
    customRoleId: null,
    loaded: true,
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
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
  CSS: { Transform: { toString: vi.fn(() => "") } },
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

const noop = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };

function setupMocks({
  brandName = "Test Brand",
  coverPhotos = [] as { id: number; brand_id: number; label: string; photo_mime: string; created_at: string }[],
} = {}) {
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
    if (key === "brands" && subKey === "cover-photos") {
      return { data: { coverPhotos }, isLoading: false };
    }
    if (key === "brands" && subKey === undefined) {
      return {
        data: {
          brand: {
            id: 42,
            name: brandName,
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
    if (key === "channels") {
      return { data: { channels: [] }, isLoading: false };
    }
    return { data: undefined, isLoading: false };
  });
}

// ---------------------------------------------------------------------------
// Tests: cover photo download filename sanitisation
// ---------------------------------------------------------------------------

describe("BrandDetailPage — cover photo download filename sanitisation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("strips OS-unsafe characters from the channel name in the channel-resized download filename", async () => {
    const coverPhoto = {
      id: 2,
      brand_id: 42,
      label: "Cover Photo",
      photo_mime: "image/jpeg",
      created_at: "2024-01-01T00:00:00Z",
    };

    const channel = {
      id: 7,
      name: "E-commerce: Web/Mobile?",
      has_logo: false,
      has_cover_photo: true,
      cover_photo_width: 800,
      cover_photo_height: 600,
      created_at: "2024-01-01T00:00:00Z",
    };

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
      if (key === "brands" && subKey === "cover-photos") {
        return { data: { coverPhotos: [coverPhoto] }, isLoading: false };
      }
      if (key === "brands" && subKey === undefined) {
        return {
          data: {
            brand: {
              id: 42,
              name: "My Brand",
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
      if (key === "channels") {
        return { data: { channels: [channel] }, isLoading: false };
      }
      return { data: undefined, isLoading: false };
    });

    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(new Blob(["data"], { type: "image/jpeg" }), { status: 200 }),
    );

    const resizedBlob = new Blob(["resized"], { type: "image/jpeg" });
    const mockCtx = { drawImage: vi.fn() };
    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => mockCtx),
      toBlob: vi.fn((cb: BlobCallback) => cb(resizedBlob)),
    };

    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string, ...rest: unknown[]) => {
      if (tag === "canvas") return mockCanvas as unknown as HTMLCanvasElement;
      return originalCreateElement(tag, ...(rest as [ElementCreationOptions?]));
    });

    vi.stubGlobal(
      "Image",
      class {
        onload?: () => void;
        onerror?: () => void;
        set src(_: string) {
          this.onload?.();
        }
      },
    );

    const appendSpy = vi.spyOn(document.body, "appendChild");

    render(<BrandDetailPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Assets" }));

    const photoImg = screen.getByAltText("Cover Photo");
    fireEvent.click(photoImg);

    const channelBtn = await screen.findByRole("button", { name: /e-commerce/i });
    fireEvent.click(channelBtn);

    await waitFor(() => {
      expect(
        appendSpy.mock.calls.some(([node]) => (node as Element).tagName === "A"),
      ).toBe(true);
    });

    const anchor = appendSpy.mock.calls.find(
      ([node]) => (node as Element).tagName === "A",
    )![0] as HTMLAnchorElement;

    expect(anchor.download).not.toMatch(/[/\\:*?"<>|]/);
    expect(anchor.download).toBe("my-brand-cover-photo-e-commerce-webmobile-800x600.jpg");
  });

  it("strips OS-unsafe characters from the brand name and photo label in the download filename", async () => {
    const coverPhoto = {
      id: 1,
      brand_id: 42,
      label: "Summer: Campaign?",
      photo_mime: "image/jpeg",
      created_at: "2024-01-01T00:00:00Z",
    };

    setupMocks({
      brandName: "Acme/Corp: My<Brand>",
      coverPhotos: [coverPhoto],
    });

    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(new Blob(["data"], { type: "image/jpeg" }), { status: 200 }),
    );

    const appendSpy = vi.spyOn(document.body, "appendChild");

    render(<BrandDetailPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Assets" }));

    const photoImg = screen.getByAltText("Summer: Campaign?");
    fireEvent.click(photoImg);

    const downloadBtn = await screen.findByRole("button", { name: /download original/i });
    fireEvent.click(downloadBtn);

    await waitFor(() =>
      appendSpy.mock.calls.some(([node]) => (node as Element).tagName === "A"),
    );

    const anchor = appendSpy.mock.calls.find(
      ([node]) => (node as Element).tagName === "A",
    )![0] as HTMLAnchorElement;

    expect(anchor.download).not.toMatch(/[/\\:*?"<>|]/);
    expect(anchor.download).toBe("acmecorp-mybrand-summer-campaign.jpg");
  });
});
