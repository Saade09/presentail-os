import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { randomBytes } from "crypto";
import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import { z } from "zod";
import OpenAI from "openai";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { getGoogleAccessToken } from "../lib/googleOAuth";
import { callAI } from "../lib/ai/callAI";
import { logger } from "../lib/logger";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPG, PNG, and WebP images are allowed."));
    }
  },
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.resolve(__dirname, "../../public/uploads/google-posts");

function getPublicBaseUrl(): string {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) {
    throw new Error(
      "PUBLIC_BASE_URL is not set. Configure it to the public HTTPS URL of this server.",
    );
  }
  return base.replace(/\/$/, "");
}

function getOpenAIClient(): OpenAI {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function getGbpBaseUrl(): string {
  const accountId = process.env.GBP_ACCOUNT_ID ?? "108815106028044891520";
  const locationId = process.env.GBP_LOCATION_ID ?? "842875596205470406";
  return `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/localPosts`;
}

router.use(requireAuth, resolveWorkspace);

/**
 * POST /api/google-product-post/generate
 * Accepts multipart/form-data with:
 *   - image (file, required)
 *   - productName (string, optional)
 *   - productUrl (string, optional)
 *   - extraNotes (string, optional)
 */
router.post(
  "/api/google-product-post/generate",
  upload.single("image"),
  async (req, res) => {
    const wreq = workspace(req);
    if (wreq.workspaceRole !== "owner") {
      res.status(403).json({ success: false, error: "Owner access required." });
      return;
    }

    if (!req.file) {
      res.status(400).json({ success: false, error: "An image file is required." });
      return;
    }

    try {
      await fs.mkdir(UPLOAD_DIR, { recursive: true });

      const filename = `${randomBytes(16).toString("hex")}.jpg`;
      const filePath = path.join(UPLOAD_DIR, filename);

      const jpgBuffer = await sharp(req.file.buffer).jpeg({ quality: 90 }).toBuffer();
      await fs.writeFile(filePath, jpgBuffer);

      const publicBaseUrl = getPublicBaseUrl();
      const imageUrl = `${publicBaseUrl}/uploads/google-posts/${filename}`;

      const productName = (req.body.productName as string | undefined)?.trim() ?? "";
      const productUrl = (req.body.productUrl as string | undefined)?.trim() ?? "";
      const extraNotes = (req.body.extraNotes as string | undefined)?.trim() ?? "";

      const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
      const openai = getOpenAIClient();

      const systemPrompt = `You are a creative product copywriter for a gifting brand.
Given a product image and optional context, produce a JSON object with exactly these keys:
- productName: a short product name (string)
- shortDescription: a 1-2 sentence product description (string)
- googlePostSummary: a compelling 150-300 character Google Business post text (string)
- ctaActionType: always exactly "SHOP" (string)
- ctaUrl: the product URL to shop (string, use the provided URL or "" if not given)

Respond ONLY with a valid JSON object — no markdown, no explanation.`;

      const userContent: OpenAI.Responses.EasyInputMessage["content"] = [
        {
          type: "input_image",
          image_url: imageUrl,
          detail: "auto",
        },
      ];

      const contextParts: string[] = [];
      if (productName) contextParts.push(`Product name: ${productName}`);
      if (productUrl) contextParts.push(`Product URL: ${productUrl}`);
      if (extraNotes) contextParts.push(`Extra notes: ${extraNotes}`);
      if (contextParts.length > 0) {
        userContent.push({
          type: "input_text",
          text: contextParts.join("\n"),
        });
      }

      const response = await callAI({
        actionKey: "google_product_post.generate",
        surface: "google_product_post",
        provider: "openai",
        api: "responses",
        model,
        sessionId: `workspace:${wreq.workspaceOwnerId}`,
        client: openai,
        instructions: systemPrompt,
        input: [
          {
            role: "user",
            content: userContent,
          },
        ],
      });

      const rawText = response.output_text?.trim() ?? "";
      let parsed: {
        productName: string;
        shortDescription: string;
        googlePostSummary: string;
        ctaActionType: string;
        ctaUrl: string;
      };

      try {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
      } catch {
        req.log.warn({ rawText }, "OpenAI returned non-JSON response");
        res.status(502).json({
          success: false,
          error: "AI returned an unexpected format. Please try again.",
        });
        return;
      }

      res.json({
        success: true,
        imageUrl,
        productName: parsed.productName ?? productName,
        shortDescription: parsed.shortDescription ?? "",
        googlePostSummary: parsed.googlePostSummary ?? "",
        ctaActionType: "SHOP",
        ctaUrl: parsed.ctaUrl ?? productUrl,
      });
    } catch (err) {
      logger.error({ err }, "googleProductPost generate error");
      const msg = err instanceof Error ? err.message : "Unknown error";
      const isAuthErr = msg.includes("GOOGLE_CLIENT_ID") || msg.includes("OPENAI_API_KEY") || msg.includes("token exchange");
      res.status(502).json({
        success: false,
        error: isAuthErr ? msg : "Failed to generate post. Please try again.",
      });
    }
  },
);

const publishSchema = z.object({
  summary: z.string().min(1, "Post summary is required."),
  imageUrl: z.string().url("imageUrl must be a valid URL."),
  ctaUrl: z.string().url("ctaUrl must be a valid URL."),
});

/**
 * POST /api/google-product-post/publish
 * Publishes a STANDARD local post to Google Business Profile.
 */
router.post("/api/google-product-post/publish", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ success: false, error: "Owner access required." });
    return;
  }

  const parsed = publishSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message ?? "Invalid input." });
    return;
  }

  const { summary, imageUrl, ctaUrl } = parsed.data;

  try {
    const accessToken = await getGoogleAccessToken();
    const gbpUrl = getGbpBaseUrl();

    const payload = {
      topicType: "STANDARD",
      languageCode: "en-US",
      summary,
      callToAction: {
        actionType: "SHOP",
        url: ctaUrl,
      },
      media: [
        {
          mediaFormat: "PHOTO",
          sourceUrl: imageUrl,
        },
      ],
    };

    const gbpRes = await fetch(gbpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const gbpBody = (await gbpRes.json()) as Record<string, unknown>;

    if (!gbpRes.ok) {
      const errMsg = mapGbpError(gbpRes.status, gbpBody);
      res.status(gbpRes.status === 401 || gbpRes.status === 403 ? 502 : 400).json({
        success: false,
        error: errMsg,
      });
      return;
    }

    const postName = typeof gbpBody.name === "string" ? gbpBody.name : "";
    const postId = postName.split("/").pop() ?? "";
    const state = typeof gbpBody.state === "string" ? gbpBody.state : "PROCESSING";

    res.json({
      success: true,
      googleResponse: gbpBody,
      postName,
      postId,
      state,
    });
  } catch (err) {
    logger.error({ err }, "googleProductPost publish error");
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ success: false, error: msg });
  }
});

