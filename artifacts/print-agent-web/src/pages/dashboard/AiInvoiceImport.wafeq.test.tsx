import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WafeqConnectionManager } from "./AiInvoiceImport";
import * as queryClient from "@/lib/queryClient";
import * as workspaceRole from "@/hooks/use-workspace-role";
import * as toastHook from "@/hooks/use-toast";

vi.mock("@/lib/queryClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/queryClient")>("@/lib/queryClient");
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: vi.fn(),
}));

describe("WafeqConnectionManager", () => {
  let queryClientInstance: QueryClient;
  const mockApiFetch = vi.mocked(queryClient.apiFetch);
  const mockUseWorkspaceRole = vi.mocked(workspaceRole.useWorkspaceRole);
  const mockUseToast = vi.mocked(toastHook.useToast);
  const mockToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    queryClientInstance = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockUseToast.mockReturnValue({ toast: mockToast } as any);
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true } as any);

    // Default GET response (unconfigured)
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === "/api/finance/wafeq/connection") {
        return { connection: { configured: false, status: "not_configured" } };
      }
      return {};
    });
  });

  const renderComponent = (open = true) => {
    return render(
      <QueryClientProvider client={queryClientInstance}>
        <WafeqConnectionManager open={open} />
      </QueryClientProvider>
    );
  };

  it("shows unauthorized message if not owner", async () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: false } as any);
    renderComponent();
    expect(screen.getByTestId("wafeq-unauthorized")).toBeInTheDocument();
  });

  it("fetches and displays status when connected", async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === "/api/finance/wafeq/connection") {
        return {
          connection: {
            configured: true,
            status: "configured",
            organization_id: "org_123",
            organization_name: "Test Org",
            last_verified_at: "2024-01-01T12:00:00Z",
          }
        };
      }
      return {};
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByTestId("wafeq-status-badge")).toHaveTextContent("Connected");
    });

    expect(screen.getByTestId("wafeq-org-name")).toHaveTextContent("Test Org (org_123)");
    expect(screen.getByTestId("wafeq-connect-button")).toHaveTextContent("Replace");
  });

  it("handles connect flow and clears secret on success", async () => {
    const user = userEvent.setup();
    renderComponent();

    // Wait for initial fetch
    await waitFor(() => {
      expect(screen.getByTestId("wafeq-connect-button")).toBeInTheDocument();
    });

    const input = screen.getByTestId("wafeq-api-key-input");
    await user.type(input, "my_secret_key");
    
    mockApiFetch.mockResolvedValueOnce({}); // Success POST
    
    const connectBtn = screen.getByTestId("wafeq-connect-button");
    await user.click(connectBtn);

    expect(mockApiFetch).toHaveBeenCalledWith(
      "/api/finance/wafeq/connection",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ api_key: "my_secret_key" })
      })
    );

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Connected to Wafeq" }));
    });

    // Verify secret is cleared
    expect(input).toHaveValue("");
  });

  it("clears a rejected candidate key and leaves the saved connection untouched", async () => {
    const user = userEvent.setup();
    renderComponent();
    const input = await screen.findByTestId("wafeq-api-key-input");
    await user.type(input, "bad_secret_key");
    mockApiFetch.mockRejectedValueOnce(new Error("Wafeq credentials could not be verified"));

    await user.click(screen.getByTestId("wafeq-connect-button"));

    await waitFor(() => expect(input).toHaveValue(""));
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Failed to connect" }));
  });

  it("shows a retryable error instead of reporting an unavailable status as disconnected", async () => {
    mockApiFetch.mockRejectedValueOnce(new Error("Network unavailable"));
    renderComponent();

    expect(await screen.findByTestId("wafeq-load-error")).toHaveTextContent("Could not load the Wafeq connection");
    expect(screen.queryByTestId("wafeq-status-badge")).not.toBeInTheDocument();
  });

  it("clears secret when dialog is closed", async () => {
    const user = userEvent.setup();
    const { rerender } = renderComponent(true);

    await waitFor(() => {
      expect(screen.getByTestId("wafeq-api-key-input")).toBeInTheDocument();
    });

    const input = screen.getByTestId("wafeq-api-key-input");
    await user.type(input, "my_secret_key");
    expect(input).toHaveValue("my_secret_key");

    // Re-render with open=false
    rerender(
      <QueryClientProvider client={queryClientInstance}>
        <WafeqConnectionManager open={false} />
      </QueryClientProvider>
    );

    // Re-render with open=true to check input
    rerender(
      <QueryClientProvider client={queryClientInstance}>
        <WafeqConnectionManager open={true} />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("wafeq-api-key-input")).toHaveValue("");
    });
  });

  it("handles test connection flow", async () => {
    const user = userEvent.setup();

    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === "/api/finance/wafeq/connection") {
        return { connection: { configured: true, status: "configured" } };
      }
      return {};
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByTestId("wafeq-test-button")).toBeInTheDocument();
    });

    mockApiFetch.mockResolvedValueOnce({}); // Success POST /test
    
    await user.click(screen.getByTestId("wafeq-test-button"));

    expect(mockApiFetch).toHaveBeenCalledWith(
      "/api/finance/wafeq/connection/test",
      expect.objectContaining({ method: "POST" })
    );

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Connection verified" }));
    });
  });

  it("handles disconnect flow with confirmation", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockImplementation(() => true);

    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === "/api/finance/wafeq/connection") {
        return { connection: { configured: true, status: "configured" } };
      }
      return {};
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByTestId("wafeq-disconnect-button")).toBeInTheDocument();
    });

    mockApiFetch.mockResolvedValueOnce({}); // Success DELETE
    
    await user.click(screen.getByTestId("wafeq-disconnect-button"));

    expect(confirmSpy).toHaveBeenCalledWith("Are you sure you want to disconnect from Wafeq?");
    
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/api/finance/wafeq/connection",
      expect.objectContaining({ method: "DELETE" })
    );

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Disconnected from Wafeq" }));
    });
    
    confirmSpy.mockRestore();
  });
});
