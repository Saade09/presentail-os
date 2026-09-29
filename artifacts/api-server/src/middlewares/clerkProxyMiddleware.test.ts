import { describe, expect, it } from "vitest";
import {
  fapiFromPublishableKey,
  getClerkFapi,
} from "./clerkProxyMiddleware";
import {
  getEffectiveClerkPublishableKey,
  PROD_CLERK_PUBLISHABLE_KEY,
} from "../lib/clerkPublishableKey";

describe("Clerk production key and proxy selection", () => {
  it("uses the pinned production key for both middleware and proxy selection", () => {
    const staleDevelopmentKey =
      "pk_test_YmVjb21pbmctbWFuLTczLmNsZXJrLmFjY291bnRzLmRldiQ=";

    expect(
      getEffectiveClerkPublishableKey("production", staleDevelopmentKey),
    ).toBe(PROD_CLERK_PUBLISHABLE_KEY);
    expect(getClerkFapi("production", staleDevelopmentKey)).toBe(
      "https://clerk.presentail.com",
    );
  });

  it("keeps development proxy selection environment-driven", () => {
    const developmentKey =
      "pk_test_YmVjb21pbmctbWFuLTczLmNsZXJrLmFjY291bnRzLmRldiQ=";

    expect(getEffectiveClerkPublishableKey("development", developmentKey)).toBe(
      developmentKey,
    );
    expect(getClerkFapi("development", developmentKey)).toBe(
      "https://becoming-man-73.clerk.accounts.dev",
    );
  });

  it("falls back to Clerk's shared FAPI for missing or malformed keys", () => {
    expect(fapiFromPublishableKey(undefined)).toBe(
      "https://frontend-api.clerk.dev",
    );
    expect(fapiFromPublishableKey("not-a-publishable-key")).toBe(
      "https://frontend-api.clerk.dev",
    );
  });
});