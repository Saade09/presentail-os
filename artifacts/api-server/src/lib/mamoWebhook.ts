import { logger } from "./logger";

const MAMO_API_BASE = "https://api.mamopay.com";

/**
 * Logs a warning at startup for each Mamo env var that is absent.
 *
 * Both MAMO_API_KEY and MAMO_WEBHOOK_SECRET must be present for the Mamo
 * webhook handler to accept and verify incoming payment events.  A missing
 * value means any webhook sent by Mamo will be rejected with a 503/401 once
 * the server is live, so we surface the problem as early as possible.
 *
 * This is intentionally a warning (not a fatal error) so that deployments that
 * do not use Mamo at all can still start normally.
 */
export function warnMamoEnvVars(): void {
  const missing: string[] = [];
  if (!process.env.MAMO_API_KEY) missing.push("MAMO_API_KEY");
  if (!process.env.MAMO_WEBHOOK_SECRET) missing.push("MAMO_WEBHOOK_SECRET");

  if (missing.length > 0) {
    logger.warn(
      { missingVars: missing },
      `Mamo payment integration is misconfigured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. ` +
        "Incoming Mamo webhooks will be rejected until this is corrected.",
    );
  }

  if (process.env.MAMO_ENABLED === "false") {
    logger.warn("Mamo payment integration is explicitly disabled (MAMO_ENABLED=false). Payment link creation will be blocked.");
  }
}

type MamoWebhook = {
  id: string;
  url: string;
  auth_header: string;
  is_active?: boolean;
};

type MamoWebhookListResponse = {
  data?: MamoWebhook[];
  results?: MamoWebhook[];
};

type MamoWebhookCreateResponse = {
  data?: MamoWebhook;
  id?: string;
};

/**
 * Returns the base URL for this deployment.
 * Mirrors the same logic used in paymentLinks.ts.
 */
function deploymentBaseUrl(): string {
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  }
  return process.env.PUBLIC_URL ?? "";
}

/**
 * On startup, ensure Mamo has a webhook registered for this deployment's
 * /api/webhooks/mamo endpoint with the correct auth_header value.
 *
 * If the webhook is missing it is created; if the auth_header is out of sync
 * it is updated. A clear log line reports the outcome in every case.
 *
 * Skips silently when MAMO_API_KEY or MAMO_WEBHOOK_SECRET are not set.
 * Never throws — failures are logged as warnings so the server still starts.
 */
export async function ensureMamoWebhook(): Promise<void> {
  const apiKey = process.env.MAMO_API_KEY;
  const webhookSecret = process.env.MAMO_WEBHOOK_SECRET;

  if (!apiKey || !webhookSecret) {
    logger.warn("Mamo webhook auto-registration skipped: MAMO_API_KEY or MAMO_WEBHOOK_SECRET not set");
    return;
  }

  const base = deploymentBaseUrl();
  if (!base) {
    logger.warn("Mamo webhook auto-registration skipped: could not determine deployment URL (set REPLIT_DEV_DOMAIN or PUBLIC_URL)");
    return;
  }

  const targetUrl = `${base}/api/webhooks/mamo`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  try {
    const listResp = await fetch(`${MAMO_API_BASE}/manage_api/v1/webhooks`, {
      method: "GET",
      headers,
    });

    if (!listResp.ok) {
      const text = await listResp.text();
      logger.warn(
        { status: listResp.status, body: text },
        "Mamo webhook auto-registration: failed to list webhooks",
      );
      return;
    }

    const listData = await listResp.json() as MamoWebhookListResponse;
    const webhooks: MamoWebhook[] = listData.data ?? listData.results ?? [];

    const existing = webhooks.find((wh) => wh.url === targetUrl);

    if (existing) {
      if (existing.auth_header === webhookSecret) {
        logger.info(
          { webhookId: existing.id, url: targetUrl },
          "Mamo webhook auto-registration: webhook already registered with correct auth_header",
        );
        return;
      }

      // auth_header is out of sync — update it
      const updateResp = await fetch(
        `${MAMO_API_BASE}/manage_api/v1/webhooks/${existing.id}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ auth_header: webhookSecret }),
        },
      );

      if (!updateResp.ok) {
        const text = await updateResp.text();
        logger.warn(
          { status: updateResp.status, body: text, webhookId: existing.id },
          "Mamo webhook auto-registration: failed to update auth_header",
        );
        return;
      }

      logger.info(
        { webhookId: existing.id, url: targetUrl },
        "Mamo webhook auto-registration: auth_header updated to match MAMO_WEBHOOK_SECRET",
      );
      return;
    }

    // No webhook for this URL yet — create one
    const createResp = await fetch(`${MAMO_API_BASE}/manage_api/v1/webhooks`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url: targetUrl,
        auth_header: webhookSecret,
        is_active: true,
      }),
    });

    if (!createResp.ok) {
      const text = await createResp.text();
      logger.warn(
        { status: createResp.status, body: text, url: targetUrl },
        "Mamo webhook auto-registration: failed to create webhook",
      );
      return;
    }

    const createData = await createResp.json() as MamoWebhookCreateResponse;
    const newId = createData.data?.id ?? createData.id ?? "(unknown)";

    logger.info(
      { webhookId: newId, url: targetUrl },
      "Mamo webhook auto-registration: webhook created successfully",
    );
  } catch (err) {
    const isNetworkError =
      err instanceof Error &&
      (err.message.includes("ENOTFOUND") || err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED"));
    if (isNetworkError) {
      logger.warn(
        "Mamo webhook auto-registration skipped: api.mamopay.com is not reachable from this server (geo-restricted DNS — only resolves from UAE/GCC networks)",
      );
    } else {
      logger.warn({ err }, "Mamo webhook auto-registration: unexpected error");
    }
  }
}
