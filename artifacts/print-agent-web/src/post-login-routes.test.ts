import { describe, expect, it } from "vitest";
import {
  getDashboardLanding,
  POST_LOGIN_ROUTES,
} from "./post-login-routes";

describe("getDashboardLanding", () => {
  it("keeps owners and unrestricted sessions on the existing device landing", () => {
    expect(getDashboardLanding(null)).toBe("/devices");
  });

  it("keeps ordinary members on the existing device landing", () => {
    expect(getDashboardLanding(["orders"])).toBe("/devices");
  });

  it("keeps Project Manager members on their existing dashboard", () => {
    expect(getDashboardLanding(["project-manager-dashboard"])).toBe(
      "/project-manager-dashboard",
    );
  });

  it("lands explicitly permitted Ops members on the Ops dashboard", () => {
    expect(getDashboardLanding(["ops-dashboard"])).toBe("/ops-dashboard");
  });

  it("gives the Ops dashboard precedence when both dashboard permissions exist", () => {
    expect(
      getDashboardLanding([
        "project-manager-dashboard",
        "ops-dashboard",
      ]),
    ).toBe("/ops-dashboard");
  });

  it("includes the Ops dashboard in post-login route validation", () => {
    expect(POST_LOGIN_ROUTES).toContain("/ops-dashboard");
  });
});