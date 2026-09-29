import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findUnambiguousJournalMatch,
  OdooConfigurationDialog,
  OdooConnectionPanel,
} from "./AccountingReconciliation";

const mockApiFetch = vi.fn();

vi.mock("@/lib/queryClient", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ realIsOwner: true }),
}));

vi.mock("@/components/lb-bank-recon/UploadStatementModal", () => ({
  default: () => null,
}));

const CONFIGURED_CONNECTION = {
  entity_id: 17,
  connected: true,
  configured: true,
  accounting_system: "odoo",
  legal_name: "Presentail SAL",
  display_name: "Presentail Lebanon",
  odoo_base_url: "https://odoo.example.com",
  odoo_database: "presentail_prod",
  odoo_company_id: 9,
  odoo_company_name: "Presentail SAL",
  error: null,
  last_sync_at: null,
};

const MISSING_CONNECTION = {
  entity_id: null,
  connected: false,
  configured: false,
  error: "No active Lebanon finance entity found",
  last_sync_at: null,
};

beforeEach(() => {
  mockApiFetch.mockReset();
  mockApiFetch.mockResolvedValue({ entity: { id: 17 } });
});

describe("Odoo connection card", () => {
  it("shows Configure Odoo for a missing entity", () => {
    render(
      <OdooConnectionPanel
        connection={MISSING_CONNECTION}
        onRefresh={vi.fn()}
        onConfigure={vi.fn()}
        canConfigure
        isRefreshing={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Configure Odoo" })).toBeEnabled();
    expect(screen.getByText(/No active Lebanon finance entity found/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check connection" })).toBeDisabled();
  });

  it("shows Edit Odoo settings when configuration exists", () => {
    render(
      <OdooConnectionPanel
        connection={CONFIGURED_CONNECTION}
        onRefresh={vi.fn()}
        onConfigure={vi.fn()}
        canConfigure
        isRefreshing={false}
      />,
    );

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Odoo settings" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Check connection" })).toBeEnabled();
  });

  it("explains why finance users cannot change credentials", () => {
    render(
      <OdooConnectionPanel
        connection={CONFIGURED_CONNECTION}
        onRefresh={vi.fn()}
        onConfigure={vi.fn()}
        canConfigure={false}
        isRefreshing={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Edit Odoo settings" })).toBeDisabled();
    expect(screen.getByText(/Only workspace owners can create or change Odoo credentials/i))
      .toBeInTheDocument();
  });

  it("renders JSON-2 diagnostics without obsolete addon guidance", () => {
    render(
      <OdooConnectionPanel
        connection={{
          ...CONFIGURED_CONNECTION,
          connected: false,
          error: "Odoo health endpoint was not found. Install or enable the bank reconciliation addon.",
          protocol: "JSON-2",
          diagnostics: { http_status: 404, endpoint: "/json/2" },
        }}
        onRefresh={vi.fn()}
        onConfigure={vi.fn()}
        canConfigure
        isRefreshing={false}
      />,
    );

    expect(screen.getByText("Disconnected")).toBeInTheDocument();
    expect(screen.getByText("Odoo JSON-2 connection check failed. Review the diagnostics below."))
      .toBeInTheDocument();
    expect(screen.getByText("JSON-2")).toBeInTheDocument();
    expect(screen.getByText("/json/2")).toBeInTheDocument();
    expect(screen.queryByText(/install or enable.*addon/i)).not.toBeInTheDocument();
  });
});

describe("Odoo journal matching", () => {
  const journals = [
    {
      id: 21,
      name: "BLOM USD",
      code: "BUSD",
      type: "bank",
      company_id: 2,
      company_name: "Presentail SAL",
      currency_id: 1,
      currency_name: "USD",
      default_account_id: 101,
      default_account_name: "BLOM USD",
      bank_account_id: 501,
      bank_account_name: "BLOM Bank · 1234",
    },
    {
      id: 22,
      name: "BLOM LBP",
      code: "BLBP",
      type: "bank",
      company_id: 2,
      company_name: "Presentail SAL",
      currency_id: 2,
      currency_name: "LBP",
      default_account_id: 102,
      default_account_name: "BLOM LBP",
      bank_account_id: 502,
      bank_account_name: "BLOM Bank",
    },
  ];

  it("preselects the one bank-name token and currency match despite account suffixes", () => {
    expect(
      findUnambiguousJournalMatch({ bank_name: "blom bank", currency: "USD" }, journals)?.id,
    ).toBe(21);
  });

  it("does not preselect when matching is ambiguous", () => {
    expect(
      findUnambiguousJournalMatch(
        { bank_name: "BLOM Bank", currency: "USD" },
        [...journals, { ...journals[0], id: 23, code: "BUSD2" }],
      ),
    ).toBeNull();
  });
});

describe("Odoo configuration dialog", () => {
  it("creates the missing Lebanon entity with the required Odoo settings", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn().mockResolvedValue(undefined);

    render(
      <OdooConfigurationDialog
        open
        onOpenChange={vi.fn()}
        connection={MISSING_CONNECTION}
        onSaved={onSaved}
      />,
    );

    await user.type(screen.getByLabelText("Odoo base URL *"), "https://odoo.example.com");
    await user.type(screen.getByLabelText("Database name *"), "presentail_prod");
    await user.type(screen.getByLabelText("Company ID *"), "9");
    await user.type(screen.getByLabelText("Company name *"), "Presentail SAL");
    await user.click(screen.getByRole("button", { name: "Save and check connection" }));

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
    const [url, options] = mockApiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/finance/entities");
    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toMatchObject({
      country: "LB",
      accounting_system: "odoo",
      odoo_database: "presentail_prod",
      odoo_company_id: 9,
    });
    expect(JSON.parse(String(options.body))).not.toHaveProperty("odoo_integration_token");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("does not expose obsolete integration-token guidance when editing", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn().mockResolvedValue(undefined);

    render(
      <OdooConfigurationDialog
        open
        onOpenChange={vi.fn()}
        connection={CONFIGURED_CONNECTION}
        onSaved={onSaved}
      />,
    );

    expect(screen.queryByText(/integration token/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save and check connection" }));

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
    const [url, options] = mockApiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/finance/entities/17");
    expect(options.method).toBe("PATCH");
    const body = JSON.parse(String(options.body));
    expect(body).not.toHaveProperty("odoo_integration_token");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});