import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  buildScannerStationPayload,
  getScannerStationRecoveryGuidance,
  ScannerCommissioningGuide,
  WindowsAgentDownloadAction,
} from "./InvoiceScanners";

describe("WindowsAgentDownloadAction", () => {
  it("links to the scanner-specific installer route when published", () => {
    render(<WindowsAgentDownloadAction available loading={false} />);

    const link = screen.getByRole("link", { name: "Download Windows Agent" });
    expect(link).toHaveAttribute("href", "/api/download/scanner-agent");
  });

  it("shows an explicit disabled state when no installer is published", () => {
    render(<WindowsAgentDownloadAction available={false} loading={false} />);

    expect(
      screen.getByRole("button", { name: "Windows Agent unavailable" }),
    ).toBeDisabled();
  });
});


describe("scanner station commissioning contract", () => {
  it("sends the selected entity under the API's default_entity_id field", () => {
    expect(
      buildScannerStationPayload({
        name: "  Reception Scanner  ",
        default_entity_id: "42",
        location: "  Dubai office  ",
      }),
    ).toEqual({
      name: "Reception Scanner",
      default_entity_id: 42,
      location: "Dubai office",
    });
  });

  it("connects installation, pairing, heartbeat, and first upload instructions", () => {
    render(<ScannerCommissioningGuide />);

    expect(screen.getByText(/reopen it from the start menu/i)).toBeInTheDocument();
    expect(screen.getByText(/exact OS URL and code/i)).toBeInTheDocument();
    expect(screen.getByText(/fresh one-time code/i)).toBeInTheDocument();
    expect(screen.getByText(/green tray icon/i)).toBeInTheDocument();
    expect(screen.getByText(/last-seen time/i)).toBeInTheDocument();
    expect(screen.getByText(/C:\\PresentailScanner\\Inbox/i)).toBeInTheDocument();
    expect(screen.getByText(/Recent Imports/i)).toBeInTheDocument();
  });

  it("gives distinct recovery steps for disabled and misconfigured stations", () => {
    expect(
      getScannerStationRecoveryGuidance({
        status: "disabled",
        default_entity_id: 42,
        default_entity_active: true,
      }),
    ).toMatch(/enable it.*fresh pairing code/i);

    expect(
      getScannerStationRecoveryGuidance({
        status: "active",
        default_entity_id: 42,
        default_entity_active: false,
      }),
    ).toMatch(/active default entity.*re-pair/i);
  });
});