import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockGetUserList = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUserList: (...args: unknown[]) => mockGetUserList(...args),
    },
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

let stubWorkspaceOwnerId = "owner_111";
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubUserId = "user_owner_abc";
let stubUserEmail: string | null = "owner@example.com";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.userId = stubUserId;
    wreq.userEmail = stubUserEmail;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

import peopleRouter, { _resetTeamMembersTableExistsForTesting } from "./people";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

const mockReqLog = vi.fn();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, typeof mockReqLog> }).log = {
      error: mockReqLog,
      warn: mockReqLog,
      info: mockReqLog,
    };
    next();
  });
  app.use(peopleRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Shared fixture rows
// ---------------------------------------------------------------------------

const MEMBER_ROWS = { rows: [] };

const TEAM_MEMBER_ROWS = {
  rows: [
    {
      id: 7,
      first_name: "Alice",
      last_name: "Smith",
      email: "alice@example.com",
      phone: "+1-555-0100",
      job_title: "Engineer",
      department_name: "Engineering",
      employment_status: "full_time",
      archived_at: null,
    },
  ],
};

const PROFILE_ROWS = {
  rows: [
    {
      team_member_id: 7,
      person_id: 42,
      profile_id: 99,
      employee_code: "EMP-007",
      start_date: "2022-01-15",
    },
  ],
};

const ENRICH_ROW = {
  birthday: "1990-03-14",
  tm_emergency_name: "Bob Smith",
  tm_emergency_phone: "+1-555-0200",
  emergency_contact_relationship: "Spouse",
  notes: "Allergic to peanuts",
  manager_name: "Carol Jones",
  work_schedule_name: "Morning Shift",
  employment_type: "full_time",
  attendance_enabled: true,
  profile_status: "active",
  profile_emergency_name: null,
  profile_emergency_phone: null,
};

const EXTERNAL_PROFILES_EMPTY = { rows: [] };

// ---------------------------------------------------------------------------
// GET /people/:id — enriched detail
// ---------------------------------------------------------------------------

describe("GET /people/:id", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "owner";

    // Default: buildPeopleList queries return the standard fixture
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_ROWS)          // workspace_members
      .mockResolvedValueOnce(TEAM_MEMBER_ROWS)     // team_members
      .mockResolvedValueOnce(PROFILE_ROWS)        // team_member_profiles
      .mockResolvedValueOnce(EXTERNAL_PROFILES_EMPTY) // external_profiles
      .mockResolvedValueOnce({ rows: [] });         // team_member Clerk email lookup
  });

  it("returns full enriched detail when team_member_id is present", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [ENRICH_ROW] }); // enrichment query

    const res = await request(makeApp()).get("/people/tm_7");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "tm_7",
      first_name: "Alice",
      last_name: "Smith",
      team_member_id: 7,
      profile_id: 99,
      employee_code: "EMP-007",
      start_date: "2022-01-15",
      birthday: "1990-03-14",
      emergency_contact_name: "Bob Smith",
      emergency_contact_phone: "+1-555-0200",
      emergency_contact_relationship: "Spouse",
      notes: "Allergic to peanuts",
      manager_name: "Carol Jones",
      work_schedule_name: "Morning Shift",
      employment_type: "full_time",
      attendance_enabled: true,
      profile_status: "active",
    });
  });

  it("prefers profile emergency fields over team_member fields when both present", async () => {
    const enrichWithProfile = {
      ...ENRICH_ROW,
      profile_emergency_name: "Profile Contact",
      profile_emergency_phone: "+1-555-9999",
    };
    mockDbQuery.mockResolvedValueOnce({ rows: [enrichWithProfile] });

    const res = await request(makeApp()).get("/people/tm_7");

    expect(res.status).toBe(200);
    expect(res.body.emergency_contact_name).toBe("Profile Contact");
    expect(res.body.emergency_contact_phone).toBe("+1-555-9999");
  });

  it("falls back gracefully when no team_member_profiles row exists (null HR fields)", async () => {
    // No profile row returned for this team member
    mockDbQuery
      .mockReset()
      .mockResolvedValueOnce(MEMBER_ROWS)       // workspace_members
      .mockResolvedValueOnce(TEAM_MEMBER_ROWS)  // team_members
      .mockResolvedValueOnce({ rows: [] })      // team_member_profiles — empty
      .mockResolvedValueOnce(EXTERNAL_PROFILES_EMPTY) // external_profiles
      .mockResolvedValueOnce({ rows: [] });     // team_member Clerk email lookup

    // Enrichment query still runs but returns the base team_member data with no profile
    const enrichNoProfile = {
      birthday: null,
      tm_emergency_name: null,
      tm_emergency_phone: null,
      emergency_contact_relationship: null,
      notes: null,
      manager_name: null,
      work_schedule_name: null,
      employment_type: null,
      attendance_enabled: null,
      profile_status: null,
      profile_emergency_name: null,
      profile_emergency_phone: null,
    };
    mockDbQuery.mockResolvedValueOnce({ rows: [enrichNoProfile] });

    const res = await request(makeApp()).get("/people/tm_7");

    expect(res.status).toBe(200);
    expect(res.body.team_member_id).toBe(7);
    expect(res.body.profile_id).toBeNull();
    expect(res.body.birthday).toBeNull();
    expect(res.body.manager_name).toBeNull();
    expect(res.body.work_schedule_name).toBeNull();
    expect(res.body.attendance_enabled).toBeNull();
    expect(res.body.profile_status).toBeNull();
    expect(res.body.emergency_contact_name).toBeNull();
  });

  it("returns 404 when the composite ID doesn't match any person", async () => {
    const res = await request(makeApp()).get("/people/tm_9999");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Person not found" });
    // Enrichment query should NOT have been called (but email lookup still runs)
    expect(mockDbQuery).toHaveBeenCalledTimes(5);
  });

  it("returns 404 when a wm_ id doesn't match any workspace member", async () => {
    const res = await request(makeApp()).get("/people/wm_9999");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Person not found" });
  });

  it("skips enrichment query when person has no team_member_id (member-only record)", async () => {
    // A workspace member with no corresponding team_member row
    const memberOnlyRows = {
      rows: [
        {
          id: 55,
          email: "memberonly@example.com",
          role: "member",
          custom_role_id: null,
          role_name: null,
          member_user_id: "user_abc",
          joined: true,
          joined_at: "2023-01-01T00:00:00Z",
          invited_at: "2022-12-01T00:00:00Z",
          job_title: "Analyst",
          employment_type: "full_time",
          employment_status: "full_time",
        },
      ],
    };

    mockDbQuery
      .mockReset()
      .mockResolvedValueOnce(memberOnlyRows)   // workspace_members
      .mockResolvedValueOnce({ rows: [] })     // workspace_member_roles (id:55 triggers lookup)
      .mockResolvedValueOnce({ rows: [] })     // team_members — empty
      .mockResolvedValueOnce({ rows: [] })    // team_member_profiles — empty
      .mockResolvedValueOnce(EXTERNAL_PROFILES_EMPTY); // external_profiles

    const res = await request(makeApp()).get("/people/wm_55");

    expect(res.status).toBe(200);
    expect(res.body.member_id).toBe(55);
    expect(res.body.team_member_id).toBeNull();
    // All HR enrichment fields should be null (no team_member_id → no extra query)
    expect(res.body.birthday).toBeNull();
    expect(res.body.manager_name).toBeNull();
    expect(res.body.work_schedule_name).toBeNull();
    // Enrichment query was NOT fired — still only 5 queries total
    expect(mockDbQuery).toHaveBeenCalledTimes(5);
  });

  it("issues the enrichment query with correct workspaceOwnerId and team_member_id", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [ENRICH_ROW] });

    await request(makeApp()).get("/people/tm_7");

    // The 6th call is the enrichment query (after WM, TM, profiles, external, email-lookup)
    const enrichCall = mockDbQuery.mock.calls[5];
    expect(enrichCall[1]).toEqual(["owner_111", 7]);
  });
});

// ---------------------------------------------------------------------------
// PATCH /people/:id — email-change sync scenarios (unit, no real DB)
// ---------------------------------------------------------------------------

