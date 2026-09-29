import { Resend } from "resend";
import { createHash } from "node:crypto";
import { logger } from "./logger";
import {
  buildMonthlyReportEmailHtml,
  buildMonthlyReportEmailText,
  type MonthlySalesResult,
} from "./cmcMonthlySales";
import { formatSupplierStatementDate } from "./supplierStatementFormatting";

let _resend: Resend | null = null;
export function getResendClient(): Resend {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is not set — email sending is unavailable");
    }
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

function getResend(): Resend {
  return getResendClient();
}

export type SupplierStatementEmailOptions = {
  to: string[];
  subject: string;
  message: string;
  requestId: string;
  stepId: string;
  entityId: number;
  periodStart: string;
  periodEnd: string;
  replyTo?: string | null;
  idempotencyKey?: string | null;
};

export type SupplierStatementEmailResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; retryable: boolean; errorCode: string; errorMessage: string };

function escapeSupplierStatementHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

/**
 * Supplier collection email transport. This deliberately lives beside the
 * existing Resend client but has its own sender, headers, and reply routing;
 * it must never share customer or purchase-order communication records.
 */
export async function sendSupplierStatementEmail(
  options: SupplierStatementEmailOptions,
): Promise<SupplierStatementEmailResult> {
  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch {
    return {
      ok: false,
      retryable: false,
      errorCode: "not_configured",
      errorMessage: "RESEND_API_KEY missing",
    };
  }

  const message = options.message.trim();
  const periodStart = formatSupplierStatementDate(options.periodStart);
  const periodEnd = formatSupplierStatementDate(options.periodEnd);
  const text = [
    "Hello,",
    "",
    message,
    "",
    `Statement period: ${periodStart} to ${periodEnd}.`,
    "",
    "Thank you,",
    "Presentail Supplier Collections",
  ].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.5"><p>Hello,</p><p>${escapeSupplierStatementHtml(message).replace(/\n/g, "<br>")}</p><p><strong>Statement period:</strong> ${escapeSupplierStatementHtml(periodStart)} to ${escapeSupplierStatementHtml(periodEnd)}.</p><p>Thank you,<br>Presentail Supplier Collections</p></div>`;
  try {
    const { data, error } = await resendClient.emails.send({
      from: process.env.SUPPLIER_STATEMENT_FROM?.trim()
        || "Presentail Supplier Collections <supplier-statements@presentail.com>",
      to: options.to,
      subject: `${options.subject} [Statement ref: ${options.requestId}]`,
      html,
      text,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      headers: {
        "X-Presentail-Message-Namespace": "supplier-statement-collection",
        "X-Presentail-Supplier-Statement-Request": options.requestId,
        "X-Presentail-Supplier-Statement-Step": options.stepId,
        "X-Presentail-Supplier-Statement-Entity": String(options.entityId),
        "X-Presentail-Supplier-Statement-Period":
          `${options.periodStart}/${options.periodEnd}`,
        ...(options.idempotencyKey
          ? { "X-Presentail-Idempotency-Key": options.idempotencyKey }
          : {}),
      },
      tags: [
        { name: "namespace", value: "supplier_statement_collection" },
        { name: "request_id", value: options.requestId },
        { name: "step_id", value: options.stepId },
      ],
    }, options.idempotencyKey
      ? { idempotencyKey: createHash("sha256").update(options.idempotencyKey).digest("hex") }
      : undefined);
    if (error) {
      return {
        ok: false,
        retryable: false,
        errorCode: "provider_rejected",
        errorMessage: error.message || "Resend rejected supplier statement email",
      };
    }
    return { ok: true, providerMessageId: data?.id ?? null };
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      errorCode: "network_error",
      errorMessage: error instanceof Error ? error.message : "Resend request failed",
    };
  }
}

/**
 * Result of a customer-facing order email send, consumed by the Customer
 * Communications tracking layer (lib/orderComms.ts). `skipped` means the email
 * service is not configured (RESEND_API_KEY missing) — nothing was attempted.
 */
export type OrderEmailSendResult = {
  sent: boolean;
  skipped: boolean;
  messageId: string | null;
  errorMessage: string | null;
  subject: string;
};

const FROM = "Presentail OS <no-reply@presentail.com>";
const DASHBOARD_URL = "https://os.presentail.com";
const BRAND_COLOR = "#0A404E";

/**
 * Customer-facing order emails are sent under the "Presentail" brand (not
 * "Presentail OS"), with replies routed to the support inbox and the brand P
 * logo in the header. Internal/staff emails keep using {@link FROM}.
 */
const ORDER_EMAIL_FROM = "Presentail <no-reply@presentail.com>";
const ORDER_EMAIL_REPLY_TO = "hello@presentail.com";
const ORDER_EMAIL_LOGO_URL = `${DASHBOARD_URL}/presentail-logo.png`;

/**
 * Order status changes that trigger a customer-facing status email. Every other
 * status (pending, cancelled, on_hold, refunded) changes silently.
 * - `processing` — order received / payment successful
 * - `ready_for_delivery` — order prepared, will be dispatched in time
 * - `out_for_delivery` — order dispatched and on its way
 * - `completed` — order delivered
 */
export const ORDER_STATUS_EMAIL_STATUSES: ReadonlySet<string> = new Set([
  "processing",
  "ready_for_delivery",
  "out_for_delivery",
  "completed",
]);

function formatLeaveDays(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function roleLabel(role: string): string {
  const map: Record<string, string> = {
    owner: "Owner",
    customer_service_agent: "Customer Service Agent",
    designer: "Designer",
  };
  return map[role] ?? role;
}

export function buildInviteHtml(opts: {
  toEmail: string;
  invitedByEmail: string | null;
  role: string;
  isAccessApproval?: boolean;
  inviteToken?: string;
}): string {
  const { toEmail, invitedByEmail, role, isAccessApproval = false, inviteToken } = opts;
  const inviterName = invitedByEmail ?? "Your team";
  const roleName = roleLabel(role);

  const eyebrowText = isAccessApproval ? "Access request approved" : "You're invited";
  const headlineText = isAccessApproval
    ? `Your access request<br/>has been approved`
    : `Join your team on<br/>Presentail OS`;
  const bodyText = isAccessApproval
    ? `Good news — your request to access Presentail OS has been approved. You've been added as a <strong style="color:#0f172a;">${escapeHtml(roleName)}</strong>. Sign in now and you'll be taken straight to your workspace.`
    : `<strong style="color:#0f172a;">${escapeHtml(inviterName)}</strong> has invited you to their workspace as a <strong style="color:#0f172a;">${escapeHtml(roleName)}</strong>. Accept the invitation by signing in — you'll be added automatically.`;
  const ctaText = isAccessApproval ? "Sign in to your workspace →" : "Accept invitation →";
  const footerNote = isAccessApproval
    ? `Sign in with <strong style="color:#64748b;">${escapeHtml(toEmail)}</strong> and you'll land straight in your workspace.`
    : `Sign in with <strong style="color:#64748b;">${escapeHtml(toEmail)}</strong> and you'll be added to the workspace automatically. If you weren't expecting this invitation you can safely ignore this email.`;
  const badgeLabel = isAccessApproval ? "Approved by" : "Invited by";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${isAccessApproval ? "Your access request has been approved" : "You've been invited to Presentail OS"}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Logo / Header -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};border-radius:14px;width:52px;height:52px;text-align:center;vertical-align:middle;">
                    <span style="font-size:22px;line-height:52px;font-weight:800;color:#ffffff;font-family:'Inter',Arial,sans-serif;letter-spacing:-1px;">P</span>
                  </td>
                  <td style="padding-left:14px;vertical-align:middle;">
                    <span style="font-size:20px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Presentail OS</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,0.07);overflow:hidden;">

              <!-- Top accent bar -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};height:5px;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <!-- Body -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:40px 48px 16px;">
                    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:${BRAND_COLOR};letter-spacing:0.08em;text-transform:uppercase;">${eyebrowText}</p>
                    <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#0f172a;line-height:1.25;letter-spacing:-0.5px;">
                      ${headlineText}
                    </h1>
                    <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.6;">
                      ${bodyText}
                    </p>
                  </td>
                </tr>

                <!-- Role badge row -->
                <tr>
                  <td style="padding:0 48px 28px;">
                    <table cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:10px;width:100%;">
                      <tr>
                        <td style="padding:16px 20px;">
                          <table cellpadding="0" cellspacing="0" width="100%">
                            <tr>
                              <td>
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Your role</p>
                                <p style="margin:0;font-size:15px;font-weight:600;color:#0f172a;">${escapeHtml(roleName)}</p>
                              </td>
                              <td align="right">
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">${escapeHtml(badgeLabel)}</p>
                                <p style="margin:0;font-size:14px;color:#0f172a;">${escapeHtml(inviterName)}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- CTA Button -->
                <tr>
                  <td align="center" style="padding:0 48px 36px;">
                    <a href="${isAccessApproval || !inviteToken ? `${DASHBOARD_URL}/sign-in` : `${DASHBOARD_URL}/join?token=${inviteToken}`}"
                       style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 36px;border-radius:10px;letter-spacing:0.01em;">
                      ${ctaText}
                    </a>
                  </td>
                </tr>

                <!-- Note -->
                <tr>
                  <td style="padding:0 48px 36px;">
                    <table cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding-top:24px;">
                          <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
                            ${footerNote}
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:28px;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Presentail OS &nbsp;·&nbsp;
                <a href="${DASHBOARD_URL}" style="color:#94a3b8;text-decoration:underline;">os.presentail.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendInviteEmail(opts: {
  toEmail: string;
  invitedByEmail: string | null;
  role: string;
  isAccessApproval?: boolean;
  inviteToken?: string;
}): Promise<void> {
  const { toEmail, invitedByEmail, role, isAccessApproval = false, inviteToken } = opts;
  const inviterName = invitedByEmail ?? "Your team";
  const roleName = roleLabel(role);

  const subject = isAccessApproval
    ? `Your access to Presentail OS has been approved`
    : `${inviterName} invited you to Presentail OS`;

  const html = buildInviteHtml(opts);

  const joinUrl = isAccessApproval || !inviteToken
    ? `${DASHBOARD_URL}/sign-in`
    : `${DASHBOARD_URL}/join?token=${inviteToken}`;

  const text = isAccessApproval
    ? `Your access to Presentail OS has been approved

Good news — your request to access Presentail OS has been approved. You've been added as a ${roleName}.

Sign in with ${toEmail} at ${DASHBOARD_URL}/sign-in and you'll land straight in your workspace.`
    : `You've been invited to Presentail OS

${inviterName} has invited you as a ${roleName}.

Accept your invitation at ${joinUrl}

If you weren't expecting this, you can safely ignore this email.`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ toEmail }, "Skipping invite email — RESEND_API_KEY not configured");
    return;
  }

  const { error } = await resendClient.emails.send({
    from: FROM,
    to: toEmail,
    subject,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, toEmail }, "Failed to send invite email");
  } else {
    logger.info({ toEmail }, "Invite email sent");
  }
}

export function buildAccessRequestHtml(opts: {
  requesterEmail: string;
  requesterName: string;
}): string {
  const { requesterEmail, requesterName } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>New Access Request — Presentail OS</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Logo / Header -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};border-radius:14px;width:52px;height:52px;text-align:center;vertical-align:middle;">
                    <span style="font-size:22px;line-height:52px;font-weight:800;color:#ffffff;font-family:'Inter',Arial,sans-serif;letter-spacing:-1px;">P</span>
                  </td>
                  <td style="padding-left:14px;vertical-align:middle;">
                    <span style="font-size:20px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Presentail OS</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,0.07);overflow:hidden;">

              <!-- Top accent bar -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};height:5px;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <!-- Body -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:40px 48px 16px;">
                    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:${BRAND_COLOR};letter-spacing:0.08em;text-transform:uppercase;">Access Request</p>
                    <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#0f172a;line-height:1.25;letter-spacing:-0.5px;">
                      Someone wants access<br/>to Presentail OS
                    </h1>
                    <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.6;">
                      The following user signed in but doesn't have workspace access yet. They've requested to be invited.
                    </p>
                  </td>
                </tr>

                <!-- Requester details -->
                <tr>
                  <td style="padding:0 48px 28px;">
                    <table cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:10px;width:100%;">
                      <tr>
                        <td style="padding:16px 20px;">
                          <table cellpadding="0" cellspacing="0" width="100%">
                            <tr>
                              <td>
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Name</p>
                                <p style="margin:0;font-size:15px;font-weight:600;color:#0f172a;">${escapeHtml(requesterName)}</p>
                              </td>
                              <td align="right">
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Email</p>
                                <p style="margin:0;font-size:14px;color:#0f172a;">${escapeHtml(requesterEmail)}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- CTA Button -->
                <tr>
                  <td align="center" style="padding:0 48px 36px;">
                    <a href="${DASHBOARD_URL}/dashboard/users"
                       style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 36px;border-radius:10px;letter-spacing:0.01em;">
                      Manage Users →
                    </a>
                  </td>
                </tr>

                <!-- Note -->
                <tr>
                  <td style="padding:0 48px 36px;">
                    <table cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding-top:24px;">
                          <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
                            To grant access, go to Dashboard → Users and invite <strong style="color:#64748b;">${escapeHtml(requesterEmail)}</strong>.
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:28px;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Presentail OS &nbsp;·&nbsp;
                <a href="${DASHBOARD_URL}" style="color:#94a3b8;text-decoration:underline;">os.presentail.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendAccessRequestEmail(opts: {
  requesterEmail: string;
  requesterName: string;
  ownerEmails: string[];
}): Promise<void> {
  const { requesterEmail, requesterName, ownerEmails } = opts;

  if (ownerEmails.length === 0) {
    logger.warn({ requesterEmail }, "No owner emails found — skipping access request notification");
    return;
  }

  const html = buildAccessRequestHtml({ requesterEmail, requesterName });

  const text = `New Access Request — Presentail OS

${requesterName} (${requesterEmail}) signed in but doesn't have workspace access.

To grant access, go to ${DASHBOARD_URL}/dashboard/users and invite ${requesterEmail}.`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.error({ requesterEmail }, "Cannot send access request email — RESEND_API_KEY not configured");
    throw new Error("Email service is not configured");
  }

  const { error } = await resendClient.emails.send({
    from: FROM,
    to: ownerEmails,
    subject: `Access request from ${requesterName} (${requesterEmail})`,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, requesterEmail, ownerEmails }, "Failed to send access request email");
    throw new Error("Failed to send access request email");
  } else {
    logger.info({ requesterEmail, ownerEmails }, "Access request email sent");
  }
}

export function buildAccessRejectionHtml(opts: {
  toEmail: string;
}): string {
  const { toEmail } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your Presentail OS access request</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Logo / Header -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};border-radius:14px;width:52px;height:52px;text-align:center;vertical-align:middle;">
                    <span style="font-size:22px;line-height:52px;font-weight:800;color:#ffffff;font-family:'Inter',Arial,sans-serif;letter-spacing:-1px;">P</span>
                  </td>
                  <td style="padding-left:14px;vertical-align:middle;">
                    <span style="font-size:20px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Presentail OS</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,0.07);overflow:hidden;">

              <!-- Top accent bar -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};height:5px;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <!-- Body -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:40px 48px 16px;">
                    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:${BRAND_COLOR};letter-spacing:0.08em;text-transform:uppercase;">Access request update</p>
                    <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#0f172a;line-height:1.25;letter-spacing:-0.5px;">
                      Your access request<br/>was not approved
                    </h1>
                    <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.6;">
                      Thank you for your interest in Presentail OS. After review, your request to access the workspace has not been approved at this time.
                    </p>
                    <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.6;">
                      If you believe this was a mistake or have any questions, please reach out to your workspace administrator directly.
                    </p>
                  </td>
                </tr>

                <!-- Note -->
                <tr>
                  <td style="padding:0 48px 36px;">
                    <table cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding-top:24px;">
                          <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
                            This notification was sent to <strong style="color:#64748b;">${escapeHtml(toEmail)}</strong>.
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:28px;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Presentail OS &nbsp;·&nbsp;
                <a href="${DASHBOARD_URL}" style="color:#94a3b8;text-decoration:underline;">os.presentail.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendAccessRejectionEmail(opts: {
  toEmail: string;
}): Promise<void> {
  const { toEmail } = opts;

  const html = buildAccessRejectionHtml({ toEmail });

  const text = `Your Presentail OS access request was not approved

Thank you for your interest in Presentail OS. After review, your request to access the workspace has not been approved at this time.

If you believe this was a mistake or have any questions, please reach out to your workspace administrator directly.`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ toEmail }, "Skipping rejection email — RESEND_API_KEY not configured");
    return;
  }

  const { error } = await resendClient.emails.send({
    from: FROM,
    to: toEmail,
    subject: `Your Presentail OS access request was not approved`,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, toEmail }, "Failed to send access rejection email");
  } else {
    logger.info({ toEmail }, "Access rejection email sent");
  }
}

