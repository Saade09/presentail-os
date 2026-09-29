import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import BaseItemsPage from "./BaseItems";
import { apiFetch } from "@/lib/queryClient";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[] }) => mockUseQuery(opts),
  useMutation: (opts: unknown) => mockUseMutation(opts),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  queryClient: { invalidateQueries: vi.fn() },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: true, allowedPages: null }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<{
  id: number;
  name: string;
  code: string;
  image_url: string | null;
  category_id: number | null;
  main_category_name: string | null;
  sub_category_name: string | null;
  created_at: string;
}> = {}) {
  return {
    id: 1,
    name: "Red Roses",
    code: "BI-001",
    image_url: null,
    category_id: null,
    main_category_name: null,
    sub_category_name: null,
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

function setupMocks({
  items = [] as ReturnType<typeof makeItem>[],
} = {}) {
  mockUseMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
    const key = opts.queryKey[0];
    if (key === "base-items") return { data: { items }, isLoading: false };
    if (key === "base-item-categories") return { data: { categories: [] }, isLoading: false };
    if (key === "base-items-check-name") {
      const name = (opts.queryKey[1] as string | undefined) ?? "";
      if (!name) return { data: undefined, isLoading: false };
      const lower = name.toLowerCase();
      let exactMatch: string | null = null;
      const similarMatches: string[] = [];
      for (const item of items) {
        const itemLower = item.name.toLowerCase();
        if (itemLower === lower) exactMatch = item.name;
        else if (itemLower.includes(lower) || lower.includes(itemLower)) similarMatches.push(item.name);
      }
      return { data: { exactMatch, similarMatches }, isLoading: false };
    }
    return { data: undefined, isLoading: false };
  });
}

function renderPage() {
  return render(<BaseItemsPage />);
}

// ---------------------------------------------------------------------------
// Component integration test: name duplicate warning in the create form
// ---------------------------------------------------------------------------

// The create dialog debounces name input by 300 ms. We use fake timers
// (setTimeout only) and `await act(async () => { vi.advanceTimersByTime(...) })`
// so React flushes all pending state updates triggered by the timer inside
// a single async act — no waitFor needed.
describe("BaseItemsPage – name duplicate warning in create form", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.clearAllMocks();
    setupMocks({
      items: [makeItem({ id: 1, name: "Red Roses" })],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function openCreateDialog() {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /new base item/i }));
  }

  it("shows no warning when the name field is empty", () => {
    openCreateDialog();
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("shows an exact-match warning when the typed name matches an existing base item exactly", async () => {
    openCreateDialog();
    const nameInput = document.getElementById("bi-name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Red Roses" } });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.getByTestId("name-warning-exact")).toHaveTextContent("Red Roses");
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("is case-insensitive when detecting an exact match", async () => {
    openCreateDialog();
    const nameInput = document.getElementById("bi-name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "RED ROSES" } });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
  });

  it("shows a similar-match warning when the typed name is a substring of an existing base item name", async () => {
    openCreateDialog();
    const nameInput = document.getElementById("bi-name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Red" } });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.getByTestId("name-warning-similar")).toHaveTextContent("Red Roses");
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
  });

  it("clears the warning when the name is changed to something unrelated", async () => {
    openCreateDialog();
    const nameInput = document.getElementById("bi-name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Red Roses" } });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    fireEvent.change(nameInput, { target: { value: "Sunflowers" } });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Component integration test: name duplicate warning in the edit-item dialog
// ---------------------------------------------------------------------------

