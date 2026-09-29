import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ProfilePage from "./Profile";

const mockSetProfileImage = vi.fn();
const mockToast = vi.fn();

const mockUseUser = vi.fn();
vi.mock("@clerk/react", () => ({
  useUser: () => mockUseUser(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({ data: undefined, isLoading: false })),
  useMutation: vi.fn(() => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  useQueryClient: vi.fn(() => ({ setQueryData: vi.fn() })),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: false, allowedPages: [], loaded: true }),
}));

vi.mock("react-phone-number-input", async () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input
      data-testid="phone-input"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
  getCountries: () => ["US", "GB", "CA"],
}));

vi.mock("./profile/ProfileOverviewTab", () => ({
  ProfileOverviewTab: () => <div data-testid="mock-overview-tab" />,
}));

vi.mock("./profile/ProfilePersonalTab", () => ({
  ProfilePersonalTab: () => <div data-testid="mock-personal-tab" />,
}));

vi.mock("./profile/ProfileWorkTab", () => ({
  ProfileWorkTab: () => <div data-testid="mock-work-tab" />,
}));

vi.mock("./profile/ProfileAccessTab", () => ({
  ProfileAccessTab: () => <div data-testid="mock-access-tab" />,
}));

vi.mock("./profile/ProfileTimeOffTab", () => ({
  ProfileTimeOffTab: () => <div data-testid="mock-time-off-tab" />,
}));

vi.mock("./profile/ProfileNotificationsTab", () => ({
  ProfileNotificationsTab: () => <div data-testid="mock-notifications-tab" />,
}));

vi.mock("./profile/ProfileSecurityTab", () => ({
  ProfileSecurityTab: () => <div data-testid="mock-security-tab" />,
}));

vi.mock("./profile/ProfilePayTab", () => ({
  ProfilePayTab: () => <div data-testid="mock-pay-tab" />,
}));

global.fetch = vi.fn(() =>
  Promise.resolve({ json: () => Promise.resolve({}) } as Response),
);

const USER_WITH_PHOTO = {
  firstName: "Alice",
  primaryEmailAddress: { emailAddress: "alice@example.com" },
  imageUrl: "https://example.com/real-photo.jpg",
  hasImage: true,
  setProfileImage: mockSetProfileImage,
  update: vi.fn(),
};

const USER_WITHOUT_PHOTO = {
  firstName: "Bob",
  primaryEmailAddress: { emailAddress: "bob@example.com" },
  imageUrl: "https://img.clerk.com/eyJ0eXBlIjoiZGVmYXVsdCIsImluaXRpYWxzIjoiQlQifQ",
  hasImage: false,
  setProfileImage: mockSetProfileImage,
  update: vi.fn(),
};

function renderProfile() {
  return render(<ProfilePage />);
}

describe("ProfilePage – Remove photo button visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetProfileImage.mockResolvedValue(undefined);
  });

  it("does not show the Remove photo button when no custom photo is set", () => {
    mockUseUser.mockReturnValue({ user: USER_WITHOUT_PHOTO, isLoaded: true });

    renderProfile();

    expect(screen.queryByTestId("remove-photo-button")).not.toBeInTheDocument();
  });

  it("shows the Remove photo button when a custom photo is uploaded", () => {
    mockUseUser.mockReturnValue({ user: USER_WITH_PHOTO, isLoaded: true });

    renderProfile();

    expect(screen.getByTestId("remove-photo-button")).toBeInTheDocument();
    expect(screen.getByTestId("remove-photo-button")).toHaveTextContent("Remove photo");
  });
});

describe("ProfilePage – Remove photo action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetProfileImage.mockResolvedValue(undefined);
    mockUseUser.mockReturnValue({ user: USER_WITH_PHOTO, isLoaded: true });
  });

  it("calls user.setProfileImage({ file: null }) when Remove photo is clicked", async () => {
    renderProfile();

    const removeBtn = screen.getByTestId("remove-photo-button");
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(mockSetProfileImage).toHaveBeenCalledTimes(1);
      expect(mockSetProfileImage).toHaveBeenCalledWith({ file: null });
    });
  });

  it("disables the Remove photo button while the removal is in progress", async () => {
    let resolveRemoval!: () => void;
    mockSetProfileImage.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRemoval = resolve;
      }),
    );

    renderProfile();

    const removeBtn = screen.getByTestId("remove-photo-button");
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(screen.getByTestId("remove-photo-button")).toBeDisabled();
    });

    resolveRemoval();

    await waitFor(() => {
      expect(screen.getByTestId("remove-photo-button")).not.toBeDisabled();
    });
  });
});

describe("ProfilePage – Upload photo action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUser.mockReturnValue({ user: USER_WITH_PHOTO, isLoaded: true });
  });

  it("disables the upload photo button while the upload is in progress", async () => {
    let resolveUpload!: () => void;
    mockSetProfileImage.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveUpload = resolve;
      }),
    );

    renderProfile();

    const fileInput = screen.getByTestId("photo-file-input");
    const mockFile = new File(["img"], "avatar.png", { type: "image/png" });

    fireEvent.change(fileInput, { target: { files: [mockFile] } });

    await waitFor(() => {
      expect(screen.getByTestId("upload-photo-button")).toBeDisabled();
    });

    resolveUpload();

    await waitFor(() => {
      expect(screen.getByTestId("upload-photo-button")).not.toBeDisabled();
    });
  });

  it("calls user.setProfileImage with the selected file and shows a success toast", async () => {
    mockSetProfileImage.mockResolvedValue(undefined);

    renderProfile();

    const fileInput = screen.getByTestId("photo-file-input");
    const mockFile = new File(["img"], "avatar.png", { type: "image/png" });

    fireEvent.change(fileInput, { target: { files: [mockFile] } });

    await waitFor(() => {
      expect(mockSetProfileImage).toHaveBeenCalledTimes(1);
      expect(mockSetProfileImage).toHaveBeenCalledWith({ file: mockFile });
    });

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Photo updated" }),
      );
    });

    expect(screen.getByTestId("upload-photo-button")).not.toBeDisabled();
  });

  it("shows a destructive toast and re-enables the button when setProfileImage rejects", async () => {
    mockSetProfileImage.mockRejectedValue(new Error("upload failed"));

    renderProfile();

    const fileInput = screen.getByTestId("photo-file-input");
    const mockFile = new File(["img"], "avatar.png", { type: "image/png" });

    fireEvent.change(fileInput, { target: { files: [mockFile] } });

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Failed to upload photo",
          variant: "destructive",
        }),
      );
    });

    expect(screen.getByTestId("upload-photo-button")).not.toBeDisabled();
  });
});