export function buildOfflineAlertHtml(opts: {
  toEmail: string;
  deviceNames: string[];
  thresholdMinutes: number;
}): string {
  const { deviceNames, thresholdMinutes } = opts;

  const thresholdLabel =
    thresholdMinutes >= 60
      ? `${thresholdMinutes / 60} hour${thresholdMinutes / 60 === 1 ? "" : "s"}`
      : `${thresholdMinutes} minute${thresholdMinutes === 1 ? "" : "s"}`;

  const deviceListHtml = deviceNames
    .map(
      (name) =>
        `<li style="padding:6px 0;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:14px;">${escapeHtml(name)}</li>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Device offline alert</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};border-radius:14px;width:52px;height:52px;text-align:center;vertical-align:middle;">
                    <span style="font-size:22px;line-height:52px;font-weight:800;color:#ffffff;font-family:'Inter',Arial,sans-serif;letter-spacing:-1px;">P</span>
                  </td>
                  <td style="padding-left:14px;vertical-align:middle;">
                    <span style="font-size:20px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Presentail OS</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background:#ffffff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,0.07);overflow:hidden;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#dc2626;height:5px;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:40px 48px 16px;">
                    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#dc2626;letter-spacing:0.08em;text-transform:uppercase;">Device Alert</p>
                    <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#0f172a;line-height:1.25;letter-spacing:-0.5px;">
                      ${deviceNames.length === 1 ? "A device has" : `${deviceNames.length} devices have`} gone offline
                    </h1>
                    <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.6;">
                      The following ${deviceNames.length === 1 ? "device has" : "devices have"} not sent a heartbeat for more than <strong style="color:#0f172a;">${thresholdLabel}</strong>:
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 48px 28px;">
                    <ul style="margin:0;padding:0;list-style:none;border-top:1px solid #e2e8f0;">
                      ${deviceListHtml}
                    </ul>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:0 48px 36px;">
                    <a href="${DASHBOARD_URL}/dashboard/analytics"
                       style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 36px;border-radius:10px;letter-spacing:0.01em;">
                      View Device Monitor →
                    </a>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 48px 36px;">
                    <table cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding-top:24px;">
                          <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
                            You can adjust alert thresholds and disable email alerts in your workspace Settings.
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:28px;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Presentail OS &nbsp;·&nbsp;
                <a href="${DASHBOARD_URL}" style="color:#94a3b8;text-decoration:underline;">os.presentail.com</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendOfflineAlertEmail(opts: {
  toEmail: string;
  deviceNames: string[];
  thresholdMinutes: number;
}): Promise<void> {
  const { toEmail, deviceNames, thresholdMinutes } = opts;

  const thresholdLabel =
    thresholdMinutes >= 60
      ? `${thresholdMinutes / 60} hour${thresholdMinutes / 60 === 1 ? "" : "s"}`
      : `${thresholdMinutes} minute${thresholdMinutes === 1 ? "" : "s"}`;

  const html = buildOfflineAlertHtml(opts);

  const text = `Device Offline Alert — Presentail OS

The following ${deviceNames.length === 1 ? "device has" : "devices have"} not sent a heartbeat for more than ${thresholdLabel}:

${deviceNames.map((n) => `  • ${n}`).join("\n")}

View your device monitor: ${DASHBOARD_URL}/dashboard/analytics

You can adjust alert thresholds and disable email alerts in your workspace Settings.`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ toEmail }, "Skipping offline alert email — RESEND_API_KEY not configured");
    return;
  }

  const { error } = await resendClient.emails.send({
    from: FROM,
    to: toEmail,
    subject: `⚠️ ${deviceNames.length === 1 ? `Device "${deviceNames[0]}" is offline` : `${deviceNames.length} devices are offline`} — Presentail OS`,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, toEmail }, "Failed to send offline alert email");
  } else {
    logger.info({ toEmail, deviceCount: deviceNames.length }, "Offline alert email sent");
  }
}

function formatDateLabel(isoDate: string): string {
  // isoDate is YYYY-MM-DD. Parse as a calendar date (no timezone shift).
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function buildTimeOffDecisionHtml(opts: {
  toEmail: string;
  employeeName: string | null;
  status: "APPROVED" | "DECLINED";
  typeName: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  halfDay: boolean;
  halfDayPeriod: "AM" | "PM" | null;
  managerNote: string | null;
  reviewerName: string | null;
}): string {
  const {
    toEmail,
    employeeName,
    status,
    typeName,
    startDate,
    endDate,
    totalDays,
    halfDay,
    halfDayPeriod,
    managerNote,
    reviewerName,
  } = opts;

  const isApproved = status === "APPROVED";
  const accentColor = isApproved ? "#16a34a" : "#dc2626";
  const eyebrowText = isApproved ? "Time off approved" : "Time off declined";
  const greetingName =
    employeeName && employeeName.trim().length > 0 ? employeeName.trim() : toEmail;
  const greetingHtml = `<p style="margin:0 0 12px;font-size:15px;color:#0f172a;font-weight:600;">Hi ${escapeHtml(greetingName)},</p>`;
  const headlineText = isApproved
    ? `Your ${escapeHtml(typeName.toLowerCase())} request<br/>has been approved`
    : `Your ${escapeHtml(typeName.toLowerCase())} request<br/>was not approved`;
  const bodyText = isApproved
    ? `Good news — your manager has approved your time-off request. Your balance has been updated to reflect the approved days.`
    : `Your manager has reviewed your time-off request and was unable to approve it at this time. Any pending days have been returned to your balance.`;

  const startLabel = formatDateLabel(startDate);
  const endLabel = formatDateLabel(endDate);
  const dateRangeLabel =
    startDate === endDate ? startLabel : `${startLabel} – ${endLabel}`;

  const daysLabel = halfDay
    ? `Half day${halfDayPeriod ? ` (${halfDayPeriod})` : ""}`
    : `${totalDays} ${totalDays === 1 ? "day" : "days"}`;

  const reviewerLabel = reviewerName ?? "Your manager";

  const noteHtml = managerNote && managerNote.trim().length > 0
    ? `
                <tr>
                  <td style="padding:0 48px 28px;">
                    <table cellpadding="0" cellspacing="0" style="background:#f8fafc;border-left:3px solid ${accentColor};border-radius:6px;width:100%;">
                      <tr>
                        <td style="padding:14px 18px;">
                          <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Note from ${escapeHtml(reviewerLabel)}</p>
                          <p style="margin:0;font-size:14px;color:#0f172a;line-height:1.5;white-space:pre-wrap;">${escapeHtml(managerNote)}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${eyebrowText} — Presentail OS</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Logo / Header -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};border-radius:14px;width:52px;height:52px;text-align:center;vertical-align:middle;">
                    <span style="font-size:22px;line-height:52px;font-weight:800;color:#ffffff;font-family:'Inter',Arial,sans-serif;letter-spacing:-1px;">P</span>
                  </td>
                  <td style="padding-left:14px;vertical-align:middle;">
                    <span style="font-size:20px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Presentail OS</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,0.07);overflow:hidden;">

              <!-- Top accent bar -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${accentColor};height:5px;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <!-- Body -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:40px 48px 16px;">
                    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:${accentColor};letter-spacing:0.08em;text-transform:uppercase;">${eyebrowText}</p>
                    <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#0f172a;line-height:1.25;letter-spacing:-0.5px;">
                      ${headlineText}
                    </h1>
                    ${greetingHtml}
                    <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.6;">
                      ${bodyText}
                    </p>
                  </td>
                </tr>

                <!-- Request details -->
                <tr>
                  <td style="padding:0 48px 28px;">
                    <table cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:10px;width:100%;">
                      <tr>
                        <td style="padding:16px 20px;">
                          <table cellpadding="0" cellspacing="0" width="100%">
                            <tr>
                              <td>
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Type</p>
                                <p style="margin:0 0 14px;font-size:15px;font-weight:600;color:#0f172a;">${escapeHtml(typeName)}</p>
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Dates</p>
                                <p style="margin:0;font-size:14px;color:#0f172a;">${escapeHtml(dateRangeLabel)}</p>
                              </td>
                              <td align="right" valign="top">
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Length</p>
                                <p style="margin:0;font-size:14px;color:#0f172a;">${escapeHtml(daysLabel)}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
${noteHtml}
                <!-- CTA Button -->
                <tr>
                  <td align="center" style="padding:0 48px 36px;">
                    <a href="${DASHBOARD_URL}/time-off/my"
                       style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 36px;border-radius:10px;letter-spacing:0.01em;">
                      View time off →
                    </a>
                  </td>
                </tr>

                <!-- Note -->
                <tr>
                  <td style="padding:0 48px 36px;">
                    <table cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding-top:24px;">
                          <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
                            This notification was sent to <strong style="color:#64748b;">${escapeHtml(toEmail)}</strong>.
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:28px;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Presentail OS &nbsp;·&nbsp;
                <a href="${DASHBOARD_URL}" style="color:#94a3b8;text-decoration:underline;">os.presentail.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendTimeOffDecisionEmail(opts: {
  toEmail: string;
  employeeName: string | null;
  status: "APPROVED" | "DECLINED";
  typeName: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  halfDay: boolean;
  halfDayPeriod: "AM" | "PM" | null;
  managerNote: string | null;
  reviewerName: string | null;
}): Promise<void> {
  const {
    toEmail,
    employeeName,
    status,
    typeName,
    startDate,
    endDate,
    totalDays,
    halfDay,
    halfDayPeriod,
    managerNote,
    reviewerName,
  } = opts;

  const isApproved = status === "APPROVED";
  const eyebrowText = isApproved ? "Time off approved" : "Time off declined";
  const greetingName =
    employeeName && employeeName.trim().length > 0 ? employeeName.trim() : toEmail;
  const greetingText = `Hi ${greetingName},\n\n`;
  const startLabel = formatDateLabel(startDate);
  const endLabel = formatDateLabel(endDate);
  const dateRangeLabel = startDate === endDate ? startLabel : `${startLabel} – ${endLabel}`;
  const daysLabel = halfDay
    ? `Half day${halfDayPeriod ? ` (${halfDayPeriod})` : ""}`
    : `${totalDays} ${totalDays === 1 ? "day" : "days"}`;
  const reviewerLabel = reviewerName ?? "Your manager";
  const noteText = managerNote && managerNote.trim().length > 0
    ? `\n\nNote from ${reviewerLabel}:\n${managerNote}`
    : "";
  const subject = isApproved
    ? `${greetingName}, your ${typeName.toLowerCase()} request was approved`
    : `${greetingName}, your ${typeName.toLowerCase()} request was declined`;

  const html = buildTimeOffDecisionHtml(opts);

  const text = `${eyebrowText} — Presentail OS

${greetingText}${isApproved
    ? `Good news — your manager has approved your time-off request. Your balance has been updated to reflect the approved days.`
    : `Your manager has reviewed your time-off request and was unable to approve it at this time. Any pending days have been returned to your balance.`}

Type:   ${typeName}
Dates:  ${dateRangeLabel}
Length: ${daysLabel}${noteText}

View time off: ${DASHBOARD_URL}/time-off/my`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ toEmail, status }, "Skipping time-off decision email — RESEND_API_KEY not configured");
    return;
  }

  const { error } = await resendClient.emails.send({
    from: FROM,
    to: toEmail,
    subject,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, toEmail, status }, "Failed to send time-off decision email");
  } else {
    logger.info({ toEmail, status }, "Time-off decision email sent");
  }
}

