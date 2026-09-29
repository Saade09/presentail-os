/**
 * Unit tests for the florist photo verification prompt builder and response
 * parser: context-rich prompts (descriptions, recipes, labeled reference
 * images), fair-but-thorough rules, and fail-closed parsing.
 */
import sharp from "sharp";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreateCompletion } = vi.hoisted(() => ({
  mockCreateCompletion: vi.fn(),
}));
vi.mock("@workspace/integrations-openai-ai-server/image", () => ({
  openai: { chat: { completions: { create: mockCreateCompletion } } },
}));
vi.mock("./logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  buildFloristFocusedItemPrompt,
  buildFloristVerificationPrompt,
  normalizeCardMessage,
  parseFloristFocusedItemResponse,
  parseFloristVerificationResponse,
  runCardTextVerification,
  type ExpectedItem,
} from "./floristPhotoVerification";

const BUNDLE: ExpectedItem = {
  name: "The Whispering Elegance Bundle",
  quantity: 1,
  description: "A romantic bundle of roses paired with a bottle of red wine.",
  recipe: [
    { name: "Red Roses", quantity: "12" },
    { name: "Red Wine Bottle", quantity: "1" },
  ],
};

beforeEach(() => {
  mockCreateCompletion.mockReset();
});

describe("buildFloristVerificationPrompt", () => {
  it("includes each item's description and recipe contents", () => {
    const prompt = buildFloristVerificationPrompt([BUNDLE]);
    expect(prompt).toContain("1. 1 × The Whispering Elegance Bundle");
    expect(prompt).toContain("Description: A romantic bundle of roses paired with a bottle of red wine.");
    expect(prompt).toContain("Contains: 12 × Red Roses, 1 × Red Wine Bottle");
  });

  it("omits description/contains lines when the item has none", () => {
    const prompt = buildFloristVerificationPrompt([{ name: "Red Roses Bouquet", quantity: 2 }]);
    expect(prompt).toContain("1. 2 × Red Roses Bouquet");
    expect(prompt).not.toContain("Description:");
    expect(prompt).not.toContain("Contains:");
  });

  it("labels each reference image with its line item", () => {
    const prompt = buildFloristVerificationPrompt(
      [BUNDLE, { name: "Chocolate Box", quantity: 1 }],
      [{ itemIndex: 0 }, { itemIndex: 1 }],
    );
    expect(prompt).toContain(
      "Image 2 is the catalog reference photo of item 1 (The Whispering Elegance Bundle).",
    );
    expect(prompt).toContain("Image 3 is the catalog reference photo of item 2 (Chocolate Box).");
  });

  it("tells the model not to guess about items without a reference image", () => {
    const prompt = buildFloristVerificationPrompt(
      [BUNDLE, { name: "Chocolate Box", quantity: 1 }],
      [{ itemIndex: 0 }],
    );
    expect(prompt).toContain("NO reference image");
    expect(prompt).toContain("item 2 (Chocolate Box)");
    expect(prompt).toContain("do not guess their exact appearance");
  });

  it("states that no reference images are available when there are none", () => {
    const prompt = buildFloristVerificationPrompt([BUNDLE], []);
    expect(prompt).toContain("No catalog reference images are available for this order.");
  });

  it("frames bundle components as part of the product, never an extra item", () => {
    const prompt = buildFloristVerificationPrompt([BUNDLE], [{ itemIndex: 0 }]);
    expect(prompt).toContain(
      "Any object visible in an item's reference image, or mentioned in its description or contents, is PART of that item",
    );
    expect(prompt).toContain("NEVER count it as an extra item");
    // Benefit of the doubt goes to the florist.
    expect(prompt).toContain("Give the florist the benefit of the doubt");
  });

  it("judges bundle/recipe components by general object type, not brand or label", () => {
    const prompt = buildFloristVerificationPrompt([BUNDLE]);
    // Must not require reading a label to confirm a component.
    expect(prompt).toContain("general object type only");
    expect(prompt).toContain("do NOT require reading a label");
    // A bottle of any wine counts as the listed wine component.
    expect(prompt).toContain("A bottle of any wine counts as the listed wine component");
  });

  it("accepts partially visible or wrapped items as present", () => {
    const prompt = buildFloristVerificationPrompt([BUNDLE]);
    expect(prompt).toContain("partially hidden inside gift bags");
    expect(prompt).toContain("partially visible or wrapped object that is consistent with an expected item or component counts as present");
  });

  it("treats a cake in an open box as present without exact flavor identification", () => {
    const prompt = buildFloristVerificationPrompt([
      { name: "Chocolate Rocher Cake", quantity: 1 },
    ]);
    expect(prompt).toContain("inside an open bakery, pastry, or gift box");
    expect(prompt).toContain("open box containing a chocolate cake is enough evidence");
    expect(prompt).toContain("Do not require exact flavor, topping, decoration, or packaging");
  });

  it("requires one present, absent, or uncertain assessment for every line", () => {
    const prompt = buildFloristVerificationPrompt([BUNDLE]);
    expect(prompt).toContain("Assess every expected line item separately");
    expect(prompt).toContain('"item_assessments"');
    expect(prompt).toContain('An "uncertain" assessment is not a missing item');
  });

  it("requires re-examining every visible object before reporting missing_item", () => {
    const prompt = buildFloristVerificationPrompt([BUNDLE]);
    expect(prompt).toContain("re-examine every visible object in the photo");
    expect(prompt).toContain("Only report \"missing_item\" when no visible object in the photo is a plausible match");
  });

  it("reserves extra-item rejection for objects unrelated to every expected item", () => {
    const prompt = buildFloristVerificationPrompt([BUNDLE]);
    expect(prompt).toContain("clearly unrelated to EVERY expected item");
  });

  it("still hard-rejects missing items, wrong quantities, and unjudgeable photos", () => {
    const prompt = buildFloristVerificationPrompt([BUNDLE]);
    expect(prompt).toContain('Reject with "missing_item" when an expected item is clearly ABSENT');
    expect(prompt).toContain('"wrong_quantity"');
    expect(prompt).toContain('Reject with "unclear_photo" ONLY when the photo is genuinely too dark, blurry, or cropped');
  });

  it("asks for specific, actionable rejection reasons", () => {
    const prompt = buildFloristVerificationPrompt([BUNDLE]);
    expect(prompt).toContain("be specific and actionable");
  });
});

