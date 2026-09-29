import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import RolesPage from "./Roles";
import { computeSmartDefault } from "@/lib/roleDefaults";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const mockUseQuery = vi.fn();
const mockMutate = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[] }) => mockUseQuery(opts),
  useMutation: vi.fn(() => ({ mutate: mockMutate, isPending: false })),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  queryClient: { invalidateQueries: vi.fn() },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Member = {
  id: number;
  email: string;
  role: string;
  custom_role_id: number | null;
  role_name: string | null;
};

function member(
  id: number,
  custom_role_id: number | null,
  role = "member",
): Member {
  return { id, email: `user${id}@test.com`, role, custom_role_id, role_name: null };
}

// ---------------------------------------------------------------------------
// Unit tests: computeSmartDefault pure function
// ---------------------------------------------------------------------------

describe("computeSmartDefault – smart pre-selection algorithm", () => {
  it("returns the most common role among non-affected members", () => {
    const deletingId = 1;
    const affected = [member(10, deletingId), member(11, deletingId)];
    const allMembers = [
      ...affected,
      member(20, 2),
      member(21, 2),
      member(22, 2),
      member(23, 3),
    ];

    expect(computeSmartDefault(allMembers, deletingId, affected)).toBe(2);
  });

  it("returns null when no non-affected members hold a custom role", () => {
    const deletingId = 1;
    const affected = [member(10, deletingId)];
    const allMembers = [
      ...affected,
      member(20, null),
      member(21, null),
    ];

    expect(computeSmartDefault(allMembers, deletingId, affected)).toBeNull();
  });

  it("excludes owners from the tally", () => {
    const deletingId = 1;
    const affected = [member(10, deletingId)];
    const ownerWithRole2 = { ...member(30, 2), role: "owner" };
    const ownerWithRole2b = { ...member(31, 2), role: "owner" };
    const allMembers = [
      ...affected,
      ownerWithRole2,
      ownerWithRole2b,
      member(40, 3),
    ];

    expect(computeSmartDefault(allMembers, deletingId, affected)).toBe(3);
  });

  it("excludes members still carrying the role being deleted from the tally", () => {
    const deletingId = 1;
    const affected = [member(10, deletingId)];
    const allMembers = [
      ...affected,
      member(20, deletingId),
      member(21, deletingId),
      member(22, 2),
    ];

    expect(computeSmartDefault(allMembers, deletingId, affected)).toBe(2);
  });

  it("excludes members with no role (null) from the tally", () => {
    const deletingId = 1;
    const affected = [member(10, deletingId)];
    const allMembers = [
      ...affected,
      member(20, null),
      member(21, null),
      member(22, null),
      member(23, 2),
      member(24, 2),
      member(25, 3),
    ];

    expect(computeSmartDefault(allMembers, deletingId, affected)).toBe(2);
  });

  it("does not count affected members toward the tally even if they would win", () => {
    const deletingId = 1;
    const affected = [
      member(10, deletingId),
      member(11, deletingId),
      member(12, deletingId),
    ];
    const allMembers = [
      ...affected,
      member(20, 2),
      member(21, 3),
      member(22, 3),
    ];

    expect(computeSmartDefault(allMembers, deletingId, affected)).toBe(3);
  });

  it("returns null when all members are affected (no one left to tally)", () => {
    const deletingId = 1;
    const affected = [member(10, deletingId), member(11, deletingId)];

    expect(computeSmartDefault([...affected], deletingId, affected)).toBeNull();
  });

  it("returns null when all non-affected members are owners or have no role", () => {
    const deletingId = 1;
    const affected = [member(10, deletingId)];
    const allMembers = [
      ...affected,
      { ...member(20, 2), role: "owner" },
      member(21, null),
    ];

    expect(computeSmartDefault(allMembers, deletingId, affected)).toBeNull();
  });

  it("handles an empty member list without throwing", () => {
    expect(computeSmartDefault([], 1, [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PageCheckboxes: products.manage sub-permission visibility
// ---------------------------------------------------------------------------

describe("PageCheckboxes — products.manage sub-permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      if (opts.queryKey[0] === "roles") return { data: { roles: [] }, isLoading: false };
      return { data: undefined, isLoading: false };
    });
  });

  function openCreateForm() {
    render(<RolesPage />);
    fireEvent.click(screen.getByTestId("button-new-role"));
  }

  it("does not show the products.manage sub-checkbox when Products is unchecked", () => {
    openCreateForm();

    expect(screen.queryByTestId("checkbox-page-products.manage")).toBeNull();
  });

  it("shows the products.manage sub-checkbox after Products is checked", async () => {
    openCreateForm();

    fireEvent.click(screen.getByTestId("checkbox-page-products"));

    await waitFor(() => {
      expect(screen.getByTestId("checkbox-page-products.manage")).toBeTruthy();
    });
  });

  it("hides the products.manage sub-checkbox again when Products is unchecked", async () => {
    openCreateForm();

    fireEvent.click(screen.getByTestId("checkbox-page-products"));
    await waitFor(() => {
      expect(screen.getByTestId("checkbox-page-products.manage")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("checkbox-page-products"));
    await waitFor(() => {
      expect(screen.queryByTestId("checkbox-page-products.manage")).toBeNull();
    });
  });

  it("removes products.manage from the selection when Products is unchecked", async () => {
    openCreateForm();

    // Check Products, then check products.manage
    fireEvent.click(screen.getByTestId("checkbox-page-products"));
    await waitFor(() => {
      expect(screen.getByTestId("checkbox-page-products.manage")).toBeTruthy();
    });

    const manageCheckbox = screen.getByTestId("checkbox-page-products.manage");
    fireEvent.click(manageCheckbox);
    await waitFor(() => {
      expect(manageCheckbox).toHaveAttribute("data-state", "checked");
    });

    // Uncheck Products — products.manage should be removed from state
    fireEvent.click(screen.getByTestId("checkbox-page-products"));
    await waitFor(() => {
      expect(screen.queryByTestId("checkbox-page-products.manage")).toBeNull();
    });

    // Re-check Products: the sub-checkbox should be unchecked (not still selected)
    // proving products.manage was cleared from state, not merely hidden
    fireEvent.click(screen.getByTestId("checkbox-page-products"));
    await waitFor(() => {
      const reShownManageCheckbox = screen.getByTestId("checkbox-page-products.manage");
      expect(reShownManageCheckbox).toHaveAttribute("data-state", "unchecked");
    });
  });

  it("does not affect brands.delete when toggling Products", async () => {
    openCreateForm();

    fireEvent.click(screen.getByTestId("checkbox-page-brands"));
    await waitFor(() => {
      expect(screen.getByTestId("checkbox-page-brands.delete")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("checkbox-page-products"));
    await waitFor(() => {
      expect(screen.getByTestId("checkbox-page-products.manage")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("checkbox-page-products"));
    await waitFor(() => {
      expect(screen.queryByTestId("checkbox-page-products.manage")).toBeNull();
    });

    expect(screen.getByTestId("checkbox-page-brands.delete")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// CMC POS permission rows: group search and independent page grants
// ---------------------------------------------------------------------------

describe("GroupedPermissionEditor — CMC POS page permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      if (opts.queryKey[0] === "roles") return { data: { roles: [] }, isLoading: false };
      return { data: undefined, isLoading: false };
    });
  });

  it("shows Dashboard, New Order, and legacy CMC actions when searching for CMC", async () => {
    render(<RolesPage />);
    fireEvent.click(screen.getByTestId("button-new-role"));
    fireEvent.change(screen.getByTestId("input-permission-search"), {
      target: { value: "CMC" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("checkbox-page-cmc-pos-dashboard")).toBeTruthy();
      expect(screen.getByTestId("checkbox-page-cmc-pos-new-order")).toBeTruthy();
      expect(screen.getByTestId("checkbox-page-cmc-pos")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("checkbox-page-cmc-pos"));
    await waitFor(() => {
      expect(screen.getByTestId("checkbox-page-cmc_pos.sell")).toBeTruthy();
    });
  });

  it.each([
    ["Dashboard only", ["cmc-pos-dashboard"], "checked", "unchecked"],
    ["New Order only", ["cmc-pos-new-order"], "unchecked", "checked"],
    ["both pages", ["cmc-pos-dashboard", "cmc-pos-new-order"], "checked", "checked"],
    ["neither page", [], "unchecked", "unchecked"],
  ])(
    "preserves the %s grant when reopening an existing role",
    async (_scenario, allowedPages, dashboardState, newOrderState) => {
      mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
        if (opts.queryKey[0] === "roles") {
          return {
            data: {
              roles: [{
                id: 1,
                name: "CMC Role",
                description: null,
                allowed_pages: allowedPages,
                channel_ids: [],
              }],
            },
            isLoading: false,
          };
        }
        return { data: undefined, isLoading: false };
      });

      render(<RolesPage />);
      fireEvent.click(screen.getByTestId("button-edit-role-1"));

      await waitFor(() => {
        expect(screen.getByTestId("checkbox-page-cmc-pos-dashboard"))
          .toHaveAttribute("data-state", dashboardState);
        expect(screen.getByTestId("checkbox-page-cmc-pos-new-order"))
          .toHaveAttribute("data-state", newOrderState);
      });
    },
  );
});

describe("GroupedPermissionEditor — Invoice Scanners page permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      if (opts.queryKey[0] === "roles") return { data: { roles: [] }, isLoading: false };
      return { data: undefined, isLoading: false };
    });
  });

  it("shows and toggles Invoice Scanners independently from Devices", async () => {
    render(<RolesPage />);
    fireEvent.click(screen.getByTestId("button-new-role"));

    const devices = screen.getByTestId("checkbox-page-devices");
    const scanners = screen.getByTestId("checkbox-page-invoice-scanners");
    expect(devices).toHaveAttribute("data-state", "unchecked");
    expect(scanners).toHaveAttribute("data-state", "unchecked");

    fireEvent.click(scanners);
    await waitFor(() => {
      expect(scanners).toHaveAttribute("data-state", "checked");
      expect(devices).toHaveAttribute("data-state", "unchecked");
    });
  });

  it("restores Invoice Scanners when editing a role that has the new key", async () => {
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      if (opts.queryKey[0] === "roles") {
        return {
          data: {
            roles: [{
              id: 1,
              name: "Scanner Role",
              description: null,
              allowed_pages: ["invoice-scanners"],
              channel_ids: [],
            }],
          },
          isLoading: false,
        };
      }
      return { data: undefined, isLoading: false };
    });

    render(<RolesPage />);
    fireEvent.click(screen.getByTestId("button-edit-role-1"));

    await waitFor(() => {
      expect(screen.getByTestId("checkbox-page-invoice-scanners"))
        .toHaveAttribute("data-state", "checked");
    });
  });

  it("drops retired page keys before saving an older role", async () => {
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      if (opts.queryKey[0] === "roles") {
        return {
          data: {
            roles: [{
              id: 1,
              name: "Legacy Role",
              description: null,
              allowed_pages: ["generate-invoice"],
              channel_ids: [],
            }],
          },
          isLoading: false,
        };
      }
      return { data: undefined, isLoading: false };
    });

    render(<RolesPage />);
    fireEvent.click(screen.getByTestId("button-edit-role-1"));
    fireEvent.click(screen.getByTestId("button-role-submit"));

    expect(mockMutate).toHaveBeenCalledWith({
      id: 1,
      name: "Legacy Role",
      description: null,
      allowedPages: [],
      channelIds: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Component integration test: name duplicate warning in the create-role form
// ---------------------------------------------------------------------------

describe("RolesPage – name duplicate warning in create form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      const key = opts.queryKey[0];
      if (key === "roles") {
        return {
          data: { roles: [{ id: 1, name: "Designer", allowed_pages: [], channel_ids: [] }] },
          isLoading: false,
        };
      }
      return { data: undefined, isLoading: false };
    });
  });

  function openCreateForm() {
    render(<RolesPage />);
    fireEvent.click(screen.getByTestId("button-new-role"));
  }

  it("shows no warning when the name field is empty", async () => {
    openCreateForm();

    await waitFor(() => {
      expect(screen.queryByTestId("name-warning-exact")).toBeNull();
      expect(screen.queryByTestId("name-warning-similar")).toBeNull();
    });
  });

  it("shows an exact-match warning when the typed name matches an existing role exactly", async () => {
    openCreateForm();

    fireEvent.change(screen.getByTestId("input-role-name"), {
      target: { value: "Designer" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toHaveTextContent("Designer");
    });
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("is case-insensitive when detecting an exact match", async () => {
    openCreateForm();

    fireEvent.change(screen.getByTestId("input-role-name"), {
      target: { value: "DESIGNER" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });
  });

  it("shows a similar-match warning when the typed name is a substring of an existing role name", async () => {
    openCreateForm();

    fireEvent.change(screen.getByTestId("input-role-name"), {
      target: { value: "Design" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-similar")).toHaveTextContent("Designer");
    });
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
  });

  it("clears the warning when the name is changed to something unrelated", async () => {
    openCreateForm();

    fireEvent.change(screen.getByTestId("input-role-name"), {
      target: { value: "Designer" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("input-role-name"), {
      target: { value: "Finance" },
    });

    await waitFor(() => {
      expect(screen.queryByTestId("name-warning-exact")).toBeNull();
      expect(screen.queryByTestId("name-warning-similar")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Component integration test: dialog pre-selection
// ---------------------------------------------------------------------------

const ROLE_DESIGNER = { id: 1, name: "Designer", allowed_pages: [], channel_ids: [] };
const ROLE_MANAGER = { id: 2, name: "Manager", allowed_pages: [], channel_ids: [] };

// Two members on role 1 (affected when deleting role 1)
const AFFECTED_MEMBER_A = member(101, 1);
const AFFECTED_MEMBER_B = member(102, 1);

// Three members on role 2 (most common non-affected role → smart default)
const OTHER_MEMBER_1 = member(201, 2);
const OTHER_MEMBER_2 = member(202, 2);
const OTHER_MEMBER_3 = member(203, 2);

const ALL_MEMBERS = [
  AFFECTED_MEMBER_A,
  AFFECTED_MEMBER_B,
  OTHER_MEMBER_1,
  OTHER_MEMBER_2,
  OTHER_MEMBER_3,
];

function setupQueryMocks() {
  mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
    const key = opts.queryKey[0];
    if (key === "roles") {
      return { data: { roles: [ROLE_DESIGNER, ROLE_MANAGER] }, isLoading: false };
    }
    if (key === "users") {
      return { data: { members: ALL_MEMBERS }, isLoading: false };
    }
    return { data: undefined, isLoading: false };
  });
}

// ---------------------------------------------------------------------------
// Component integration test: name duplicate warning in the edit-role form
// ---------------------------------------------------------------------------

describe("RolesPage – name duplicate warning in edit form (self-match exclusion)", () => {
  const ROLE_DESIGNER = { id: 1, name: "Designer", allowed_pages: [], channel_ids: [] };
  const ROLE_MANAGER = { id: 2, name: "Manager", allowed_pages: [], channel_ids: [] };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      if (opts.queryKey[0] === "roles") {
        return {
          data: { roles: [ROLE_DESIGNER, ROLE_MANAGER] },
          isLoading: false,
        };
      }
      return { data: undefined, isLoading: false };
    });
  });

  function openEditForm() {
    render(<RolesPage />);
    fireEvent.click(screen.getByTestId("button-edit-role-1"));
  }

  it("shows no warning when the edit form opens (own name is pre-filled and excluded)", async () => {
    openEditForm();

    await waitFor(() => {
      expect(screen.queryByTestId("name-warning-exact")).toBeNull();
      expect(screen.queryByTestId("name-warning-similar")).toBeNull();
    });
  });

  it("shows an exact-match warning when typing a name that matches another role", async () => {
    openEditForm();

    fireEvent.change(screen.getByTestId("input-role-name"), {
      target: { value: "Manager" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toHaveTextContent("Manager");
    });
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("suppresses the warning when typing the role's own current name (self-match exclusion)", async () => {
    openEditForm();

    fireEvent.change(screen.getByTestId("input-role-name"), {
      target: { value: "Manager" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("input-role-name"), {
      target: { value: "Designer" },
    });

    await waitFor(() => {
      expect(screen.queryByTestId("name-warning-exact")).toBeNull();
      expect(screen.queryByTestId("name-warning-similar")).toBeNull();
    });
  });

  it("shows a similar-match warning when the typed name overlaps with another role", async () => {
    openEditForm();

    fireEvent.change(screen.getByTestId("input-role-name"), {
      target: { value: "Manage" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-similar")).toHaveTextContent("Manager");
    });
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
  });
});

describe("RolesPage – delete-role dialog smart pre-selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupQueryMocks();
  });

  it("pre-populates the bulk select with the most-common non-affected role", async () => {
    render(<RolesPage />);

    // Click delete on role 1 (Designer)
    fireEvent.click(screen.getByTestId("button-delete-role-1"));

    // Bulk select trigger should show the smart default: "Manager" (role 2)
    await waitFor(() => {
      const bulkTrigger = screen.getByTestId("select-reassign-all");
      expect(bulkTrigger).toHaveTextContent("Manager");
    });
  });

  it("pre-populates every affected member's select with the most-common non-affected role", async () => {
    render(<RolesPage />);

    fireEvent.click(screen.getByTestId("button-delete-role-1"));

    await waitFor(() => {
      const triggerA = screen.getByTestId(`select-reassign-${AFFECTED_MEMBER_A.id}`);
      const triggerB = screen.getByTestId(`select-reassign-${AFFECTED_MEMBER_B.id}`);
      expect(triggerA).toHaveTextContent("Manager");
      expect(triggerB).toHaveTextContent("Manager");
    });
  });

  it("pre-populates with 'No role' when no other custom roles are in use", async () => {
    // Override: all non-affected members have no custom role
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      const key = opts.queryKey[0];
      if (key === "roles") {
        return { data: { roles: [ROLE_DESIGNER, ROLE_MANAGER] }, isLoading: false };
      }
      if (key === "users") {
        return {
          data: {
            members: [
              AFFECTED_MEMBER_A,
              AFFECTED_MEMBER_B,
              member(301, null),
              member(302, null),
            ],
          },
          isLoading: false,
        };
      }
      return { data: undefined, isLoading: false };
    });

    render(<RolesPage />);

    fireEvent.click(screen.getByTestId("button-delete-role-1"));

    await waitFor(() => {
      const triggerA = screen.getByTestId(`select-reassign-${AFFECTED_MEMBER_A.id}`);
      expect(triggerA).toHaveTextContent("No role");
    });
  });
});

// ---------------------------------------------------------------------------
// PageCheckboxes: brands.manage sub-permission visibility
// ---------------------------------------------------------------------------

describe("PageCheckboxes — brands.manage sub-permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      if (opts.queryKey[0] === "roles") return { data: { roles: [] }, isLoading: false };
      return { data: undefined, isLoading: false };
    });
  });

  function openCreateForm() {
    render(<RolesPage />);
    fireEvent.click(screen.getByTestId("button-new-role"));
  }

  it("does not show the brands.manage sub-checkbox when Brands is unchecked", () => {
    openCreateForm();

    expect(screen.queryByTestId("checkbox-page-brands.manage")).toBeNull();
  });

  it("shows the brands.manage sub-checkbox after Brands is checked", async () => {
    openCreateForm();

    fireEvent.click(screen.getByTestId("checkbox-page-brands"));

    await waitFor(() => {
      expect(screen.getByTestId("checkbox-page-brands.manage")).toBeTruthy();
    });
  });

  it("hides the brands.manage sub-checkbox again when Brands is unchecked", async () => {
    openCreateForm();

    fireEvent.click(screen.getByTestId("checkbox-page-brands"));
    await waitFor(() => {
      expect(screen.getByTestId("checkbox-page-brands.manage")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("checkbox-page-brands"));
    await waitFor(() => {
      expect(screen.queryByTestId("checkbox-page-brands.manage")).toBeNull();
    });
  });

  it("removes brands.manage from the selection when Brands is unchecked", async () => {
    openCreateForm();

    fireEvent.click(screen.getByTestId("checkbox-page-brands"));
    await waitFor(() => {
      expect(screen.getByTestId("checkbox-page-brands.manage")).toBeTruthy();
    });

    const manageCheckbox = screen.getByTestId("checkbox-page-brands.manage");
    fireEvent.click(manageCheckbox);
    await waitFor(() => {
      expect(manageCheckbox).toHaveAttribute("data-state", "checked");
    });

    fireEvent.click(screen.getByTestId("checkbox-page-brands"));
    await waitFor(() => {
      expect(screen.queryByTestId("checkbox-page-brands.manage")).toBeNull();
    });

    fireEvent.click(screen.getByTestId("checkbox-page-brands"));
    await waitFor(() => {
      const reShownManageCheckbox = screen.getByTestId("checkbox-page-brands.manage");
      expect(reShownManageCheckbox).toHaveAttribute("data-state", "unchecked");
    });
  });
});
