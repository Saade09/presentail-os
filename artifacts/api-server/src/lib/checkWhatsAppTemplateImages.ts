/**
 * Startup probe — HEAD-requests each WhatsApp template header image to confirm
 * Meta / respond.io can retrieve them. Logs an error for any unreachable URL
 * so missing images are caught before orders arrive.
 *
 * Runs fire-and-forget after initDb(); never blocks server startup.
 */
import { logger } from "./logger";
import { orderPaymentTemplateHeaderImage } from "./respondioOrderTemplates";
import type { RespondIoOrderPaymentTemplateName } from "./respondioOrderTemplates";

const IMAGE_TEMPLATE_NAMES: readonly RespondIoOrderPaymentTemplateName[] = [
  "new_order_received",
  "order_ready",
  "order_delivered",
];

const PROBE_TIMEOUT_MS = 5_000;

/**
 * HEAD-requests each WhatsApp order template header image URL.
 * Logs an error for any URL that is missing, returns non-200, or times out.
 * Never throws.
 */
export async function checkWhatsAppTemplateImages(): Promise<void> {
  await Promise.allSettled(
    IMAGE_TEMPLATE_NAMES.map(async (templateName) => {
      const url = orderPaymentTemplateHeaderImage(templateName);
      if (!url) {
        logger.error(
          { templateName },
          `WhatsApp template image: no URL configured for "${templateName}" — upload the image to the public bucket or set the RESPONDIO_IMG_* override`,
        );
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(url, { method: "HEAD", signal: controller.signal });
        if (res.ok) {
          logger.info(
            { templateName, url, status: res.status },
            `WhatsApp template image OK: "${templateName}"`,
          );
        } else {
          logger.error(
            { templateName, url, status: res.status },
            `WhatsApp template image unreachable: "${templateName}" at ${url} returned HTTP ${res.status}`,
          );
        }
      } catch (err) {
        const isTimeout =
          err instanceof Error && (err.name === "AbortError" || err.message.includes("abort"));
        logger.error(
          { templateName, url, err: isTimeout ? undefined : err, timedOut: isTimeout },
          `WhatsApp template image probe failed: "${templateName}" at ${url}${isTimeout ? " (timed out after 5 s)" : ""}`,
        );
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}
