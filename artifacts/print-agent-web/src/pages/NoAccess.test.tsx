import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NoAccessPage from "./NoAccess";

vi.mock("@clerk/react", () => ({
  useClerk: () => ({ signOut: vi.fn() }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function statusResponse(requested: boolean) {
  return new Response(JSON.stringify({ requested }), { status: 200 });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/?workspace=test-workspace");
  // Default: status endpoint says the user has NOT yet requested access.
  // Individual tests override the POST behaviour with mockResolvedValueOnce.
  mockFetch.mockResolvedValue(statusResponse(false));
});

function renderPage() {
  return render(<NoAccessPage />);
}

describe("NoAccessPage — Request Access button", () => {
  it("renders with the button in the idle state initially", () => {
    renderPage();
    const btn = screen.getByRole("button", { name: /request access/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toBeEnabled();
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it("starts as disabled with 'Request sent!' when the user has already requested", async () => {
    mockFetch.mockResolvedValue(statusResponse(true));
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /request sent/i })).toBeDisabled();
    });
  });

  it("transitions idle → loading → sent on a successful API response", async () => {
    const user = userEvent.setup();

    let resolvePost!: (value: Response) => void;
    // First call: status check (resolves immediately via default mock)
    // Second call: POST — we control when it resolves
    mockFetch
      .mockResolvedValueOnce(statusResponse(false))
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolvePost = resolve;
        }),
      );

    renderPage();

    // Wait for the status check to complete so the button is enabled
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /request access/i })).toBeEnabled();
    });

    const btn = screen.getByRole("button", { name: /request access/i });
    await user.click(btn);

    expect(screen.getByText(/sending/i)).toBeInTheDocument();
    expect(btn).toBeDisabled();

    resolvePost(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /request sent/i })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /request sent/i })).toBeDisabled();
  });

  it("shows 'already requested' message when the API returns 409", async () => {
    const user = userEvent.setup();

    mockFetch
      .mockResolvedValueOnce(statusResponse(false))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "already_requested" }), { status: 409 }),
      );

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /request access/i })).toBeEnabled();
    });

    await user.click(screen.getByRole("button", { name: /request access/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /request sent/i })).toBeDisabled();
    });
    expect(screen.getByText(/you've already requested access/i)).toBeInTheDocument();
  });

  it("shows the inline error message when the API returns a non-ok response", async () => {
    const user = userEvent.setup();

    mockFetch
      .mockResolvedValueOnce(statusResponse(false))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Failed to send" }), { status: 500 }),
      );

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /request access/i })).toBeEnabled();
    });

    await user.click(screen.getByRole("button", { name: /request access/i }));

    await waitFor(() => {
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /request access/i })).toBeEnabled();
  });

  it("shows the inline error message when the fetch itself throws (network error)", async () => {
    const user = userEvent.setup();

    mockFetch
      .mockResolvedValueOnce(statusResponse(false))
      .mockRejectedValueOnce(new Error("Network error"));

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /request access/i })).toBeEnabled();
    });

    await user.click(screen.getByRole("button", { name: /request access/i }));

    await waitFor(() => {
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /request access/i })).toBeEnabled();
  });

  it("posts to the request-access endpoint with credentials:include", async () => {
    const user = userEvent.setup();

    mockFetch
      .mockResolvedValueOnce(statusResponse(false))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /request access/i })).toBeEnabled();
    });

    await user.click(screen.getByRole("button", { name: /request access/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /request sent/i })).toBeInTheDocument();
    });

    // First call is the GET status check; second is the POST.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [statusUrl] = mockFetch.mock.calls[0];
    expect(statusUrl).toContain("request-access/status");

    const [postUrl, postInit] = mockFetch.mock.calls[1];
    expect(postUrl).toContain("request-access");
    expect(postInit).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: "test-workspace" }),
    });
  });

  it("lets a denied user enter a workspace slug when the URL has no workspace target", async () => {
    window.history.replaceState({}, "", "/");
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    renderPage();

    const button = screen.getByRole("button", { name: /request access/i });
    expect(button).toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: /workspace slug/i }), "My-Team");
    expect(button).toBeEnabled();
    await user.click(button);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /request sent/i })).toBeDisabled();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("request-access"),
      expect.objectContaining({ body: JSON.stringify({ workspace: "my-team" }) }),
    );
  });
});