export function buildTimeOffCancelledHtml(opts: {
  toEmail: string;
  employeeName: string | null;
  typeName: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  halfDay: boolean;
  halfDayPeriod: "AM" | "PM" | null;
  cancellationReason: string | null;
  cancelledByName: string | null;
  myRequestsUrl: string;
}): string {
  const {
    toEmail,
    employeeName,
    typeName,
    startDate,
    endDate,
    totalDays,
    halfDay,
    halfDayPeriod,
    cancellationReason,
    cancelledByName,
    myRequestsUrl,
  } = opts;

  const accentColor = "#b45309";
  const greetingName =
    employeeName && employeeName.trim().length > 0 ? employeeName.trim() : toEmail;
  const greetingHtml = `<p style="margin:0 0 12px;font-size:15px;color:#0f172a;font-weight:600;">Hi ${escapeHtml(greetingName)},</p>`;
  const cancellerLabel = cancelledByName ?? "Your manager";

  const startLabel = formatDateLabel(startDate);
  const endLabel = formatDateLabel(endDate);
  const dateRangeLabel =
    startDate === endDate ? startLabel : `${startLabel} – ${endLabel}`;
  const daysLabel = halfDay
    ? `Half day${halfDayPeriod ? ` (${halfDayPeriod})` : ""}`
    : `${totalDays} ${totalDays === 1 ? "day" : "days"}`;

  const reasonHtml = cancellationReason && cancellationReason.trim().length > 0
    ? `
                <tr>
                  <td style="padding:0 48px 28px;">
                    <table cellpadding="0" cellspacing="0" style="background:#f8fafc;border-left:3px solid ${accentColor};border-radius:6px;width:100%;">
                      <tr>
                        <td style="padding:14px 18px;">
                          <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Reason from ${escapeHtml(cancellerLabel)}</p>
                          <p style="margin:0;font-size:14px;color:#0f172a;line-height:1.5;white-space:pre-wrap;">${escapeHtml(cancellationReason)}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Time off cancelled — Presentail OS</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Logo / Header -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};border-radius:14px;width:52px;height:52px;text-align:center;vertical-align:middle;">
                    <span style="font-size:22px;line-height:52px;font-weight:800;color:#ffffff;font-family:'Inter',Arial,sans-serif;letter-spacing:-1px;">P</span>
                  </td>
                  <td style="padding-left:14px;vertical-align:middle;">
                    <span style="font-size:20px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Presentail OS</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,0.07);overflow:hidden;">

              <!-- Top accent bar -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${accentColor};height:5px;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <!-- Body -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:40px 48px 16px;">
                    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:${accentColor};letter-spacing:0.08em;text-transform:uppercase;">Time off cancelled</p>
                    <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#0f172a;line-height:1.25;letter-spacing:-0.5px;">
                      Your ${escapeHtml(typeName.toLowerCase())} request<br/>has been cancelled
                    </h1>
                    ${greetingHtml}
                    <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.6;">
                      ${escapeHtml(cancellerLabel)} has cancelled your approved time-off request. Any used days have been returned to your balance.
                    </p>
                  </td>
                </tr>

                <!-- Request details -->
                <tr>
                  <td style="padding:0 48px 28px;">
                    <table cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:10px;width:100%;">
                      <tr>
                        <td style="padding:16px 20px;">
                          <table cellpadding="0" cellspacing="0" width="100%">
                            <tr>
                              <td>
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Type</p>
                                <p style="margin:0 0 14px;font-size:15px;font-weight:600;color:#0f172a;">${escapeHtml(typeName)}</p>
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Dates</p>
                                <p style="margin:0;font-size:14px;color:#0f172a;">${escapeHtml(dateRangeLabel)}</p>
                              </td>
                              <td align="right" valign="top">
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Length</p>
                                <p style="margin:0;font-size:14px;color:#0f172a;">${escapeHtml(daysLabel)}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
${reasonHtml}
                <!-- CTA Button -->
                <tr>
                  <td align="center" style="padding:0 48px 36px;">
                    <a href="${escapeHtml(myRequestsUrl)}"
                       style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 36px;border-radius:10px;letter-spacing:0.01em;">
                      View time off →
                    </a>
                  </td>
                </tr>

                <!-- Note -->
                <tr>
                  <td style="padding:0 48px 36px;">
                    <table cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding-top:24px;">
                          <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
                            This notification was sent to <strong style="color:#64748b;">${escapeHtml(toEmail)}</strong>. If you have questions, please contact your manager.
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:28px;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Presentail OS &nbsp;·&nbsp;
                <a href="${DASHBOARD_URL}" style="color:#94a3b8;text-decoration:underline;">os.presentail.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendTimeOffCancelledEmail(opts: {
  toEmail: string;
  employeeName: string | null;
  typeName: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  halfDay: boolean;
  halfDayPeriod: "AM" | "PM" | null;
  cancellationReason: string | null;
  cancelledByName: string | null;
  myRequestsUrl: string;
}): Promise<void> {
  const { toEmail, employeeName, typeName, startDate, endDate, cancellationReason, cancelledByName } = opts;

  const greetingName =
    employeeName && employeeName.trim().length > 0 ? employeeName.trim() : toEmail;
  const cancellerLabel = cancelledByName ?? "Your manager";

  const startLabel = formatDateLabel(startDate);
  const endLabel = formatDateLabel(endDate);
  const dateRangeLabel = startDate === endDate ? startLabel : `${startLabel} – ${endLabel}`;

  const reasonText = cancellationReason && cancellationReason.trim().length > 0
    ? `\n\nReason from ${cancellerLabel}:\n${cancellationReason}`
    : "";

  const subject = `${greetingName}, your ${typeName.toLowerCase()} request has been cancelled`;

  const html = buildTimeOffCancelledHtml(opts);

  const text = `Time off cancelled — Presentail OS

Hi ${greetingName},

${cancellerLabel} has cancelled your approved time-off request. Any used days have been returned to your balance.

Type:   ${typeName}
Dates:  ${dateRangeLabel}${reasonText}

View time off: ${opts.myRequestsUrl}`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ toEmail }, "Skipping time-off cancelled email — RESEND_API_KEY not configured");
    return;
  }

  const { error } = await resendClient.emails.send({
    from: FROM,
    to: toEmail,
    subject,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, toEmail }, "Failed to send time-off cancelled email");
  } else {
    logger.info({ toEmail }, "Time-off cancelled email sent");
  }
}

export function buildTimeOffRequestSubmittedHtml(opts: {
  toEmail: string;
  requesterName: string | null;
  typeName: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  halfDay: boolean;
  halfDayPeriod: "AM" | "PM" | null;
  reason: string | null;
  approvalsUrl: string;
}): string {
  const {
    toEmail,
    requesterName,
    typeName,
    startDate,
    endDate,
    totalDays,
    halfDay,
    halfDayPeriod,
    reason,
    approvalsUrl,
  } = opts;

  const displayName =
    requesterName && requesterName.trim().length > 0 ? requesterName.trim() : toEmail;

  const startLabel = formatDateLabel(startDate);
  const endLabel = formatDateLabel(endDate);
  const dateRangeLabel =
    startDate === endDate ? startLabel : `${startLabel} – ${endLabel}`;
  const daysLabel = halfDay
    ? `Half day${halfDayPeriod ? ` (${halfDayPeriod})` : ""}`
    : `${totalDays} ${totalDays === 1 ? "day" : "days"}`;

  const reasonHtml = reason && reason.trim().length > 0
    ? `
                <tr>
                  <td style="padding:0 48px 28px;">
                    <table cellpadding="0" cellspacing="0" style="background:#f8fafc;border-left:3px solid ${BRAND_COLOR};border-radius:6px;width:100%;">
                      <tr>
                        <td style="padding:14px 18px;">
                          <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Note from ${escapeHtml(displayName)}</p>
                          <p style="margin:0;font-size:14px;color:#0f172a;line-height:1.5;white-space:pre-wrap;">${escapeHtml(reason)}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>New time-off request — Presentail OS</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Logo / Header -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};border-radius:14px;width:52px;height:52px;text-align:center;vertical-align:middle;">
                    <span style="font-size:22px;line-height:52px;font-weight:800;color:#ffffff;font-family:'Inter',Arial,sans-serif;letter-spacing:-1px;">P</span>
                  </td>
                  <td style="padding-left:14px;vertical-align:middle;">
                    <span style="font-size:20px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Presentail OS</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,0.07);overflow:hidden;">

              <!-- Top accent bar -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};height:5px;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <!-- Body -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:40px 48px 16px;">
                    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:${BRAND_COLOR};letter-spacing:0.08em;text-transform:uppercase;">New time-off request</p>
                    <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#0f172a;line-height:1.25;letter-spacing:-0.5px;">
                      ${escapeHtml(displayName)} requested<br/>${escapeHtml(typeName.toLowerCase())}
                    </h1>
                    <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.6;">
                      A direct report has submitted a new time-off request and is waiting for your review.
                    </p>
                  </td>
                </tr>

                <!-- Request details -->
                <tr>
                  <td style="padding:0 48px 28px;">
                    <table cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:10px;width:100%;">
                      <tr>
                        <td style="padding:16px 20px;">
                          <table cellpadding="0" cellspacing="0" width="100%">
                            <tr>
                              <td>
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Type</p>
                                <p style="margin:0 0 14px;font-size:15px;font-weight:600;color:#0f172a;">${escapeHtml(typeName)}</p>
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Dates</p>
                                <p style="margin:0;font-size:14px;color:#0f172a;">${escapeHtml(dateRangeLabel)}</p>
                              </td>
                              <td align="right" valign="top">
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Length</p>
                                <p style="margin:0;font-size:14px;color:#0f172a;">${escapeHtml(daysLabel)}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
${reasonHtml}
                <!-- CTA Button -->
                <tr>
                  <td align="center" style="padding:0 48px 36px;">
                    <a href="${approvalsUrl}"
                       style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 36px;border-radius:10px;letter-spacing:0.01em;">
                      Review request →
                    </a>
                  </td>
                </tr>

                <!-- Note -->
                <tr>
                  <td style="padding:0 48px 36px;">
                    <table cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding-top:24px;">
                          <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
                            This notification was sent to <strong style="color:#64748b;">${escapeHtml(toEmail)}</strong> because you are listed as ${escapeHtml(displayName)}'s manager.
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:28px;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Presentail OS &nbsp;·&nbsp;
                <a href="${DASHBOARD_URL}" style="color:#94a3b8;text-decoration:underline;">os.presentail.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendTimeOffRequestSubmittedEmail(opts: {
  toEmail: string;
  requesterName: string | null;
  typeName: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  halfDay: boolean;
  halfDayPeriod: "AM" | "PM" | null;
  reason: string | null;
  approvalsUrl: string;
}): Promise<void> {
  const {
    toEmail,
    requesterName,
    typeName,
    startDate,
    endDate,
    totalDays,
    halfDay,
    halfDayPeriod,
    reason,
    approvalsUrl,
  } = opts;

  const displayName =
    requesterName && requesterName.trim().length > 0 ? requesterName.trim() : toEmail;

  const startLabel = formatDateLabel(startDate);
  const endLabel = formatDateLabel(endDate);
  const dateRangeLabel =
    startDate === endDate ? startLabel : `${startLabel} – ${endLabel}`;
  const daysLabel = halfDay
    ? `Half day${halfDayPeriod ? ` (${halfDayPeriod})` : ""}`
    : `${totalDays} ${totalDays === 1 ? "day" : "days"}`;
  const reasonText = reason && reason.trim().length > 0
    ? `\n\nNote from ${displayName}:\n${reason}`
    : "";
  const subject = `${displayName} requested ${typeName.toLowerCase()} (${dateRangeLabel})`;

  const html = buildTimeOffRequestSubmittedHtml(opts);

  const text = `New time-off request — Presentail OS

${displayName} has submitted a new time-off request and is waiting for your review.

Type:   ${typeName}
Dates:  ${dateRangeLabel}
Length: ${daysLabel}${reasonText}

Review the request: ${approvalsUrl}`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ toEmail }, "Skipping time-off request submitted email — RESEND_API_KEY not configured");
    return;
  }

  const { error } = await resendClient.emails.send({
    from: FROM,
    to: toEmail,
    subject,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, toEmail }, "Failed to send time-off request submitted email");
  } else {
    logger.info({ toEmail }, "Time-off request submitted email sent");
  }
}

export async function sendTimeOffRequestConfirmationEmail(opts: {
  toEmail: string;
  typeName: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  halfDay: boolean;
  halfDayPeriod: "AM" | "PM" | null;
  reason: string | null;
  myRequestsUrl: string;
}): Promise<void> {
  const { toEmail, typeName, startDate, endDate, totalDays, halfDay, halfDayPeriod, reason, myRequestsUrl } = opts;

  const startLabel = formatDateLabel(startDate);
  const endLabel = formatDateLabel(endDate);
  const dateRangeLabel = startDate === endDate ? startLabel : `${startLabel} – ${endLabel}`;
  const daysLabel = halfDay
    ? `Half day${halfDayPeriod ? ` (${halfDayPeriod})` : ""}`
    : `${totalDays} ${totalDays === 1 ? "day" : "days"}`;

  const reasonHtml = reason && reason.trim().length > 0
    ? `
                <tr>
                  <td style="padding:0 48px 28px;">
                    <table cellpadding="0" cellspacing="0" style="background:#f8fafc;border-left:3px solid ${BRAND_COLOR};border-radius:6px;width:100%;">
                      <tr>
                        <td style="padding:14px 18px;">
                          <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Your note</p>
                          <p style="margin:0;font-size:14px;color:#0f172a;line-height:1.5;white-space:pre-wrap;">${escapeHtml(reason)}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>`
    : "";

  const subject = `Your ${typeName.toLowerCase()} request has been submitted`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Time-off request submitted — Presentail OS</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Logo / Header -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};border-radius:14px;width:52px;height:52px;text-align:center;vertical-align:middle;">
                    <span style="font-size:22px;line-height:52px;font-weight:800;color:#ffffff;font-family:'Inter',Arial,sans-serif;letter-spacing:-1px;">P</span>
                  </td>
                  <td style="padding-left:14px;vertical-align:middle;">
                    <span style="font-size:20px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Presentail OS</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,0.07);overflow:hidden;">

              <!-- Top accent bar -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};height:5px;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <!-- Body -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:40px 48px 16px;">
                    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:${BRAND_COLOR};letter-spacing:0.08em;text-transform:uppercase;">Request submitted</p>
                    <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#0f172a;line-height:1.25;letter-spacing:-0.5px;">
                      Your ${escapeHtml(typeName.toLowerCase())}<br/>request is pending review
                    </h1>
                    <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.6;">
                      Your request has been submitted and is waiting for your manager's review. We'll notify you once a decision has been made.
                    </p>
                  </td>
                </tr>

                <!-- Request details -->
                <tr>
                  <td style="padding:0 48px 28px;">
                    <table cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:10px;width:100%;">
                      <tr>
                        <td style="padding:16px 20px;">
                          <table cellpadding="0" cellspacing="0" width="100%">
                            <tr>
                              <td>
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Type</p>
                                <p style="margin:0 0 14px;font-size:15px;font-weight:600;color:#0f172a;">${escapeHtml(typeName)}</p>
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Dates</p>
                                <p style="margin:0;font-size:14px;color:#0f172a;">${escapeHtml(dateRangeLabel)}</p>
                              </td>
                              <td align="right" valign="top">
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Length</p>
                                <p style="margin:0;font-size:14px;color:#0f172a;">${escapeHtml(daysLabel)}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
${reasonHtml}
                <!-- CTA Button -->
                <tr>
                  <td align="center" style="padding:0 48px 36px;">
                    <a href="${myRequestsUrl}"
                       style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 36px;border-radius:10px;letter-spacing:0.01em;">
                      View my requests →
                    </a>
                  </td>
                </tr>

                <!-- Note -->
                <tr>
                  <td style="padding:0 48px 36px;">
                    <table cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding-top:24px;">
                          <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
                            This confirmation was sent to <strong style="color:#64748b;">${escapeHtml(toEmail)}</strong>. You'll receive another email when your request is approved or declined.
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:28px;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Presentail OS &nbsp;·&nbsp;
                <a href="${DASHBOARD_URL}" style="color:#94a3b8;text-decoration:underline;">os.presentail.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const reasonText = reason && reason.trim().length > 0
    ? `\n\nYour note:\n${reason}`
    : "";

  const text = `Your ${typeName.toLowerCase()} request has been submitted — Presentail OS

Your request has been submitted and is waiting for your manager's review. You'll receive another email once a decision has been made.

Type:   ${typeName}
Dates:  ${dateRangeLabel}
Length: ${daysLabel}${reasonText}

View your requests: ${myRequestsUrl}`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ toEmail }, "Skipping time-off request confirmation email — RESEND_API_KEY not configured");
    return;
  }

  const { error } = await resendClient.emails.send({
    from: FROM,
    to: toEmail,
    subject,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, toEmail }, "Failed to send time-off request confirmation email");
  } else {
    logger.info({ toEmail }, "Time-off request confirmation email sent");
  }
}

export function buildAnnualLeavePolicyAssignedHtml(opts: {
  toEmail: string;
  firstName: string | null;
  policyName: string;
  vacationDaysPerYear: number;
  sickDaysPerYear: number | null;
  effectiveYear: number;
}): string {
  const { toEmail, firstName, policyName, vacationDaysPerYear, sickDaysPerYear, effectiveYear } = opts;

  const greetingName = firstName && firstName.trim().length > 0 ? firstName.trim() : toEmail;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Annual leave policy assigned — Presentail OS</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Logo / Header -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};border-radius:14px;width:52px;height:52px;text-align:center;vertical-align:middle;">
                    <span style="font-size:22px;line-height:52px;font-weight:800;color:#ffffff;font-family:'Inter',Arial,sans-serif;letter-spacing:-1px;">P</span>
                  </td>
                  <td style="padding-left:14px;vertical-align:middle;">
                    <span style="font-size:20px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Presentail OS</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,0.07);overflow:hidden;">

              <!-- Top accent bar -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};height:5px;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <!-- Eyebrow -->
              <tr>
                <td style="padding:36px 48px 0;">
                  <p style="margin:0;font-size:11px;font-weight:700;color:#64748b;letter-spacing:0.1em;text-transform:uppercase;">Leave policy</p>
                </td>
              </tr>

              <!-- Headline -->
              <tr>
                <td style="padding:10px 48px 24px;">
                  <h1 style="margin:0;font-size:26px;font-weight:800;color:#0f172a;line-height:1.2;letter-spacing:-0.5px;">Your annual leave<br/>policy has been assigned</h1>
                </td>
              </tr>

              <!-- Greeting & body -->
              <tr>
                <td style="padding:0 48px 24px;">
                  <p style="margin:0 0 12px;font-size:15px;color:#0f172a;font-weight:600;">Hi ${escapeHtml(greetingName)},</p>
                  <p style="margin:0;font-size:14px;color:#475569;line-height:1.6;">An annual leave policy has been assigned to your account for ${escapeHtml(String(effectiveYear))}. Your leave balance has been updated accordingly.</p>
                </td>
              </tr>

              <!-- Policy details -->
              <tr>
                <td style="padding:0 48px 28px;">
                  <table cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;width:100%;">
                    <tr>
                      <td style="padding:20px 24px 4px;">
                        <p style="margin:0 0 12px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Policy details</p>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:0 24px;">
                        <table cellpadding="0" cellspacing="0" style="width:100%;">
                          <tr>
                            <td style="padding:10px 0;font-size:13px;color:#64748b;width:55%;border-bottom:1px solid #f1f5f9;">Policy name</td>
                            <td style="padding:10px 0;font-size:13px;color:#0f172a;font-weight:600;text-align:right;border-bottom:1px solid #f1f5f9;">${escapeHtml(policyName)}</td>
                          </tr>
                          <tr>
                            <td style="padding:10px 0;font-size:13px;color:#64748b;border-bottom:1px solid #f1f5f9;">Vacation days / year</td>
                            <td style="padding:10px 0;font-size:13px;color:#0f172a;font-weight:600;text-align:right;border-bottom:1px solid #f1f5f9;">${escapeHtml(formatLeaveDays(vacationDaysPerYear))}</td>
                          </tr>
                          ${sickDaysPerYear != null ? `<tr>
                            <td style="padding:10px 0;font-size:13px;color:#64748b;border-bottom:1px solid #f1f5f9;">Sick days / year</td>
                            <td style="padding:10px 0;font-size:13px;color:#0f172a;font-weight:600;text-align:right;border-bottom:1px solid #f1f5f9;">${escapeHtml(formatLeaveDays(sickDaysPerYear))}</td>
                          </tr>` : ""}
                          <tr>
                            <td style="padding:10px 0;font-size:13px;color:#64748b;">Effective year</td>
                            <td style="padding:10px 0;font-size:13px;color:#0f172a;font-weight:600;text-align:right;">${escapeHtml(String(effectiveYear))}</td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    <tr><td style="height:8px;"></td></tr>
                  </table>
                </td>
              </tr>

              <!-- CTA Button -->
              <tr>
                <td align="center" style="padding:0 48px 32px;">
                  <a href="https://os.presentail.com/time-off/my"
                     style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 36px;border-radius:10px;letter-spacing:0.01em;">
                    View leave balance →
                  </a>
                </td>
              </tr>

              <!-- Footer note -->
              <tr>
                <td style="padding:0 48px 36px;">
                  <table cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #e2e8f0;">
                    <tr>
                      <td style="padding-top:24px;">
                        <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">This is an automated notification from Presentail OS. Need help? Contact your manager or HR team.</p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

            </td>
          </tr>

          <!-- Bottom spacer -->
          <tr><td style="height:32px;"></td></tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendAnnualLeavePolicyAssignedEmail(opts: {
  toEmail: string;
  firstName: string | null;
  policyName: string;
  vacationDaysPerYear: number;
  sickDaysPerYear: number | null;
  effectiveYear: number;
}): Promise<void> {
  const { toEmail, firstName, policyName, vacationDaysPerYear, sickDaysPerYear, effectiveYear } = opts;

  const greetingName = firstName && firstName.trim().length > 0 ? firstName.trim() : toEmail;
  const subject = "Your annual leave policy has been assigned";

  const html = buildAnnualLeavePolicyAssignedHtml(opts);

  const sickLine = sickDaysPerYear != null ? `\nSick days / year:     ${formatLeaveDays(sickDaysPerYear)}` : "";
  const text = `Your annual leave policy has been assigned — Presentail OS

Hi ${greetingName},

An annual leave policy has been assigned to your account for ${effectiveYear}. Your leave balance has been updated accordingly.

Policy name:          ${policyName}
Vacation days / year: ${formatLeaveDays(vacationDaysPerYear)}${sickLine}
Effective year:       ${effectiveYear}

View your leave balance: https://os.presentail.com/time-off/my

This is an automated notification from Presentail OS. Need help? Contact your manager or HR team.`;

  const resendClient = getResend();

  const { error } = await resendClient.emails.send({
    from: FROM,
    to: toEmail,
    subject,
    html,
    text,
  });

  if (error) {
    throw new Error(`Resend delivery failed: ${error.message}`);
  }

  logger.info({ toEmail }, "Annual leave policy assigned email sent");
}