describe("PATCH /people/:id — email-change sync", () => {
  // DB query order inside the handler for an email PATCH on tm_7:
  //  [0] SELECT id FROM team_members          (existence check)
  //  [1] SELECT before-state                  (read current values for audit logging)
  //  [2] UPDATE team_members SET …            (field update — email is in tmAllowed)
  //  [3] SELECT id, person_id FROM team_member_profiles  (find linked profile)
  //  [4] email-specific query (varies by scenario)
  //  [5] (scenario 1 & 2 only) second email-specific query
  //  [x] INSERT INTO people_audit_log …      (one row per changed field)
  //  then buildPeopleList: [workspace_members, team_members, team_member_profiles]
  //  then enrichPersonDetail enrichment query

  const TM_EXISTS = { rows: [{ id: 7 }] };
  const UPDATE_OK = { rows: [] };
  const PROFILE_LINKED = { rows: [{ id: 99, person_id: 42 }] };

  // Before-state fixture matching the handler's SELECT + LEFT JOIN
  const BEFORE_STATE = {
    rows: [
      {
        first_name: "Alice",
        last_name: "Smith",
        email: "alice@example.com",
        phone: "+1-555-0100",
        department_id: 1,
        employment_status: "full_time",
        manager_id: 2,
        work_schedule_id: 3,
        birthday: "1990-03-14",
        start_date: "2022-01-15",
        emergency_contact_name: "Bob Smith",
        emergency_contact_phone: "+1-555-0200",
        emergency_contact_relationship: "Spouse",
        notes: "Allergic to peanuts",
        job_title: "Engineer",
        attendance_enabled: false,
      },
    ],
  };

  // Standard tail mocks shared by all scenarios: buildPeopleList + enrichment
  function mockTail() {
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_ROWS)        // buildPeopleList: workspace_members
      .mockResolvedValueOnce(TEAM_MEMBER_ROWS)   // buildPeopleList: team_members
      .mockResolvedValueOnce(PROFILE_ROWS)       // buildPeopleList: team_member_profiles
      .mockResolvedValueOnce(EXTERNAL_PROFILES_EMPTY) // buildPeopleList: external_profiles
      .mockResolvedValueOnce({ rows: [] })       // team_member Clerk email lookup
      .mockResolvedValueOnce({ rows: [ENRICH_ROW] }); // enrichPersonDetail
  }

  beforeEach(() => {
    vi.resetAllMocks();
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "owner";
  });

  it("scenario 1: new unique email — updates the people row email", async () => {
    const newEmail = "new-unique@example.com";

    mockDbQuery
      .mockResolvedValueOnce(TM_EXISTS)       // [0] team_member check
      .mockResolvedValueOnce(BEFORE_STATE)      // [1] before-state read
      .mockResolvedValueOnce(UPDATE_OK)         // [2] UPDATE team_members
      .mockResolvedValueOnce(PROFILE_LINKED)    // [3] SELECT profile
      .mockResolvedValueOnce({ rows: [] })     // [4] SELECT people by email → no match
      .mockResolvedValueOnce(UPDATE_OK)         // [5] UPDATE people SET email = newEmail
      .mockResolvedValueOnce(UPDATE_OK);       // [6] INSERT INTO people_audit_log

    mockTail();

    const res = await request(makeApp())
      .patch("/people/tm_7")
      .send({ email: newEmail });

    expect(res.status).toBe(200);

    // [4] must query people by the new email
    const checkEmailCall = mockDbQuery.mock.calls[4];
    expect(checkEmailCall[1]).toEqual(["owner_111", newEmail]);

    // [5] must UPDATE people.email to the new value
    const updatePeopleCall = mockDbQuery.mock.calls[5];
    expect(updatePeopleCall[1]).toEqual([newEmail, 42, "owner_111"]);

    // [6] must insert the audit log row for the email change
    const auditCall = mockDbQuery.mock.calls[6];
    expect(auditCall[0]).toContain("INSERT INTO people_audit_log");
    expect(auditCall[1]).toEqual(["owner_111", 7, "user_owner_abc", "email", "alice@example.com", newEmail]);
  });

  it("scenario 2: email matches an existing people row — re-links the profile", async () => {
    const existingEmail = "already-exists@example.com";
    const existingPersonId = 55; // a different person row from the currently linked one (42)

    mockDbQuery
      .mockResolvedValueOnce(TM_EXISTS)                              // [0] team_member check
      .mockResolvedValueOnce(BEFORE_STATE)                             // [1] before-state read
      .mockResolvedValueOnce(UPDATE_OK)                              // [2] UPDATE team_members
      .mockResolvedValueOnce(PROFILE_LINKED)                         // [3] SELECT profile (person_id=42)
      .mockResolvedValueOnce({ rows: [{ id: existingPersonId }] })    // [4] SELECT people → match (id=55)
      .mockResolvedValueOnce(UPDATE_OK)                              // [5] UPDATE team_member_profiles SET person_id=55
      .mockResolvedValueOnce(UPDATE_OK);                             // [6] INSERT INTO people_audit_log

    mockTail();

    const res = await request(makeApp())
      .patch("/people/tm_7")
      .send({ email: existingEmail });

    expect(res.status).toBe(200);

    // [4] must look up the new email in people
    const checkEmailCall = mockDbQuery.mock.calls[4];
    expect(checkEmailCall[1]).toEqual(["owner_111", existingEmail]);

    // [5] must re-link the profile to the matched person row (person_id=55, profile id=99)
    const relinkCall = mockDbQuery.mock.calls[5];
    expect(relinkCall[1]).toEqual([existingPersonId, 99, "owner_111"]);
  });

  it("scenario 4: email matches the already-linked person_id — no re-link UPDATE issued", async () => {
    const samePersonEmail = "same-person@example.com";
    // PROFILE_LINKED has person_id=42; matching people row also has id=42 → no-op branch
    const SAME_PERSON_MATCH = { rows: [{ id: 42 }] };

    mockDbQuery
      .mockResolvedValueOnce(TM_EXISTS)          // [0] team_member check
      .mockResolvedValueOnce(BEFORE_STATE)       // [1] before-state read
      .mockResolvedValueOnce(UPDATE_OK)          // [2] UPDATE team_members SET email
      .mockResolvedValueOnce(PROFILE_LINKED)     // [3] SELECT profile (person_id=42)
      .mockResolvedValueOnce(SAME_PERSON_MATCH)  // [4] SELECT people → match id=42 (same)
      .mockResolvedValueOnce(UPDATE_OK);         // [5] INSERT people_audit_log (email changed)

    mockTail();

    const res = await request(makeApp())
      .patch("/people/tm_7")
      .send({ email: samePersonEmail });

    expect(res.status).toBe(200);

    // [4] must look up the new email in people
    const checkEmailCall = mockDbQuery.mock.calls[4];
    expect(checkEmailCall[1]).toEqual(["owner_111", samePersonEmail]);

    // Total must be 12 — the re-link UPDATE is skipped (matchedPersonId=42 === profile.person_id=42)
    // [0] check TM, [1] before-state, [2] UPDATE TM, [3] SELECT profile, [4] SELECT people,
    // [5] audit INSERT, [6] WM, [7] TM list, [8] profiles list, [9] external,
    // [10] email-lookup, [11] enrich
    expect(mockDbQuery).toHaveBeenCalledTimes(12);
  });

  it("scenario 3: email cleared — sets people row email to null", async () => {
    mockDbQuery
      .mockResolvedValueOnce(TM_EXISTS)      // [0] team_member check
      .mockResolvedValueOnce(BEFORE_STATE)   // [1] before-state read
      .mockResolvedValueOnce(UPDATE_OK)      // [2] UPDATE team_members SET email=NULL
      .mockResolvedValueOnce(PROFILE_LINKED) // [3] SELECT profile
      .mockResolvedValueOnce(UPDATE_OK)      // [4] UPDATE people SET email=NULL
      .mockResolvedValueOnce(UPDATE_OK);     // [5] INSERT INTO people_audit_log

    mockTail();

    const res = await request(makeApp())
      .patch("/people/tm_7")
      .send({ email: "" });

    expect(res.status).toBe(200);

    // [4] must clear the email on the people row (person_id=42)
    const clearEmailCall = mockDbQuery.mock.calls[4];
    expect(clearEmailCall[1]).toEqual([42, "owner_111"]);

    // Confirm 12 total DB calls
    // [0] check TM, [1] before-state, [2] UPDATE TM, [3] SELECT profile,
    // [4] UPDATE people, [5] audit INSERT, [6] WM, [7] TM list, [8] profiles list,
    // [9] external, [10] email-lookup, [11] enrich
    expect(mockDbQuery).toHaveBeenCalledTimes(12);
  });
});

// ---------------------------------------------------------------------------
// POST /people — create a new team member
// ---------------------------------------------------------------------------

