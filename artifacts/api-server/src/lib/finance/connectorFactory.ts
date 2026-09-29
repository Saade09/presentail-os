import type { AccountingConnector } from "./accountingConnector.js";
import { OdooAccountingConnector } from "./odooConnector.js";
import { ManualAccountingConnector, NoopAccountingConnector } from "./manualConnector.js";
import { WafeqAccountingConnector } from "./wafeqConnector.js";

type EntityRow = {
  id: number;
  accounting_system: string;
  odoo_base_url: string | null;
  odoo_database: string | null;
  odoo_integration_token: string | null;
  odoo_company_id: number | null;
  odoo_company_name: string | null;
  odoo_default_expense_account_id?: number | null;
  wafeq_api_key?: string | null;
  wafeq_organization_id?: string | null;
  wafeq_supplier_id?: string | null;
  wafeq_account_id?: string | null;
  wafeq_tax_id?: string | null;
};

export function createConnector(entity: EntityRow): AccountingConnector {
  switch (entity.accounting_system) {
    case "odoo":
      return new OdooAccountingConnector({
        odoo_base_url: entity.odoo_base_url,
        odoo_database: entity.odoo_database,
        odoo_integration_token: entity.odoo_integration_token,
        odoo_company_id: entity.odoo_company_id,
        odoo_company_name: entity.odoo_company_name,
        odoo_default_expense_account_id: entity.odoo_default_expense_account_id,
      });
    case "manual":
      return new ManualAccountingConnector();
    case "wafeq":
      return new WafeqAccountingConnector({
        apiKey: entity.wafeq_api_key,
        organizationId: entity.wafeq_organization_id,
      });
    default:
      return new NoopAccountingConnector();
  }
}
