import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUseListSecuritySessions = vi.fn();
vi.mock("@workspace/api-client-react", () => ({
  useListSecuritySessions: () => mockUseListSecuritySessions(),
}));

vi.mock("wouter", () => ({
  Link: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: () => void;
    [key: string]: unknown;
  }) => (
    <a href={href} onClick={onClick} {...rest}>
      {children}
    </a>
  ),
}));

// ---------------------------------------------------------------------------
// Import component AFTER mocks are set up
// ---------------------------------------------------------------------------

import { NewSessionBanner } from "./NewSessionBanner";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = "presentail_known_session_labels";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(deviceLabel: string, country?: string | null) {
  return { deviceLabel, country: country ?? null };
}

/** Seed storage with the old (v1) string-array format to test migration paths. */
function seedKnownLabels(labels: string[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(labels));
}

/** Seed storage with the new {label, country} format. */
function seedKnownEntries(entries: Array<{ label: string; country: string | null }>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

interface StoredEntry {
  label: string;
  country: string | null;
}

function readStoredEntries(): StoredEntry[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  if (parsed.length === 0) return [];
  if (typeof parsed[0] === "string") {
    return (parsed as string[]).map((label) => ({ label, country: null }));
  }
  return parsed as StoredEntry[];
}

function readStoredLabels(): string[] {
  return readStoredEntries().map((e) => e.label);
}

function renderBanner() {
  return render(<NewSessionBanner />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockUseListSecuritySessions.mockReturnValue({ data: undefined, isSuccess: false });
});

afterEach(() => {
  localStorage.clear();
});

describe("NewSessionBanner – banner not shown when no new sessions", () => {
  it("renders nothing when the API has not yet responded", () => {
    mockUseListSecuritySessions.mockReturnValue({
      data: undefined,
      isSuccess: false,
    });

    renderBanner();

    expect(screen.queryByTestId("new-session-banner")).not.toBeInTheDocument();
  });

  it("renders nothing when all sessions are already known", () => {
    seedKnownLabels(["MacBook Chrome"]);
    mockUseListSecuritySessions.mockReturnValue({
      data: { sessions: [makeSession("MacBook Chrome")] },
      isSuccess: true,
    });

    renderBanner();

    expect(screen.queryByTestId("new-session-banner")).not.toBeInTheDocument();
  });

  it("silently seeds the baseline on first load (no known labels) without showing the banner", () => {
    // No known labels stored — first-ever load should never alert
    mockUseListSecuritySessions.mockReturnValue({
      data: { sessions: [makeSession("iPhone Safari")] },
      isSuccess: true,
    });

    renderBanner();

    expect(screen.queryByTestId("new-session-banner")).not.toBeInTheDocument();
    // And the baseline should now be seeded in storage
    expect(readStoredLabels()).toContain("iPhone Safari");
  });
});

describe("NewSessionBanner – banner appears for unrecognized sessions", () => {
  it("shows the banner with the correct device name when a new session label is detected", () => {
    seedKnownLabels(["MacBook Chrome"]);
    mockUseListSecuritySessions.mockReturnValue({
      data: {
        sessions: [makeSession("MacBook Chrome"), makeSession("Windows Firefox")],
      },
      isSuccess: true,
    });

    renderBanner();

    expect(screen.getByTestId("new-session-banner")).toBeInTheDocument();
    expect(screen.getByText(/New sign-in detected on Windows Firefox\./)).toBeInTheDocument();
  });

  it("shows a plural message when multiple new session labels are detected", () => {
    seedKnownLabels(["MacBook Chrome"]);
    mockUseListSecuritySessions.mockReturnValue({
      data: {
        sessions: [
          makeSession("MacBook Chrome"),
          makeSession("Windows Firefox"),
          makeSession("Android Chrome"),
        ],
      },
      isSuccess: true,
    });

    renderBanner();

    expect(screen.getByTestId("new-session-banner")).toBeInTheDocument();
    expect(
      screen.getByText(/New sign-ins detected on 2 new devices or locations\./)
    ).toBeInTheDocument();
  });
});

describe("NewSessionBanner – country mismatch", () => {
  it("shows a country-specific message when a known device signs in from a new country", () => {
    seedKnownEntries([{ label: "MacBook Chrome", country: "US" }]);
    mockUseListSecuritySessions.mockReturnValue({
      data: {
        sessions: [makeSession("MacBook Chrome", "DE")],
      },
      isSuccess: true,
    });

    renderBanner();

    expect(screen.getByTestId("new-session-banner")).toBeInTheDocument();
    expect(
      screen.getByText(/New sign-in on MacBook Chrome detected from DE\./)
    ).toBeInTheDocument();
  });

  it("falls back gracefully when country is null on a country-mismatch session", () => {
    // Known entry has a country set, new session has no country info
    seedKnownEntries([{ label: "MacBook Chrome", country: "US" }]);
    mockUseListSecuritySessions.mockReturnValue({
      data: {
        sessions: [makeSession("MacBook Chrome", null)],
      },
      isSuccess: true,
    });

    renderBanner();

    expect(screen.getByTestId("new-session-banner")).toBeInTheDocument();
    expect(
      screen.getByText(/New sign-in on MacBook Chrome detected from an unexpected location\./)
    ).toBeInTheDocument();
  });

  it("does NOT alert on country change when the stored entry has null country (migrated data)", () => {
    // Old-format entry migrates to { label, country: null } — should never
    // trigger a country-mismatch alert so existing users aren't spammed.
    seedKnownLabels(["MacBook Chrome"]);
    mockUseListSecuritySessions.mockReturnValue({
      data: {
        sessions: [makeSession("MacBook Chrome", "AE")],
      },
      isSuccess: true,
    });

    renderBanner();

    expect(screen.queryByTestId("new-session-banner")).not.toBeInTheDocument();
  });

  it("shows a plural message when there is a mix of new-device and country-mismatch alerts", () => {
    seedKnownEntries([{ label: "MacBook Chrome", country: "US" }]);
    mockUseListSecuritySessions.mockReturnValue({
      data: {
        sessions: [
          makeSession("MacBook Chrome", "DE"),
          makeSession("Windows Firefox", null),
        ],
      },
      isSuccess: true,
    });

    renderBanner();

    expect(screen.getByTestId("new-session-banner")).toBeInTheDocument();
    expect(
      screen.getByText(/New sign-ins detected on 2 new devices or locations\./)
    ).toBeInTheDocument();
  });

  it("does not alert when the same device+country pair is already known", () => {
    seedKnownEntries([{ label: "MacBook Chrome", country: "US" }]);
    mockUseListSecuritySessions.mockReturnValue({
      data: {
        sessions: [makeSession("MacBook Chrome", "US")],
      },
      isSuccess: true,
    });

    renderBanner();

    expect(screen.queryByTestId("new-session-banner")).not.toBeInTheDocument();
  });
});

describe("NewSessionBanner – dismiss button", () => {
  it("hides the banner when the dismiss button is clicked", () => {
    seedKnownLabels(["MacBook Chrome"]);
    mockUseListSecuritySessions.mockReturnValue({
      data: {
        sessions: [makeSession("MacBook Chrome"), makeSession("Windows Firefox")],
      },
      isSuccess: true,
    });

    renderBanner();

    expect(screen.getByTestId("new-session-banner")).toBeInTheDocument();

    act(() => {
      screen.getByTestId("new-session-banner-dismiss").click();
    });

    expect(screen.queryByTestId("new-session-banner")).not.toBeInTheDocument();
  });

  it("writes the full current session set to localStorage after dismissing", () => {
    seedKnownLabels(["MacBook Chrome"]);
    mockUseListSecuritySessions.mockReturnValue({
      data: {
        sessions: [makeSession("MacBook Chrome"), makeSession("Windows Firefox")],
      },
      isSuccess: true,
    });

    renderBanner();

    act(() => {
      screen.getByTestId("new-session-banner-dismiss").click();
    });

    const stored = readStoredLabels();
    expect(stored).toContain("MacBook Chrome");
    expect(stored).toContain("Windows Firefox");
  });

  it("writes country info when dismissing a country-mismatch alert", () => {
    seedKnownEntries([{ label: "MacBook Chrome", country: "US" }]);
    mockUseListSecuritySessions.mockReturnValue({
      data: {
        sessions: [makeSession("MacBook Chrome", "DE")],
      },
      isSuccess: true,
    });

    renderBanner();

    act(() => {
      screen.getByTestId("new-session-banner-dismiss").click();
    });

    const stored = readStoredEntries();
    expect(stored).toEqual(
      expect.arrayContaining([{ label: "MacBook Chrome", country: "DE" }])
    );
  });
});

describe("NewSessionBanner – re-evaluation when session list changes", () => {
  it("shows the banner when a new device arrives via polling after the initial load", () => {
    seedKnownLabels(["MacBook Chrome"]);

    // Initial render: only the known session is present
    mockUseListSecuritySessions.mockReturnValue({
      data: { sessions: [makeSession("MacBook Chrome")] },
      isSuccess: true,
    });

    const { rerender } = renderBanner();
    expect(screen.queryByTestId("new-session-banner")).not.toBeInTheDocument();

    // Polling delivers a new device
    mockUseListSecuritySessions.mockReturnValue({
      data: {
        sessions: [makeSession("MacBook Chrome"), makeSession("Windows Firefox")],
      },
      isSuccess: true,
    });

    rerender(<NewSessionBanner />);

    expect(screen.getByTestId("new-session-banner")).toBeInTheDocument();
    expect(
      screen.getByText(/New sign-in detected on Windows Firefox\./),
    ).toBeInTheDocument();
  });

  it("does not re-show the banner after dismiss when the same sessions are still present", () => {
    seedKnownLabels(["MacBook Chrome"]);

    mockUseListSecuritySessions.mockReturnValue({
      data: {
        sessions: [makeSession("MacBook Chrome"), makeSession("Windows Firefox")],
      },
      isSuccess: true,
    });

    const { rerender } = renderBanner();
    expect(screen.getByTestId("new-session-banner")).toBeInTheDocument();

    act(() => {
      screen.getByTestId("new-session-banner-dismiss").click();
    });

    expect(screen.queryByTestId("new-session-banner")).not.toBeInTheDocument();

    // Same session list arrives again (e.g. another polling tick)
    rerender(<NewSessionBanner />);

    expect(screen.queryByTestId("new-session-banner")).not.toBeInTheDocument();
  });

  it("shows the banner again after dismiss when a brand-new device appears", () => {
    seedKnownLabels(["MacBook Chrome"]);

    mockUseListSecuritySessions.mockReturnValue({
      data: {
        sessions: [makeSession("MacBook Chrome"), makeSession("Windows Firefox")],
      },
      isSuccess: true,
    });

    const { rerender } = renderBanner();

    act(() => {
      screen.getByTestId("new-session-banner-dismiss").click();
    });

    expect(screen.queryByTestId("new-session-banner")).not.toBeInTheDocument();

    // A third, truly new device appears after the dismiss
    mockUseListSecuritySessions.mockReturnValue({
      data: {
        sessions: [
          makeSession("MacBook Chrome"),
          makeSession("Windows Firefox"),
          makeSession("Android Chrome"),
        ],
      },
      isSuccess: true,
    });

    rerender(<NewSessionBanner />);

    expect(screen.getByTestId("new-session-banner")).toBeInTheDocument();
    expect(
      screen.getByText(/New sign-in detected on Android Chrome\./),
    ).toBeInTheDocument();
  });

  it("keeps localStorage in sync after dismiss so a new tab won't re-show already-dismissed alerts", () => {
    seedKnownLabels(["MacBook Chrome"]);

    mockUseListSecuritySessions.mockReturnValue({
      data: {
        sessions: [makeSession("MacBook Chrome"), makeSession("Windows Firefox")],
      },
      isSuccess: true,
    });

    renderBanner();

    act(() => {
      screen.getByTestId("new-session-banner-dismiss").click();
    });

    // A fresh component (simulating a new tab) reads from localStorage
    const stored = readStoredLabels();
    expect(stored).toContain("MacBook Chrome");
    expect(stored).toContain("Windows Firefox");
    expect(stored).toHaveLength(2);
  });
});

describe("NewSessionBanner – security settings link", () => {
  it("renders a link pointing to /profile?tab=security", () => {
    seedKnownLabels(["MacBook Chrome"]);
    mockUseListSecuritySessions.mockReturnValue({
      data: {
        sessions: [makeSession("MacBook Chrome"), makeSession("iPad Safari")],
      },
      isSuccess: true,
    });

    renderBanner();

    const link = screen.getByTestId("new-session-banner-link");
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/profile?tab=security");
  });

  it("hides the banner when the security link is clicked", () => {
    seedKnownLabels(["MacBook Chrome"]);
    mockUseListSecuritySessions.mockReturnValue({
      data: {
        sessions: [makeSession("MacBook Chrome"), makeSession("iPad Safari")],
      },
      isSuccess: true,
    });

    renderBanner();

    expect(screen.getByTestId("new-session-banner")).toBeInTheDocument();

    act(() => {
      screen.getByTestId("new-session-banner-link").click();
    });

    expect(screen.queryByTestId("new-session-banner")).not.toBeInTheDocument();
  });

  it("writes the full current session set to localStorage when the link is clicked", () => {
    seedKnownLabels(["MacBook Chrome"]);
    mockUseListSecuritySessions.mockReturnValue({
      data: {
        sessions: [makeSession("MacBook Chrome"), makeSession("iPad Safari")],
      },
      isSuccess: true,
    });

    renderBanner();

    act(() => {
      screen.getByTestId("new-session-banner-link").click();
    });

    const stored = readStoredLabels();
    expect(stored).toContain("MacBook Chrome");
    expect(stored).toContain("iPad Safari");
  });
});
