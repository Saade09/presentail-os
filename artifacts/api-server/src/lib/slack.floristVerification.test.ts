/**
 * Unit tests for the florist photo-verification Slack helpers:
 *  - postFloristVerificationPhotos posts ONE chat.postMessage (chat:write —
 *    no files:write needed) with the order number as text and two image
 *    blocks pointing at public URLs, alt text carrying the delivery key.
 *  - findFloristVerificationMessage reconciles a crash-after-send by matching
 *    channel history on message text + image-block URL/alt text, failing
 *    closed on any Slack error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("./db", () => ({
  db: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
}));

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockPostMessage = vi.fn();
const mockHistory = vi.fn();
vi.mock("@slack/web-api", () => ({
  // Must be constructible (`new WebClient(...)`) — use a regular function.
  WebClient: function WebClient(this: Record<string, unknown>) {
    this.chat = { postMessage: (...args: unknown[]) => mockPostMessage(...args) };
    this.conversations = { history: (...args: unknown[]) => mockHistory(...args) };
  },
}));

// getUncachableSlackClient reads connector settings via fetch — stub it out by
// setting env vars it expects and mocking fetch.
process.env.REPLIT_CONNECTORS_HOSTNAME = "connectors.test";
process.env.REPL_IDENTITY = "test-identity";
vi.stubGlobal(
  "fetch",
  vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ items: [{ settings: { access_token: "xoxb-test" } }] }),
  }),
);

import {
  postFloristVerificationPhotos,
  findFloristVerificationMessage,
  floristVerificationChannelId,
} from "./slack";

const CHANNEL = "C_FLORIST_TEST";
const ITEMS_URL = "https://os.presentail.com/api/storage/public-objects/florist-verification/1/a1r3-items.jpg";
const CARD_URL = "https://os.presentail.com/api/storage/public-objects/florist-verification/1/a1r3-card.jpg";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SLACK_FLORIST_VERIFICATION_CHANNEL_ID = CHANNEL;
  mockPostMessage.mockResolvedValue({ ok: true });
  mockHistory.mockResolvedValue({ ok: true, messages: [] });
});

// ---------------------------------------------------------------------------
// postFloristVerificationPhotos
// ---------------------------------------------------------------------------

describe("postFloristVerificationPhotos", () => {
  const args = {
    orderNumber: "LB-2122",
    photos: [
      { imageUrl: ITEMS_URL, altText: "LB-2122-a1r3-items" },
      { imageUrl: CARD_URL, altText: "LB-2122-a1r3-card" },
    ],
  };

  it("posts ONE chat.postMessage with prefixed order-number text and two image blocks", async () => {
    await postFloristVerificationPhotos(args);

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const call = mockPostMessage.mock.calls[0][0];
    expect(call.channel).toBe(CHANNEL);
    expect(call.text).toBe("#LB-2122");
    const imageBlocks = call.blocks.filter((b: { type: string }) => b.type === "image");
    expect(imageBlocks).toHaveLength(2);
    expect(imageBlocks[0]).toMatchObject({ image_url: ITEMS_URL, alt_text: "LB-2122-a1r3-items" });
    expect(imageBlocks[1]).toMatchObject({ image_url: CARD_URL, alt_text: "LB-2122-a1r3-card" });
  });

  it("does not double-prefix an already-prefixed order number", async () => {
    await postFloristVerificationPhotos({ ...args, orderNumber: "#LB-2122" });
    expect(mockPostMessage.mock.calls[0][0].text).toBe("#LB-2122");
  });

  it("throws when Slack reports failure (never silently dropped)", async () => {
    mockPostMessage.mockResolvedValueOnce({ ok: false, error: "channel_not_found" });
    await expect(postFloristVerificationPhotos(args)).rejects.toThrow("channel_not_found");
  });

  it("throws when the Slack call rejects", async () => {
    mockPostMessage.mockRejectedValueOnce(new Error("network down"));
    await expect(postFloristVerificationPhotos(args)).rejects.toThrow("network down");
  });

  it("falls back to the default channel when the env override is unset", () => {
    delete process.env.SLACK_FLORIST_VERIFICATION_CHANNEL_ID;
    expect(floristVerificationChannelId()).toBe("C043TTNESN4");
  });
});

// ---------------------------------------------------------------------------
// findFloristVerificationMessage (crash-recovery reconcile)
// ---------------------------------------------------------------------------

describe("findFloristVerificationMessage", () => {
  const reconcileArgs = { orderNumber: "LB-2122", deliveryKey: "a1r3" };

  function msg(text: string, blocks: Array<Record<string, unknown>>) {
    return { text, blocks };
  }

  it("matches a message whose text is the order number and whose image block URL carries the delivery key", async () => {
    mockHistory.mockResolvedValueOnce({
      ok: true,
      messages: [
        msg("#LB-9999", [{ type: "image", image_url: ITEMS_URL, alt_text: "x" }]),
        msg("#LB-2122", [
          { type: "section" },
          { type: "image", image_url: ITEMS_URL, alt_text: "irrelevant" },
        ]),
      ],
    });
    await expect(findFloristVerificationMessage(reconcileArgs)).resolves.toBe(true);
  });

  it("matches on alt text when the URL does not carry the key", async () => {
    mockHistory.mockResolvedValueOnce({
      ok: true,
      messages: [
        msg("#LB-2122", [
          { type: "image", image_url: "https://example.com/img.jpg", alt_text: "LB-2122-a1r3-card" },
        ]),
      ],
    });
    await expect(findFloristVerificationMessage(reconcileArgs)).resolves.toBe(true);
  });

  it("does NOT match an older notification for the same order (different rev key)", async () => {
    mockHistory.mockResolvedValueOnce({
      ok: true,
      messages: [
        msg("#LB-2122", [
          {
            type: "image",
            image_url: "https://os.presentail.com/api/storage/public-objects/florist-verification/1/a1r2-items.jpg",
            alt_text: "LB-2122-a1r2-items",
          },
        ]),
      ],
    });
    await expect(findFloristVerificationMessage(reconcileArgs)).resolves.toBe(false);
  });

  it("matches a legacy upload-style message via file names carrying the key", async () => {
    mockHistory.mockResolvedValueOnce({
      ok: true,
      messages: [
        { text: "#LB-2122", files: [{ name: "LB-2122-a1r3-items.jpg", title: "photo" }] },
      ],
    });
    await expect(findFloristVerificationMessage(reconcileArgs)).resolves.toBe(true);
  });

  it("does NOT match when only the text matches but there are no image blocks", async () => {
    mockHistory.mockResolvedValueOnce({
      ok: true,
      messages: [msg("#LB-2122", [{ type: "section" }])],
    });
    await expect(findFloristVerificationMessage(reconcileArgs)).resolves.toBe(false);
  });

  it("does NOT match a delivery-key hit under a different order number", async () => {
    mockHistory.mockResolvedValueOnce({
      ok: true,
      messages: [msg("#LB-9999", [{ type: "image", image_url: ITEMS_URL, alt_text: "a1r3" }])],
    });
    await expect(findFloristVerificationMessage(reconcileArgs)).resolves.toBe(false);
  });

  it("fails closed (throws) when Slack history errors", async () => {
    mockHistory.mockResolvedValueOnce({ ok: false, error: "ratelimited" });
    await expect(findFloristVerificationMessage(reconcileArgs)).rejects.toThrow("ratelimited");
  });

  it("queries the configured channel with a bounded lookback", async () => {
    await findFloristVerificationMessage({ ...reconcileArgs, lookbackSeconds: 3600 });
    const call = mockHistory.mock.calls[0][0];
    expect(call.channel).toBe(CHANNEL);
    expect(Number(call.oldest)).toBeGreaterThan(0);
    expect(call.limit).toBe(200);
  });
});