describe("POST /people", () => {
  // DB query order when creating without email:
  //  [0] INSERT INTO team_members          → returns { id: newTmId }
  //  [1] INSERT INTO people                → returns { id: newPersonId }
  //  [2] INSERT INTO team_member_profiles
  //  then buildPeopleList: [3] workspace_members, [4] team_members, [5] team_member_profiles

  // DB query order when creating with email (no existing people row):
  //  [0] INSERT INTO team_members          → returns { id: newTmId }
  //  [1] SELECT id FROM people (email check) → { rows: [] }
  //  [2] INSERT INTO people                → returns { id: newPersonId }
  //  [3] INSERT INTO team_member_profiles
  //  then buildPeopleList: [4] workspace_members, [5] team_members, [6] team_member_profiles

  const NEW_TM_ID = 42;
  const NEW_PERSON_ID = 10;

  const NEW_TM_ROWS = {
    rows: [
      {
        id: NEW_TM_ID,
        first_name: "Bob",
        last_name: null,
        email: null,
        phone: null,
        department_name: null,
        employment_status: "full_time",
        archived_at: null,
      },
    ],
  };

  const NEW_PROFILE_ROWS = {
    rows: [
      {
        team_member_id: NEW_TM_ID,
        person_id: NEW_PERSON_ID,
        profile_id: 5,
        employee_code: null,
        start_date: null,
      },
    ],
  };

  beforeEach(() => {
    vi.resetAllMocks();
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "owner";
  });

  it("success (no email): inserts team_member + people + profile and returns 201", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: NEW_TM_ID }] })  // [0] INSERT team_members
      .mockResolvedValueOnce({ rows: [{ id: NEW_PERSON_ID }] }) // [1] INSERT people (no-email path)
      .mockResolvedValueOnce({ rows: [] })                     // [2] INSERT team_member_profiles
      .mockResolvedValueOnce(MEMBER_ROWS)                      // [3] buildPeopleList: workspace_members
      .mockResolvedValueOnce(NEW_TM_ROWS)                      // [4] buildPeopleList: team_members
      .mockResolvedValueOnce(NEW_PROFILE_ROWS)                // [5] buildPeopleList: team_member_profiles
      .mockResolvedValueOnce(EXTERNAL_PROFILES_EMPTY);        // [6] buildPeopleList: external_profiles

    const res = await request(makeApp())
      .post("/people")
      .send({ first_name: "Bob" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: `tm_${NEW_TM_ID}`,
      first_name: "Bob",
      team_member_id: NEW_TM_ID,
      source: "team_member",
    });
  });

  it("success (with email, no existing people row): inserts team_member, checks people, inserts people + profile", async () => {
    const NEW_EMAIL_TM_ROWS = {
      rows: [
        {
          id: NEW_TM_ID,
          first_name: "Carol",
          last_name: null,
          email: "carol@example.com",
          phone: null,
          department_name: null,
          employment_status: "full_time",
          archived_at: null,
        },
      ],
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [] })                      // [0] dupCheck → no duplicate
      .mockResolvedValueOnce({ rows: [{ id: NEW_TM_ID }] })     // [1] INSERT team_members
      .mockResolvedValueOnce({ rows: [] })                     // [2] SELECT people by email → no match
      .mockResolvedValueOnce({ rows: [{ id: NEW_PERSON_ID }] }) // [3] INSERT people
      .mockResolvedValueOnce({ rows: [] })                     // [4] INSERT team_member_profiles
      .mockResolvedValueOnce(MEMBER_ROWS)                      // [5] buildPeopleList: workspace_members
      .mockResolvedValueOnce(NEW_EMAIL_TM_ROWS)                // [6] buildPeopleList: team_members
      .mockResolvedValueOnce(NEW_PROFILE_ROWS)               // [7] buildPeopleList: team_member_profiles
      .mockResolvedValueOnce(EXTERNAL_PROFILES_EMPTY);         // [8] buildPeopleList: external_profiles

    const res = await request(makeApp())
      .post("/people")
      .send({ first_name: "Carol", email: "carol@example.com" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: `tm_${NEW_TM_ID}`,
      first_name: "Carol",
      email: "carol@example.com",
      team_member_id: NEW_TM_ID,
    });

    // [2] must have checked people table for the given email
    const emailCheckCall = mockDbQuery.mock.calls[2];
    expect(emailCheckCall[1]).toEqual(["owner_111", "carol@example.com"]);
  });

  it("success (with email, existing people row): re-uses existing people id", async () => {
    const EXISTING_PERSON_ID = 99;

    mockDbQuery
      .mockResolvedValueOnce({ rows: [] })                      // [0] dupCheck → no duplicate
      .mockResolvedValueOnce({ rows: [{ id: NEW_TM_ID }] })     // [1] INSERT team_members
      .mockResolvedValueOnce({ rows: [{ id: EXISTING_PERSON_ID }] }) // [2] SELECT people → match
      .mockResolvedValueOnce({ rows: [] })                           // [3] INSERT team_member_profiles
      .mockResolvedValueOnce(MEMBER_ROWS)                            // [4] buildPeopleList: workspace_members
      .mockResolvedValueOnce(NEW_TM_ROWS)                            // [5] buildPeopleList: team_members
      .mockResolvedValueOnce(NEW_PROFILE_ROWS)                      // [6] buildPeopleList: team_member_profiles
      .mockResolvedValueOnce(EXTERNAL_PROFILES_EMPTY);              // [7] buildPeopleList: external_profiles

    const res = await request(makeApp())
      .post("/people")
      .send({ first_name: "Bob", email: "existing@example.com" });

    expect(res.status).toBe(201);

    // team_member_profiles insert must use the existing person id, not a newly created one
    const profileInsertCall = mockDbQuery.mock.calls[3];
    expect(profileInsertCall[1][0]).toBe(EXISTING_PERSON_ID);
  });

  it("returns 403 for non-owner", async () => {
    stubWorkspaceRole = "member";

    const res = await request(makeApp())
      .post("/people")
      .send({ first_name: "Bob" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Only owners can add people" });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when first_name is missing", async () => {
    const res = await request(makeApp())
      .post("/people")
      .send({ last_name: "Smith" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "first_name is required" });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when first_name is an empty string", async () => {
    const res = await request(makeApp())
      .post("/people")
      .send({ first_name: "  " });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "first_name is required" });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PATCH /people/:id — basic access and validation (non email-sync paths)
// ---------------------------------------------------------------------------

describe("PATCH /people/:id — basic cases", () => {
  // DB query order for a first_name-only update on tm_7:
  //  [0] SELECT id FROM team_members       (existence check)
  //  [1] UPDATE team_members SET first_name
  //  [2] SELECT id, person_id FROM team_member_profiles  (name/phone sync lookup)
  //  [3] UPDATE people SET first_name
  //  then buildPeopleList: [4] workspace_members, [5] team_members, [6] team_member_profiles, [7] external_profiles
  //  then enrichPersonDetail: [8]

  const TM_EXISTS = { rows: [{ id: 7 }] };
  const UPDATE_OK = { rows: [] };
  const PROFILE_LINKED = { rows: [{ id: 99, person_id: 42 }] };

  function mockTail() {
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_ROWS)
      .mockResolvedValueOnce(TEAM_MEMBER_ROWS)
      .mockResolvedValueOnce(PROFILE_ROWS)
      .mockResolvedValueOnce(EXTERNAL_PROFILES_EMPTY)
      .mockResolvedValueOnce({ rows: [] })             // team_member Clerk email lookup
      .mockResolvedValueOnce({ rows: [ENRICH_ROW] });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "owner";
  });

  it("success: updates first_name and returns enriched person", async () => {
    // DB query order for { first_name } update:
    //  [0] existence check, [1] before-state, [2] UPDATE team_members,
    //  [3] name/phone sync lookup, [4] UPDATE people, [5] INSERT audit log
    const BEFORE_STATE_BASIC = {
      rows: [
        {
          first_name: "Alice", last_name: "Smith", email: null, phone: null,
          department_id: null, employment_status: "full_time", manager_id: null,
          work_schedule_id: null, birthday: null, start_date: null,
          emergency_contact_name: null, emergency_contact_phone: null,
          emergency_contact_relationship: null, notes: null,
          job_title: null, attendance_enabled: null,
        },
      ],
    };

    mockDbQuery
      .mockResolvedValueOnce(TM_EXISTS)           // [0] existence check
      .mockResolvedValueOnce(BEFORE_STATE_BASIC)  // [1] before-state read
      .mockResolvedValueOnce(UPDATE_OK)           // [2] UPDATE team_members SET first_name
      .mockResolvedValueOnce(PROFILE_LINKED)      // [3] name/phone sync lookup
      .mockResolvedValueOnce(UPDATE_OK)           // [4] UPDATE people SET first_name
      .mockResolvedValueOnce(UPDATE_OK);          // [5] INSERT people_audit_log

    mockTail();

    const res = await request(makeApp())
      .patch("/people/tm_7")
      .send({ first_name: "Updated" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ team_member_id: 7 });
  });

  it("returns 403 for non-owner", async () => {
    stubWorkspaceRole = "member";

    const res = await request(makeApp())
      .patch("/people/tm_7")
      .send({ first_name: "Updated" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Only owners can update people" });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when team_member does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // existence check → empty

    const res = await request(makeApp())
      .patch("/people/tm_9999")
      .send({ first_name: "Updated" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Person not found" });
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when no updatable fields are provided", async () => {
    // Handler reads before-state before checking for updatable fields,
    // so two DB calls fire: existence check + before-state read.
    mockDbQuery
      .mockResolvedValueOnce(TM_EXISTS)           // [0] existence check
      .mockResolvedValueOnce({ rows: [{}] });     // [1] before-state read (empty state)

    const res = await request(makeApp())
      .patch("/people/tm_7")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "No fields to update" });
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it("returns 400 for non tm_ prefixed IDs", async () => {
    const res = await request(makeApp())
      .patch("/people/wm_55")
      .send({ first_name: "Updated" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("tm_") });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE /people/:id — archive a team member
// ---------------------------------------------------------------------------

describe("DELETE /people/:id", () => {
  // DB query order:
  //  [0] UPDATE team_members SET archived_at … WHERE … AND archived_at IS NULL RETURNING id

  beforeEach(() => {
    vi.resetAllMocks();
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "owner";
  });

  it("success: archives the team_member and returns 204", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 7 }] }); // UPDATE returns the row

    const res = await request(makeApp()).delete("/people/tm_7");

    expect(res.status).toBe(204);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);

    // The query must scope to the correct workspace and team_member id
    const archiveCall = mockDbQuery.mock.calls[0];
    expect(archiveCall[1]).toEqual(["owner_111", 7]);
  });

  it("returns 403 for non-owner", async () => {
    stubWorkspaceRole = "member";

    const res = await request(makeApp()).delete("/people/tm_7");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Only owners can remove people" });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when team_member not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE returns nothing

    const res = await request(makeApp()).delete("/people/tm_9999");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Person not found" });
  });

  it("returns 404 when team_member is already archived", async () => {
    // The WHERE clause includes archived_at IS NULL so an already-archived row
    // won't match, and UPDATE returns 0 rows
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp()).delete("/people/tm_7");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Person not found" });
  });

  it("returns 400 for non tm_ prefixed IDs", async () => {
    const res = await request(makeApp()).delete("/people/wm_55");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("tm_") });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PATCH /people/:id — audit log writes for HR field changes
// ---------------------------------------------------------------------------

describe("PATCH /people/:id — audit log writes", () => {
  // DB query order for { job_title, manager_id } on tm_7:
  //  [0] SELECT id FROM team_members           (existence check)
  //  [1] SELECT before-state                   (read current values for audit log)
  //  [2] UPDATE team_members SET manager_id    (manager_id is in tmAllowed)
  //  [3] SELECT id FROM team_member_profiles   (job_title profile sync lookup)
  //  [4] UPDATE team_member_profiles SET job_title
  //  [5] INSERT INTO people_audit_log          (two rows: manager_id + job_title)
  //  then buildPeopleList: [6] workspace_members, [7] team_members, [8] profiles
  //  then enrichPersonDetail: [9]

  const TM_EXISTS = { rows: [{ id: 7 }] };
  const UPDATE_OK = { rows: [] };
  const PROFILE_FOR_JT_SYNC = { rows: [{ id: 99 }] };

  const BEFORE_STATE = {
    rows: [
      {
        first_name: "Alice",
        last_name: "Smith",
        email: "alice@example.com",
        phone: "+1-555-0100",
        department_id: 1,
        employment_status: "full_time",
        manager_id: 2,
        work_schedule_id: 3,
        birthday: "1990-03-14",
        start_date: "2022-01-15",
        emergency_contact_name: "Bob Smith",
        emergency_contact_phone: "+1-555-0200",
        emergency_contact_relationship: "Spouse",
        notes: "Allergic to peanuts",
        job_title: "Engineer",
        attendance_enabled: false,
      },
    ],
  };

  function mockTail() {
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_ROWS)
      .mockResolvedValueOnce(TEAM_MEMBER_ROWS)
      .mockResolvedValueOnce(PROFILE_ROWS)
      .mockResolvedValueOnce(EXTERNAL_PROFILES_EMPTY)
      .mockResolvedValueOnce({ rows: [] })             // team_member Clerk email lookup
      .mockResolvedValueOnce({ rows: [ENRICH_ROW] });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "owner";
  });

  it("writes audit rows for job_title and manager_id changes with correct old/new values and changed_by_user_id", async () => {
    mockDbQuery
      .mockResolvedValueOnce(TM_EXISTS)           // [0] existence check
      .mockResolvedValueOnce(BEFORE_STATE)         // [1] before-state read
      .mockResolvedValueOnce(UPDATE_OK)            // [2] UPDATE team_members SET manager_id
      .mockResolvedValueOnce(PROFILE_FOR_JT_SYNC)  // [3] SELECT profile (job_title sync)
      .mockResolvedValueOnce(UPDATE_OK)            // [4] UPDATE team_member_profiles SET job_title
      .mockResolvedValueOnce(UPDATE_OK);           // [5] INSERT INTO people_audit_log

    mockTail();

    const res = await request(makeApp())
      .patch("/people/tm_7")
      .send({ job_title: "Senior Engineer", manager_id: 5 });

    expect(res.status).toBe(200);

    // [5] must be the audit log INSERT
    const auditCall = mockDbQuery.mock.calls[5];
    expect(auditCall[0]).toContain("INSERT INTO people_audit_log");

    // Params: [workspaceOwnerId, tmId, userId, field1, oldVal1, newVal1, field2, oldVal2, newVal2]
    // auditableFields order places manager_id before job_title
    expect(auditCall[1]).toEqual([
      "owner_111",
      7,
      "user_owner_abc",
      "manager_id", "2", "5",
      "job_title", "Engineer", "Senior Engineer",
    ]);
  });

  it("returns 200 even when the people_audit_log INSERT fails after the update succeeds", async () => {
    mockDbQuery
      .mockResolvedValueOnce(TM_EXISTS)           // [0] existence check
      .mockResolvedValueOnce(BEFORE_STATE)         // [1] before-state read
      .mockResolvedValueOnce(UPDATE_OK)            // [2] UPDATE team_members SET manager_id
      .mockResolvedValueOnce(PROFILE_FOR_JT_SYNC)  // [3] SELECT profile (job_title sync)
      .mockResolvedValueOnce(UPDATE_OK)            // [4] UPDATE team_member_profiles SET job_title
      .mockRejectedValueOnce(new Error("people_audit_log table missing")); // [5] audit log fails

    mockTail();

    const res = await request(makeApp())
      .patch("/people/tm_7")
      .send({ job_title: "Senior Engineer", manager_id: 5 });

    expect(res.status).toBe(200);
  });

  it("does not write an audit row when the field value is unchanged", async () => {
    // Sending the same job_title that is already in before-state → no audit row
    mockDbQuery
      .mockResolvedValueOnce(TM_EXISTS)           // [0] existence check
      .mockResolvedValueOnce(BEFORE_STATE)         // [1] before-state read
      .mockResolvedValueOnce(PROFILE_FOR_JT_SYNC)  // [2] SELECT profile (job_title sync)
      .mockResolvedValueOnce(UPDATE_OK);           // [3] UPDATE team_member_profiles SET job_title

    mockTail();

    const res = await request(makeApp())
      .patch("/people/tm_7")
      .send({ job_title: "Engineer" }); // same as before-state — no actual change

    expect(res.status).toBe(200);

    // INSERT INTO people_audit_log must NOT have been called
    const callSqls = mockDbQuery.mock.calls.map((c) => String(c[0]));
    expect(callSqls.some((sql) => sql.includes("INSERT INTO people_audit_log"))).toBe(false);
  });

  it("writes a single audit row when only manager_id changes", async () => {
    // DB query order for { manager_id } only:
    //  [0] existence check, [1] before-state, [2] UPDATE team_members, [3] INSERT audit log
    mockDbQuery
      .mockResolvedValueOnce(TM_EXISTS)   // [0] existence check
      .mockResolvedValueOnce(BEFORE_STATE) // [1] before-state read
      .mockResolvedValueOnce(UPDATE_OK)   // [2] UPDATE team_members SET manager_id
      .mockResolvedValueOnce(UPDATE_OK);  // [3] INSERT INTO people_audit_log

    mockTail();

    const res = await request(makeApp())
      .patch("/people/tm_7")
      .send({ manager_id: 99 });

    expect(res.status).toBe(200);

    const auditCall = mockDbQuery.mock.calls[3];
    expect(auditCall[0]).toContain("INSERT INTO people_audit_log");
    expect(auditCall[1]).toEqual([
      "owner_111",
      7,
      "user_owner_abc",
      "manager_id", "2", "99",
    ]);
  });

  it("records old_value as null when manager_id was previously null", async () => {
    const beforeNoManager = {
      rows: [{ ...BEFORE_STATE.rows[0], manager_id: null }],
    };

    mockDbQuery
      .mockResolvedValueOnce(TM_EXISTS)     // [0] existence check
      .mockResolvedValueOnce(beforeNoManager) // [1] before-state (manager_id = null)
      .mockResolvedValueOnce(UPDATE_OK)     // [2] UPDATE team_members SET manager_id
      .mockResolvedValueOnce(UPDATE_OK);    // [3] INSERT INTO people_audit_log

    mockTail();

    const res = await request(makeApp())
      .patch("/people/tm_7")
      .send({ manager_id: 10 });

    expect(res.status).toBe(200);

    const auditCall = mockDbQuery.mock.calls[3];
    expect(auditCall[0]).toContain("INSERT INTO people_audit_log");
    // old_value must be null (not the string "null")
    expect(auditCall[1]).toEqual([
      "owner_111",
      7,
      "user_owner_abc",
      "manager_id", null, "10",
    ]);
  });
});

// ---------------------------------------------------------------------------
// GET /people/:id/activity — paginated audit log read
// ---------------------------------------------------------------------------

describe("GET /people/:id/activity", () => {
  // DB query order (run via Promise.all):
  //  [0] SELECT … FROM people_audit_log … LIMIT … OFFSET …  (items)
  //  [1] SELECT COUNT(*) FROM people_audit_log …             (count)
  //  then fetchClerkNames → clerkClient.users.getUserList

  const AUDIT_ROW = {
    id: 1,
    field_name: "job_title",
    old_value: "Engineer",
    new_value: "Senior Engineer",
    changed_by_user_id: "user_owner_abc",
    changed_at: "2025-01-15T10:00:00Z",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "owner";

    // Default: Clerk resolves the changing user's display name
    mockGetUserList.mockResolvedValue({
      data: [
        {
          id: "user_owner_abc",
          firstName: "Alice",
          lastName: "Owner",
          primaryEmailAddress: null,
          hasImage: false,
          imageUrl: null,
        },
      ],
    });
  });

  it("returns paginated activity items with the expected shape", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [AUDIT_ROW] })      // [0] items
      .mockResolvedValueOnce({ rows: [{ total: "1" }] }); // [1] count

    const res = await request(makeApp()).get("/people/tm_7/activity");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      items: [
        {
          id: 1,
          field_name: "job_title",
          old_value: "Engineer",
          new_value: "Senior Engineer",
          changed_by_user_id: "user_owner_abc",
          changed_by_name: "Alice Owner",
          changed_at: "2025-01-15T10:00:00Z",
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });
  });

  it("queries with the correct team_member_id and workspace_owner_id", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] })               // [0] items
      .mockResolvedValueOnce({ rows: [{ total: "0" }] }); // [1] count

    await request(makeApp()).get("/people/tm_7/activity");

    // items query: params are [tmId, workspaceOwnerId, limit, offset]
    const itemsCall = mockDbQuery.mock.calls[0];
    expect(itemsCall[1][0]).toBe(7);
    expect(itemsCall[1][1]).toBe("owner_111");

    // count query: params are [tmId, workspaceOwnerId]
    const countCall = mockDbQuery.mock.calls[1];
    expect(countCall[1][0]).toBe(7);
    expect(countCall[1][1]).toBe("owner_111");
  });

  it("respects page and limit query params", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "5" }] });

    const res = await request(makeApp()).get("/people/tm_7/activity?page=2&limit=3");

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.limit).toBe(3);

    // items query params: [tmId, workspaceOwnerId, limit, offset]
    const itemsCall = mockDbQuery.mock.calls[0];
    expect(itemsCall[1][2]).toBe(3);  // limit
    expect(itemsCall[1][3]).toBe(3);  // offset = (2-1)*3
  });

  it("falls back to changed_by_user_id when Clerk returns no matching user", async () => {
    mockGetUserList.mockResolvedValue({ data: [] }); // Clerk returns no users

    mockDbQuery
      .mockResolvedValueOnce({ rows: [AUDIT_ROW] })
      .mockResolvedValueOnce({ rows: [{ total: "1" }] });

    const res = await request(makeApp()).get("/people/tm_7/activity");

    expect(res.status).toBe(200);
    // When no Clerk user matched, falls back to the raw user ID
    expect(res.body.items[0].changed_by_name).toBe("user_owner_abc");
  });

  it("returns empty items and total=0 when no audit rows exist", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });

    const res = await request(makeApp()).get("/people/tm_7/activity");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it("returns 403 for non-owner", async () => {
    stubWorkspaceRole = "member";

    const res = await request(makeApp()).get("/people/tm_7/activity");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Only owners can view activity" });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 for non tm_ prefixed IDs", async () => {
    const res = await request(makeApp()).get("/people/wm_55/activity");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("tm_") });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /people/repair-orphans
// ---------------------------------------------------------------------------

describe("POST /people/repair-orphans", () => {
  // DB query order (when orphans exist with a matching email):
  //  [0] SELECT orphan team_members (those without a team_member_profiles row)
  //  [1] SELECT people by email (per orphan that has an email)
  //  [2] INSERT INTO team_member_profiles (per orphan)
  //
  // When no matching people row exists:
  //  [0] SELECT orphan team_members
  //  [1] SELECT people by email (returns empty)
  //  [2] INSERT INTO people RETURNING id
  //  [3] INSERT INTO team_member_profiles

  beforeEach(() => {
    vi.resetAllMocks();
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "owner";
  });

  it("returns 403 for non-owner", async () => {
    stubWorkspaceRole = "member";

    const res = await request(makeApp()).post("/people/repair-orphans");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Only owners can repair orphan records" });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("success: no orphans → returns { repaired: 0 } with no INSERT queries", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // [0] orphans query → empty

    const res = await request(makeApp()).post("/people/repair-orphans");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ repaired: 0 });
    // Only the initial orphans SELECT should have been called
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("success: orphan with email matches existing people row → inserts profile only, skips INSERT people", async () => {
    const orphanRow = {
      id: 10,
      first_name: "Jane",
      last_name: "Doe",
      email: "jane@example.com",
      phone: "+1-555-0200",
      department_id: 3,
      employment_status: "full_time",
      start_date: "2023-06-01",
      emergency_contact_name: "John Doe",
      emergency_contact_phone: "+1-555-0201",
      archived_at: null,
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [orphanRow] })        // [0] orphans SELECT
      .mockResolvedValueOnce({ rows: [{ id: 55 }] })       // [1] SELECT people by email → match found
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });   // [2] INSERT team_member_profiles

    const res = await request(makeApp()).post("/people/repair-orphans");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ repaired: 1 });

    // Exactly 3 queries: orphans, email lookup, profile insert
    expect(mockDbQuery).toHaveBeenCalledTimes(3);

    // The email lookup must scope to the correct workspace and email
    const emailLookupCall = mockDbQuery.mock.calls[1];
    expect(emailLookupCall[1]).toEqual(["owner_111", "jane@example.com"]);

    // The profile INSERT must use the existing person id (55), not insert a new people row
    const profileInsertCall = mockDbQuery.mock.calls[2];
    expect(profileInsertCall[1][0]).toBe(55);   // person_id
    expect(profileInsertCall[1][2]).toBe(10);   // team_member_id
  });

  it("success: orphan with no matching people row → inserts both people + profile", async () => {
    const orphanRow = {
      id: 20,
      first_name: "Carlos",
      last_name: "Rivera",
      email: "carlos@example.com",
      phone: null,
      department_id: null,
      employment_status: null,
      start_date: null,
      emergency_contact_name: null,
      emergency_contact_phone: null,
      archived_at: null,
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [orphanRow] })        // [0] orphans SELECT
      .mockResolvedValueOnce({ rows: [] })                 // [1] SELECT people by email → no match
      .mockResolvedValueOnce({ rows: [{ id: 99 }] })       // [2] INSERT INTO people RETURNING id
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });   // [3] INSERT team_member_profiles

    const res = await request(makeApp()).post("/people/repair-orphans");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ repaired: 1 });

    // All four queries must have fired
    expect(mockDbQuery).toHaveBeenCalledTimes(4);

    // The people INSERT must receive the correct workspace and name fields
    const peopleInsertCall = mockDbQuery.mock.calls[2];
    expect(peopleInsertCall[1][0]).toBe("owner_111");     // workspace_owner_id
    expect(peopleInsertCall[1][1]).toBe("Carlos");        // first_name
    expect(peopleInsertCall[1][2]).toBe("Rivera");        // last_name
    expect(peopleInsertCall[1][3]).toBe("carlos@example.com"); // email
    expect(peopleInsertCall[1][5]).toBe("active");        // status (not archived)

    // The profile INSERT must use the newly created person id (99)
    const profileInsertCall = mockDbQuery.mock.calls[3];
    expect(profileInsertCall[1][0]).toBe(99);   // person_id
    expect(profileInsertCall[1][2]).toBe(20);   // team_member_id
  });
});

