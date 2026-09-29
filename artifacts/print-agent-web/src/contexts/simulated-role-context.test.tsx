import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SimulatedRoleProvider,
  useSimulatedRole,
  type SimulatedRole,
} from "./simulated-role-context";

const SESSION_KEY = "simulatedRole";

const DESIGNER_ROLE: SimulatedRole = { id: 1, name: "Designer" };
const CSA_ROLE: SimulatedRole = { id: 2, name: "Customer Service Agent" };
const OWNER_ROLE: SimulatedRole = { id: 3, name: "Owner" };

function BannerConsumer() {
  const { simulatedRole, setSimulatedRole } = useSimulatedRole();

  return (
    <>
      {simulatedRole && (
        <div data-testid="impersonation-banner">
          <span>Viewing as {simulatedRole.name}</span>
          <button
            data-testid="exit-simulation-button"
            onClick={() => setSimulatedRole(null)}
          >
            Exit
          </button>
        </div>
      )}
      {!simulatedRole && <span data-testid="no-role">No role</span>}
    </>
  );
}

function renderWithProvider() {
  return render(
    <SimulatedRoleProvider>
      <BannerConsumer />
    </SimulatedRoleProvider>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
});

describe("SimulatedRoleProvider – sessionStorage persistence", () => {
  it("restores the simulated role after a page refresh (provider re-mount)", () => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(DESIGNER_ROLE));

    renderWithProvider();

    expect(screen.getByTestId("impersonation-banner")).toBeInTheDocument();
    expect(screen.getByTestId("impersonation-banner")).toHaveTextContent(DESIGNER_ROLE.name);
  });

  it("shows no banner when sessionStorage is empty on mount", () => {
    renderWithProvider();

    expect(screen.queryByTestId("impersonation-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("no-role")).toBeInTheDocument();
  });

  it("removes the sessionStorage key when Exit is clicked", async () => {
    const user = userEvent.setup();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(CSA_ROLE));

    renderWithProvider();

    expect(screen.getByTestId("impersonation-banner")).toBeInTheDocument();

    await user.click(screen.getByTestId("exit-simulation-button"));

    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect(screen.queryByTestId("impersonation-banner")).not.toBeInTheDocument();
  });

  it("persists the role to sessionStorage when setSimulatedRole is called", async () => {
    function SetRoleButton() {
      const { setSimulatedRole } = useSimulatedRole();
      return (
        <button
          data-testid="set-role"
          onClick={() => setSimulatedRole(OWNER_ROLE)}
        >
          Set owner
        </button>
      );
    }

    const user = userEvent.setup();

    render(
      <SimulatedRoleProvider>
        <BannerConsumer />
        <SetRoleButton />
      </SimulatedRoleProvider>,
    );

    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();

    await user.click(screen.getByTestId("set-role"));

    expect(JSON.parse(sessionStorage.getItem(SESSION_KEY)!)).toMatchObject(OWNER_ROLE);

    expect(screen.getByTestId("impersonation-banner")).toBeInTheDocument();
  });

  it("banner survives a page refresh – set role, unmount, remount, assert banner is shown", async () => {
    function SetRoleButton({ role }: { role: SimulatedRole }) {
      const { setSimulatedRole } = useSimulatedRole();
      return (
        <button
          data-testid="set-role"
          onClick={() => setSimulatedRole(role)}
        >
          Set role
        </button>
      );
    }

    const user = userEvent.setup();

    const { unmount } = render(
      <SimulatedRoleProvider>
        <BannerConsumer />
        <SetRoleButton role={DESIGNER_ROLE} />
      </SimulatedRoleProvider>,
    );

    await user.click(screen.getByTestId("set-role"));
    expect(JSON.parse(sessionStorage.getItem(SESSION_KEY)!)).toMatchObject(DESIGNER_ROLE);
    expect(screen.getByTestId("impersonation-banner")).toBeInTheDocument();

    unmount();

    render(
      <SimulatedRoleProvider>
        <BannerConsumer />
      </SimulatedRoleProvider>,
    );

    expect(screen.getByTestId("impersonation-banner")).toBeInTheDocument();
    expect(screen.getByTestId("impersonation-banner")).toHaveTextContent(DESIGNER_ROLE.name);
  });
});