export function buildUnexpectedCountryAlertHtml(opts: {
  toEmail: string;
  deviceLabel: string;
  country: string;
  signedInAt: string;
  revokeUrl: string;
}): string {
  const { deviceLabel, country, signedInAt, revokeUrl } = opts;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign-in from an unexpected country — Presentail OS</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Logo / Header -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};border-radius:14px;width:52px;height:52px;text-align:center;vertical-align:middle;">
                    <span style="font-size:22px;line-height:52px;font-weight:800;color:#ffffff;font-family:'Inter',Arial,sans-serif;letter-spacing:-1px;">P</span>
                  </td>
                  <td style="padding-left:14px;vertical-align:middle;">
                    <span style="font-size:20px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Presentail OS</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,0.07);overflow:hidden;">

              <!-- Top accent bar (amber for caution) -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#d97706;height:5px;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <!-- Body -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:40px 48px 16px;">
                    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#d97706;letter-spacing:0.08em;text-transform:uppercase;">Security Alert</p>
                    <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#0f172a;line-height:1.25;letter-spacing:-0.5px;">
                      Sign-in from an<br/>unexpected country
                    </h1>
                    <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.6;">
                      We detected a sign-in to your Presentail OS account from a country we haven't seen before for this account. If this was you, no action is needed.
                    </p>
                  </td>
                </tr>

                <!-- Sign-in details -->
                <tr>
                  <td style="padding:0 48px 28px;">
                    <table cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:10px;width:100%;">
                      <tr>
                        <td style="padding:16px 20px;">
                          <table cellpadding="0" cellspacing="0" width="100%">
                            <tr>
                              <td style="padding-bottom:12px;">
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Device</p>
                                <p style="margin:0;font-size:15px;font-weight:600;color:#0f172a;">${escapeHtml(deviceLabel)}</p>
                              </td>
                            </tr>
                            <tr>
                              <td>
                                <table cellpadding="0" cellspacing="0" width="100%">
                                  <tr>
                                    <td>
                                      <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Country</p>
                                      <p style="margin:0;font-size:14px;color:#0f172a;">${escapeHtml(country)}</p>
                                    </td>
                                    <td align="right">
                                      <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Time</p>
                                      <p style="margin:0;font-size:14px;color:#0f172a;">${escapeHtml(signedInAt)}</p>
                                    </td>
                                  </tr>
                                </table>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- CTA Button -->
                <tr>
                  <td align="center" style="padding:0 48px 16px;">
                    <a href="${revokeUrl}"
                       style="display:inline-block;background:#dc2626;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 36px;border-radius:10px;letter-spacing:0.01em;">
                      Revoke sessions →
                    </a>
                  </td>
                </tr>

                <!-- Note -->
                <tr>
                  <td style="padding:0 48px 36px;">
                    <table cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding-top:24px;">
                          <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
                            If this was you, you can safely ignore this message. To manage your active sessions, visit <a href="${revokeUrl}" style="color:#64748b;">Profile → Security</a>.
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:28px;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Presentail OS &nbsp;·&nbsp;
                <a href="${DASHBOARD_URL}" style="color:#94a3b8;text-decoration:underline;">os.presentail.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendUnexpectedCountryAlertEmail(opts: {
  toEmail: string;
  deviceLabel: string;
  country: string;
  signedInAt: string;
}): Promise<void> {
  const { toEmail, deviceLabel, country, signedInAt } = opts;
  const revokeUrl = `${DASHBOARD_URL}/profile?tab=security`;

  const html = buildUnexpectedCountryAlertHtml({ toEmail, deviceLabel, country, signedInAt, revokeUrl });

  const text = `Sign-in from an unexpected country — Presentail OS

We detected a sign-in to your Presentail OS account from a country we haven't seen before for this account.

Device: ${deviceLabel}
Country: ${country}
Time: ${signedInAt}

If this wasn't you, revoke sessions at: ${revokeUrl}

If this was you, no action is needed.`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ toEmail }, "Skipping unexpected-country alert email — RESEND_API_KEY not configured");
    return;
  }

  const { error } = await resendClient.emails.send({
    from: FROM,
    to: toEmail,
    subject: `Sign-in from an unexpected country on your Presentail OS account`,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, toEmail }, "Failed to send unexpected-country alert email");
  } else {
    logger.info({ toEmail }, "Unexpected-country alert email sent");
  }
}

export function buildNewSignInAlertHtml(opts: {
  toEmail: string;
  deviceLabel: string;
  city: string | null;
  country: string | null;
  signedInAt: string;
  revokeUrl: string;
}): string {
  const { deviceLabel, city, country, signedInAt, revokeUrl } = opts;

  const locationParts = [city, country].filter(Boolean);
  const locationLabel = locationParts.length > 0 ? locationParts.join(", ") : "Unknown location";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>New sign-in detected — Presentail OS</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Logo / Header -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};border-radius:14px;width:52px;height:52px;text-align:center;vertical-align:middle;">
                    <span style="font-size:22px;line-height:52px;font-weight:800;color:#ffffff;font-family:'Inter',Arial,sans-serif;letter-spacing:-1px;">P</span>
                  </td>
                  <td style="padding-left:14px;vertical-align:middle;">
                    <span style="font-size:20px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Presentail OS</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,0.07);overflow:hidden;">

              <!-- Top accent bar (amber for caution) -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#d97706;height:5px;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <!-- Body -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:40px 48px 16px;">
                    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#d97706;letter-spacing:0.08em;text-transform:uppercase;">Security Alert</p>
                    <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#0f172a;line-height:1.25;letter-spacing:-0.5px;">
                      New sign-in from<br/>an unfamiliar device
                    </h1>
                    <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.6;">
                      We detected a new sign-in to your Presentail OS account from a device we haven't seen before. If this was you, no action is needed.
                    </p>
                  </td>
                </tr>

                <!-- Sign-in details -->
                <tr>
                  <td style="padding:0 48px 28px;">
                    <table cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:10px;width:100%;">
                      <tr>
                        <td style="padding:16px 20px;">
                          <table cellpadding="0" cellspacing="0" width="100%">
                            <tr>
                              <td style="padding-bottom:12px;">
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Device</p>
                                <p style="margin:0;font-size:15px;font-weight:600;color:#0f172a;">${escapeHtml(deviceLabel)}</p>
                              </td>
                            </tr>
                            <tr>
                              <td>
                                <table cellpadding="0" cellspacing="0" width="100%">
                                  <tr>
                                    <td>
                                      <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Location</p>
                                      <p style="margin:0;font-size:14px;color:#0f172a;">${escapeHtml(locationLabel)}</p>
                                    </td>
                                    <td align="right">
                                      <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Time</p>
                                      <p style="margin:0;font-size:14px;color:#0f172a;">${escapeHtml(signedInAt)}</p>
                                    </td>
                                  </tr>
                                </table>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- CTA Button -->
                <tr>
                  <td align="center" style="padding:0 48px 16px;">
                    <a href="${revokeUrl}"
                       style="display:inline-block;background:#dc2626;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 36px;border-radius:10px;letter-spacing:0.01em;">
                      Revoke sessions →
                    </a>
                  </td>
                </tr>

                <!-- Note -->
                <tr>
                  <td style="padding:0 48px 36px;">
                    <table cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding-top:24px;">
                          <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
                            If this was you, you can safely ignore this message. To stop receiving these alerts, go to <a href="${DASHBOARD_URL}/profile?tab=notifications" style="color:#64748b;">Profile → Notifications</a> and turn off new sign-in emails.
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:28px;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Presentail OS &nbsp;·&nbsp;
                <a href="${DASHBOARD_URL}" style="color:#94a3b8;text-decoration:underline;">os.presentail.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export type PurchaseOrderEmailLineItem = {
  description: string;
  quantity: string;
  unit_price: string;
  currency: string;
  supplier_item_code?: string | null;
  tax_category?: string | null;
  applied_tax_rate?: string | null;
  tax_amount?: string | null;
};

