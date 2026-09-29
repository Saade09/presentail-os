import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("Address Collector one-send dashboard", () => {
  it("does not expose a manual WhatsApp reminder control", () => {
    const source = readFileSync("src/pages/AddressCollectorPage.tsx", "utf8");
    expect(source).not.toContain("address-collector-send-reminder");
    expect(source).not.toContain("/send-reminder");
  });

  it("describes one WhatsApp request instead of a reminder ladder", () => {
    const locale = JSON.parse(
      readFileSync("src/locales/en.json", "utf8"),
    ) as { addressCollector: { timingRules: string } };
    expect(locale.addressCollector.timingRules).toContain("One WhatsApp address request");
    expect(locale.addressCollector.timingRules).toContain("no repeat WhatsApp reminders");
    expect(locale.addressCollector.timingRules).not.toContain("reminder 2h");
  });
});