// ---------------------------------------------------------------------------
// GET /people — team_members table absent (42P01 guard)
// ---------------------------------------------------------------------------

describe("GET /people — team_members table absent (42P01)", () => {
  // When team_members does not yet exist the query throws a pg error with
  // code 42P01 ("undefined_table"). buildPeopleList catches it, sets the
  // module flag to false, and falls back to a members-only list.
  //
  // Query sequence in this scenario:
  //  [0] workspace_members  — succeeds
  //  [1] team_members       — throws pg 42P01
  //  [2] external_profiles  — succeeds (profiles query is skipped)

  const MEMBER_WITH_JOINED = {
    rows: [
      {
        id: 10,
        email: "alice@example.com",
        role: "member",
        custom_role_id: null,
        role_name: null,
        member_user_id: "user_alice",
        joined: true,
        joined_at: "2024-01-01T00:00:00Z",
        invited_at: "2023-12-01T00:00:00Z",
        job_title: "Engineer",
        employment_type: "full_time",
        employment_status: "full_time",
        access_expires_at: null,
        revoked_at: null,
      },
    ],
  };

  const pg42P01 = Object.assign(new Error("relation \"team_members\" does not exist"), {
    code: "42P01",
  });

  beforeEach(() => {
    vi.resetAllMocks();
    _resetTeamMembersTableExistsForTesting();
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "owner";
  });

  it("returns 200 with members-only data when team_members throws 42P01", async () => {
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_WITH_JOINED)    // [0] workspace_members
      .mockResolvedValueOnce({ rows: [] })           // [1] workspace_member_roles (id:10)
      .mockRejectedValueOnce(pg42P01)               // [2] team_members — table absent
      .mockResolvedValueOnce({ rows: [] });          // [3] external_profiles

    const res = await request(makeApp()).get("/people");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("people");
    expect(res.body).toHaveProperty("stats");

    // The member row must appear in the list
    expect(res.body.people).toHaveLength(1);
    expect(res.body.people[0]).toMatchObject({
      email: "alice@example.com",
      source: "member",
      access_type: "user",
      member_id: 10,
      team_member_id: null,
    });

    // Exactly 4 queries: members, workspace_member_roles, team_members (rejected), external_profiles
    expect(mockDbQuery).toHaveBeenCalledTimes(4);
  });

  it("skips team_members query on subsequent calls once flag is set to false", async () => {
    // First call — sets flag to false
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_WITH_JOINED)    // workspace_members
      .mockResolvedValueOnce({ rows: [] })           // workspace_member_roles (id:10)
      .mockRejectedValueOnce(pg42P01)               // team_members — table absent
      .mockResolvedValueOnce({ rows: [] });          // external_profiles

    await request(makeApp()).get("/people");

    vi.resetAllMocks();

    // Second call — flag is already false; team_members query must NOT be issued
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_WITH_JOINED)    // [0] workspace_members
      .mockResolvedValueOnce({ rows: [] })           // [1] workspace_member_roles (id:10)
      .mockResolvedValueOnce({ rows: [] });          // [2] external_profiles (no team_members call)

    const res = await request(makeApp()).get("/people");

    expect(res.status).toBe(200);
    // Only 3 queries: members + workspace_member_roles + external_profiles; team_members was skipped
    expect(mockDbQuery).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// GET /people — departments table absent (42P01 guard)
// ---------------------------------------------------------------------------

describe("GET /people — departments table absent (42P01)", () => {
  // When departments does not yet exist the team_members LEFT JOIN throws 42P01.
  // buildPeopleList should detect "departments" in the error message, set
  // _departmentsTableExists = false, log the correct message, then retry
  // WITHOUT the JOIN (returning NULL department_name) so the rest of the
  // people list still works normally.
  //
  // Query sequence on first call:
  //  [0] workspace_members            — succeeds
  //  [1] team_members (with JOIN)     — throws pg 42P01 mentioning "departments"
  //  [2] team_members (without JOIN)  — succeeds (retry)
  //  [3] team_member_profiles         — succeeds
  //  [4] external_profiles            — succeeds
  //
  // Query sequence on second call (flag already set):
  //  [0] workspace_members            — succeeds
  //  [1] team_members (without JOIN)  — succeeds (no retry needed)
  //  [2] team_member_profiles         — succeeds
  //  [3] external_profiles            — succeeds

  const MEMBER_WITH_JOINED = {
    rows: [
      {
        id: 10,
        email: "alice@example.com",
        role: "member",
        custom_role_id: null,
        role_name: null,
        member_user_id: "user_alice",
        joined: true,
        joined_at: "2024-01-01T00:00:00Z",
        invited_at: "2023-12-01T00:00:00Z",
        job_title: "Engineer",
        employment_type: "full_time",
        employment_status: "full_time",
        access_expires_at: null,
        revoked_at: null,
      },
    ],
  };

  const TEAM_MEMBER_NO_DEPT = {
    rows: [
      {
        id: 7,
        first_name: "Bob",
        last_name: "Jones",
        email: "bob@example.com",
        phone: null,
        department_name: null,
        employment_status: "full_time",
        archived_at: null,
      },
    ],
  };

  const pg42P01Dept = Object.assign(
    new Error('relation "departments" does not exist'),
    { code: "42P01" },
  );

  beforeEach(() => {
    vi.resetAllMocks();
    _resetTeamMembersTableExistsForTesting();
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "owner";
  });

  it("returns 200 with team_member data (null department_name) when departments throws 42P01", async () => {
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_WITH_JOINED)       // [0] workspace_members
      .mockResolvedValueOnce({ rows: [] })             // [1] workspace_member_roles (id:10)
      .mockRejectedValueOnce(pg42P01Dept)              // [2] team_members with JOIN — departments absent
      .mockResolvedValueOnce(TEAM_MEMBER_NO_DEPT)      // [3] team_members retry without JOIN
      .mockResolvedValueOnce({ rows: [] })             // [4] team_member_profiles
      .mockResolvedValueOnce({ rows: [] })             // [5] external_profiles
      .mockResolvedValueOnce({ rows: [] });             // [6] team_member Clerk email lookup

    const res = await request(makeApp()).get("/people");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("people");

    // Both the member and team_member rows must appear (merged on email)
    const bob = res.body.people.find((p: { email: string }) => p.email === "bob@example.com");
    expect(bob).toBeDefined();
    expect(bob.department_name).toBeNull();
    expect(bob.team_member_id).toBe(7);

    // Exactly 7 queries including the retry
    expect(mockDbQuery).toHaveBeenCalledTimes(7);
  });

  it("skips the departments JOIN on subsequent calls once flag is set to false", async () => {
    // First call — sets _departmentsTableExists = false
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_WITH_JOINED)
      .mockRejectedValueOnce(pg42P01Dept)
      .mockResolvedValueOnce(TEAM_MEMBER_NO_DEPT)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await request(makeApp()).get("/people");

    vi.resetAllMocks();

    // Second call — no JOIN attempted, so no retry; only 5 queries
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_WITH_JOINED)       // [0] workspace_members
      .mockResolvedValueOnce(TEAM_MEMBER_NO_DEPT)      // [1] team_members without JOIN
      .mockResolvedValueOnce({ rows: [] })             // [2] team_member_profiles
      .mockResolvedValueOnce({ rows: [] })             // [3] external_profiles
      .mockResolvedValueOnce({ rows: [] });             // [4] team_member Clerk email lookup

    const res = await request(makeApp()).get("/people");

    expect(res.status).toBe(200);
    // 5 queries — no retry on the second call
    expect(mockDbQuery).toHaveBeenCalledTimes(5);
  });
});

