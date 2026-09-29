import { describe, expect, it } from "vitest";
import {
  dashboardStartupRetryDelay,
  retryDashboardStartup,
} from "./dashboardBootstrapRetry";

describe("dashboard startup retry", () => {
  const startupError = Object.assign(new Error("System update in progress"), {
    status: 503,
    code: "startup_in_progress",
  });

  it("retries only the bounded startup-readiness response", () => {
    expect(retryDashboardStartup(0, startupError)).toBe(true);
    expect(retryDashboardStartup(2, startupError)).toBe(true);
    expect(retryDashboardStartup(3, startupError)).toBe(false);
    expect(retryDashboardStartup(0, Object.assign(new Error("Unauthorized"), {
      status: 401,
      code: "unauthorized",
    }))).toBe(false);
    expect(retryDashboardStartup(0, Object.assign(new Error("Unavailable"), {
      status: 503,
      code: "other_failure",
    }))).toBe(false);
  });

  it("uses finite exponential delays capped at the server retry interval", () => {
    expect([
      dashboardStartupRetryDelay(0),
      dashboardStartupRetryDelay(1),
      dashboardStartupRetryDelay(2),
      dashboardStartupRetryDelay(3),
    ]).toEqual([1_000, 2_000, 4_000, 5_000]);
  });
});