// Unit tests for AI contact gender inference (task #3165).

import { describe, it, expect, vi, beforeEach } from "vitest";

const chatCreate = vi.fn();
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: (...args: unknown[]) => chatCreate(...args) } } },
}));

const mockDbQuery = vi.fn();
vi.mock("./db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./aiUsageRecorder", () => ({
  openAiUsage: vi.fn(),
  aiUsageAttribution: vi.fn(() => ({})),
  trackAiUsage: async ({ call }: { call: () => Promise<unknown> }) => call(),
}));

import {
  normalizeFirstName,
  inferGenderFromName,
  applyGenderInference,
  resolveCountryContext,
  genderConfidenceThreshold,
  GENDER_PROMPT_VERSION,
} from "./genderInference";

function aiResponse(gender: string, confidence: number) {
  return {
    choices: [{ message: { content: JSON.stringify({ gender, confidence }) } }],
  };
}

beforeEach(() => {
  chatCreate.mockReset();
  mockDbQuery.mockReset();
  mockDbQuery.mockResolvedValue({ rows: [] });
  delete process.env.GENDER_CONFIDENCE_THRESHOLD;
});

describe("normalizeFirstName", () => {
  it("prefers first_name, lowercases and trims", () => {
    expect(normalizeFirstName("  Sarah ", "Ignored Name")).toBe("sarah");
  });
  it("falls back to first token of display_name", () => {
    expect(normalizeFirstName(null, "Ahmad Khalil")).toBe("ahmad");
  });
  it("returns null for empty or non-letter input", () => {
    expect(normalizeFirstName(null, null)).toBeNull();
    expect(normalizeFirstName("12345", null)).toBeNull();
    expect(normalizeFirstName("...", "!!!")).toBeNull();
  });
  it("handles Arabic script", () => {
    expect(normalizeFirstName("محمد", null)).toBe("محمد");
  });
});

describe("genderConfidenceThreshold", () => {
  it("defaults to 0.9", () => {
    expect(genderConfidenceThreshold()).toBe(0.9);
  });
  it("reads env override", () => {
    process.env.GENDER_CONFIDENCE_THRESHOLD = "0.75";
    expect(genderConfidenceThreshold()).toBe(0.75);
  });
  it("ignores invalid env values", () => {
    process.env.GENDER_CONFIDENCE_THRESHOLD = "5";
    expect(genderConfidenceThreshold()).toBe(0.9);
  });
});

describe("resolveCountryContext", () => {
  it("derives country from phone dial code first", () => {
    expect(resolveCountryContext("+9613123456", "ae")).toBe("Lebanon");
  });
  it("falls back to metadata country code", () => {
    expect(resolveCountryContext(null, "ae")).toBe("United Arab Emirates");
  });
  it("returns empty string when nothing resolves", () => {
    expect(resolveCountryContext(null, null)).toBe("");
  });
});

describe("inferGenderFromName", () => {
  it("returns cache hit without calling the model", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ gender: "female", confidence: "0.97" }] });
    const res = await inferGenderFromName({ normalizedFirstName: "sarah" });
    expect(res).toEqual({ gender: "female", confidence: 0.97, fromCache: true });
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("calls the model on miss and caches the result", async () => {
    chatCreate.mockResolvedValueOnce(aiResponse("male", 0.95));
    const res = await inferGenderFromName({
      normalizedFirstName: "ahmad",
      countryContext: "Lebanon",
      language: "AR",
    });
    expect(res).toEqual({ gender: "male", confidence: 0.95, fromCache: false });
    // 1st query = cache select, 2nd = cache insert
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    const insert = mockDbQuery.mock.calls[1];
    expect(String(insert[0])).toContain("INSERT INTO gender_inference_cache");
    expect(insert[1]).toEqual(["ahmad", "Lebanon", "ar", GENDER_PROMPT_VERSION, "male", 0.95]);
  });

  it("keys the cache by country + language context", async () => {
    chatCreate.mockResolvedValue(aiResponse("female", 0.92));
    await inferGenderFromName({ normalizedFirstName: "andrea", countryContext: "Italy" });
    await inferGenderFromName({ normalizedFirstName: "andrea", countryContext: "United States" });
    const selects = mockDbQuery.mock.calls.filter((c) => String(c[0]).includes("SELECT"));
    expect(selects[0][1]).toEqual(["andrea", "Italy", "", GENDER_PROMPT_VERSION]);
    expect(selects[1][1]).toEqual(["andrea", "United States", "", GENDER_PROMPT_VERSION]);
    expect(chatCreate).toHaveBeenCalledTimes(2);
  });

  it("returns unknown on unparseable model output (no crash)", async () => {
    chatCreate.mockResolvedValueOnce({ choices: [{ message: { content: "not json" } }] });
    const res = await inferGenderFromName({ normalizedFirstName: "x" });
    expect(res.gender).toBe("unknown");
    expect(res.confidence).toBeNull();
  });

  it("retries once, then does not cache when the model keeps failing", async () => {
    chatCreate.mockRejectedValue(new Error("boom"));
    const res = await inferGenderFromName({ normalizedFirstName: "sarah" });
    expect(res).toEqual({ gender: "unknown", confidence: null, fromCache: false });
    // limited retry: exactly 2 attempts
    expect(chatCreate).toHaveBeenCalledTimes(2);
    // Only the cache SELECT ran — failure is not cached.
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("recovers when a retry succeeds", async () => {
    chatCreate
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(aiResponse("female", 0.93));
    const res = await inferGenderFromName({ normalizedFirstName: "sarah" });
    expect(res).toEqual({ gender: "female", confidence: 0.93, fromCache: false });
    expect(chatCreate).toHaveBeenCalledTimes(2);
  });
});