// ---------------------------------------------------------------------------
// GET /people — team_member_profiles table absent (42P01 guard)
// ---------------------------------------------------------------------------

describe("GET /people — team_member_profiles table absent (42P01)", () => {
  // When team_members exists but team_member_profiles does not, the profiles
  // query throws 42P01. buildPeopleList must catch it, fall back to empty
  // profile rows, and still return team_member data (with null profile fields).
  //
  // Query sequence:
  //  [0] workspace_members       — succeeds
  //  [1] team_members            — succeeds (sets _teamMembersTableExists = true)
  //  [2] team_member_profiles    — throws pg 42P01
  //  [3] external_profiles       — succeeds

  const MEMBER_WITH_JOINED = {
    rows: [
      {
        id: 10,
        email: "alice@example.com",
        role: "member",
        custom_role_id: null,
        role_name: null,
        member_user_id: "user_alice",
        joined: true,
        joined_at: "2024-01-01T00:00:00Z",
        invited_at: "2023-12-01T00:00:00Z",
        job_title: null,
        employment_type: "full_time",
        employment_status: "full_time",
        access_expires_at: null,
        revoked_at: null,
      },
    ],
  };

  const pg42P01Profiles = Object.assign(
    new Error("relation \"team_member_profiles\" does not exist"),
    { code: "42P01" },
  );

  beforeEach(() => {
    vi.resetAllMocks();
    _resetTeamMembersTableExistsForTesting();
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "owner";
  });

  it("returns 200 with team_member data but null profile fields when team_member_profiles throws 42P01", async () => {
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_WITH_JOINED)    // [0] workspace_members
      .mockResolvedValueOnce({ rows: [] })           // [1] workspace_member_roles (id:10)
      .mockResolvedValueOnce(TEAM_MEMBER_ROWS)       // [2] team_members — succeeds
      .mockRejectedValueOnce(pg42P01Profiles)        // [3] team_member_profiles — table absent
      .mockResolvedValueOnce({ rows: [] })           // [4] external_profiles
      .mockResolvedValueOnce({ rows: [] });           // [5] team_member Clerk email lookup

    const res = await request(makeApp()).get("/people");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("people");

    // Alice appears in both workspace_members and team_members (same email),
    // so source is "both"; the key check is that team_member data is present
    // and profile fields are null (table was absent).
    const alice = res.body.people.find((p: { first_name: string }) => p.first_name === "Alice");
    expect(alice).toBeDefined();
    expect(alice).toMatchObject({
      source: "both",
      team_member_id: 7,
      first_name: "Alice",
      last_name: "Smith",
    });

    // Profile fields must be null because the table was absent
    expect(alice.profile_id).toBeNull();
    expect(alice.person_id).toBeNull();
    expect(alice.employee_code).toBeNull();
    expect(alice.start_date).toBeNull();

    // Exactly 6 queries: members, workspace_member_roles, team_members, team_member_profiles (rejected), external_profiles, email-lookup
    expect(mockDbQuery).toHaveBeenCalledTimes(6);
  });

  it("skips team_member_profiles query on subsequent calls once flag is set to false", async () => {
    // First call — sets _teamMemberProfilesTableExists = false
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_WITH_JOINED)    // workspace_members
      .mockResolvedValueOnce({ rows: [] })           // workspace_member_roles (id:10)
      .mockResolvedValueOnce(TEAM_MEMBER_ROWS)       // team_members
      .mockRejectedValueOnce(pg42P01Profiles)        // team_member_profiles — table absent
      .mockResolvedValueOnce({ rows: [] });           // external_profiles

    await request(makeApp()).get("/people");

    vi.resetAllMocks();

    // Second call — profiles query must NOT be issued (flag is false)
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_WITH_JOINED)    // [0] workspace_members
      .mockResolvedValueOnce({ rows: [] })           // [1] workspace_member_roles (id:10)
      .mockResolvedValueOnce(TEAM_MEMBER_ROWS)       // [2] team_members (still runs — table exists)
      .mockResolvedValueOnce({ rows: [] })           // [3] external_profiles (no profiles call)
      .mockResolvedValueOnce({ rows: [] });           // [4] team_member Clerk email lookup

    const res = await request(makeApp()).get("/people");

    expect(res.status).toBe(200);
    // Only 5 queries: members + workspace_member_roles + team_members + external_profiles + email-lookup; profiles was skipped
    expect(mockDbQuery).toHaveBeenCalledTimes(5);
  });
});

