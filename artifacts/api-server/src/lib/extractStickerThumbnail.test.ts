import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockCompletionsCreate = vi.fn();

vi.mock("@workspace/integrations-openai-ai-server/image", () => ({
  openai: {
    chat: {
      completions: {
        create: (...args: unknown[]) => mockCompletionsCreate(...args),
      },
    },
  },
}));

const mockSharpMetadata = vi.fn();
const mockSharpExtract = vi.fn();
const mockSharpPng = vi.fn();
const mockSharpToBuffer = vi.fn();

const mockSharpInstance = {
  metadata: mockSharpMetadata,
  extract: mockSharpExtract,
  png: mockSharpPng,
  toBuffer: mockSharpToBuffer,
};

mockSharpExtract.mockReturnValue(mockSharpInstance);
mockSharpPng.mockReturnValue(mockSharpInstance);

vi.mock("sharp", () => ({
  default: vi.fn(() => mockSharpInstance),
}));

vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { extractStickerThumbnail } from "./extractStickerThumbnail";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeImageBuffer(): Buffer {
  return Buffer.from("fake-image-bytes");
}

function makeOpenAiResponse(content: string) {
  return {
    choices: [
      {
        message: {
          content,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// extractStickerThumbnail — valid bounding box
// ---------------------------------------------------------------------------

describe("extractStickerThumbnail — valid bounding box from OpenAI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSharpExtract.mockReturnValue(mockSharpInstance);
    mockSharpPng.mockReturnValue(mockSharpInstance);
  });

  it("returns a cropped PNG buffer when OpenAI returns a valid bounding box", async () => {
    const bbox = '{"x": 10, "y": 20, "width": 50, "height": 40}';
    mockCompletionsCreate.mockResolvedValueOnce(makeOpenAiResponse(bbox));
    mockSharpMetadata.mockResolvedValueOnce({ width: 400, height: 300 });
    const expectedBuffer = Buffer.from("cropped-png");
    mockSharpToBuffer.mockResolvedValueOnce(expectedBuffer);

    const result = await extractStickerThumbnail(makeImageBuffer());

    expect(result).toBe(expectedBuffer);
    expect(mockSharpExtract).toHaveBeenCalledTimes(1);
    const extractArgs = mockSharpExtract.mock.calls[0][0];
    expect(extractArgs).toMatchObject({
      left: Math.round((10 / 100) * 400),
      top: Math.round((20 / 100) * 300),
      width: Math.round((50 / 100) * 400),
      height: Math.round((40 / 100) * 300),
    });
  });

  it("converts percentage bbox values to pixel coordinates based on image dimensions", async () => {
    const bbox = '{"x": 25, "y": 25, "width": 50, "height": 50}';
    mockCompletionsCreate.mockResolvedValueOnce(makeOpenAiResponse(bbox));
    mockSharpMetadata.mockResolvedValueOnce({ width: 200, height: 200 });
    mockSharpToBuffer.mockResolvedValueOnce(Buffer.from("output"));

    await extractStickerThumbnail(makeImageBuffer());

    const extractArgs = mockSharpExtract.mock.calls[0][0];
    expect(extractArgs).toMatchObject({ left: 50, top: 50, width: 100, height: 100 });
  });

  it("clamps crop coordinates to valid image bounds (left must not exceed imgWidth-1)", async () => {
    const bbox = '{"x": 120, "y": 120, "width": 50, "height": 50}';
    mockCompletionsCreate.mockResolvedValueOnce(makeOpenAiResponse(bbox));
    mockSharpMetadata.mockResolvedValueOnce({ width: 100, height: 100 });
    mockSharpToBuffer.mockResolvedValueOnce(Buffer.from("clamped-output"));

    const result = await extractStickerThumbnail(makeImageBuffer());

    expect(result).not.toBeNull();
    const extractArgs = mockSharpExtract.mock.calls[0][0];
    expect(extractArgs.left).toBeLessThanOrEqual(99);
    expect(extractArgs.top).toBeLessThanOrEqual(99);
    expect(extractArgs.width).toBeGreaterThanOrEqual(1);
    expect(extractArgs.height).toBeGreaterThanOrEqual(1);
  });

  it("handles OpenAI response with JSON wrapped in markdown fences", async () => {
    const content = '```json\n{"x": 5, "y": 5, "width": 30, "height": 30}\n```';
    mockCompletionsCreate.mockResolvedValueOnce(makeOpenAiResponse(content));
    mockSharpMetadata.mockResolvedValueOnce({ width: 200, height: 200 });
    mockSharpToBuffer.mockResolvedValueOnce(Buffer.from("markdown-output"));

    const result = await extractStickerThumbnail(makeImageBuffer());

    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractStickerThumbnail — invalid JSON from OpenAI
// ---------------------------------------------------------------------------

describe("extractStickerThumbnail — invalid or missing JSON from OpenAI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when OpenAI returns a plain text response with no JSON", async () => {
    mockCompletionsCreate.mockResolvedValueOnce(
      makeOpenAiResponse("Sorry, I cannot detect any sticker in this image."),
    );

    const result = await extractStickerThumbnail(makeImageBuffer());

    expect(result).toBeNull();
  });

  it("returns null when OpenAI returns an empty string", async () => {
    mockCompletionsCreate.mockResolvedValueOnce(makeOpenAiResponse(""));

    const result = await extractStickerThumbnail(makeImageBuffer());

    expect(result).toBeNull();
  });

  it("returns null when the parsed JSON is missing numeric fields (invalid shape)", async () => {
    const bbox = '{"x": "left", "y": "top", "width": "half", "height": "half"}';
    mockCompletionsCreate.mockResolvedValueOnce(makeOpenAiResponse(bbox));

    const result = await extractStickerThumbnail(makeImageBuffer());

    expect(result).toBeNull();
  });

  it("returns null when the parsed JSON is missing fields entirely", async () => {
    mockCompletionsCreate.mockResolvedValueOnce(makeOpenAiResponse('{"foo": "bar"}'));

    const result = await extractStickerThumbnail(makeImageBuffer());

    expect(result).toBeNull();
  });

  it("returns null when OpenAI call throws an error", async () => {
    mockCompletionsCreate.mockRejectedValueOnce(new Error("Network error"));

    const result = await extractStickerThumbnail(makeImageBuffer());

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractStickerThumbnail — timeout
// ---------------------------------------------------------------------------

describe("extractStickerThumbnail — timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when the OpenAI call hangs and the 15-second timeout fires", async () => {
    mockCompletionsCreate.mockImplementationOnce(
      () => new Promise(() => { /* never resolves */ }),
    );

    const resultPromise = extractStickerThumbnail(makeImageBuffer());

    vi.advanceTimersByTime(15_001);

    const result = await resultPromise;
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractStickerThumbnail — sharp crop failure
// ---------------------------------------------------------------------------

describe("extractStickerThumbnail — sharp crop failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSharpExtract.mockReturnValue(mockSharpInstance);
    mockSharpPng.mockReturnValue(mockSharpInstance);
  });

  it("returns null when sharp metadata cannot read image dimensions", async () => {
    const bbox = '{"x": 10, "y": 10, "width": 50, "height": 50}';
    mockCompletionsCreate.mockResolvedValueOnce(makeOpenAiResponse(bbox));
    mockSharpMetadata.mockResolvedValueOnce({ width: 0, height: 0 });

    const result = await extractStickerThumbnail(makeImageBuffer());

    expect(result).toBeNull();
  });

  it("returns null when sharp extract throws during crop", async () => {
    const bbox = '{"x": 10, "y": 10, "width": 50, "height": 50}';
    mockCompletionsCreate.mockResolvedValueOnce(makeOpenAiResponse(bbox));
    mockSharpMetadata.mockResolvedValueOnce({ width: 300, height: 300 });
    mockSharpToBuffer.mockRejectedValueOnce(new Error("sharp: invalid extract region"));

    const result = await extractStickerThumbnail(makeImageBuffer());

    expect(result).toBeNull();
  });
});
