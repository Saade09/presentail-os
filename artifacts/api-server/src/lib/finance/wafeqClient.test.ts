import { describe, expect, it, vi } from "vitest";
import {
  deterministicImportUuid,
  WafeqApiError,
  WafeqClient,
} from "./wafeqClient.js";

function response(body: unknown, status = 200): Response {
  return new Response(body === "__malformed__" ? "{" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("WafeqClient", () => {
  it("uses the documented Api-Key authorization header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      count: 0,
      next: null,
      previous: null,
      results: [],
    }));
    const client = new WafeqClient({ apiKey: "secret-api-key", fetchImpl });

    await client.searchContacts();

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Api-Key secret-api-key");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.wafeq.com/v1/contacts/");
    expect(JSON.stringify(init)).not.toContain("secret-api-key");
  });

  it("follows paginated results only on the same Wafeq origin", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({
        count: 2,
        next: "https://api.wafeq.com/v1/accounts/?page=2",
        previous: null,
        results: [{ id: "a1" }],
      }))
      .mockResolvedValueOnce(response({
        count: 2,
        next: null,
        previous: "https://api.wafeq.com/v1/accounts/",
        results: [{ id: "a2" }],
      }));

    const accounts = await new WafeqClient({ apiKey: "key", fetchImpl }).listEligibleAccounts();
    expect(accounts.map((account) => account.id)).toEqual(["a1", "a2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects an unsafe pagination URL without following it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      count: 1,
      next: "https://attacker.example/v1/accounts/?page=2",
      previous: null,
      results: [{ id: "a1" }],
    }));

    await expect(new WafeqClient({ apiKey: "key", fetchImpl }).listEligibleAccounts())
      .rejects.toMatchObject({ message: "Wafeq returned an unsafe pagination URL" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not expose malformed upstream bodies or API keys", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response("__malformed__"));
    const client = new WafeqClient({ apiKey: "very-secret-key", fetchImpl });

    await expect(client.verifyOrganization()).rejects.toMatchObject({
      message: "Wafeq returned malformed JSON",
    });
    await expect(client.verifyOrganization()).rejects.not.toThrow("very-secret-key");
  });

  it("redacts upstream error bodies and identifies rate limits", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("request body contained secret-api-key", { status: 429 }),
    );
    try {
      await new WafeqClient({ apiKey: "secret-api-key", fetchImpl }).verifyOrganization();
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WafeqApiError);
      expect(error).toMatchObject({ status: 429, rateLimited: true });
      expect((error as Error).message).toBe("Wafeq rate limit exceeded");
      expect((error as Error).message).not.toContain("secret-api-key");
    }
  });

  it("creates a deterministic UUID v4 from import identity", () => {
    const first = deterministicImportUuid(7, 42);
    expect(first).toBe(deterministicImportUuid(7, 42));
    expect(first).not.toBe(deterministicImportUuid(7, 43));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("sends the idempotency key on bill creation and validates the response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ id: "bill-1", status: "DRAFT" }, 201));
    const client = new WafeqClient({ apiKey: "key", fetchImpl });

    await client.createDraftBill({ contact: "supplier-1" }, deterministicImportUuid(1, 2));

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("X-Wafeq-Idempotency-Key")).toBe(deterministicImportUuid(1, 2));
    expect(JSON.parse(String(init.body))).toEqual({ contact: "supplier-1" });
  });
});