// ---------------------------------------------------------------------------
// GET /people — external_profiles table absent (42P01 guard)
// ---------------------------------------------------------------------------

describe("GET /people — external_profiles table absent (42P01)", () => {
  // When external_profiles does not yet exist the query throws 42P01.
  // buildPeopleList must catch it, degrade to no external profiles, and still
  // return workspace_member + team_member rows with status 200.
  //
  // Query sequence:
  //  [0] workspace_members       — succeeds
  //  [1] team_members            — succeeds
  //  [2] team_member_profiles    — succeeds (empty)
  //  [3] external_profiles       — throws pg 42P01

  const MEMBER_WITH_JOINED = {
    rows: [
      {
        id: 10,
        email: "alice@example.com",
        role: "member",
        custom_role_id: null,
        role_name: null,
        member_user_id: "user_alice",
        joined: true,
        joined_at: "2024-01-01T00:00:00Z",
        invited_at: "2023-12-01T00:00:00Z",
        job_title: null,
        employment_type: "full_time",
        employment_status: "full_time",
        access_expires_at: null,
        revoked_at: null,
      },
    ],
  };

  const pg42P01External = Object.assign(
    new Error("relation \"external_profiles\" does not exist"),
    { code: "42P01" },
  );

  beforeEach(() => {
    vi.resetAllMocks();
    _resetTeamMembersTableExistsForTesting();
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "owner";
  });

  it("returns 200 with member/team_member data when external_profiles throws 42P01", async () => {
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_WITH_JOINED)    // [0] workspace_members
      .mockResolvedValueOnce({ rows: [] })           // [1] workspace_member_roles (id:10)
      .mockResolvedValueOnce(TEAM_MEMBER_ROWS)       // [2] team_members
      .mockResolvedValueOnce({ rows: [] })            // [3] team_member_profiles — empty
      .mockRejectedValueOnce(pg42P01External)         // [4] external_profiles — table absent
      .mockResolvedValueOnce({ rows: [] });            // [5] team_member Clerk email lookup

    const res = await request(makeApp()).get("/people");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("people");

    // Alice from TEAM_MEMBER_ROWS must appear; no external profile should be added
    const alice = res.body.people.find((p: { first_name: string }) => p.first_name === "Alice");
    expect(alice).toBeDefined();
    expect(alice.has_external_profile).toBe(false);
    expect(alice.external_type).toBeNull();

    // Exactly 6 queries: members, workspace_member_roles, team_members, profiles, external_profiles (rejected), email-lookup
    expect(mockDbQuery).toHaveBeenCalledTimes(6);
  });

  it("skips external_profiles query on subsequent calls once flag is set to false", async () => {
    // First call — sets _externalProfilesTableExists = false
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_WITH_JOINED)
      .mockResolvedValueOnce(TEAM_MEMBER_ROWS)
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(pg42P01External);

    await request(makeApp()).get("/people");

    vi.resetAllMocks();

    // Second call — external_profiles must NOT be issued (flag is false)
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_WITH_JOINED)    // [0] workspace_members
      .mockResolvedValueOnce(TEAM_MEMBER_ROWS)       // [1] team_members
      .mockResolvedValueOnce({ rows: [] })           // [2] team_member_profiles (no external call)
      .mockResolvedValueOnce({ rows: [] });           // [3] team_member Clerk email lookup

    const res = await request(makeApp()).get("/people");

    expect(res.status).toBe(200);
    // Only 4 queries: members + team_members + profiles + email-lookup; external_profiles was skipped
    expect(mockDbQuery).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// GET /people — external_profiles unexpected error guard
// ---------------------------------------------------------------------------

describe("GET /people — external_profiles unexpected error", () => {
  // When external_profiles query throws an unexpected (non-42P01) error,
  // buildPeopleList must degrade gracefully: log a warning and treat external
  // profiles as an empty list, returning 200 with null external fields.
  //
  // Query sequence:
  //  [0] workspace_members       — succeeds
  //  [1] team_members            — succeeds
  //  [2] team_member_profiles    — succeeds (empty)
  //  [3] external_profiles       — throws unexpected Error (not 42P01)
  //  [4] team_member Clerk email lookup — succeeds

  const MEMBER_WITH_JOINED = {
    rows: [
      {
        id: 10,
        email: "alice@example.com",
        role: "member",
        custom_role_id: null,
        role_name: null,
        member_user_id: "user_alice",
        joined: true,
        joined_at: "2024-01-01T00:00:00Z",
        invited_at: "2023-12-01T00:00:00Z",
        job_title: null,
        employment_type: "full_time",
        employment_status: "full_time",
        access_expires_at: null,
        revoked_at: null,
      },
    ],
  };

  const unexpectedError = new Error("connection timeout");

  beforeEach(() => {
    vi.resetAllMocks();
    _resetTeamMembersTableExistsForTesting();
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "owner";
  });

  it("returns 200 with member/team_member data when external_profiles throws unexpected error", async () => {
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_WITH_JOINED)    // [0] workspace_members
      .mockResolvedValueOnce({ rows: [] })           // [1] workspace_member_roles (id:10)
      .mockResolvedValueOnce(TEAM_MEMBER_ROWS)       // [2] team_members
      .mockResolvedValueOnce({ rows: [] })            // [3] team_member_profiles — empty
      .mockRejectedValueOnce(unexpectedError)         // [4] external_profiles — unexpected error
      .mockResolvedValueOnce({ rows: [] });            // [5] team_member Clerk email lookup

    const res = await request(makeApp()).get("/people");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("people");

    // Alice from TEAM_MEMBER_ROWS must appear with no external profile data
    const alice = res.body.people.find((p: { first_name: string }) => p.first_name === "Alice");
    expect(alice).toBeDefined();
    expect(alice.has_external_profile).toBe(false);
    expect(alice.external_type).toBeNull();
    expect(alice.external_company_name).toBeNull();

    // Exactly 6 queries: members, workspace_member_roles, team_members, profiles, external_profiles (rejected), email-lookup
    expect(mockDbQuery).toHaveBeenCalledTimes(6);
  });
});

