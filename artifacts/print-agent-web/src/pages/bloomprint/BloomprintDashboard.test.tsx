import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateDraft,
  mockGetClerkToken,
  mockSetLocation,
  mockUploadFile,
  mockUseBloomprintDrafts,
  mockUseCreateBloomprintDraft,
  mockUseUpload,
} = vi.hoisted(() => ({
  mockCreateDraft: {
    isPending: false,
    mutate: vi.fn(),
  },
  mockGetClerkToken: vi.fn().mockResolvedValue("clerk-token"),
  mockSetLocation: vi.fn(),
  mockUploadFile: vi.fn(),
  mockUseBloomprintDrafts: vi.fn(),
  mockUseCreateBloomprintDraft: vi.fn(),
  mockUseUpload: vi.fn(),
}));

vi.mock("@/hooks/use-bloomprint", () => ({
  bloomprintErrorMessage: (error: unknown, fallback: string) => {
    if ((error as { status?: number } | null)?.status === 403) {
      return "Bloomprint requires owner access or the Manage products permission. Ask a workspace owner to grant access.";
    }
    return error instanceof Error ? error.message : fallback;
  },
  useBloomprintDrafts: mockUseBloomprintDrafts,
  useCreateBloomprintDraft: mockUseCreateBloomprintDraft,
}));

vi.mock("@workspace/object-storage-web", () => ({
  useUpload: mockUseUpload,
}));

vi.mock("@/lib/queryClient", () => ({
  getClerkToken: mockGetClerkToken,
}));

vi.mock("./StyleProfilesPanel", () => ({
  StyleProfilesPanel: () => null,
}));

vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useLocation: () => ["/bloomprint", mockSetLocation],
}));

import BloomprintDashboard from "./BloomprintDashboard";

const EMPTY_DRAFTS_RESULT = {
  data: [],
  error: null,
  isError: false,
  isFetching: false,
  isLoading: false,
  refetch: vi.fn(),
};

function makeImageFile(name = "inspiration.jpg", type = "image/jpeg") {
  return new File(["image contents"], name, { type });
}

let uploadOptions: {
  getAuthToken?: () => Promise<string | null>;
  onError?: (error: Error) => void;
  onSuccess?: (response: { objectPath: string }) => void;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUseBloomprintDrafts.mockReturnValue(EMPTY_DRAFTS_RESULT);
  mockUseCreateBloomprintDraft.mockReturnValue(mockCreateDraft);
  mockUseUpload.mockImplementation((options: typeof uploadOptions) => {
    uploadOptions = options;
    return {
      error: null,
      isUploading: false,
      progress: 0,
      uploadFile: mockUploadFile,
    };
  });
});

describe("BloomprintDashboard upload actions", () => {
  it("opens the same image picker from both visible upload controls", () => {
    render(<BloomprintDashboard />);

    const input = screen.getByLabelText("Choose Bloomprint inspiration image");
    const clickSpy = vi.spyOn(input, "click");

    fireEvent.click(screen.getByRole("button", { name: "New Draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Upload Inspiration" }));

    expect(clickSpy).toHaveBeenCalledTimes(2);
  });

  it("passes the Clerk token to the upload and navigates after draft creation", async () => {
    mockCreateDraft.mutate.mockImplementation((_data, callbacks) => {
      callbacks.onSuccess({ id: 73 });
    });
    render(<BloomprintDashboard />);

    const file = makeImageFile();
    fireEvent.change(screen.getByLabelText("Choose Bloomprint inspiration image"), {
      target: { files: [file] },
    });

    expect(mockUploadFile).toHaveBeenCalledWith(file);
    expect(uploadOptions.getAuthToken).toBe(mockGetClerkToken);

    uploadOptions.onSuccess?.({ objectPath: "/objects/workspace/uploads/inspiration" });

    await waitFor(() => {
      expect(mockCreateDraft.mutate).toHaveBeenCalledWith(
        { inspiration_image_path: "/objects/workspace/uploads/inspiration" },
        expect.any(Object),
      );
      expect(mockSetLocation).toHaveBeenCalledWith("/bloomprint/73");
    });
  });

  it("shows an upload error and allows selecting the same file again", async () => {
    render(<BloomprintDashboard />);
    const input = screen.getByLabelText("Choose Bloomprint inspiration image");
    const file = makeImageFile();

    fireEvent.change(input, { target: { files: [file] } });
    uploadOptions.onError?.(new Error("Storage is temporarily unavailable."));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Upload failed: Storage is temporarily unavailable. Please try again.",
    );

    fireEvent.change(input, { target: { files: [file] } });
    expect(mockUploadFile).toHaveBeenCalledTimes(2);
  });

  it("keeps the dashboard retry-ready when draft creation fails after upload", async () => {
    mockCreateDraft.mutate.mockImplementation((_data, callbacks) => {
      callbacks.onError(new Error("The image analysis could not be completed."));
    });
    render(<BloomprintDashboard />);

    fireEvent.change(screen.getByLabelText("Choose Bloomprint inspiration image"), {
      target: { files: [makeImageFile()] },
    });
    uploadOptions.onSuccess?.({ objectPath: "/objects/workspace/uploads/inspiration" });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Draft creation failed: The image analysis could not be completed. Please try again.",
    );
    expect(screen.getByRole("button", { name: "New Draft" })).toBeEnabled();
  });

  it("shows an actionable access state when the draft list is forbidden", () => {
    const error = Object.assign(
      new Error("Bloomprint requires owner access or the Manage products permission"),
      { status: 403 },
    );
    mockUseBloomprintDrafts.mockReturnValue({
      ...EMPTY_DRAFTS_RESULT,
      data: undefined,
      error,
      isError: true,
    });

    render(<BloomprintDashboard />);

    expect(screen.getByRole("heading", { name: "Bloomprint access required" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Ask a workspace owner to grant access.");
    expect(screen.queryByRole("button", { name: "New Draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload Inspiration" })).not.toBeInTheDocument();
  });
});