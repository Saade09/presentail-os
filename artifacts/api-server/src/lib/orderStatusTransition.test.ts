import { describe, expect, it, vi } from "vitest";

const { mockCreateAutomaticAddressCollectionRequest } = vi.hoisted(() => ({
  mockCreateAutomaticAddressCollectionRequest: vi.fn().mockResolvedValue({
    created: true,
    requestId: "request-1",
    token: "token",
  }),
}));

vi.mock("./addressCollector/service", () => ({
  createAutomaticAddressCollectionRequest: (...args: unknown[]) =>
    mockCreateAutomaticAddressCollectionRequest(...args),
  finalizeAddressCollectionForOrder: vi.fn().mockResolvedValue(0),
}));

vi.mock("./logger", () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

import { transitionOrderStatus } from "./orderStatusTransition";

describe("transitionOrderStatus automatic address collection", () => {
  it("triggers one automatic request after a pending order commits as processing", async () => {
    const clientQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("SELECT id, status, external_order_id")) {
        return Promise.resolve({
          rows: [{
            id: "order-1",
            status: "pending",
            external_order_id: "external-1",
            inventory_fulfillment_cycle: 0,
          }],
          rowCount: 1,
        });
      }
      if (sql.includes("UPDATE orders")) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const client = {
      query: clientQuery,
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    };

    await expect(transitionOrderStatus(pool as never, {
      orderId: "order-1",
      newStatus: "processing",
      workspaceOwnerId: "workspace-1",
      actorUserId: "user-1",
    })).resolves.toMatchObject({
      success: true,
      previousStatus: "pending",
      newStatus: "processing",
    });
    await Promise.resolve();

    expect(mockCreateAutomaticAddressCollectionRequest).toHaveBeenCalledTimes(1);
    expect(mockCreateAutomaticAddressCollectionRequest).toHaveBeenCalledWith({
      workspaceOwnerId: "workspace-1",
      orderId: "order-1",
    });
    const commitCallOrder = clientQuery.mock.invocationCallOrder[
      clientQuery.mock.calls.findIndex(([sql]) => sql === "COMMIT")
    ];
    const triggerCallOrder = mockCreateAutomaticAddressCollectionRequest.mock.invocationCallOrder[0];
    expect(triggerCallOrder).toBeGreaterThan(commitCallOrder);
  });
});

describe("transitionOrderStatus refunded-order status changes", () => {
  it("marks payment paid in the same transaction as a status change", async () => {
    const clientQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("SELECT id, status, external_order_id")) {
        return Promise.resolve({
          rows: [{
            id: "order-1",
            status: "refunded",
            external_order_id: "external-1",
            inventory_fulfillment_cycle: 0,
          }],
          rowCount: 1,
        });
      }
      if (sql.includes("FROM order_payment")) {
        return Promise.resolve({
          rows: [{ status: "partially_refunded" }],
          rowCount: 1,
        });
      }
      if (sql.includes("UPDATE order_payment")) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.includes("UPDATE orders")) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const client = { query: clientQuery, release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    await expect(
      transitionOrderStatus(pool as never, {
        orderId: "order-1",
        newStatus: "preparing",
        workspaceOwnerId: "workspace-1",
        actorUserId: "user-1",
        restoreRefundedPayment: true,
        allowedFromStatuses: ["refunded"],
      }),
    ).resolves.toMatchObject({
      success: true,
      previousStatus: "refunded",
      previousPaymentStatus: "partially_refunded",
      newStatus: "preparing",
    });

    const paymentUpdateIndex = clientQuery.mock.calls.findIndex(([sql]) =>
      String(sql).includes("UPDATE order_payment"),
    );
    const orderUpdateIndex = clientQuery.mock.calls.findIndex(([sql]) =>
      String(sql).includes("UPDATE orders"),
    );
    const commitIndex = clientQuery.mock.calls.findIndex(([sql]) => sql === "COMMIT");
    expect(paymentUpdateIndex).toBeGreaterThan(-1);
    expect(paymentUpdateIndex).toBeLessThan(orderUpdateIndex);
    expect(orderUpdateIndex).toBeLessThan(commitIndex);
    expect(String(clientQuery.mock.calls[paymentUpdateIndex][0])).toMatch(
      /SET status = 'paid'/,
    );
    expect(String(clientQuery.mock.calls[paymentUpdateIndex][0])).not.toMatch(
      /refunded_amount|payment_reference/i,
    );
  });

  it("does not change the order when its payment record is missing", async () => {
    const clientQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("SELECT id, status, external_order_id")) {
        return Promise.resolve({
          rows: [{
            id: "order-1",
            status: "refunded",
            external_order_id: null,
            inventory_fulfillment_cycle: 0,
          }],
          rowCount: 1,
        });
      }
      if (sql.includes("FROM order_payment")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const client = { query: clientQuery, release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    await expect(
      transitionOrderStatus(pool as never, {
        orderId: "order-1",
        newStatus: "preparing",
        workspaceOwnerId: "workspace-1",
        actorUserId: "user-1",
        restoreRefundedPayment: true,
        allowedFromStatuses: ["refunded"],
      }),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "REFUNDED_PAYMENT_NOT_FOUND" },
    });
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE orders"))).toBe(false);
    expect(clientQuery).toHaveBeenCalledWith("ROLLBACK");
  });
});