// ---------------------------------------------------------------------------
// GET /people — image_url populated from Clerk for joined members
// ---------------------------------------------------------------------------

describe("GET /people — image_url populated from Clerk", () => {
  // DB query order:
  //  [0] workspace_members  — member with member_user_id
  //  [1] team_members       — empty
  //  [2] team_member_profiles — empty
  //  [3] external_profiles  — empty
  // Then: fetchClerkNames called for member_user_id → getUserList

  const MEMBER_WITH_USER_ID = {
    rows: [
      {
        id: 20,
        email: "alice@example.com",
        role: "member",
        custom_role_id: null,
        role_name: null,
        member_user_id: "user_alice_123",
        joined: true,
        joined_at: "2024-01-01T00:00:00Z",
        invited_at: "2023-12-01T00:00:00Z",
        job_title: null,
        employment_type: null,
        employment_status: "full_time",
        access_expires_at: null,
        revoked_at: null,
      },
    ],
  };

  const MEMBER_WITHOUT_PHOTO = {
    rows: [
      {
        id: 21,
        email: "bob@example.com",
        role: "member",
        custom_role_id: null,
        role_name: null,
        member_user_id: "user_bob_456",
        joined: true,
        joined_at: "2024-02-01T00:00:00Z",
        invited_at: "2024-01-01T00:00:00Z",
        job_title: null,
        employment_type: null,
        employment_status: "full_time",
        access_expires_at: null,
        revoked_at: null,
      },
    ],
  };

  beforeEach(() => {
    vi.resetAllMocks();
    _resetTeamMembersTableExistsForTesting();
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "owner";
  });

  it("sets image_url from Clerk when the member has a profile photo", async () => {
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_WITH_USER_ID)  // [0] workspace_members
      .mockResolvedValueOnce({ rows: [] })           // [1] workspace_member_roles (multi-role junction)
      .mockResolvedValueOnce({ rows: [] })           // [2] team_members
      .mockResolvedValueOnce({ rows: [] })           // [3] team_member_profiles
      .mockResolvedValueOnce({ rows: [] });          // [4] external_profiles

    mockGetUserList.mockResolvedValueOnce({
      data: [
        {
          id: "user_alice_123",
          firstName: "Alice",
          lastName: "Smith",
          primaryEmailAddress: null,
          hasImage: true,
          imageUrl: "https://clerk.example.com/alice.jpg",
        },
      ],
    });

    const res = await request(makeApp()).get("/people");

    expect(res.status).toBe(200);
    expect(res.body.people).toHaveLength(1);
    expect(res.body.people[0]).toMatchObject({
      first_name: "Alice",
      last_name: "Smith",
      email: "alice@example.com",
      image_url: "https://clerk.example.com/alice.jpg",
    });
  });

  it("leaves image_url as null when the member has no profile photo", async () => {
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_WITHOUT_PHOTO)  // [0] workspace_members
      .mockResolvedValueOnce({ rows: [] })            // [1] workspace_member_roles (multi-role junction)
      .mockResolvedValueOnce({ rows: [] })            // [2] team_members
      .mockResolvedValueOnce({ rows: [] })            // [3] team_member_profiles
      .mockResolvedValueOnce({ rows: [] });           // [4] external_profiles

    mockGetUserList.mockResolvedValueOnce({
      data: [
        {
          id: "user_bob_456",
          firstName: "Bob",
          lastName: "Jones",
          primaryEmailAddress: null,
          hasImage: false,
          imageUrl: null,
        },
      ],
    });

    const res = await request(makeApp()).get("/people");

    expect(res.status).toBe(200);
    expect(res.body.people).toHaveLength(1);
    expect(res.body.people[0]).toMatchObject({
      first_name: "Bob",
      last_name: "Jones",
      email: "bob@example.com",
      image_url: null,
    });
  });

  it("leaves image_url as null when Clerk call fails", async () => {
    mockDbQuery
      .mockResolvedValueOnce(MEMBER_WITH_USER_ID)  // [0] workspace_members
      .mockResolvedValueOnce({ rows: [] })           // [1] workspace_member_roles (multi-role junction)
      .mockResolvedValueOnce({ rows: [] })           // [2] team_members
      .mockResolvedValueOnce({ rows: [] })           // [3] team_member_profiles
      .mockResolvedValueOnce({ rows: [] });          // [4] external_profiles

    mockGetUserList.mockRejectedValueOnce(new Error("Clerk unavailable"));

    const res = await request(makeApp()).get("/people");

    expect(res.status).toBe(200);
    expect(res.body.people).toHaveLength(1);
    expect(res.body.people[0]).toMatchObject({
      email: "alice@example.com",
      image_url: null,
    });
  });

  it("does not call getUserList when no members have a member_user_id", async () => {
    const pendingMemberRows = {
      rows: [
        {
          id: 30,
          email: "pending@example.com",
          role: "member",
          custom_role_id: null,
          role_name: null,
          member_user_id: null,
          joined: false,
          joined_at: null,
          invited_at: "2024-01-01T00:00:00Z",
          job_title: null,
          employment_type: null,
          employment_status: "full_time",
          access_expires_at: null,
          revoked_at: null,
        },
      ],
    };

    mockDbQuery
      .mockResolvedValueOnce(pendingMemberRows)  // [0] workspace_members
      .mockResolvedValueOnce({ rows: [] })        // [1] workspace_member_roles (multi-role junction)
      .mockResolvedValueOnce({ rows: [] })        // [2] team_members
      .mockResolvedValueOnce({ rows: [] })        // [3] team_member_profiles
      .mockResolvedValueOnce({ rows: [] });       // [4] external_profiles

    const res = await request(makeApp()).get("/people");

    expect(res.status).toBe(200);
    expect(mockGetUserList).not.toHaveBeenCalled();
  });

  it("sets image_url via email-based lookup for a team_member-only row", async () => {
    // Scenario: carol@example.com exists only as a team_member (HR record) —
    // the workspace_members query [0] returns no match for that email, so the
    // merged row gets source="team_member" and image_url=null after the initial
    // Clerk enrichment pass. The email-based workspace_members lookup [4] then
    // finds carol as a signed-in member and Clerk returns her profile photo.
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] })       // [0] workspace_members — no entry for carol
      .mockResolvedValueOnce({                   // [1] team_members
        rows: [
          {
            id: 50,
            first_name: "Carol",
            last_name: "Danvers",
            email: "carol@example.com",
            phone: null,
            department_name: null,
            employment_status: "full_time",
            archived_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })       // [2] team_member_profiles
      .mockResolvedValueOnce({ rows: [] })       // [3] external_profiles
      .mockResolvedValueOnce({                   // [4] workspace_members by email (email-based lookup)
        rows: [
          { member_email: "carol@example.com", member_user_id: "user_carol_789" },
        ],
      });

    mockGetUserList.mockResolvedValueOnce({
      data: [
        {
          id: "user_carol_789",
          firstName: "Carol",
          lastName: "Danvers",
          primaryEmailAddress: null,
          hasImage: true,
          imageUrl: "https://clerk.example.com/carol.jpg",
        },
      ],
    });

    const res = await request(makeApp()).get("/people");

    expect(res.status).toBe(200);
    expect(res.body.people).toHaveLength(1);
    expect(res.body.people[0]).toMatchObject({
      email: "carol@example.com",
      image_url: "https://clerk.example.com/carol.jpg",
    });
  });

  it("leaves image_url null for a team_member-only row when the email-based Clerk call fails", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] })       // [0] workspace_members
      .mockResolvedValueOnce({                   // [1] team_members
        rows: [
          {
            id: 51,
            first_name: "Dana",
            last_name: "Prince",
            email: "dana@example.com",
            phone: null,
            department_name: null,
            employment_status: "full_time",
            archived_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })       // [2] team_member_profiles
      .mockResolvedValueOnce({ rows: [] })       // [3] external_profiles
      .mockResolvedValueOnce({                   // [4] workspace_members by email
        rows: [
          { member_email: "dana@example.com", member_user_id: "user_dana_321" },
        ],
      });

    mockGetUserList.mockRejectedValueOnce(new Error("Clerk unavailable"));

    const res = await request(makeApp()).get("/people");

    expect(res.status).toBe(200);
    expect(res.body.people).toHaveLength(1);
    expect(res.body.people[0]).toMatchObject({
      email: "dana@example.com",
      image_url: null,
    });
  });

  it("leaves image_url null when the email-based workspace_members DB query throws", async () => {
    // Scenario: the 5th db.query (workspace_members by email lookup) throws an
    // unexpected DB error. The catch block at people.ts line 470 must absorb it
    // and leave image_url as null rather than crashing the request.
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] })       // [0] workspace_members — no entry for eve
      .mockResolvedValueOnce({                   // [1] team_members
        rows: [
          {
            id: 52,
            first_name: "Eve",
            last_name: "Harlow",
            email: "eve@example.com",
            phone: null,
            department_name: null,
            employment_status: "full_time",
            archived_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })       // [2] team_member_profiles
      .mockResolvedValueOnce({ rows: [] })       // [3] external_profiles
      .mockRejectedValueOnce(new Error("DB connection error")); // [4] workspace_members by email — throws

    const res = await request(makeApp()).get("/people");

    expect(res.status).toBe(200);
    expect(res.body.people).toHaveLength(1);
    expect(res.body.people[0]).toMatchObject({
      email: "eve@example.com",
      image_url: null,
    });
  });
});