describe("BaseItemsPage – name duplicate warning in edit dialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks({
      items: [
        makeItem({ id: 1, name: "Red Roses" }),
        makeItem({ id: 2, name: "Blue Tulips", code: "BI-002" }),
      ],
    });
  });

  function openEditDialog() {
    renderPage();
    const editButtons = screen.getAllByTitle("Edit");
    fireEvent.click(editButtons[1]);
  }

  it("shows no warning when the edit dialog opens with the item's own name", () => {
    openEditDialog();
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("shows an exact-match warning when changed to another item's name", async () => {
    openEditDialog();
    const nameInput = document.getElementById("bi-name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Red Roses" } });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toHaveTextContent("Red Roses");
    });
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("is case-insensitive when detecting an exact match in the edit dialog", async () => {
    openEditDialog();
    const nameInput = document.getElementById("bi-name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "RED ROSES" } });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });
  });

  it("shows a similar-match warning when edited name is a partial match of another item", async () => {
    openEditDialog();
    const nameInput = document.getElementById("bi-name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Red" } });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-similar")).toHaveTextContent("Red Roses");
    });
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
  });

  it("clears the warning when the name is changed to something unrelated", async () => {
    openEditDialog();
    const nameInput = document.getElementById("bi-name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Red Roses" } });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });
    fireEvent.change(nameInput, { target: { value: "Sunflowers" } });
    await waitFor(() => {
      expect(screen.queryByTestId("name-warning-exact")).toBeNull();
      expect(screen.queryByTestId("name-warning-similar")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Component integration test: image upload in the create dialog
// ---------------------------------------------------------------------------

describe("BaseItemDialog – image upload error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks({ items: [] });
  });

  function openCreateDialog() {
    renderPage();
    fireEvent.click(screen.getAllByRole("button", { name: /new base item/i })[0]);
  }

  it("shows an inline error near the upload area when the upload endpoint fails", async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("Upload server error"));
    openCreateDialog();

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["data"], "photo.jpg", { type: "image/jpeg" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
        "/api/base-items/upload-image",
        expect.objectContaining({ method: "POST" }),
      );
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("Upload server error");
    });
  });

  it("clears the upload error when the user retries and the upload succeeds", async () => {
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(new Error("Upload server error"))
      .mockResolvedValueOnce({ url: "https://cdn.example.com/img.jpg" });
    openCreateDialog();

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["data"], "photo.jpg", { type: "image/jpeg" });

    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Upload server error");
    });

    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => {
      expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("shows Upload image card and Generate with AI card side-by-side when no image is selected", () => {
    openCreateDialog();
    expect(screen.getByText("Generate with AI")).toBeTruthy();
    expect(screen.getByText("Upload image")).toBeTruthy();
    expect(screen.getByText("Recommended")).toBeTruthy();
  });

  it("shows image preview row with Replace and Remove buttons after a successful upload", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ url: "/objects/ws/base-items/test-uuid" });
    openCreateDialog();

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["data"], "flower.jpg", { type: "image/jpeg" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /replace/i })).toBeTruthy();
    });
  });

  it("clicking Replace removes the image and shows the two cards again", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ url: "/objects/ws/base-items/test-uuid" });
    openCreateDialog();

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["data"], "flower.jpg", { type: "image/jpeg" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /replace/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /replace/i }));

    await waitFor(() => {
      expect(screen.getByText("Generate with AI")).toBeTruthy();
      expect(screen.getByText("Upload image")).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// Component integration test: AI generation panel
// ---------------------------------------------------------------------------

describe("BaseItemDialog – AI generation panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks({ items: [] });
  });

  function openCreateDialogAndAiPanel() {
    renderPage();
    fireEvent.click(screen.getAllByRole("button", { name: /new base item/i })[0]);
    const generateCard = screen.getByText("Generate with AI");
    fireEvent.click(generateCard.closest("button")!);
  }

  it("opens the AI panel when the Generate with AI card is clicked", async () => {
    openCreateDialogAndAiPanel();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^generate$/i })).toBeTruthy();
    });
  });

  it("shows prompt textarea pre-filled and char counter when AI panel is open", async () => {
    openCreateDialogAndAiPanel();
    await waitFor(() => {
      const textarea = screen.getByPlaceholderText(/describe the image/i);
      expect(textarea).toBeTruthy();
      expect(screen.getByText(/\/ 500/)).toBeTruthy();
    });
  });

  it("shows all five suggestion chips in the AI panel", async () => {
    openCreateDialogAndAiPanel();
    await waitFor(() => {
      expect(screen.getByText("Isolated on white background")).toBeTruthy();
      expect(screen.getByText("Close-up, high detail")).toBeTruthy();
      expect(screen.getByText("Product photography")).toBeTruthy();
      expect(screen.getByText("Natural lighting")).toBeTruthy();
      expect(screen.getByText("Top view")).toBeTruthy();
    });
  });

  it("shows three style cards: Photographic, Clean & Minimal, Illustration", async () => {
    openCreateDialogAndAiPanel();
    await waitFor(() => {
      expect(screen.getByText("Photographic")).toBeTruthy();
      expect(screen.getByText("Clean & Minimal")).toBeTruthy();
      expect(screen.getByText("Illustration")).toBeTruthy();
    });
  });

  it("shows count buttons: 1 Image, 2 Images, 4 Images", async () => {
    openCreateDialogAndAiPanel();
    await waitFor(() => {
      expect(screen.getByText("1 Image")).toBeTruthy();
      expect(screen.getByText("2 Images")).toBeTruthy();
      expect(screen.getByText("4 Images")).toBeTruthy();
    });
  });

  it("shows an inline error in the AI panel when the generate-image endpoint fails", async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("Generation server error"));
    openCreateDialogAndAiPanel();

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/describe the image/i)).toBeTruthy();
    });

    const textarea = screen.getByPlaceholderText(/describe the image/i);
    fireEvent.change(textarea, { target: { value: "red roses bouquet" } });
    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));

    await waitFor(() => {
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
        "/api/base-items/generate-image",
        expect.objectContaining({ method: "POST" }),
      );
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("Generation server error");
    });
  });

  it("clears the generate error when the user retries and generation succeeds", async () => {
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(new Error("Generation server error"))
      .mockResolvedValueOnce({ urls: ["https://cdn.example.com/generated.jpg"] });
    openCreateDialogAndAiPanel();

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/describe the image/i)).toBeTruthy();
    });

    const textarea = screen.getByPlaceholderText(/describe the image/i);
    fireEvent.change(textarea, { target: { value: "red roses bouquet" } });
    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Generation server error");
    });

    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));
    await waitFor(() => {
      expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("closes the AI panel when the Back button is clicked", async () => {
    openCreateDialogAndAiPanel();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^generate$/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /back to item details/i }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^generate$/i })).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Component integration test: edit dialog with existing image
// ---------------------------------------------------------------------------

describe("BaseItemDialog – replace image in edit dialog (thumb-present mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks({
      items: [makeItem({ id: 1, name: "Red Roses", image_url: "https://cdn.example.com/existing.jpg" })],
    });
  });

  function openEditDialogWithImage() {
    renderPage();
    const editButtons = screen.getAllByTitle("Edit");
    fireEvent.click(editButtons[0]);
  }

  it("shows Replace button (not the two image cards) when the dialog opens with an existing image", () => {
    openEditDialogWithImage();
    expect(screen.getByRole("button", { name: /replace/i })).toBeTruthy();
    expect(screen.queryByText("Recommended")).toBeNull();
  });

  it("clicking Replace clears the image and shows the two image option cards", async () => {
    openEditDialogWithImage();
    fireEvent.click(screen.getByRole("button", { name: /replace/i }));
    await waitFor(() => {
      expect(screen.getByText("Generate with AI")).toBeTruthy();
      expect(screen.getByText("Upload image")).toBeTruthy();
    });
  });
});