describe("parseFloristVerificationResponse (fail-closed)", () => {
  it("rejects unreadable responses", () => {
    const outcome = parseFloristVerificationResponse("I cannot help with that.");
    expect(outcome.approved).toBe(false);
    expect(outcome.reasonCode).toBe("other");
  });

  it("rejects invalid JSON", () => {
    const outcome = parseFloristVerificationResponse("{ approved: yes maybe }");
    expect(outcome.approved).toBe(false);
    expect(outcome.reasonCode).toBe("other");
  });

  it("passes through an approval", () => {
    const outcome = parseFloristVerificationResponse(
      JSON.stringify({
        approved: true,
        reason_code: null,
        reason: null,
        detected_items: [{ name: "The Whispering Elegance Bundle", quantity: 1 }],
        item_assessments: [{
          item_number: 1,
          name: "The Whispering Elegance Bundle",
          status: "present",
          cue: "A rose arrangement and wine bottle are visible.",
        }],
      }),
    );
    expect(outcome.approved).toBe(true);
    expect(outcome.reasonCode).toBeNull();
    expect(outcome.detectedItems).toEqual([
      { name: "The Whispering Elegance Bundle", quantity: 1 },
    ]);
    expect(outcome.itemAssessments[0]).toMatchObject({
      itemIndex: 0,
      status: "present",
    });
  });

  it("passes through a rejection with its categorized reason", () => {
    const outcome = parseFloristVerificationResponse(
      JSON.stringify({
        approved: false,
        reason_code: "missing_item",
        reason: "The Chocolate Box is not visible in the photo.",
        detected_items: [],
      }),
    );
    expect(outcome.approved).toBe(false);
    expect(outcome.reasonCode).toBe("missing_item");
    expect(outcome.reason).toContain("Chocolate Box");
  });

  it("rejects incomplete, duplicate, malformed, or blank per-item evidence", () => {
    const expected = [
      { name: "Red Roses Bouquet", quantity: 1 },
      { name: "Chocolate Rocher Cake", quantity: 1 },
    ];
    const duplicate = parseFloristVerificationResponse(
      JSON.stringify({
        approved: true,
        reason_code: null,
        reason: null,
        detected_items: [],
        item_assessments: [
          { item_number: 1, name: "Roses", status: "present", cue: "Flowers" },
          { item_number: 1, name: "Duplicate", status: "present", cue: "Same flowers" },
        ],
      }),
      expected,
    );
    const invalidStatus = parseFloristVerificationResponse(
      JSON.stringify({
        approved: false,
        reason_code: "missing_item",
        reason: "Cake missing.",
        detected_items: [],
        item_assessments: [
          { item_number: 1, name: "Roses", status: "present", cue: "Flowers" },
          { item_number: 2, name: "Cake", status: "maybe", cue: "No cake identified" },
        ],
      }),
      expected,
    );
    const blankCue = parseFloristVerificationResponse(
      JSON.stringify({
        approved: false,
        reason_code: "missing_item",
        reason: "Cake missing.",
        detected_items: [],
        item_assessments: [
          { item_number: 1, name: "Roses", status: "present", cue: "Flowers" },
          { item_number: 2, name: "Cake", status: "absent", cue: "   " },
        ],
      }),
      expected,
    );
    expect(duplicate).toMatchObject({ approved: false, reasonCode: "other" });
    expect(invalidStatus).toMatchObject({ approved: false, reasonCode: "other" });
    expect(blankCue).toMatchObject({ approved: false, reasonCode: "other" });
  });

  it("derives missing and uncertain outcomes from canonical line evidence", () => {
    const expected = [{ name: "Chocolate Rocher Cake", quantity: 1 }];
    const absent = parseFloristVerificationResponse(
      JSON.stringify({
        approved: true,
        reason_code: null,
        reason: null,
        detected_items: [],
        item_assessments: [
          { item_number: 1, name: "Untrusted label", status: "absent", cue: "No cake found" },
        ],
      }),
      expected,
    );
    const uncertain = parseFloristVerificationResponse(
      JSON.stringify({
        approved: false,
        reason_code: "missing_item",
        reason: "Cake missing.",
        detected_items: [],
        item_assessments: [
          { item_number: 1, name: "Cake", status: "uncertain", cue: "Cake-like object in box" },
        ],
      }),
      expected,
    );
    expect(absent).toMatchObject({ approved: false, reasonCode: "missing_item" });
    expect(absent.itemAssessments[0].name).toBe("Chocolate Rocher Cake");
    expect(uncertain).toMatchObject({ approved: true, reasonCode: null });
  });
});