describe("applyGenderInference", () => {
  function contactRow(overrides: Record<string, unknown> = {}) {
    return {
      first_name: "Sarah",
      display_name: null,
      phone: "+9613123456",
      gender_source: null,
      preferred_language: null,
      metadata_country_code: null,
      ...overrides,
    };
  }

  it("saves gender when confidence meets the threshold", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [contactRow()] }) // contact load
      .mockResolvedValueOnce({ rows: [] }) // cache miss
      .mockResolvedValueOnce({ rows: [] }) // cache insert
      .mockResolvedValueOnce({ rows: [] }); // contact update
    chatCreate.mockResolvedValueOnce(aiResponse("female", 0.97));

    await applyGenderInference("c1");

    const update = mockDbQuery.mock.calls[3];
    expect(String(update[0])).toContain("UPDATE contacts");
    expect(String(update[0])).toContain("gender_source IS NULL OR gender_source = 'ai'");
    expect(update[1]).toEqual(["c1", "female", 0.97, "Lebanon", GENDER_PROMPT_VERSION]);
  });

  it("stores unknown when confidence is below the threshold and no order context exists", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [contactRow()] }) // contact load
      .mockResolvedValueOnce({ rows: [] }) // cache miss
      .mockResolvedValueOnce({ rows: [] }) // cache insert
      .mockResolvedValueOnce({ rows: [] }) // order context lookup (none)
      .mockResolvedValueOnce({ rows: [] }); // contact update
    chatCreate.mockResolvedValueOnce(aiResponse("male", 0.6));

    await applyGenderInference("c1");

    const update = mockDbQuery.mock.calls[4];
    expect(String(update[0])).toContain("UPDATE contacts");
    expect(update[1][1]).toBe("unknown");
    expect(update[1][2]).toBe(0.6);
  });

  it("falls back to order card-message context when the name alone is unclear", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [contactRow()] }) // contact load
      .mockResolvedValueOnce({ rows: [] }) // cache miss (name-only)
      .mockResolvedValueOnce({ rows: [] }) // cache insert (name-only)
      .mockResolvedValueOnce({
        rows: [
          {
            role: "recipient",
            card_to: "Sarah",
            card_from: "Ziad",
            card_message: "Happy birthday to my beautiful wife",
          },
        ],
      }) // order context lookup
      .mockResolvedValueOnce({ rows: [] }) // cache select (context pass)
      .mockResolvedValueOnce({ rows: [] }); // contact update
    chatCreate
      .mockResolvedValueOnce(aiResponse("unknown", 0.4)) // name-only pass
      .mockResolvedValueOnce(aiResponse("female", 0.96)); // context pass

    await applyGenderInference("c1");

    // context pass result is NOT cached (only the name-only insert ran)
    const inserts = mockDbQuery.mock.calls.filter((c) =>
      String(c[0]).includes("INSERT INTO gender_inference_cache"),
    );
    expect(inserts).toHaveLength(1);

    const secondCall = chatCreate.mock.calls[1][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(secondCall.messages[1].content).toContain("gift card context");
    expect(secondCall.messages[1].content).toContain("wife");

    const update = mockDbQuery.mock.calls[5];
    expect(String(update[0])).toContain("UPDATE contacts");
    expect(update[1][1]).toBe("female");
    expect(update[1][2]).toBe(0.96);
  });

  it("skips contacts with a manual gender", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [contactRow({ gender_source: "manual" })] });
    await applyGenderInference("c1");
    expect(chatCreate).not.toHaveBeenCalled();
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("skips contacts without a usable name", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [contactRow({ first_name: null, display_name: "12345" })],
    });
    await applyGenderInference("c1");
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("never throws even when the DB fails", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("db down"));
    await expect(applyGenderInference("c1")).resolves.toBe(false);
  });
});
