import { describe, it, expect } from "vitest";
import { computeBannerStatus } from "./homepageBannerStatus";

const now = new Date("2026-05-01T12:00:00Z").getTime();

describe("computeBannerStatus", () => {
  it("returns Draft when toggle is off and never activated", () => {
    expect(
      computeBannerStatus(
        { is_active: false, activated_at: null, start_at: null, end_at: null },
        now,
      ),
    ).toBe("Draft");
  });

  it("returns Inactive when toggle is off but was previously activated", () => {
    expect(
      computeBannerStatus(
        {
          is_active: false,
          activated_at: "2026-04-01T00:00:00Z",
          start_at: null,
          end_at: null,
        },
        now,
      ),
    ).toBe("Inactive");
  });

  it("returns Live when active and within the window", () => {
    expect(
      computeBannerStatus(
        {
          is_active: true,
          activated_at: "2026-04-01T00:00:00Z",
          start_at: "2026-04-15T00:00:00Z",
          end_at: "2026-06-01T00:00:00Z",
        },
        now,
      ),
    ).toBe("Live");
  });

  it("returns Live when active and no schedule bounds", () => {
    expect(
      computeBannerStatus(
        {
          is_active: true,
          activated_at: "2026-04-01T00:00:00Z",
          start_at: null,
          end_at: null,
        },
        now,
      ),
    ).toBe("Live");
  });

  it("returns Scheduled when active but start_at is in the future", () => {
    expect(
      computeBannerStatus(
        {
          is_active: true,
          activated_at: "2026-04-01T00:00:00Z",
          start_at: "2026-06-01T00:00:00Z",
          end_at: null,
        },
        now,
      ),
    ).toBe("Scheduled");
  });

  it("returns Expired when active but end_at is in the past", () => {
    expect(
      computeBannerStatus(
        {
          is_active: true,
          activated_at: "2026-01-01T00:00:00Z",
          start_at: "2026-01-15T00:00:00Z",
          end_at: "2026-04-01T00:00:00Z",
        },
        now,
      ),
    ).toBe("Expired");
  });

  it("Expired takes precedence over Scheduled when both bounds are out of order", () => {
    expect(
      computeBannerStatus(
        {
          is_active: true,
          activated_at: "2026-01-01T00:00:00Z",
          start_at: "2026-06-01T00:00:00Z",
          end_at: "2026-04-01T00:00:00Z",
        },
        now,
      ),
    ).toBe("Expired");
  });

  it("accepts Date objects for start_at/end_at", () => {
    expect(
      computeBannerStatus(
        {
          is_active: true,
          activated_at: new Date("2026-04-01T00:00:00Z"),
          start_at: new Date("2026-04-15T00:00:00Z"),
          end_at: new Date("2026-06-01T00:00:00Z"),
        },
        now,
      ),
    ).toBe("Live");
  });
});
