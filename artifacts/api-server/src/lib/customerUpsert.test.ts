/**
 * Unit tests for customerUpsert helpers — normalization and the executor
 * selection logic in upsertCustomerFromOrder. The DB executor is mocked so
 * these tests run without a database; they verify which SQL branch is taken
 * and which (normalized) parameters are passed.
 *
 * For end-to-end behaviour (no-duplicate-on-repeat-email, recompute totals
 * across multiple orders, etc.) see customerUpsert.integration.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import {
  normalizeEmail,
  normalizePhone,
  upsertCustomerFromOrder,
  recomputeCustomerAggregates,
} from "./customerUpsert";

type MockExec = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any;
};

function makeExec(responses: Array<{ rows: unknown[]; rowCount?: number }>): MockExec {
  const exec: MockExec = { query: vi.fn() };
  for (const r of responses) {
    exec.query.mockResolvedValueOnce({ rows: r.rows, rowCount: r.rowCount ?? r.rows.length });
  }
  return exec;
}

describe("normalizeEmail()", () => {
  it("returns null for null/undefined/empty input", () => {
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
  });

  it("rejects values without an '@' as invalid emails", () => {
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("plainstring")).toBeNull();
  });

  it("lowercases and trims valid emails", () => {
    expect(normalizeEmail("  Jane.DOE@Example.COM ")).toBe("jane.doe@example.com");
    expect(normalizeEmail("USER@HOST.IO")).toBe("user@host.io");
  });
});

describe("normalizePhone()", () => {
  it("returns null for null/undefined/empty input", () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("()-  ")).toBeNull();
  });

  it("strips spaces, dashes, parens, and other non-digits but keeps + and digits", () => {
    expect(normalizePhone("+971 (50) 123-4567")).toBe("+971501234567");
    expect(normalizePhone("(415) 555-2671")).toBe("4155552671");
    expect(normalizePhone("050.123.4567")).toBe("0501234567");
  });

  it("preserves a leading + sign when present", () => {
    expect(normalizePhone("+1-202-555-0100")).toBe("+12025550100");
  });
});

describe("upsertCustomerFromOrder() — executor branch selection", () => {
  it("returns null when neither email nor phone is provided", async () => {
    const exec = makeExec([]);
    const id = await upsertCustomerFromOrder("ws_1", { email: null, phone: null }, exec);
    expect(id).toBeNull();
    expect(exec.query).not.toHaveBeenCalled();
  });

  it("returns null when email/phone are present but normalize to nothing", async () => {
    const exec = makeExec([]);
    const id = await upsertCustomerFromOrder(
      "ws_1",
      { email: "no-at-sign", phone: "()" },
      exec,
    );
    expect(id).toBeNull();
    expect(exec.query).not.toHaveBeenCalled();
  });

  it("uses the email-conflict INSERT branch and passes normalized email", async () => {
    const exec = makeExec([{ rows: [{ id: 42 }] }]);
    const id = await upsertCustomerFromOrder(
      "ws_1",
      {
        firstName: "Jane",
        lastName: "Doe",
        email: "  Jane.DOE@Example.COM ",
        phone: "+971 50 123 4567",
        country: "AE",
        city: "Dubai",
        source: "manual",
      },
      exec,
    );

    expect(id).toBe(42);
    expect(exec.query).toHaveBeenCalledTimes(1);
    const [sql, params] = exec.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO customers/i);
    expect(sql).toMatch(/ON CONFLICT \(workspace_owner_id, email\)/i);
    // [workspace, firstName, lastName, email, phone, country, city, source]
    expect(params[0]).toBe("ws_1");
    expect(params[1]).toBe("Jane");
    expect(params[2]).toBe("Doe");
    expect(params[3]).toBe("jane.doe@example.com"); // lowercased
    expect(params[4]).toBe("+971501234567");        // phone normalized
    expect(params[5]).toBe("AE");
    expect(params[6]).toBe("Dubai");
    expect(params[7]).toBe("manual");
  });

  it("phone-only fallback: SELECTs by phone first, then UPDATEs the existing row", async () => {
    const exec = makeExec([
      { rows: [{ id: 7 }] }, // SELECT existing by phone
      { rows: [] },          // UPDATE
    ]);
    const id = await upsertCustomerFromOrder(
      "ws_2",
      { firstName: "Bob", phone: "(415) 555-2671" },
      exec,
    );
    expect(id).toBe(7);
    expect(exec.query).toHaveBeenCalledTimes(2);

    const [selectSql, selectParams] = exec.query.mock.calls[0] as [string, unknown[]];
    expect(selectSql).toMatch(/SELECT id FROM customers/i);
    expect(selectSql).toMatch(/workspace_owner_id = \$1 AND phone = \$2/);
    expect(selectParams).toEqual(["ws_2", "4155552671"]);

    const [updateSql, updateParams] = exec.query.mock.calls[1] as [string, unknown[]];
    expect(updateSql).toMatch(/^\s*UPDATE customers/i);
    expect(updateParams[0]).toBe(7);
    expect(updateParams[1]).toBe("Bob");
  });

  it("phone-only fallback: INSERTs a new row when no phone match exists", async () => {
    const exec = makeExec([
      { rows: [] },          // SELECT — no match
      { rows: [{ id: 99 }] }, // INSERT
    ]);
    const id = await upsertCustomerFromOrder(
      "ws_3",
      { firstName: "Eve", phone: "050-555-0001", source: "checkout" },
      exec,
    );
    expect(id).toBe(99);
    expect(exec.query).toHaveBeenCalledTimes(2);

    const [insertSql, insertParams] = exec.query.mock.calls[1] as [string, unknown[]];
    expect(insertSql).toMatch(/INSERT INTO customers/i);
    expect(insertSql).toMatch(/VALUES \(\$1,\$2,\$3,NULL,\$4/); // email column = NULL
    // [workspace, firstName, lastName, phone, country, city, source]
    expect(insertParams[0]).toBe("ws_3");
    expect(insertParams[1]).toBe("Eve");
    expect(insertParams[2]).toBeNull();
    expect(insertParams[3]).toBe("0505550001");
    expect(insertParams[6]).toBe("checkout");
  });

  it("does not take the phone-only branch when an email is present", async () => {
    const exec = makeExec([{ rows: [{ id: 1 }] }]);
    await upsertCustomerFromOrder(
      "ws_1",
      { email: "x@y.io", phone: "+971501234567" },
      exec,
    );
    // Only the email-branch INSERT runs (one query, not the SELECT-then-X
    // pattern of the phone fallback).
    expect(exec.query).toHaveBeenCalledTimes(1);
    const [sql] = exec.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ON CONFLICT/i);
  });
});

describe("recomputeCustomerAggregates() — SQL shape", () => {
  it("is a no-op (aggregates not recomputed)", async () => {
    const exec = makeExec([]);
    await recomputeCustomerAggregates(123, exec);
    expect(exec.query).toHaveBeenCalledTimes(0);
  });
});