// ---------------------------------------------------------------------------
// GET /people/orphan-count — team_members table absent (42P01 guard)
// ---------------------------------------------------------------------------

describe("GET /people/orphan-count — team_members table absent (42P01)", () => {
  // When team_members does not yet exist the orphan-count query throws 42P01.
  // The route must catch it and return { orphan_count: 0 } with status 200.
  //
  // Query sequence:
  //  [0] COUNT query on team_members — throws pg 42P01

  const pg42P01 = Object.assign(new Error("relation \"team_members\" does not exist"), {
    code: "42P01",
  });

  beforeEach(() => {
    vi.resetAllMocks();
    _resetTeamMembersTableExistsForTesting();
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "owner";
  });

  it("returns 200 with { orphan_count: 0 } when team_members throws 42P01", async () => {
    mockDbQuery.mockRejectedValueOnce(pg42P01);

    const res = await request(makeApp()).get("/people/orphan-count");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orphan_count: 0 });
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("returns 403 for non-owner regardless of table state", async () => {
    stubWorkspaceRole = "member";

    const res = await request(makeApp()).get("/people/orphan-count");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Only owners can view orphan counts" });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns the correct count when team_members exists and has orphans", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ orphan_count: "3" }] });

    const res = await request(makeApp()).get("/people/orphan-count");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orphan_count: 3 });
  });
});