export function buildPurchaseOrderEmailHtml(opts: {
  poNumberLabel: string;
  status: string;
  currency: string;
  totalAmount: string | null;
  effectiveTotal: string | null;
  expectedDeliveryDate: string | null;
  notes: string | null;
  supplierName: string;
  locationName?: string | null;
  dashboardUrl: string;
  lineItems?: PurchaseOrderEmailLineItem[];
  acceptanceLink?: string | null;
}): string {
  const { poNumberLabel, status, currency, totalAmount, effectiveTotal, expectedDeliveryDate, notes, supplierName, locationName, dashboardUrl, lineItems, acceptanceLink } = opts;

  const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
  const displayTotal = effectiveTotal ?? totalAmount;
  const totalLabel = displayTotal
    ? `${currency} ${parseFloat(displayTotal).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "—";
  const deliveryLabel = expectedDeliveryDate
    ? new Date(expectedDeliveryDate).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : "Not specified";

  const hasLineItems = lineItems && lineItems.length > 0;

  function fmtNum(val: string, decimals = 2): string {
    const n = parseFloat(val);
    if (isNaN(n)) return val;
    return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  const TAX_CATEGORY_LABELS: Record<string, string> = {
    standard_taxable: "Standard",
    zero_rated: "Zero-rated",
    exempt: "Exempt",
    non_taxable: "Non-taxable",
    food_grocery: "Food/Grocery",
    packaging: "Packaging",
    service: "Service",
    import_related: "Import",
  };

  const hasTax = hasLineItems && lineItems!.some(
    li => li.tax_amount != null || (li.tax_category != null && li.tax_category !== "not_classified"),
  );

  const netSubtotal = hasLineItems
    ? lineItems!.reduce((sum, li) => sum + parseFloat(li.quantity) * parseFloat(li.unit_price), 0)
    : null;

  const totalTaxAmount = hasLineItems
    ? lineItems!.reduce((sum, li) => sum + (li.tax_amount != null ? parseFloat(li.tax_amount) : 0), 0)
    : 0;

  const grossTotal = netSubtotal != null ? netSubtotal + totalTaxAmount : null;

  const footerRows = hasLineItems ? (() => {
    if (hasTax && netSubtotal != null && grossTotal != null) {
      const netLabel = `${currency} ${netSubtotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const taxLabel = `+${currency} ${totalTaxAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const grossLabel = `${currency} ${grossTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      return `
                        <tr style="background:#f8fafc;">
                          <td colspan="4" style="padding:8px 12px;font-size:11px;font-weight:600;color:#64748b;text-align:right;">Net Subtotal</td>
                          <td style="padding:8px 12px;font-size:13px;color:#0f172a;text-align:right;white-space:nowrap;">${escapeHtml(netLabel)}</td>
                        </tr>
                        <tr style="background:#f8fafc;">
                          <td colspan="4" style="padding:8px 12px;font-size:11px;font-weight:600;color:#64748b;text-align:right;">Tax</td>
                          <td style="padding:8px 12px;font-size:13px;color:#64748b;text-align:right;white-space:nowrap;">${escapeHtml(taxLabel)}</td>
                        </tr>
                        <tr style="background:#f8fafc;border-top:1px solid #e2e8f0;">
                          <td colspan="4" style="padding:10px 12px;font-size:12px;font-weight:600;color:#475569;text-align:right;">Gross Total (incl. tax)</td>
                          <td style="padding:10px 12px;font-size:14px;font-weight:700;color:#0f172a;text-align:right;white-space:nowrap;">${escapeHtml(grossLabel)}</td>
                        </tr>`;
    }
    return `
                        <tr style="background:#f8fafc;">
                          <td colspan="4" style="padding:10px 12px;font-size:12px;font-weight:600;color:#475569;text-align:right;">Total</td>
                          <td style="padding:10px 12px;font-size:14px;font-weight:700;color:#0f172a;text-align:right;white-space:nowrap;">${escapeHtml(totalLabel)}</td>
                        </tr>`;
  })() : "";

  const lineItemsTableHtml = hasLineItems ? `
                <!-- Line Items -->
                <tr>
                  <td style="padding:0 48px 28px;">
                    <p style="margin:0 0 10px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Line Items</p>
                    <table cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;border-collapse:separate;">
                      <thead>
                        <tr style="background:#f8fafc;">
                          <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0;">Description</th>
                          <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0;white-space:nowrap;">Code</th>
                          <th style="text-align:right;padding:8px 12px;font-size:11px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0;white-space:nowrap;">Qty</th>
                          <th style="text-align:right;padding:8px 12px;font-size:11px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0;white-space:nowrap;">Unit Price</th>
                          <th style="text-align:right;padding:8px 12px;font-size:11px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0;white-space:nowrap;">Line Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${lineItems!.map((li, idx) => {
                          const lineTotal = (parseFloat(li.quantity) * parseFloat(li.unit_price));
                          const lineTotalLabel = isNaN(lineTotal) ? "—" : lineTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                          const rowBg = idx % 2 === 1 ? "background:#f8fafc;" : "";
                          const hasMeaningfulCategory = li.tax_category != null && li.tax_category !== "not_classified";
                          const hasTaxLine = li.tax_amount != null || hasMeaningfulCategory;
                          const taxCatLabel = hasMeaningfulCategory
                            ? (TAX_CATEGORY_LABELS[li.tax_category!] ?? li.tax_category)
                            : null;
                          const rateLabel = li.applied_tax_rate != null
                            ? `${parseFloat(li.applied_tax_rate).toFixed(2)}%`
                            : null;
                          const taxAmtLabel = li.tax_amount != null
                            ? `+tax ${li.currency} ${parseFloat(li.tax_amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                            : null;
                          const descTaxParts = [taxCatLabel, rateLabel].filter(Boolean).join(" · ");
                          return `<tr style="${rowBg}">
                            <td style="padding:8px 12px;font-size:13px;color:#0f172a;border-bottom:1px solid #f1f5f9;">${escapeHtml(li.description)}${hasTaxLine && descTaxParts ? `<br><span style="font-size:10px;color:#94a3b8;">${escapeHtml(descTaxParts)}</span>` : ""}</td>
                            <td style="padding:8px 12px;font-size:12px;color:#64748b;font-family:monospace;border-bottom:1px solid #f1f5f9;white-space:nowrap;">${li.supplier_item_code ? escapeHtml(li.supplier_item_code) : "—"}</td>
                            <td style="padding:8px 12px;font-size:13px;color:#0f172a;text-align:right;border-bottom:1px solid #f1f5f9;white-space:nowrap;">${fmtNum(li.quantity, 4).replace(/\.?0+$/, "")}</td>
                            <td style="padding:8px 12px;font-size:13px;color:#0f172a;text-align:right;border-bottom:1px solid #f1f5f9;white-space:nowrap;">${escapeHtml(li.currency)} ${fmtNum(li.unit_price)}</td>
                            <td style="padding:8px 12px;font-size:13px;font-weight:600;color:#0f172a;text-align:right;border-bottom:1px solid #f1f5f9;white-space:nowrap;">${escapeHtml(li.currency)} ${lineTotalLabel}${hasTaxLine && taxAmtLabel ? `<br><span style="font-size:10px;color:#94a3b8;font-weight:400;">${escapeHtml(taxAmtLabel)}</span>` : ""}</td>
                          </tr>`;
                        }).join("")}
                        ${footerRows}
                      </tbody>
                    </table>
                  </td>
                </tr>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Purchase Order ${escapeHtml(poNumberLabel)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Logo / Header -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};border-radius:14px;width:52px;height:52px;text-align:center;vertical-align:middle;">
                    <span style="font-size:22px;line-height:52px;font-weight:800;color:#ffffff;font-family:'Inter',Arial,sans-serif;letter-spacing:-1px;">P</span>
                  </td>
                  <td style="padding-left:14px;vertical-align:middle;">
                    <span style="font-size:20px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Presentail OS</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,0.07);overflow:hidden;">

              <!-- Top accent bar -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};height:5px;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <!-- Body -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:40px 48px 16px;">
                    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:${BRAND_COLOR};letter-spacing:0.08em;text-transform:uppercase;">Purchase Order</p>
                    <h1 style="margin:0 0 8px;font-size:26px;font-weight:700;color:#0f172a;line-height:1.25;letter-spacing:-0.5px;font-family:monospace;">
                      ${escapeHtml(poNumberLabel)}
                    </h1>
                    <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.6;">
                      Please find the purchase order details below from <strong style="color:#0f172a;">${escapeHtml(supplierName)}</strong>.
                    </p>
                  </td>
                </tr>

                <!-- PO Details -->
                <tr>
                  <td style="padding:0 48px 28px;">
                    <table cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;width:100%;border:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding:20px 24px;">
                          <table cellpadding="0" cellspacing="0" width="100%">
                            <tr>
                              <td style="padding-bottom:14px;">
                                <table cellpadding="0" cellspacing="0" width="100%">
                                  <tr>
                                    <td width="50%" style="vertical-align:top;">
                                      <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Status</p>
                                      <p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;">${escapeHtml(statusLabel)}</p>
                                    </td>
                                    <td width="50%" style="vertical-align:top;">
                                      <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Total Amount</p>
                                      <p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;">${escapeHtml(totalLabel)}</p>
                                    </td>
                                  </tr>
                                </table>
                              </td>
                            </tr>
                            <tr>
                              <td style="padding-top:14px;border-top:1px solid #e2e8f0;">
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Expected Delivery</p>
                                <p style="margin:0;font-size:14px;color:#0f172a;">${escapeHtml(deliveryLabel)}</p>
                              </td>
                            </tr>
                            ${locationName ? `
                            <tr>
                              <td style="padding-top:14px;border-top:1px solid #e2e8f0;">
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Location</p>
                                <p style="margin:0;font-size:14px;color:#0f172a;">${escapeHtml(locationName)}</p>
                              </td>
                            </tr>` : ""}
                            ${notes ? `
                            <tr>
                              <td style="padding-top:14px;border-top:1px solid #e2e8f0;">
                                <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Notes</p>
                                <p style="margin:0;font-size:14px;color:#475569;white-space:pre-wrap;">${escapeHtml(notes)}</p>
                              </td>
                            </tr>` : ""}
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                ${acceptanceLink ? `
                <!-- Acceptance CTA -->
                <tr>
                  <td style="padding:0 48px 28px;text-align:center;">
                    <a href="${escapeHtml(acceptanceLink)}" style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:13px 36px;border-radius:9px;letter-spacing:-0.1px;">
                      Review &amp; Accept Order →
                    </a>
                    <p style="margin:10px 0 0;font-size:12px;color:#94a3b8;">This link is for your review only. It expires after 30 days.</p>
                  </td>
                </tr>` : ""}

                ${lineItemsTableHtml}

                <!-- Note -->
                <tr>
                  <td style="padding:0 48px 36px;">
                    <table cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding-top:24px;">
                          <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
                            This purchase order was sent from Presentail OS. Please reply to this email to confirm receipt or raise any queries.
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:28px;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Presentail OS &nbsp;·&nbsp;
                <a href="${dashboardUrl}" style="color:#94a3b8;text-decoration:underline;">os.presentail.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendPurchaseOrderEmail(opts: {
  toEmail: string;
  poNumberLabel: string;
  status: string;
  currency: string;
  totalAmount: string | null;
  effectiveTotal: string | null;
  expectedDeliveryDate: string | null;
  notes: string | null;
  supplierName: string;
  locationName?: string | null;
  lineItems?: PurchaseOrderEmailLineItem[];
  acceptanceLink?: string | null;
}): Promise<void> {
  const { toEmail, poNumberLabel, status, currency, totalAmount, effectiveTotal, expectedDeliveryDate, notes, supplierName, locationName, lineItems, acceptanceLink } = opts;

  const html = buildPurchaseOrderEmailHtml({
    poNumberLabel,
    status,
    currency,
    totalAmount,
    effectiveTotal,
    expectedDeliveryDate,
    notes,
    supplierName,
    locationName,
    dashboardUrl: DASHBOARD_URL,
    lineItems,
    acceptanceLink,
  });

  const displayTotal = effectiveTotal ?? totalAmount;
  const totalLabel = displayTotal
    ? `${currency} ${parseFloat(displayTotal).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "Not specified";

  const deliveryLabel = expectedDeliveryDate
    ? new Date(expectedDeliveryDate).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : "Not specified";

  const TAX_CATEGORY_LABELS_TEXT: Record<string, string> = {
    standard_taxable: "Standard",
    zero_rated: "Zero-rated",
    exempt: "Exempt",
    non_taxable: "Non-taxable",
    food_grocery: "Food/Grocery",
    packaging: "Packaging",
    service: "Service",
    import_related: "Import",
  };

  let lineItemsText = "";
  let taxSummaryText = "";
  if (lineItems && lineItems.length > 0) {
    const netSubtotalText = lineItems.reduce((sum, li) => sum + parseFloat(li.quantity) * parseFloat(li.unit_price), 0);
    const totalTaxText = lineItems.reduce((sum, li) => sum + (li.tax_amount != null ? parseFloat(li.tax_amount) : 0), 0);
    const hasTaxText = lineItems.some(
      li => li.tax_amount != null || (li.tax_category != null && li.tax_category !== "not_classified"),
    );

    lineItemsText = `\nLine Items:\n${lineItems.map((li) => {
      const lineTotal = parseFloat(li.quantity) * parseFloat(li.unit_price);
      const lineTotalStr = isNaN(lineTotal) ? "—" : lineTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const codeStr = li.supplier_item_code ? ` [${li.supplier_item_code}]` : "";
      const hasMeaningfulCategory = li.tax_category != null && li.tax_category !== "not_classified";
      const taxCatLabel = hasMeaningfulCategory ? (TAX_CATEGORY_LABELS_TEXT[li.tax_category!] ?? li.tax_category) : null;
      const rateLabel = li.applied_tax_rate != null ? `${parseFloat(li.applied_tax_rate).toFixed(2)}%` : null;
      const taxAmtStr = li.tax_amount != null ? ` +tax ${li.currency} ${parseFloat(li.tax_amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "";
      const taxDescParts = [taxCatLabel, rateLabel].filter(Boolean).join(" · ");
      const taxDesc = taxDescParts ? ` (${taxDescParts})` : "";
      return `  - ${li.description}${codeStr}${taxDesc}: qty ${li.quantity} x ${li.currency} ${parseFloat(li.unit_price).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} = ${li.currency} ${lineTotalStr}${taxAmtStr}`;
    }).join("\n")}\n`;

    if (hasTaxText) {
      const grossAmtText = netSubtotalText + totalTaxText;
      taxSummaryText = `\nNet Subtotal: ${currency} ${netSubtotalText.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\nTax: +${currency} ${totalTaxText.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\nGross Total (incl. tax): ${currency} ${grossAmtText.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
    }
  }

  const text = `Purchase Order ${poNumberLabel}

Please find the purchase order details below from ${supplierName}.

Status: ${status.charAt(0).toUpperCase() + status.slice(1)}
Total Amount: ${totalLabel}
Expected Delivery: ${deliveryLabel}
${locationName ? `Location: ${locationName}\n` : ""}${lineItemsText}${taxSummaryText}${notes ? `\nNotes:\n${notes}` : ""}

This purchase order was sent from Presentail OS. Please reply to this email to confirm receipt or raise any queries.${acceptanceLink ? `\n\nReview & Accept Order: ${acceptanceLink}` : ""}`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ toEmail }, "Skipping purchase order email — RESEND_API_KEY not configured");
    throw new Error("Email service is not configured");
  }

  const { error } = await resendClient.emails.send({
    from: FROM,
    to: toEmail,
    subject: `Purchase Order ${poNumberLabel} from Presentail OS`,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, toEmail }, "Failed to send purchase order email");
    throw new Error("Failed to send purchase order email");
  } else {
    logger.info({ toEmail, poNumberLabel }, "Purchase order email sent");
  }
}

export async function sendWorkshopSaleReceiptEmail(opts: {
  toEmail: string;
  orderNumber: string;
  currency: string;
  total: string;
  amountPaid: string;
  balanceDue: string;
  customerName?: string | null;
  pdfBuffer: Buffer;
}): Promise<void> {
  const {
    toEmail,
    orderNumber,
    currency,
    total,
    amountPaid,
    balanceDue,
    customerName,
    pdfBuffer,
  } = opts;

  const fmt = (v: string) =>
    `${currency} ${parseFloat(v || "0").toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  const greeting = customerName ? `Hi ${customerName},` : "Hello,";
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #0f172a;">
      <div style="height: 4px; background: ${BRAND_COLOR}; border-radius: 4px;"></div>
      <h2 style="margin: 20px 0 4px;">Your receipt — ${orderNumber}</h2>
      <p style="color: #475569;">${greeting}</p>
      <p style="color: #475569;">Thank you for your order. Your receipt is attached as a PDF. Here is a quick summary:</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding: 6px 0; color: #64748b;">Total</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${fmt(total)}</td></tr>
        <tr><td style="padding: 6px 0; color: #64748b;">Amount paid</td><td style="padding: 6px 0; text-align: right;">${fmt(amountPaid)}</td></tr>
        <tr><td style="padding: 6px 0; color: #64748b;">Balance due</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${fmt(balanceDue)}</td></tr>
      </table>
      <p style="color: #94a3b8; font-size: 12px;">This receipt was sent from Presentail OS.</p>
    </div>`;

  const text = `Your receipt — ${orderNumber}

${greeting}

Thank you for your order. Your receipt is attached as a PDF.

Total: ${fmt(total)}
Amount paid: ${fmt(amountPaid)}
Balance due: ${fmt(balanceDue)}

This receipt was sent from Presentail OS.`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ toEmail }, "Skipping workshop sale receipt email — RESEND_API_KEY not configured");
    throw new Error("Email service is not configured");
  }

  const { error } = await resendClient.emails.send({
    from: FROM,
    to: toEmail,
    subject: `Receipt ${orderNumber} from Presentail OS`,
    html,
    text,
    attachments: [
      {
        filename: `Receipt-${orderNumber.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`,
        content: pdfBuffer,
      },
    ],
  });

  if (error) {
    logger.warn({ error, toEmail }, "Failed to send workshop sale receipt email");
    throw new Error("Failed to send workshop sale receipt email");
  }
  logger.info({ toEmail, orderNumber }, "Workshop sale receipt email sent");
}

export function buildLowStockAlertHtml(opts: {
  itemName: string;
  locationName: string;
  country: string;
  currentStock: number;
  effectiveThreshold: number;
  deficit: number;
  dashboardUrl: string;
}): string {
  const { itemName, locationName, country, currentStock, effectiveThreshold, deficit, dashboardUrl } = opts;
  const baseItemsUrl = `${dashboardUrl}/dashboard/base-items`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Low Stock Alert — ${escapeHtml(itemName)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Logo / Header -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};border-radius:14px;width:52px;height:52px;text-align:center;vertical-align:middle;">
                    <span style="font-size:22px;line-height:52px;font-weight:800;color:#ffffff;font-family:'Inter',Arial,sans-serif;letter-spacing:-1px;">P</span>
                  </td>
                  <td style="padding-left:14px;vertical-align:middle;">
                    <span style="font-size:20px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Presentail OS</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,0.07);overflow:hidden;">

              <!-- Top accent bar -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#f59e0b;height:4px;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <!-- Body -->
              <table width="100%" cellpadding="0" cellspacing="0">

                <!-- Eyebrow + Headline -->
                <tr>
                  <td style="padding:40px 48px 24px;">
                    <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#f59e0b;letter-spacing:0.08em;text-transform:uppercase;">Low Stock Alert</p>
                    <h1 style="margin:0 0 14px;font-size:24px;font-weight:800;color:#0f172a;line-height:1.25;letter-spacing:-0.5px;">
                      ${escapeHtml(itemName)}<br/>is running low
                    </h1>
                    <p style="margin:0;font-size:15px;color:#475569;line-height:1.65;">
                      Stock at <strong style="color:#0f172a;">${escapeHtml(locationName)}</strong>${country ? ` (${escapeHtml(country)})` : ""} has dropped to or below its alert threshold. Immediate attention may be needed to avoid a stockout.
                    </p>
                  </td>
                </tr>

                <!-- Stock Details -->
                <tr>
                  <td style="padding:0 48px 28px;">
                    <table cellpadding="0" cellspacing="0" style="background:#fff7ed;border-radius:10px;width:100%;border:1px solid #fed7aa;">
                      <tr>
                        <td style="padding:20px 24px;">
                          <table cellpadding="0" cellspacing="0" width="100%">
                            <tr>
                              <td width="33%" style="vertical-align:top;padding-bottom:14px;">
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Current Stock</p>
                                <p style="margin:0;font-size:22px;font-weight:800;color:#dc2626;">${currentStock}</p>
                              </td>
                              <td width="33%" style="vertical-align:top;padding-bottom:14px;">
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Alert Threshold</p>
                                <p style="margin:0;font-size:22px;font-weight:800;color:#0f172a;">${effectiveThreshold}</p>
                              </td>
                              <td width="33%" style="vertical-align:top;padding-bottom:14px;">
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Deficit</p>
                                <p style="margin:0;font-size:22px;font-weight:800;color:#f59e0b;">${deficit}</p>
                              </td>
                            </tr>
                            <tr>
                              <td colspan="3" style="padding-top:14px;border-top:1px solid #fed7aa;">
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Location</p>
                                <p style="margin:0;font-size:14px;color:#0f172a;">${escapeHtml(locationName)}${country ? ` &mdash; ${escapeHtml(country)}` : ""}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- CTA -->
                <tr>
                  <td style="padding:0 48px 36px;">
                    <table cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="background:${BRAND_COLOR};border-radius:10px;">
                          <a href="${baseItemsUrl}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:-0.2px;">
                            View Base Items &rarr;
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Footer note -->
                <tr>
                  <td style="padding:0 48px 36px;">
                    <table cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding-top:24px;">
                          <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
                            This alert was sent from Presentail OS because this location's stock dropped to or below its configured threshold. At most one alert per location is sent per 24-hour window.
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:28px;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Presentail OS &nbsp;&middot;&nbsp;
                <a href="${dashboardUrl}" style="color:#94a3b8;text-decoration:underline;">os.presentail.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendLowStockAlertEmail(opts: {
  toEmail: string;
  itemName: string;
  locationName: string;
  country: string;
  currentStock: number;
  effectiveThreshold: number;
  deficit: number;
}): Promise<void> {
  const { toEmail, itemName, locationName, country, currentStock, effectiveThreshold, deficit } = opts;

  const html = buildLowStockAlertHtml({
    itemName,
    locationName,
    country,
    currentStock,
    effectiveThreshold,
    deficit,
    dashboardUrl: DASHBOARD_URL,
  });

  const text = `Low Stock Alert — ${itemName}

Stock at ${locationName}${country ? ` (${country})` : ""} has dropped to or below its alert threshold.

Current Stock: ${currentStock}
Alert Threshold: ${effectiveThreshold}
Deficit: ${deficit}

Review and reorder as needed: ${DASHBOARD_URL}/dashboard/base-items

This alert is sent at most once per location per 24-hour window.`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ toEmail }, "Skipping low-stock alert email — RESEND_API_KEY not configured");
    return;
  }

  const { error } = await resendClient.emails.send({
    from: FROM,
    to: toEmail,
    subject: `Low stock alert: ${itemName} at ${locationName}`,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, toEmail }, "Failed to send low-stock alert email");
  } else {
    logger.info({ toEmail, itemName, locationName }, "Low-stock alert email sent");
  }
}

export async function sendNewSignInAlertEmail(opts: {
  toEmail: string;
  deviceLabel: string;
  city: string | null;
  country: string | null;
  signedInAt: string;
}): Promise<void> {
  const { toEmail, deviceLabel, city, country, signedInAt } = opts;

  const locationParts = [city, country].filter(Boolean);
  const locationLabel = locationParts.length > 0 ? locationParts.join(", ") : "Unknown location";
  const revokeUrl = `${DASHBOARD_URL}/profile?tab=security`;

  const html = buildNewSignInAlertHtml({ toEmail, deviceLabel, city, country, signedInAt, revokeUrl });

  const text = `New sign-in from an unfamiliar device — Presentail OS

We detected a new sign-in to your Presentail OS account from a device we haven't seen before.

Device: ${deviceLabel}
Location: ${locationLabel}
Time: ${signedInAt}

If this wasn't you, revoke sessions at: ${revokeUrl}

If this was you, no action is needed. To stop receiving these alerts, go to Profile → Notifications and turn off new sign-in emails.`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ toEmail }, "Skipping new sign-in alert email — RESEND_API_KEY not configured");
    return;
  }

  const { error } = await resendClient.emails.send({
    from: FROM,
    to: toEmail,
    subject: `New sign-in detected on your Presentail OS account`,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, toEmail }, "Failed to send new sign-in alert email");
  } else {
    logger.info({ toEmail }, "New sign-in alert email sent");
  }
}

// ── Customer-facing order emails ───────────────────────────────────────────
// Sent to the order sender (billing/customer contact) when an order is placed
// and on every status change. Best-effort: skip gracefully when no email is on
// file or RESEND_API_KEY is unconfigured, matching the other helpers.

const PRESENTAIL_WEBSITE_URL = "https://presentail.com";

/**
 * The Whish account number customers send manual payments to. Shown in the
 * payment-instructions email. Hardcoded constant (no per-workspace config).
 */
export const WHISH_PAYMENT_NUMBER = "+961 3 159 639";

type OrderStatusCopy = {
  label: string;
  eyebrow: string;
  headline: string;
  body: string;
  textBody: string;
};

/**
 * Friendly, customer-facing copy per order status. Falls back to a generic
 * "status updated" message for any status without bespoke copy.
 */
function orderStatusCopy(status: string): OrderStatusCopy {
  const map: Record<string, OrderStatusCopy> = {
    pending: {
      label: "Pending",
      eyebrow: "Order update",
      headline: "Your order is<br/>pending",
      body: "We've received your order and will begin processing it shortly. We'll keep you posted as it progresses.",
      textBody: "We've received your order and will begin processing it shortly. We'll keep you posted as it progresses.",
    },
    processing: {
      label: "Order received",
      eyebrow: "Order received",
      headline: "We've received<br/>your order",
      body: "Thank you — your payment was successful and your order has been received. We'll take care of everything and keep you posted at every step.",
      textBody: "Thank you — your payment was successful and your order has been received. We'll take care of everything and keep you posted at every step.",
    },
    ready_for_delivery: {
      label: "Ready for delivery",
      eyebrow: "Order update",
      headline: "Your order is<br/>ready for delivery",
      body: "Your order has been prepared and is ready for delivery. It will be dispatched in time and we'll let you know once it's on the way.",
      textBody: "Your order has been prepared and is ready for delivery. It will be dispatched in time and we'll let you know once it's on the way.",
    },
    out_for_delivery: {
      label: "Out for delivery",
      eyebrow: "Order update",
      headline: "Your order is<br/>out for delivery",
      body: "Your order is on its way to you. It should arrive soon — thank you for your patience!",
      textBody: "Your order is on its way to you. It should arrive soon — thank you for your patience!",
    },
    completed: {
      label: "Delivered",
      eyebrow: "Order update",
      headline: "Your order has<br/>been delivered",
      body: "Your order has been delivered. Thank you for choosing Presentail — we hope to see you again soon.",
      textBody: "Your order has been delivered. Thank you for choosing Presentail — we hope to see you again soon.",
    },
    cancelled: {
      label: "Cancelled",
      eyebrow: "Order update",
      headline: "Your order has<br/>been cancelled",
      body: "Your order has been cancelled. If you have any questions or this was unexpected, just reply to this email.",
      textBody: "Your order has been cancelled. If you have any questions or this was unexpected, just reply to this email.",
    },
    refunded: {
      label: "Refunded",
      eyebrow: "Order update",
      headline: "Your order has<br/>been refunded",
      body: "Your order has been refunded. The amount should appear in your account within a few business days.",
      textBody: "Your order has been refunded. The amount should appear in your account within a few business days.",
    },
    on_hold: {
      label: "On hold",
      eyebrow: "Order update",
      headline: "Your order is<br/>on hold",
      body: "Your order is currently on hold. We'll be in touch with an update soon — thank you for your patience.",
      textBody: "Your order is currently on hold. We'll be in touch with an update soon — thank you for your patience.",
    },
  };
  return (
    map[status] ?? {
      label: status,
      eyebrow: "Order update",
      headline: "Your order has<br/>an update",
      body: `Your order status has been updated to "${status}". We'll keep you posted with any further changes.`,
      textBody: `Your order status has been updated to "${status}". We'll keep you posted with any further changes.`,
    }
  );
}

/**
 * A single line item shown in the customer-facing order emails. `priceText` and
 * `quantity` are optional and pre-formatted by the caller (no currency/locale
 * logic lives in this module).
 */
export type OrderEmailItem = {
  name: string;
  imageUrl?: string | null;
  quantity?: number | string | null;
  priceText?: string | null;
};

/**
 * Optional pricing-breakdown + extras shown alongside the line items in the
 * customer order emails. All fields are pre-formatted by the caller (no
 * currency/locale logic lives in this module) and every amount is expected to
 * be in the currency the customer actually paid.
 */
export type OrderEmailDetails = {
  items?: OrderEmailItem[];
  amountPaidText?: string | null;
  deliveryDateText?: string | null;
  subtotalText?: string | null;
  deliveryFeeText?: string | null;
  discountText?: string | null;
  paymentMethodText?: string | null;
  cardMessage?: string | null;
  cardFrom?: string | null;
  cardTo?: string | null;
};

/**
 * Render the optional "order details" block (line items with thumbnails, the
 * pricing breakdown, the delivery date, and the card message). Returns an
 * empty string when there is nothing to show, so the shell collapses cleanly.
 */
function renderOrderDetailsHtml(details: OrderEmailDetails): string {
  const {
    items,
    amountPaidText,
    deliveryDateText,
    subtotalText,
    deliveryFeeText,
    discountText,
    paymentMethodText,
    cardMessage,
    cardFrom,
    cardTo,
  } = details;
  const hasItems = !!items && items.length > 0;
  const hasMeta =
    !!amountPaidText ||
    !!deliveryDateText ||
    !!subtotalText ||
    !!deliveryFeeText ||
    !!discountText ||
    !!paymentMethodText ||
    !!cardMessage;
  if (!hasItems && !hasMeta) return "";

  const itemRows = hasItems
    ? items!
        .map((item) => {
          const qty = item.quantity != null && `${item.quantity}`.trim() !== "" ? `${item.quantity}` : "";
          const thumb = item.imageUrl
            ? `<img src="${escapeHtml(item.imageUrl)}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;border-radius:10px;object-fit:cover;background:#f1f5f9;" />`
            : `<div style="width:56px;height:56px;border-radius:10px;background:#f1f5f9;"></div>`;
          return `
                        <tr>
                          <td style="padding:10px 0;width:56px;vertical-align:middle;">${thumb}</td>
                          <td style="padding:10px 0 10px 14px;vertical-align:middle;">
                            <p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;line-height:1.35;">${escapeHtml(item.name)}</p>
                            ${qty ? `<p style="margin:3px 0 0;font-size:12px;color:#94a3b8;">Qty ${escapeHtml(qty)}</p>` : ""}
                          </td>
                          ${
                            item.priceText
                              ? `<td align="right" style="padding:10px 0;vertical-align:middle;white-space:nowrap;"><p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;">${escapeHtml(item.priceText)}</p></td>`
                              : ""
                          }
                        </tr>`;
        })
        .join("")
    : "";

  const itemsBlock = hasItems
    ? `
                    <p style="margin:0 0 10px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Order items</p>
                    <table cellpadding="0" cellspacing="0" width="100%">
                      ${itemRows}
                    </table>`
    : "";

  const metaRow = (label: string, value: string): string => `
                        <tr>
                          <td style="padding:6px 0;font-size:14px;color:#64748b;">${escapeHtml(label)}</td>
                          <td align="right" style="padding:6px 0;font-size:14px;font-weight:600;color:#0f172a;">${escapeHtml(value)}</td>
                        </tr>`;
  const metaRows: string[] = [];
  if (subtotalText) metaRows.push(metaRow("Subtotal", subtotalText));
  if (deliveryFeeText) metaRows.push(metaRow("Delivery fee", deliveryFeeText));
  if (discountText) metaRows.push(metaRow("Discount", discountText));
  if (amountPaidText) metaRows.push(metaRow("Total", amountPaidText));
  if (paymentMethodText) metaRows.push(metaRow("Payment method", paymentMethodText));
  if (deliveryDateText) metaRows.push(metaRow("Delivery date", deliveryDateText));
  const cardMessageBlock = cardMessage
    ? `
                    <table cellpadding="0" cellspacing="0" width="100%" style="margin-top:14px;">
                      <tr>
                        <td style="background:#f8fafc;border-left:3px solid ${BRAND_COLOR};border-radius:6px;padding:12px 16px;">
                          <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Card message</p>
                          <p style="margin:0;font-size:14px;color:#334155;line-height:1.6;font-style:italic;">${escapeHtml(cardMessage)}</p>
                           ${
                             cardFrom || cardTo
                               ? `<p style="margin:8px 0 0;font-size:12px;color:#64748b;line-height:1.5;">${[
                                   cardFrom ? `From: ${escapeHtml(cardFrom)}` : "",
                                   cardTo ? `To: ${escapeHtml(cardTo)}` : "",
                                 ]
                                   .filter(Boolean)
                                   .join(" &nbsp;·&nbsp; ")}</p>`
                               : ""
                           }
                        </td>
                      </tr>
                    </table>`
    : "";
  const metaBlock = hasMeta
    ? `
                    ${hasItems && metaRows.length > 0 ? `<table cellpadding="0" cellspacing="0" width="100%"><tr><td style="border-top:1px solid #e2e8f0;font-size:0;line-height:0;padding-top:14px;">&nbsp;</td></tr></table>` : ""}
                    <table cellpadding="0" cellspacing="0" width="100%">
                      ${metaRows.join("")}
                    </table>
                    ${cardMessageBlock}`
    : "";

  return `
                <!-- Order details -->
                <tr>
                  <td style="padding:0 48px 32px;">
                    ${itemsBlock}
                    ${metaBlock}
                  </td>
                </tr>`;
}

/**
 * Plain-text counterpart of {@link renderOrderDetailsHtml} for the text/plain
 * MIME part. Returns an empty string when there is nothing to show.
 */
function renderOrderDetailsText(details: OrderEmailDetails): string {
  const {
    items,
    amountPaidText,
    deliveryDateText,
    subtotalText,
    deliveryFeeText,
    discountText,
    paymentMethodText,
    cardMessage,
    cardFrom,
    cardTo,
  } = details;
  const lines: string[] = [];
  if (items && items.length > 0) {
    lines.push("", "Order items:");
    for (const item of items) {
      const qty = item.quantity != null && `${item.quantity}`.trim() !== "" ? ` x${item.quantity}` : "";
      const price = item.priceText ? ` — ${item.priceText}` : "";
      lines.push(`- ${item.name}${qty}${price}`);
    }
  }
  const metaLines: string[] = [];
  if (subtotalText) metaLines.push(`Subtotal: ${subtotalText}`);
  if (deliveryFeeText) metaLines.push(`Delivery fee: ${deliveryFeeText}`);
  if (discountText) metaLines.push(`Discount: ${discountText}`);
  if (amountPaidText) metaLines.push(`Total: ${amountPaidText}`);
  if (paymentMethodText) metaLines.push(`Payment method: ${paymentMethodText}`);
  if (deliveryDateText) metaLines.push(`Delivery date: ${deliveryDateText}`);
  if (metaLines.length > 0) lines.push("", ...metaLines);
  if (cardMessage) {
    lines.push("", `Card message: ${cardMessage}`);
    if (cardFrom) lines.push(`From: ${cardFrom}`);
    if (cardTo) lines.push(`To: ${cardTo}`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * Shared branded shell for the customer-facing order emails so the confirmation
 * and status emails stay visually consistent with the rest of Presentail OS.
 */
function renderOrderEmailShell(opts: {
  title: string;
  eyebrow: string;
  headline: string;
  bodyHtml: string;
  orderNumber: string;
  statusLabel: string;
  greeting: string;
  items?: OrderEmailItem[];
  amountPaidText?: string | null;
  deliveryDateText?: string | null;
  subtotalText?: string | null;
  deliveryFeeText?: string | null;
  discountText?: string | null;
  paymentMethodText?: string | null;
  cardMessage?: string | null;
  calloutHtml?: string;
}): string {
  const { title, eyebrow, headline, bodyHtml, orderNumber, statusLabel, greeting, items, amountPaidText, deliveryDateText, subtotalText, deliveryFeeText, discountText, paymentMethodText, cardMessage, calloutHtml } = opts;
  const detailsHtml = renderOrderDetailsHtml({ items, amountPaidText, deliveryDateText, subtotalText, deliveryFeeText, discountText, paymentMethodText, cardMessage });
  const calloutBlock = calloutHtml
    ? `
                <tr>
                  <td style="padding:0 48px 8px;">
                    ${calloutHtml}
                  </td>
                </tr>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Logo / Header -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <img src="${ORDER_EMAIL_LOGO_URL}" width="52" height="52" alt="Presentail" style="display:block;border-radius:14px;width:52px;height:52px;" />
                  </td>
                  <td style="padding-left:14px;vertical-align:middle;">
                    <span style="font-size:20px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Presentail</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,0.07);overflow:hidden;">

              <!-- Top accent bar -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};height:5px;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <!-- Body -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:40px 48px 8px;">
                    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:${BRAND_COLOR};letter-spacing:0.08em;text-transform:uppercase;">${escapeHtml(eyebrow)}</p>
                    <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#0f172a;line-height:1.25;letter-spacing:-0.5px;">
                      ${headline}
                    </h1>
                    <p style="margin:0 0 8px;font-size:15px;color:#475569;line-height:1.6;">${escapeHtml(greeting)}</p>
                    <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.6;">
                      ${bodyHtml}
                    </p>
                  </td>
                </tr>
                ${calloutBlock}
                ${detailsHtml}
                <!-- Order summary row -->
                <tr>
                  <td style="padding:0 48px 36px;">
                    <table cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:10px;width:100%;">
                      <tr>
                        <td style="padding:16px 20px;">
                          <table cellpadding="0" cellspacing="0" width="100%">
                            <tr>
                              <td>
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Order</p>
                                <p style="margin:0;font-size:15px;font-weight:600;color:#0f172a;">${escapeHtml(orderNumber)}</p>
                              </td>
                              <td align="right">
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Status</p>
                                <p style="margin:0;font-size:15px;font-weight:600;color:${BRAND_COLOR};">${escapeHtml(statusLabel)}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:28px;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Presentail &nbsp;·&nbsp;
                <a href="${PRESENTAIL_WEBSITE_URL}" style="color:#94a3b8;text-decoration:underline;">presentail.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function buildOrderConfirmationHtml(opts: {
  orderNumber: string;
  customerName?: string | null;
  items?: OrderEmailItem[];
  amountPaidText?: string | null;
  deliveryDateText?: string | null;
  subtotalText?: string | null;
  deliveryFeeText?: string | null;
  discountText?: string | null;
  paymentMethodText?: string | null;
  cardMessage?: string | null;
}): string {
  const { orderNumber, customerName, items, amountPaidText, deliveryDateText, subtotalText, deliveryFeeText, discountText, paymentMethodText, cardMessage } = opts;
  const greeting = customerName ? `Hi ${customerName},` : "Hello,";
  return renderOrderEmailShell({
    title: `Order ${orderNumber} received`,
    eyebrow: "Order received",
    headline: "Thanks for<br/>your order",
    greeting,
    bodyHtml:
      "Thank you — your order has been received. We'll take care of everything and email you with updates at every step.",
    orderNumber,
    statusLabel: "Order received",
    items,
    amountPaidText,
    deliveryDateText,
    subtotalText,
    deliveryFeeText,
    discountText,
    paymentMethodText,
    cardMessage,
  });
}

export async function sendOrderConfirmationEmail(opts: {
  toEmail: string;
  orderNumber: string;
  customerName?: string | null;
  items?: OrderEmailItem[];
  amountPaidText?: string | null;
  deliveryDateText?: string | null;
  subtotalText?: string | null;
  deliveryFeeText?: string | null;
  discountText?: string | null;
  paymentMethodText?: string | null;
  cardMessage?: string | null;
}): Promise<OrderEmailSendResult> {
  const { toEmail, orderNumber, customerName, items, amountPaidText, deliveryDateText, subtotalText, deliveryFeeText, discountText, paymentMethodText, cardMessage } = opts;
  const subject = `We've received your order ${orderNumber}`;

  const html = buildOrderConfirmationHtml({ orderNumber, customerName, items, amountPaidText, deliveryDateText, subtotalText, deliveryFeeText, discountText, paymentMethodText, cardMessage });
  const greeting = customerName ? `Hi ${customerName},` : "Hello,";
  const text = `Thanks for your order — ${orderNumber}

${greeting}

Thank you — your order has been received. We'll take care of everything and email you with updates at every step.
${renderOrderDetailsText({ items, amountPaidText, deliveryDateText, subtotalText, deliveryFeeText, discountText, paymentMethodText, cardMessage })}
Order: ${orderNumber}
Status: Order received

Presentail · ${PRESENTAIL_WEBSITE_URL}`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ toEmail }, "Skipping order confirmation email — RESEND_API_KEY not configured");
    return { sent: false, skipped: true, messageId: null, errorMessage: "Email service not configured", subject };
  }

  const { data, error } = await resendClient.emails.send({
    from: ORDER_EMAIL_FROM,
    replyTo: ORDER_EMAIL_REPLY_TO,
    to: toEmail,
    subject,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, toEmail }, "Failed to send order confirmation email");
    return { sent: false, skipped: false, messageId: null, errorMessage: error.message ?? "Send failed", subject };
  }
  logger.info({ toEmail, orderNumber }, "Order confirmation email sent");
  return { sent: true, skipped: false, messageId: data?.id ?? null, errorMessage: null, subject };
}

export function buildOrderStatusHtml(opts: {
  orderNumber: string;
  status: string;
  customerName?: string | null;
  items?: OrderEmailItem[];
  amountPaidText?: string | null;
  deliveryDateText?: string | null;
}): string {
  const { orderNumber, status, customerName, items, amountPaidText, deliveryDateText } = opts;
  const copy = orderStatusCopy(status);
  const greeting = customerName ? `Hi ${customerName},` : "Hello,";
  return renderOrderEmailShell({
    title: `Order ${orderNumber} — ${copy.label}`,
    eyebrow: copy.eyebrow,
    headline: copy.headline,
    greeting,
    bodyHtml: copy.body,
    orderNumber,
    statusLabel: copy.label,
    items,
    amountPaidText,
    deliveryDateText,
  });
}

export async function sendOrderStatusEmail(opts: {
  toEmail: string;
  orderNumber: string;
  status: string;
  customerName?: string | null;
  items?: OrderEmailItem[];
  amountPaidText?: string | null;
  deliveryDateText?: string | null;
}): Promise<OrderEmailSendResult> {
  const { toEmail, orderNumber, status, customerName, items, amountPaidText, deliveryDateText } = opts;

  const copy = orderStatusCopy(status);
  const subject = `Update on your order ${orderNumber}: ${copy.label}`;
  const html = buildOrderStatusHtml({ orderNumber, status, customerName, items, amountPaidText, deliveryDateText });
  const greeting = customerName ? `Hi ${customerName},` : "Hello,";
  const text = `Order update — ${orderNumber}

${greeting}

${copy.textBody}
${renderOrderDetailsText({ items, amountPaidText, deliveryDateText })}
Order: ${orderNumber}
Status: ${copy.label}

Presentail · ${PRESENTAIL_WEBSITE_URL}`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ toEmail }, "Skipping order status email — RESEND_API_KEY not configured");
    return { sent: false, skipped: true, messageId: null, errorMessage: "Email service not configured", subject };
  }

  const { data, error } = await resendClient.emails.send({
    from: ORDER_EMAIL_FROM,
    replyTo: ORDER_EMAIL_REPLY_TO,
    to: toEmail,
    subject,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, toEmail }, "Failed to send order status email");
    return { sent: false, skipped: false, messageId: null, errorMessage: error.message ?? "Send failed", subject };
  }
  logger.info({ toEmail, orderNumber, status }, "Order status email sent");
  return { sent: true, skipped: false, messageId: data?.id ?? null, errorMessage: null, subject };
}

