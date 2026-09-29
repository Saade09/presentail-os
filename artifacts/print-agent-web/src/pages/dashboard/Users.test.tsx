import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import UsersPage from "./Users";
import { formatWorkSchedule } from "@/lib/workSchedule";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts?.count !== undefined) return `${opts.count} people`;
      return key;
    },
  }),
}));

const mockUseMutation = vi.fn();
const mockUseQuery = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  queryClient: { invalidateQueries: vi.fn() },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-roles", () => ({
  useRoles: () => ({ data: { roles: [{ id: 7, name: "Designer" }] } }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ allowedPages: null, loaded: true }),
}));

vi.mock("@/components/StaleDataBadge", () => ({
  StaleDataBadge: () => null,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: (string | undefined | null | boolean)[]) =>
    classes.filter(Boolean).join(" "),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type WorkingDaysConfig = {
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
};

const DEFAULT_WORKING_DAYS: WorkingDaysConfig = {
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
  saturday: false,
  sunday: false,
};

function makeMember(overrides: Partial<{
  id: number;
  email: string;
  role: "owner" | "member";
  joined: boolean;
  joined_at: string | null;
  custom_role_id: number | null;
  role_name: string | null;
  invited_at: string;
  invited_by_email: string | null;
  manager_member_id: number | null;
  manager_email: string | null;
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
  invite_token: string | null;
  assigned_locations: { id: number; name: string }[];
  job_title: string | null;
  start_date: string | null;
  department: string | null;
  location: string | null;
  employment_type: "full_time" | "part_time" | "contractor" | "intern" | null;
  employment_status: "active" | "inactive" | "on_leave";
  working_days: WorkingDaysConfig | null;
}> = {}) {
  return {
    id: 1,
    email: "member@example.com",
    role: "member" as const,
    joined: false,
    joined_at: null,
    custom_role_id: 7,
    role_name: "Designer",
    invited_at: "2024-01-01T00:00:00Z",
    invited_by_email: "owner@example.com",
    manager_member_id: null,
    manager_email: null,
    first_name: null,
    last_name: null,
    image_url: null,
    invite_token: null,
    assigned_locations: [],
    job_title: null,
    start_date: null,
    department: null,
    location: null,
    employment_type: null,
    employment_status: "active" as const,
    working_days: null,
    ...overrides,
  };
}

function setupMocks({
  meRole,
  meAllowedPages,
  members,
}: {
  meRole?: "owner" | "member";
  meAllowedPages?: string[] | null;
  members?: ReturnType<typeof makeMember>[];
} = {}) {
  const resolvedRole: "owner" | "member" = meRole ?? "owner";
  // Owners get null (unrestricted); non-owners default to [] (no sub-permissions granted)
  const resolvedAllowedPages: string[] | null =
    meAllowedPages !== undefined ? meAllowedPages : resolvedRole === "owner" ? null : [];
  const resolvedMembers = members ?? [];
  const mutate = vi.fn();
  mockUseMutation.mockReturnValue({ mutate, isPending: false });
  mockUseQuery.mockImplementation((opts: { queryKey: string[] }) => {
    const key = opts.queryKey[0];
    if (key === "users") {
      return {
        data: { members: resolvedMembers, me: { role: resolvedRole, email: "owner@example.com", allowedPages: resolvedAllowedPages, customRoleId: null } },
        isLoading: false,
      };
    }
    return { data: undefined, isLoading: false };
  });
}

function renderUsersPage() {
  return render(<UsersPage />);
}

// ---------------------------------------------------------------------------
// Tests: formatWorkSchedule unit tests
// ---------------------------------------------------------------------------

describe("formatWorkSchedule", () => {
  it("returns null for the default Mon–Fri schedule", () => {
    expect(formatWorkSchedule(DEFAULT_WORKING_DAYS)).toBeNull();
  });

  it("returns null when working_days is null (treated as default Mon–Fri)", () => {
    expect(formatWorkSchedule(null)).toBeNull();
  });

  it("returns a range label for a contiguous schedule (Mon–Thu)", () => {
    const days: WorkingDaysConfig = {
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: false,
      saturday: false,
      sunday: false,
    };
    expect(formatWorkSchedule(days)).toBe("Mon–Thu");
  });

  it("returns a range label for a contiguous schedule (Mon–Sat)", () => {
    const days: WorkingDaysConfig = {
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
      saturday: true,
      sunday: false,
    };
    expect(formatWorkSchedule(days)).toBe("Mon–Sat");
  });

  it("returns comma-separated labels for non-contiguous days", () => {
    const days: WorkingDaysConfig = {
      monday: true,
      tuesday: false,
      wednesday: true,
      thursday: false,
      friday: true,
      saturday: false,
      sunday: false,
    };
    expect(formatWorkSchedule(days)).toBe("Mon, Wed, Fri");
  });

  it("returns comma-separated labels for two non-adjacent days", () => {
    const days: WorkingDaysConfig = {
      monday: false,
      tuesday: false,
      wednesday: false,
      thursday: false,
      friday: false,
      saturday: true,
      sunday: true,
    };
    // Sat and Sun are adjacent in the WORK_SCHEDULE_DAYS array so this is contiguous
    expect(formatWorkSchedule(days)).toBe("Sat–Sun");
  });

  it("returns 'No working days' when all days are false", () => {
    const days: WorkingDaysConfig = {
      monday: false,
      tuesday: false,
      wednesday: false,
      thursday: false,
      friday: false,
      saturday: false,
      sunday: false,
    };
    expect(formatWorkSchedule(days)).toBe("No working days");
  });

  it("returns a single day label when exactly one day is active and it differs from default", () => {
    const days: WorkingDaysConfig = {
      monday: false,
      tuesday: false,
      wednesday: false,
      thursday: false,
      friday: false,
      saturday: true,
      sunday: false,
    };
    expect(formatWorkSchedule(days)).toBe("Sat");
  });
});

// ---------------------------------------------------------------------------
// Tests: "Resend invite" and "Revoke" button visibility
// ---------------------------------------------------------------------------

describe("UsersPage — Resend invite and Revoke button visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("when the current user is an owner", () => {
    it("shows Resend invite and Revoke buttons for a pending (not-yet-joined) member", () => {
      const pending = makeMember({ id: 10, joined: false });
      setupMocks({ meRole: "owner", members: [pending] });

      renderUsersPage();

      expect(screen.getByTestId("button-resend-invite-10")).toBeInTheDocument();
      expect(screen.getByTestId("button-revoke-invite-10")).toBeInTheDocument();
    });

    it("does NOT show Resend invite or Revoke buttons for a joined member", () => {
      const joined = makeMember({ id: 20, joined: true, joined_at: "2024-06-01T00:00:00Z" });
      setupMocks({ meRole: "owner", members: [joined] });

      renderUsersPage();

      expect(screen.queryByTestId("button-resend-invite-20")).not.toBeInTheDocument();
      expect(screen.queryByTestId("button-revoke-invite-20")).not.toBeInTheDocument();
    });

    it("shows Resend invite for pending members but not for joined members when both are present", () => {
      const pending = makeMember({ id: 30, email: "pending@example.com", joined: false });
      const joined = makeMember({ id: 31, email: "joined@example.com", joined: true, joined_at: "2024-06-01T00:00:00Z" });
      setupMocks({ meRole: "owner", members: [pending, joined] });

      renderUsersPage();

      expect(screen.getByTestId("button-resend-invite-30")).toBeInTheDocument();
      expect(screen.getByTestId("button-revoke-invite-30")).toBeInTheDocument();
      expect(screen.queryByTestId("button-resend-invite-31")).not.toBeInTheDocument();
      expect(screen.queryByTestId("button-revoke-invite-31")).not.toBeInTheDocument();
    });

    it("does NOT show Resend invite or Revoke buttons for the owner row itself", () => {
      const ownerRow = makeMember({ id: 40, email: "owner@example.com", role: "owner", joined: true, joined_at: "2024-01-01T00:00:00Z" });
      const pending = makeMember({ id: 41, email: "pending@example.com", joined: false });
      setupMocks({ meRole: "owner", members: [ownerRow, pending] });

      renderUsersPage();

      expect(screen.queryByTestId("button-resend-invite-40")).not.toBeInTheDocument();
      expect(screen.queryByTestId("button-revoke-invite-40")).not.toBeInTheDocument();
    });
  });

  describe("when the current user is NOT an owner (member role)", () => {
    it("does NOT show Resend invite or Revoke buttons for any pending member", () => {
      const pending = makeMember({ id: 50, joined: false });
      setupMocks({ meRole: "member", members: [pending] });

      renderUsersPage();

      expect(screen.queryByTestId("button-resend-invite-50")).not.toBeInTheDocument();
      expect(screen.queryByTestId("button-revoke-invite-50")).not.toBeInTheDocument();
    });

    it("does NOT show Resend invite or Revoke buttons even when there are multiple pending members", () => {
      const p1 = makeMember({ id: 60, email: "a@example.com", joined: false });
      const p2 = makeMember({ id: 61, email: "b@example.com", joined: false });
      setupMocks({ meRole: "member", members: [p1, p2] });

      renderUsersPage();

      expect(screen.queryByTestId("button-resend-invite-60")).not.toBeInTheDocument();
      expect(screen.queryByTestId("button-revoke-invite-60")).not.toBeInTheDocument();
      expect(screen.queryByTestId("button-resend-invite-61")).not.toBeInTheDocument();
      expect(screen.queryByTestId("button-revoke-invite-61")).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: work schedule badge rendering
// ---------------------------------------------------------------------------

describe("UsersPage — work schedule badge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT show the schedule badge for a member with the default Mon–Fri schedule (null working_days)", () => {
    const member = makeMember({ id: 100, joined: true, joined_at: "2024-01-01T00:00:00Z", working_days: null });
    setupMocks({ meRole: "owner", members: [member] });

    renderUsersPage();

    expect(screen.queryByTestId("schedule-display-100")).not.toBeInTheDocument();
  });

  it("does NOT show the schedule badge for a member with an explicit Mon–Fri schedule", () => {
    const member = makeMember({
      id: 101,
      joined: true,
      joined_at: "2024-01-01T00:00:00Z",
      working_days: { ...DEFAULT_WORKING_DAYS },
    });
    setupMocks({ meRole: "owner", members: [member] });

    renderUsersPage();

    expect(screen.queryByTestId("schedule-display-101")).not.toBeInTheDocument();
  });

  it("shows the schedule badge with the correct text for a contiguous non-default schedule (Mon–Thu)", () => {
    const member = makeMember({
      id: 102,
      joined: true,
      joined_at: "2024-01-01T00:00:00Z",
      working_days: {
        monday: true,
        tuesday: true,
        wednesday: true,
        thursday: true,
        friday: false,
        saturday: false,
        sunday: false,
      },
    });
    setupMocks({ meRole: "owner", members: [member] });

    renderUsersPage();

    const badge = screen.getByTestId("schedule-display-102");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("Mon–Thu");
  });

  it("shows the schedule badge with comma-separated days for a non-contiguous schedule", () => {
    const member = makeMember({
      id: 103,
      joined: true,
      joined_at: "2024-01-01T00:00:00Z",
      working_days: {
        monday: true,
        tuesday: false,
        wednesday: true,
        thursday: false,
        friday: true,
        saturday: false,
        sunday: false,
      },
    });
    setupMocks({ meRole: "owner", members: [member] });

    renderUsersPage();

    const badge = screen.getByTestId("schedule-display-103");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("Mon, Wed, Fri");
  });

  it("shows the schedule badge with 'No working days' when all days are off", () => {
    const member = makeMember({
      id: 104,
      joined: true,
      joined_at: "2024-01-01T00:00:00Z",
      working_days: {
        monday: false,
        tuesday: false,
        wednesday: false,
        thursday: false,
        friday: false,
        saturday: false,
        sunday: false,
      },
    });
    setupMocks({ meRole: "owner", members: [member] });

    renderUsersPage();

    const badge = screen.getByTestId("schedule-display-104");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("No working days");
  });

  it("shows badge only for the non-default member when mixed schedules are present", () => {
    const defaultMember = makeMember({ id: 110, email: "default@example.com", joined: true, joined_at: "2024-01-01T00:00:00Z", working_days: null });
    const customMember = makeMember({
      id: 111,
      email: "custom@example.com",
      joined: true,
      joined_at: "2024-01-01T00:00:00Z",
      working_days: {
        monday: true,
        tuesday: true,
        wednesday: true,
        thursday: true,
        friday: true,
        saturday: true,
        sunday: false,
      },
    });
    setupMocks({ meRole: "owner", members: [defaultMember, customMember] });

    renderUsersPage();

    expect(screen.queryByTestId("schedule-display-110")).not.toBeInTheDocument();
    const badge = screen.getByTestId("schedule-display-111");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("Mon–Sat");
  });
});

// ---------------------------------------------------------------------------
// Tests: Edit button → employment info dialog
// ---------------------------------------------------------------------------

describe("UsersPage — Edit employment button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the employment info dialog pre-filled when the pencil Edit button is clicked", async () => {
    const user = userEvent.setup();
    const member = makeMember({
      id: 200,
      email: "alice@example.com",
      joined: true,
      joined_at: "2024-03-01T00:00:00Z",
      job_title: "Senior Designer",
      start_date: "2023-01-15",
      department: "Design",
      employment_type: "full_time",
      employment_status: "active",
      working_days: null,
    });
    setupMocks({ meRole: "owner", members: [member] });

    renderUsersPage();

    const editBtn = screen.getByTestId("button-edit-employment-200");
    await user.click(editBtn);

    expect(screen.getByTestId("dialog-employment-info")).toBeInTheDocument();

    const jobTitleInput = screen.getByTestId("input-job-title") as HTMLInputElement;
    expect(jobTitleInput.value).toBe("Senior Designer");
  });

  it("closes the dialog without saving when Cancel is clicked", async () => {
    const user = userEvent.setup();
    const member = makeMember({
      id: 201,
      email: "bob@example.com",
      joined: true,
      joined_at: "2024-04-01T00:00:00Z",
      job_title: "Developer",
      start_date: null,
      department: null,
      employment_type: null,
      employment_status: "active",
      working_days: null,
    });
    setupMocks({ meRole: "owner", members: [member] });

    const mutate = vi.fn();
    mockUseMutation.mockReturnValue({ mutate, isPending: false });

    renderUsersPage();

    const editBtn = screen.getByTestId("button-edit-employment-201");
    await user.click(editBtn);

    expect(screen.getByTestId("dialog-employment-info")).toBeInTheDocument();

    const cancelBtn = screen.getByTestId("button-cancel-employment-info");
    await user.click(cancelBtn);

    expect(screen.queryByTestId("dialog-employment-info")).not.toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("does NOT show the Edit button for a non-owner without users.edit permission", () => {
    const member = makeMember({
      id: 202,
      email: "charlie@example.com",
      joined: true,
      joined_at: "2024-05-01T00:00:00Z",
      job_title: "Analyst",
    });
    setupMocks({ meRole: "member", meAllowedPages: [], members: [member] });

    renderUsersPage();

    expect(screen.queryByTestId("button-edit-employment-202")).not.toBeInTheDocument();
  });

  it("calls mutate with the correct payload when Save is clicked, and closes the dialog after onSuccess", { timeout: 15000 }, async () => {
    const user = userEvent.setup();
    const member = makeMember({
      id: 300,
      email: "diana@example.com",
      joined: true,
      joined_at: "2024-06-01T00:00:00Z",
      job_title: "Designer",
      start_date: null,
      department: null,
      employment_type: null,
      employment_status: "active",
      working_days: null,
    });

    const mutate = vi.fn();
    // Capture the options passed to each useMutation call keyed by mutationKey
    // so the lookup is stable regardless of how many mutations Users.tsx defines
    // or in what order they appear. The employment info mutation declares
    // mutationKey: ["employmentInfo"] exactly for this purpose.
    const capturedByKey = new Map<string, { onSuccess?: () => void }>();
    mockUseMutation.mockImplementation(
      (opts: { mutationKey?: string[]; onSuccess?: () => void }) => {
        const key = opts?.mutationKey?.[0] ?? "";
        if (key) capturedByKey.set(key, opts ?? {});
        return { mutate, isPending: false };
      },
    );

    mockUseQuery.mockImplementation((opts: { queryKey: string[] }) => {
      const key = opts.queryKey[0];
      if (key === "users") {
        return {
          data: {
            members: [member],
            me: { role: "owner", email: "owner@example.com", allowedPages: null, customRoleId: null },
          },
          isLoading: false,
        };
      }
      return { data: undefined, isLoading: false };
    });

    renderUsersPage();

    const editBtn = screen.getByTestId("button-edit-employment-300");
    await user.click(editBtn);

    expect(screen.getByTestId("dialog-employment-info")).toBeInTheDocument();

    const jobTitleInput = screen.getByTestId("input-job-title") as HTMLInputElement;
    await user.clear(jobTitleInput);
    await user.type(jobTitleInput, "Senior Designer");

    const saveBtn = screen.getByTestId("button-save-employment-info");
    await user.click(saveBtn);

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 300,
        payload: expect.objectContaining({ jobTitle: "Senior Designer" }),
      })
    );

    // Look up the mutation by its stable mutationKey rather than a positional index.
    // Adding mutations before the employment one will not shift this lookup.
    const employmentOnSuccess = capturedByKey.get("employmentInfo")?.onSuccess;
    expect(employmentOnSuccess).toBeDefined();
    await act(async () => { employmentOnSuccess!(); });

    expect(screen.queryByTestId("dialog-employment-info")).not.toBeInTheDocument();
  });
});
