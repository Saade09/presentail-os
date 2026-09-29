/**
 * Integration test: verifies that a live SSE subscriber receives the
 * "low_stock" event when broadcastLowStock() is called, and that the message
 * is formatted correctly (event: low_stock + JSON payload).
 *
 * Uses the REAL subscribeToLowStock / broadcastLowStock implementations so the
 * full pipeline is exercised: subscribeToLowStock() registers the Response →
 * broadcastLowStock() writes to it → the SSE client receives the event.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "http";
import { subscribeToLowStock, broadcastLowStock } from "./lowStockSse";
import type { LowStockPayload } from "./lowStockSse";

// ---------------------------------------------------------------------------
// Test server — minimal SSE endpoint using the real lowStockSse module
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "workspace_sse_test";

function makeServer() {
  const app = express();
  app.get("/low-stock-events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    res.write(": connected\n\n");
    subscribeToLowStock(WORKSPACE_ID, res);

    req.on("close", () => {
      // nothing extra needed; lowStockSse removes the subscriber on "close"
    });
  });
  return http.createServer(app);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Open a persistent SSE connection to the server and return an accessor for
 * accumulated response text plus a handle to close the socket.
 */
function connectSse(
  server: http.Server,
  path: string,
): Promise<{ getText: () => string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { host: "127.0.0.1", port: addr.port, path, method: "GET" },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString();
        });
        resolve({
          getText: () => text,
          close: () => req.destroy(),
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Wait until condition() returns true or timeout elapses. */
function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (condition()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error("waitFor timed out"));
      }
    }, 10);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lowStockSse integration — real subscribeToLowStock / broadcastLowStock", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = makeServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("subscriber receives a well-formed 'low_stock' event when broadcastLowStock is called", async () => {
    const sse = await connectSse(server, "/low-stock-events");

    // Wait for the connection confirmation comment
    await waitFor(() => sse.getText().includes(": connected"));

    const payload: LowStockPayload = {
      itemName: "Ficus Plant",
      locationName: "Warehouse A",
      currentStock: 2,
      baseItemId: 101,
    };

    broadcastLowStock(WORKSPACE_ID, payload);

    await waitFor(() => sse.getText().includes("event: low_stock"));

    const text = sse.getText();
    expect(text).toContain("event: low_stock");
    expect(text).toContain(`"itemName":"Ficus Plant"`);
    expect(text).toContain(`"locationName":"Warehouse A"`);
    expect(text).toContain(`"currentStock":2`);
    expect(text).toContain(`"baseItemId":101`);

    sse.close();
  });

  it("subscriber receives multiple events for multiple broadcasts", async () => {
    const sse = await connectSse(server, "/low-stock-events");

    await waitFor(() => sse.getText().includes(": connected"));

    broadcastLowStock(WORKSPACE_ID, {
      itemName: "Rose Bouquet",
      locationName: "Branch 1",
      currentStock: 1,
      baseItemId: 202,
    });

    broadcastLowStock(WORKSPACE_ID, {
      itemName: "Balloon Set",
      locationName: "Branch 2",
      currentStock: 3,
      baseItemId: 303,
    });

    await waitFor(() => sse.getText().split("event: low_stock").length - 1 >= 2);

    const text = sse.getText();
    expect(text).toContain(`"itemName":"Rose Bouquet"`);
    expect(text).toContain(`"itemName":"Balloon Set"`);

    sse.close();
  });

  it("does NOT receive an event when broadcastLowStock is called for a different workspace", async () => {
    const sse = await connectSse(server, "/low-stock-events");

    await waitFor(() => sse.getText().includes(": connected"));

    const initialText = sse.getText();

    broadcastLowStock("other_workspace_id", {
      itemName: "Ghost Item",
      locationName: "Other HQ",
      currentStock: 0,
      baseItemId: 999,
    });

    // Brief wait to confirm no event arrives
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sse.getText()).toBe(initialText);

    sse.close();
  });

  it("two subscribers in the same workspace both receive the event", async () => {
    const sse1 = await connectSse(server, "/low-stock-events");
    const sse2 = await connectSse(server, "/low-stock-events");

    await waitFor(() => sse1.getText().includes(": connected"));
    await waitFor(() => sse2.getText().includes(": connected"));

    broadcastLowStock(WORKSPACE_ID, {
      itemName: "Candle",
      locationName: "Main Store",
      currentStock: 5,
      baseItemId: 404,
    });

    await waitFor(() => sse1.getText().includes("event: low_stock"));
    await waitFor(() => sse2.getText().includes("event: low_stock"));

    expect(sse1.getText()).toContain(`"itemName":"Candle"`);
    expect(sse2.getText()).toContain(`"itemName":"Candle"`);

    sse1.close();
    sse2.close();
  });

  it("subscriber is silently removed from the set when its connection closes", async () => {
    const sse = await connectSse(server, "/low-stock-events");

    await waitFor(() => sse.getText().includes(": connected"));

    // Close the SSE connection before broadcasting
    sse.close();

    // Let the close event propagate so the subscriber is de-registered
    await new Promise((resolve) => setTimeout(resolve, 100));

    // broadcastLowStock should not throw even though the connection is gone
    expect(() =>
      broadcastLowStock(WORKSPACE_ID, {
        itemName: "Dropped Item",
        locationName: "Closed Branch",
        currentStock: 0,
        baseItemId: 505,
      }),
    ).not.toThrow();
  });
});