export async function sendOrderRescheduledEmail(opts: {
  toEmail: string;
  orderNumber: string;
  customerName?: string | null;
  deliveryDateText?: string | null;
  idempotencyKey?: string;
}): Promise<OrderEmailSendResult> {
  const { toEmail, orderNumber, customerName, deliveryDateText } = opts;
  const subject = `Delivery rescheduled for order ${orderNumber}`;
  const greeting = customerName ? `Hi ${customerName},` : "Hello,";
  const schedule = deliveryDateText ?? "the newly selected delivery window";
  const html = renderOrderEmailShell({
    title: subject,
    eyebrow: "Delivery update",
    headline: "Your delivery<br/>has been rescheduled",
    greeting,
    bodyHtml: `Your order is now scheduled for <strong>${escapeHtml(schedule)}</strong>. We’ll continue preparing it for the updated delivery window.`,
    orderNumber,
    statusLabel: "Rescheduled",
    deliveryDateText: schedule,
  });
  const text = `${greeting}

Your delivery for order ${orderNumber} has been rescheduled to ${schedule}.

Presentail · ${PRESENTAIL_WEBSITE_URL}`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch {
    logger.warn({ toEmail }, "Skipping delivery rescheduled email — RESEND_API_KEY not configured");
    return { sent: false, skipped: true, messageId: null, errorMessage: "Email service not configured", subject };
  }

  const { data, error } = await resendClient.emails.send({
    from: ORDER_EMAIL_FROM,
    replyTo: ORDER_EMAIL_REPLY_TO,
    to: toEmail,
    subject,
    html,
    text,
  }, opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined);
  if (error) {
    logger.warn({ error, toEmail }, "Failed to send delivery rescheduled email");
    return { sent: false, skipped: false, messageId: null, errorMessage: error.message ?? "Send failed", subject };
  }
  return { sent: true, skipped: false, messageId: data?.id ?? null, errorMessage: null, subject };
}

