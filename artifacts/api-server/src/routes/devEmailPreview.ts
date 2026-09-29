import { Router } from "express";
import {
  buildInviteHtml,
  buildAccessRequestHtml,
  buildAccessRejectionHtml,
  buildOfflineAlertHtml,
  buildTimeOffDecisionHtml,
  buildTimeOffRequestSubmittedHtml,
  buildAnnualLeavePolicyAssignedHtml,
  buildNewSignInAlertHtml,
} from "../lib/email";

const router = Router();

const TEMPLATES: Array<{ id: string; label: string }> = [
  { id: "invite", label: "Invite — standard" },
  { id: "invite-access-approval", label: "Invite — access approval variant" },
  { id: "access-request", label: "Access Request (to owners)" },
  { id: "access-rejection", label: "Access Rejection (to requester)" },
  { id: "offline-alert", label: "Offline Alert" },
  { id: "time-off-approved", label: "Time-Off Decision — Approved" },
  { id: "time-off-declined", label: "Time-Off Decision — Declined" },
  { id: "time-off-submitted", label: "Time-Off Request Submitted (to manager)" },
  { id: "leave-policy-assigned", label: "Leave Policy Assigned" },
  { id: "new-sign-in-alert", label: "New Sign-In Alert (security)" },
];

function getTemplateHtml(template: string): string | null {
  switch (template) {
    case "invite":
      return buildInviteHtml({
        toEmail: "jane.doe@example.com",
        invitedByEmail: "admin@acme.com",
        role: "designer",
        isAccessApproval: false,
        inviteToken: "sample-invite-token-abc123",
      });

    case "invite-access-approval":
      return buildInviteHtml({
        toEmail: "jane.doe@example.com",
        invitedByEmail: "admin@acme.com",
        role: "customer_service_agent",
        isAccessApproval: true,
      });

    case "access-request":
      return buildAccessRequestHtml({
        requesterEmail: "john.smith@example.com",
        requesterName: "John Smith",
      });

    case "access-rejection":
      return buildAccessRejectionHtml({
        toEmail: "john.smith@example.com",
      });

    case "offline-alert":
      return buildOfflineAlertHtml({
        toEmail: "admin@acme.com",
        deviceNames: ["POS Terminal — Dubai Mall", "Kiosk #3 — JBR Walk"],
        thresholdMinutes: 15,
      });

    case "time-off-approved":
      return buildTimeOffDecisionHtml({
        toEmail: "sarah.johnson@example.com",
        employeeName: "Sarah Johnson",
        status: "APPROVED",
        typeName: "Annual Leave",
        startDate: "2026-06-10",
        endDate: "2026-06-14",
        totalDays: 5,
        halfDay: false,
        halfDayPeriod: null,
        managerNote: "Enjoy your well-deserved vacation!",
        reviewerName: "Michael Chen",
      });

    case "time-off-declined":
      return buildTimeOffDecisionHtml({
        toEmail: "sarah.johnson@example.com",
        employeeName: "Sarah Johnson",
        status: "DECLINED",
        typeName: "Annual Leave",
        startDate: "2026-06-10",
        endDate: "2026-06-14",
        totalDays: 5,
        halfDay: false,
        halfDayPeriod: null,
        managerNote: "We have a major launch that week. Please resubmit for a later date.",
        reviewerName: "Michael Chen",
      });

    case "time-off-submitted":
      return buildTimeOffRequestSubmittedHtml({
        toEmail: "manager@acme.com",
        requesterName: "Sarah Johnson",
        typeName: "Annual Leave",
        startDate: "2026-06-10",
        endDate: "2026-06-14",
        totalDays: 5,
        halfDay: false,
        halfDayPeriod: null,
        reason: "Family vacation — already have flights booked.",
        approvalsUrl: "https://os.presentail.com/time-off/approvals",
      });

    case "leave-policy-assigned":
      return buildAnnualLeavePolicyAssignedHtml({
        toEmail: "sarah.johnson@example.com",
        firstName: "Sarah",
        policyName: "Standard Employee Policy 2026",
        vacationDaysPerYear: 21,
        sickDaysPerYear: 10,
        effectiveYear: 2026,
      });

    case "new-sign-in-alert":
      return buildNewSignInAlertHtml({
        toEmail: "jane.doe@example.com",
        deviceLabel: "Chrome on macOS",
        city: "Dubai",
        country: "United Arab Emirates",
        signedInAt: new Date().toUTCString(),
        revokeUrl: "https://os.presentail.com/profile?tab=security",
      });

    default:
      return null;
  }
}

if (process.env.NODE_ENV !== "production") {
  router.get("/dev/email-preview", (_req, res) => {
    const links = TEMPLATES.map(
      (t) =>
        `<li style="margin:8px 0;"><a href="/api/dev/email-preview/${t.id}" target="_blank" style="color:#0A404E;font-size:15px;">${t.label}</a></li>`,
    ).join("");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Email Template Preview — Presentail OS</title>
  <style>
    body { font-family: 'Inter', Arial, sans-serif; background: #f4f6f8; margin: 0; padding: 40px; }
    .card { background: #fff; border-radius: 12px; padding: 32px 40px; max-width: 560px; margin: 0 auto; box-shadow: 0 2px 16px rgba(0,0,0,0.07); }
    h1 { font-size: 22px; color: #0f172a; margin: 0 0 8px; }
    p { color: #64748b; font-size: 14px; margin: 0 0 24px; }
    ul { margin: 0; padding: 0; list-style: none; }
    li a:hover { text-decoration: underline; }
    .badge { display: inline-block; background: #fef9c3; color: #854d0e; font-size: 11px; font-weight: 600; letter-spacing: 0.05em; padding: 2px 8px; border-radius: 4px; margin-bottom: 20px; text-transform: uppercase; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">Dev only</div>
    <h1>Email Template Preview</h1>
    <p>Click a template below to open its rendered HTML preview with sample data. These pages are only available outside of production.</p>
    <ul>${links}</ul>
  </div>
</body>
</html>`);
  });

  router.get("/dev/email-preview/:template", (req, res) => {
    const { template } = req.params;
    const html = getTemplateHtml(template);

    if (!html) {
      const available = TEMPLATES.map((t) => t.id).join(", ");
      res.status(404).send(`Unknown template "${template}". Available: ${available}`);
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });
}

export default router;
