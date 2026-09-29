import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EntitySettingsDialog } from "./AiInvoiceImport";

const { apiFetch, toast, invalidateQueries } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toast: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({ apiFetch }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/hooks/use-workspace-role", () => ({ useWorkspaceRole: () => ({ isOwner: true, allowedPages: null }) }));

const entity = (accountId: number | null) => ({
  id: 3,
  legal_name: "Presentail SAL",
  display_name: "Presentail Lebanon",
  country: "LB",
  tax_registration_number: null,
  accounting_system: "odoo",
  odoo_base_url: "https://odoo.example.com",
  odoo_company_name: "Presentail SAL",
  odoo_company_id: 2,
  odoo_database: "presentail",
  default_currency: "USD",
  is_active: true,
  odoo_integration_configured: true,
  odoo_default_expense_account_id: accountId,
});

describe("EntitySettingsDialog Odoo default expense account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetch.mockResolvedValue({ entity: entity(383) });
  });

  it("exposes and initializes the current account, then refreshes it when the entity changes", () => {
    const { rerender } = render(<EntitySettingsDialog entity={entity(383)} open onClose={vi.fn()} />);
    expect(screen.getByTestId("input-entity-odoo-default-expense-account")).toHaveValue("383");

    rerender(<EntitySettingsDialog entity={entity(601101)} open onClose={vi.fn()} />);
    expect(screen.getByTestId("input-entity-odoo-default-expense-account")).toHaveValue("601101");
  });

  it("sends the numeric account ID in the update payload", async () => {
    render(<EntitySettingsDialog entity={entity(null)} open onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId("input-entity-odoo-default-expense-account"), { target: { value: "383" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/finance/entities/3", expect.objectContaining({
      method: "PATCH",
      body: expect.stringContaining('"odoo_default_expense_account_id":383'),
    })));
  });

  it("rejects decimal and non-positive account IDs before sending", async () => {
    render(<EntitySettingsDialog entity={entity(null)} open onClose={vi.fn()} />);
    const input = screen.getByTestId("input-entity-odoo-default-expense-account");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(screen.getByTestId("button-save-entity-settings"));

    expect(apiFetch).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Invalid default expense account", variant: "destructive" }));
  });

  it("surfaces server validation errors without closing or masking the dialog", async () => {
    apiFetch.mockRejectedValueOnce(new Error("The default expense account must be an active expense account"));
    render(<EntitySettingsDialog entity={entity(null)} open onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId("input-entity-odoo-default-expense-account"), { target: { value: "999999" } });
    fireEvent.click(screen.getByTestId("button-save-entity-settings"));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Failed",
      description: "The default expense account must be an active expense account",
      variant: "destructive",
    })));
    expect(screen.getByTestId("input-entity-odoo-default-expense-account")).toHaveValue("999999");
  });
});