describe("focused missing-item confirmation", () => {
  it("repeats open-box cake guidance with catalog context", () => {
    const prompt = buildFloristFocusedItemPrompt({
      name: "Chocolate Rocher Cake",
      quantity: 1,
      description: "Chocolate cake topped with hazelnut pralines.",
      recipe: [{ name: "Chocolate Cake", quantity: "1" }],
    });
    expect(prompt).toContain("original high-detail prepared-order photo");
    expect(prompt).toContain("inside an open bakery, pastry, or gift box");
    expect(prompt).toContain("Description: Chocolate cake topped with hazelnut pralines.");
  });

  it("parses visible evidence and treats malformed absence as uncertain", () => {
    const present = parseFloristFocusedItemResponse(
      JSON.stringify({
        status: "present",
        cue: "An open white bakery box contains a round chocolate cake.",
      }),
      1,
      "Chocolate Rocher Cake",
    );
    const unreadable = parseFloristFocusedItemResponse(
      "No structured result",
      0,
      "Chocolate Rocher Cake",
    );
    const missingCue = parseFloristFocusedItemResponse(
      JSON.stringify({ status: "absent" }),
      0,
      "Chocolate Rocher Cake",
    );
    expect(present.status).toBe("present");
    expect(unreadable.status).toBe("uncertain");
    expect(missingCue.status).toBe("uncertain");
  });
});