/**
 * Render the Whish payment callout box (account number + optional amount due)
 * shown in the payment-instructions email.
 */
function renderWhishCalloutHtml(amountDueText?: string | null): string {
  const amountRow = amountDueText
    ? `
                      <tr>
                        <td style="padding:14px 0 0;border-top:1px solid #e2e8f0;">
                          <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Amount due</p>
                          <p style="margin:0;font-size:18px;font-weight:700;color:#0f172a;">${escapeHtml(amountDueText)}</p>
                        </td>
                      </tr>`
    : "";
  return `<table cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:10px;width:100%;">
                      <tr>
                        <td style="padding:16px 20px;">
                          <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Whish account number</p>
                          <p style="margin:0;font-size:20px;font-weight:700;color:${BRAND_COLOR};letter-spacing:0.3px;">${escapeHtml(WHISH_PAYMENT_NUMBER)}</p>
                        </td>
                      </tr>
                      ${amountRow}
                    </table>`;
}

export function buildOrderPaymentInstructionsHtml(opts: {
  orderNumber: string;
  customerName?: string | null;
  amountDueText?: string | null;
  items?: OrderEmailItem[];
  deliveryDateText?: string | null;
}): string {
  const { orderNumber, customerName, amountDueText, items, deliveryDateText } = opts;
  const greeting = customerName ? `Hi ${customerName},` : "Hello,";
  return renderOrderEmailShell({
    title: `Complete payment for order ${orderNumber}`,
    eyebrow: "Payment instructions",
    headline: "Complete<br/>your payment",
    greeting,
    bodyHtml:
      "To finish your order, please send your payment via Whish to the account number below. Once we receive it, we'll confirm your order right away.",
    orderNumber,
    statusLabel: "Awaiting payment",
    calloutHtml: renderWhishCalloutHtml(amountDueText),
    items,
    deliveryDateText,
  });
}

export async function sendOrderPaymentInstructionsEmail(opts: {
  toEmail: string;
  orderNumber: string;
  customerName?: string | null;
  amountDueText?: string | null;
  items?: OrderEmailItem[];
  deliveryDateText?: string | null;
}): Promise<OrderEmailSendResult> {
  const { toEmail, orderNumber, customerName, amountDueText, items, deliveryDateText } = opts;
  const subject = `Complete your payment for order ${orderNumber}`;

  const html = buildOrderPaymentInstructionsHtml({ orderNumber, customerName, amountDueText, items, deliveryDateText });
  const greeting = customerName ? `Hi ${customerName},` : "Hello,";
  const text = `Complete your payment — ${orderNumber}

${greeting}

To finish your order, please send your payment via Whish to the account number below. Once we receive it, we'll confirm your order right away.

Whish account number: ${WHISH_PAYMENT_NUMBER}${amountDueText ? `\nAmount due: ${amountDueText}` : ""}
${renderOrderDetailsText({ items, deliveryDateText })}
Order: ${orderNumber}
Status: Awaiting payment

Presentail · ${PRESENTAIL_WEBSITE_URL}`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ toEmail }, "Skipping payment instructions email — RESEND_API_KEY not configured");
    return { sent: false, skipped: true, messageId: null, errorMessage: "Email service not configured", subject };
  }

  const { data, error } = await resendClient.emails.send({
    from: ORDER_EMAIL_FROM,
    replyTo: ORDER_EMAIL_REPLY_TO,
    to: toEmail,
    subject,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, toEmail }, "Failed to send payment instructions email");
    return { sent: false, skipped: false, messageId: null, errorMessage: error.message ?? "Send failed", subject };
  }
  logger.info({ toEmail, orderNumber }, "Payment instructions email sent");
  return { sent: true, skipped: false, messageId: data?.id ?? null, errorMessage: null, subject };
}

export function buildOrderPaymentReceivedHtml(opts: {
  orderNumber: string;
  customerName?: string | null;
  items?: OrderEmailItem[];
  amountPaidText?: string | null;
  deliveryDateText?: string | null;
}): string {
  const { orderNumber, customerName, items, amountPaidText, deliveryDateText } = opts;
  const greeting = customerName ? `Hi ${customerName},` : "Hello,";
  return renderOrderEmailShell({
    title: `Payment received for order ${orderNumber}`,
    eyebrow: "Payment received",
    headline: "We've received<br/>your payment",
    greeting,
    bodyHtml:
      "Thank you — your payment has been received and your order is now confirmed. We'll keep you updated at every step.",
    orderNumber,
    statusLabel: "Paid",
    items,
    amountPaidText,
    deliveryDateText,
  });
}

export async function sendOrderPaymentReceivedEmail(opts: {
  toEmail: string;
  orderNumber: string;
  customerName?: string | null;
  items?: OrderEmailItem[];
  amountPaidText?: string | null;
  deliveryDateText?: string | null;
}): Promise<OrderEmailSendResult> {
  const { toEmail, orderNumber, customerName, items, amountPaidText, deliveryDateText } = opts;
  const subject = `We've received your payment for order ${orderNumber}`;

  const html = buildOrderPaymentReceivedHtml({ orderNumber, customerName, items, amountPaidText, deliveryDateText });
  const greeting = customerName ? `Hi ${customerName},` : "Hello,";
  const text = `Payment received — ${orderNumber}

${greeting}

Thank you — your payment has been received and your order is now confirmed. We'll keep you updated at every step.
${renderOrderDetailsText({ items, amountPaidText, deliveryDateText })}
Order: ${orderNumber}
Status: Paid

Presentail · ${PRESENTAIL_WEBSITE_URL}`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ toEmail }, "Skipping payment received email — RESEND_API_KEY not configured");
    return { sent: false, skipped: true, messageId: null, errorMessage: "Email service not configured", subject };
  }

  const { data, error } = await resendClient.emails.send({
    from: ORDER_EMAIL_FROM,
    replyTo: ORDER_EMAIL_REPLY_TO,
    to: toEmail,
    subject,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, toEmail }, "Failed to send payment received email");
    return { sent: false, skipped: false, messageId: null, errorMessage: error.message ?? "Send failed", subject };
  }
  logger.info({ toEmail, orderNumber }, "Payment received email sent");
  return { sent: true, skipped: false, messageId: data?.id ?? null, errorMessage: null, subject };
}

/**
 * Render the refund-amount callout box shown in the refund email: the amount
 * refunded now and, for partial refunds, the cumulative total refunded so far.
 */
function renderRefundCalloutHtml(opts: {
  refundAmountText?: string | null;
  totalRefundedText?: string | null;
}): string | undefined {
  const { refundAmountText, totalRefundedText } = opts;
  if (!refundAmountText && !totalRefundedText) return undefined;
  const amountRow = refundAmountText
    ? `
                      <tr>
                        <td style="padding:16px 20px${totalRefundedText ? " 14px" : ""};">
                          <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Refund amount</p>
                          <p style="margin:0;font-size:20px;font-weight:700;color:${BRAND_COLOR};letter-spacing:0.3px;">${escapeHtml(refundAmountText)}</p>
                        </td>
                      </tr>`
    : "";
  const totalRow = totalRefundedText
    ? `
                      <tr>
                        <td style="padding:${refundAmountText ? "14px 20px 16px" : "16px 20px"};${refundAmountText ? "border-top:1px solid #e2e8f0;" : ""}">
                          <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Total refunded so far</p>
                          <p style="margin:0;font-size:16px;font-weight:700;color:#0f172a;">${escapeHtml(totalRefundedText)}</p>
                        </td>
                      </tr>`
    : "";
  return `<table cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:10px;width:100%;">${amountRow}${totalRow}
                    </table>`;
}

export function buildOrderRefundHtml(opts: {
  orderNumber: string;
  isPartial: boolean;
  customerName?: string | null;
  refundAmountText?: string | null;
  totalRefundedText?: string | null;
  items?: OrderEmailItem[];
  amountPaidText?: string | null;
  deliveryDateText?: string | null;
}): string {
  const { orderNumber, isPartial, customerName, refundAmountText, totalRefundedText, items, amountPaidText, deliveryDateText } = opts;
  const greeting = customerName ? `Hi ${customerName},` : "Hello,";
  const bodyHtml = isPartial
    ? `We've issued a partial refund${refundAmountText ? ` of <strong style="color:#0f172a;">${escapeHtml(refundAmountText)}</strong>` : ""} for your order. The amount should appear back on your original payment method within a few business days.`
    : `We've issued a full refund${refundAmountText ? ` of <strong style="color:#0f172a;">${escapeHtml(refundAmountText)}</strong>` : ""} for your order. The amount should appear back on your original payment method within a few business days.`;
  return renderOrderEmailShell({
    title: `Refund issued for order ${orderNumber}`,
    eyebrow: isPartial ? "Partial refund issued" : "Refund issued",
    headline: isPartial ? "Your partial refund<br/>is on its way" : "Your refund<br/>is on its way",
    greeting,
    bodyHtml,
    orderNumber,
    statusLabel: isPartial ? "Partially refunded" : "Refunded",
    calloutHtml: renderRefundCalloutHtml({
      refundAmountText,
      totalRefundedText: isPartial ? totalRefundedText : null,
    }),
    items,
    amountPaidText,
    deliveryDateText,
  });
}

/**
 * Customer-facing refund confirmation email, sent (best-effort) when a full or
 * partial refund is issued from the dashboard. Uses the shared branded order
 * email shell and the customer-facing Presentail sender identity.
 */
