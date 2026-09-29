import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRelease = vi.fn();
const mockClientQuery = vi.fn();
const mockDbQuery = vi.fn();

vi.mock("./db", () => ({
  db: {
    connect: vi.fn(async () => ({
      query: mockClientQuery,
      release: mockRelease,
    })),
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: vi.fn(),
    },
  },
}));

import {
  claimMembership,
  logPageAccessDenial,
  resolveWorkspace,
  type WorkspaceRequest,
} from "./workspace";
import { clerkClient } from "@clerk/express";
import { logger } from "./logger";

describe("logPageAccessDenial", () => {
  it("records safe resolved authorization context without request credentials", () => {
    const warn = vi.fn();
    const req = {
      path: "/payment-links",
      headers: {
        authorization: "Bearer must-not-be-logged",
        cookie: "__session=must-not-be-logged",
      },
      log: { warn },
    };
    const wreq = {
      ...req,
      userId: "user_staff",
      workspaceOwnerId: "owner_123",
      workspaceRole: "member",
      workspaceActualRole: "member",
      memberDbId: 42,
      customRoleId: 7,
      customRoleIds: [7],
      allowedPages: ["cmc-pos-dashboard"],
    } as unknown as WorkspaceRequest;

    logPageAccessDenial(req as never, wreq, ["payment-links"]);

    expect(warn).toHaveBeenCalledWith(
      {
        authUserId: "user_staff",
        workspaceOwnerId: "owner_123",
        workspaceRole: "member",
        workspaceActualRole: "member",
        memberDbId: 42,
        customRoleId: 7,
        customRoleIds: [7],
        allowedPages: ["cmc-pos-dashboard"],
        requiredPages: ["payment-links"],
        requestPath: "/payment-links",
        httpStatus: 403,
        authorizationResult: "denied_before_query",
        databaseError: null,
      },
      "workspace page permission denied",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("must-not-be-logged");
  });
});

// ---------------------------------------------------------------------------
// claimMembership — no auto-created workspaces
// ---------------------------------------------------------------------------

describe("claimMembership — no auto-created workspaces", () => {
  const USER_ID = "user_abc123";
  const PRESENTAIL_EMAIL = "alice@presentail.com";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null and does not insert when a @presentail.com user has no invite and no existing membership (no auto-bootstrap)", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT ... FOR UPDATE (no existing joined row)
      .mockResolvedValueOnce({ rows: [] }) // UPDATE (no pending invite to accept)
      .mockResolvedValueOnce({ rows: [] }) // UPDATE (re-link — no existing joined row to re-link)
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await claimMembership(USER_ID, PRESENTAIL_EMAIL);

    expect(result).toBeNull();

    // The INSERT must never have been called — no new workspace created.
    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    const insertCalled = calls.some((sql) => sql.toUpperCase().startsWith("INSERT"));
    expect(insertCalled).toBe(false);
  });

  it("returns null and does not insert when the email is not @presentail.com and there is no invite", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // UPDATE (no invite)
      .mockResolvedValueOnce({ rows: [] }) // UPDATE (re-link — no match)
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await claimMembership(USER_ID, "bob@external.com");

    expect(result).toBeNull();

    // The INSERT must never have been called.
    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    const insertCalled = calls.some((sql) => sql.toUpperCase().startsWith("INSERT"));
    expect(insertCalled).toBe(false);
  });

  it("returns null when there is no email at all", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }); // COMMIT (email block skipped entirely)

    const result = await claimMembership(USER_ID, null);

    expect(result).toBeNull();
    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    const insertCalled = calls.some((sql) => sql.toUpperCase().startsWith("INSERT"));
    expect(insertCalled).toBe(false);
  });

  it("still accepts a pending invite for a @presentail.com email", async () => {
    const MAIN_OWNER_ID = "user_main_owner";

    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE (no joined row yet)
      .mockResolvedValueOnce({             // UPDATE — accept pending invite
        rows: [
          {
            workspace_owner_id: MAIN_OWNER_ID,
            role: "member",
            member_email: "taleb@presentail.com",
            custom_role_id: null,
            allowed_pages: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await claimMembership(USER_ID, "taleb@presentail.com");

    expect(result).not.toBeNull();
    expect(result!.role).toBe("member");
    expect(result!.workspace_owner_id).toBe(MAIN_OWNER_ID);

    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    const insertCalled = calls.some((sql) => sql.toUpperCase().startsWith("INSERT"));
    expect(insertCalled).toBe(false);
  });

  it("accepts a valid pending invite when the stored email casing differs from Clerk", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({
        rows: [{
          id: 41,
          workspace_owner_id: "user_main_owner",
          role: "member",
          member_email: "Member@Example.com",
          custom_role_id: null,
          revoked_at: null,
          access_expires_at: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ allowed_pages: ["orders", "cash-sessions"], custom_role_ids: [7] }],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await claimMembership(USER_ID, "member@example.com");

    expect(result?.workspace_owner_id).toBe("user_main_owner");
    expect(result?.allowed_pages).toEqual(["orders", "cash-sessions"]);
    expect(result?.custom_role_ids).toEqual([7]);
    const inviteSql = String(mockClientQuery.mock.calls[2][0]);
    expect(inviteSql).toMatch(/lower\(member_email\) = lower\(\$2\)/i);
    expect(inviteSql).toMatch(/revoked_at IS NULL/i);
    expect(inviteSql).toMatch(/access_expires_at IS NULL OR access_expires_at > NOW\(\)/i);
  });

  it("accepts a pending invite and preserves the invited role for non-owner members", async () => {
    const INVITEE_ID = "user_invitee";
    const INVITEE_EMAIL = "carol@external.com";

    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE (no joined row yet)
      .mockResolvedValueOnce({             // UPDATE — accept pending invite
        rows: [
          {
            workspace_owner_id: USER_ID,
            role: "designer",
            member_email: INVITEE_EMAIL,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await claimMembership(INVITEE_ID, INVITEE_EMAIL);

    expect(result).not.toBeNull();
    expect(result!.role).toBe("designer");
  });
});

// ---------------------------------------------------------------------------
// claimMembership — Clerk ID re-link path
// ---------------------------------------------------------------------------

describe("claimMembership — Clerk ID re-link", () => {
  const NEW_USER_ID = "user_new_clerk_id";
  const MAIN_OWNER_ID = "user_workspace_owner";
  const EMAIL = "member@presentail.com";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-links an existing joined membership to the new Clerk user ID when no pending invite exists", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE (no joined row for new user ID)
      .mockResolvedValueOnce({ rows: [] }) // UPDATE (no pending invite — member_user_id IS NULL row not found)
      .mockResolvedValueOnce({             // UPDATE (re-link — existing joined row found, updated to new ID)
        rows: [
          {
            id: 42,
            workspace_owner_id: MAIN_OWNER_ID,
            role: "member",
            member_email: EMAIL,
            custom_role_id: null,
            allowed_pages: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await claimMembership(NEW_USER_ID, EMAIL);

    expect(result).not.toBeNull();
    expect(result!.workspace_owner_id).toBe(MAIN_OWNER_ID);
    expect(result!.role).toBe("member");
    expect(result!.member_email).toBe(EMAIL);

    // The INSERT must never have been called (no new workspace created).
    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    const insertCalled = calls.some((sql) => sql.toUpperCase().startsWith("INSERT"));
    expect(insertCalled).toBe(false);
  });

  it("re-links an active joined membership when the stored email casing differs from Clerk", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // no pending invite
      .mockResolvedValueOnce({
        rows: [{
          id: 42,
          workspace_owner_id: MAIN_OWNER_ID,
          role: "member",
          member_email: "Member@Presentail.com",
          custom_role_id: null,
          revoked_at: null,
          access_expires_at: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ allowed_pages: ["orders", "cash-sessions"], custom_role_ids: [7] }],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await claimMembership(NEW_USER_ID, "member@presentail.com");

    expect(result?.workspace_owner_id).toBe(MAIN_OWNER_ID);
    expect(result?.allowed_pages).toEqual(["orders", "cash-sessions"]);
    const relinkSql = String(mockClientQuery.mock.calls[3][0]);
    expect(relinkSql).toMatch(/lower\(member_email\) = lower\(\$2\)/i);
    expect(relinkSql).toMatch(/joined_at IS NOT NULL/i);
    expect(relinkSql).toMatch(/revoked_at IS NULL/i);
    expect(relinkSql).toMatch(/access_expires_at IS NULL OR access_expires_at > NOW\(\)/i);
  });

  it("logs an info message when re-linking", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // UPDATE (no pending invite)
      .mockResolvedValueOnce({             // UPDATE (re-link — success)
        rows: [
          {
            id: 42,
            workspace_owner_id: MAIN_OWNER_ID,
            role: "member",
            member_email: EMAIL,
            custom_role_id: null,
            allowed_pages: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    await claimMembership(NEW_USER_ID, EMAIL);

    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ email: EMAIL, newUserId: NEW_USER_ID }),
      expect.stringContaining("re-linked existing membership to new Clerk user ID"),
    );
  });

  it("re-links and fetches allowed_pages when the membership has a custom_role_id", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // UPDATE (no pending invite)
      .mockResolvedValueOnce({             // UPDATE (re-link — row with custom_role_id)
        rows: [
          {
            id: 42,
            workspace_owner_id: MAIN_OWNER_ID,
            role: "custom",
            member_email: EMAIL,
            custom_role_id: 7,
            allowed_pages: null,
          },
        ],
      })
      .mockResolvedValueOnce({             // SELECT allowed_pages for custom_role_id
        rows: [{ allowed_pages: ["products", "brands"] }],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await claimMembership(NEW_USER_ID, EMAIL);

    expect(result).not.toBeNull();
    expect(result!.allowed_pages).toEqual(["products", "brands"]);
  });
});

// ---------------------------------------------------------------------------
// claimMembership — invite-acceptance UPDATE path
// ---------------------------------------------------------------------------

describe("claimMembership — invite-acceptance UPDATE path", () => {
  const OWNER_ID = "user_owner";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves role='customer_service_agent' from the accepted invite row", async () => {
    const INVITEE_ID = "user_csa";
    const INVITEE_EMAIL = "support@external.com";

    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE (no joined row)
      .mockResolvedValueOnce({             // UPDATE — accept pending invite
        rows: [
          {
            workspace_owner_id: OWNER_ID,
            role: "customer_service_agent",
            member_email: INVITEE_EMAIL,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await claimMembership(INVITEE_ID, INVITEE_EMAIL);

    expect(result).not.toBeNull();
    expect(result!.role).toBe("customer_service_agent");
    expect(result!.workspace_owner_id).toBe(OWNER_ID);
    expect(result!.member_email).toBe(INVITEE_EMAIL);
  });

  it("preserves role='designer' from the accepted invite row", async () => {
    const INVITEE_ID = "user_designer";
    const INVITEE_EMAIL = "design@agency.com";

    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE (no joined row)
      .mockResolvedValueOnce({             // UPDATE — accept pending invite
        rows: [
          {
            workspace_owner_id: OWNER_ID,
            role: "designer",
            member_email: INVITEE_EMAIL,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await claimMembership(INVITEE_ID, INVITEE_EMAIL);

    expect(result).not.toBeNull();
    expect(result!.role).toBe("designer");
    expect(result!.workspace_owner_id).toBe(OWNER_ID);
  });

  it("does not INSERT when an invite is accepted (UPDATE path returns without inserting)", async () => {
    const INVITEE_ID = "user_invitee2";
    const INVITEE_EMAIL = "invitee@partner.com";

    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({             // UPDATE — accepted
        rows: [
          {
            workspace_owner_id: OWNER_ID,
            role: "customer_service_agent",
            member_email: INVITEE_EMAIL,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    await claimMembership(INVITEE_ID, INVITEE_EMAIL);

    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    const insertCalled = calls.some((sql) => sql.toUpperCase().startsWith("INSERT"));
    expect(insertCalled).toBe(false);
  });

  it("returns early with existing joined row (race: another request already accepted the invite)", async () => {
    const INVITEE_ID = "user_race";
    const INVITEE_EMAIL = "race@external.com";

    // The SELECT FOR UPDATE inside the transaction finds a row already joined
    // by a concurrent request that won the race.
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({             // SELECT FOR UPDATE — already joined
        rows: [
          {
            workspace_owner_id: OWNER_ID,
            role: "designer",
            member_email: INVITEE_EMAIL,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await claimMembership(INVITEE_ID, INVITEE_EMAIL);

    expect(result).not.toBeNull();
    expect(result!.role).toBe("designer");

    // Neither the UPDATE nor INSERT should have been attempted.
    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    const updateCalled = calls.some((sql) => sql.toUpperCase().startsWith("UPDATE"));
    const insertCalled = calls.some((sql) => sql.toUpperCase().startsWith("INSERT"));
    expect(updateCalled).toBe(false);
    expect(insertCalled).toBe(false);
  });

  it("rolls back and rethrows when the database throws a 23505 unique-constraint error", async () => {
    const INVITEE_ID = "user_23505";
    const INVITEE_EMAIL = "clash@external.com";

    const constraintError = Object.assign(new Error("duplicate key"), { code: "23505" });

    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE (no joined row)
      .mockRejectedValueOnce(constraintError) // UPDATE throws 23505
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    await expect(claimMembership(INVITEE_ID, INVITEE_EMAIL)).rejects.toThrow("duplicate key");

    // ROLLBACK must have been issued.
    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(calls).toContain("ROLLBACK");

    // The connection must be released even on error.
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// resolveWorkspace — 23505 race-condition recovery
// ---------------------------------------------------------------------------

describe("resolveWorkspace — 23505 race-condition recovery", () => {
  const USER_ID = "user_race_ws";
  const INVITEE_EMAIL = "race@partner.com";
  const OWNER_ID = "user_workspace_owner";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeReq(userId: string) {
    return { userId } as Record<string, unknown>;
  }

  function makeRes() {
    const res: Record<string, unknown> = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res;
  }

  it("re-reads membership via findMembership when claimMembership throws 23505, and succeeds", async () => {
    const constraintError = Object.assign(new Error("duplicate key"), { code: "23505" });

    // fetchUserEmail path: clerkClient.users.getUser returns an email
    vi.mocked(clerkClient.users.getUser).mockResolvedValueOnce({
      primaryEmailAddress: { emailAddress: INVITEE_EMAIL },
    } as never);

    // Call sequence for db.query (used by findMembership):
    //   1st call — findMembership at the top of resolveWorkspace (no row yet)
    //   2nd call — findMembership inside the 23505 catch block (row now exists)
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] }) // first findMembership → no row
      .mockResolvedValueOnce({             // second findMembership (after 23505) → row found
        rows: [
          {
            workspace_owner_id: OWNER_ID,
            role: "customer_service_agent",
            member_email: INVITEE_EMAIL,
          },
        ],
      });

    // claimMembership uses db.connect → mockClientQuery.
    // It will throw a 23505 during the UPDATE step.
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE
      .mockRejectedValueOnce(constraintError) // UPDATE → 23505
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const req = makeReq(USER_ID);
    const res = makeRes();
    const next = vi.fn();

    await resolveWorkspace(
      req as never,
      res as never,
      next,
    );

    // next() should have been called, meaning workspace was resolved successfully.
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();

    // The resolved workspace should reflect the role from the re-read row.
    expect((req as Record<string, unknown>).workspaceActualRole).toBe("customer_service_agent");
    expect((req as Record<string, unknown>).workspaceRole).toBe("member");
    expect((req as Record<string, unknown>).workspaceOwnerId).toBe(OWNER_ID);
  });

  it("returns 403 when claimMembership throws 23505 and the re-read still finds no row", async () => {
    const constraintError = Object.assign(new Error("duplicate key"), { code: "23505" });

    vi.mocked(clerkClient.users.getUser).mockResolvedValueOnce({
      primaryEmailAddress: { emailAddress: "nobody@nowhere.com" },
    } as never);

    // Both findMembership calls return nothing.
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] }) // first findMembership
      .mockResolvedValueOnce({ rows: [] }); // second findMembership (after 23505)

    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE
      .mockRejectedValueOnce(constraintError) // UPDATE → 23505
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const req = makeReq(USER_ID);
    const res = makeRes();
    const next = vi.fn();

    await resolveWorkspace(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("resolveWorkspace — membership lifecycle", () => {
  const USER_ID = "user_lifecycle";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeRes() {
    const res: Record<string, unknown> = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res;
  }

  it("rejects a revoked membership without resolving workspace context", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        id: 10,
        workspace_owner_id: "owner_1",
        role: "member",
        member_email: "revoked@example.com",
        custom_role_id: null,
        custom_role_ids: [],
        allowed_pages: [],
        revoked_at: new Date(),
        access_expires_at: null,
      }],
    });
    const req = { userId: USER_ID };
    const res = makeRes();
    const next = vi.fn();

    await resolveWorkspace(req as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects an expired membership without resolving workspace context", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        id: 11,
        workspace_owner_id: "owner_1",
        role: "member",
        member_email: "expired@example.com",
        custom_role_id: null,
        custom_role_ids: [],
        allowed_pages: [],
        revoked_at: null,
        access_expires_at: new Date(Date.now() - 60_000),
      }],
    });
    const req = { userId: USER_ID };
    const res = makeRes();
    const next = vi.fn();

    await resolveWorkspace(req as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("filters revoked and expired rows in the membership lookup query", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        id: 12,
        workspace_owner_id: "owner_1",
        role: "owner",
        member_email: "active@example.com",
        custom_role_id: null,
        custom_role_ids: [],
        allowed_pages: null,
        revoked_at: null,
        access_expires_at: null,
      }],
    });
    const res = makeRes();

    await resolveWorkspace(
      { userId: USER_ID } as never,
      res as never,
      vi.fn(),
    );

    const sql = String(mockDbQuery.mock.calls[0][0]);
    expect(sql).toMatch(/revoked_at IS NULL/i);
    expect(sql).toMatch(/access_expires_at IS NULL OR wm\.access_expires_at > NOW\(\)/i);
  });

  it("resolves an active mixed-case invite into its existing workspace with page and location scope", async () => {
    vi.mocked(clerkClient.users.getUser).mockResolvedValueOnce({
      primaryEmailAddress: { emailAddress: "member@example.com" },
    } as never);
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] }) // initial findMembership
      .mockResolvedValueOnce({ rows: [{ location_id: 9 }] }); // assigned locations
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // transactional re-check
      .mockResolvedValueOnce({
        rows: [{
          id: 27,
          workspace_owner_id: "owner_existing",
          role: "member",
          member_email: "Member@Example.com",
          custom_role_id: 7,
          revoked_at: null,
          access_expires_at: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          allowed_pages: ["orders", "cash-sessions"],
          custom_role_ids: [7],
        }],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    const req = { userId: USER_ID } as Record<string, unknown>;
    const res = makeRes();
    const next = vi.fn();

    await resolveWorkspace(req as never, res as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.workspaceOwnerId).toBe("owner_existing");
    expect(req.allowedPages).toEqual(["orders", "cash-sessions"]);
    expect(req.assignedLocationIds).toEqual([9]);
  });
});
