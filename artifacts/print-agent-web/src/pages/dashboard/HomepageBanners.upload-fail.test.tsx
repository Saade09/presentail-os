import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import HomepageBannersPage from "./HomepageBanners";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

const mockUploadFile = vi.fn();
vi.mock("@workspace/object-storage-web", () => ({
  useUpload: vi.fn(() => ({
    uploadFile: mockUploadFile,
    isUploading: false,
  })),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  queryClient: { invalidateQueries: vi.fn() },
  getClerkToken: vi.fn().mockResolvedValue("mock-token"),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({ data: undefined, isLoading: false, error: null })),
  useMutation: vi.fn(() => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
  })),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

vi.mock("@workspace/api-client-react", () => ({
  useListOccasions: vi.fn(() => ({ data: undefined, isLoading: false })),
  useListCatalogCategories: vi.fn(() => ({ data: undefined, isLoading: false })),
  getListOccasionsQueryKey: vi.fn(() => ["occasions"]),
  getListCatalogCategoriesQueryKey: vi.fn(() => ["catalog-categories"]),
}));

vi.mock("@/lib/countries", () => ({
  findCountryByName: vi.fn(() => ({ name: "United Arab Emirates", code: "AE" })),
  findCountryByCode: vi.fn(() => ({ name: "United Arab Emirates", code: "AE" })),
}));

vi.mock("@/components/FlagImage", () => ({
  FlagImage: () => null,
}));

vi.mock("wouter", () => ({
  useSearch: () => "",
  useLocation: () => ["/dashboard/homepage-banners", vi.fn()],
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderPage() {
  return render(<HomepageBannersPage />);
}

function makeImageFile(name = "banner.jpg") {
  return new File(["content"], name, { type: "image/jpeg" });
}

/**
 * Open the New Banner dialog and return the dialog element rendered via the
 * Radix portal (always appended to document.body).
 */
async function openDialog() {
  fireEvent.click(screen.getByTestId("button-new-banner"));
  await waitFor(() => screen.getByRole("dialog"));
  return screen.getByRole("dialog");
}

/**
 * Enable the desktop SideEditor. The dialog has 4 switches:
 *   0: is_global (Targeting)
 *   1: desktop-enabled (Desktop SideEditor)
 *   2: mobile-enabled (Mobile SideEditor)
 *   3: is_active (Schedule)
 * Clicking index 1 sets desktop.enabled = true, revealing the file inputs.
 */
function enableDesktopSide(dialog: HTMLElement) {
  const switches = within(dialog).getAllByRole("switch");
  fireEvent.click(switches[1]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HomepageBanners – upload failure shows destructive toast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUploadFile.mockResolvedValue(null);
  });

  it("shows a destructive toast when uploadFile returns null (upload failed)", async () => {
    renderPage();
    const dialog = await openDialog();
    enableDesktopSide(dialog);

    const hiddenFileInput = dialog.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(hiddenFileInput).toBeTruthy();

    fireEvent.change(hiddenFileInput, { target: { files: [makeImageFile()] } });

    await waitFor(() => {
      expect(mockUploadFile).toHaveBeenCalledOnce();
    });

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive" }),
      );
    });
  });

  it("shows an 'Upload failed' destructive toast title when upload returns null", async () => {
    renderPage();
    const dialog = await openDialog();
    enableDesktopSide(dialog);

    const hiddenFileInput = dialog.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(hiddenFileInput).toBeTruthy();

    fireEvent.change(hiddenFileInput, { target: { files: [makeImageFile()] } });

    await waitFor(() => {
      const call = mockToast.mock.calls.find(
        ([args]) =>
          args?.title === "Upload failed" && args?.variant === "destructive",
      );
      expect(call).toBeDefined();
    });
  });

  it("does NOT update the media_url input when upload fails", async () => {
    renderPage();
    const dialog = await openDialog();
    enableDesktopSide(dialog);

    const hiddenFileInput = dialog.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    fireEvent.change(hiddenFileInput, { target: { files: [makeImageFile()] } });

    await waitFor(() => expect(mockUploadFile).toHaveBeenCalledOnce());

    const urlInputs = within(dialog).getAllByPlaceholderText("/storage/objects/…");
    expect(urlInputs[0]).toHaveValue("");
  });
});
