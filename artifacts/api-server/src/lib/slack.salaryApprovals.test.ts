import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
vi.mock("./db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockLookupByEmail = vi.fn();
const mockConversationsOpen = vi.fn();
const mockPostMessage = vi.fn();
vi.mock("@slack/web-api", () => ({
  // Must be constructible (`new WebClient(...)`) — use a regular function.
  WebClient: function WebClient(this: Record<string, unknown>) {
    this.users = { lookupByEmail: (...args: unknown[]) => mockLookupByEmail(...args) };
    this.conversations = { open: (...args: unknown[]) => mockConversationsOpen(...args) };
    this.chat = { postMessage: (...args: unknown[]) => mockPostMessage(...args) };
  },
}));

// getUncachableSlackClient reads connector settings via fetch — stub it out by
// setting env vars it expects and mocking fetch.
process.env.REPLIT_CONNECTORS_HOSTNAME = "connectors.test";
process.env.REPL_IDENTITY = "test-identity";
vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({
    items: [{ connection_settings: { access_token: "xoxp-test" }, settings: { access_token: "xoxp-test" } }],
  }),
}));

import {
  buildSalaryApprovalRequestText,
  buildSalaryDecisionText,
  salaryApprovalLink,
  sendSlackDmByEmail,
  findSalaryApproverEmails,
  notifySalaryApprovalRequested,
  notifySalaryDecisionToRequester,
} from "./slack";

beforeEach(() => {
  vi.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ---------------------------------------------------------------------------
// Message builders (pure)
// ---------------------------------------------------------------------------

describe("salary approval message builders", () => {
  it("request text includes type, payee, requester, amount+currency, and the OS deep link", () => {
    const text = buildSalaryApprovalRequestText({
      payee: "Ahmad Saade",
      amount: "1500.00",
      currency: "USD",
      requesterName: "Lina K",
      paymentTypeLabel: "salary",
      sessionNumber: "CS-1",
      transactionId: 55,
    });
    expect(text).toContain("Salaries & Wages");
    expect(text).toContain("Ahmad Saade");
    expect(text).toContain("Lina K");
    expect(text).toContain("1500.00 USD");
    expect(text).toContain("CS-1");
    expect(text).toContain(salaryApprovalLink(55));
    expect(salaryApprovalLink(55)).toBe("https://os.presentail.com/cash-approvals?tx=55");
  });

  it("decision text covers approved and declined (with reason)", () => {
    const approved = buildSalaryDecisionText({ payee: "Ahmad", amount: "100.00", currency: "USD", approved: true });
    expect(approved).toContain("was approved");
    const declined = buildSalaryDecisionText({
      payee: "Ahmad", amount: "100.00", currency: "USD", approved: false, reason: "Wrong amount",
    });
    expect(declined).toContain("was declined");
    expect(declined).toContain("Wrong amount");
  });
});

// ---------------------------------------------------------------------------
// DM sending
// ---------------------------------------------------------------------------

describe("sendSlackDmByEmail", () => {
  it("looks up by email, opens a DM, and posts the message", async () => {
    mockLookupByEmail.mockResolvedValue({ ok: true, user: { id: "U123" } });
    mockConversationsOpen.mockResolvedValue({ ok: true, channel: { id: "D456" } });
    mockPostMessage.mockResolvedValue({ ok: true });

    const sent = await sendSlackDmByEmail("bd@presentail.com", "hello");
    expect(sent).toBe(true);
    expect(mockLookupByEmail).toHaveBeenCalledWith({ email: "bd@presentail.com" });
    expect(mockConversationsOpen).toHaveBeenCalledWith({ users: "U123" });
    expect(mockPostMessage).toHaveBeenCalledWith({ channel: "D456", text: "hello" });
  });

  it("returns false (never throws) when the email has no Slack match", async () => {
    mockLookupByEmail.mockRejectedValue(new Error("users_not_found"));
    const sent = await sendSlackDmByEmail("nobody@presentail.com", "hello");
    expect(sent).toBe(false);
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it("returns false (never throws) when posting fails", async () => {
    mockLookupByEmail.mockResolvedValue({ ok: true, user: { id: "U123" } });
    mockConversationsOpen.mockResolvedValue({ ok: true, channel: { id: "D456" } });
    mockPostMessage.mockRejectedValue(new Error("ratelimited"));
    const sent = await sendSlackDmByEmail("bd@presentail.com", "hello");
    expect(sent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Approver resolution
// ---------------------------------------------------------------------------

describe("findSalaryApproverEmails", () => {
  it("returns Business Development role holder emails when present", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ member_email: "bd1@x.com" }, { member_email: "bd2@x.com" }] });
    const emails = await findSalaryApproverEmails("owner_123");
    expect(emails).toEqual(["bd1@x.com", "bd2@x.com"]);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("falls back to owners/admins when nobody holds the role", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] })                                   // BD role holders → none
      .mockResolvedValueOnce({ rows: [{ member_email: "owner@x.com" }] });   // owners fallback
    const emails = await findSalaryApproverEmails("owner_123");
    expect(emails).toEqual(["owner@x.com"]);
  });
});

// ---------------------------------------------------------------------------
// Notify wrappers never throw
// ---------------------------------------------------------------------------

describe("notify wrappers are best-effort", () => {
  it("notifySalaryApprovalRequested swallows db errors", async () => {
    mockDbQuery.mockRejectedValue(new Error("db down"));
    await expect(
      notifySalaryApprovalRequested({
        workspaceOwnerId: "owner_123",
        fields: {
          payee: "A", amount: "1.00", currency: "USD", requesterName: "R",
          paymentTypeLabel: null, sessionNumber: null, transactionId: 1,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("notifySalaryDecisionToRequester is a no-op without a resolvable email", async () => {
    await expect(
      notifySalaryDecisionToRequester({
        requesterEmail: null,
        fields: { payee: "A", amount: "1.00", currency: "USD", approved: true },
      }),
    ).resolves.toBeUndefined();
    expect(mockLookupByEmail).not.toHaveBeenCalled();
  });
});