/**
 * GET /api/google-product-post/status/:postId
 * Re-fetches the current state of a published post.
 */
router.get("/api/google-product-post/status/:postId", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ success: false, error: "Owner access required." });
    return;
  }

  const { postId } = req.params;

  try {
    const accessToken = await getGoogleAccessToken();
    const gbpUrl = `${getGbpBaseUrl()}/${postId}`;

    const gbpRes = await fetch(gbpUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (gbpRes.status === 404) {
      res.status(404).json({ success: false, error: "Post not found." });
      return;
    }

    const gbpBody = (await gbpRes.json()) as Record<string, unknown>;

    if (!gbpRes.ok) {
      const errMsg = mapGbpError(gbpRes.status, gbpBody);
      res.status(400).json({ success: false, error: errMsg });
      return;
    }

    const state = typeof gbpBody.state === "string" ? gbpBody.state : "UNKNOWN";
    res.json({ success: true, post: gbpBody, state });
  } catch (err) {
    logger.error({ err }, "googleProductPost status error");
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ success: false, error: msg });
  }
});

function mapGbpError(status: number, body: Record<string, unknown>): string {
  const detail =
    typeof body.error === "object" && body.error !== null
      ? (body.error as Record<string, unknown>)
      : {};
  const message = typeof detail.message === "string" ? detail.message : "";

  if (status === 401 || status === 403) {
    return "Google authentication failed. Check your OAuth credentials.";
  }
  if (status === 400) {
    return message || "Google rejected the post. Check the image URL and CTA URL.";
  }
  if (status === 429) {
    return "Google Business Profile API rate limit reached. Please try again later.";
  }
  return message || `Google API error (HTTP ${status}).`;
}

export default router;
