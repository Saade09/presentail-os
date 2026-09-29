import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const retryMutate = vi.fn();
const verifyMutate = vi.fn();
const invalidateQueries = vi.fn();
const connectionState = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, values?: { count?: number; date?: string; id?: string; timezone?: string; currency?: string }) => {
      if (key === "adPlatforms.conversionFailures.title") {
        return `${values?.count} paid-link Ads conversions need attention`;
      }
      if (key === "adPlatforms.conversionFailures.failedCount") {
        return `${values?.count} failed`;
      }
      if (key === "adPlatforms.conversionFailures.latestFailure") {
        return `Latest failure ${values?.date}`;
      }
      if (key === "adPlatforms.conversionFailures.attempts") {
        return `${values?.count} upload attempts`;
      }
      if (key === "adPlatforms.conversionFailures.retry") return "Retry upload";
      if (key === "adPlatforms.customerId") return `Customer ${values?.id}`;
      if (key === "adPlatforms.timezone") return `Timezone ${values?.timezone}`;
      if (key === "adPlatforms.currency") return `Currency ${values?.currency}`;
      return key;
    },
  }),
}));

vi.mock("@workspace/api-client-react", () => ({
  getListAdPlatformsQueryKey: () => ["/api/ad-platforms"],
  useListAdPlatforms: () => ({
    isLoading: false,
    data: {
      connections: connectionState.connections,
      conversionFailures: {
        total: 1,
        markets: [
          {
            countryCode: "AE",
            marketName: "United Arab Emirates",
            failedCount: 1,
            latestFailedAt: "2026-08-30T10:00:00.000Z",
            failures: [
              {
                id: 91,
                attemptCount: 10,
                failedAt: "2026-08-30T10:00:00.000Z",
                reasonCode: "google_ads_authentication",
                reason:
                  "Google Ads rejected the connection. Reconnect Google Ads and try again.",
              },
            ],
          },
        ],
      },
    },
  }),
  useConnectAdPlatform: () => ({ mutate: vi.fn(), isPending: false }),
  useVerifyGoogleAdsConnection: () => ({ mutate: verifyMutate, isPending: false }),
  useSyncAdPlatform: () => ({ mutate: vi.fn(), isPending: false }),
  useDisconnectAdPlatform: () => ({ mutate: vi.fn(), isPending: false }),
  useRetryAdPlatformConversionFailure: () => ({
    mutate: retryMutate,
    isPending: false,
    variables: undefined,
  }),
}));

import { AdPlatformsSection } from "./AdPlatformsSection";

describe("AdPlatformsSection conversion health alert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionState.connections = [{
      platform: "google_ads",
      connected: true,
      accountLabel: "Ads account",
      accountName: "Presentail Ads",
      customerId: "1234567890",
      accountCurrency: "AED",
      accountTimeZone: "Asia/Dubai",
      missingConfigurationVariables: [],
      syncStatus: "idle",
      lastSyncAt: null,
      lastFullSyncAt: null,
      lastError: null,
      entryCount: 12,
      latestDataDate: "2026-08-29",
    }];
  });

  it("shows the destination and safe reason, then retries the same failure", async () => {
    const user = userEvent.setup();
    render(<AdPlatformsSection />);

    expect(screen.getByTestId("alert-paid-link-conversion-failures")).toBeInTheDocument();
    expect(screen.getByText("United Arab Emirates")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Google Ads rejected the connection. Reconnect Google Ads and try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/click/i)).not.toBeInTheDocument();

    await user.click(screen.getByTestId("button-retry-paid-link-conversion-91"));

    expect(retryMutate).toHaveBeenCalledWith({ id: 91 });
  });

  it("shows verified metadata and allows retesting the connection", async () => {
    const user = userEvent.setup();
    render(<AdPlatformsSection />);
    expect(screen.getByTestId("row-ad-platform-google_ads")).toHaveTextContent(
      "Presentail Ads",
    );
    expect(screen.getByTestId("row-ad-platform-google_ads")).toHaveTextContent(
      "1234567890",
    );
    await user.click(screen.getByTestId("button-test-google-ads"));
    expect(verifyMutate).toHaveBeenCalled();
  });

  it("shows only missing server variable names instead of credential inputs", () => {
    connectionState.connections = [{
      platform: "google_ads",
      connected: false,
      accountLabel: null,
      accountName: null,
      customerId: null,
      accountCurrency: null,
      accountTimeZone: null,
      missingConfigurationVariables: [
        "GOOGLE_ADS_SERVICE_ACCOUNT_JSON",
        "GOOGLE_ADS_CUSTOMER_ID",
      ],
      syncStatus: null,
      lastSyncAt: null,
      lastFullSyncAt: null,
      lastError: null,
      entryCount: 0,
      latestDataDate: null,
    }];
    render(<AdPlatformsSection />);
    expect(screen.getByTestId("google-ads-missing-configuration")).toHaveTextContent(
      "GOOGLE_ADS_SERVICE_ACCOUNT_JSON, GOOGLE_ADS_CUSTOMER_ID",
    );
    expect(screen.queryByTestId("input-developerToken")).not.toBeInTheDocument();
    expect(screen.queryByTestId("input-refreshToken")).not.toBeInTheDocument();
  });
});