describe("staged card reading", () => {
  async function validCardPhoto() {
    return {
      buffer: await sharp({
        create: {
          width: 40,
          height: 40,
          channels: 3,
          background: { r: 225, g: 225, b: 225 },
        },
      })
        .jpeg()
        .toBuffer(),
      mime: "image/jpeg",
    };
  }

  function completion(payload: unknown) {
    return {
      choices: [{ message: { content: JSON.stringify(payload) } }],
    };
  }

  it("normalizes capitalization, punctuation, spacing, and line breaks", () => {
    expect(normalizeCardMessage("  Happy,\nBirthday!!  SAM  ")).toBe(
      normalizeCardMessage("happy birthday sam"),
    );
    expect(normalizeCardMessage("I’m proud of you")).toBe(
      normalizeCardMessage("Im proud of you"),
    );
  });

  it("approves a matching handwritten transcription without an unnecessary confirmation", async () => {
    mockCreateCompletion.mockResolvedValueOnce(
      completion({
        legible: true,
        detected_text: "Happy,\nBirthday!!  Sam",
        confidence: 0.93,
        reason: null,
      }),
    );

    const result = await runCardTextVerification(
      await validCardPhoto(),
      "happy birthday sam",
    );

    expect(result).toMatchObject({
      legible: true,
      approved: true,
      detectedText: "Happy,\nBirthday!!  Sam",
    });
    expect(result.decisionPath).toEqual([
      "transcribed_original",
      "comparison_matched",
    ]);
    expect(result.evidence[1]?.raw).toEqual({
      method: "normalized_exact_match",
    });
    expect(mockCreateCompletion).toHaveBeenCalledTimes(1);
  });

  it("uses the enhanced view when small low-contrast writing is unreadable first", async () => {
    mockCreateCompletion
      .mockResolvedValueOnce(
        completion({
          legible: false,
          detected_text: null,
          confidence: 0.15,
          reason: "The original is too low contrast.",
        }),
      )
      .mockResolvedValueOnce(
        completion({
          legible: true,
          detected_text: "With love, Maya",
          confidence: 0.91,
          reason: null,
        }),
      );

    const result = await runCardTextVerification(
      await validCardPhoto(),
      "With love Maya",
    );

    expect(result.approved).toBe(true);
    expect(result.decisionPath).toContain("generated_enhanced_view");
    expect(result.decisionPath).toContain("transcribed_enhanced");
    expect(result.evidence.map((pass) => pass.source)).toContain("enhanced");
    expect(mockCreateCompletion).toHaveBeenCalledTimes(2);
  });

  it("confirms an ambiguous first reading with the expected message before approval", async () => {
    mockCreateCompletion
      .mockResolvedValueOnce(
        completion({
          legible: true,
          detected_text: "Happy Birthdoy Sam",
          confidence: 0.55,
          reason: null,
        }),
      )
      .mockResolvedValueOnce(
        completion({
          legible: true,
          detected_text: "Happy Birthdoy Sam",
          confidence: 0.72,
          reason: null,
        }),
      )
      .mockResolvedValueOnce(
        completion({
          approved: false,
          confidence: 0.55,
          reason: "One handwritten character is ambiguous.",
        }),
      )
      .mockResolvedValueOnce(
        completion({
          legible: true,
          approved: true,
          detected_text: "Happy Birthday Sam",
          confidence: 0.9,
          reason: null,
        }),
      );

    const result = await runCardTextVerification(
      await validCardPhoto(),
      "Happy Birthday Sam",
    );

    expect(result.approved).toBe(true);
    expect(result.detectedText).toBe("Happy Birthday Sam");
    expect(result.decisionPath).toContain("focused_confirmation");
    expect(result.decisionPath).toContain("confirmed_match");
    expect(result.evidence.at(-1)).toMatchObject({
      pass: "confirmation",
      approved: true,
    });
  });

  it("rejects a confirmed wrong recipient and retains every pass as evidence", async () => {
    mockCreateCompletion
      .mockResolvedValueOnce(
        completion({
          legible: true,
          detected_text: "Happy Birthday Alex",
          confidence: 0.95,
          reason: null,
        }),
      )
      .mockResolvedValueOnce(
        completion({
          approved: false,
          confidence: 0.98,
          reason: "The recipient is Alex rather than Maya.",
        }),
      )
      .mockResolvedValueOnce(
        completion({
          legible: true,
          detected_text: "Happy Birthday Alex",
          confidence: 0.96,
          reason: null,
        }),
      )
      .mockResolvedValueOnce(
        completion({
          approved: false,
          confidence: 0.98,
          reason: "The recipient is Alex rather than Maya.",
        }),
      )
      .mockResolvedValueOnce(
        completion({
          legible: true,
          approved: false,
          detected_text: "Happy Birthday Alex",
          confidence: 0.99,
          reason: "The card is clearly addressed to Alex, not Maya.",
        }),
      );

    const result = await runCardTextVerification(
      await validCardPhoto(),
      "Happy Birthday Maya",
    );

    expect(result).toMatchObject({
      approved: false,
      legible: true,
      detectedText: "Happy Birthday Alex",
    });
    expect(result.reason).toContain("Alex");
    expect(result.decisionPath.at(-1)).toBe("confirmed_material_mismatch");
    expect(result.evidence).toHaveLength(5);
  });

  it("does not approve low-confidence positive comparison or confirmation judgments", async () => {
    mockCreateCompletion
      .mockResolvedValueOnce(
        completion({
          legible: true,
          detected_text: "Happy Birthday Moya",
          confidence: 0.92,
          reason: null,
        }),
      )
      .mockResolvedValueOnce(
        completion({
          approved: true,
          confidence: 0.2,
          reason: null,
        }),
      )
      .mockResolvedValueOnce(
        completion({
          legible: true,
          detected_text: "Happy Birthday Moya",
          confidence: 0.93,
          reason: null,
        }),
      )
      .mockResolvedValueOnce(
        completion({
          approved: true,
          confidence: 0.25,
          reason: null,
        }),
      )
      .mockResolvedValueOnce(
        completion({
          legible: true,
          approved: true,
          detected_text: "Happy Birthday Moya",
          confidence: 0.3,
          reason: null,
        }),
      );

    const result = await runCardTextVerification(
      await validCardPhoto(),
      "Happy Birthday Maya",
    );

    expect(result.approved).toBe(false);
    expect(result.legible).toBe(false);
    expect(result.reason).toContain("could not be read clearly");
    expect(result.decisionPath.at(-1)).toBe(
      "confirmed_unreadable_or_uncertain",
    );
  });

  it("rejects genuinely unreadable photos after original, enhanced, and confirmation passes", async () => {
    mockCreateCompletion
      .mockResolvedValueOnce(
        completion({
          legible: false,
          detected_text: null,
          confidence: 0.05,
          reason: "The card is out of focus.",
        }),
      )
      .mockResolvedValueOnce(
        completion({
          legible: false,
          detected_text: null,
          confidence: 0.1,
          reason: "The enhanced view is still out of focus.",
        }),
      )
      .mockResolvedValueOnce(
        completion({
          legible: false,
          approved: false,
          detected_text: null,
          confidence: 0.05,
          reason: "The writing remains unreadable.",
        }),
      );

    const result = await runCardTextVerification(
      await validCardPhoto(),
      "Congratulations Maya",
    );

    expect(result).toMatchObject({
      legible: false,
      approved: false,
      detectedText: null,
    });
    expect(result.reason).toContain("unreadable");
    expect(result.decisionPath.at(-1)).toBe(
      "confirmed_unreadable_or_uncertain",
    );
  });

  it("fails closed and records malformed AI responses from every pass", async () => {
    mockCreateCompletion
      .mockResolvedValueOnce({ choices: [{ message: { content: "not json" } }] })
      .mockResolvedValueOnce(completion({ detected_text: 42 }))
      .mockResolvedValueOnce(completion({ approved: "perhaps" }));

    const result = await runCardTextVerification(
      await validCardPhoto(),
      "Happy Anniversary",
    );

    expect(result).toMatchObject({ approved: false, legible: false });
    expect(result.evidence).toHaveLength(3);
    expect(result.evidence.every((pass) => pass.confidence === 0)).toBe(true);
    expect(result.decisionPath.at(-1)).toBe(
      "confirmed_unreadable_or_uncertain",
    );
  });

  it("classifies malformed confirmation as unreadable rather than a material mismatch", async () => {
    mockCreateCompletion
      .mockResolvedValueOnce(
        completion({
          legible: true,
          detected_text: "Congratulations Alex",
          confidence: 0.9,
          reason: null,
        }),
      )
      .mockResolvedValueOnce(
        completion({
          approved: false,
          confidence: 0.9,
          reason: "The recipient appears different.",
        }),
      )
      .mockResolvedValueOnce(
        completion({
          legible: true,
          detected_text: "Congratulations Alex",
          confidence: 0.91,
          reason: null,
        }),
      )
      .mockResolvedValueOnce(
        completion({
          approved: false,
          confidence: 0.9,
          reason: "The recipient appears different.",
        }),
      )
      .mockResolvedValueOnce({ choices: [{ message: { content: "not json" } }] });

    const result = await runCardTextVerification(
      await validCardPhoto(),
      "Congratulations Maya",
    );

    expect(result).toMatchObject({
      approved: false,
      legible: false,
      reason: "The focused confirmation returned an unreadable result.",
    });
    expect(result.decisionPath.at(-1)).toBe(
      "confirmed_unreadable_or_uncertain",
    );
    expect(result.evidence.at(-1)).toMatchObject({
      pass: "confirmation",
      valid: false,
    });
  });
});