export async function sendOrderRefundEmail(opts: {
  toEmail: string;
  orderNumber: string;
  isPartial: boolean;
  customerName?: string | null;
  refundAmountText?: string | null;
  totalRefundedText?: string | null;
  items?: OrderEmailItem[];
  amountPaidText?: string | null;
  deliveryDateText?: string | null;
}): Promise<OrderEmailSendResult> {
  const { toEmail, orderNumber, isPartial, customerName, refundAmountText, totalRefundedText, items, amountPaidText, deliveryDateText } = opts;
  const subject = isPartial
    ? `A partial refund has been issued for your order ${orderNumber}`
    : `Your refund for order ${orderNumber} has been issued`;

  const html = buildOrderRefundHtml({ orderNumber, isPartial, customerName, refundAmountText, totalRefundedText, items, amountPaidText, deliveryDateText });
  const greeting = customerName ? `Hi ${customerName},` : "Hello,";
  const textBody = isPartial
    ? `We've issued a partial refund${refundAmountText ? ` of ${refundAmountText}` : ""} for your order. The amount should appear back on your original payment method within a few business days.`
    : `We've issued a full refund${refundAmountText ? ` of ${refundAmountText}` : ""} for your order. The amount should appear back on your original payment method within a few business days.`;
  const totalLine =
    isPartial && totalRefundedText ? `\nTotal refunded so far: ${totalRefundedText}` : "";
  const text = `Refund issued — ${orderNumber}

${greeting}

${textBody}${totalLine}
${renderOrderDetailsText({ items, amountPaidText, deliveryDateText })}
Order: ${orderNumber}
Status: ${isPartial ? "Partially refunded" : "Refunded"}

Presentail · ${PRESENTAIL_WEBSITE_URL}`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ toEmail }, "Skipping refund email — RESEND_API_KEY not configured");
    return { sent: false, skipped: true, messageId: null, errorMessage: "Email service not configured", subject };
  }

  const { data, error } = await resendClient.emails.send({
    from: ORDER_EMAIL_FROM,
    replyTo: ORDER_EMAIL_REPLY_TO,
    to: toEmail,
    subject,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, toEmail }, "Failed to send refund email");
    return { sent: false, skipped: false, messageId: null, errorMessage: error.message ?? "Send failed", subject };
  }
  logger.info({ toEmail, orderNumber, isPartial }, "Refund email sent");
  return { sent: true, skipped: false, messageId: data?.id ?? null, errorMessage: null, subject };
}

/**
 * Internal/staff-facing "new order received" email. Sent to the workspace's
 * owner/admin staff (not the customer) whenever a brand-new order is ingested.
 * Reuses the shared order-detail formatting ({@link renderOrderDetailsHtml} /
 * {@link renderOrderDetailsText}) and the internal {@link FROM} sender identity
 * used for other staff emails — distinct from the customer-facing
 * {@link ORDER_EMAIL_FROM} brand.
 */
export type NewOrderStaffEmailDetails = OrderEmailDetails & {
  orderNumber: string;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  deliveryAddress?: string | null;
  deliveryDistrict?: string | null;
  deliveryCity?: string | null;
  deliveryCountry?: string | null;
  deliveryInstructions?: string | null;
  deliveryTimeSlot?: string | null;
};

function staffEmailText(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function staffRecipientDiffers(
  customerName: string | null,
  customerPhone: string | null,
  recipientName: string | null,
  recipientPhone: string | null,
): boolean {
  if (!recipientName && !recipientPhone) return false;
  const hasSharedIdentity =
    (recipientName !== null && recipientName === customerName) ||
    (recipientPhone !== null && recipientPhone === customerPhone);
  const hasDifferingIdentity =
    (recipientName !== null && recipientName !== customerName) ||
    (recipientPhone !== null && recipientPhone !== customerPhone);
  return !hasSharedIdentity || hasDifferingIdentity;
}

function renderNewOrderStaffContextHtml(details: NewOrderStaffEmailDetails): string {
  const customerName = staffEmailText(details.customerName);
  const customerEmail = staffEmailText(details.customerEmail);
  const customerPhone = staffEmailText(details.customerPhone);
  const recipientName = staffEmailText(details.recipientName);
  const recipientPhone = staffEmailText(details.recipientPhone);
  const deliveryAddress = staffEmailText(details.deliveryAddress);
  const deliveryDistrict = staffEmailText(details.deliveryDistrict);
  const deliveryCity = staffEmailText(details.deliveryCity);
  const deliveryCountry = staffEmailText(details.deliveryCountry);
  const deliveryInstructions = staffEmailText(details.deliveryInstructions);
  const deliveryTimeSlot = staffEmailText(details.deliveryTimeSlot);
  const deliveryDateText = staffEmailText(details.deliveryDateText);

  const row = (label: string, value: string): string => `
                            <tr>
                              <td style="padding:4px 0;width:42%;vertical-align:top;font-size:13px;color:#64748b;">${escapeHtml(label)}</td>
                              <td style="padding:4px 0;font-size:13px;color:#0f172a;line-height:1.5;white-space:pre-wrap;">${escapeHtml(value)}</td>
                            </tr>`;
  const section = (title: string, rows: string[]): string =>
    rows.length > 0
      ? `
                    <table cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 14px;">
                      <tr>
                        <td colspan="2" style="padding:0 0 6px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">${escapeHtml(title)}</td>
                      </tr>
                      ${rows.join("")}
                    </table>`
      : "";

  const customerRows = [
    customerName ? row("Name", customerName) : "",
    customerEmail ? row("Email", customerEmail) : "",
    customerPhone ? row("Phone", customerPhone) : "",
  ].filter(Boolean);
  const recipientDiffers = staffRecipientDiffers(
    customerName,
    customerPhone,
    recipientName,
    recipientPhone,
  );
  const recipientRows = recipientDiffers
    ? [
        recipientName ? row("Name", recipientName) : "",
        recipientPhone ? row("Phone", recipientPhone) : "",
      ].filter(Boolean)
    : [];
  const deliveryRows = [
    deliveryAddress ? row("Address", deliveryAddress) : "",
    deliveryDistrict ? row("District", deliveryDistrict) : "",
    deliveryCity ? row("City", deliveryCity) : "",
    deliveryCountry ? row("Country", deliveryCountry) : "",
    deliveryDateText ? row("Delivery date", deliveryDateText) : "",
    deliveryTimeSlot ? row("Time slot", deliveryTimeSlot) : "",
    deliveryInstructions ? row("Instructions", deliveryInstructions) : "",
  ].filter(Boolean);
  const sections = [
    section("Customer", customerRows),
    section("Recipient", recipientRows),
    section("Delivery", deliveryRows),
  ].filter(Boolean);

  return sections.length > 0
    ? `
                <tr>
                  <td style="padding:12px 48px 4px;">
                    ${sections.join("")}
                  </td>
                </tr>`
    : "";
}

function renderNewOrderStaffContextText(details: NewOrderStaffEmailDetails): string {
  const customerName = staffEmailText(details.customerName);
  const customerEmail = staffEmailText(details.customerEmail);
  const customerPhone = staffEmailText(details.customerPhone);
  const recipientName = staffEmailText(details.recipientName);
  const recipientPhone = staffEmailText(details.recipientPhone);
  const deliveryAddress = staffEmailText(details.deliveryAddress);
  const deliveryDistrict = staffEmailText(details.deliveryDistrict);
  const deliveryCity = staffEmailText(details.deliveryCity);
  const deliveryCountry = staffEmailText(details.deliveryCountry);
  const deliveryInstructions = staffEmailText(details.deliveryInstructions);
  const deliveryTimeSlot = staffEmailText(details.deliveryTimeSlot);
  const deliveryDateText = staffEmailText(details.deliveryDateText);

  const section = (title: string, rows: Array<[string, string | null]>): string => {
    const available = rows.filter((row): row is [string, string] => row[1] !== null);
    return available.length > 0
      ? `${title}:\n${available.map(([label, value]) => `${label}: ${value}`).join("\n")}\n`
      : "";
  };
  const recipientDiffers = staffRecipientDiffers(
    customerName,
    customerPhone,
    recipientName,
    recipientPhone,
  );

  return [
    section("Customer", [
      ["Name", customerName],
      ["Email", customerEmail],
      ["Phone", customerPhone],
    ]),
    recipientDiffers
      ? section("Recipient", [
          ["Name", recipientName],
          ["Phone", recipientPhone],
        ])
      : "",
    section("Delivery", [
      ["Address", deliveryAddress],
      ["District", deliveryDistrict],
      ["City", deliveryCity],
      ["Country", deliveryCountry],
      ["Delivery date", deliveryDateText],
      ["Time slot", deliveryTimeSlot],
      ["Instructions", deliveryInstructions],
    ]),
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildNewOrderStaffHtml(opts: NewOrderStaffEmailDetails): string {
  const {
    orderNumber,
    items,
    amountPaidText,
    subtotalText,
    deliveryFeeText,
    discountText,
    cardMessage,
    cardFrom,
    cardTo,
  } = opts;
  const detailsHtml = renderOrderDetailsHtml({
    items,
    amountPaidText,
    subtotalText,
    deliveryFeeText,
    discountText,
    cardMessage,
    cardFrom,
    cardTo,
  });
  const staffContextHtml = renderNewOrderStaffContextHtml(opts);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>New order ${escapeHtml(orderNumber)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Logo / Header -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};border-radius:14px;width:52px;height:52px;text-align:center;vertical-align:middle;">
                    <span style="font-size:22px;line-height:52px;font-weight:800;color:#ffffff;font-family:'Inter',Arial,sans-serif;letter-spacing:-1px;">P</span>
                  </td>
                  <td style="padding-left:14px;vertical-align:middle;">
                    <span style="font-size:20px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Presentail OS</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,0.07);overflow:hidden;">

              <!-- Top accent bar -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${BRAND_COLOR};height:5px;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <!-- Body -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:40px 48px 8px;">
                    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:${BRAND_COLOR};letter-spacing:0.08em;text-transform:uppercase;">New order received</p>
                    <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#0f172a;line-height:1.25;letter-spacing:-0.5px;">
                      A new order<br/>just came in
                    </h1>
                    <p style="margin:0 0 8px;font-size:15px;color:#475569;line-height:1.6;">
                      Order <strong style="color:#0f172a;">${escapeHtml(orderNumber)}</strong> has been received.
                    </p>
                  </td>
                </tr>
                ${staffContextHtml}
                ${detailsHtml}
                <!-- Order summary row -->
                <tr>
                  <td style="padding:0 48px 36px;">
                    <table cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:10px;width:100%;">
                      <tr>
                        <td style="padding:16px 20px;">
                          <table cellpadding="0" cellspacing="0" width="100%">
                            <tr>
                              <td>
                                <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.07em;text-transform:uppercase;">Order</p>
                                <p style="margin:0;font-size:15px;font-weight:600;color:#0f172a;">${escapeHtml(orderNumber)}</p>
                              </td>
                              <td align="right">
                                <a href="${DASHBOARD_URL}/dashboard/orders" style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;padding:10px 18px;border-radius:8px;">View orders</a>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:28px;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Presentail OS &nbsp;·&nbsp;
                <a href="${DASHBOARD_URL}" style="color:#94a3b8;text-decoration:underline;">os.presentail.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendNewOrderStaffEmail(opts: {
  toEmails: string[];
} & NewOrderStaffEmailDetails): Promise<void> {
  const { toEmails, orderNumber } = opts;

  if (!toEmails || toEmails.length === 0) {
    logger.info({ orderNumber }, "No owner/admin emails on file — skipping new order staff notification");
    return;
  }

  const html = buildNewOrderStaffHtml(opts);
  const staffContextText = renderNewOrderStaffContextText(opts);
  const text = `New order received — ${orderNumber}

A new order has been received.
Order: ${orderNumber}
${staffContextText ? `\n${staffContextText}` : ""}${renderOrderDetailsText({
  items: opts.items,
  amountPaidText: opts.amountPaidText,
  subtotalText: opts.subtotalText,
  deliveryFeeText: opts.deliveryFeeText,
  discountText: opts.discountText,
  cardMessage: opts.cardMessage,
  cardFrom: opts.cardFrom,
  cardTo: opts.cardTo,
})}
View your orders at ${DASHBOARD_URL}/dashboard/orders

Presentail OS · ${DASHBOARD_URL}`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ orderNumber }, "Skipping new order staff email — RESEND_API_KEY not configured");
    return;
  }

  const { error } = await resendClient.emails.send({
    from: FROM,
    to: toEmails,
    subject: `New order received: ${orderNumber}`,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, orderNumber, toEmails }, "Failed to send new order staff email");
  } else {
    logger.info({ orderNumber, toEmails }, "New order staff email sent");
  }
}

// ── Weekly Sales Digest (task #2830) ────────────────────────────────────────

export async function sendWeeklyDigestEmail(opts: {
  to: string[];
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const { to, subject, html, text } = opts;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (e) {
    logger.warn({ to }, "Skipping weekly digest email — RESEND_API_KEY not configured");
    throw e instanceof Error ? e : new Error("RESEND_API_KEY not configured");
  }

  const { error } = await resendClient.emails.send({
    from: FROM,
    to,
    subject,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, to, subject }, "Failed to send weekly digest email");
    throw new Error(`Weekly digest email send failed: ${error.message ?? "unknown error"}`);
  }

  logger.info({ to, subject }, "Weekly digest email sent");
}

// ── CMC Monthly Sales Report ─────────────────────────────────────────────────

export async function sendCmcMonthlyReportEmail(opts: {
  toEmail: string;
  reportMonth: string;
  salesData: MonthlySalesResult;
  pdfBuffer: Buffer;
}): Promise<string | null> {
  const { toEmail, reportMonth, salesData, pdfBuffer } = opts;
  const subject = `CMC Monthly Sales Report — ${reportMonth}`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch (err) {
    logger.warn({ toEmail, reportMonth }, "CMC monthly report email unavailable — RESEND_API_KEY not configured");
    throw err;
  }

  const { data, error } = await resendClient.emails.send({
    from: FROM,
    to: toEmail,
    subject,
    html: buildMonthlyReportEmailHtml(reportMonth, salesData),
    text: buildMonthlyReportEmailText(reportMonth, salesData),
    attachments: [
      {
        filename: `cmc-monthly-sales-${reportMonth}.pdf`,
        content: pdfBuffer,
      },
    ],
  });

  if (error) {
    logger.warn({ error, toEmail, reportMonth }, "Failed to send CMC monthly report email");
    throw new Error(`CMC monthly report email send failed: ${error.message ?? "unknown error"}`);
  }

  logger.info({ toEmail, reportMonth }, "CMC monthly report email sent");
  return data?.id ?? null;
}

// ── Payment Receipt Email ────────────────────────────────────────────────────

function buildPaymentReceiptHtml(opts: {
  amountText: string;
  description: string | null;
}): string {
  const { amountText, description } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="background:#047481;padding:28px 32px;">
              <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">
                Presentail OS
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#0f172a;">
                Payment received
              </h1>
              <p style="margin:0 0 24px;font-size:14px;color:#64748b;">
                Your payment has been successfully processed.
              </p>

              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:8px;padding:20px 24px;margin-bottom:24px;">
                <tr>
                  <td style="font-size:14px;color:#64748b;">Amount paid</td>
                  <td align="right" style="font-size:20px;font-weight:700;color:#0f172a;">${amountText}</td>
                </tr>
                ${description ? `<tr><td colspan="2" style="padding-top:12px;font-size:13px;color:#64748b;">${description}</td></tr>` : ""}
              </table>

              <p style="margin:0;font-size:13px;color:#94a3b8;">
                If you have any questions about this payment, please contact the person who sent you this link.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding:20px 32px;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Presentail OS &nbsp;·&nbsp;
                <a href="${DASHBOARD_URL}" style="color:#94a3b8;text-decoration:underline;">os.presentail.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendPaymentReceiptEmail(opts: {
  toEmail: string;
  amountCents: number;
  currency: string;
  description: string | null | undefined;
}): Promise<void> {
  const { toEmail, amountCents, currency, description } = opts;

  const amountText = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amountCents / 100);

  const html = buildPaymentReceiptHtml({ amountText, description: description ?? null });
  const text = `Payment received — ${amountText}

Your payment of ${amountText} has been successfully processed.${description ? `\n\nDetails: ${description}` : ""}

If you have any questions about this payment, please contact the person who sent you this link.

Presentail OS · ${DASHBOARD_URL}`;

  let resendClient: Resend;
  try {
    resendClient = getResend();
  } catch {
    logger.warn({ toEmail }, "Skipping payment receipt email — RESEND_API_KEY not configured");
    return;
  }

  const { error } = await resendClient.emails.send({
    from: FROM,
    to: [toEmail],
    subject: `Payment received: ${amountText}`,
    html,
    text,
  });

  if (error) {
    logger.warn({ error, toEmail }, "Failed to send payment receipt email");
  } else {
    logger.info({ toEmail }, "Payment receipt email sent");
  }
}
